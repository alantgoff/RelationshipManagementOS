import { and, count, desc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agentActions, agentTurns, channelMessages, interactions, memoryFacts, pendingActions, people, reminders } from "@/db/schema";
import { deleteInteraction, setFollowUpDone } from "@/server/actions/interactions";
import { archivePerson, updatePerson } from "@/server/actions/people";
import { deleteReminder } from "@/server/actions/reminders";
import { getPerson } from "@/server/queries/person";
import { revalidateApp } from "@/server/revalidate";
import type { PersonInput } from "@/server/validation";
import type { UndoOp } from "./tool-kit";
import { toPersonInput } from "./tools";

/**
 * `undo` reverses the changes of the most recent turn that changed something,
 * newest first, within UNDO_WINDOW_MS. It never clobbers later edits: profile
 * fields are restored only where they still hold what the agent wrote, and a
 * person the agent created is archived rather than deleted once they have
 * history. `why` lists what the most recent turn read and did.
 */

export const UNDO_WINDOW_MS = 24 * 60 * 60_000;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const notFound = (err: unknown) => err instanceof Error && /not found/i.test(err.message);

/** Apply one undo op. Returns a note when part of it was skipped. */
async function applyUndo(op: UndoOp, userId: string): Promise<string | null> {
  const db = getDb();
  switch (op.kind) {
    case "delete_interaction":
      await deleteInteraction(op.id).catch((err) => {
        if (!notFound(err)) throw err;
      });
      return null;
    case "delete_person": {
      const owned = and(eq(people.id, op.id), eq(people.userId, userId));
      // History is anything that would be lost with them: interactions (including intros
      // naming them), reminders, live facts and live drafts. Facts and drafts this same
      // turn added were already reverted by the newer steps, so they don't count.
      const [[i], [r], [f], [d]] = await Promise.all([
        db
          .select({ n: count() })
          .from(interactions)
          .where(and(eq(interactions.userId, userId), or(eq(interactions.personId, op.id), eq(interactions.introducedPersonId, op.id)))),
        db.select({ n: count() }).from(reminders).where(and(eq(reminders.personId, op.id), eq(reminders.userId, userId))),
        db.select({ n: count() }).from(memoryFacts).where(and(eq(memoryFacts.personId, op.id), eq(memoryFacts.userId, userId), isNull(memoryFacts.validTo))),
        db
          .select({ n: count() })
          .from(pendingActions)
          .where(and(eq(pendingActions.personId, op.id), eq(pendingActions.userId, userId), inArray(pendingActions.status, ["pending", "approved"]))),
      ]);
      if (Number(i.n) + Number(r.n) + Number(f.n) + Number(d.n) > 0) {
        await archivePerson(op.id);
        return "archived them instead of deleting, since they have history now";
      }
      await db.delete(people).where(owned);
      revalidateApp();
      return null;
    }
    case "delete_reminder":
      await deleteReminder(op.id).catch((err) => {
        if (!notFound(err)) throw err;
      });
      return null;
    case "reopen_follow_up":
      await setFollowUpDone(op.id, false);
      return null;
    case "reopen_reminder":
      await db.update(reminders).set({ completedAt: null }).where(and(eq(reminders.id, op.id), eq(reminders.userId, userId)));
      revalidateApp();
      return null;
    case "restore_person":
      await updatePerson(op.id, op.input);
      return null;
    case "restore_person_fields": {
      const current = await getPerson(op.id);
      if (!current) return "they no longer exist";
      const now = toPersonInput(current);
      const restore: Partial<PersonInput> = {};
      const skipped: string[] = [];
      for (const [field, value] of Object.entries(op.before) as [keyof PersonInput, unknown][]) {
        if (same(now[field], op.after[field])) (restore as Record<string, unknown>)[field] = value;
        else skipped.push(field);
      }
      if (Object.keys(restore).length) await updatePerson(op.id, { ...now, ...restore });
      return skipped.length ? `left ${skipped.join(", ")} alone because it changed since` : null;
    }
    case "restore_lp": {
      const [row] = await db
        .select({ stage: people.lpStage, commitment: people.lpCommitmentUsd, roles: people.roles })
        .from(people)
        .where(and(eq(people.id, op.id), eq(people.userId, userId)));
      if (!row) return "they no longer exist";
      if (op.after && (row.stage !== op.after.stage || row.commitment !== op.after.commitmentUsd)) {
        return "left the LP stage alone because it changed since";
      }
      // Remove only the roles the tool added; roles added since stay.
      const roles = op.rolesAdded ? row.roles.filter((role) => !op.rolesAdded!.includes(role)) : (op.roles ?? row.roles);
      await db
        .update(people)
        .set({ lpStage: op.stage, roles, lpCommitmentUsd: op.commitmentUsd, updatedAt: new Date() })
        .where(and(eq(people.id, op.id), eq(people.userId, userId)));
      revalidateApp([`/people/${op.id}`]);
      return null;
    }
    case "invalidate_fact":
      await db.update(memoryFacts).set({ validTo: new Date() }).where(and(eq(memoryFacts.id, op.id), eq(memoryFacts.userId, userId)));
      return null;
    case "discard_draft":
      await db
        .update(pendingActions)
        .set({ status: "rejected", resolvedAt: new Date() })
        .where(and(eq(pendingActions.id, op.id), eq(pendingActions.userId, userId), eq(pendingActions.status, "pending")));
      return null;
    case "unapprove_draft":
      await deleteInteraction(op.interactionId).catch((err) => {
        if (!notFound(err)) throw err;
      });
      await db
        .update(pendingActions)
        .set({ status: "pending", resolvedAt: null })
        .where(and(eq(pendingActions.id, op.id), eq(pendingActions.userId, userId), eq(pendingActions.status, "approved")));
      return null;
    case "restore_draft":
      await db
        .update(pendingActions)
        .set({ status: "pending", resolvedAt: null })
        .where(and(eq(pendingActions.id, op.id), eq(pendingActions.userId, userId), eq(pendingActions.status, "rejected")));
      return null;
  }
}

/** Reverse the latest turn's changes. Returns a reply for the owner. */
export async function undoLastTurn(userId: string, now = new Date()): Promise<string> {
  const db = getDb();
  const pending = and(eq(agentActions.userId, userId), eq(agentActions.ok, true), isNull(agentActions.undoneAt), isNotNull(agentActions.undo));
  const [latest] = await db
    .select({ turnId: agentActions.turnId, createdAt: agentActions.createdAt })
    .from(agentActions)
    .where(pending)
    .orderBy(desc(agentActions.createdAt))
    .limit(1);
  if (!latest) return "There's nothing to undo.";
  if (latest.createdAt.getTime() < now.getTime() - UNDO_WINDOW_MS) {
    return "My last change was more than a day ago, so I won't undo it by text. You can edit it in the app.";
  }

  const undoable = await db
    .select()
    .from(agentActions)
    .where(and(pending, eq(agentActions.turnId, latest.turnId), gte(agentActions.createdAt, new Date(now.getTime() - UNDO_WINDOW_MS))))
    .orderBy(desc(agentActions.createdAt));

  const reverted: string[] = [];
  const revertedIds: string[] = [];
  const notes: string[] = [];
  const failed: string[] = [];
  for (const a of undoable) {
    try {
      const note = await applyUndo(a.undo as unknown as UndoOp, userId);
      reverted.push(a.summary);
      revertedIds.push(a.id);
      if (note) notes.push(`${a.summary}: ${note}`);
    } catch (err) {
      console.error("[agent] undo failed", a.id, err);
      failed.push(a.summary);
    }
  }
  // Only what was actually reverted is marked; a failed step stays undoable and is retried next time.
  if (revertedIds.length) await db.update(agentActions).set({ undoneAt: now }).where(inArray(agentActions.id, revertedIds));
  const lines: string[] = [];
  if (reverted.length) lines.push(`Undid: ${reverted.join("; ")}.`);
  if (notes.length) lines.push(`Note: ${notes.join("; ")}.`);
  if (failed.length) lines.push(`Couldn't undo: ${failed.join("; ")}. Text "undo" again to retry.`);
  return lines.join(" ");
}

/** Explain the most recent turn: the tools it used and what each returned. */
export async function explainLastTurn(userId: string): Promise<string> {
  const db = getDb();
  const [[turn], [brief]] = await Promise.all([
    db.select({ id: agentTurns.id, createdAt: agentTurns.createdAt }).from(agentTurns).where(eq(agentTurns.userId, userId)).orderBy(desc(agentTurns.createdAt)).limit(1),
    db
      .select({ createdAt: channelMessages.createdAt })
      .from(channelMessages)
      .where(and(eq(channelMessages.userId, userId), eq(channelMessages.direction, "out"), eq(channelMessages.kind, "brief"), isNull(channelMessages.error)))
      .orderBy(desc(channelMessages.createdAt))
      .limit(1),
  ]);
  // A brief writes no turn; don't pass off an older turn as the basis for it.
  if (brief && (!turn || brief.createdAt > turn.createdAt)) {
    return "My last message was your brief: it comes straight from your records (follow-ups and reminders due, and who's going cold) and didn't change anything.";
  }
  if (!turn) return "I haven't answered anything yet.";
  const actions = await db
    .select({ tool: agentActions.tool, summary: agentActions.summary, ok: agentActions.ok, undoneAt: agentActions.undoneAt })
    .from(agentActions)
    .where(eq(agentActions.turnId, turn.id))
    .orderBy(agentActions.createdAt);
  if (actions.length === 0) return "My last reply didn't read or change any of your records; it came from our conversation and the context I keep.";
  const lines = actions.map((a) => `- ${a.summary}${a.ok ? "" : " (failed)"}${a.undoneAt ? " (undone)" : ""}`);
  return `My last answer was based on:\n${lines.join("\n")}`;
}

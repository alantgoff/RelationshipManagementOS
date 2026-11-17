import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agentActions, agentTurns, memoryFacts, pendingActions, people, reminders } from "@/db/schema";
import { deleteInteraction, setFollowUpDone } from "@/server/actions/interactions";
import { updatePerson } from "@/server/actions/people";
import { deleteReminder } from "@/server/actions/reminders";
import { revalidateApp } from "@/server/revalidate";
import type { UndoOp } from "./tools";

/**
 * `undo` reverses every change made in the most recent turn that changed
 * something, newest first. `why` lists what the most recent turn read and did.
 */

async function applyUndo(op: UndoOp, userId: string): Promise<void> {
  const db = getDb();
  switch (op.kind) {
    case "delete_interaction":
      await deleteInteraction(op.id).catch((err: Error) => {
        if (!/not found/i.test(err.message)) throw err;
      });
      return;
    case "delete_person":
      await db.delete(people).where(and(eq(people.id, op.id), eq(people.userId, userId)));
      revalidateApp();
      return;
    case "delete_reminder":
      await deleteReminder(op.id);
      return;
    case "reopen_follow_up":
      await setFollowUpDone(op.id, false);
      return;
    case "reopen_reminder":
      await db.update(reminders).set({ completedAt: null }).where(and(eq(reminders.id, op.id), eq(reminders.userId, userId)));
      revalidateApp();
      return;
    case "restore_person":
      await updatePerson(op.id, op.input);
      return;
    case "restore_lp":
      await db
        .update(people)
        .set({ lpStage: op.stage, roles: op.roles, lpCommitmentUsd: op.commitmentUsd, updatedAt: new Date() })
        .where(and(eq(people.id, op.id), eq(people.userId, userId)));
      revalidateApp([`/people/${op.id}`]);
      return;
    case "invalidate_fact":
      await db.update(memoryFacts).set({ validTo: new Date() }).where(and(eq(memoryFacts.id, op.id), eq(memoryFacts.userId, userId)));
      return;
    case "discard_draft":
      await db
        .update(pendingActions)
        .set({ status: "rejected", resolvedAt: new Date() })
        .where(and(eq(pendingActions.id, op.id), eq(pendingActions.userId, userId), eq(pendingActions.status, "pending")));
      return;
  }
}

/** Reverse the latest turn's changes. Returns a reply for the owner. */
export async function undoLastTurn(userId: string): Promise<string> {
  const db = getDb();
  const [latest] = await db
    .select({ turnId: agentActions.turnId })
    .from(agentActions)
    .where(and(eq(agentActions.userId, userId), eq(agentActions.ok, true), isNull(agentActions.undoneAt), isNotNull(agentActions.undo)))
    .orderBy(desc(agentActions.createdAt))
    .limit(1);
  if (!latest) return "There's nothing to undo.";

  const undoable = await db
    .select()
    .from(agentActions)
    .where(
      and(eq(agentActions.turnId, latest.turnId), eq(agentActions.ok, true), isNull(agentActions.undoneAt), isNotNull(agentActions.undo)),
    )
    .orderBy(desc(agentActions.createdAt));

  const reverted: string[] = [];
  const failed: string[] = [];
  for (const a of undoable) {
    try {
      await applyUndo(a.undo as unknown as UndoOp, userId);
      reverted.push(a.summary);
    } catch (err) {
      console.error("[agent] undo failed", a.id, err);
      failed.push(a.summary);
    }
  }
  await db
    .update(agentActions)
    .set({ undoneAt: new Date() })
    .where(and(eq(agentActions.turnId, latest.turnId), isNotNull(agentActions.undo)));
  const lines = [`Undid: ${reverted.join("; ")}.`];
  if (failed.length) lines.push(`Couldn't undo: ${failed.join("; ")}.`);
  return lines.join(" ");
}

/** Explain the most recent turn: the tools it used and what each returned. */
export async function explainLastTurn(userId: string): Promise<string> {
  const db = getDb();
  const [turn] = await db
    .select({ id: agentTurns.id })
    .from(agentTurns)
    .innerJoin(agentActions, eq(agentActions.turnId, agentTurns.id))
    .where(eq(agentTurns.userId, userId))
    .orderBy(desc(agentTurns.createdAt))
    .limit(1);
  if (!turn) return "My last reply didn't use any of your records; it came from our conversation.";
  const actions = await db
    .select({ tool: agentActions.tool, summary: agentActions.summary, ok: agentActions.ok, undoneAt: agentActions.undoneAt })
    .from(agentActions)
    .where(eq(agentActions.turnId, turn.id))
    .orderBy(agentActions.createdAt);
  const lines = actions.map((a) => `- ${a.summary}${a.ok ? "" : " (failed)"}${a.undoneAt ? " (undone)" : ""}`);
  return `My last answer was based on:\n${lines.join("\n")}`;
}

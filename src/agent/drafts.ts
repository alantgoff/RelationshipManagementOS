import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pendingActions, people } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { logInteraction } from "@/server/actions/interactions";
import type { UndoOp } from "./tool-kit";

/**
 * Resolving a pending draft, shared by the code commands (👍, "skip",
 * tapbacks) and the resolve_draft tool. Callers run as the owner and record
 * the returned undo op in agent_actions.
 */

export interface ResolvedDraft {
  name: string;
  channel: string;
  summary: string;
  undo: UndoOp;
}

async function loadPending(userId: string, draftId: string) {
  const [row] = await getDb()
    .select({
      id: pendingActions.id,
      personId: pendingActions.personId,
      channel: pendingActions.channel,
      bodyEnc: pendingActions.bodyEnc,
      status: pendingActions.status,
      name: people.fullName,
    })
    .from(pendingActions)
    .innerJoin(people, eq(people.id, pendingActions.personId))
    .where(and(eq(pendingActions.id, draftId), eq(pendingActions.userId, userId)));
  return row ?? null;
}

/** Mark a draft as sent by the owner and log it as an interaction. Null if it isn't pending. */
export async function approveDraft(userId: string, draftId: string, now: Date): Promise<ResolvedDraft | null> {
  const draft = await loadPending(userId, draftId);
  if (!draft || draft.status !== "pending") return null;
  // Claim it first so two approvals can't both log an interaction.
  const claimed = await getDb()
    .update(pendingActions)
    .set({ status: "approved", resolvedAt: now })
    .where(and(eq(pendingActions.id, draftId), eq(pendingActions.status, "pending")))
    .returning({ id: pendingActions.id });
  if (claimed.length === 0) return null;
  const body = decrypt(draft.bodyEnc);
  const firstLine = body.split("\n").find((l) => l.trim() && !/^subject:/i.test(l)) ?? body;
  const { id } = await logInteraction({
    personId: draft.personId,
    type: draft.channel === "email" ? "email" : "message",
    summary: `Sent: ${firstLine.trim().slice(0, 120)}`,
    notes: body,
    occurredAt: now,
  });
  return {
    name: draft.name,
    channel: draft.channel,
    summary: `Logged the ${draft.channel} you sent to ${draft.name}`,
    undo: { kind: "unapprove_draft", id: draftId, interactionId: id },
  };
}

/** Discard a pending draft. Null if it isn't pending. */
export async function rejectDraft(userId: string, draftId: string, now: Date): Promise<ResolvedDraft | null> {
  const draft = await loadPending(userId, draftId);
  if (!draft || draft.status !== "pending") return null;
  const updated = await getDb()
    .update(pendingActions)
    .set({ status: "rejected", resolvedAt: now })
    .where(and(eq(pendingActions.id, draftId), eq(pendingActions.status, "pending")))
    .returning({ id: pendingActions.id });
  if (updated.length === 0) return null;
  return {
    name: draft.name,
    channel: draft.channel,
    summary: `Discarded the ${draft.channel} draft to ${draft.name}`,
    undo: { kind: "restore_draft", id: draftId },
  };
}

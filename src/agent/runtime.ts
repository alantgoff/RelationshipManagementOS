import { inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agentActions, agentTurns } from "@/db/schema";
import type { ChannelAdapter, InboundMessage } from "@/channels/types";
import { runAsOwner } from "@/server/auth";
import { briefIsEmpty, composeBrief, gatherBriefData, renderBriefFallback } from "./brief";
import { HELP_TEXT, parseCommand, type Command } from "./commands";
import { approveDraft, rejectDraft, type ResolvedDraft } from "./drafts";
import { chat, type ChatRequest, type ChatResult } from "./llm";
import { composeInboundText, defaultMediaDeps, MEDIA_BUDGET_MS, processMedia, storableMedia, type MediaDeps } from "./media";
import {
  findOwnerByPhone,
  getAgentPrefs,
  getBinding,
  insertInbound,
  lastDeliveredOutbound,
  markProcessed,
  markReady,
  pendingDrafts,
  readyUnprocessed,
  redeemBindingCode,
  updateAgentPrefs,
  withOwnerLock,
  type StoredMessage,
} from "./store";
import { maybeUpdateThreadSummary, runTurn, SEND_RESERVE_MS, sendOut } from "./turn";
import { explainLastTurn, undoLastTurn } from "./undo";

export { cleanReply, splitMessage } from "./text";
export { maybeUpdateThreadSummary, runTurn, type TurnInput, type TurnResult } from "./turn";

/* ───────────── Dependencies ───────────── */

export interface AgentDeps {
  adapter: ChannelAdapter;
  llm: (req: ChatRequest) => Promise<ChatResult>;
  media: MediaDeps;
  now: () => Date;
  /** Our line in E.164; inbound messages addressed elsewhere are ignored. */
  lineNumber?: string;
  /**
   * Start a fresh run for an owner whose queue outlasted this run's budget
   * (see src/app/api/cron/drain). Without it, the tick picks them up.
   */
  handOff?: (userId: string) => Promise<void>;
}

export function defaultAgentDeps(adapter: ChannelAdapter): AgentDeps {
  return {
    adapter,
    llm: (req) => chat(req),
    media: defaultMediaDeps(),
    now: () => new Date(),
    lineNumber: process.env.SENDBLUE_FROM_NUMBER || undefined,
    handOff: drainHandOffFromEnv(),
  };
}

/** Hand-off over HTTP to this deployment's drain route, when it knows its own URL and the cron secret. */
function drainHandOffFromEnv(): AgentDeps["handOff"] {
  const secret = process.env.CRON_SECRET;
  const base = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (!secret || !base) return undefined;
  return async (userId) => {
    const res = await fetch(new URL("/api/cron/drain", base), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`drain hand-off failed: ${res.status}`);
  };
}

/**
 * Real-clock budget for the work after a webhook responds. The webhook route's
 * maxDuration (60s) must stay above this, or the platform kills a turn midway.
 */
export const WORK_BUDGET_MS = 50_000;
/** Least time left for starting a model turn; less, and the message waits for the next run or tick. */
export const MIN_TURN_MS = 20_000;
/** Least time left for keeping the thread summary caught up after the queue is empty. */
const MIN_FOLD_MS = 8_000;

/* ───────────── Intake ───────────── */

export type ReceiveResult =
  | { status: "ignored"; reason: "unknown_sender" | "wrong_line" }
  | { status: "duplicate"; userId: string }
  | { status: "bound"; userId: string; work: () => Promise<void> }
  | { status: "accepted"; userId: string; messageId: string; work: () => Promise<void> };

/**
 * The fast, synchronous part of a webhook (HA-1..HA-4): allowlist, binding
 * codes, and an idempotent insert. Unknown senders cause no reply (HAC-4).
 * Returns `work` to run after the HTTP response.
 */
export async function receiveInbound(deps: AgentDeps, msg: InboundMessage): Promise<ReceiveResult> {
  if (deps.lineNumber && msg.to && msg.to !== deps.lineNumber) return { status: "ignored", reason: "wrong_line" };

  const owner = await findOwnerByPhone(msg.from);
  if (!owner) {
    const code = msg.text.trim();
    const userId = /^\d{6}$/.test(code) ? await redeemBindingCode(code, msg.from, deps.now()) : null;
    if (!userId) return { status: "ignored", reason: "unknown_sender" };
    await insertInbound({ userId, provider: deps.adapter.name, providerMessageId: msg.providerMessageId, body: msg.text, kind: "command", processed: true });
    return {
      status: "bound",
      userId,
      work: () =>
        sendOut(
          deps,
          userId,
          msg.from,
          "You're connected. Text me what happened with people (\"coffee with Priya, send her the deck Friday\") or ask \"who's going cold?\". Text \"help\" for commands.",
          "command",
        ).then(() => undefined),
    };
  }

  const messageId = await insertInbound({
    userId: owner.userId,
    provider: deps.adapter.name,
    providerMessageId: msg.providerMessageId,
    body: msg.text,
    ready: msg.media.length === 0,
  });
  if (!messageId) return { status: "duplicate", userId: owner.userId };
  return {
    status: "accepted",
    userId: owner.userId,
    messageId,
    work: () => processInbound(deps, owner.userId, messageId, msg),
  };
}

/* ───────────── Processing ───────────── */

/**
 * The slow part, after the webhook has responded: read attachments, then work
 * through the owner's ready messages under a per-owner lock, so a burst of
 * texts is answered in order, in as few turns as possible, never in parallel.
 */
export async function processInbound(deps: AgentDeps, userId: string, messageId: string, msg: InboundMessage): Promise<void> {
  const deadline = Date.now() + WORK_BUDGET_MS;
  await runAsOwner(userId, "channel", async () => {
    if (msg.media.length) {
      const budget = Math.min(MEDIA_BUDGET_MS, deadline - Date.now() - MIN_TURN_MS);
      const media = await processMedia(msg.media, deps.media, budget);
      await markReady(messageId, composeInboundText(msg.text, media), storableMedia(media));
    }
    await drainQueue(deps, userId, msg.from, deadline);
  });
}

/** Drain one owner's queue in a fresh run (the hand-off route). */
export async function drainOwner(deps: AgentDeps, userId: string): Promise<void> {
  const binding = await getBinding(userId);
  if (!binding?.phone || !binding.verifiedAt) return;
  const phone = binding.phone;
  const deadline = Date.now() + WORK_BUDGET_MS;
  await runAsOwner(userId, "channel", () => drainQueue(deps, userId, phone, deadline));
}

/**
 * Answer ready messages until none are left or the budget runs low, then keep
 * the thread summary caught up. Whoever holds the owner's lock also picks up
 * messages that arrive meanwhile; a run that can't get the lock in time leaves
 * its message for the holder. A holder that runs out of budget with messages
 * still queued hands them to a fresh run (or, failing that, to the tick).
 * Must be called inside runAsOwner.
 */
export async function drainQueue(deps: AgentDeps, userId: string, to: string, deadline: number): Promise<void> {
  await withOwnerLock(userId, deadline - Date.now() - MIN_TURN_MS, async () => {
    const attempted = new Set<string>();
    let folded = false;
    for (;;) {
      const ready = await readyUnprocessed(userId);
      if (ready.length && !attempted.has(ready[0].id)) {
        if (await processNext(deps, userId, to, ready, deadline, attempted)) continue;
        break;
      }
      if (ready.length || folded || deadline - Date.now() < MIN_FOLD_MS) break;
      // Queue empty: fold older conversation into the summary while there's time (HA-7).
      folded = true;
      await maybeUpdateThreadSummary(deps, userId, deps.now(), Math.min(15_000, deadline - Date.now() - 2_000)).catch((err) =>
        console.error("[agent] summary update failed", err),
      );
    }
    if (deps.handOff && (await readyUnprocessed(userId)).length) {
      await deps.handOff(userId).catch((err) => console.error("[agent] hand-off failed; the tick will pick it up", err));
    }
  });
}

/** What a message means as a command, given the drafts the owner had seen when they sent it. */
async function commandFor(userId: string, m: StoredMessage): Promise<Command | null> {
  if (m.media.length) return null; // attachments always go to the model
  const [pending, lastOut] = await Promise.all([pendingDrafts(userId), lastDeliveredOutbound(userId, m.createdAt)]);
  // Drafts created after this message (by a turn still catching up) aren't what it refers to.
  const drafts = pending.filter((d) => d.createdAt < m.createdAt).map((d) => ({ id: d.id, body: d.body }));
  const shownDraft = lastOut?.kind === "draft" && lastOut.refId ? (drafts.find((d) => d.id === lastOut.refId) ?? null) : null;
  const lastOutboundAsked = lastOut?.kind === "chat" && /\?\s*$/.test(lastOut.body);
  return parseCommand(m.body, { drafts, shownDraft, lastOutboundAsked });
}

/** Handle the next unit of work: one command, or one run of consecutive chat messages. Returns false to stop. */
async function processNext(deps: AgentDeps, userId: string, to: string, ready: StoredMessage[], deadline: number, attempted: Set<string>): Promise<boolean> {
  const first = ready[0];
  const command = await commandFor(userId, first);
  if (command) {
    attempted.add(first.id);
    // Commands run at most once: mark first, so a crash can't replay an undo.
    await markProcessed([first.id], { kind: command.kind === "reaction" ? "reaction" : "command" });
    try {
      const reply = await runCommand(deps, userId, first, command, deadline);
      if (reply) await sendOut(deps, userId, to, reply.text, reply.kind, deadline);
    } catch (err) {
      console.error("[agent] command failed", err);
      await sendOut(deps, userId, to, "Sorry, something broke on my side while doing that. Text \"why\" to see what I last changed.", "system", deadline).catch(() => {});
    }
    return true;
  }

  const run = [first];
  for (const m of ready.slice(1)) {
    if (await commandFor(userId, m)) break;
    run.push(m);
  }
  const ids = run.map((m) => m.id);

  // A turn already started for these messages means a previous run was killed midway.
  const prior = await getDb().select({ id: agentTurns.id, inbound: agentTurns.inboundMessageId }).from(agentTurns).where(inArray(agentTurns.inboundMessageId, ids));
  if (prior.length) {
    // Only the messages that killed run covered are reported; later ones get a turn of their own.
    const cut = Math.max(...prior.map((t) => ids.indexOf(t.inbound!)));
    ids.slice(0, cut + 1).forEach((id) => attempted.add(id));
    await reportInterrupted(deps, userId, to, ids.slice(0, cut + 1), prior.map((t) => t.id), deadline);
    return true;
  }

  ids.forEach((id) => attempted.add(id));
  if (Date.now() + MIN_TURN_MS > deadline) return false;
  try {
    const result = await runTurn(deps, { userId, messages: run, now: deps.now(), to, deadline });
    await markProcessed(ids, result.sent ? {} : { error: "reply not delivered" });
  } catch (err) {
    console.error("[agent] turn failed", err);
    await markProcessed(ids, { error: err instanceof Error ? err.message.slice(0, 500) : "error" });
    const started = await getDb().select({ id: agentTurns.id }).from(agentTurns).where(inArray(agentTurns.inboundMessageId, ids)).limit(1);
    const text = started.length
      ? "Sorry, something broke on my side and I may not have finished. Text \"why\" to see what I saved."
      : "Sorry, something broke on my side before I could start, so nothing was saved. Could you send that again?";
    await sendOut(deps, userId, to, text, "system", deadline).catch(() => {});
  }
  return true;
}

/** Tell the owner a turn was cut off, with what it had saved, instead of redoing (and duplicating) it. */
async function reportInterrupted(deps: AgentDeps, userId: string, to: string, ids: string[], turnIds: string[], deadline: number): Promise<void> {
  await markProcessed(ids, { error: "interrupted" });
  const actions = await getDb().select({ summary: agentActions.summary, ok: agentActions.ok, undo: agentActions.undo }).from(agentActions).where(inArray(agentActions.turnId, turnIds));
  const saved = actions.filter((a) => a.ok && a.undo).map((a) => a.summary);
  const text = saved.length
    ? `Sorry, I got cut off while handling your last message. Before that I saved: ${saved.join("; ")}. Tell me if anything's missing.`
    : "Sorry, I got cut off while handling your last message and nothing was saved. Could you send it again?";
  await sendOut(deps, userId, to, text, "system", deadline);
}

/* ───────────── Commands ───────────── */

/** Record a draft resolved by command as its own turn, so `undo` and `why` cover it. */
async function recordDraftAction(userId: string, messageId: string, tool: string, draftId: string, done: ResolvedDraft): Promise<void> {
  const [turn] = await getDb().insert(agentTurns).values({ userId, inboundMessageId: messageId, steps: 0 }).returning({ id: agentTurns.id });
  await getDb()
    .insert(agentActions)
    .values({ userId, turnId: turn.id, tool, input: { draft_id: draftId }, ok: true, summary: done.summary, undo: done.undo as unknown as Record<string, unknown> });
}

async function runCommand(deps: AgentDeps, userId: string, m: StoredMessage, command: Command, deadline: number): Promise<{ text: string; kind: string } | null> {
  const now = deps.now();
  switch (command.kind) {
    case "reaction":
      return null;
    case "help":
      return { text: HELP_TEXT, kind: "command" };
    case "stop":
      await updateAgentPrefs(userId, { proactiveEnabled: false });
      return { text: "Okay, I won't message you first until you text \"start\". You can still text me anytime.", kind: "command" };
    case "start": {
      const prefs = await getAgentPrefs(userId);
      await updateAgentPrefs(userId, { proactiveEnabled: true, pausedUntil: null });
      return { text: `Back on. Your brief comes weekdays at ${prefs.briefTime}.`, kind: "command" };
    }
    case "pause": {
      const until = new Date(now.getTime() + command.minutes * 60_000);
      await updateAgentPrefs(userId, { pausedUntil: until });
      const label = command.minutes < 120 ? `${command.minutes} minutes` : command.minutes < 2880 ? `${Math.round(command.minutes / 60)} hours` : `${Math.round(command.minutes / 1440)} days`;
      return { text: `Paused for ${label}. I won't message you first until then; text "start" to resume early.`, kind: "command" };
    }
    case "undo":
      return { text: await undoLastTurn(userId), kind: "command" };
    case "why":
      return { text: await explainLastTurn(userId), kind: "command" };
    case "brief": {
      const prefs = await getAgentPrefs(userId);
      const data = await gatherBriefData(userId, now, prefs.timezone);
      if (briefIsEmpty(data)) return { text: "Nothing due and nobody going cold. Enjoy the quiet.", kind: "brief" };
      const timeoutMs = Math.min(30_000, deadline - Date.now() - SEND_RESERVE_MS);
      const text = timeoutMs < 3_000 ? renderBriefFallback(data) : (await composeBrief(deps.llm, data, timeoutMs)).text;
      return { text, kind: "brief" };
    }
    case "approve": {
      const done = await approveDraft(userId, command.draftId, now);
      if (!done) return { text: "That draft was already logged or discarded.", kind: "command" };
      await recordDraftAction(userId, m.id, "approve_draft", command.draftId, done);
      return { text: `Logged as sent to ${done.name}.`, kind: "command" };
    }
    case "reject": {
      const done = await rejectDraft(userId, command.draftId, now);
      if (!done) return { text: "That draft was already logged or discarded.", kind: "command" };
      await recordDraftAction(userId, m.id, "reject_draft", command.draftId, done);
      return { text: `Discarded the draft to ${done.name}.`, kind: "command" };
    }
  }
}

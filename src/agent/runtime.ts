import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agentActions, agentTurns, pendingActions, people, threadSummaries } from "@/db/schema";
import type { ChannelAdapter, InboundMessage } from "@/channels/types";
import { decrypt, encrypt } from "@/lib/crypto";
import { localDate } from "@/lib/time";
import { logInteraction } from "@/server/actions/interactions";
import { runAsOwner } from "@/server/auth";
import { briefIsEmpty, briefScheduleCheck, composeBrief, gatherBriefData, type BriefSkipReason } from "./brief";
import { HELP_TEXT, parseCommand, type Command } from "./commands";
import { assembleContext, RECENT_MESSAGE_LIMIT, threadSummary } from "./context";
import { chat, type ChatMessage, type ChatRequest, type ChatResult } from "./llm";
import { defaultMediaDeps, mediaToText, processMedia, type MediaDeps } from "./media";
import {
  attachNotificationMessage,
  claimBriefSlot,
  findOwnerByPhone,
  getAgentPrefs,
  insertInbound,
  insertOutbound,
  listVerifiedBindings,
  markProcessed,
  messagesBetween,
  recentMessages,
  redeemBindingCode,
  releaseNotification,
  unpromptedCountToday,
  updateAgentPrefs,
} from "./store";
import { toolSpecs } from "./tool-specs";
import { executeToolCall, type ToolContext } from "./tools";
import { explainLastTurn, undoLastTurn } from "./undo";

/* ───────────── Dependencies ───────────── */

export interface AgentDeps {
  adapter: ChannelAdapter;
  llm: (req: ChatRequest) => Promise<ChatResult>;
  media: MediaDeps;
  now: () => Date;
  /** Our line in E.164; inbound messages addressed elsewhere are ignored. */
  lineNumber?: string;
}

export function defaultAgentDeps(adapter: ChannelAdapter): AgentDeps {
  return {
    adapter,
    llm: (req) => chat(req),
    media: defaultMediaDeps(),
    now: () => new Date(),
    lineNumber: process.env.SENDBLUE_FROM_NUMBER || undefined,
  };
}

/** Message kinds that form the conversation the model sees. */
const CONVERSATION_KINDS = ["chat", "brief", "draft"];
const MAX_STEPS = 6;
const MAX_INBOUND_CHARS = 12_000;

/* ───────────── Output helpers ───────────── */

/** Strip reasoning tags and markdown that doesn't render in iMessage. */
export function cleanReply(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split long text into at most `maxParts` messages at paragraph or sentence boundaries. */
export function splitMessage(text: string, maxChars = 1200, maxParts = 3): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars && parts.length < maxParts - 1) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". ") + 1);
    const at = cut > maxChars / 3 ? cut : maxChars;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  parts.push(rest.length > maxChars ? `${rest.slice(0, maxChars - 1)}…` : rest);
  return parts.filter(Boolean);
}

async function send(deps: AgentDeps, userId: string, to: string, body: string, kind: string): Promise<void> {
  for (const part of splitMessage(body)) {
    const res = await deps.adapter.sendText(to, part);
    await insertOutbound({ userId, provider: deps.adapter.name, providerMessageId: res.providerMessageId, body: part, kind });
  }
}

/* ───────────── Intake ───────────── */

export type ReceiveResult =
  | { status: "ignored"; reason: "unknown_sender" | "wrong_line" }
  | { status: "duplicate"; userId: string }
  | { status: "bound"; userId: string; work: () => Promise<void> }
  | { status: "accepted"; userId: string; messageId: string; work: () => Promise<void> };

/**
 * The fast, synchronous part of a webhook (HA-1..HA-4): allowlist, binding
 * codes, and an idempotent insert. Unknown senders cause no writes and no
 * reply (HAC-4). Returns `work` to run after the HTTP response.
 */
export async function receiveInbound(deps: AgentDeps, msg: InboundMessage): Promise<ReceiveResult> {
  if (deps.lineNumber && msg.to && msg.to !== deps.lineNumber) return { status: "ignored", reason: "wrong_line" };

  const owner = await findOwnerByPhone(msg.from);
  if (!owner) {
    const code = msg.text.trim();
    const userId = /^\d{6}$/.test(code) ? await redeemBindingCode(code, msg.from, deps.now()) : null;
    if (!userId) return { status: "ignored", reason: "unknown_sender" };
    await insertInbound({ userId, provider: deps.adapter.name, providerMessageId: msg.providerMessageId, body: msg.text, kind: "command" });
    return {
      status: "bound",
      userId,
      work: () =>
        send(
          deps,
          userId,
          msg.from,
          "You're connected. Text me what happened with people (\"coffee with Priya, send her the deck Friday\") or ask \"who's going cold?\". Text \"help\" for commands.",
          "command",
        ),
    };
  }

  const messageId = await insertInbound({
    userId: owner.userId,
    provider: deps.adapter.name,
    providerMessageId: msg.providerMessageId,
    body: msg.text,
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

async function latestPendingDraft(userId: string) {
  const [row] = await getDb()
    .select({
      id: pendingActions.id,
      personId: pendingActions.personId,
      channel: pendingActions.channel,
      bodyEnc: pendingActions.bodyEnc,
      name: people.fullName,
    })
    .from(pendingActions)
    .innerJoin(people, eq(people.id, pendingActions.personId))
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, "pending")))
    .orderBy(desc(pendingActions.createdAt))
    .limit(1);
  return row ?? null;
}

/** The slow part: runs after the webhook has responded, as the owner. */
export async function processInbound(deps: AgentDeps, userId: string, messageId: string, msg: InboundMessage): Promise<void> {
  await runAsOwner(userId, "channel", async () => {
    const now = deps.now();
    try {
      const media = msg.media.length ? await processMedia(msg.media, deps.media) : [];
      const attachmentText = media.length ? mediaToText(media) : "";
      const text = [msg.text.trim(), attachmentText].filter(Boolean).join("\n").slice(0, MAX_INBOUND_CHARS);

      const draft = await latestPendingDraft(userId);
      const prior = (await recentMessages(userId, 2)).filter((m) => m.id !== messageId).at(-1);
      const draftAwaitingReply = Boolean(draft) && prior?.direction === "out" && prior.kind === "draft";
      const command = media.length ? null : parseCommand(msg.text, { draftAwaitingReply });

      if (command) {
        await markProcessed(messageId, { kind: "command", media });
        const reply = await runCommand(deps, userId, command, now, draft);
        await send(deps, userId, msg.from, reply.text, reply.kind);
        return;
      }
      await markProcessed(messageId, { media });
      if (!text) return;
      await runTurn(deps, { userId, messageId, text, now, to: msg.from });
    } catch (err) {
      console.error("[agent] processing failed", err);
      await markProcessed(messageId, { error: err instanceof Error ? err.message.slice(0, 500) : "error" });
      await send(deps, userId, msg.from, "Sorry, something broke on my side. Your message is saved; try again in a minute.", "system").catch(
        () => {},
      );
    }
  });
}

/* ───────────── Commands ───────────── */

async function runCommand(
  deps: AgentDeps,
  userId: string,
  command: Command,
  now: Date,
  draft: Awaited<ReturnType<typeof latestPendingDraft>>,
): Promise<{ text: string; kind: string }> {
  const prefs = await getAgentPrefs(userId);
  switch (command.kind) {
    case "help":
      return { text: HELP_TEXT, kind: "command" };
    case "stop":
      await updateAgentPrefs(userId, { proactiveEnabled: false });
      return { text: "Okay, I won't message you first until you text \"start\". You can still text me anytime.", kind: "command" };
    case "start":
      await updateAgentPrefs(userId, { proactiveEnabled: true, pausedUntil: null });
      return { text: `Back on. Your brief comes weekdays at ${prefs.briefTime}.`, kind: "command" };
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
      const data = await gatherBriefData(userId, now, prefs.timezone);
      if (briefIsEmpty(data)) return { text: "Nothing due and nobody going cold. Enjoy the quiet.", kind: "brief" };
      return { text: (await composeBrief(deps.llm, data)).text, kind: "brief" };
    }
    case "approve": {
      if (!draft) return { text: "There's no draft waiting.", kind: "command" };
      const body = decrypt(draft.bodyEnc);
      const firstLine = body.split("\n").find((l) => l.trim() && !/^subject:/i.test(l)) ?? body;
      const [turn] = await getDb().insert(agentTurns).values({ userId, steps: 0 }).returning({ id: agentTurns.id });
      const { id } = await logInteraction({
        personId: draft.personId,
        type: draft.channel === "email" ? "email" : "message",
        summary: `Sent: ${firstLine.trim().slice(0, 120)}`,
        notes: body,
        occurredAt: now,
      });
      await getDb().update(pendingActions).set({ status: "approved", resolvedAt: now }).where(eq(pendingActions.id, draft.id));
      await getDb()
        .insert(agentActions)
        .values({
          userId,
          turnId: turn.id,
          tool: "approve_draft",
          input: { draft_id: draft.id },
          ok: true,
          summary: `Logged the ${draft.channel} you sent to ${draft.name}`,
          undo: { kind: "delete_interaction", id },
        });
      return { text: `Logged as sent to ${draft.name}.`, kind: "command" };
    }
    case "reject":
      if (!draft) return { text: "There's no draft waiting.", kind: "command" };
      await getDb().update(pendingActions).set({ status: "rejected", resolvedAt: now }).where(eq(pendingActions.id, draft.id));
      return { text: `Discarded the draft to ${draft.name}.`, kind: "command" };
  }
}

/* ───────────── Agent turn ───────────── */

export interface TurnInput {
  userId: string;
  messageId: string;
  text: string;
  now: Date;
  /** Owner's phone, for replies. */
  to: string;
}

export interface TurnResult {
  reply: string;
  turnId: string;
  steps: number;
  contextTokens: number;
  draftIds: string[];
}

function textOf(m: ChatMessage): string {
  return typeof m.content === "string" ? m.content : "";
}

export async function runTurn(deps: AgentDeps, input: TurnInput): Promise<TurnResult> {
  const { userId, now } = input;
  const started = Date.now();
  const prefs = await getAgentPrefs(userId);
  const history = (await recentMessages(userId, RECENT_MESSAGE_LIMIT + 1, { kinds: CONVERSATION_KINDS }))
    .filter((m) => m.id !== input.messageId)
    .slice(-RECENT_MESSAGE_LIMIT);
  const ctx = await assembleContext({ userId, now, tz: prefs.timezone, history, newMessage: input.text });
  const [turn] = await getDb()
    .insert(agentTurns)
    .values({ userId, inboundMessageId: input.messageId, contextTokens: ctx.contextTokens })
    .returning({ id: agentTurns.id });

  const toolCtx: ToolContext = { userId, turnId: turn.id, sourceMessageId: input.messageId, now, tz: prefs.timezone };
  const tools = toolSpecs();
  const messages: ChatMessage[] = [...ctx.messages];
  const draftIds: string[] = [];
  const done: string[] = [];
  let reply = "";
  let steps = 0;
  let model: string | undefined;
  let provider: string | undefined;
  let error: string | undefined;

  deps.adapter.sendTyping?.(input.to).catch(() => {});

  try {
    for (; steps < MAX_STEPS; steps++) {
      const res = await deps.llm({ messages, tools, temperature: 0.3, maxTokens: 1500, timeoutMs: 45_000 });
      model = res.model;
      provider = res.provider;
      const calls = (res.message.tool_calls ?? []).map((c, i) => ({ ...c, id: c.id || `call_${steps}_${i}` }));
      if (calls.length === 0) {
        reply = cleanReply(textOf(res.message));
        steps++;
        break;
      }
      messages.push({ role: "assistant", content: textOf(res.message) || null, tool_calls: calls });
      for (const call of calls) {
        const outcome = await executeToolCall(call, toolCtx);
        if (outcome.draftId) draftIds.push(outcome.draftId);
        if (outcome.ok && outcome.undo) done.push(outcome.summary);
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: outcome.text });
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("[agent] model call failed", err);
  }

  if (!reply) {
    reply = done.length
      ? `Done: ${done.join("; ")}.`
      : error
        ? "I couldn't reach my model just now. Your message is saved; try again in a minute."
        : "Got it.";
  }

  await send(deps, userId, input.to, reply, "chat");
  for (const id of draftIds) {
    const [d] = await getDb().select({ bodyEnc: pendingActions.bodyEnc }).from(pendingActions).where(eq(pendingActions.id, id));
    if (d) await send(deps, userId, input.to, decrypt(d.bodyEnc), "draft");
  }

  await getDb()
    .update(agentTurns)
    .set({ model, provider, steps, latencyMs: Date.now() - started, error: error?.slice(0, 500) })
    .where(eq(agentTurns.id, turn.id));

  await maybeUpdateThreadSummary(deps, userId, now).catch((err) => console.error("[agent] summary update failed", err));

  return { reply, turnId: turn.id, steps, contextTokens: ctx.contextTokens, draftIds };
}

/* ───────────── Rolling thread summary ───────────── */

/** Fold messages that have left the recent window into the summary, in batches. */
export const SUMMARY_BATCH = 10;

export async function maybeUpdateThreadSummary(deps: AgentDeps, userId: string, now: Date): Promise<boolean> {
  const window = await recentMessages(userId, RECENT_MESSAGE_LIMIT, { kinds: CONVERSATION_KINDS });
  if (window.length < RECENT_MESSAGE_LIMIT) return false;
  const windowStart = window[0].createdAt;
  const existing = await threadSummary(userId);
  const older = (await messagesBetween(userId, existing?.coversThrough ?? null, windowStart, CONVERSATION_KINDS)).filter(
    (m) => m.createdAt < windowStart,
  );
  if (older.length < SUMMARY_BATCH) return false;

  const transcript = older.map((m) => `${m.direction === "in" ? "Owner" : "Agent"} (${localDate(m.createdAt, "UTC")}): ${m.body}`).join("\n");
  const res = await deps.llm({
    messages: [
      {
        role: "system",
        content:
          "You maintain a running summary of a conversation between a fund manager (the owner) and their relationship-manager agent. Merge the new messages into the existing summary. Keep: open loops and promises, decisions, preferences the owner expressed, and who was discussed and why. Drop small talk and anything already recorded as done. Plain text, at most 1200 characters.",
      },
      { role: "user", content: `Existing summary:\n${existing?.summary ?? "(none)"}\n\nNew messages:\n${transcript}` },
    ],
    temperature: 0.2,
    maxTokens: 600,
    timeoutMs: 45_000,
  });
  const summary = cleanReply(textOf(res.message)).slice(0, 1500);
  if (!summary) return false;
  const coversThrough = older[older.length - 1].createdAt;
  await getDb()
    .insert(threadSummaries)
    .values({ userId, summaryEnc: encrypt(summary), coversThrough, updatedAt: now })
    .onConflictDoUpdate({ target: threadSummaries.userId, set: { summaryEnc: encrypt(summary), coversThrough, updatedAt: now } });
  return true;
}

/* ───────────── Morning brief tick ───────────── */

export interface BriefTickResult {
  userId: string;
  sent: boolean;
  skipped?: BriefSkipReason | "no_phone" | "error";
  preview?: string;
}

/**
 * Called by the cron route every ~15 minutes. Sends each owner's weekday
 * brief once, inside their window, within the unprompted budget (HA-8).
 */
export async function runBriefTick(deps: AgentDeps, opts: { dryRun?: boolean } = {}): Promise<BriefTickResult[]> {
  const now = deps.now();
  const results: BriefTickResult[] = [];
  for (const binding of await listVerifiedBindings()) {
    const userId = binding.userId;
    const result = await runAsOwner(userId, "cron", async (): Promise<BriefTickResult> => {
      if (!binding.phone) return { userId, sent: false, skipped: "no_phone" };
      const prefs = await getAgentPrefs(userId);
      const skip = briefScheduleCheck(prefs, now, await unpromptedCountToday(userId, now, prefs.timezone));
      if (skip) return { userId, sent: false, skipped: skip };
      const data = await gatherBriefData(userId, now, prefs.timezone);
      if (briefIsEmpty(data)) return { userId, sent: false, skipped: "nothing_due" };
      if (opts.dryRun) {
        const { text } = await composeBrief(deps.llm, data);
        return { userId, sent: false, preview: text };
      }
      const logId = await claimBriefSlot(userId, now, prefs.timezone);
      if (!logId) return { userId, sent: false, skipped: "already_sent" };
      try {
        const { text } = await composeBrief(deps.llm, data);
        const res = await deps.adapter.sendText(binding.phone, text);
        const messageId = await insertOutbound({ userId, provider: deps.adapter.name, providerMessageId: res.providerMessageId, body: text, kind: "brief" });
        await attachNotificationMessage(logId, messageId);
        return { userId, sent: true };
      } catch (err) {
        console.error("[agent] brief send failed", err);
        await releaseNotification(logId);
        return { userId, sent: false, skipped: "error" };
      }
    });
    results.push(result);
  }
  return results;
}

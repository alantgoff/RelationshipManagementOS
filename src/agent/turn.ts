import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agentTurns, pendingActions, threadSummaries } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { localDate, localMinutes } from "@/lib/time";
import { assembleContext, HISTORY_KEEP, HISTORY_MAX, messageTokens, threadSummary } from "./context";
import type { ChatMessage } from "./llm";
import type { AgentDeps } from "./runtime";
import { conversationSince, countConversationSince, getAgentPrefs, insertOutbound, type StoredMessage } from "./store";
import { cleanReply, splitMessage, stripReasoning } from "./text";
import { toolSpecs } from "./tool-specs";
import { executeToolCall, type ToolContext } from "./tools";

/**
 * One agent turn: answer the owner's newest message(s) with a bounded tool
 * loop. The turn runs against a real-clock deadline (the webhook's function
 * budget), always ends with a text answer the model wrote after seeing its
 * last tool results, and never claims more than the tools confirmed.
 */

/** Message kinds that form the conversation the model sees. */
export const CONVERSATION_KINDS = ["chat", "brief", "draft", "system"];
/** Tool-calling rounds before the model must answer in text. */
export const MAX_STEPS = 6;
/** Once the running prompt passes this, the next call must answer in text (HA-7). */
export const LOOP_TOKEN_LIMIT = 24_000;
/** Time kept back from the deadline for sending the reply. */
export const SEND_RESERVE_MS = 5_000;
const MIN_CALL_MS = 4_000;
const MODEL_CALL_CAP_MS = 30_000;

export interface TurnInput {
  userId: string;
  /** The owner's messages answered in this turn, oldest first. */
  messages: StoredMessage[];
  now: Date;
  /** Owner's phone, for replies. */
  to: string;
  /** Real-clock deadline (ms since epoch) for the whole turn, sending included. */
  deadline: number;
}

export interface TurnResult {
  reply: string;
  turnId: string;
  steps: number;
  contextTokens: number;
  draftIds: string[];
  /** False if the reply could not be delivered. */
  sent: boolean;
}

const textOf = (m: ChatMessage) => (typeof m.content === "string" ? m.content : "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send one message, retrying transient failures while the deadline allows. */
async function sendWithRetry(deps: AgentDeps, to: string, text: string, deadline: number): Promise<{ providerMessageId?: string }> {
  const delays = [0, 1_000, 3_000];
  let lastErr: unknown;
  for (const [i, delay] of delays.entries()) {
    if (i > 0 && Date.now() + delay > deadline) break;
    if (delay) await sleep(delay);
    try {
      return await deps.adapter.sendText(to, text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Send a message in parts and record each. A part that can't be delivered is
 * still recorded (with an error) so the next turn's history matches what was
 * done. Returns false if anything failed to send.
 */
export async function sendOut(deps: AgentDeps, userId: string, to: string, body: string, kind: string, deadline = Date.now() + 15_000): Promise<boolean> {
  for (const part of splitMessage(body)) {
    try {
      const res = await sendWithRetry(deps, to, part, deadline);
      await insertOutbound({ userId, provider: deps.adapter.name, providerMessageId: res.providerMessageId, body: part, kind });
    } catch (err) {
      console.error("[agent] send failed", err);
      await insertOutbound({ userId, provider: deps.adapter.name, body: part, kind, error: "not delivered" }).catch(() => {});
      return false;
    }
  }
  return true;
}

export async function runTurn(deps: AgentDeps, input: TurnInput): Promise<TurnResult> {
  const { userId, now } = input;
  const started = Date.now();
  const last = input.messages[input.messages.length - 1];
  const prefs = await getAgentPrefs(userId);
  const summary = await threadSummary(userId);
  const history = await conversationSince(userId, summary?.coversThrough ?? null, input.messages[0].createdAt, CONVERSATION_KINDS, HISTORY_MAX);
  const text = input.messages.map((m) => m.body).join("\n");
  const ctx = await assembleContext({ userId, now, tz: prefs.timezone, history, newMessage: text });
  const [turn] = await getDb()
    .insert(agentTurns)
    .values({ userId, inboundMessageId: last.id, contextTokens: ctx.contextTokens })
    .returning({ id: agentTurns.id });

  const toolCtx: ToolContext = { userId, turnId: turn.id, sourceMessageId: last.id, now, tz: prefs.timezone };
  const tools = toolSpecs();
  const messages: ChatMessage[] = [...ctx.messages];
  let tokens = ctx.contextTokens;
  const draftIds: string[] = [];
  const done: string[] = [];
  let reply = "";
  let steps = 0;
  let toolRounds = 0;
  let model: string | undefined;
  let provider: string | undefined;
  let error: string | undefined;
  let timedOut = false;
  let lengthRetried = false;
  const remaining = () => input.deadline - Date.now() - SEND_RESERVE_MS;

  deps.adapter.sendTyping?.(input.to).catch(() => {});

  try {
    for (;;) {
      if (remaining() < MIN_CALL_MS) {
        timedOut = true;
        break;
      }
      // After the last tool round, or once the prompt is large, the model must answer in text.
      const final = toolRounds >= MAX_STEPS || tokens > LOOP_TOKEN_LIMIT;
      const res = await deps.llm({
        messages,
        tools,
        toolChoice: final ? "none" : "auto",
        temperature: 0.3,
        maxTokens: lengthRetried ? 3_000 : 1_500,
        timeoutMs: Math.min(MODEL_CALL_CAP_MS, remaining()),
      });
      steps++;
      model = res.model;
      provider = res.provider;
      const calls = final ? [] : (res.message.tool_calls ?? []).map((c, i) => ({ ...c, id: c.id || `call_${steps}_${i}` }));
      if (calls.length === 0) {
        // Cut off (often mid-reasoning): try once more with room to finish.
        if (res.finishReason === "length" && !lengthRetried) {
          lengthRetried = true;
          continue;
        }
        reply = cleanReply(textOf(res.message));
        break;
      }
      toolRounds++;
      const assistant: ChatMessage = { role: "assistant", content: textOf(res.message) || null, tool_calls: calls };
      messages.push(assistant);
      tokens += messageTokens(assistant);
      for (const call of calls) {
        const outcome = await executeToolCall(call, toolCtx);
        if (outcome.draftId) draftIds.push(outcome.draftId);
        if (outcome.ok && outcome.undo) done.push(outcome.summary);
        const result: ChatMessage = { role: "tool", tool_call_id: call.id, name: call.function.name, content: outcome.text };
        messages.push(result);
        tokens += messageTokens(result);
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("[agent] model call failed", err);
  }

  if (!reply) {
    // Honest fallbacks: say exactly what was saved; only suggest resending when nothing was.
    if (done.length) {
      reply = `Done: ${done.join("; ")}.${error || timedOut ? " I got cut off before finishing, so tell me if anything's missing." : ""}`;
    } else if (timedOut) {
      reply = "I ran out of time on that one and nothing was saved. Could you send it again?";
    } else if (error) {
      reply = "I couldn't reach my model just now, so nothing was saved. Text me again in a minute.";
    } else {
      reply = "I didn't manage to answer that, and nothing was saved. Could you say it another way?";
    }
  }
  if (timedOut && !error) error = "turn ran out of time";

  // Record the turn before sending, so the audit survives a failed send.
  await getDb()
    .update(agentTurns)
    .set({ model, provider, steps, latencyMs: Date.now() - started, error: error?.slice(0, 500) })
    .where(eq(agentTurns.id, turn.id));

  let sent = await sendOut(deps, userId, input.to, reply, "chat", input.deadline);
  if (sent && draftIds.length) {
    const drafts = await getDb().select({ id: pendingActions.id, bodyEnc: pendingActions.bodyEnc }).from(pendingActions).where(inArray(pendingActions.id, draftIds));
    for (const id of draftIds) {
      const d = drafts.find((x) => x.id === id);
      if (d) sent = (await sendOut(deps, userId, input.to, decrypt(d.bodyEnc), "draft", input.deadline)) && sent;
    }
  }

  return { reply, turnId: turn.id, steps, contextTokens: ctx.contextTokens, draftIds, sent };
}

/* ───────────── Rolling thread summary ───────────── */

/** Most messages folded into the summary in one pass. */
export const FOLD_MAX = 40;
const FOLD_MESSAGE_CHARS = 1_000;

const SUMMARY_SYSTEM =
  "You maintain a running summary of a conversation between a fund manager (the owner) and their relationship-manager agent. Merge the new messages into the existing summary. Keep: open loops and promises, decisions, preferences the owner expressed, and who was discussed and why, with dates. Drop small talk and anything already recorded as done. Plain text, at most 1200 characters.";

/**
 * When more than HISTORY_MAX conversation messages follow the summary cursor,
 * fold the oldest into the summary and keep the newest HISTORY_KEEP verbatim.
 * Returns true if the summary moved.
 */
export async function maybeUpdateThreadSummary(deps: AgentDeps, userId: string, now: Date, timeoutMs = 30_000): Promise<boolean> {
  const existing = await threadSummary(userId);
  const after = existing?.coversThrough ?? null;
  const total = await countConversationSince(userId, after, CONVERSATION_KINDS);
  if (total <= HISTORY_MAX) return false;
  const older = await conversationSince(userId, after, null, CONVERSATION_KINDS, Math.min(total - HISTORY_KEEP, FOLD_MAX), "oldest");
  if (older.length === 0) return false;

  const { timezone } = await getAgentPrefs(userId);
  const stamp = (d: Date) => {
    const m = localMinutes(d, timezone);
    return `${localDate(d, timezone)} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const transcript = older
    .map((m) => `${m.direction === "in" ? "Owner" : "Agent"} (${stamp(m.createdAt)}): ${m.body.slice(0, FOLD_MESSAGE_CHARS)}`)
    .join("\n");
  const res = await deps.llm({
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: `Existing summary:\n${existing?.summary ?? "(none)"}\n\nNew messages (owner's local time):\n${transcript}` },
    ],
    temperature: 0.2,
    maxTokens: 800,
    timeoutMs,
  });
  const summary = stripReasoning(textOf(res.message)).slice(0, 1500);
  if (!summary) return false;
  const coversThrough = older[older.length - 1].createdAt;
  await getDb()
    .insert(threadSummaries)
    .values({ userId, summaryEnc: encrypt(summary), coversThrough, updatedAt: now })
    .onConflictDoUpdate({ target: threadSummaries.userId, set: { summaryEnc: encrypt(summary), coversThrough, updatedAt: now } });
  return true;
}

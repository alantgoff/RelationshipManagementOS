import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { memoryFacts, pendingActions, people, threadSummaries } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { localDate, localMinutes, weekdayName } from "@/lib/time";
import { getDashboard } from "@/server/queries/dashboard";
import { listPeople, type PersonRow } from "@/server/queries/people";
import type { ChatMessage } from "./llm";
import { AGENT_SYSTEM_PROMPT } from "./prompt";
import type { StoredMessage } from "./store";
import { personLine, shortId } from "./tools";

/**
 * Per-turn context assembly (ADR-0003). Layout, stable first so a provider's
 * prefix cache can reuse it from turn to turn:
 *
 *   1. system: the frozen agent prompt (tools are sent alongside, sorted)
 *   2. the recent conversation, verbatim, oldest first (tool results are never
 *      replayed; the agent re-reads data through tools when it needs it)
 *   3. the new message, prefixed by a <context> block that is rebuilt every turn:
 *      date and time, rolling summary of older conversation, facts about the
 *      owner, people in play, what's due, pending drafts.
 *
 * Everything is budgeted in estimated tokens so a months-long thread still
 * fits well under the spec's 20k ceiling (HA-7).
 */

export const CONTEXT_BUDGET_TOKENS = 18_000;
export const RECENT_MESSAGE_LIMIT = 12;
const MAX_PEOPLE_IN_PLAY = 8;
const MAX_FACTS_PER_PERSON = 3;

/** Rough token estimate (≈4 characters per token for English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function messageTokens(m: ChatMessage): number {
  const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  return estimateTokens(content) + estimateTokens(JSON.stringify(m.tool_calls ?? "")) + 4;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names a person might be called by in a text: full name, preferred name, first name. */
function aliases(p: Pick<PersonRow, "fullName" | "preferredName">): string[] {
  const first = p.fullName.trim().split(/\s+/)[0];
  return [...new Set([p.fullName, p.preferredName, first].filter((x): x is string => Boolean(x && x.length >= 2)))];
}

/**
 * People mentioned in recent text, most recently mentioned first. A first name
 * shared by several people pulls in all of them, so the model can ask which.
 */
export function findMentionedPeople(rows: PersonRow[], textsNewestFirst: string[], max = MAX_PEOPLE_IN_PLAY): PersonRow[] {
  const found: PersonRow[] = [];
  const seen = new Set<string>();
  for (const text of textsNewestFirst) {
    for (const p of rows) {
      if (seen.has(p.id)) continue;
      const hit = aliases(p).some((a) => new RegExp(`(^|[^\\p{L}])${escapeRe(a)}($|[^\\p{L}])`, "iu").test(text));
      if (hit) {
        seen.add(p.id);
        found.push(p);
      }
    }
    if (found.length >= max) break;
  }
  return found.slice(0, max);
}

export interface WorkingSetInput {
  userId: string;
  now: Date;
  tz: string;
  /** Owner and agent texts, newest first, including the new message. */
  recentTexts: string[];
}

export async function buildWorkingSet(input: WorkingSetInput): Promise<{ text: string; peopleInPlay: PersonRow[] }> {
  const { userId, now, tz } = input;
  const db = getDb();
  const all = await listPeople({ sort: "name" }, now);
  const inPlay = findMentionedPeople(all, input.recentTexts);

  const sections: string[] = [];

  if (inPlay.length) {
    const facts = await db
      .select()
      .from(memoryFacts)
      .where(and(eq(memoryFacts.userId, userId), inArray(memoryFacts.personId, inPlay.map((p) => p.id)), isNull(memoryFacts.validTo)))
      .orderBy(desc(memoryFacts.createdAt));
    const byPerson = new Map<string, string[]>();
    for (const f of facts) {
      const list = byPerson.get(f.personId!) ?? [];
      if (list.length < MAX_FACTS_PER_PERSON) list.push(f.fact);
      byPerson.set(f.personId!, list);
    }
    sections.push(
      "People in play (mentioned recently):\n" +
        inPlay
          .map((p) => {
            const f = byPerson.get(p.id);
            const last = p.lastSummary ? `\n  last: ${p.lastSummary}` : "";
            return `- ${personLine(p, tz)}${last}${f?.length ? `\n  facts: ${f.join("; ")}` : ""}`;
          })
          .join("\n"),
    );
  }

  const d = await getDashboard(undefined, now);
  const dueLines: string[] = [];
  if (d.attention.length) {
    const top = d.attention.slice(0, 5).map((p) => `${p.fullName} [${shortId(p.id)}] (${p.health})`);
    dueLines.push(`${d.attention.length} people need attention; most urgent: ${top.join(", ")}`);
  }
  for (const f of d.followUps.slice(0, 6)) {
    dueLines.push(`follow-up [${shortId(f.id)}] ${f.description} → ${f.personName}${f.dueAt ? `, due ${localDate(f.dueAt, tz)}` : ""}${f.overdue ? " (overdue)" : ""}`);
  }
  for (const r of d.reminders.slice(0, 4)) {
    dueLines.push(`reminder [${shortId(r.id)}] ${r.reason} → ${r.personName}, ${localDate(r.dueAt, tz)}${r.overdue ? " (overdue)" : ""}`);
  }
  if (dueLines.length) sections.push(`Due:\n${dueLines.map((l) => `- ${l}`).join("\n")}`);

  const drafts = await db
    .select({ id: pendingActions.id, channel: pendingActions.channel, createdAt: pendingActions.createdAt, name: people.fullName })
    .from(pendingActions)
    .innerJoin(people, eq(people.id, pendingActions.personId))
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, "pending")))
    .orderBy(desc(pendingActions.createdAt))
    .limit(3);
  if (drafts.length) {
    sections.push(
      `Drafts waiting for the owner to send:\n${drafts.map((x) => `- ${x.channel} to ${x.name} (${localDate(x.createdAt, tz)})`).join("\n")}`,
    );
  }

  return { text: sections.join("\n\n"), peopleInPlay: inPlay };
}

export async function ownerFacts(userId: string, limit = 10): Promise<string[]> {
  const rows = await getDb()
    .select({ fact: memoryFacts.fact })
    .from(memoryFacts)
    .where(and(eq(memoryFacts.userId, userId), isNull(memoryFacts.personId), isNull(memoryFacts.validTo)))
    .orderBy(desc(memoryFacts.createdAt))
    .limit(limit);
  return rows.map((r) => r.fact);
}

export async function threadSummary(userId: string): Promise<{ summary: string; coversThrough: Date } | null> {
  const [row] = await getDb().select().from(threadSummaries).where(eq(threadSummaries.userId, userId));
  if (!row) return null;
  try {
    return { summary: decrypt(row.summaryEnc), coversThrough: row.coversThrough };
  } catch {
    return null;
  }
}

export interface AssembleInput {
  userId: string;
  now: Date;
  tz: string;
  /** Prior messages, oldest first (excluding the new one). */
  history: StoredMessage[];
  /** The owner's new message, with attachment text appended. */
  newMessage: string;
}

export interface AssembledContext {
  messages: ChatMessage[];
  contextTokens: number;
  peopleInPlay: PersonRow[];
}

/** Map stored messages to chat roles. Owner → user; agent (replies, briefs, drafts) → assistant. */
function historyToMessages(history: StoredMessage[]): ChatMessage[] {
  return history.map((m) => ({
    role: m.direction === "in" ? "user" : "assistant",
    content: m.kind === "draft" ? `[Draft shown to the owner]\n${m.body}` : m.body,
  }));
}

export async function assembleContext(input: AssembleInput): Promise<AssembledContext> {
  const { userId, now, tz } = input;
  const recentTexts = [input.newMessage, ...[...input.history].reverse().slice(0, 6).map((m) => m.body)];
  const [working, facts, summary] = await Promise.all([
    buildWorkingSet({ userId, now, tz, recentTexts }),
    ownerFacts(userId),
    threadSummary(userId),
  ]);

  const minutes = localMinutes(now, tz);
  const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const ctxParts = [`Today is ${weekdayName(now, tz)}, ${localDate(now, tz)}; local time ${time} (${tz}).`];
  if (summary?.summary) ctxParts.push(`Earlier in this conversation (summary):\n${summary.summary}`);
  if (facts.length) ctxParts.push(`About the owner:\n${facts.map((f) => `- ${f}`).join("\n")}`);
  if (working.text) ctxParts.push(working.text);
  const contextBlock = `<context>\n${ctxParts.join("\n\n")}\n</context>`;

  const system: ChatMessage = { role: "system", content: AGENT_SYSTEM_PROMPT };
  const final: ChatMessage = { role: "user", content: `${contextBlock}\n\n${input.newMessage}` };

  // Keep as much recent history as fits the budget, dropping the oldest first.
  let history = historyToMessages(input.history.slice(-RECENT_MESSAGE_LIMIT));
  const fixed = messageTokens(system) + messageTokens(final) + 2_500; // tool schemas ≈ 2.5k
  let historyTokens = history.reduce((n, m) => n + messageTokens(m), 0);
  while (history.length && fixed + historyTokens > CONTEXT_BUDGET_TOKENS) {
    historyTokens -= messageTokens(history[0]);
    history = history.slice(1);
  }
  // A conversation should not start with an assistant turn.
  while (history.length && history[0].role !== "user") {
    historyTokens -= messageTokens(history[0]);
    history = history.slice(1);
  }

  return {
    messages: [system, ...history, final],
    contextTokens: fixed + historyTokens,
    peopleInPlay: working.peopleInPlay,
  };
}

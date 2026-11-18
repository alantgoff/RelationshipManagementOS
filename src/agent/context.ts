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
 * Everything is budgeted in estimated tokens. The assembled prompt stays under
 * CONTEXT_BUDGET_TOKENS, leaving room for tool results below the spec's 20k
 * per-call ceiling (HA-7), which the turn loop enforces (LOOP_TOKEN_LIMIT).
 */

export const CONTEXT_BUDGET_TOKENS = 14_000;
/**
 * History policy: the conversation after the rolling summary's cursor is
 * replayed verbatim. Once it passes HISTORY_MAX messages or HISTORY_FOLD_TOKENS
 * (src/agent/turn.ts), the oldest are folded into the summary after the turn,
 * keeping a short verbatim tail. So replayed history is normally contiguous
 * with the summary, and its start only moves on a fold, which keeps the
 * provider's prefix cache warm. A single turn that arrives with more history
 * than fits the budget drops its oldest messages for that turn only; the fold
 * that follows puts them into the summary.
 */
export const HISTORY_MAX = 24;
export const HISTORY_KEEP = 12;
const MAX_PEOPLE_IN_PLAY = 8;
const MAX_FACTS_PER_PERSON = 3;
const MAX_DRAFTS_LISTED = 8;
/** Rough size of the tool schemas sent with every call. */
export const TOOL_SCHEMA_TOKENS = 2_800;

/** Rough token estimate (≈4 characters per token for English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function messageTokens(m: ChatMessage): number {
  const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  return estimateTokens(content) + estimateTokens(JSON.stringify(m.tool_calls ?? "")) + 4;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * First names that are also everyday words. They only count as a mention when
 * capitalized ("Mark said…", not "mark it done"), and only in the owner's texts.
 */
export const COMMON_WORD_NAMES = new Set(
  [
    "al", "an", "april", "art", "august", "autumn", "bill", "bob", "brook", "buck", "cash", "chance", "chase", "chip", "christian",
    "clay", "cliff", "colt", "dale", "dash", "dawn", "dean", "destiny", "don", "drew", "duke", "earl", "eve", "faith", "fern",
    "frank", "gene", "gil", "glen", "grace", "grant", "guy", "harmony", "heath", "holly", "hope", "hunter", "iris", "ivy", "jack",
    "jade", "jay", "jean", "jewel", "jimmy", "job", "joy", "judge", "june", "king", "lance", "lane", "lark", "lily", "major", "march",
    "mark", "mason", "matt", "max", "may", "mercy", "miles", "millie", "mike", "misty", "nick", "noble", "pat", "patience", "pearl",
    "penny", "pepper", "pierce", "rich", "river", "rob", "robin", "rose", "ruby", "rusty", "sage", "sandy", "scott", "sky", "skye",
    "sonny", "stone", "storm", "sue", "summer", "sunny", "tad", "tank", "ted", "tom", "trinity", "ty", "van", "victor", "violet",
    "wade", "ward", "will", "win", "winter", "wren", "young",
  ],
);

export interface MentionText {
  text: string;
  /** Owner texts may refer to people by first name; agent texts only count full names. */
  fromOwner: boolean;
}

const wordRe = (alias: string, caseSensitive: boolean) =>
  new RegExp(`(^|[^\\p{L}])${escapeRe(alias)}($|[^\\p{L}])`, caseSensitive ? "u" : "iu");

/** Short aliases a person is called by in a text: preferred name and first name. */
function shortAliases(p: Pick<PersonRow, "fullName" | "preferredName">): string[] {
  const first = p.fullName.trim().split(/\s+/)[0];
  return [...new Set([p.preferredName?.trim(), first].filter((x): x is string => Boolean(x && x.length >= 2 && x !== p.fullName.trim())))];
}

/**
 * A name that is also a common word counts only when capitalized mid-sentence:
 * "Will Chen" is caught by the full name, but "Will send the deck." (sentence
 * start, capitalized by the keyboard) and "Don't" (a contraction) are words.
 */
function commonWordNameHit(name: string, text: string): boolean {
  const re = new RegExp(`(^|[^\\p{L}])${escapeRe(name)}(?=$|[^\\p{L}])`, "gu");
  for (const m of text.matchAll(re)) {
    const at = m.index + m[1].length;
    const before = text.slice(0, at);
    const after = text.slice(at + name.length);
    if (/(^|[.!?…]["”’)]?\s+|\n\s*)$/u.test(before) || /^\s*$/.test(before)) continue;
    if (/^['’](t|ll|re|ve|d)\b/i.test(after)) continue;
    return true;
  }
  return false;
}

function aliasHit(alias: string, text: string): boolean {
  const lower = alias.toLowerCase();
  if (COMMON_WORD_NAMES.has(lower)) return commonWordNameHit(lower[0].toUpperCase() + lower.slice(1), text);
  return wordRe(alias, false).test(text);
}

/**
 * People mentioned in recent text, most recently mentioned first. Full names
 * win: "Sam Lee" pulls in Sam Lee, not every Sam. A first name shared by
 * several people (with no full name given) pulls in all of them, so the model
 * can ask which.
 */
export function findMentionedPeople(rows: PersonRow[], textsNewestFirst: MentionText[], max = MAX_PEOPLE_IN_PLAY): PersonRow[] {
  const found: PersonRow[] = [];
  const seen = new Set<string>();
  const add = (p: PersonRow) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    found.push(p);
  };
  for (const { text, fromOwner } of textsNewestFirst) {
    let rest = text;
    for (const p of rows) {
      const full = p.fullName.trim();
      if (full.includes(" ") && wordRe(full, false).test(rest)) {
        add(p);
        rest = rest.replace(new RegExp(escapeRe(full), "giu"), " ");
      }
    }
    if (fromOwner) {
      for (const p of rows) {
        if (seen.has(p.id)) continue;
        if (shortAliases(p).some((a) => aliasHit(a, rest)) || (!p.fullName.trim().includes(" ") && aliasHit(p.fullName.trim(), rest))) add(p);
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
  recentTexts: MentionText[];
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
    .select({ id: pendingActions.id, channel: pendingActions.channel, createdAt: pendingActions.createdAt, bodyEnc: pendingActions.bodyEnc, name: people.fullName })
    .from(pendingActions)
    .innerJoin(people, eq(people.id, pendingActions.personId))
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, "pending")))
    .orderBy(desc(pendingActions.createdAt))
    .limit(MAX_DRAFTS_LISTED + 1);
  if (drafts.length) {
    const opening = (enc: string) => {
      try {
        const body = decrypt(enc);
        const line = body.split("\n").find((l) => l.trim() && !/^subject:/i.test(l)) ?? body;
        return line.trim().slice(0, 60);
      } catch {
        return "";
      }
    };
    const more = drafts.length > MAX_DRAFTS_LISTED ? "\n- …and more; ask the owner which one they mean." : "";
    sections.push(
      `Drafts waiting for the owner to send (draft id, newest first):\n${drafts
        .slice(0, MAX_DRAFTS_LISTED)
        .map((x) => `- [${shortId(x.id)}] ${x.channel} to ${x.name} (${localDate(x.createdAt, tz)}): "${opening(x.bodyEnc)}…"`)
        .join("\n")}${more}`,
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
  /** Prior conversation after the summary cursor, oldest first (excluding the new messages). */
  history: StoredMessage[];
  /** The owner's new message(s), with attachment text included. */
  newMessage: string;
}

export interface AssembledContext {
  messages: ChatMessage[];
  contextTokens: number;
  peopleInPlay: PersonRow[];
}

/**
 * Map stored messages to chat roles (owner → user; agent replies, briefs and
 * drafts → assistant), merging consecutive messages from the same side so roles
 * alternate. If the history opens with the agent (a brief, or after a long
 * silence), a short user line goes first instead of dropping those messages.
 */
export function historyToMessages(history: StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    const role = m.direction === "in" ? "user" : "assistant";
    const label =
      m.direction === "out" && m.error
        ? m.kind === "draft"
          ? "[Draft NOT delivered: the owner never saw it]\n"
          : "[NOT delivered: the owner never saw this]\n"
        : m.kind === "draft"
          ? "[Draft shown to the owner]\n"
          : m.kind === "brief"
            ? "[Morning brief]\n"
            : "";
    const content = `${label}${m.body}`;
    const last = out.at(-1);
    if (last && last.role === role) last.content = `${String(last.content)}\n\n${content}`;
    else out.push({ role, content });
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: "(Earlier conversation)" });
  return out;
}

export async function assembleContext(input: AssembleInput): Promise<AssembledContext> {
  const { userId, now, tz } = input;
  const recentTexts: MentionText[] = [
    { text: input.newMessage, fromOwner: true },
    ...[...input.history].reverse().slice(0, 6).map((m) => ({ text: m.body, fromOwner: m.direction === "in" })),
  ];
  const [working, facts, summary] = await Promise.all([
    buildWorkingSet({ userId, now, tz, recentTexts }),
    ownerFacts(userId),
    threadSummary(userId),
  ]);

  const minutes = localMinutes(now, tz);
  const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const ctxParts = [`Today is ${weekdayName(now, tz)}, ${localDate(now, tz)}; local time ${time} (${tz}).`];
  if (summary?.summary) ctxParts.push(`Earlier in this conversation (summary):\n${summary.summary}`);
  if (facts.length) ctxParts.push(`About the owner (newest; use recall for older facts):\n${facts.map((f) => `- ${f}`).join("\n")}`);
  if (working.text) ctxParts.push(working.text);
  const contextBlock = `<context>\n${ctxParts.join("\n\n")}\n</context>`;

  const system: ChatMessage = { role: "system", content: AGENT_SYSTEM_PROMPT };
  const final: ChatMessage = { role: "user", content: `${contextBlock}\n\n${input.newMessage}` };

  // Keep as much history as fits the budget, dropping the oldest first.
  let kept = input.history.slice(-HISTORY_MAX);
  const fixed = messageTokens(system) + messageTokens(final) + TOOL_SCHEMA_TOKENS;
  let history = historyToMessages(kept);
  let historyTokens = history.reduce((n, m) => n + messageTokens(m), 0);
  while (kept.length && fixed + historyTokens > CONTEXT_BUDGET_TOKENS) {
    kept = kept.slice(1);
    history = historyToMessages(kept);
    historyTokens = history.reduce((n, m) => n + messageTokens(m), 0);
  }
  // The newest history message must not be a user turn directly before the new user turn.
  if (history.at(-1)?.role === "user") history.push({ role: "assistant", content: "(no reply)" });

  return {
    messages: [system, ...history, final],
    contextTokens: fixed + history.reduce((n, m) => n + messageTokens(m), 0),
    peopleInPlay: working.peopleInPlay,
  };
}

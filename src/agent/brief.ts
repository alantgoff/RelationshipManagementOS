import { HEALTH_LABELS } from "@/domain/enums";
import { inWindow, localDate, localMinutes, parseHM, weekdayName, zonedParts } from "@/lib/time";
import { getDashboard } from "@/server/queries/dashboard";
import type { ChatRequest, ChatResult } from "./llm";
import type { AgentPrefs } from "./store";
import { stripReasoning } from "./text";
import { shortId } from "./tools";
import { and, eq, isNull, desc, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { memoryFacts, pendingActions } from "@/db/schema";

/** How long after the brief time a late cron tick may still send it. */
export const BRIEF_WINDOW_MINUTES = 150;

export type BriefSkipReason =
  | "weekend"
  | "not_time_yet"
  | "window_passed"
  | "stopped"
  | "paused"
  | "quiet_hours"
  | "daily_limit"
  | "already_sent"
  | "nothing_due";

/** Pure schedule check for the weekday morning brief (HA-8). */
export function briefScheduleCheck(prefs: AgentPrefs, now: Date, sentToday: number): BriefSkipReason | null {
  const { weekday } = zonedParts(now, prefs.timezone);
  if (weekday === 0 || weekday === 6) return "weekend";
  const start = parseHM(prefs.briefTime) ?? 7 * 60 + 30;
  const minutes = localMinutes(now, prefs.timezone);
  if (minutes < start) return "not_time_yet";
  if (minutes >= start + BRIEF_WINDOW_MINUTES) return "window_passed";
  if (!prefs.proactiveEnabled) return "stopped";
  if (prefs.pausedUntil && prefs.pausedUntil > now) return "paused";
  const qs = parseHM(prefs.quietStart);
  const qe = parseHM(prefs.quietEnd);
  if (qs !== null && qe !== null && inWindow(minutes, qs, qe)) return "quiet_hours";
  if (sentToday >= prefs.dailyUnpromptedLimit) return "daily_limit";
  return null;
}

export interface BriefData {
  today: string;
  weekday: string;
  reachOut: { name: string; id: string; health: string; lastContact: string | null; lastSummary: string | null; cadenceDays: number | null; facts: string[] }[];
  dueToday: { text: string; person: string; overdue: boolean }[];
  draftsWaiting: number;
  needAttentionTotal: number;
}

export async function gatherBriefData(userId: string, now: Date, tz: string): Promise<BriefData> {
  const d = await getDashboard(undefined, now);
  const today = localDate(now, tz);
  const reach = d.attention.slice(0, 3);
  const facts = reach.length
    ? await getDb()
        .select({ personId: memoryFacts.personId, fact: memoryFacts.fact })
        .from(memoryFacts)
        .where(and(eq(memoryFacts.userId, userId), inArray(memoryFacts.personId, reach.map((p) => p.id)), isNull(memoryFacts.validTo)))
        .orderBy(desc(memoryFacts.createdAt))
    : [];
  const drafts = await getDb()
    .select({ id: pendingActions.id })
    .from(pendingActions)
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, "pending")));
  return {
    today,
    weekday: weekdayName(now, tz),
    reachOut: reach.map((p) => ({
      name: p.fullName,
      id: shortId(p.id),
      health: HEALTH_LABELS[p.health].toLowerCase(),
      lastContact: p.lastInteractionAt ? localDate(p.lastInteractionAt, tz) : null,
      lastSummary: p.lastSummary,
      cadenceDays: p.cadenceDays,
      facts: facts.filter((f) => f.personId === p.id).slice(0, 2).map((f) => f.fact),
    })),
    dueToday: [
      // Undated follow-ups aren't "due today"; they surface through the dashboard instead.
      ...d.followUps
        .filter((f) => f.dueAt && localDate(f.dueAt, tz) <= today)
        .map((f) => ({ text: f.description, person: f.personName, overdue: f.overdue })),
      ...d.reminders.filter((r) => localDate(r.dueAt, tz) <= today).map((r) => ({ text: r.reason, person: r.personName, overdue: r.overdue })),
    ].slice(0, 6),
    draftsWaiting: drafts.length,
    needAttentionTotal: d.attention.length,
  };
}

export function briefIsEmpty(d: BriefData): boolean {
  return d.reachOut.length === 0 && d.dueToday.length === 0 && d.draftsWaiting === 0;
}

/** Plain template used when the model is unavailable. */
export function renderBriefFallback(d: BriefData): string {
  const lines = [`Good morning. ${d.weekday}'s brief:`];
  if (d.dueToday.length) {
    lines.push(`Due: ${d.dueToday.map((x) => `${x.text} (${x.person}${x.overdue ? ", overdue" : ""})`).join("; ")}.`);
  }
  if (d.reachOut.length) {
    lines.push(
      `Reach out: ${d.reachOut.map((p) => `${p.name} (${p.lastContact ? `${p.health}, last ${p.lastContact}` : "never contacted"})`).join("; ")}.`,
    );
  }
  if (d.draftsWaiting) lines.push(`${d.draftsWaiting} draft${d.draftsWaiting > 1 ? "s" : ""} waiting for you to send.`);
  if (lines.length === 1) lines.push("Nothing urgent today.");
  return lines.join("\n");
}

const BRIEF_SYSTEM = `You write a venture capital fund manager's morning brief, delivered by iMessage. Use only the data given. Plain text, no markdown, at most 8 short lines:
1. One line on what's due today (promises first, overdue flagged).
2. For each person to reach out to: name, a few words on why now, and a one-sentence opener the owner could send, grounded in the last conversation or facts. Never invent details.
3. If drafts are waiting, one line saying so.
End with: Reply "brief" anytime, or tell me who you talked to.`;

/** Compose the brief, falling back to the template if the model fails. */
export async function composeBrief(
  llm: (req: ChatRequest) => Promise<ChatResult>,
  d: BriefData,
  timeoutMs = 45_000,
): Promise<{ text: string; usedModel: boolean }> {
  try {
    const res = await llm({
      messages: [
        { role: "system", content: BRIEF_SYSTEM },
        { role: "user", content: `Data for ${d.weekday}, ${d.today}:\n${JSON.stringify(d, null, 1)}` },
      ],
      temperature: 0.4,
      maxTokens: 700,
      timeoutMs,
    });
    const text = typeof res.message.content === "string" ? stripReasoning(res.message.content) : "";
    if (text.length >= 20 && res.finishReason !== "length") return { text, usedModel: true };
  } catch (err) {
    console.error("[agent] brief composition failed; using template", err);
  }
  return { text: renderBriefFallback(d), usedModel: false };
}

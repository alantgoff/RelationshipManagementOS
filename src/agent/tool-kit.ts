import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { getDb } from "@/db/client";
import { followUps, people, pendingActions, reminders } from "@/db/schema";
import { HEALTH_LABELS, LP_STAGE_LABELS, ROLE_LABELS, type LpStage, type Role } from "@/domain/enums";
import { localDate, zonedTimeToUtc } from "@/lib/time";
import type { PersonRow } from "@/server/queries/people";
import type { PersonInput } from "@/server/validation";
import type { ToolName, toolSchemas } from "./tool-specs";

/** Shared types and helpers for the agent's tools (src/agent/tools.ts, read-tools.ts). */

export interface ToolContext {
  userId: string;
  turnId: string;
  /** The inbound message that caused this turn, for provenance. */
  sourceMessageId: string;
  now: Date;
  tz: string;
}

export type PersonFields = Partial<PersonInput>;

export type UndoOp =
  | { kind: "delete_interaction"; id: string }
  | { kind: "delete_person"; id: string }
  | { kind: "delete_reminder"; id: string }
  | { kind: "reopen_follow_up"; id: string }
  | { kind: "reopen_reminder"; id: string }
  /** Legacy rows only: a full profile snapshot. New rows use restore_person_fields. */
  | { kind: "restore_person"; id: string; input: PersonInput }
  /** Put back only the fields the tool changed, and only where nobody has changed them since. */
  | { kind: "restore_person_fields"; id: string; before: PersonFields; after: PersonFields }
  | {
      kind: "restore_lp";
      id: string;
      stage: LpStage | null;
      roles: Role[];
      commitmentUsd: number | null;
      /** State the tool left behind; undo is skipped if it changed since. */
      after?: { stage: LpStage | null; commitmentUsd: number | null };
    }
  | { kind: "invalidate_fact"; id: string }
  | { kind: "discard_draft"; id: string }
  /** Undo "I sent it": remove the logged interaction and put the draft back to pending. */
  | { kind: "unapprove_draft"; id: string; interactionId: string }
  | { kind: "restore_draft"; id: string };

export interface ToolOutcome {
  ok: boolean;
  /** What the model sees. */
  text: string;
  /** One line for the audit log, `why`, and `undo`. */
  summary: string;
  undo?: UndoOp;
  /** Set by draft_message so the runtime can show the draft to the owner. */
  draftId?: string;
}

/** An error whose message is written for the model. */
export class ToolUserError extends Error {}

export type Args<N extends ToolName> = z.infer<(typeof toolSchemas)[N]["input"]>;

/** 8-hex-character handle for an id: fewer tokens and fewer copy mistakes than a full UUID. */
export const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_RE = /^[0-9a-f]{6,32}$/i;

type IdTable = typeof people | typeof followUps | typeof reminders | typeof pendingActions;

/** Resolve a full UUID or a short handle to a full id owned by the user. */
export async function resolveId(table: IdTable, ref: string, userId: string, noun: string): Promise<string> {
  const clean = ref.trim().replace(/^\[|\]$/g, "").replace(/^(id|person|fu|rem|int|draft)[\s:_-]*/i, "");
  if (UUID_RE.test(clean)) {
    const [row] = await getDb()
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, clean.toLowerCase()), eq(table.userId, userId)));
    if (row) return row.id;
  } else if (SHORT_RE.test(clean)) {
    const rows = await getDb()
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.userId, userId), sql`replace(${table.id}::text, '-', '') like ${clean.toLowerCase() + "%"}`))
      .limit(2);
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) throw new ToolUserError(`The ${noun} id "${ref}" is ambiguous. Use the full id from get_person.`);
  }
  throw new ToolUserError(
    noun === "person"
      ? `No person with id "${ref}". Ids look like 1a2b3c4d and come from the working set or find_people; search with find_people first.`
      : `No ${noun} with id "${ref}". Use an id shown in the working set or get_person.`,
  );
}

export const resolvePerson = (ref: string, ctx: ToolContext) => resolveId(people, ref, ctx.userId, "person");

export function money(n: number | null | undefined): string | undefined {
  return n == null ? undefined : `$${n.toLocaleString("en-US")}`;
}

/** One compact line per person, used by tools and the working set. */
export function personLine(p: PersonRow, tz: string): string {
  const roles = p.roles.map((r) => ROLE_LABELS[r]).join(", ");
  const contact = p.lastInteractionAt ? `last contact ${localDate(p.lastInteractionAt, tz)}` : "never contacted";
  const health = p.health === "never" ? contact : `${HEALTH_LABELS[p.health].toLowerCase()}, ${contact}`;
  const goesBy = p.preferredName && p.preferredName.trim() && p.preferredName.trim() !== p.fullName ? ` (goes by ${p.preferredName.trim()})` : "";
  return [
    `${p.fullName}${goesBy} [${shortId(p.id)}]`,
    roles || undefined,
    [p.title, p.company].filter(Boolean).join(" at ") || undefined,
    `${health}${p.cadenceDays ? `, every ${p.cadenceDays}d` : ""}`,
    p.lpStage ? `LP stage ${LP_STAGE_LABELS[p.lpStage]}` : undefined,
    money(p.lpCommitmentUsd),
    p.archivedAt ? "archived" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function noonOn(date: string | undefined, ctx: ToolContext): Date {
  return zonedTimeToUtc(date ?? localDate(ctx.now, ctx.tz), 12, 0, ctx.tz);
}

export function requireNotPast(date: string, ctx: ToolContext, what: string) {
  if (date < localDate(ctx.now, ctx.tz)) {
    throw new ToolUserError(`${what} ${date} is in the past (today is ${localDate(ctx.now, ctx.tz)}). Check the date math.`);
  }
}

/** Longest tool result the model sees; longer output is cut with a note (HA-7). */
export const MAX_TOOL_TEXT = 6_000;

export function capToolText(text: string, max = MAX_TOOL_TEXT): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > max / 2 ? cut : max)}\n…(output cut to fit; narrow the request to see more)`;
}

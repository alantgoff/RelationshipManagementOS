import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agentActions, followUps, memoryFacts, pendingActions, people, reminders } from "@/db/schema";
import { HEALTH_LABELS, LP_STAGE_LABELS, ROLE_LABELS, type LpStage, type Role } from "@/domain/enums";
import { encrypt } from "@/lib/crypto";
import { addDays, localDate, zonedTimeToUtc } from "@/lib/time";
import { logInteraction, setFollowUpDone } from "@/server/actions/interactions";
import { createPerson, setLpStage, updatePerson } from "@/server/actions/people";
import { completeReminder, createReminder } from "@/server/actions/reminders";
import { getDashboard } from "@/server/queries/dashboard";
import { listPeople, type PersonRow } from "@/server/queries/people";
import { getPerson } from "@/server/queries/person";
import type { PersonInput } from "@/server/validation";
import { parseToolArguments, type ToolCall } from "./llm";
import { isToolName, TOOL_NAMES, validateToolInput, type ToolName } from "./tool-specs";
import type { z } from "zod";
import type { toolSchemas } from "./tool-specs";

/**
 * Tool implementations. Each is a thin wrapper over an owner-scoped v1 action
 * or query, runs inside runAsOwner(), returns compact text with short ids, and
 * records how to undo itself. Errors are written to teach the model what to do
 * next instead of failing the turn.
 */

export interface ToolContext {
  userId: string;
  turnId: string;
  /** The inbound message that caused this turn, for provenance. */
  sourceMessageId: string;
  now: Date;
  tz: string;
}

export type UndoOp =
  | { kind: "delete_interaction"; id: string }
  | { kind: "delete_person"; id: string }
  | { kind: "delete_reminder"; id: string }
  | { kind: "reopen_follow_up"; id: string }
  | { kind: "reopen_reminder"; id: string }
  | { kind: "restore_person"; id: string; input: PersonInput }
  | { kind: "restore_lp"; id: string; stage: LpStage | null; roles: Role[]; commitmentUsd: number | null }
  | { kind: "invalidate_fact"; id: string }
  | { kind: "discard_draft"; id: string };

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

/** 8-hex-character handle for an id: fewer tokens and fewer copy mistakes than a full UUID. */
export const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_RE = /^[0-9a-f]{6,32}$/i;

type IdTable = typeof people | typeof followUps | typeof reminders;

/** Resolve a full UUID or a short handle to a full id owned by the user. */
async function resolveId(table: IdTable, ref: string, userId: string, noun: string): Promise<string> {
  const clean = ref.trim().replace(/^(id|person|fu|rem|int)[\s:_-]*/i, "");
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

const resolvePerson = (ref: string, ctx: ToolContext) => resolveId(people, ref, ctx.userId, "person");

function money(n: number | null | undefined): string | undefined {
  return n == null ? undefined : `$${n.toLocaleString("en-US")}`;
}

/** One compact line per person, used by tools and the working set. */
export function personLine(p: PersonRow, tz: string): string {
  const roles = p.roles.map((r) => ROLE_LABELS[r]).join(", ");
  const contact = p.lastInteractionAt ? `last contact ${localDate(p.lastInteractionAt, tz)}` : "never contacted";
  const health = p.health === "never" ? contact : `${HEALTH_LABELS[p.health].toLowerCase()}, ${contact}`;
  return [
    `${p.fullName} [${shortId(p.id)}]`,
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

function noonOn(date: string | undefined, ctx: ToolContext): Date {
  return zonedTimeToUtc(date ?? localDate(ctx.now, ctx.tz), 12, 0, ctx.tz);
}

function requireNotPast(date: string, ctx: ToolContext, what: string) {
  if (date < localDate(ctx.now, ctx.tz)) {
    throw new ToolUserError(`${what} ${date} is in the past (today is ${localDate(ctx.now, ctx.tz)}). Check the date math.`);
  }
}

type Args<N extends ToolName> = z.infer<(typeof toolSchemas)[N]["input"]>;

/* ───────────── Implementations ───────────── */

async function findPeople(a: Args<"find_people">, ctx: ToolContext): Promise<ToolOutcome> {
  const terms = a.query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (terms.length === 0) throw new ToolUserError("query is too short; give a name, company or keyword.");
  const limit = a.limit ?? 8;
  const longest = [...terms].sort((x, y) => y.length - x.length)[0];
  const candidates = await listPeople({ q: longest, role: a.role, sort: "name" }, ctx.now);
  const haystack = (p: PersonRow) =>
    [p.fullName, p.preferredName, p.company, p.email, p.title, p.location, ...p.tags].filter(Boolean).join(" ").toLowerCase();
  let rows = candidates.filter((p) => terms.every((t) => haystack(p).includes(t)));
  if (rows.length === 0) rows = candidates;
  if (a.health) rows = rows.filter((p) => p.health === a.health);
  if (rows.length === 0) {
    return {
      ok: true,
      text: `No one matches "${a.query}"${a.role ? ` with role ${a.role}` : ""}. If this is someone new, confirm the details with the owner or use create_person.`,
      summary: `Searched "${a.query}": no match`,
    };
  }
  const shown = rows.slice(0, limit);
  const more = rows.length > shown.length ? `\n…and ${rows.length - shown.length} more; narrow the query.` : "";
  return {
    ok: true,
    text: `${rows.length} match${rows.length === 1 ? "" : "es"}:\n${shown.map((p) => `- ${personLine(p, ctx.tz)}`).join("\n")}${more}`,
    summary: `Searched "${a.query}": ${rows.length} match${rows.length === 1 ? "" : "es"}`,
  };
}

export async function personDossier(id: string, ctx: ToolContext): Promise<string> {
  const p = await getPerson(id, ctx.now);
  if (!p) throw new ToolUserError("Person not found.");
  const facts = await getDb()
    .select()
    .from(memoryFacts)
    .where(and(eq(memoryFacts.userId, ctx.userId), eq(memoryFacts.personId, id), isNull(memoryFacts.validTo)))
    .orderBy(desc(memoryFacts.createdAt))
    .limit(12);
  const row: PersonRow = { ...p, lastSummary: null };
  const lines = [personLine(row, ctx.tz)];
  if (p.email || p.phone) lines.push([p.email, p.phone].filter(Boolean).join(" · "));
  if (p.tags.length) lines.push(`Tags: ${p.tags.join(", ")}`);
  if (p.howWeMet) lines.push(`How we met: ${p.howWeMet}`);
  if (p.dealSourceQuality) lines.push(`Deal-source quality: ${p.dealSourceQuality}`);
  if (p.introsGiven || p.introsReceived) lines.push(`Intros: ${p.introsGiven} given, ${p.introsReceived} received`);
  if (p.notes) lines.push(`Notes: ${p.notes.slice(0, 600)}`);
  if (facts.length) lines.push("Known facts:", ...facts.map((f) => `- ${f.fact} (noted ${localDate(f.createdAt, ctx.tz)})`));
  const open = p.timeline.flatMap((i) => i.followUps.filter((f) => !f.completedAt).map((f) => ({ f, i })));
  if (open.length) {
    lines.push(
      "Open follow-ups:",
      ...open.map(({ f }) => `- [${shortId(f.id)}] ${f.description}${f.dueAt ? ` (due ${localDate(f.dueAt, ctx.tz)})` : ""}`),
    );
  }
  const rems = p.reminders.filter((r) => !r.completedAt);
  if (rems.length) lines.push("Reminders:", ...rems.map((r) => `- [${shortId(r.id)}] ${r.reason} (${localDate(r.dueAt, ctx.tz)})`));
  if (p.timeline.length) {
    lines.push(
      "Recent timeline:",
      ...p.timeline.slice(0, 8).map((i) => {
        const extra = i.introducedPersonName ? ` (introduced to ${i.introducedPersonName})` : i.viaPersonName ? ` (introduced by ${i.viaPersonName})` : "";
        const notes = i.notes ? ` — ${i.notes.slice(0, 160)}` : "";
        return `- ${localDate(i.occurredAt, ctx.tz)} ${i.type}: ${i.summary}${extra}${notes}`;
      }),
    );
    if (p.timeline.length > 8) lines.push(`(${p.timeline.length - 8} older interactions not shown)`);
  }
  return lines.join("\n");
}

async function getPersonTool(a: Args<"get_person">, ctx: ToolContext): Promise<ToolOutcome> {
  const id = await resolvePerson(a.person_id, ctx);
  const text = await personDossier(id, ctx);
  return { ok: true, text, summary: `Read the dossier for ${text.split(" [")[0]}` };
}

async function createPersonTool(a: Args<"create_person">, ctx: ToolContext): Promise<ToolOutcome> {
  const [dupe] = await getDb()
    .select({ id: people.id, fullName: people.fullName })
    .from(people)
    .where(and(eq(people.userId, ctx.userId), sql`lower(${people.fullName}) = ${a.full_name.trim().toLowerCase()}`, isNull(people.archivedAt)))
    .limit(1);
  if (dupe) {
    throw new ToolUserError(`${dupe.fullName} already exists [${shortId(dupe.id)}]. Use that id; ask the owner if this is a different person with the same name.`);
  }
  const { id } = await createPerson({
    fullName: a.full_name,
    email: a.email,
    company: a.company,
    title: a.title,
    roles: a.roles ?? [],
    tags: a.tags ?? [],
    notes: a.notes,
  });
  const [row] = await listPeople({ q: a.full_name, includeArchived: false }, ctx.now).then((r) => r.filter((p) => p.id === id));
  return {
    ok: true,
    text: `Created: ${row ? personLine(row, ctx.tz) : `${a.full_name} [${shortId(id)}]`}`,
    summary: `Added ${a.full_name}`,
    undo: { kind: "delete_person", id },
  };
}

function toPersonInput(p: NonNullable<Awaited<ReturnType<typeof getPerson>>>): PersonInput {
  return {
    fullName: p.fullName,
    preferredName: p.preferredName,
    email: p.email,
    phone: p.phone,
    company: p.company,
    title: p.title,
    location: p.location,
    howWeMet: p.howWeMet,
    notes: p.notes,
    roles: p.roles,
    tags: p.tags,
    cadenceDays: p.cadenceDays,
    lpStage: p.lpStage,
    dealSourceQuality: p.dealSourceQuality,
  };
}

async function updatePersonTool(a: Args<"update_person">, ctx: ToolContext): Promise<ToolOutcome> {
  const id = await resolvePerson(a.person_id, ctx);
  const current = await getPerson(id, ctx.now);
  if (!current) throw new ToolUserError("Person not found.");
  const before = toPersonInput(current);
  const next: PersonInput = {
    ...before,
    ...(a.company !== undefined ? { company: a.company } : {}),
    ...(a.title !== undefined ? { title: a.title } : {}),
    ...(a.email !== undefined ? { email: a.email } : {}),
    ...(a.location !== undefined ? { location: a.location } : {}),
    ...(a.roles !== undefined ? { roles: a.roles } : {}),
    ...(a.add_tags?.length ? { tags: [...new Set([...(before.tags ?? []), ...a.add_tags])] } : {}),
    ...(a.cadence_days !== undefined ? { cadenceDays: a.cadence_days } : {}),
    ...(a.deal_source_quality !== undefined ? { dealSourceQuality: a.deal_source_quality } : {}),
  };
  const changed = Object.keys(a).filter((k) => k !== "person_id");
  if (changed.length === 0) throw new ToolUserError("Nothing to update; pass at least one field.");
  await updatePerson(id, next);
  return {
    ok: true,
    text: `Updated ${current.fullName} [${shortId(id)}]: ${changed.join(", ")}.`,
    summary: `Updated ${current.fullName} (${changed.join(", ")})`,
    undo: { kind: "restore_person", id, input: before },
  };
}

async function logInteractionTool(a: Args<"log_interaction">, ctx: ToolContext): Promise<ToolOutcome> {
  const personId = await resolvePerson(a.person_id, ctx);
  const today = localDate(ctx.now, ctx.tz);
  if (a.occurred_on && a.occurred_on > today) {
    throw new ToolUserError(`occurred_on ${a.occurred_on} is in the future (today is ${today}). log_interaction is for things that already happened; use set_reminder for plans.`);
  }
  const introducedPersonId = a.introduced_person_id ? await resolvePerson(a.introduced_person_id, ctx) : null;
  if (a.type === "intro" && !introducedPersonId) {
    // Still allowed (introduced to someone not in the app), but say so.
  }
  for (const f of a.follow_ups ?? []) if (f.due_on) requireNotPast(f.due_on, ctx, "Follow-up due date");
  const occurredAt = a.occurred_on && a.occurred_on !== today ? noonOn(a.occurred_on, ctx) : ctx.now;
  const { id } = await logInteraction({
    personId,
    type: a.type,
    summary: a.summary,
    occurredAt,
    notes: a.notes,
    introducedPersonId,
    followUps: (a.follow_ups ?? []).map((f) => ({ description: f.description, dueAt: f.due_on ? noonOn(f.due_on, ctx) : null })),
  });
  const p = await getPerson(personId, ctx.now);
  const fus = a.follow_ups?.length ? ` with ${a.follow_ups.length} follow-up${a.follow_ups.length > 1 ? "s" : ""}` : "";
  return {
    ok: true,
    text: `Logged ${a.type} with ${p?.fullName ?? "them"} on ${a.occurred_on ?? today}${fus}. Health is now ${p ? HEALTH_LABELS[p.health].toLowerCase() : "updated"}.`,
    summary: `Logged ${a.type} with ${p?.fullName ?? "someone"}: ${a.summary}${fus}`,
    undo: { kind: "delete_interaction", id },
  };
}

async function addFollowUpTool(a: Args<"add_follow_up">, ctx: ToolContext): Promise<ToolOutcome> {
  const personId = await resolvePerson(a.person_id, ctx);
  const due = a.due_on ?? addDays(localDate(ctx.now, ctx.tz), 7);
  requireNotPast(due, ctx, "Due date");
  const { id } = await createReminder({ personId, dueAt: noonOn(due, ctx), reason: a.description });
  return {
    ok: true,
    text: `Follow-up saved [${shortId(id)}] for ${due}: ${a.description}.`,
    summary: `Follow-up for ${due}: ${a.description}`,
    undo: { kind: "delete_reminder", id },
  };
}

async function completeFollowUpTool(a: Args<"complete_follow_up">, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const id = await resolveId(followUps, a.follow_up_id, ctx.userId, "follow-up");
    const [fu] = await getDb().select().from(followUps).where(eq(followUps.id, id));
    if (fu.completedAt) return { ok: true, text: "That follow-up was already done.", summary: "Follow-up already done" };
    await setFollowUpDone(id, true);
    return { ok: true, text: `Done: ${fu.description}.`, summary: `Completed: ${fu.description}`, undo: { kind: "reopen_follow_up", id } };
  } catch (err) {
    if (!(err instanceof ToolUserError)) throw err;
  }
  const id = await resolveId(reminders, a.follow_up_id, ctx.userId, "follow-up or reminder");
  const [rem] = await getDb().select().from(reminders).where(eq(reminders.id, id));
  if (rem.completedAt) return { ok: true, text: "That reminder was already done.", summary: "Reminder already done" };
  await completeReminder(id);
  return { ok: true, text: `Done: ${rem.reason}.`, summary: `Completed: ${rem.reason}`, undo: { kind: "reopen_reminder", id } };
}

async function setReminderTool(a: Args<"set_reminder">, ctx: ToolContext): Promise<ToolOutcome> {
  const personId = await resolvePerson(a.person_id, ctx);
  requireNotPast(a.due_on, ctx, "Reminder date");
  const { id } = await createReminder({ personId, dueAt: zonedTimeToUtc(a.due_on, 9, 0, ctx.tz), reason: a.reason });
  return {
    ok: true,
    text: `Reminder set [${shortId(id)}] for ${a.due_on}: ${a.reason}.`,
    summary: `Reminder for ${a.due_on}: ${a.reason}`,
    undo: { kind: "delete_reminder", id },
  };
}

async function setLpStageTool(a: Args<"set_lp_stage">, ctx: ToolContext): Promise<ToolOutcome> {
  const id = await resolvePerson(a.person_id, ctx);
  const [before] = await getDb()
    .select({ fullName: people.fullName, stage: people.lpStage, roles: people.roles, commitment: people.lpCommitmentUsd })
    .from(people)
    .where(eq(people.id, id));
  await setLpStage(id, a.stage, a.commitment_usd);
  const amount = a.commitment_usd ? ` at ${money(a.commitment_usd)}` : "";
  return {
    ok: true,
    text: `${before.fullName} is now at LP stage ${LP_STAGE_LABELS[a.stage]}${amount}.`,
    summary: `${before.fullName}: LP stage ${before.stage ? LP_STAGE_LABELS[before.stage] : "none"} → ${LP_STAGE_LABELS[a.stage]}${amount}`,
    undo: { kind: "restore_lp", id, stage: before.stage, roles: before.roles, commitmentUsd: before.commitment },
  };
}

async function whatsDueTool(a: Args<"whats_due">, ctx: ToolContext): Promise<ToolOutcome> {
  const d = await getDashboard(a.role, ctx.now);
  const today = localDate(ctx.now, ctx.tz);
  const inScope = (date: Date | null) => a.scope !== "today" || !date || localDate(date, ctx.tz) <= today;
  const fus = d.followUps.filter((f) => inScope(f.dueAt));
  const rems = d.reminders.filter((r) => inScope(r.dueAt));
  const lines: string[] = [];
  lines.push(
    d.attention.length
      ? `Needs attention (${d.attention.length}, most urgent first):\n${d.attention
          .slice(0, 10)
          .map((p) => `- ${personLine(p, ctx.tz)}${p.lastSummary ? ` · last: ${p.lastSummary}` : ""}`)
          .join("\n")}${d.attention.length > 10 ? `\n…and ${d.attention.length - 10} more` : ""}`
      : "Nobody with a cadence needs attention.",
  );
  if (fus.length) {
    lines.push(
      `Open follow-ups:\n${fus
        .map((f) => `- [${shortId(f.id)}] ${f.description} → ${f.personName}${f.dueAt ? ` (due ${localDate(f.dueAt, ctx.tz)}${f.overdue ? ", overdue" : ""})` : ""}`)
        .join("\n")}`,
    );
  }
  if (rems.length) {
    lines.push(
      `Reminders:\n${rems.map((r) => `- [${shortId(r.id)}] ${r.reason} → ${r.personName} (${localDate(r.dueAt, ctx.tz)}${r.overdue ? ", overdue" : ""})`).join("\n")}`,
    );
  }
  return { ok: true, text: lines.join("\n\n"), summary: `Checked what's due (${d.attention.length} need attention)` };
}

async function rememberTool(a: Args<"remember">, ctx: ToolContext): Promise<ToolOutcome> {
  const personId = a.person_id ? await resolvePerson(a.person_id, ctx) : null;
  const [row] = await getDb()
    .insert(memoryFacts)
    .values({ userId: ctx.userId, personId, fact: a.fact.trim(), sourceKind: "message", sourceId: ctx.sourceMessageId, validFrom: ctx.now })
    .returning({ id: memoryFacts.id });
  const who = personId ? (await getPerson(personId, ctx.now))?.fullName : "you";
  return {
    ok: true,
    text: `Remembered about ${who}: ${a.fact}`,
    summary: `Remembered about ${who}: ${a.fact}`,
    undo: { kind: "invalidate_fact", id: row.id },
  };
}

async function draftMessageTool(a: Args<"draft_message">, ctx: ToolContext): Promise<ToolOutcome> {
  const personId = await resolvePerson(a.person_id, ctx);
  const p = await getPerson(personId, ctx.now);
  if (!p) throw new ToolUserError("Person not found.");
  if (a.channel === "email" && !p.email) {
    // Still draft it: the owner may have the address elsewhere. Mention it.
  }
  const [row] = await getDb()
    .insert(pendingActions)
    .values({ userId: ctx.userId, kind: "message_draft", personId, channel: a.channel, bodyEnc: encrypt(a.body.trim()), turnId: ctx.turnId })
    .returning({ id: pendingActions.id });
  const emailNote = a.channel === "email" && !p.email ? " There is no email address on file for them." : "";
  return {
    ok: true,
    text: `Draft saved for ${p.fullName} (${a.channel}). It is shown to the owner verbatim right after your reply, so don't repeat it; just say what it does and ask them to tap 👍 after sending.${emailNote}`,
    summary: `Drafted a ${a.channel} message to ${p.fullName}: ${a.intent}`,
    undo: { kind: "discard_draft", id: row.id },
    draftId: row.id,
  };
}

const IMPLEMENTATIONS: { [N in ToolName]: (a: Args<N>, ctx: ToolContext) => Promise<ToolOutcome> } = {
  find_people: findPeople,
  get_person: getPersonTool,
  create_person: createPersonTool,
  update_person: updatePersonTool,
  log_interaction: logInteractionTool,
  add_follow_up: addFollowUpTool,
  complete_follow_up: completeFollowUpTool,
  set_reminder: setReminderTool,
  set_lp_stage: setLpStageTool,
  whats_due: whatsDueTool,
  remember: rememberTool,
  draft_message: draftMessageTool,
};

/** Read-only tools are not recorded as undoable actions but still appear in `why`. */
export const READ_ONLY_TOOLS: ReadonlySet<ToolName> = new Set(["find_people", "get_person", "whats_due"]);

/** Validate and run one tool call, record it, and return text for the model. Never throws. */
export async function executeToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const name = call.function.name;
  const args = parseToolArguments(call);
  let outcome: ToolOutcome;
  if (!isToolName(name)) {
    outcome = { ok: false, text: `Unknown tool "${name}". Available tools: ${TOOL_NAMES.join(", ")}.`, summary: `Unknown tool ${name}` };
  } else if (!args) {
    outcome = { ok: false, text: "The arguments were not valid JSON. Call the tool again with a JSON object.", summary: `${name}: invalid JSON` };
  } else {
    const parsed = validateToolInput(name, args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      outcome = { ok: false, text: `Invalid arguments for ${name}: ${issues}. Fix them and call again.`, summary: `${name}: invalid arguments` };
    } else {
      try {
        const impl = IMPLEMENTATIONS[name] as (a: unknown, c: ToolContext) => Promise<ToolOutcome>;
        outcome = await impl(parsed.data, ctx);
      } catch (err) {
        if (err instanceof ToolUserError) {
          outcome = { ok: false, text: err.message, summary: `${name}: ${err.message}` };
        } else {
          console.error(`[agent] tool ${name} failed`, err);
          outcome = {
            ok: false,
            text: `${name} failed because of an internal error. Tell the owner it didn't save and suggest trying again.`,
            summary: `${name}: internal error`,
          };
        }
      }
    }
  }
  await getDb()
    .insert(agentActions)
    .values({
      userId: ctx.userId,
      turnId: ctx.turnId,
      tool: name,
      input: args ?? {},
      ok: outcome.ok,
      summary: outcome.summary.slice(0, 500),
      undo: (outcome.undo as unknown as Record<string, unknown>) ?? null,
    });
  return outcome;
}

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agentActions, followUps, memoryFacts, pendingActions, people, reminders } from "@/db/schema";
import { HEALTH_LABELS, LP_STAGE_LABELS } from "@/domain/enums";
import { encrypt } from "@/lib/crypto";
import { addDays, localDate, zonedTimeToUtc } from "@/lib/time";
import { logInteraction, setFollowUpDone } from "@/server/actions/interactions";
import { createPerson, setLpStage, updatePerson } from "@/server/actions/people";
import { completeReminder, createReminder } from "@/server/actions/reminders";
import { listPeople } from "@/server/queries/people";
import { getPerson } from "@/server/queries/person";
import type { PersonInput } from "@/server/validation";
import { approveDraft, rejectDraft } from "./drafts";
import { parseToolArguments, type ToolCall } from "./llm";
import { findPeople, getPersonTool, recallTool, whatsDueTool } from "./read-tools";
import {
  capToolText,
  money,
  noonOn,
  personLine,
  requireNotPast,
  resolveId,
  resolvePerson,
  shortId,
  ToolUserError,
  type Args,
  type PersonFields,
  type ToolContext,
  type ToolOutcome,
} from "./tool-kit";
import { isToolName, TOOL_NAMES, validateToolInput, type ToolName } from "./tool-specs";

export { personDossier } from "./read-tools";
export { personLine, shortId, ToolUserError, type ToolContext, type ToolOutcome, type UndoOp } from "./tool-kit";

/**
 * Tool implementations. Each is a thin wrapper over an owner-scoped v1 action
 * or query, runs inside runAsOwner(), returns compact text with short ids, and
 * records how to undo itself. Errors are written to teach the model what to do
 * next instead of failing the turn.
 */

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

export function toPersonInput(p: NonNullable<Awaited<ReturnType<typeof getPerson>>>): PersonInput {
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
  const full = toPersonInput(current);
  const patch: PersonFields = {
    ...(a.company !== undefined ? { company: a.company } : {}),
    ...(a.title !== undefined ? { title: a.title } : {}),
    ...(a.email !== undefined ? { email: a.email } : {}),
    ...(a.location !== undefined ? { location: a.location } : {}),
    ...(a.roles !== undefined ? { roles: a.roles } : {}),
    ...(a.add_tags?.length ? { tags: [...new Set([...(full.tags ?? []), ...a.add_tags])] } : {}),
    ...(a.cadence_days !== undefined ? { cadenceDays: a.cadence_days } : {}),
    ...(a.deal_source_quality !== undefined ? { dealSourceQuality: a.deal_source_quality } : {}),
  };
  const fields = Object.keys(patch) as (keyof PersonInput)[];
  if (fields.length === 0) throw new ToolUserError("Nothing to update; pass at least one field.");
  await updatePerson(id, { ...full, ...patch });
  // Record only what changed, read back after validation normalized it.
  const updated = await getPerson(id, ctx.now);
  const afterFull = updated ? toPersonInput(updated) : { ...full, ...patch };
  const before: PersonFields = {};
  const after: PersonFields = {};
  for (const f of fields) {
    (before as Record<string, unknown>)[f] = full[f] ?? null;
    (after as Record<string, unknown>)[f] = afterFull[f] ?? null;
  }
  const changed = Object.keys(a).filter((k) => k !== "person_id");
  return {
    ok: true,
    text: `Updated ${current.fullName} [${shortId(id)}]: ${changed.join(", ")}.`,
    summary: `Updated ${current.fullName} (${changed.join(", ")})`,
    undo: { kind: "restore_person_fields", id, before, after },
  };
}

async function logInteractionTool(a: Args<"log_interaction">, ctx: ToolContext): Promise<ToolOutcome> {
  const personId = await resolvePerson(a.person_id, ctx);
  const today = localDate(ctx.now, ctx.tz);
  if (a.occurred_on && a.occurred_on > today) {
    throw new ToolUserError(
      `occurred_on ${a.occurred_on} is after today (${today}), and log_interaction is only for things that already happened. If the owner described a past event with a bare weekday ("met Sam Monday"), use the most recent such day on or before today. If it's still a plan, use set_reminder or add_follow_up instead.`,
    );
  }
  const introducedPersonId = a.introduced_person_id ? await resolvePerson(a.introduced_person_id, ctx) : null;
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

async function lpState(id: string) {
  const [row] = await getDb()
    .select({ fullName: people.fullName, stage: people.lpStage, roles: people.roles, commitment: people.lpCommitmentUsd })
    .from(people)
    .where(eq(people.id, id));
  return row;
}

async function setLpStageTool(a: Args<"set_lp_stage">, ctx: ToolContext): Promise<ToolOutcome> {
  const id = await resolvePerson(a.person_id, ctx);
  const before = await lpState(id);
  await setLpStage(id, a.stage, a.commitment_usd);
  const after = await lpState(id);
  const amount = a.commitment_usd ? ` at ${money(a.commitment_usd)}` : "";
  return {
    ok: true,
    text: `${before.fullName} is now at LP stage ${LP_STAGE_LABELS[a.stage]}${amount}.`,
    summary: `${before.fullName}: LP stage ${before.stage ? LP_STAGE_LABELS[before.stage] : "none"} → ${LP_STAGE_LABELS[a.stage]}${amount}`,
    undo: {
      kind: "restore_lp",
      id,
      stage: before.stage,
      rolesAdded: after.roles.filter((r) => !before.roles.includes(r)),
      commitmentUsd: before.commitment,
      after: { stage: after.stage, commitmentUsd: after.commitment },
    },
  };
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
  const [row] = await getDb()
    .insert(pendingActions)
    .values({ userId: ctx.userId, kind: "message_draft", personId, channel: a.channel, bodyEnc: encrypt(a.body.trim()), turnId: ctx.turnId })
    .returning({ id: pendingActions.id });
  const emailNote = a.channel === "email" && !p.email ? " There is no email address on file for them." : "";
  return {
    ok: true,
    text: `Draft saved [${shortId(row.id)}] for ${p.fullName} (${a.channel}). It is shown to the owner verbatim right after your reply, so don't repeat it; just say what it does and ask them to reply 👍 once they've sent it.${emailNote}`,
    summary: `Drafted a ${a.channel} message to ${p.fullName}: ${a.intent}`,
    undo: { kind: "discard_draft", id: row.id },
    draftId: row.id,
  };
}

async function resolveDraftTool(a: Args<"resolve_draft">, ctx: ToolContext): Promise<ToolOutcome> {
  const id = await resolveId(pendingActions, a.draft_id, ctx.userId, "draft");
  const done = a.action === "sent" ? await approveDraft(ctx.userId, id, ctx.now) : await rejectDraft(ctx.userId, id, ctx.now);
  if (!done) throw new ToolUserError("That draft is no longer waiting (already logged or discarded).");
  return {
    ok: true,
    text: a.action === "sent" ? `Logged as sent to ${done.name}.` : `Discarded the draft to ${done.name}.`,
    summary: done.summary,
    undo: done.undo,
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
  recall: recallTool,
  draft_message: draftMessageTool,
  resolve_draft: resolveDraftTool,
};

/** Read-only tools are not recorded as undoable actions but still appear in `why`. */
export const READ_ONLY_TOOLS: ReadonlySet<ToolName> = new Set(["find_people", "get_person", "whats_due", "recall"]);

/**
 * The audit copy of a call's arguments (plaintext jsonb). Message bodies stay
 * only in encrypted storage: for draft_message, and for any call that failed
 * validation or named an unknown tool (where a body may sit under another
 * key), long strings are replaced by their length.
 */
function auditInput(name: string, args: Record<string, unknown> | null, valid: boolean): Record<string, unknown> {
  if (!args) return {};
  if (valid && name !== "draft_message") return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const keepAsIs = valid ? key !== "body" : typeof value !== "object" || value === null;
    if (typeof value === "string" && (!keepAsIs || value.length > 80)) out[key] = `[${value.length} characters, not stored]`;
    else out[key] = keepAsIs ? value : "[not stored]";
  }
  return out;
}

/** Validate and run one tool call, record it, and return text for the model. Never throws. */
export async function executeToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const name = call.function.name;
  const args = parseToolArguments(call);
  let valid = false;
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
      valid = true;
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
            text: `${name} failed because of an internal error and nothing was saved by this call. Tell the owner it didn't save.`,
            summary: `${name}: internal error`,
          };
        }
      }
    }
  }
  outcome = { ...outcome, text: capToolText(outcome.text) };
  await getDb()
    .insert(agentActions)
    .values({
      userId: ctx.userId,
      turnId: ctx.turnId,
      tool: name,
      input: auditInput(name, args, valid),
      ok: outcome.ok,
      summary: outcome.summary.slice(0, 500),
      undo: (outcome.undo as unknown as Record<string, unknown>) ?? null,
    });
  return outcome;
}

import { and, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { memoryFacts, people } from "@/db/schema";
import { localDate } from "@/lib/time";
import { getDashboard } from "@/server/queries/dashboard";
import { listPeople, type PersonRow } from "@/server/queries/people";
import { getPerson } from "@/server/queries/person";
import { personLine, resolvePerson, shortId, ToolUserError, type Args, type ToolContext, type ToolOutcome } from "./tool-kit";

/** Read-only tools: they never change records, so they record no undo. */

const MAX_DUE_ITEMS = 10;

export async function findPeople(a: Args<"find_people">, ctx: ToolContext): Promise<ToolOutcome> {
  const terms = a.query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (terms.length === 0) throw new ToolUserError("query is too short; give a name, company or keyword.");
  const limit = a.limit ?? 8;
  const longest = [...terms].sort((x, y) => y.length - x.length)[0];
  const candidates = await listPeople({ q: longest, role: a.role, sort: "name" }, ctx.now);
  const haystack = (p: PersonRow) =>
    [p.fullName, p.preferredName, p.company, p.email, p.title, p.location, ...p.tags].filter(Boolean).join(" ").toLowerCase();
  let rows = candidates.filter((p) => terms.every((t) => haystack(p).includes(t)));
  const partial = rows.length === 0 && terms.length > 1;
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
  const list = shown.map((p) => `- ${personLine(p, ctx.tz)}`).join("\n");
  if (partial) {
    return {
      ok: true,
      text: `No exact match for "${a.query}". Partial matches on "${longest}" only:\n${list}${more}\nIf none of these is who the owner means, it may be someone new: confirm with the owner, then create_person.`,
      summary: `Searched "${a.query}": no exact match, ${rows.length} partial`,
    };
  }
  return {
    ok: true,
    text: `${rows.length} match${rows.length === 1 ? "" : "es"}:\n${list}${more}`,
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

export async function getPersonTool(a: Args<"get_person">, ctx: ToolContext): Promise<ToolOutcome> {
  const id = await resolvePerson(a.person_id, ctx);
  const text = await personDossier(id, ctx);
  return { ok: true, text, summary: `Read the dossier for ${text.split(" [")[0].replace(/ \(goes by .*\)$/, "")}` };
}

function capped<T>(items: T[], render: (x: T) => string, max = MAX_DUE_ITEMS): string {
  const lines = items.slice(0, max).map(render);
  if (items.length > max) lines.push(`…and ${items.length - max} more`);
  return lines.join("\n");
}

export async function whatsDueTool(a: Args<"whats_due">, ctx: ToolContext): Promise<ToolOutcome> {
  const d = await getDashboard(a.role, ctx.now);
  const today = localDate(ctx.now, ctx.tz);
  const inScope = (date: Date | null) => a.scope !== "today" || !date || localDate(date, ctx.tz) <= today;
  const fus = d.followUps.filter((f) => inScope(f.dueAt));
  const rems = d.reminders.filter((r) => inScope(r.dueAt));
  const lines: string[] = [];
  lines.push(
    d.attention.length
      ? `Needs attention (${d.attention.length}, most urgent first):\n${capped(d.attention, (p) => `- ${personLine(p, ctx.tz)}${p.lastSummary ? ` · last: ${p.lastSummary}` : ""}`)}`
      : "Nobody with a cadence needs attention.",
  );
  if (fus.length) {
    lines.push(
      `Open follow-ups:\n${capped(fus, (f) => `- [${shortId(f.id)}] ${f.description} → ${f.personName}${f.dueAt ? ` (due ${localDate(f.dueAt, ctx.tz)}${f.overdue ? ", overdue" : ""})` : ""}`)}`,
    );
  }
  if (rems.length) {
    lines.push(`Reminders:\n${capped(rems, (r) => `- [${shortId(r.id)}] ${r.reason} → ${r.personName} (${localDate(r.dueAt, ctx.tz)}${r.overdue ? ", overdue" : ""})`)}`);
  }
  return { ok: true, text: lines.join("\n\n"), summary: `Checked what's due (${d.attention.length} need attention)` };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Search remembered facts, including older owner facts that no longer fit the context block. */
export async function recallTool(a: Args<"recall">, ctx: ToolContext): Promise<ToolOutcome> {
  const where: SQL[] = [eq(memoryFacts.userId, ctx.userId), isNull(memoryFacts.validTo)];
  let scope = "about the owner";
  if (a.person_id) {
    const personId = await resolvePerson(a.person_id, ctx);
    where.push(eq(memoryFacts.personId, personId));
    scope = "about that person";
  } else if (!a.query) {
    where.push(isNull(memoryFacts.personId));
  } else {
    scope = "anywhere";
  }
  const terms = (a.query ?? "").toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (terms.length) where.push(or(...terms.map((t) => ilike(memoryFacts.fact, `%${escapeLike(t)}%`)))!);
  const rows = await getDb()
    .select({ fact: memoryFacts.fact, createdAt: memoryFacts.createdAt, personId: memoryFacts.personId, name: people.fullName })
    .from(memoryFacts)
    .leftJoin(people, eq(people.id, memoryFacts.personId))
    .where(and(...where))
    .orderBy(desc(memoryFacts.createdAt))
    .limit(20);
  if (rows.length === 0) {
    return { ok: true, text: `Nothing remembered ${scope}${a.query ? ` matching "${a.query}"` : ""}.`, summary: `Recalled facts: none` };
  }
  const lines = rows.map(
    (r) => `- ${r.personId ? `${r.name} [${shortId(r.personId)}]: ` : "Owner: "}${r.fact} (noted ${localDate(r.createdAt, ctx.tz)})`,
  );
  return { ok: true, text: `Remembered facts, newest first:\n${lines.join("\n")}`, summary: `Recalled ${rows.length} fact${rows.length === 1 ? "" : "s"}` };
}

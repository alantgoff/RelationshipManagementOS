import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { interactions, people, personTags, tags, type Person } from "@/db/schema";
import type { Health, LpStage, Role } from "@/domain/enums";
import { computeHealth } from "@/domain/health";
import { requireUserId } from "@/server/auth";

export interface PersonRow extends Person {
  tags: string[];
  lastInteractionAt: Date | null;
  lastSummary: string | null;
  health: Health;
}

export type PeopleSort = "health" | "name" | "lastContact" | "dealSource";

export interface PeopleFilter {
  q?: string;
  role?: Role;
  tag?: string;
  lpStage?: LpStage;
  sort?: PeopleSort;
  includeArchived?: boolean;
}

const HEALTH_RANK: Record<Health, number> = { cold: 0, due: 1, never: 2, warm: 3, fresh: 4, no_cadence: 5 };
const QUALITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, unknown: 3 };

function lastInteractionSubquery() {
  return getDb()
    .select({
      personId: interactions.personId,
      lastAt: sql<Date>`max(${interactions.occurredAt})`.as("last_at"),
    })
    .from(interactions)
    .groupBy(interactions.personId)
    .as("last_i");
}

async function tagsFor(personIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (personIds.length === 0) return map;
  const rows = await getDb()
    .select({ personId: personTags.personId, name: tags.name })
    .from(personTags)
    .innerJoin(tags, eq(tags.id, personTags.tagId))
    .where(inArray(personTags.personId, personIds))
    .orderBy(asc(tags.name));
  for (const r of rows) map.set(r.personId, [...(map.get(r.personId) ?? []), r.name]);
  return map;
}

async function lastSummaries(personIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (personIds.length === 0) return map;
  const rows = await getDb()
    .selectDistinctOn([interactions.personId], {
      personId: interactions.personId,
      summary: interactions.summary,
    })
    .from(interactions)
    .where(inArray(interactions.personId, personIds))
    .orderBy(interactions.personId, desc(interactions.occurredAt));
  for (const r of rows) map.set(r.personId, r.summary);
  return map;
}

/** Owner-scoped people list with tags, last contact, and computed health. */
export async function listPeople(filter: PeopleFilter = {}, now = new Date()): Promise<PersonRow[]> {
  const userId = await requireUserId();
  const db = getDb();
  const last = lastInteractionSubquery();

  const where: SQL[] = [eq(people.userId, userId)];
  if (!filter.includeArchived) where.push(isNull(people.archivedAt));
  if (filter.role) where.push(sql`${filter.role}::role = any(${people.roles})`);
  if (filter.lpStage) where.push(eq(people.lpStage, filter.lpStage));
  if (filter.tag) {
    where.push(
      sql`exists (select 1 from ${personTags} pt join ${tags} t on t.id = pt.tag_id
        where pt.person_id = ${people.id} and t.user_id = ${userId} and t.name = ${filter.tag})`,
    );
  }
  if (filter.q) {
    const like = `%${filter.q.replace(/[%_]/g, "\\$&")}%`;
    where.push(
      or(
        ilike(people.fullName, like),
        ilike(people.preferredName, like),
        ilike(people.company, like),
        ilike(people.email, like),
        ilike(people.notes, like),
        sql`exists (select 1 from ${personTags} pt join ${tags} t on t.id = pt.tag_id
          where pt.person_id = ${people.id} and t.name ilike ${like})`,
        sql`exists (select 1 from ${interactions} i where i.person_id = ${people.id}
          and (i.summary ilike ${like} or i.notes ilike ${like}))`,
      )!,
    );
  }

  const rows = await db
    .select({ person: people, lastAt: last.lastAt })
    .from(people)
    .leftJoin(last, eq(last.personId, people.id))
    .where(and(...where))
    .orderBy(asc(people.fullName));

  const ids = rows.map((r) => r.person.id);
  const [tagMap, summaryMap] = await Promise.all([tagsFor(ids), lastSummaries(ids)]);

  const result: PersonRow[] = rows.map(({ person, lastAt }) => {
    const lastInteractionAt = lastAt ? new Date(lastAt) : null;
    return {
      ...person,
      tags: tagMap.get(person.id) ?? [],
      lastInteractionAt,
      lastSummary: summaryMap.get(person.id) ?? null,
      health: computeHealth({ cadenceDays: person.cadenceDays, lastInteractionAt, now }),
    };
  });

  return sortPeople(result, filter.sort ?? "name");
}

export function sortPeople(rows: PersonRow[], sort: PeopleSort): PersonRow[] {
  const byName = (a: PersonRow, b: PersonRow) => a.fullName.localeCompare(b.fullName);
  switch (sort) {
    case "health":
      return rows.sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || byName(a, b));
    case "lastContact":
      return rows.sort(
        (a, b) => (a.lastInteractionAt?.getTime() ?? 0) - (b.lastInteractionAt?.getTime() ?? 0) || byName(a, b),
      );
    case "dealSource":
      return rows.sort(
        (a, b) =>
          (QUALITY_RANK[a.dealSourceQuality ?? "unknown"] ?? 9) - (QUALITY_RANK[b.dealSourceQuality ?? "unknown"] ?? 9) ||
          byName(a, b),
      );
    default:
      return rows.sort(byName);
  }
}

/** Minimal list for pickers (intro target, reminders). */
export async function listPeopleForPicker(): Promise<{ id: string; fullName: string }[]> {
  const userId = await requireUserId();
  return getDb()
    .select({ id: people.id, fullName: people.fullName })
    .from(people)
    .where(and(eq(people.userId, userId), isNull(people.archivedAt)))
    .orderBy(asc(people.fullName));
}

export async function listTags(): Promise<string[]> {
  const userId = await requireUserId();
  const rows = await getDb().select({ name: tags.name }).from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.name));
  return rows.map((r) => r.name);
}

/** Existing (non-archived) people with an email, for import duplicate detection. */
export async function listPeopleWithEmail(): Promise<{ id: string; fullName: string; email: string }[]> {
  const userId = await requireUserId();
  const rows = await getDb()
    .select({ id: people.id, fullName: people.fullName, email: people.email })
    .from(people)
    .where(and(eq(people.userId, userId), isNull(people.archivedAt)));
  return rows.filter((r): r is { id: string; fullName: string; email: string } => Boolean(r.email));
}

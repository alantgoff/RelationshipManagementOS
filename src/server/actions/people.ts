"use server";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { interactions, people, personTags, reminders } from "@/db/schema";
import type { DealSourceQuality, LpStage } from "@/domain/enums";
import { requireUserId } from "@/server/auth";
import { normalizePerson, upsertTags, type Executor } from "@/server/people-helpers";
import { getCadenceOverrides } from "@/server/queries/settings";
import { revalidateApp } from "@/server/revalidate";
import { personInput, uuid, type PersonInput } from "@/server/validation";

async function setPersonTags(db: Executor, userId: string, personId: string, names: string[]): Promise<void> {
  const ids = await upsertTags(db, userId, names);
  await db.delete(personTags).where(eq(personTags.personId, personId));
  if (ids.length) await db.insert(personTags).values(ids.map((tagId) => ({ personId, tagId })));
}

export async function createPerson(raw: PersonInput): Promise<{ id: string }> {
  const userId = await requireUserId();
  const parsed = normalizePerson(personInput.parse(raw), await getCadenceOverrides());
  const { tags: tagNames, ...fields } = parsed;
  const db = getDb();
  const [row] = await db
    .insert(people)
    .values({ ...fields, userId })
    .returning({ id: people.id });
  await setPersonTags(db, userId, row.id, tagNames);
  revalidateApp();
  return { id: row.id };
}

export async function updatePerson(id: string, raw: PersonInput): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  const parsed = normalizePerson(personInput.parse(raw), await getCadenceOverrides());
  const { tags: tagNames, ...fields } = parsed;
  const db = getDb();
  const updated = await db
    .update(people)
    .set({ ...fields, updatedAt: new Date() })
    .where(and(eq(people.id, id), eq(people.userId, userId)))
    .returning({ id: people.id });
  if (updated.length === 0) throw new Error("Person not found");
  await setPersonTags(db, userId, id, tagNames);
  revalidateApp([`/people/${id}`]);
}

export async function setLpStage(id: string, stage: LpStage | null): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  const db = getDb();
  const [row] = await db
    .select({ roles: people.roles })
    .from(people)
    .where(and(eq(people.id, id), eq(people.userId, userId)));
  if (!row) throw new Error("Person not found");
  const roles = [...row.roles];
  if (stage === "committed" && !roles.includes("committed_lp")) roles.push("committed_lp");
  await db
    .update(people)
    .set({ lpStage: stage, roles, updatedAt: new Date() })
    .where(and(eq(people.id, id), eq(people.userId, userId)));
  revalidateApp([`/people/${id}`]);
}

export async function setDealSourceQuality(id: string, quality: DealSourceQuality | null): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  await getDb()
    .update(people)
    .set({ dealSourceQuality: quality, updatedAt: new Date() })
    .where(and(eq(people.id, id), eq(people.userId, userId)));
  revalidateApp([`/people/${id}`]);
}

export async function archivePerson(id: string): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  await getDb()
    .update(people)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(people.id, id), eq(people.userId, userId)));
  revalidateApp([`/people/${id}`]);
}

export async function restorePerson(id: string): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  await getDb()
    .update(people)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(people.id, id), eq(people.userId, userId), isNotNull(people.archivedAt)));
  revalidateApp([`/people/${id}`]);
}

/**
 * Merge `sourceId` into `targetId` (FR-5): move interactions, intro links,
 * reminders; union roles and tags; fill empty target fields; delete source.
 */
export async function mergePeople(targetId: string, sourceId: string): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(targetId);
  uuid.parse(sourceId);
  if (targetId === sourceId) throw new Error("Cannot merge a person into themselves");
  const db = getDb();

  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(people)
      .where(and(inArray(people.id, [targetId, sourceId]), eq(people.userId, userId)));
    const target = rows.find((r) => r.id === targetId);
    const source = rows.find((r) => r.id === sourceId);
    if (!target || !source) throw new Error("Person not found");

    await tx.update(interactions).set({ personId: targetId }).where(eq(interactions.personId, sourceId));
    await tx
      .update(interactions)
      .set({ introducedPersonId: targetId })
      .where(eq(interactions.introducedPersonId, sourceId));
    await tx.update(reminders).set({ personId: targetId }).where(eq(reminders.personId, sourceId));

    const sourceTagIds = (
      await tx.select({ tagId: personTags.tagId }).from(personTags).where(eq(personTags.personId, sourceId))
    ).map((r) => r.tagId);
    if (sourceTagIds.length) {
      await tx
        .insert(personTags)
        .values(sourceTagIds.map((tagId) => ({ personId: targetId, tagId })))
        .onConflictDoNothing();
    }

    const roles = [...new Set([...target.roles, ...source.roles])];
    const fill = <K extends keyof typeof target>(k: K) => target[k] ?? source[k];
    await tx
      .update(people)
      .set({
        roles,
        preferredName: fill("preferredName"),
        email: fill("email"),
        phone: fill("phone"),
        company: fill("company"),
        title: fill("title"),
        location: fill("location"),
        howWeMet: fill("howWeMet"),
        notes: [target.notes, source.notes].filter(Boolean).join("\n\n") || null,
        cadenceDays:
          target.cadenceDays != null && source.cadenceDays != null
            ? Math.min(target.cadenceDays, source.cadenceDays)
            : fill("cadenceDays"),
        lpStage: fill("lpStage"),
        dealSourceQuality: fill("dealSourceQuality"),
        updatedAt: new Date(),
      })
      .where(eq(people.id, targetId));

    await tx.delete(people).where(and(eq(people.id, sourceId), eq(people.userId, userId)));
  });

  revalidateApp([`/people/${targetId}`, `/people/${sourceId}`]);
}

/** Count helper used by tests and the people page header. */
export async function countPeople(): Promise<number> {
  const userId = await requireUserId();
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(people)
    .where(eq(people.userId, userId));
  return Number(row?.n ?? 0);
}

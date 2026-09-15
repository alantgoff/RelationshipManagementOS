"use server";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { people, personTags } from "@/db/schema";
import type { ImportedPerson } from "@/domain/csv";
import { defaultCadenceForRoles } from "@/domain/health";
import { requireUserId } from "@/server/auth";
import { getCadenceOverrides } from "@/server/queries/settings";
import { revalidateApp } from "@/server/revalidate";
import { z } from "zod";
import { upsertTags } from "@/server/people-helpers";
import { ROLES } from "@/domain/enums";

const importedPerson = z.object({
  fullName: z.string().trim().min(1).max(200),
  preferredName: z.string().trim().max(200).optional(),
  email: z.string().trim().toLowerCase().max(320).optional(),
  phone: z.string().trim().max(60).optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  howWeMet: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(20_000).optional(),
  roles: z.array(z.enum(ROLES)).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).default([]),
  cadenceDays: z.number().int().min(1).max(3650).optional(),
});

/** Per-row decision for rows flagged as duplicates: merge into existing id, or skip. */
export type DuplicateDecision = { action: "merge"; existingId: string } | { action: "skip" };

export interface ImportRequest {
  people: ImportedPerson[];
  /** keyed by index into `people` */
  decisions: Record<number, DuplicateDecision>;
}

export interface ImportResult {
  created: number;
  merged: number;
  skipped: number;
}

const importRequest = z.object({
  people: z.array(importedPerson).max(5000),
  decisions: z.record(
    z.string(),
    z.union([z.object({ action: z.literal("merge"), existingId: z.uuid() }), z.object({ action: z.literal("skip") })]),
  ),
});

export async function importPeople(raw: ImportRequest): Promise<ImportResult> {
  const userId = await requireUserId();
  const req = importRequest.parse(raw);
  const overrides = await getCadenceOverrides();
  const db = getDb();
  const result: ImportResult = { created: 0, merged: 0, skipped: 0 };

  await db.transaction(async (tx) => {
    for (let i = 0; i < req.people.length; i++) {
      const p = req.people[i];
      const decision = req.decisions[String(i)];
      if (decision?.action === "skip") {
        result.skipped++;
        continue;
      }
      const { tags: tagNames, ...fields } = p;
      const tagIds = await upsertTags(tx, userId, tagNames);

      if (decision?.action === "merge") {
        const [existing] = await tx
          .select()
          .from(people)
          .where(and(eq(people.id, decision.existingId), eq(people.userId, userId)));
        if (!existing) {
          result.skipped++;
          continue;
        }
        const roles = [...new Set([...existing.roles, ...fields.roles])];
        await tx
          .update(people)
          .set({
            roles,
            preferredName: existing.preferredName ?? fields.preferredName ?? null,
            phone: existing.phone ?? fields.phone ?? null,
            company: existing.company ?? fields.company ?? null,
            title: existing.title ?? fields.title ?? null,
            location: existing.location ?? fields.location ?? null,
            howWeMet: existing.howWeMet ?? fields.howWeMet ?? null,
            notes: existing.notes ?? fields.notes ?? null,
            cadenceDays: existing.cadenceDays ?? fields.cadenceDays ?? defaultCadenceForRoles(roles, overrides),
            updatedAt: new Date(),
          })
          .where(eq(people.id, existing.id));
        if (tagIds.length) {
          await tx
            .insert(personTags)
            .values(tagIds.map((tagId) => ({ personId: existing.id, tagId })))
            .onConflictDoNothing();
        }
        result.merged++;
        continue;
      }

      const [row] = await tx
        .insert(people)
        .values({
          userId,
          fullName: fields.fullName,
          preferredName: fields.preferredName ?? null,
          email: fields.email ?? null,
          phone: fields.phone ?? null,
          company: fields.company ?? null,
          title: fields.title ?? null,
          location: fields.location ?? null,
          howWeMet: fields.howWeMet ?? null,
          notes: fields.notes ?? null,
          roles: fields.roles,
          cadenceDays: fields.cadenceDays ?? defaultCadenceForRoles(fields.roles, overrides),
        })
        .returning({ id: people.id });
      if (tagIds.length) await tx.insert(personTags).values(tagIds.map((tagId) => ({ personId: row.id, tagId })));
      result.created++;
    }
  });

  revalidateApp(["/import"]);
  return result;
}

/** Used by the import wizard to validate `merge` targets belong to the owner. */
export async function ownedPeopleIds(ids: string[]): Promise<string[]> {
  const userId = await requireUserId();
  if (ids.length === 0) return [];
  const rows = await getDb()
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.userId, userId), inArray(people.id, ids)));
  return rows.map((r) => r.id);
}

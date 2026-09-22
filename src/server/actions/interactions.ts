"use server";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { followUps, interactions, people } from "@/db/schema";
import { requireUserId } from "@/server/auth";
import { revalidateApp } from "@/server/revalidate";
import { followUpInput, interactionInput, uuid, type InteractionInput } from "@/server/validation";
import { z } from "zod";

async function assertOwnsPerson(userId: string, personId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.id, personId), eq(people.userId, userId)));
  if (!row) throw new Error("Person not found");
}

export async function logInteraction(raw: InteractionInput): Promise<{ id: string }> {
  const userId = await requireUserId();
  const input = interactionInput.parse(raw);
  await assertOwnsPerson(userId, input.personId);
  if (input.introducedPersonId) {
    if (input.introducedPersonId === input.personId) throw new Error("Cannot introduce a person to themselves");
    await assertOwnsPerson(userId, input.introducedPersonId);
  }
  const db = getDb();
  const { followUps: fus, ...fields } = input;
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(interactions)
      .values({
        ...fields,
        userId,
        occurredAt: fields.occurredAt ?? new Date(),
        introducedPersonId: fields.type === "intro" ? fields.introducedPersonId ?? null : null,
      })
      .returning({ id: interactions.id });
    if (fus.length) {
      await tx.insert(followUps).values(
        fus.map((f) => ({ userId, interactionId: row.id, description: f.description, dueAt: f.dueAt ?? null })),
      );
    }
    return row.id;
  });
  revalidateApp([`/people/${input.personId}`]);
  return { id };
}

const interactionPatch = interactionInput.omit({ personId: true, followUps: true }).partial();

export async function updateInteraction(id: string, raw: z.input<typeof interactionPatch>): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  const patch = interactionPatch.parse(raw);
  const updated = await getDb()
    .update(interactions)
    .set(patch)
    .where(and(eq(interactions.id, id), eq(interactions.userId, userId)))
    .returning({ personId: interactions.personId });
  if (updated.length === 0) throw new Error("Interaction not found");
  revalidateApp([`/people/${updated[0].personId}`]);
}

/** Deletes the interaction and, via cascade, its follow-ups (FR-9). */
export async function deleteInteraction(id: string): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  const deleted = await getDb()
    .delete(interactions)
    .where(and(eq(interactions.id, id), eq(interactions.userId, userId)))
    .returning({ personId: interactions.personId });
  if (deleted.length === 0) throw new Error("Interaction not found");
  revalidateApp([`/people/${deleted[0].personId}`]);
}

export async function addFollowUp(interactionId: string, raw: z.input<typeof followUpInput>): Promise<{ id: string }> {
  const userId = await requireUserId();
  uuid.parse(interactionId);
  const input = followUpInput.parse(raw);
  const db = getDb();
  const [owner] = await db
    .select({ personId: interactions.personId })
    .from(interactions)
    .where(and(eq(interactions.id, interactionId), eq(interactions.userId, userId)));
  if (!owner) throw new Error("Interaction not found");
  const [row] = await db
    .insert(followUps)
    .values({ userId, interactionId, description: input.description, dueAt: input.dueAt ?? null })
    .returning({ id: followUps.id });
  revalidateApp([`/people/${owner.personId}`]);
  return { id: row.id };
}

export async function setFollowUpDone(id: string, done: boolean): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  await getDb()
    .update(followUps)
    .set({ completedAt: done ? new Date() : null })
    .where(and(eq(followUps.id, id), eq(followUps.userId, userId)));
  revalidateApp();
}

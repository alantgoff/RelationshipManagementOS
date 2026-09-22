"use server";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { people, reminders } from "@/db/schema";
import { requireUserId } from "@/server/auth";
import { revalidateApp } from "@/server/revalidate";
import { reminderInput, uuid, type ReminderInput } from "@/server/validation";

export async function createReminder(raw: ReminderInput): Promise<{ id: string }> {
  const userId = await requireUserId();
  const input = reminderInput.parse(raw);
  const db = getDb();
  const [owner] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.id, input.personId), eq(people.userId, userId)));
  if (!owner) throw new Error("Person not found");
  const [row] = await db.insert(reminders).values({ ...input, userId }).returning({ id: reminders.id });
  revalidateApp([`/people/${input.personId}`]);
  return { id: row.id };
}

export async function completeReminder(id: string): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  await getDb()
    .update(reminders)
    .set({ completedAt: new Date() })
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
  revalidateApp();
}

export async function snoozeReminder(id: string, days: number): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  const n = Math.max(1, Math.min(365, Math.floor(days)));
  await getDb()
    .update(reminders)
    .set({ snoozedUntil: new Date(Date.now() + n * 86_400_000) })
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
  revalidateApp();
}

export async function deleteReminder(id: string): Promise<void> {
  const userId = await requireUserId();
  uuid.parse(id);
  await getDb()
    .delete(reminders)
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)));
  revalidateApp();
}

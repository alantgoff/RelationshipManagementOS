import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";

export async function resetDb(): Promise<void> {
  await getDb().execute(
    sql`truncate table follow_ups, reminders, interactions, person_tags, tags, people, user_settings restart identity cascade`,
  );
}

export async function teardownDb(): Promise<void> {
  await closeDb();
}

/** Switch the dev-auth user for owner-scoping tests. */
export function actAs(userId: string): void {
  process.env.DEV_USER_ID = userId;
}

export const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);
export const daysFromNow = (n: number): Date => new Date(Date.now() + n * 86_400_000);

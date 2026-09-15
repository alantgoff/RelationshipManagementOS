import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userSettings, type UserSettings } from "@/db/schema";
import type { Role } from "@/domain/enums";
import { requireUserId } from "@/server/auth";

export async function getSettings(): Promise<UserSettings> {
  const userId = await requireUserId();
  const db = getDb();
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return (
    row ?? {
      userId,
      timezone: "UTC",
      defaultCadences: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }
  );
}

export async function getCadenceOverrides(): Promise<Partial<Record<Role, number>>> {
  const s = await getSettings();
  return s.defaultCadences as Partial<Record<Role, number>>;
}

"use server";

import { getDb } from "@/db/client";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/server/auth";
import { revalidateApp } from "@/server/revalidate";
import { settingsInput, type SettingsInput } from "@/server/validation";

export async function updateSettings(raw: SettingsInput): Promise<void> {
  const userId = await requireUserId();
  const input = settingsInput.parse(raw);
  await getDb()
    .insert(userSettings)
    .values({ userId, ...input })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...input, updatedAt: new Date() },
    });
  revalidateApp(["/settings"]);
}

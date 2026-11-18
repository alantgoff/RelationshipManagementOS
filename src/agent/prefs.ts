import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { notificationLog, userSettings } from "@/db/schema";
import { localDate, safeTimeZone } from "@/lib/time";

/** Agent preferences (brief time, quiet hours, pause) and the unprompted-message budget (HA-8). */

export interface AgentPrefs {
  timezone: string;
  proactiveEnabled: boolean;
  pausedUntil: Date | null;
  briefTime: string;
  quietStart: string;
  quietEnd: string;
  dailyUnpromptedLimit: number;
}

export async function getAgentPrefs(userId: string): Promise<AgentPrefs> {
  const [row] = await getDb().select().from(userSettings).where(eq(userSettings.userId, userId));
  return {
    timezone: safeTimeZone(row?.timezone),
    proactiveEnabled: row?.proactiveEnabled ?? true,
    pausedUntil: row?.pausedUntil ?? null,
    briefTime: row?.briefTime ?? "07:30",
    quietStart: row?.quietStart ?? "21:00",
    quietEnd: row?.quietEnd ?? "07:00",
    dailyUnpromptedLimit: row?.dailyUnpromptedLimit ?? 3,
  };
}

export async function updateAgentPrefs(
  userId: string,
  patch: Partial<Pick<AgentPrefs, "proactiveEnabled" | "pausedUntil" | "briefTime" | "quietStart" | "quietEnd" | "dailyUnpromptedLimit">>,
): Promise<void> {
  await getDb()
    .insert(userSettings)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: userSettings.userId, set: { ...patch, updatedAt: new Date() } });
}

/** Unprompted messages already sent on the owner's local date. */
export async function unpromptedCountToday(userId: string, now: Date, tz: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(notificationLog)
    .where(and(eq(notificationLog.userId, userId), eq(notificationLog.localDate, localDate(now, tz))));
  return Number(row?.n ?? 0);
}

/**
 * Claim today's brief slot before composing it, so two overlapping cron ticks
 * can't both send. Returns null if another tick already claimed it.
 */
export async function claimBriefSlot(userId: string, now: Date, tz: string): Promise<string | null> {
  const rows = await getDb()
    .insert(notificationLog)
    .values({ userId, kind: "brief", localDate: localDate(now, tz), sentAt: now })
    .onConflictDoNothing()
    .returning({ id: notificationLog.id });
  return rows[0]?.id ?? null;
}

export async function attachNotificationMessage(logId: string, messageId: string): Promise<void> {
  await getDb().update(notificationLog).set({ messageId }).where(eq(notificationLog.id, logId));
}

export async function releaseNotification(logId: string): Promise<void> {
  await getDb().delete(notificationLog).where(eq(notificationLog.id, logId));
}

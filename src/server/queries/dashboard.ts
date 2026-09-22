import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { followUps, interactions, people, reminders } from "@/db/schema";
import type { Role } from "@/domain/enums";
import { compareForDashboard, isDashboardHealth } from "@/domain/health";
import { requireUserId } from "@/server/auth";
import { listPeople, type PersonRow } from "./people";

export interface DashboardFollowUp {
  id: string;
  description: string;
  dueAt: Date | null;
  personId: string;
  personName: string;
  interactionSummary: string;
  overdue: boolean;
}

export interface DashboardReminder {
  id: string;
  reason: string;
  dueAt: Date;
  personId: string;
  personName: string;
  overdue: boolean;
}

export interface Dashboard {
  attention: PersonRow[];
  followUps: DashboardFollowUp[];
  reminders: DashboardReminder[];
  totals: { people: number; withCadence: number };
}

const WEEK_MS = 7 * 86_400_000;

export async function getDashboard(roleFilter?: Role, now = new Date()): Promise<Dashboard> {
  const userId = await requireUserId();
  const db = getDb();
  const horizon = new Date(now.getTime() + WEEK_MS);

  const all = await listPeople({ role: roleFilter, sort: "name" }, now);
  const attention = all.filter((p) => isDashboardHealth(p.health)).sort(compareForDashboard);

  const [fuRows, remRows] = await Promise.all([
    db
      .select({
        id: followUps.id,
        description: followUps.description,
        dueAt: followUps.dueAt,
        personId: people.id,
        personName: people.fullName,
        interactionSummary: interactions.summary,
      })
      .from(followUps)
      .innerJoin(interactions, eq(interactions.id, followUps.interactionId))
      .innerJoin(people, eq(people.id, interactions.personId))
      .where(
        and(
          eq(followUps.userId, userId),
          isNull(followUps.completedAt),
          isNull(people.archivedAt),
          or(isNull(followUps.dueAt), lte(followUps.dueAt, horizon)),
          roleFilter ? sql`${roleFilter}::role = any(${people.roles})` : undefined,
        ),
      )
      .orderBy(sql`${followUps.dueAt} asc nulls last`),
    db
      .select({
        id: reminders.id,
        reason: reminders.reason,
        dueAt: reminders.dueAt,
        snoozedUntil: reminders.snoozedUntil,
        personId: people.id,
        personName: people.fullName,
      })
      .from(reminders)
      .innerJoin(people, eq(people.id, reminders.personId))
      .where(
        and(
          eq(reminders.userId, userId),
          isNull(reminders.completedAt),
          isNull(people.archivedAt),
          lte(reminders.dueAt, horizon),
          or(isNull(reminders.snoozedUntil), lte(reminders.snoozedUntil, now)),
          roleFilter ? sql`${roleFilter}::role = any(${people.roles})` : undefined,
        ),
      )
      .orderBy(asc(reminders.dueAt)),
  ]);

  return {
    attention,
    followUps: fuRows.map((f) => ({ ...f, overdue: f.dueAt != null && f.dueAt < now })),
    reminders: remRows.map((r) => ({ id: r.id, reason: r.reason, dueAt: r.dueAt, personId: r.personId, personName: r.personName, overdue: r.dueAt < now })),
    totals: { people: all.length, withCadence: all.filter((p) => p.cadenceDays != null).length },
  };
}


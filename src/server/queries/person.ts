import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/db/client";
import { followUps, interactions, people, personTags, reminders, tags, type FollowUp, type Interaction, type Person, type Reminder } from "@/db/schema";
import type { Health } from "@/domain/enums";
import { computeHealth } from "@/domain/health";
import { requireUserId } from "@/server/auth";

export interface TimelineItem extends Interaction {
  followUps: FollowUp[];
  introducedPersonName: string | null;
  /** Set when this person is the one who was introduced (appears on B's timeline). */
  viaPersonName: string | null;
}

export interface PersonDetail extends Person {
  tags: string[];
  lastInteractionAt: Date | null;
  health: Health;
  timeline: TimelineItem[];
  reminders: Reminder[];
  introsGiven: number;
  introsReceived: number;
}

export async function getPerson(id: string, now = new Date()): Promise<PersonDetail | null> {
  const userId = await requireUserId();
  const db = getDb();

  const [person] = await db.select().from(people).where(and(eq(people.id, id), eq(people.userId, userId)));
  if (!person) return null;

  const introduced = alias(people, "introduced");
  const owner = alias(people, "owner_person");

  const [tagRows, ownRows, viaRows, reminderRows, [counts]] = await Promise.all([
    db
      .select({ name: tags.name })
      .from(personTags)
      .innerJoin(tags, eq(tags.id, personTags.tagId))
      .where(eq(personTags.personId, id))
      .orderBy(asc(tags.name)),
    db
      .select({ interaction: interactions, introducedName: introduced.fullName })
      .from(interactions)
      .leftJoin(introduced, eq(introduced.id, interactions.introducedPersonId))
      .where(and(eq(interactions.personId, id), eq(interactions.userId, userId)))
      .orderBy(desc(interactions.occurredAt)),
    db
      .select({ interaction: interactions, viaName: owner.fullName })
      .from(interactions)
      .innerJoin(owner, eq(owner.id, interactions.personId))
      .where(and(eq(interactions.introducedPersonId, id), eq(interactions.userId, userId)))
      .orderBy(desc(interactions.occurredAt)),
    db
      .select()
      .from(reminders)
      .where(and(eq(reminders.personId, id), eq(reminders.userId, userId)))
      .orderBy(asc(reminders.dueAt)),
    db
      .select({
        given: sql<number>`count(*) filter (where ${interactions.personId} = ${id} and ${interactions.type} = 'intro' and ${interactions.introducedPersonId} is not null)`,
        received: sql<number>`count(*) filter (where ${interactions.introducedPersonId} = ${id} and ${interactions.type} = 'intro')`,
      })
      .from(interactions)
      .where(eq(interactions.userId, userId)),
  ]);

  const allIds = [...ownRows, ...viaRows].map((r) => r.interaction.id);
  const fuRows = allIds.length
    ? await db.select().from(followUps).where(sql`${followUps.interactionId} in ${allIds}`).orderBy(asc(followUps.dueAt))
    : [];
  const fuMap = new Map<string, FollowUp[]>();
  for (const f of fuRows) fuMap.set(f.interactionId, [...(fuMap.get(f.interactionId) ?? []), f]);

  const timeline: TimelineItem[] = [
    ...ownRows.map((r) => ({
      ...r.interaction,
      followUps: fuMap.get(r.interaction.id) ?? [],
      introducedPersonName: r.introducedName,
      viaPersonName: null,
    })),
    ...viaRows.map((r) => ({
      ...r.interaction,
      followUps: fuMap.get(r.interaction.id) ?? [],
      introducedPersonName: null,
      viaPersonName: r.viaName,
    })),
  ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  const lastInteractionAt = ownRows[0]?.interaction.occurredAt ?? null;

  return {
    ...person,
    tags: tagRows.map((t) => t.name),
    lastInteractionAt,
    health: computeHealth({ cadenceDays: person.cadenceDays, lastInteractionAt, now }),
    timeline,
    reminders: reminderRows,
    introsGiven: Number(counts?.given ?? 0),
    introsReceived: Number(counts?.received ?? 0),
  };
}

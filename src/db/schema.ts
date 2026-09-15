import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { DEAL_SOURCE_QUALITIES, INTERACTION_TYPES, LP_STAGES, ROLES } from "@/domain/enums";

export const roleEnum = pgEnum("role", ROLES);
export const lpStageEnum = pgEnum("lp_stage", LP_STAGES);
export const dealSourceQualityEnum = pgEnum("deal_source_quality", DEAL_SOURCE_QUALITIES);
export const interactionTypeEnum = pgEnum("interaction_type", INTERACTION_TYPES);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    fullName: text("full_name").notNull(),
    preferredName: text("preferred_name"),
    email: text("email"),
    phone: text("phone"),
    company: text("company"),
    title: text("title"),
    location: text("location"),
    howWeMet: text("how_we_met"),
    notes: text("notes"),
    roles: roleEnum("roles").array().notNull().default(sql`'{}'::role[]`),
    cadenceDays: integer("cadence_days"),
    lpStage: lpStageEnum("lp_stage"),
    dealSourceQuality: dealSourceQualityEnum("deal_source_quality"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("people_user_idx").on(t.userId),
    index("people_user_email_idx").on(t.userId, t.email),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("tags_user_name_idx").on(t.userId, t.name)],
);

export const personTags = pgTable(
  "person_tags",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.personId, t.tagId] })],
);

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    type: interactionTypeEnum("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    summary: text("summary").notNull(),
    notes: text("notes"),
    introducedPersonId: uuid("introduced_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interactions_user_person_idx").on(t.userId, t.personId, t.occurredAt),
    index("interactions_introduced_idx").on(t.introducedPersonId),
  ],
);

export const followUps = pgTable(
  "follow_ups",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("follow_ups_user_due_idx").on(t.userId, t.dueAt)],
);

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  },
  (t) => [index("reminders_user_due_idx").on(t.userId, t.dueAt)],
);

export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  timezone: text("timezone").notNull().default("UTC"),
  /** Per-role cadence overrides, e.g. { "prospective_lp": 14 } */
  defaultCadences: jsonb("default_cadences").$type<Record<string, number>>().notNull().default({}),
  ...timestamps,
});

export const peopleRelations = relations(people, ({ many }) => ({
  interactions: many(interactions, { relationName: "personInteractions" }),
  personTags: many(personTags),
  reminders: many(reminders),
}));

export const tagsRelations = relations(tags, ({ many }) => ({ personTags: many(personTags) }));

export const personTagsRelations = relations(personTags, ({ one }) => ({
  person: one(people, { fields: [personTags.personId], references: [people.id] }),
  tag: one(tags, { fields: [personTags.tagId], references: [tags.id] }),
}));

export const interactionsRelations = relations(interactions, ({ one, many }) => ({
  person: one(people, {
    fields: [interactions.personId],
    references: [people.id],
    relationName: "personInteractions",
  }),
  introducedPerson: one(people, {
    fields: [interactions.introducedPersonId],
    references: [people.id],
    relationName: "introducedPerson",
  }),
  followUps: many(followUps),
}));

export const followUpsRelations = relations(followUps, ({ one }) => ({
  interaction: one(interactions, { fields: [followUps.interactionId], references: [interactions.id] }),
}));

export const remindersRelations = relations(reminders, ({ one }) => ({
  person: one(people, { fields: [reminders.personId], references: [people.id] }),
}));

export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
export type FollowUp = typeof followUps.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;

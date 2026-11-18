import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
    /** Committed or soft-circled amount for LPs, in whole US dollars. */
    lpCommitmentUsd: bigint("lp_commitment_usd", { mode: "number" }),
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
  /** Agent: whether it may send unprompted messages (briefs, nudges). `stop` turns this off. */
  proactiveEnabled: boolean("proactive_enabled").notNull().default(true),
  /** Agent: unprompted messages are held until this time (`pause 2h`). */
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  /** Agent: local time of the weekday morning brief, HH:MM. */
  briefTime: text("brief_time").notNull().default("07:30"),
  /** Agent: quiet hours in local time, HH:MM; may wrap past midnight. */
  quietStart: text("quiet_start").notNull().default("21:00"),
  quietEnd: text("quiet_end").notNull().default("07:00"),
  /** Agent: at most this many unprompted messages per local day. */
  dailyUnpromptedLimit: integer("daily_unprompted_limit").notNull().default(3),
  ...timestamps,
});

/* ───────────────────────── Headless agent (spec 0002) ───────────────────────── */

/** One messaging line per owner. The phone is set only after the owner texts the binding code. */
export const channelBindings = pgTable(
  "channel_bindings",
  {
    userId: text("user_id").primaryKey(),
    provider: text("provider").notNull(),
    /** Owner's phone in E.164, set when verified. */
    phone: text("phone"),
    pendingCodeHash: text("pending_code_hash"),
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("channel_bindings_phone_idx").on(t.phone), index("channel_bindings_code_idx").on(t.pendingCodeHash)],
);

/** Attachment metadata. The derived text (transcript, description, card) lives in the encrypted body. */
export interface StoredMedia {
  kind: "audio" | "image" | "contact" | "file";
  contentType?: string;
  error?: string;
}

/** Every message on the line, both directions. Bodies are encrypted (src/lib/crypto.ts). */
export const channelMessages = pgTable(
  "channel_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id"),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    /** chat | command | brief | draft | system */
    kind: text("kind").notNull().default("chat"),
    bodyEnc: text("body_enc").notNull(),
    media: jsonb("media").$type<StoredMedia[]>().notNull().default([]),
    /** Inbound with attachments: null until they're processed and the body holds the full text. */
    readyAt: timestamp("ready_at", { withTimezone: true }).defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_messages_provider_msg_idx").on(t.provider, t.providerMessageId),
    index("channel_messages_pending_idx").on(t.userId, t.direction, t.processedAt),
    index("channel_messages_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/** Failed binding-code attempts from unknown numbers, for rate limiting (phone is an HMAC, not the number). */
export const bindingFailures = pgTable(
  "binding_failures",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    phoneHash: text("phone_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("binding_failures_created_idx").on(t.createdAt), index("binding_failures_phone_idx").on(t.phoneHash, t.createdAt)],
);

/** One agent turn: an inbound message and everything the agent did for it. */
export const agentTurns = pgTable(
  "agent_turns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    inboundMessageId: uuid("inbound_message_id").references(() => channelMessages.id, { onDelete: "set null" }),
    model: text("model"),
    provider: text("provider"),
    contextTokens: integer("context_tokens"),
    steps: integer("steps").notNull().default(0),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_turns_user_created_idx").on(t.userId, t.createdAt)],
);

/** Each tool call, with how to reverse it. Powers `undo` and `why`. */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => agentTurns.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    ok: boolean("ok").notNull(),
    summary: text("summary").notNull(),
    undo: jsonb("undo").$type<Record<string, unknown> | null>(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_actions_turn_idx").on(t.turnId), index("agent_actions_user_created_idx").on(t.userId, t.createdAt)],
);

/** Things that would reach another person. The owner approves each one (HA-6). */
export const pendingActions = pgTable(
  "pending_actions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull().default("message_draft"),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    bodyEnc: text("body_enc").notNull(),
    /** pending | approved | rejected | expired */
    status: text("status").notNull().default("pending"),
    turnId: uuid("turn_id").references(() => agentTurns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("pending_actions_user_status_idx").on(t.userId, t.status)],
);

/** Durable facts with provenance. Superseded facts get valid_to set; nothing is deleted. */
export const memoryFacts = pgTable(
  "memory_facts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    /** Null means a fact about the owner. */
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    fact: text("fact").notNull(),
    /** message | web | import */
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("memory_facts_user_person_idx").on(t.userId, t.personId)],
);

/** Rolling summary of the conversation before the recent window. */
export const threadSummaries = pgTable("thread_summaries", {
  userId: text("user_id").primaryKey(),
  summaryEnc: text("summary_enc").notNull(),
  /** created_at of the newest message folded into the summary. */
  coversThrough: timestamp("covers_through", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Unprompted messages sent, for the daily budget and brief idempotency (HA-8). */
export const notificationLog = pgTable(
  "notification_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    /** brief | nudge */
    kind: text("kind").notNull(),
    localDate: text("local_date").notNull(),
    messageId: uuid("message_id").references(() => channelMessages.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_log_brief_once_idx").on(t.userId, t.kind, t.localDate).where(sql`kind = 'brief'`),
    index("notification_log_user_date_idx").on(t.userId, t.localDate),
  ],
);

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
export type ChannelBinding = typeof channelBindings.$inferSelect;
export type ChannelMessage = typeof channelMessages.$inferSelect;
export type AgentAction = typeof agentActions.$inferSelect;
export type PendingAction = typeof pendingActions.$inferSelect;
export type MemoryFact = typeof memoryFacts.$inferSelect;

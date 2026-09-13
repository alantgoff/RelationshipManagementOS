import { z } from "zod";
import { DEAL_SOURCE_QUALITIES, INTERACTION_TYPES, LP_STAGES, ROLES } from "@/domain/enums";

const optionalText = z
  .string()
  .trim()
  .max(2000)
  .transform((s) => (s === "" ? null : s))
  .nullable()
  .optional();

export const personInput = z.object({
  fullName: z.string().trim().min(1, "Name is required").max(200),
  preferredName: optionalText,
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .transform((s) => (s === "" ? null : s))
    .pipe(z.email().nullable())
    .nullable()
    .optional(),
  phone: optionalText,
  company: optionalText,
  title: optionalText,
  location: optionalText,
  howWeMet: optionalText,
  notes: z.string().trim().max(20_000).transform((s) => (s === "" ? null : s)).nullable().optional(),
  roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  /** null or undefined = derive from roles */
  cadenceDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
  lpStage: z.enum(LP_STAGES).nullable().optional(),
  dealSourceQuality: z.enum(DEAL_SOURCE_QUALITIES).nullable().optional(),
});
export type PersonInput = z.input<typeof personInput>;

export const followUpInput = z.object({
  description: z.string().trim().min(1).max(500),
  dueAt: z.coerce.date().nullable().optional(),
});

export const interactionInput = z.object({
  personId: z.uuid(),
  type: z.enum(INTERACTION_TYPES),
  occurredAt: z.coerce.date().optional(),
  summary: z.string().trim().min(1, "Summary is required").max(300),
  notes: z.string().trim().max(20_000).transform((s) => (s === "" ? null : s)).nullable().optional(),
  introducedPersonId: z.uuid().nullable().optional(),
  followUps: z.array(followUpInput).max(20).default([]),
});
export type InteractionInput = z.input<typeof interactionInput>;

export const reminderInput = z.object({
  personId: z.uuid(),
  dueAt: z.coerce.date(),
  reason: z.string().trim().min(1).max(300),
});
export type ReminderInput = z.input<typeof reminderInput>;

export const settingsInput = z.object({
  timezone: z.string().trim().min(1).max(64),
  defaultCadences: z.partialRecord(z.enum(ROLES), z.coerce.number().int().min(1).max(3650)),
});
export type SettingsInput = z.input<typeof settingsInput>;

export const uuid = z.uuid();

/** Shared enum definitions used by the DB schema, zod validators, and UI. */

export const ROLES = [
  "friend",
  "family",
  "mentor",
  "prospective_lp",
  "committed_lp",
  "deal_source",
  "founder",
  "co_investor",
  "service_provider",
  "other",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  friend: "Friend",
  family: "Family",
  mentor: "Mentor",
  prospective_lp: "Prospective LP",
  committed_lp: "Committed LP",
  deal_source: "Deal source",
  founder: "Founder",
  co_investor: "Co-investor",
  service_provider: "Service provider",
  other: "Other",
};

export const LP_STAGES = [
  "identified",
  "intro_made",
  "first_meeting",
  "data_room",
  "soft_commit",
  "committed",
  "passed",
] as const;
export type LpStage = (typeof LP_STAGES)[number];

export const LP_STAGE_LABELS: Record<LpStage, string> = {
  identified: "Identified",
  intro_made: "Intro made",
  first_meeting: "First meeting",
  data_room: "Data room",
  soft_commit: "Soft commit",
  committed: "Committed",
  passed: "Passed",
};

export const DEAL_SOURCE_QUALITIES = ["unknown", "low", "medium", "high"] as const;
export type DealSourceQuality = (typeof DEAL_SOURCE_QUALITIES)[number];

export const INTERACTION_TYPES = [
  "call",
  "meeting",
  "email",
  "message",
  "intro",
  "event",
  "note",
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export const INTERACTION_TYPE_LABELS: Record<InteractionType, string> = {
  call: "Call",
  meeting: "Meeting",
  email: "Email",
  message: "Message",
  intro: "Intro",
  event: "Event",
  note: "Note",
};

export const HEALTH_STATES = ["no_cadence", "never", "fresh", "warm", "due", "cold"] as const;
export type Health = (typeof HEALTH_STATES)[number];

export const HEALTH_LABELS: Record<Health, string> = {
  no_cadence: "No cadence",
  never: "Never contacted",
  fresh: "Fresh",
  warm: "Warm",
  due: "Due",
  cold: "Cold",
};

import { z } from "zod";
import { DEAL_SOURCE_QUALITIES, HEALTH_STATES, INTERACTION_TYPES, LP_STAGES, ROLES } from "@/domain/enums";
import type { ToolSpec } from "./llm";

/**
 * The agent's tool surface: few tools, clearly named, snake_case arguments,
 * dates as YYYY-MM-DD. Each tool is later bound to an existing owner-scoped
 * server action or query (see docs/specs/0002-headless-agent.md). Schemas are
 * zod so the same definition validates model output and generates the JSON
 * Schema sent to the model.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const personId = z.string().min(1).describe("A person id from the working set or from find_people");

export const toolSchemas = {
  find_people: {
    description:
      "Search the owner's people by name, company, email, tag, or words from past conversations. Use this before any tool that needs a person_id when the person is not already in the working set.",
    input: z.object({
      query: z.string().min(1).describe("Name, company, or keywords, e.g. 'Sarah Sequoia'"),
      role: z.enum(ROLES).optional(),
      health: z.enum(HEALTH_STATES).optional().describe("Filter by relationship health"),
      limit: z.number().int().min(1).max(20).optional(),
    }),
  },
  get_person: {
    description: "Get one person's dossier: profile, relationship health, recent timeline, open follow-ups, and known facts.",
    input: z.object({ person_id: personId }),
  },
  create_person: {
    description: "Add someone new. Only use when find_people found no match.",
    input: z.object({
      full_name: z.string().min(1),
      email: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      roles: z.array(z.enum(ROLES)).optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }),
  },
  update_person: {
    description: "Change a person's profile fields, roles, tags, cadence, or deal-source quality.",
    input: z.object({
      person_id: personId,
      company: z.string().optional(),
      title: z.string().optional(),
      email: z.string().optional(),
      location: z.string().optional(),
      roles: z.array(z.enum(ROLES)).optional().describe("The full new role list"),
      add_tags: z.array(z.string()).optional(),
      cadence_days: z.number().int().min(1).max(3650).optional(),
      deal_source_quality: z.enum(DEAL_SOURCE_QUALITIES).optional(),
    }),
  },
  log_interaction: {
    description:
      "Record something that already happened with a person (call, meeting, email, message, intro, event, note), with optional follow-ups the owner promised.",
    input: z.object({
      person_id: personId,
      type: z.enum(INTERACTION_TYPES),
      summary: z.string().min(1).max(300).describe("One line, e.g. 'Coffee, discussed Fund I timing'"),
      occurred_on: isoDate.optional().describe("Defaults to today"),
      notes: z.string().optional(),
      introduced_person_id: z.string().optional().describe("For type 'intro': the person they were introduced to"),
      follow_ups: z
        .array(z.object({ description: z.string().min(1), due_on: isoDate.optional() }))
        .optional(),
    }),
  },
  add_follow_up: {
    description: "Add a promise the owner made to a person, not tied to a new interaction.",
    input: z.object({ person_id: personId, description: z.string().min(1), due_on: isoDate.optional() }),
  },
  complete_follow_up: {
    description: "Mark a follow-up as done.",
    input: z.object({ follow_up_id: z.string().min(1) }),
  },
  set_reminder: {
    description: "Remind the owner about a person on a date (birthday, check back after their launch, etc).",
    input: z.object({ person_id: personId, due_on: isoDate, reason: z.string().min(1) }),
  },
  set_lp_stage: {
    description: "Move a prospective LP through the fundraising pipeline, optionally with a commitment amount.",
    input: z.object({
      person_id: personId,
      stage: z.enum(LP_STAGES),
      commitment_usd: z.number().positive().optional(),
    }),
  },
  whats_due: {
    description: "List who needs attention (cold, due, never contacted), open follow-ups, and reminders.",
    input: z.object({
      scope: z.enum(["today", "week"]).optional(),
      role: z.enum(ROLES).optional(),
    }),
  },
  remember: {
    description:
      "Save a durable fact the owner told you (preferences, family, where someone works now). Not for events; use log_interaction for those.",
    input: z.object({
      person_id: personId.optional().describe("Omit for facts about the owner"),
      fact: z.string().min(1).max(500),
    }),
  },
  draft_message: {
    description:
      "Draft a message to someone for the owner to approve. Never sends. The owner confirms with a thumbs up or 'send'.",
    input: z.object({
      person_id: personId,
      channel: z.enum(["imessage", "email", "linkedin"]),
      intent: z.string().min(1).describe("What the message should accomplish"),
    }),
  },
} as const;

export type ToolName = keyof typeof toolSchemas;
export const TOOL_NAMES = Object.keys(toolSchemas) as ToolName[];

/** OpenAI-compatible tool list, sorted and deterministic so it stays in the cached prefix. */
export function toolSpecs(names: readonly ToolName[] = TOOL_NAMES): ToolSpec[] {
  return [...names].sort().map((name) => {
    const { description, input } = toolSchemas[name];
    const parameters = z.toJSONSchema(input) as Record<string, unknown>;
    delete parameters.$schema;
    return { type: "function", function: { name, description, parameters } };
  });
}

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolSchemas, name);
}

/** Validate model-produced arguments for a tool. */
export function validateToolInput(name: ToolName, args: unknown) {
  return toolSchemas[name].input.safeParse(args);
}

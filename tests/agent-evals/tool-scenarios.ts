import type { ToolName } from "@/agent/tool-specs";

/**
 * First-call tool-use scenarios. Each gives the agent one owner message plus a
 * working set, and checks the FIRST tool call it makes (or that it makes none).
 * Deterministic date: Thursday 2026-09-24.
 */

export type ArgMatcher =
  | string
  | number
  | boolean
  | { includes: string }
  | { oneOf: readonly (string | number | boolean)[] }
  | { present: true }
  | { absent: true }
  | { contains: string | number };

export interface ToolScenario {
  id: string;
  message: string;
  /** Acceptable first tools; null means the agent should reply without a tool. */
  expectTool: readonly ToolName[] | null;
  /** Dotted paths into the arguments, e.g. "follow_ups.0.due_on". */
  expectArgs?: Record<string, ArgMatcher>;
}

export const EVAL_TODAY = "2026-09-24";
export const EVAL_WEEKDAY = "Thursday";

export const EVAL_WORKING_SET = `People in play (mentioned recently):
- Priya Patel [a1b2c3d4] · Prospective LP · Partner at Halcyon Family Office · due, last contact 2026-08-10, every 21d · LP stage First meeting
- Raj Mehta [b2c3d4e5] · Founder · CEO at Acme Robotics · warm, last contact 2026-09-01, every 45d
- Sarah Chen [c3d4e5f6] · Deal source · Scout at Sequoia · fresh, last contact 2026-09-20, every 30d
- Leo Park [d4e5f6a7] · Co-investor · Partner at Northstar Ventures · warm, last contact 2026-08-30, every 60d
- Dana Lee [e5f6a7b8] · Friend · cold, last contact 2026-06-02, every 45d

Due:
- follow-up [f6a7b8c9] Send Fund I deck to Priya → Priya Patel, due 2026-09-25`;

export const TOOL_SCENARIOS: readonly ToolScenario[] = [
  {
    id: "log-coffee",
    message: "Had coffee with Priya this morning, she's keen on Fund I",
    expectTool: ["log_interaction"],
    expectArgs: { person_id: "a1b2c3d4", type: { oneOf: ["meeting", "event"] }, summary: { present: true } },
  },
  {
    id: "log-call-with-promise",
    message: "Call with Raj yesterday about his seed round. I promised to send him 3 angel intros by Friday",
    expectTool: ["log_interaction"],
    expectArgs: {
      person_id: "b2c3d4e5",
      type: "call",
      occurred_on: "2026-09-23",
      "follow_ups.0.due_on": "2026-09-25",
    },
  },
  { id: "going-cold", message: "who's going cold?", expectTool: ["whats_due"] },
  {
    id: "what-do-i-know",
    message: "What do I know about Sarah?",
    expectTool: ["get_person"],
    expectArgs: { person_id: "c3d4e5f6" },
  },
  {
    id: "unknown-person-search-first",
    message: "Met Tom Becker at the Climate Week dinner, he runs a family office",
    expectTool: ["find_people"],
    expectArgs: { query: { includes: "tom" } },
  },
  {
    id: "birthday-reminder",
    message: "Remind me about Dana's birthday on October 8",
    expectTool: ["set_reminder"],
    expectArgs: { person_id: "e5f6a7b8", due_on: "2026-10-08", reason: { includes: "birthday" } },
  },
  {
    id: "soft-circle",
    message: "Priya soft circled 250k!",
    expectTool: ["set_lp_stage"],
    expectArgs: { person_id: "a1b2c3d4", stage: "soft_commit", commitment_usd: 250000 },
  },
  {
    id: "job-change",
    message: "Sarah moved to Benchmark",
    expectTool: ["update_person", "remember"],
    expectArgs: { person_id: "c3d4e5f6" },
  },
  {
    id: "draft-not-send",
    message: "Draft a note to Leo asking if he wants to co-invest in Acme",
    expectTool: ["draft_message"],
    expectArgs: { person_id: "d4e5f6a7", intent: { present: true }, body: { present: true } },
  },
  { id: "small-talk", message: "thanks!", expectTool: null },
  {
    id: "complete-promise",
    message: "I sent Priya the deck",
    expectTool: ["complete_follow_up", "log_interaction"],
  },
  {
    id: "intro",
    message: "Introduced Raj to Leo over email today",
    expectTool: ["log_interaction"],
    expectArgs: {
      person_id: { oneOf: ["b2c3d4e5", "d4e5f6a7"] },
      type: "intro",
      introduced_person_id: { oneOf: ["b2c3d4e5", "d4e5f6a7"] },
    },
  },
  {
    id: "preference-fact",
    message: "Raj hates phone calls, text only",
    expectTool: ["remember", "update_person"],
    expectArgs: { person_id: "b2c3d4e5" },
  },
  {
    id: "list-lps",
    message: "Who are my prospective LPs?",
    expectTool: ["find_people", "whats_due"],
    expectArgs: { role: "prospective_lp" },
  },
  {
    id: "deal-source-quality",
    message: "Mark Sarah as a high quality deal source",
    expectTool: ["update_person"],
    expectArgs: { person_id: "c3d4e5f6", deal_source_quality: "high" },
  },
  {
    id: "relative-date-follow-up",
    message: "Follow up with Dana in 2 weeks about the ski trip",
    expectTool: ["add_follow_up", "set_reminder"],
    expectArgs: { person_id: "e5f6a7b8", due_on: "2026-10-08" },
  },
  {
    id: "week-plate",
    message: "What's on my plate this week?",
    expectTool: ["whats_due"],
  },
  {
    id: "add-new-person",
    message: "Add Maya Singh, founder of Loom Labs, maya@loomlabs.io",
    expectTool: ["find_people", "create_person"],
  },
  {
    id: "lp-passed",
    message: "Priya passed on Fund I :(",
    expectTool: ["set_lp_stage"],
    expectArgs: { person_id: "a1b2c3d4", stage: "passed" },
  },
  {
    id: "scheduling-preference",
    message: "Leo prefers Tuesday mornings for calls",
    expectTool: ["remember", "update_person", "log_interaction"],
    expectArgs: { person_id: "d4e5f6a7" },
  },
];

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

export const EVAL_WORKING_SET = `People:
- Priya Patel (id p_priya): prospective LP, stage first_meeting, last contact 2026-08-10, cadence 21d
- Raj Mehta (id p_raj): founder of Acme Robotics, last contact 2026-09-01
- Sarah Chen (id p_sarah): deal source, scout at Sequoia
- Leo Park (id p_leo): co-investor at Northstar Ventures
- Dana Lee (id p_dana): friend
Open follow-ups:
- f_deck: "Send Fund I deck to Priya Patel", due 2026-09-25`;

export const TOOL_SCENARIOS: readonly ToolScenario[] = [
  {
    id: "log-coffee",
    message: "Had coffee with Priya this morning, she's keen on Fund I",
    expectTool: ["log_interaction"],
    expectArgs: { person_id: "p_priya", type: { oneOf: ["meeting", "event"] }, summary: { present: true } },
  },
  {
    id: "log-call-with-promise",
    message: "Call with Raj yesterday about his seed round. I promised to send him 3 angel intros by Friday",
    expectTool: ["log_interaction"],
    expectArgs: {
      person_id: "p_raj",
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
    expectArgs: { person_id: "p_sarah" },
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
    expectArgs: { person_id: "p_dana", due_on: "2026-10-08", reason: { includes: "birthday" } },
  },
  {
    id: "soft-circle",
    message: "Priya soft circled 250k!",
    expectTool: ["set_lp_stage"],
    expectArgs: { person_id: "p_priya", stage: "soft_commit", commitment_usd: 250000 },
  },
  {
    id: "job-change",
    message: "Sarah moved to Benchmark",
    expectTool: ["update_person", "remember"],
    expectArgs: { person_id: "p_sarah" },
  },
  {
    id: "draft-not-send",
    message: "Draft a note to Leo asking if he wants to co-invest in Acme",
    expectTool: ["draft_message"],
    expectArgs: { person_id: "p_leo", intent: { present: true } },
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
      person_id: { oneOf: ["p_raj", "p_leo"] },
      type: "intro",
      introduced_person_id: { oneOf: ["p_raj", "p_leo"] },
    },
  },
  {
    id: "preference-fact",
    message: "Raj hates phone calls, text only",
    expectTool: ["remember", "update_person"],
    expectArgs: { person_id: "p_raj" },
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
    expectArgs: { person_id: "p_sarah", deal_source_quality: "high" },
  },
  {
    id: "relative-date-follow-up",
    message: "Follow up with Dana in 2 weeks about the ski trip",
    expectTool: ["add_follow_up", "set_reminder"],
    expectArgs: { person_id: "p_dana", due_on: "2026-10-08" },
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
    expectArgs: { person_id: "p_priya", stage: "passed" },
  },
  {
    id: "scheduling-preference",
    message: "Leo prefers Tuesday mornings for calls",
    expectTool: ["remember", "update_person", "log_interaction"],
    expectArgs: { person_id: "p_leo" },
  },
];

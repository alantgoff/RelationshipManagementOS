import { and, eq, isNull, sql } from "drizzle-orm";
import { createBindingCode, redeemBindingCode } from "@/agent/store";
import { getDb } from "@/db/client";
import { followUps, interactions, memoryFacts, pendingActions, people, reminders } from "@/db/schema";
import { localDate } from "@/lib/time";
import { logInteraction } from "@/server/actions/interactions";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { runAsOwner } from "@/server/auth";

/**
 * Full-turn scenarios: the real runtime and tools run against a scratch
 * database with the live model, and each scenario checks the records written
 * and the reply. Deterministic clock: Thursday 2026-09-24, 11:00 New York.
 */

export const TURN_NOW = new Date("2026-09-24T15:00:00Z");
export const TURN_TZ = "America/New_York";

export interface SeededPeople {
  priya: string;
  raj: string;
  sarah: string;
  leo: string;
  dana: string;
  /** Interactions created by the fixture, which checks must ignore. */
  seededInteractions: string[];
}

export interface TurnCheckContext {
  userId: string;
  ids: SeededPeople;
  reply: string;
  /** Messages the agent sent to the owner during the turn (reply parts and drafts). */
  sent: string[];
}

export interface TurnScenario {
  id: string;
  message: string;
  /** Returns failure reasons; empty means pass. */
  check: (ctx: TurnCheckContext) => Promise<string[]>;
}

const db = () => getDb();

let seeded = new Set<string>();

/** Interactions the turn created for a person (fixture rows excluded). */
async function interactionsFor(personId: string) {
  const rows = await db().select().from(interactions).where(eq(interactions.personId, personId));
  return rows.filter((r) => !seeded.has(r.id));
}

export const TURN_SCENARIOS: TurnScenario[] = [
  {
    id: "coffee-with-promise",
    message: "Had coffee with Priya this morning, she's keen on Fund I. I promised to send her the deck Friday",
    async check({ ids }) {
      const errs: string[] = [];
      const rows = await interactionsFor(ids.priya);
      if (rows.length !== 1) return [`expected 1 interaction for Priya, got ${rows.length}`];
      if (rows[0].type !== "meeting") errs.push(`type ${rows[0].type}, want meeting`);
      if (localDate(rows[0].occurredAt, TURN_TZ) !== "2026-09-24") errs.push(`occurred ${localDate(rows[0].occurredAt, TURN_TZ)}, want 2026-09-24`);
      const fus = await db().select().from(followUps).where(eq(followUps.interactionId, rows[0].id));
      const due = fus.map((f) => (f.dueAt ? localDate(f.dueAt, TURN_TZ) : null));
      if (!due.includes("2026-09-25")) errs.push(`follow-up due dates ${JSON.stringify(due)}, want 2026-09-25`);
      return errs;
    },
  },
  {
    id: "yesterday-call",
    message: "Call with Raj yesterday about his seed round",
    async check({ ids }) {
      const rows = await interactionsFor(ids.raj);
      if (rows.length !== 1) return [`expected 1 interaction for Raj, got ${rows.length}`];
      const errs: string[] = [];
      if (rows[0].type !== "call") errs.push(`type ${rows[0].type}, want call`);
      if (localDate(rows[0].occurredAt, TURN_TZ) !== "2026-09-23") errs.push(`occurred ${localDate(rows[0].occurredAt, TURN_TZ)}, want 2026-09-23`);
      return errs;
    },
  },
  {
    id: "soft-circle",
    message: "Priya soft circled 250k!",
    async check({ ids }) {
      const [p] = await db().select().from(people).where(eq(people.id, ids.priya));
      const errs: string[] = [];
      if (p.lpStage !== "soft_commit") errs.push(`lp stage ${p.lpStage}, want soft_commit`);
      if (p.lpCommitmentUsd !== 250000) errs.push(`commitment ${p.lpCommitmentUsd}, want 250000`);
      return errs;
    },
  },
  {
    id: "birthday-reminder",
    message: "Remind me about Dana's birthday on October 8",
    async check({ ids }) {
      const rows = await db().select().from(reminders).where(eq(reminders.personId, ids.dana));
      if (rows.length !== 1) return [`expected 1 reminder for Dana, got ${rows.length}`];
      return localDate(rows[0].dueAt, TURN_TZ) === "2026-10-08" ? [] : [`due ${localDate(rows[0].dueAt, TURN_TZ)}, want 2026-10-08`];
    },
  },
  {
    id: "preference-fact",
    message: "Raj hates phone calls, text only",
    async check({ ids }) {
      const facts = await db()
        .select()
        .from(memoryFacts)
        .where(and(eq(memoryFacts.personId, ids.raj), isNull(memoryFacts.validTo)));
      const [p] = await db().select().from(people).where(eq(people.id, ids.raj));
      const stored = facts.some((f) => /call|text/i.test(f.fact)) || /call|text/i.test(p.notes ?? "");
      const logged = (await interactionsFor(ids.raj)).length;
      const errs: string[] = [];
      if (!stored) errs.push("no fact or note about calls/texting for Raj");
      if (logged) errs.push("a preference was logged as an interaction");
      return errs;
    },
  },
  {
    id: "job-change",
    message: "Sarah moved to Benchmark",
    async check({ ids }) {
      const [p] = await db().select().from(people).where(eq(people.id, ids.sarah));
      const facts = await db().select().from(memoryFacts).where(eq(memoryFacts.personId, ids.sarah));
      return /benchmark/i.test(p.company ?? "") || facts.some((f) => /benchmark/i.test(f.fact)) ? [] : ["Benchmark not recorded for Sarah"];
    },
  },
  {
    id: "draft-not-send",
    message: "Draft a note to Leo asking if he wants to co-invest in Acme",
    async check({ ids, sent }) {
      const drafts = await db().select().from(pendingActions).where(eq(pendingActions.personId, ids.leo));
      const errs: string[] = [];
      if (drafts.length !== 1) errs.push(`expected 1 draft for Leo, got ${drafts.length}`);
      if ((await interactionsFor(ids.leo)).length) errs.push("logged an interaction before the owner sent anything");
      if (sent.length < 2) errs.push("the draft text was not shown to the owner");
      return errs;
    },
  },
  {
    id: "intro",
    message: "Introduced Raj to Leo over email today",
    async check({ ids }) {
      const rows = [...(await interactionsFor(ids.raj)), ...(await interactionsFor(ids.leo))];
      const intro = rows.find((r) => r.type === "intro");
      if (!intro) return ["no intro interaction"];
      const other = intro.personId === ids.raj ? ids.leo : ids.raj;
      return intro.introducedPersonId === other ? [] : ["intro is not linked to the other person"];
    },
  },
  {
    id: "going-cold",
    message: "who's going cold?",
    async check({ reply }) {
      return /dana/i.test(reply) ? [] : [`reply doesn't mention Dana (cold): ${reply.slice(0, 160)}`];
    },
  },
  {
    id: "ambiguous-name",
    message: "Had lunch with Sam today",
    async check({ reply, userId }) {
      const rows = (await db().select().from(interactions).where(eq(interactions.userId, userId))).filter((r) => !seeded.has(r.id));
      const errs: string[] = [];
      if (rows.length) errs.push("logged an interaction without knowing which Sam");
      if (!reply.includes("?")) errs.push(`didn't ask which Sam: ${reply.slice(0, 160)}`);
      return errs;
    },
  },
];

/* ───────────── Fixture ───────────── */

export const EVAL_OWNER = "eval-owner";
export const EVAL_PHONE = "+14155550177";

/** Wipe the scratch database. Only ever run against a dedicated eval/test database. */
export async function resetEvalDb(): Promise<void> {
  await db().execute(
    sql`truncate table notification_log, thread_summaries, memory_facts, pending_actions, agent_actions, agent_turns, channel_messages, channel_bindings, follow_ups, reminders, interactions, person_tags, tags, people, user_settings restart identity cascade`,
  );
}

/** Seed the owner, a bound phone, and a small network with known health. */
export async function seedTurnFixture(): Promise<SeededPeople> {
  return runAsOwner(EVAL_OWNER, "eval", async () => {
    await updateSettings({ timezone: TURN_TZ, defaultCadences: {} });
    const priya = (await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"], company: "Halcyon Family Office", title: "Partner" })).id;
    const raj = (await createPerson({ fullName: "Raj Mehta", roles: ["founder"], company: "Acme Robotics", title: "CEO" })).id;
    const sarah = (await createPerson({ fullName: "Sarah Chen", roles: ["deal_source"], company: "Sequoia", title: "Scout" })).id;
    const leo = (await createPerson({ fullName: "Leo Park", roles: ["co_investor"], company: "Northstar Ventures", email: "leo@northstar.vc" })).id;
    const dana = (await createPerson({ fullName: "Dana Lee", roles: ["friend"] })).id;
    await createPerson({ fullName: "Sam Altmann", roles: ["founder"], company: "Orbit Labs" });
    await createPerson({ fullName: "Sam Rivera", roles: ["friend"] });
    const s1 = await logInteraction({ personId: dana, type: "call", summary: "Caught up about her move", occurredAt: new Date("2026-05-27T16:00:00Z") });
    const s2 = await logInteraction({ personId: raj, type: "meeting", summary: "Seed round planning", occurredAt: new Date("2026-09-01T16:00:00Z") });
    seeded = new Set([s1.id, s2.id]);
    const { code } = await createBindingCode(EVAL_OWNER, "eval", TURN_NOW);
    await redeemBindingCode(code, EVAL_PHONE, TURN_NOW);
    return { priya, raj, sarah, leo, dana, seededInteractions: [s1.id, s2.id] };
  });
}

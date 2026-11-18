import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executeToolCall, shortId, type ToolContext } from "@/agent/tools";
import { undoLastTurn } from "@/agent/undo";
import { getDb } from "@/db/client";
import { agentTurns, memoryFacts, people, reminders } from "@/db/schema";
import { logInteraction } from "@/server/actions/interactions";
import { createPerson } from "@/server/actions/people";
import { createReminder } from "@/server/actions/reminders";
import { runAsOwner } from "@/server/auth";
import { getPerson } from "@/server/queries/person";
import { actAs, resetDb, teardownDb } from "./helpers";
import { THURSDAY_11AM_NY } from "./agent-harness";

const OWNER = "owner-tools";

async function ctx(): Promise<ToolContext> {
  const [turn] = await getDb().insert(agentTurns).values({ userId: OWNER }).returning({ id: agentTurns.id });
  return { userId: OWNER, turnId: turn.id, sourceMessageId: "00000000-0000-0000-0000-000000000000", now: THURSDAY_11AM_NY, tz: "America/New_York" };
}

let n = 0;
async function call(name: string, args: Record<string, unknown>, c?: ToolContext) {
  const context = c ?? (await ctx());
  return runAsOwner(OWNER, "eval", () =>
    executeToolCall({ id: `t${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }, context),
  );
}

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
});
afterAll(teardownDb);

describe("ids", () => {
  it("accepts short handles and full UUIDs, and rejects other owners' ids", async () => {
    const { id } = await createPerson({ fullName: "Priya Patel" });
    expect((await call("get_person", { person_id: shortId(id) })).ok).toBe(true);
    expect((await call("get_person", { person_id: id })).ok).toBe(true);
    // Copying the handle with its brackets still works.
    expect((await call("get_person", { person_id: `[${shortId(id)}]` })).ok).toBe(true);
    actAs("someone-else");
    const other = await createPerson({ fullName: "Not Yours" });
    actAs(OWNER);
    const res = await call("get_person", { person_id: shortId(other.id) });
    expect(res).toMatchObject({ ok: false });
    expect(res.text).toMatch(/No person with id/);
  });
});

describe("find_people", () => {
  it("matches every term across name, company and tags, with a fallback to any term", async () => {
    await createPerson({ fullName: "Sarah Chen", company: "Sequoia", tags: ["scout"] });
    await createPerson({ fullName: "Sarah Kim", company: "Benchmark" });
    const both = await call("find_people", { query: "sarah sequoia" });
    expect(both.text).toMatch(/^1 match:\n- Sarah Chen/);
    const any = await call("find_people", { query: "sarah" });
    expect(any.text).toMatch(/^2 matches/);
    const none = await call("find_people", { query: "zzzz" });
    expect(none.text).toMatch(/No one matches "zzzz".*create_person/);
  });
});

describe("create_person and update_person", () => {
  it("refuses duplicates by name and applies role-based cadence", async () => {
    const created = await call("create_person", { full_name: "Tom Becker", roles: ["prospective_lp"], company: "Becker FO" });
    expect(created.text).toMatch(/^Created: Tom Becker \[[0-9a-f]{8}\] · Prospective LP · Becker FO · never contacted, every 21d$/);
    const [tom] = await getDb().select().from(people).where(eq(people.fullName, "Tom Becker"));
    expect(tom.cadenceDays).toBe(21);
    const dupe = await call("create_person", { full_name: "tom becker" });
    expect(dupe.ok).toBe(false);
    expect(dupe.text).toMatch(/already exists \[/);
  });

  it("changes only the given fields, keeps a custom cadence, and undo restores the profile", async () => {
    const { id } = await createPerson({ fullName: "Sarah Chen", company: "Sequoia", roles: ["deal_source"], cadenceDays: 10, tags: ["scout"] });
    const c = await ctx();
    const res = await call("update_person", { person_id: shortId(id), company: "Benchmark", add_tags: ["ai"] }, c);
    expect(res.ok).toBe(true);
    let p = await getPerson(id);
    expect(p).toMatchObject({ company: "Benchmark", cadenceDays: 10, roles: ["deal_source"] });
    expect(p?.tags.sort()).toEqual(["ai", "scout"]);
    await runAsOwner(OWNER, "eval", () => undoLastTurn(OWNER));
    p = await getPerson(id);
    expect(p).toMatchObject({ company: "Sequoia", cadenceDays: 10 });
    expect(p?.tags).toEqual(["scout"]);
  });
});

describe("log_interaction", () => {
  it("rejects future dates and past follow-up due dates with guidance", async () => {
    const { id } = await createPerson({ fullName: "Raj Mehta" });
    const future = await call("log_interaction", { person_id: shortId(id), type: "call", summary: "x", occurred_on: "2026-09-30" });
    expect(future.text).toMatch(/after today \(2026-09-24\).*most recent such day.*set_reminder/);
    const pastDue = await call("log_interaction", {
      person_id: shortId(id),
      type: "call",
      summary: "x",
      follow_ups: [{ description: "y", due_on: "2026-09-01" }],
    });
    expect(pastDue.text).toMatch(/in the past/);
  });

  it("records yesterday at local noon and links intros", async () => {
    const raj = await createPerson({ fullName: "Raj Mehta" });
    const leo = await createPerson({ fullName: "Leo Park" });
    const res = await call("log_interaction", {
      person_id: shortId(raj.id),
      type: "intro",
      summary: "Intro to Leo",
      occurred_on: "2026-09-23",
      introduced_person_id: shortId(leo.id),
    });
    expect(res.ok).toBe(true);
    const p = await getPerson(raj.id);
    expect(p?.timeline[0].occurredAt.toISOString()).toBe("2026-09-23T16:00:00.000Z");
    expect(p?.introsGiven).toBe(1);
  });
});

describe("follow-ups, reminders and LP stages", () => {
  it("add_follow_up defaults to a week out; complete_follow_up handles follow-ups and reminders", async () => {
    const { id } = await createPerson({ fullName: "Dana Lee" });
    const add = await call("add_follow_up", { person_id: shortId(id), description: "Ski trip plan" });
    expect(add.text).toMatch(/for 2026-10-01/);
    const [rem] = await getDb().select().from(reminders);
    expect((await call("complete_follow_up", { follow_up_id: shortId(rem.id) })).text).toBe("Done: Ski trip plan.");
    expect((await call("complete_follow_up", { follow_up_id: shortId(rem.id) })).text).toMatch(/already done/);

    const { id: iid } = await logInteraction({ personId: id, type: "call", summary: "c", followUps: [{ description: "Send photos" }] });
    const p = await getPerson(id);
    const fu = p!.timeline.find((t) => t.id === iid)!.followUps[0];
    expect((await call("complete_follow_up", { follow_up_id: shortId(fu.id) })).text).toBe("Done: Send photos.");
  });

  it("set_reminder refuses past dates", async () => {
    const { id } = await createPerson({ fullName: "Dana Lee" });
    expect((await call("set_reminder", { person_id: shortId(id), due_on: "2026-09-01", reason: "bday" })).text).toMatch(/in the past/);
    expect((await call("set_reminder", { person_id: shortId(id), due_on: "2026-10-08", reason: "bday" })).ok).toBe(true);
  });

  it("set_lp_stage records the commitment, adds LP roles, and undo restores the previous state", async () => {
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["friend"] });
    const res = await call("set_lp_stage", { person_id: shortId(id), stage: "soft_commit", commitment_usd: 250000 });
    expect(res.text).toBe("Priya Patel is now at LP stage Soft commit at $250,000.");
    let p = await getPerson(id);
    expect(p).toMatchObject({ lpStage: "soft_commit", lpCommitmentUsd: 250000 });
    expect(p?.roles).toEqual(["friend", "prospective_lp"]);
    await runAsOwner(OWNER, "eval", () => undoLastTurn(OWNER));
    p = await getPerson(id);
    expect(p).toMatchObject({ lpStage: null, lpCommitmentUsd: null, roles: ["friend"] });
  });
});

describe("remember", () => {
  it("stores facts with provenance, shows them in the dossier, and undo invalidates instead of deleting", async () => {
    const { id } = await createPerson({ fullName: "Raj Mehta" });
    const c = await ctx();
    await call("remember", { person_id: shortId(id), fact: "Hates phone calls; text only" }, c);
    await call("remember", { fact: "Owner is raising Fund I, $25M target" }, c);
    const facts = await getDb().select().from(memoryFacts);
    expect(facts).toHaveLength(2);
    expect(facts.every((f) => f.sourceKind === "message" && f.sourceId === c.sourceMessageId)).toBe(true);
    expect((await call("get_person", { person_id: shortId(id) })).text).toContain("Known facts:\n- Hates phone calls; text only");
    await runAsOwner(OWNER, "eval", () => undoLastTurn(OWNER));
    const after = await getDb().select().from(memoryFacts);
    expect(after).toHaveLength(2);
    expect(after.every((f) => f.validTo !== null)).toBe(true);
    expect((await call("get_person", { person_id: shortId(id) })).text).not.toContain("Known facts");
  });
});

describe("whats_due", () => {
  it("lists attention, follow-ups and reminders, filtered to today on request", async () => {
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    await runAsOwner(OWNER, "eval", () => createReminder({ personId: id, dueAt: new Date("2026-09-27T13:00:00Z"), reason: "Check in" }));
    const week = await call("whats_due", { scope: "week" });
    expect(week.text).toMatch(/Needs attention \(1/);
    expect(week.text).toMatch(/Check in → Priya Patel \(2026-09-27\)/);
    const today = await call("whats_due", { scope: "today" });
    expect(today.text).not.toMatch(/Check in/);
  });
});

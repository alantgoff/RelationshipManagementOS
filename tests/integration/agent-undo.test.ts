import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBindingCode } from "@/agent/store";
import { executeToolCall, shortId, toPersonInput, type ToolContext } from "@/agent/tools";
import { UNDO_WINDOW_MS } from "@/agent/undo";
import { getDb } from "@/db/client";
import { agentActions, agentTurns, interactions, pendingActions, people, reminders } from "@/db/schema";
import { logInteraction } from "@/server/actions/interactions";
import { createPerson, setLpStage, updatePerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { runAsOwner } from "@/server/auth";
import { getPerson } from "@/server/queries/person";
import type { PersonInput } from "@/server/validation";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, makeDeps, say, scriptedModel, text, THURSDAY_11AM_NY, toolCall } from "./agent-harness";

/**
 * `undo` and `why` after the hardening pass (findings 9, 27, 28 and 36):
 * undo restores only what the agent changed and never clobbers later edits,
 * a failed step stays undoable without letting a retry reach an older turn,
 * changes older than a day are refused, and `why` explains the latest turn
 * even when it used no tools.
 */

const OWNER = "owner-undo";
const TZ = "America/New_York";
const NO_RECORDS = "My last reply didn't read or change any of your records; it came from our conversation and the context I keep.";
const LEO_BODY = "Subject: Acme\nHey Leo, want to co-invest in Acme's seed?";

type Step = Parameters<typeof scriptedModel>[0][number];

/** Bind the owner on a fake line. `send` texts the agent and returns every message it sent back. */
async function connect(steps: Step[] = []) {
  const line = new FakeLine();
  const model = scriptedModel(steps);
  const deps = makeDeps(line, model.llm);
  const { code } = await createBindingCode(OWNER, "test", deps.now());
  expect((await text(deps, code)).status).toBe("bound");
  const send = async (body: string): Promise<string[]> => {
    const before = line.sent.length;
    await text(deps, body);
    return line.texts().slice(before);
  };
  return { line, model, send };
}

/** A new agent turn, as runTurn records it, so tools can be called directly. */
async function newTurn(): Promise<ToolContext> {
  const [t] = await getDb().insert(agentTurns).values({ userId: OWNER, steps: 1 }).returning({ id: agentTurns.id });
  return { userId: OWNER, turnId: t.id, sourceMessageId: "00000000-0000-0000-0000-000000000000", now: THURSDAY_11AM_NY, tz: TZ };
}

let n = 0;
/** Run one successful tool call as the agent, in its own turn unless one is given. */
async function tool(name: string, args: Record<string, unknown>, ctx?: ToolContext) {
  const c = ctx ?? (await newTurn());
  const out = await runAsOwner(OWNER, "eval", () =>
    executeToolCall({ id: `undo_${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }, c),
  );
  expect(out.ok, out.text).toBe(true);
  return out;
}

/** The owner saves the profile form in the web app with some fields changed. */
async function webEdit(id: string, change: Partial<PersonInput>) {
  const p = await getPerson(id);
  await updatePerson(id, { ...toPersonInput(p!), ...change });
}

const actions = () => getDb().select().from(agentActions).orderBy(agentActions.createdAt);
const personRow = async (id: string) => (await getDb().select().from(people).where(eq(people.id, id)))[0];

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
  await updateSettings({ timezone: TZ, defaultCadences: {} });
});
afterAll(teardownDb);

describe("undo of update_person (finding 9)", () => {
  const priya = () =>
    createPerson({ fullName: "Priya Patel", company: "Halcyon", title: "Partner", notes: "Met at SaaStr", roles: ["prospective_lp"], tags: ["fund-i"] });

  it("records only the changed fields and restores just those, keeping the owner's later edits to the rest", async () => {
    const { send } = await connect();
    const { id } = await priya();
    await tool("update_person", { person_id: shortId(id), company: "Halcyon Capital", title: "Managing Partner" });
    const [a] = await actions();
    expect(a.undo).toEqual({
      kind: "restore_person_fields",
      id,
      before: { company: "Halcyon", title: "Partner" },
      after: { company: "Halcyon Capital", title: "Managing Partner" },
    });

    // Later, in the web app, the owner rewrites the notes and adds a tag.
    await webEdit(id, { notes: "Prefers early mornings", tags: ["fund-i", "warm"] });
    expect(await send("undo")).toEqual(["Undid: Updated Priya Patel (company, title)."]);

    const p = await getPerson(id);
    expect(p).toMatchObject({ company: "Halcyon", title: "Partner", notes: "Prefers early mornings", roles: ["prospective_lp"], cadenceDays: 21 });
    expect(p?.tags).toEqual(["fund-i", "warm"]);
    expect((await actions())[0].undoneAt).not.toBeNull();
  });

  it("leaves a field the owner changed since, says so, and still restores the others", async () => {
    const { send } = await connect();
    const { id } = await priya();
    await tool("update_person", { person_id: shortId(id), company: "Halcyon Capital", title: "Managing Partner" });
    await webEdit(id, { title: "General Partner" });

    expect(await send("undo")).toEqual([
      "Undid: Updated Priya Patel (company, title). Note: Updated Priya Patel (company, title): left title alone because it changed since.",
    ]);
    expect(await getPerson(id)).toMatchObject({ company: "Halcyon", title: "General Partner", notes: "Met at SaaStr" });
    // The turn is done with: nothing older is waiting.
    expect(await send("undo")).toEqual(["There's nothing to undo."]);
  });
});

describe("undo of set_lp_stage (finding 9)", () => {
  const SUMMARY = "Priya Patel: LP stage First meeting → Soft commit at $250,000";

  it("restores the previous stage and commitment", async () => {
    const { send } = await connect();
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"], lpStage: "first_meeting" });
    const out = await tool("set_lp_stage", { person_id: shortId(id), stage: "soft_commit", commitment_usd: 250000 });
    expect(out.summary).toBe(SUMMARY);
    expect(await personRow(id)).toMatchObject({ lpStage: "soft_commit", lpCommitmentUsd: 250000 });

    expect(await send("undo")).toEqual([`Undid: ${SUMMARY}.`]);
    expect(await personRow(id)).toMatchObject({ lpStage: "first_meeting", lpCommitmentUsd: null, roles: ["prospective_lp"] });
  });

  it("is skipped, with a note, when the owner moved the stage since", async () => {
    const { send } = await connect();
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"], lpStage: "first_meeting" });
    await tool("set_lp_stage", { person_id: shortId(id), stage: "soft_commit", commitment_usd: 250000 });
    await setLpStage(id, "committed", 500000);

    expect(await send("undo")).toEqual([`Undid: ${SUMMARY}. Note: ${SUMMARY}: left the LP stage alone because it changed since.`]);
    expect(await personRow(id)).toMatchObject({ lpStage: "committed", lpCommitmentUsd: 500000, roles: ["prospective_lp", "committed_lp"] });
  });

  it("keeps a role the owner added after the turn", async () => {
    const { send } = await connect();
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["friend"] });
    await tool("set_lp_stage", { person_id: shortId(id), stage: "soft_commit", commitment_usd: 250000 });
    expect((await personRow(id)).roles).toEqual(["friend", "prospective_lp"]);
    // The stage and commitment are untouched; only the roles were edited in the web app.
    await webEdit(id, { roles: ["friend", "prospective_lp", "co_investor"] });

    await send("undo");
    const row = await personRow(id);
    expect(row).toMatchObject({ lpStage: null, lpCommitmentUsd: null });
    expect(row.roles).toContain("co_investor");
  });
});

describe("undo of create_person (finding 9)", () => {
  const tomId = async () => (await getDb().select({ id: people.id }).from(people).where(eq(people.fullName, "Tom Becker")))[0].id;

  it("deletes a person the agent added when they have no history", async () => {
    const { send } = await connect();
    await tool("create_person", { full_name: "Tom Becker", roles: ["prospective_lp"] });
    expect(await getDb().select().from(people)).toHaveLength(1);
    expect(await send("undo")).toEqual(["Undid: Added Tom Becker."]);
    expect(await getDb().select().from(people)).toHaveLength(0);
  });

  it("archives instead of deleting once they gained history, which stays intact", async () => {
    const { send } = await connect();
    await tool("create_person", { full_name: "Tom Becker", roles: ["prospective_lp"] });
    const tom = await tomId();
    await tool("log_interaction", { person_id: shortId(tom), type: "meeting", summary: "Intro coffee" });
    // Meanwhile the owner logs a call with Tom in the web app.
    await logInteraction({ personId: tom, type: "call", summary: "Quick call about Fund I" });

    // Newest turn first: the agent's meeting goes, the owner's call stays.
    expect(await send("undo")).toEqual(["Undid: Logged meeting with Tom Becker: Intro coffee."]);
    expect(await send("undo")).toEqual([
      "Undid: Added Tom Becker. Note: Added Tom Becker: archived them instead of deleting, since they have history now.",
    ]);
    const row = await personRow(tom);
    expect(row.archivedAt).not.toBeNull();
    const left = await getDb().select().from(interactions);
    expect(left.map((i) => [i.personId, i.summary])).toEqual([[tom, "Quick call about Fund I"]]);
    expect(await send("undo")).toEqual(["There's nothing to undo."]);
  });

  it("archives instead of deleting once someone was introduced to them", async () => {
    const { send } = await connect();
    const priya = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    await tool("create_person", { full_name: "Tom Becker", roles: ["prospective_lp"] });
    const tom = await tomId();
    // The owner logs, in the web app, that Priya introduced them to Tom.
    const intro = await logInteraction({ personId: priya.id, type: "intro", summary: "Priya introduced Tom", introducedPersonId: tom });

    await send("undo");
    const row = await personRow(tom);
    expect(row).toBeDefined();
    expect(row.archivedAt).not.toBeNull();
    const [i] = await getDb().select().from(interactions).where(eq(interactions.id, intro.id));
    expect(i.introducedPersonId).toBe(tom);
  });
});

describe("a step that fails to undo (finding 27)", () => {
  it("is reported and stays undoable, and retrying never reverts an older, unrelated turn", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { send } = await connect();
      const { id } = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
      // An older turn the owner is happy with.
      await tool("log_interaction", { person_id: shortId(id), type: "call", summary: "Quick call" });
      // The newer turn: one step that undoes cleanly, and one whose undo throws.
      const newer = await newTurn();
      await tool("add_follow_up", { person_id: shortId(id), description: "Send the deck", due_on: "2026-10-01" }, newer);
      await getDb()
        .insert(agentActions)
        .values({ userId: OWNER, turnId: newer.turnId, tool: "complete_follow_up", input: {}, ok: true, summary: "Completed: Send the memo", undo: { kind: "reopen_follow_up", id: "not-a-uuid" } });

      expect(await send("undo")).toEqual([
        `Undid: Follow-up for 2026-10-01: Send the deck. Couldn't undo: Completed: Send the memo. Text "undo" again to retry.`,
      ]);
      expect(await getDb().select().from(reminders)).toHaveLength(0);
      expect(errors).toHaveBeenCalledWith("[agent] undo failed", expect.any(String), expect.anything());

      // The retry tries the failed step again, and only that step.
      expect(await send("undo")).toEqual([`Couldn't undo: Completed: Send the memo. Text "undo" again to retry.`]);
      const calls = await getDb().select().from(interactions);
      expect(calls.map((i) => i.summary)).toEqual(["Quick call"]);
      expect((await actions()).map((a) => [a.tool, a.undoneAt !== null])).toEqual([
        ["log_interaction", false],
        ["add_follow_up", true],
        ["complete_follow_up", false],
      ]);

      // `why` doesn't claim the failed step was undone.
      expect(await send("why")).toEqual(["My last answer was based on:\n- Follow-up for 2026-10-01: Send the deck (undone)\n- Completed: Send the memo"]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the undo window", () => {
  it("refuses changes older than 24 hours and leaves them in place", async () => {
    const { send } = await connect();
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    await tool("log_interaction", { person_id: shortId(id), type: "call", summary: "Quick call" });

    await getDb().update(agentActions).set({ createdAt: new Date(Date.now() - UNDO_WINDOW_MS - 60_000) });
    expect(await send("undo")).toEqual(["My last change was more than a day ago, so I won't undo it by text. You can edit it in the app."]);
    expect(await getDb().select().from(interactions)).toHaveLength(1);
    expect((await actions())[0].undoneAt).toBeNull();

    // Just inside the window, the same change is undone.
    await getDb().update(agentActions).set({ createdAt: new Date(Date.now() - UNDO_WINDOW_MS + 60_000) });
    expect(await send("undo")).toEqual(["Undid: Logged call with Priya Patel: Quick call."]);
    expect(await getDb().select().from(interactions)).toHaveLength(0);
  });
});

describe("why (findings 28 and 36)", () => {
  it("after a reply that used no tools, says so instead of describing an older turn", async () => {
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const { send, model } = await connect([
      toolCall("log_interaction", { person_id: shortId(id), type: "call", summary: "Quick call" }),
      say("Logged your call with Priya."),
      say("You last talked to Priya today, on the call."),
    ]);
    expect(await send("called Priya")).toEqual(["Logged your call with Priya."]);
    expect(await send("why")).toEqual(["My last answer was based on:\n- Logged call with Priya Patel: Quick call"]);

    expect(await send("when did I last talk to Priya?")).toEqual(["You last talked to Priya today, on the call."]);
    const why = await send("why");
    expect(why).toEqual([NO_RECORDS]);
    expect(why[0]).not.toContain("Logged call");
    expect(await getDb().select().from(agentTurns)).toHaveLength(2);

    // undo still reaches the latest turn that changed something.
    expect(await send("undo")).toEqual(["Undid: Logged call with Priya Patel: Quick call."]);
    expect(await getDb().select().from(interactions)).toHaveLength(0);
    expect(model.remaining()).toBe(0);
  });
});

describe("undo of an approved draft", () => {
  it("removes the logged interaction and puts the draft back to pending", async () => {
    const leo = await createPerson({ fullName: "Leo Park", roles: ["co_investor"], email: "leo@northstar.vc" });
    const { send, model } = await connect([
      toolCall("draft_message", { person_id: shortId(leo.id), channel: "email", intent: "Co-invest in Acme", body: LEO_BODY }),
      say("Drafted an email to Leo about Acme. Reply 👍 once you've sent it."),
    ]);
    expect(await send("Draft a note to Leo about co-investing in Acme")).toEqual([
      "Drafted an email to Leo about Acme. Reply 👍 once you've sent it.",
      LEO_BODY,
    ]);
    expect(await send("👍")).toEqual(["Logged as sent to Leo Park."]);
    expect(await getDb().select().from(interactions)).toHaveLength(1);

    expect(await send("undo")).toEqual(["Undid: Logged the email you sent to Leo Park."]);
    expect(await getDb().select().from(interactions)).toHaveLength(0);
    const [d] = await getDb().select().from(pendingActions);
    expect(d).toMatchObject({ status: "pending", resolvedAt: null });
    expect((await actions()).map((a) => [a.tool, a.undoneAt !== null])).toEqual([
      ["draft_message", false],
      ["approve_draft", true],
    ]);
    expect(await send("why")).toEqual(["My last answer was based on:\n- Logged the email you sent to Leo Park (undone)"]);

    // The draft can be approved again (a tapback on it; a bare 👍 now would answer "why").
    expect(await send("Liked “Hey Leo, want to co-invest”")).toEqual(["Logged as sent to Leo Park."]);
    const [i] = await getDb().select().from(interactions);
    expect(i).toMatchObject({ personId: leo.id, type: "email", summary: "Sent: Hey Leo, want to co-invest in Acme's seed?" });
    expect((await getDb().select().from(pendingActions))[0].status).toBe("approved");
    expect(model.remaining()).toBe(0);
  });
});

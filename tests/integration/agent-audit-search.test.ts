import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBindingCode } from "@/agent/store";
import { executeToolCall, shortId, type ToolContext } from "@/agent/tools";
import { getDb } from "@/db/client";
import { agentActions, agentTurns, channelMessages, memoryFacts, pendingActions } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { runAsOwner } from "@/server/auth";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, makeDeps, say, scriptedModel, text, THURSDAY_11AM_NY, toolCall } from "./agent-harness";

/**
 * Regression tests for eb6fdd7: audit rows never keep draft text or long free
 * text from bad calls, `why` explains the brief, find_people only matches word
 * prefixes, recall says when older facts are hidden, and migration 0003 closes
 * stale inbound rows and scrubs draft bodies from old audit rows.
 */

const OWNER = "owner-audit-search";
const NY = "America/New_York";
const SECRET =
  "Hey Leo, between us: Halcyon is wiring $2M on Friday and the Acme round is oversubscribed, so please keep this quiet until the close.";
const BRIEF_WHY =
  "My last message was your brief: it comes straight from your records (follow-ups and reminders due, and who's going cold) and didn't change anything.";
const hidden = (s: string) => `[${s.length} characters, not stored]`;

async function newTurn(): Promise<ToolContext> {
  const [t] = await getDb().insert(agentTurns).values({ userId: OWNER, steps: 1 }).returning({ id: agentTurns.id });
  return { userId: OWNER, turnId: t.id, sourceMessageId: "00000000-0000-0000-0000-000000000000", now: THURSDAY_11AM_NY, tz: NY };
}

let n = 0;
/** Run one tool call as the agent in a fresh turn; return its outcome and the audit row it wrote. */
async function audited(name: string, args: Record<string, unknown>) {
  const ctx = await newTurn();
  const outcome = await runAsOwner(OWNER, "eval", () =>
    executeToolCall({ id: `aud_${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }, ctx),
  );
  const rows = await getDb().select().from(agentActions).where(eq(agentActions.turnId, ctx.turnId));
  expect(rows).toHaveLength(1);
  return { outcome, row: rows[0] };
}

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
  await updateSettings({ timezone: NY, defaultCadences: {} });
});
afterAll(teardownDb);

describe("audit rows keep no draft text or long free text", () => {
  it("a draft_message with a mis-named body field fails validation and its text is not stored", async () => {
    const leo = await createPerson({ fullName: "Leo Park", roles: ["co_investor"], email: "leo@northstar.vc" });
    const args = { person_id: shortId(leo.id), channel: "email", intent: "Co-invest in Acme", message: SECRET };
    const { outcome, row } = await audited("draft_message", args);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^Invalid arguments for draft_message: body: /);
    expect(row).toMatchObject({ tool: "draft_message", ok: false });
    // A call that failed validation keeps only ids and enums: free text may sit under any key.
    expect(row.input).toEqual({ person_id: shortId(leo.id), channel: "email", intent: hidden("Co-invest in Acme"), message: hidden(SECRET) });
    expect(JSON.stringify(row.input)).not.toContain("oversubscribed");
    expect(await getDb().select().from(pendingActions)).toHaveLength(0);
  });

  it("a draft_message that fails validation for another reason never keeps even a short body", async () => {
    const leo = await createPerson({ fullName: "Leo Park", roles: ["co_investor"], email: "leo@northstar.vc" });
    const body = "Hey Leo, great seeing you, deck Friday!";
    const { outcome, row } = await audited("draft_message", { person_id: shortId(leo.id), channel: "sms", intent: "thank", body });
    expect(outcome.ok).toBe(false);
    expect(row.input).toEqual({ person_id: shortId(leo.id), channel: "sms", intent: "thank", body: hidden(body) });
    expect(JSON.stringify(row.input)).not.toContain("great seeing you");
  });

  it("an unknown tool keeps only short scalars: the body and nested values are not stored", async () => {
    const args = { to: "leo@northstar.vc", subject: "Fund I", body: SECRET, cc: ["sam@halcyon.vc"], urgent: true };
    const { outcome, row } = await audited("send_email", args);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^Unknown tool "send_email"/);
    expect(row).toMatchObject({ tool: "send_email", ok: false });
    expect(row.input).toEqual({ to: "leo@northstar.vc", subject: hidden("Fund I"), body: hidden(SECRET), cc: "[not stored]", urgent: true });
    expect(JSON.stringify(row.input)).not.toContain("oversubscribed");
  });

  it("a valid draft_message keeps person, channel and a short intent, and never the body (even a short one)", async () => {
    const leo = await createPerson({ fullName: "Leo Park", roles: ["co_investor"] });
    const body = "Congrats on the launch, Leo!";
    const { outcome, row } = await audited("draft_message", { person_id: shortId(leo.id), channel: "imessage", intent: "Congratulate on the launch", body });
    expect(outcome.ok, outcome.text).toBe(true);
    expect(row.input).toEqual({ person_id: shortId(leo.id), channel: "imessage", intent: "Congratulate on the launch", body: hidden(body) });
    // The body lives only in encrypted storage.
    const [draft] = await getDb().select().from(pendingActions);
    expect(draft.bodyEnc).not.toContain("Congrats");
    expect(decrypt(draft.bodyEnc)).toBe(body);
  });

  it("a valid draft_message with an intent over 80 characters stores only its length", async () => {
    const leo = await createPerson({ fullName: "Leo Park", roles: ["co_investor"] });
    const intent = "Tell Leo confidentially that Halcyon is wiring two million on Friday and the round is nearly closed";
    expect(intent.length).toBeGreaterThan(80);
    const { outcome, row } = await audited("draft_message", { person_id: shortId(leo.id), channel: "email", intent, body: SECRET });
    expect(outcome.ok, outcome.text).toBe(true);
    expect(row.input).toEqual({ person_id: shortId(leo.id), channel: "email", intent: hidden(intent), body: hidden(SECRET) });
    expect(JSON.stringify(row.input)).not.toMatch(/Halcyon|oversubscribed/);
  });

  it("a valid draft_message does not keep long draft text the model put under an extra key", async () => {
    const leo = await createPerson({ fullName: "Leo Park", roles: ["co_investor"] });
    const args = { person_id: shortId(leo.id), channel: "email", intent: "Co-invest in Acme", body: "Hi Leo, want in on Acme?", alternatives: [SECRET] };
    const { outcome, row } = await audited("draft_message", args);
    expect(outcome.ok, outcome.text).toBe(true);
    expect(JSON.stringify(row.input)).not.toContain("oversubscribed");
  });

  it("other valid tools are stored as called, long notes and nested follow-ups included", async () => {
    const priya = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const notes = "She asked for the Fund I deck, the track record appendix, and a reference call with one of the existing LPs.";
    expect(notes.length).toBeGreaterThan(80);
    const args = {
      person_id: shortId(priya.id),
      type: "meeting",
      summary: "Coffee at Blue Bottle",
      notes,
      follow_ups: [{ description: "Send the Fund I deck", due_on: "2026-09-25" }],
    };
    const { outcome, row } = await audited("log_interaction", args);
    expect(outcome.ok, outcome.text).toBe(true);
    expect(row).toMatchObject({ tool: "log_interaction", ok: true, input: args });
  });
});

describe("why after the brief", () => {
  async function connect(steps: Parameters<typeof scriptedModel>[0]) {
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

  it("says the last message was the brief, then describes the next turn again", async () => {
    const priya = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const id = shortId(priya.id);
    const { model, send } = await connect([
      toolCall("remember", { person_id: id, fact: "Prefers morning calls" }),
      say("Noted: Priya prefers morning calls."),
      say("Morning! Priya Patel has never heard from you; ask how her week is going."),
      toolCall("log_interaction", { person_id: id, type: "call", summary: "Quick call" }),
      say("Logged your call with Priya."),
    ]);
    expect(await send("Priya prefers morning calls")).toEqual(["Noted: Priya prefers morning calls."]);
    expect(await send("why")).toEqual(["My last answer was based on:\n- Remembered about Priya Patel: Prefers morning calls"]);

    expect(await send("brief")).toEqual(["Morning! Priya Patel has never heard from you; ask how her week is going."]);
    // The brief was composed by the model from the records, not by a turn.
    expect(String(model.requests[2].messages[0].content)).toMatch(/morning brief/);
    expect(await getDb().select().from(agentTurns)).toHaveLength(1);

    const why = await send("why");
    expect(why).toEqual([BRIEF_WHY]);
    expect(why[0]).not.toContain("Remembered");

    expect(await send("called Priya")).toEqual(["Logged your call with Priya."]);
    expect(await send("why")).toEqual(["My last answer was based on:\n- Logged call with Priya Patel: Quick call"]);
    expect(model.remaining()).toBe(0);
  });

  it("a brief that was never delivered is not passed off as the last message", async () => {
    const priya = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const { line, send } = await connect([
      toolCall("remember", { person_id: shortId(priya.id), fact: "Prefers morning calls" }),
      say("Noted: Priya prefers morning calls."),
      say("Morning! Priya Patel has never heard from you; ask how her week is going."),
    ]);
    expect(await send("Priya prefers morning calls")).toEqual(["Noted: Priya prefers morning calls."]);
    line.fail = true;
    expect(await send("brief")).toEqual([]);
    line.fail = false;
    const briefs = (await getDb().select().from(channelMessages)).filter((m) => m.kind === "brief");
    expect(briefs.map((b) => b.error)).toEqual(["not delivered"]);
    expect(await send("why")).toEqual(["My last answer was based on:\n- Remembered about Priya Patel: Prefers morning calls"]);
  });
});

describe("find_people matches word prefixes only", () => {
  const find = async (query: string) => {
    const { outcome } = await audited("find_people", { query });
    expect(outcome.ok, outcome.text).toBe(true);
    return outcome.text;
  };

  it("says there is no exact match for a name that only appears inside other words", async () => {
    await createPerson({ fullName: "Mike Rivera", title: "Managing Partner" });
    await createPerson({ fullName: "Diana Rivera" });
    await createPerson({ fullName: "Priya Patel", company: "Halcyon", email: "priya@acme.com" });

    const anaRivera = await find("Ana Rivera");
    expect(anaRivera).toMatch(/^No exact match for "Ana Rivera"\. Partial matches on "rivera" only:\n- Diana Rivera \[[0-9a-f]{8}\]/);
    expect(anaRivera).toContain("\n- Mike Rivera [");
    expect(anaRivera).toMatch(/it may be someone new: confirm with the owner, then create_person\.$/);
    expect(anaRivera).not.toMatch(/^\d+ match/);

    const ana = await find("ana");
    expect(ana).toMatch(/^No exact match for "ana"\. Partial matches on "ana" only:\n/);
    expect(ana).toContain("- Diana Rivera [");
    expect(ana).not.toMatch(/^\d+ match/);

    expect(await find("Mike Rivera")).toMatch(/^1 match:\n- Mike Rivera \[[0-9a-f]{8}\] · Managing Partner · no cadence, never contacted$/);
    expect(await find("rivera")).toMatch(/^2 matches:\n- Diana Rivera \[[0-9a-f]{8}\][^\n]*\n- Mike Rivera \[/);
    // An email is split into words, so its domain matches.
    expect(await find("acme")).toMatch(/^1 match:\n- Priya Patel \[[0-9a-f]{8}\] · Halcyon/);

    // Once Ana exists, the same query finds only her.
    await createPerson({ fullName: "Ana Rivera" });
    const exact = await find("Ana Rivera");
    expect(exact).toMatch(/^1 match:\n- Ana Rivera \[[0-9a-f]{8}\]/);
    expect(exact).not.toContain("Diana");
  });
});

describe("recall shows the newest 20 facts and says when older ones exist", () => {
  const recall = async (args: Record<string, unknown>) => {
    const { outcome } = await audited("recall", args);
    expect(outcome.ok, outcome.text).toBe(true);
    return outcome.text;
  };
  const OLDER_NOTE = "…and older facts not shown; recall again with a query to search them.";

  /** Owner facts noted `days` days ago, one per day. */
  async function seedFacts(days: number[], fact: (d: number) => string) {
    await getDb()
      .insert(memoryFacts)
      .values(days.map((d) => ({ userId: OWNER, fact: fact(d), sourceKind: "message", createdAt: new Date(Date.now() - d * 86_400_000) })));
  }

  it("lists exactly 20 with no note, then 20 of 25 with the note, and a query finds an old one", async () => {
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    await seedFacts(range(1, 20), (d) => `Owner fact from ${d} days ago`);
    const twenty = await recall({});
    expect(twenty.split("\n").filter((l) => l.startsWith("- Owner: "))).toHaveLength(20);
    expect(twenty).not.toContain("older facts not shown");

    await seedFacts(range(21, 24), (d) => `Owner fact from ${d} days ago`);
    await seedFacts([25], () => "Daughter goes to Lakeside School");
    const all = await recall({});
    const lines = all.split("\n").filter((l) => l.startsWith("- Owner: "));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toMatch(/^- Owner: Owner fact from 1 days ago \(noted \d{4}-\d{2}-\d{2}\)$/);
    expect(lines[19]).toMatch(/^- Owner: Owner fact from 20 days ago /);
    expect(all).not.toContain("21 days ago");
    expect(all).not.toContain("Lakeside");
    expect(all.endsWith(`\n${OLDER_NOTE}`)).toBe(true);

    const found = await recall({ query: "lakeside" });
    expect(found).toMatch(/^Remembered facts, newest first:\n- Owner: Daughter goes to Lakeside School \(noted /);
    expect(found).not.toContain("older facts not shown");
  });
});

describe("migration 0003", () => {
  const MIGRATION = fileURLToPath(new URL("../../src/db/migrations/0003_agent_queue_fixes.sql", import.meta.url));

  /** The data statements of the migration (the column it adds already exists here). */
  async function runMigrationUpdates() {
    const statements = readFileSync(MIGRATION, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s && !/^ALTER TABLE/im.test(s));
    expect(statements).toHaveLength(2);
    for (const s of statements) await getDb().execute(sql.raw(s));
  }

  async function message(direction: "in" | "out", minutesAgo: number, processedAt: Date | null = null) {
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);
    const [r] = await getDb()
      .insert(channelMessages)
      .values({ userId: OWNER, provider: "test", providerMessageId: `mig-${direction}-${minutesAgo}`, direction, bodyEnc: encrypt("hi"), readyAt: createdAt, processedAt, createdAt })
      .returning({ id: channelMessages.id, createdAt: channelMessages.createdAt });
    return r;
  }

  async function auditRow(tool: string, input: Record<string, unknown>) {
    const ctx = await newTurn();
    const [r] = await getDb().insert(agentActions).values({ userId: OWNER, turnId: ctx.turnId, tool, input, ok: true, summary: tool }).returning({ id: agentActions.id });
    return r.id;
  }

  const inputOf = async (id: string) => (await getDb().select().from(agentActions).where(eq(agentActions.id, id)))[0].input;

  it("closes only stale unprocessed inbound rows and scrubs draft bodies from old audit rows", async () => {
    const stale = await message("in", 60);
    const fresh = await message("in", 0);
    const oldOut = await message("out", 60);
    const handledAt = new Date(Date.now() - 50 * 60_000);
    const handled = await message("in", 55, handledAt);
    const draft = await auditRow("draft_message", { person_id: "abcd1234", channel: "email", intent: "Co-invest", body: SECRET });
    const logged = await auditRow("log_interaction", { person_id: "abcd1234", type: "call", summary: "Quick call" });

    await runMigrationUpdates();

    const rows = await getDb().select().from(channelMessages).orderBy(asc(channelMessages.createdAt));
    const byId = new Map(rows.map((r) => [r.id, r.processedAt?.getTime() ?? null]));
    expect(byId.get(stale.id)).toBe(stale.createdAt.getTime());
    expect(byId.get(fresh.id)).toBeNull();
    expect(byId.get(oldOut.id)).toBeNull();
    expect(byId.get(handled.id)).toBe(handledAt.getTime());

    expect(await inputOf(draft)).toEqual({ person_id: "abcd1234", channel: "email", intent: "Co-invest", body: "[redacted]" });
    expect(await inputOf(logged)).toEqual({ person_id: "abcd1234", type: "call", summary: "Quick call" });
  });

  it("also scrubs a draft body an earlier version stored under a mis-named key", async () => {
    // Before eb6fdd7, a draft_message that failed validation was audited exactly as called.
    const misnamed = await auditRow("draft_message", { person_id: "abcd1234", channel: "email", intent: "Co-invest", message: SECRET });
    await runMigrationUpdates();
    expect(JSON.stringify(await inputOf(misnamed))).not.toContain("oversubscribed");
  });
});

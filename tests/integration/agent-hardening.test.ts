import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatherBriefData } from "@/agent/brief";
import { ownerFacts } from "@/agent/context";
import { AGENT_SYSTEM_PROMPT } from "@/agent/prompt";
import {
  conversationSince,
  countConversationSince,
  createBindingCode,
  getBinding,
  MAX_FAILURES_GLOBAL,
  MAX_FAILURES_PER_PHONE,
} from "@/agent/store";
import { runBriefTick } from "@/agent/tick";
import { capToolText, MAX_TOOL_TEXT } from "@/agent/tool-kit";
import { validateToolInput } from "@/agent/tool-specs";
import { executeToolCall, shortId, type ToolContext } from "@/agent/tools";
import { getDb } from "@/db/client";
import { agentTurns, bindingFailures, channelBindings, channelMessages, memoryFacts, notificationLog, reminders } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { zonedTimeToUtc } from "@/lib/time";
import { logInteraction } from "@/server/actions/interactions";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { runAsOwner } from "@/server/auth";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, inbound, makeDeps, OWNER_PHONE, say, scriptedModel, text, THURSDAY_11AM_NY } from "./agent-harness";

/**
 * Regression tests for the M1 review findings 14, 15, 16, 20, 24, 30, 31, 32,
 * 34, 39, 41 and 42. Each would fail on the pre-hardening behavior.
 */

// Finding 32: one owner's settings can't be read. Only this owner is affected; every other test uses other ids.
vi.mock("@/agent/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agent/store")>();
  return {
    ...actual,
    getAgentPrefs: async (userId: string) => {
      if (userId === "owner-tick-broken") throw new Error("settings row unreadable");
      return actual.getAgentPrefs(userId);
    },
  };
});

const OWNER = "owner-hardening";
const BROKEN = "owner-tick-broken";
const NY = "America/New_York";
/** Thursday 2026-09-24, 07:35 in New York: inside the brief window. */
const THU_0735 = new Date("2026-09-24T11:35:00Z");
const CUT_NOTE = "\n…(output cut to fit; narrow the request to see more)";

async function bindOwner(deps: ReturnType<typeof makeDeps>, userId = OWNER, phone = OWNER_PHONE) {
  const { code } = await createBindingCode(userId, "test", deps.now());
  const r = await text(deps, inbound(code, { from: phone }));
  expect(r.status).toBe("bound");
}

async function ownerWithSettings(userId = OWNER) {
  actAs(userId);
  await updateSettings({ timezone: NY, defaultCadences: {} });
}

let callN = 0;
async function call(name: string, args: Record<string, unknown>) {
  const [turn] = await getDb().insert(agentTurns).values({ userId: OWNER }).returning({ id: agentTurns.id });
  const ctx: ToolContext = { userId: OWNER, turnId: turn.id, sourceMessageId: "00000000-0000-0000-0000-000000000000", now: THURSDAY_11AM_NY, tz: NY };
  return runAsOwner(OWNER, "eval", () =>
    executeToolCall({ id: `h${++callN}`, type: "function", function: { name, arguments: JSON.stringify(args) } }, ctx),
  );
}

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(teardownDb);

describe("names the model can tell apart (findings 14, 15)", () => {
  it("find_people and get_person show the preferred name", async () => {
    const { id } = await createPerson({ fullName: "Jonathan Ive", preferredName: "Jony", roles: ["founder"], company: "LoveFrom" });
    const line = `Jonathan Ive (goes by Jony) [${shortId(id)}] · Founder · LoveFrom · never contacted, every 45d`;
    const found = await call("find_people", { query: "jony" });
    expect(found.text).toBe(`1 match:\n- ${line}`);
    const dossier = await call("get_person", { person_id: shortId(id) });
    expect(dossier.text.split("\n")[0]).toBe(line);
    expect(dossier.summary).toBe("Read the dossier for Jonathan Ive");
  });

  it("the working set shows both Davids when one goes by David", async () => {
    await ownerWithSettings();
    const zhang = await createPerson({ fullName: "Zhang Wei", preferredName: "David" });
    const kim = await createPerson({ fullName: "David Kim" });
    const model = scriptedModel([say("Which David: Zhang Wei or David Kim?")]);
    const deps = makeDeps(new FakeLine(), model.llm);
    await bindOwner(deps);
    await text(deps, "Lunch with David, he wants the deck");
    const ctx = String(model.requests[0].messages.at(-1)?.content);
    expect(ctx).toContain(
      "People in play (mentioned recently):\n" +
        `- David Kim [${shortId(kim.id)}] · no cadence, never contacted\n` +
        `- Zhang Wei (goes by David) [${shortId(zhang.id)}] · no cadence, never contacted\n</context>`,
    );
  });

  it("find_people says when only part of a two-word name matched", async () => {
    const mike = await createPerson({ fullName: "Mike Rivera", roles: ["co_investor"] });
    const res = await call("find_people", { query: "Ana Rivera" });
    expect(res.text).toBe(
      `No exact match for "Ana Rivera". Partial matches on "rivera" only:\n` +
        `- Mike Rivera [${shortId(mike.id)}] · Co-investor · never contacted, every 60d\n` +
        "If none of these is who the owner means, it may be someone new: confirm with the owner, then create_person.",
    );
    expect(res.summary).toBe('Searched "Ana Rivera": no exact match, 1 partial');
    expect((await call("find_people", { query: "Mike Rivera" })).text).toBe(
      `1 match:\n- Mike Rivera [${shortId(mike.id)}] · Co-investor · never contacted, every 60d`,
    );
  });
});

describe("dates (findings 16, 30)", () => {
  it("the prompt resolves a bare weekday by tense, and a future occurred_on points back to the past", async () => {
    expect(AGENT_SYSTEM_PROMPT).toContain(
      'Mind the tense: for plans and promises ("send the deck Friday"), a weekday means the next one on or after today; for things that already happened ("met Sam Monday"), it means the most recent one on or before today.',
    );
    expect(AGENT_SYSTEM_PROMPT).not.toContain('"Friday" means the next Friday on or after today');
    const { id } = await createPerson({ fullName: "Leo Park" });
    const res = await call("log_interaction", { person_id: shortId(id), type: "meeting", summary: "Lunch", occurred_on: "2026-09-25" });
    expect(res.ok).toBe(false);
    expect(res.text).toBe(
      'occurred_on 2026-09-25 is after today (2026-09-24), and log_interaction is only for things that already happened. If the owner described a past event with a bare weekday ("met Sam Monday"), use the most recent such day on or before today. If it\'s still a plan, use set_reminder or add_follow_up instead.',
    );
  });

  it("rejects impossible calendar dates instead of rolling them over", async () => {
    const bad = validateToolInput("set_reminder", { person_id: "abc12345", due_on: "2026-02-30", reason: "Check in" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([["due_on", "Not a real calendar date"]]);
    expect(validateToolInput("set_reminder", { person_id: "abc12345", due_on: "2028-02-29", reason: "Leap day" }).success).toBe(true);
    expect(() => zonedTimeToUtc("2026-02-30", 9, 0, NY)).toThrow("Invalid date 2026-02-30: no such day");
    expect(zonedTimeToUtc("2026-11-30", 9, 0, NY).toISOString()).toBe("2026-11-30T14:00:00.000Z");

    const { id } = await createPerson({ fullName: "Priya Patel" });
    const res = await call("set_reminder", { person_id: shortId(id), due_on: "2026-11-31", reason: "Check in" });
    expect(res).toMatchObject({ ok: false, text: "Invalid arguments for set_reminder: due_on: Not a real calendar date. Fix them and call again." });
    expect(await getDb().select().from(reminders)).toHaveLength(0);
  });
});

describe("a brief that opens the conversation (finding 20)", () => {
  it("the owner's reply to the first brief has the brief in history", async () => {
    await ownerWithSettings();
    await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const brief = "Morning! Priya Patel has never heard from you. Opener: congrats on the Halcyon close.";
    const model = scriptedModel([say(brief), say("Here's a draft for Priya.")]);
    const line = new FakeLine();
    const deps = makeDeps(line, model.llm, THU_0735);
    await bindOwner(deps);
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: true }]);
    await text(deps, "draft that opener for her");

    const messages = model.requests[1].messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1]).toEqual({ role: "user", content: "(Earlier conversation)" });
    expect(messages[2]).toEqual({ role: "assistant", content: `[Morning brief]\n${brief}` });
    expect(String(messages[3].content).endsWith("\n\ndraft that opener for her")).toBe(true);
    expect(line.texts().at(-1)).toBe("Here's a draft for Priya.");
  });
});

describe("binding codes resist guessing (finding 24)", () => {
  const ATTACKER = "+15550001000";
  const guessNot = (...codes: string[]) => {
    for (let k = 0; ; k++) {
      const g = String(k).padStart(6, "0");
      if (!codes.includes(g)) return g;
    }
  };

  it("five wrong codes block that number for 15 minutes, even with the right code; other numbers still bind", async () => {
    const line = new FakeLine();
    const deps = makeDeps(line, scriptedModel([]).llm);
    const { code } = await createBindingCode(OWNER, "test", deps.now());
    for (let k = 1; k <= MAX_FAILURES_PER_PHONE; k++) {
      const wrong = String((Number(code) + k) % 1_000_000).padStart(6, "0");
      expect((await text(deps, inbound(wrong, { from: ATTACKER }))).status).toBe("ignored");
    }
    expect((await text(deps, inbound(code, { from: ATTACKER }))).status).toBe("ignored");
    expect((await getBinding(OWNER))?.phone).toBeNull();

    // Failures are stored under a keyed hash, never the number itself.
    const failures = await getDb().select().from(bindingFailures);
    expect(failures).toHaveLength(MAX_FAILURES_PER_PHONE);
    expect(new Set(failures.map((f) => f.phoneHash)).size).toBe(1);
    expect(failures[0].phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(failures)).not.toContain("5550001000");

    // The same live code still works from another number.
    expect((await text(deps, inbound(code))).status).toBe("bound");
    expect((await getBinding(OWNER))?.phone).toBe(OWNER_PHONE);
    expect(line.sent.map((s) => s.to)).toEqual([OWNER_PHONE]);

    // Once the window has passed, the blocked number can bind again.
    const later = makeDeps(line, scriptedModel([]).llm, new Date(THURSDAY_11AM_NY.getTime() + 16 * 60_000));
    const fresh = await createBindingCode("owner-2", "test", later.now());
    expect((await text(later, inbound(fresh.code, { from: ATTACKER }))).status).toBe("bound");
    expect((await getBinding("owner-2"))?.phone).toBe(ATTACKER);
  });

  it("thirty failures across numbers revoke every live code", async () => {
    const deps = makeDeps(new FakeLine(), scriptedModel([]).llm);
    const a = await createBindingCode(OWNER, "test", deps.now());
    const b = await createBindingCode("owner-2", "test", deps.now());
    const guess = guessNot(a.code, b.code);
    const liveCodes = async () =>
      (await getDb().select().from(channelBindings)).filter((r) => r.pendingCodeHash !== null && r.codeExpiresAt !== null).length;

    for (let k = 0; k < MAX_FAILURES_GLOBAL - 1; k++) {
      expect((await text(deps, inbound(guess, { from: `+1555002${String(k).padStart(4, "0")}` }))).status).toBe("ignored");
    }
    expect(await liveCodes()).toBe(2);
    expect((await text(deps, inbound(guess, { from: "+15550029999" }))).status).toBe("ignored");
    expect(await getDb().select().from(bindingFailures)).toHaveLength(MAX_FAILURES_GLOBAL);
    expect(await liveCodes()).toBe(0);
    const rows = await getDb().select().from(channelBindings);
    expect(rows.map((r) => [r.userId, r.pendingCodeHash, r.codeExpiresAt, r.phone]).sort()).toEqual([
      ["owner-2", null, null, null],
      [OWNER, null, null, null],
    ]);

    // The real code is dead, even from a number that never guessed.
    expect((await text(deps, inbound(a.code, { from: "+15550030000" }))).status).toBe("ignored");
    expect((await getBinding(OWNER))?.phone).toBeNull();
  });
});

describe("morning brief tick (findings 31, 32, 41)", () => {
  it("keeps the slot when the brief was delivered but recording it failed", async () => {
    await ownerWithSettings();
    await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const line = new FakeLine();
    const model = scriptedModel([say("Brief one is long enough to send."), say("Brief two is long enough to send.")]);
    const deps = makeDeps(line, model.llm, THU_0735);
    await bindOwner(deps);
    // The provider id FakeLine hands out next is already taken, so recording the brief fails after it was sent.
    const nextId = `out-${line.sent.length + 1}`;
    line.sent = [];
    await getDb()
      .insert(channelMessages)
      .values({ userId: OWNER, provider: "test", providerMessageId: nextId, direction: "out", kind: "chat", bodyEnc: encrypt("taken") });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: true }]);
    expect(errors).toHaveBeenCalledWith("[agent] brief sent but not recorded", expect.any(Error));
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: false, skipped: "already_sent" }]);

    expect(line.texts()).toEqual(["Brief one is long enough to send."]);
    expect(model.remaining()).toBe(1);
    const logs = await getDb().select().from(notificationLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: OWNER, kind: "brief", localDate: "2026-09-24", messageId: null });
  });

  it("one owner's failure doesn't stop the tick for the others", async () => {
    const brief = "Morning! Priya Patel has never heard from you; say hi.";
    const line = new FakeLine();
    const model = scriptedModel([say(brief)]);
    const deps = makeDeps(line, model.llm, THU_0735);
    // The broken owner is bound first, so the loop meets it before the healthy one.
    for (const [userId, phone] of [
      [BROKEN, "+14155550111"],
      [OWNER, OWNER_PHONE],
    ]) {
      await ownerWithSettings(userId);
      await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
      await bindOwner(deps, userId, phone);
    }
    actAs(OWNER);
    line.sent = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await runBriefTick(deps);
    expect([...results].sort((x, y) => x.userId.localeCompare(y.userId))).toEqual([
      { userId: OWNER, sent: true },
      { userId: BROKEN, sent: false, skipped: "error" },
    ]);
    expect(line.sent).toEqual([{ to: OWNER_PHONE, text: brief }]);
    expect(errors).toHaveBeenCalledWith("[agent] tick failed for owner", BROKEN, expect.any(Error));
    const logs = await getDb().select().from(notificationLog);
    expect(logs.map((l) => l.userId)).toEqual([OWNER]);
  });

  it("leaves undated follow-ups out of 'due today'", async () => {
    await ownerWithSettings();
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    await logInteraction({
      personId: id,
      type: "meeting",
      summary: "Coffee",
      occurredAt: new Date("2026-09-20T16:00:00Z"),
      followUps: [
        { description: "Intro her to Sam", dueAt: null },
        { description: "Send the deck", dueAt: new Date("2026-09-24T16:00:00Z") },
        { description: "Call back", dueAt: new Date("2026-09-28T16:00:00Z") },
      ],
    });
    const data = await gatherBriefData(OWNER, THURSDAY_11AM_NY, NY);
    expect(data.dueToday).toEqual([{ text: "Send the deck", person: "Priya Patel", overdue: false }]);
  });
});

describe("summary cursor (finding 34)", () => {
  it("a message stored with microseconds is excluded after a cursor at its own (millisecond) timestamp", async () => {
    const row = (id: string, at: string) => ({
      userId: OWNER,
      provider: "test",
      providerMessageId: id,
      direction: "in" as const,
      kind: "chat",
      bodyEnc: encrypt(id),
      createdAt: sql`${at}::timestamptz`,
      processedAt: sql`${at}::timestamptz`,
    });
    await getDb()
      .insert(channelMessages)
      .values([row("boundary", "2026-09-01T12:00:00.123456Z"), row("next", "2026-09-01T12:00:00.124001Z")]);
    const [boundary, next] = await conversationSince(OWNER, null, null, ["chat"], 10, "oldest");
    expect([boundary.body, next.body]).toEqual(["boundary", "next"]);
    expect(boundary.createdAt.toISOString()).toBe("2026-09-01T12:00:00.123Z");

    const after = await conversationSince(OWNER, boundary.createdAt, null, ["chat"], 10);
    expect(after.map((m) => m.body)).toEqual(["next"]);
    expect(await countConversationSince(OWNER, boundary.createdAt, ["chat"])).toBe(1);
    expect(await countConversationSince(OWNER, next.createdAt, ["chat"])).toBe(0);
  });
});

describe("tool output is bounded (finding 39)", () => {
  it("whats_due lists 10 follow-ups and counts the rest", async () => {
    const { id } = await createPerson({ fullName: "Priya Patel" });
    await logInteraction({
      personId: id,
      type: "meeting",
      summary: "Board prep",
      occurredAt: new Date("2026-09-20T16:00:00Z"),
      followUps: Array.from({ length: 15 }, (_, k) => ({
        description: `Task ${String(k + 1).padStart(2, "0")}`,
        dueAt: new Date(Date.UTC(2026, 8, 25, 16, k)),
      })),
    });
    const res = await call("whats_due", {});
    expect(res.ok).toBe(true);
    const section = res.text.split("\n\n").find((s) => s.startsWith("Open follow-ups:"));
    const lines = section?.split("\n") ?? [];
    expect(lines).toHaveLength(12);
    expect(lines.slice(1, 11).map((l) => l.replace(/^- \[[0-9a-f]{8}\] /, ""))).toEqual(
      Array.from({ length: 10 }, (_, k) => `Task ${String(k + 1).padStart(2, "0")} → Priya Patel (due 2026-09-25)`),
    );
    expect(lines[11]).toBe("…and 5 more");
    expect(res.text).not.toContain("Task 11");
  });

  it("capToolText cuts long output at a line break with a note", () => {
    const long = Array.from({ length: 100 }, (_, k) => `${String(k).padStart(3, "0")} ${"x".repeat(95)}`).join("\n");
    expect(long.length).toBe(9_999);
    const out = capToolText(long);
    expect(out.endsWith(CUT_NOTE)).toBe(true);
    const kept = out.slice(0, -CUT_NOTE.length);
    expect(kept.length).toBeLessThanOrEqual(MAX_TOOL_TEXT);
    expect(kept.split("\n")).toHaveLength(60);
    expect(long.startsWith(`${kept}\n`)).toBe(true);
    expect(capToolText("short")).toBe("short");
  });

  it("every tool result goes through the cap", async () => {
    await getDb()
      .insert(memoryFacts)
      .values(
        Array.from({ length: 20 }, (_, k) => ({
          userId: OWNER,
          fact: `Fact ${k}: ${"detail ".repeat(68)}`,
          sourceKind: "message",
          createdAt: new Date(Date.UTC(2026, 8, 1, 12, k)),
        })),
      );
    const res = await call("recall", {});
    expect(res.ok).toBe(true);
    expect(res.text.endsWith(CUT_NOTE)).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT + CUT_NOTE.length);
    expect(res.text.startsWith("Remembered facts, newest first:\n- Owner: Fact 19: detail")).toBe(true);
  });
});

describe("recall reaches facts outside the context (finding 42)", () => {
  it("returns owner facts beyond the newest 10 and filters by query and person", async () => {
    const priya = await createPerson({ fullName: "Priya Patel" });
    const leo = await createPerson({ fullName: "Leo Park" });
    const fact = (minute: number, body: string, personId: string | null = null) => ({
      userId: OWNER,
      personId,
      fact: body,
      sourceKind: "message",
      createdAt: new Date(Date.UTC(2026, 8, 1, 12, minute)),
    });
    await getDb()
      .insert(memoryFacts)
      .values([
        fact(0, "I never take meetings on Fridays"),
        ...Array.from({ length: 11 }, (_, k) => fact(k + 1, `Owner fact ${k + 1}`)),
        fact(20, "Her kids go to Lakeside school", priya.id),
        fact(21, "His kids are at Lakeside too", leo.id),
      ]);
    const FRIDAYS = "- Owner: I never take meetings on Fridays (noted 2026-09-01)";
    // The context block only carries the newest 10 owner facts.
    const inContext = await ownerFacts(OWNER);
    expect(inContext).toHaveLength(10);
    expect(inContext).not.toContain("I never take meetings on Fridays");

    const all = await call("recall", {});
    expect(all.text.split("\n")).toHaveLength(13);
    expect(all.text.split("\n").at(-1)).toBe(FRIDAYS);
    expect(all.text).not.toContain("Lakeside");

    expect((await call("recall", { query: "fridays" })).text).toBe(`Remembered facts, newest first:\n${FRIDAYS}`);
    expect((await call("recall", { person_id: shortId(priya.id) })).text).toBe(
      `Remembered facts, newest first:\n- Priya Patel [${shortId(priya.id)}]: Her kids go to Lakeside school (noted 2026-09-01)`,
    );
    expect((await call("recall", { query: "lakeside" })).text).toBe(
      "Remembered facts, newest first:\n" +
        `- Leo Park [${shortId(leo.id)}]: His kids are at Lakeside too (noted 2026-09-01)\n` +
        `- Priya Patel [${shortId(priya.id)}]: Her kids go to Lakeside school (noted 2026-09-01)`,
    );
    expect((await call("recall", { person_id: shortId(leo.id), query: "fridays" })).text).toBe(
      'Nothing remembered about that person matching "fridays".',
    );
  });
});

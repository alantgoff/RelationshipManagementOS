import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MEDIA_BUDGET_MS } from "@/agent/media";
import { drainQueue, MIN_TURN_MS, receiveInbound, runTurn, WORK_BUDGET_MS, type ReceiveResult } from "@/agent/runtime";
import { createBindingCode, getMessage, insertInbound } from "@/agent/store";
import { runBriefTick, TICK_BUDGET_MS } from "@/agent/tick";
import { executeToolCall, shortId } from "@/agent/tools";
import { getDb } from "@/db/client";
import { agentActions, agentTurns, channelMessages, followUps, interactions, pendingActions, reminders } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { runAsOwner } from "@/server/auth";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, inbound, makeDeps, OWNER_PHONE, say, scriptedModel, text, toolCall } from "./agent-harness";

/**
 * The per-owner queue and its failure paths (findings 3, 6, 7, 13, 10, 18, 25, 17):
 * bursts are answered in order by one turn at a time, failed sends are recorded
 * honestly, and the tick recovers what a killed webhook run left behind.
 */

const OWNER = "owner-queue";
const NY = "America/New_York";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const CUT_OFF_NOTHING = "Sorry, I got cut off while handling your last message and nothing was saved. Could you send it again?";

type Steps = Parameters<typeof scriptedModel>[0];

/** Seed Priya, bind the owner's phone, and script the model (steps may use Priya's id). */
async function setup(steps: Steps | ((priya: string) => Steps), opts: { delayMs?: number; line?: FakeLine } = {}) {
  actAs(OWNER);
  await updateSettings({ timezone: NY, defaultCadences: {} });
  const priya = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"], company: "Halcyon" });
  const line = opts.line ?? new FakeLine();
  const model = scriptedModel(typeof steps === "function" ? steps(priya.id) : steps, { delayMs: opts.delayMs });
  const deps = makeDeps(line, model.llm);
  const { code } = await createBindingCode(OWNER, "test", deps.now());
  expect((await text(deps, code)).status).toBe("bound");
  line.sent = [];
  return { priya: priya.id, line, model, deps };
}

/** Outbound rows after the welcome message, oldest first, decrypted. */
async function outbound() {
  const rows = await getDb().select().from(channelMessages).where(eq(channelMessages.direction, "out")).orderBy(asc(channelMessages.createdAt));
  return rows.slice(1).map((r) => ({ body: decrypt(r.bodyEnc), kind: r.kind, error: r.error }));
}

async function row(id: string) {
  const [r] = await getDb().select().from(channelMessages).where(eq(channelMessages.id, id));
  return { kind: r.kind, processed: r.processedAt !== null, ready: r.readyAt !== null, error: r.error };
}

/** An inbound row as a webhook would have left it `minutes` ago. */
async function backdated(body: string, minutes: number, ready = true): Promise<string> {
  const createdAt = minutesAgo(minutes);
  const [r] = await getDb()
    .insert(channelMessages)
    .values({
      userId: OWNER,
      provider: "test",
      providerMessageId: `old-${minutes}-${body}`,
      direction: "in",
      kind: "chat",
      bodyEnc: encrypt(body),
      media: ready ? [] : [{ kind: "image", contentType: "image/jpeg" }],
      readyAt: ready ? createdAt : null,
      createdAt,
    })
    .returning({ id: channelMessages.id });
  return r.id;
}

/** The agent_turns row a webhook run writes before its first model call; the run then died. */
async function killedTurn(messageId: string): Promise<string> {
  const [t] = await getDb().insert(agentTurns).values({ userId: OWNER, inboundMessageId: messageId, contextTokens: 1200 }).returning({ id: agentTurns.id });
  return t.id;
}

const accepted = (r: ReceiveResult) => {
  if (r.status !== "accepted") throw new Error(`expected accepted, got ${r.status}`);
  return r;
};

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
});
afterAll(teardownDb);

describe("bursts are serialized per owner (finding 3)", () => {
  it("answers two texts whose webhooks run concurrently with ONE turn that sees both, in order", async () => {
    const { line, model, deps } = await setup(
      (priya) => [
        toolCall("log_interaction", {
          person_id: shortId(priya),
          type: "meeting",
          summary: "Coffee at Blue Bottle",
          follow_ups: [{ description: "Send the Fund I deck", due_on: "2026-09-25" }],
        }),
        say("Logged coffee with Priya; deck reminder Friday."),
      ],
      { delayMs: 150 },
    );
    const a = accepted(await receiveInbound(deps, inbound("Had coffee with Priya")));
    const b = accepted(await receiveInbound(deps, inbound("she wants the deck Friday")));
    await Promise.all([a.work(), b.work()]);

    expect(model.requests).toHaveLength(2);
    expect(model.maxInFlight()).toBe(1);
    const first = model.requests[0];
    expect(first.messages).toHaveLength(2); // system + the merged burst; no history before it
    expect(String(first.messages[1].content).endsWith("\n\nHad coffee with Priya\nshe wants the deck Friday")).toBe(true);

    expect(line.texts()).toEqual(["Logged coffee with Priya; deck reminder Friday."]);
    expect(await getDb().select().from(interactions)).toHaveLength(1);
    expect(await getDb().select().from(followUps)).toHaveLength(1);
    const turns = await getDb().select().from(agentTurns);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ inboundMessageId: b.messageId, steps: 2, error: null });
    expect(await row(a.messageId)).toEqual({ kind: "chat", processed: true, ready: true, error: null });
    expect(await row(b.messageId)).toEqual({ kind: "chat", processed: true, ready: true, error: null });
  });

  it("answers a text that lands mid-turn next, with the first reply in its history", async () => {
    const { line, model, deps } = await setup([say("Logged coffee with Priya."), say("Noted: deck to Priya Friday.")], { delayMs: 50 });
    let late: Promise<void> | undefined;
    let lateId = "";
    const llm = deps.llm;
    deps.llm = async (req) => {
      if (!late) {
        // The owner's next text arrives while the first turn waits on the model.
        const r = accepted(await receiveInbound(deps, inbound("she wants the deck Friday")));
        lateId = r.messageId;
        late = r.work();
      }
      return llm(req);
    };
    const first = accepted(await text(deps, "Had coffee with Priya"));
    await late;

    expect(line.texts()).toEqual(["Logged coffee with Priya.", "Noted: deck to Priya Friday."]);
    expect(model.requests).toHaveLength(2);
    expect(model.maxInFlight()).toBe(1);
    const second = model.requests[1];
    expect(String(second.messages.at(-1)?.content).endsWith("\n\nshe wants the deck Friday")).toBe(true);
    // The model must see that the first text was already answered, or it may redo it.
    expect(second.messages.slice(1, -1)).toEqual([
      { role: "user", content: "Had coffee with Priya" },
      { role: "assistant", content: "Logged coffee with Priya." },
    ]);
    expect(await row(first.messageId)).toMatchObject({ processed: true, error: null });
    expect(await row(lateId)).toMatchObject({ processed: true, error: null });
  });

  it("handles a command between two chat messages in order: turn, command, turn", async () => {
    const { line, model, deps } = await setup(
      (priya) => [
        toolCall("log_interaction", { person_id: shortId(priya), type: "meeting", summary: "Coffee at Blue Bottle" }),
        say("Logged coffee with Priya."),
        toolCall("add_follow_up", { person_id: shortId(priya), description: "Send the Fund I deck", due_on: "2026-09-25" }),
        say("Reminder set: deck to Priya Friday."),
      ],
      { delayMs: 50 },
    );
    const burst = [
      accepted(await receiveInbound(deps, inbound("Had coffee with Priya"))),
      accepted(await receiveInbound(deps, inbound("why"))),
      accepted(await receiveInbound(deps, inbound("she wants the deck Friday"))),
    ];
    await Promise.all(burst.map((r) => r.work()));

    expect(line.texts()).toEqual([
      "Logged coffee with Priya.",
      // "why" ran after the first turn and before the second.
      "My last answer was based on:\n- Logged meeting with Priya Patel: Coffee at Blue Bottle",
      "Reminder set: deck to Priya Friday.",
    ]);
    expect(model.requests).toHaveLength(4);
    expect(model.maxInFlight()).toBe(1);
    expect(String(model.requests[0].messages.at(-1)?.content).endsWith("\n\nHad coffee with Priya")).toBe(true);
    const second = model.requests[2];
    expect(String(second.messages.at(-1)?.content).endsWith("\n\nshe wants the deck Friday")).toBe(true);
    // The command and its reply are not part of the conversation the model replays.
    expect(second.messages.slice(1, -1)).toEqual([
      { role: "user", content: "Had coffee with Priya" },
      { role: "assistant", content: "Logged coffee with Priya." },
    ]);
    expect((await Promise.all(burst.map((r) => row(r.messageId)))).map((r) => [r.kind, r.processed, r.error])).toEqual([
      ["chat", true, null],
      ["command", true, null],
      ["chat", true, null],
    ]);
    expect(await getDb().select().from(interactions)).toHaveLength(1);
    expect(await getDb().select().from(reminders)).toHaveLength(1);
  });
});

describe("failed sends after writes (finding 6)", () => {
  it("records the turn before sending, keeps the undelivered reply, and never says 'try again'", async () => {
    const { line, model, deps } = await setup((priya) => [
      toolCall("log_interaction", { person_id: shortId(priya), type: "meeting", summary: "Coffee at Blue Bottle" }),
      say("Logged coffee with Priya."),
      say("Yes, the coffee with Priya is logged."),
    ]);
    line.fail = true;
    const r = accepted(await text(deps, "Had coffee with Priya"));

    expect(line.sent).toEqual([]);
    const [turn] = await getDb().select().from(agentTurns);
    expect(turn).toMatchObject({ inboundMessageId: r.messageId, steps: 2, model: "scripted", provider: "primary", error: "reply not delivered" });
    expect(turn.latencyMs).not.toBeNull();
    expect(await outbound()).toEqual([{ body: "Logged coffee with Priya.", kind: "chat", error: "not delivered" }]);
    expect(await row(r.messageId)).toMatchObject({ processed: true, error: "reply not delivered" });
    expect(await getDb().select().from(interactions)).toHaveLength(1);
    expect(model.requests).toHaveLength(2);

    // The line recovers: the next turn's history shows what the agent tried to say.
    line.fail = false;
    await text(deps, "did that save?");
    expect(model.requests[2].messages.slice(1, -1)).toEqual([
      { role: "user", content: "Had coffee with Priya" },
      { role: "assistant", content: "[NOT delivered: the owner never saw this]\nLogged coffee with Priya." },
    ]);
    expect(line.texts()).toEqual(["Yes, the coffee with Priya is logged."]);
    const all = await outbound();
    expect(all.map((m) => m.body).join("\n")).not.toMatch(/try again/i);
    expect(await getDb().select().from(interactions)).toHaveLength(1);
  });

  it("when only the draft fails to send, records it undelivered and keeps the draft pending", async () => {
    class DraftFailsLine extends FakeLine {
      override async sendText(to: string, body: string) {
        if (body.startsWith("Subject:")) throw new Error("provider down");
        return super.sendText(to, body);
      }
    }
    const line = new DraftFailsLine();
    const { deps } = await setup(
      (priya) => [
        toolCall("draft_message", { person_id: shortId(priya), channel: "email", intent: "Send the deck", body: "Subject: Deck\nHi Priya, here's the Fund I deck." }),
        say("Drafted an email to Priya. Tap 👍 once you've sent it."),
      ],
      { line },
    );
    const r = accepted(await text(deps, "Draft Priya a note with the deck"));

    expect(line.texts()).toEqual(["Drafted an email to Priya. Tap 👍 once you've sent it."]);
    expect(await outbound()).toEqual([
      { body: "Drafted an email to Priya. Tap 👍 once you've sent it.", kind: "chat", error: null },
      { body: "Subject: Deck\nHi Priya, here's the Fund I deck.", kind: "draft", error: "not delivered" },
    ]);
    expect(await row(r.messageId)).toMatchObject({ processed: true, error: "reply not delivered" });
    expect((await getDb().select().from(pendingActions)).map((d) => d.status)).toEqual(["pending"]);
    expect((await outbound()).map((m) => m.body).join("\n")).not.toMatch(/try again/i);
  });
});

describe("tick recovery of killed webhook runs (findings 7, 13)", () => {
  it("reports what an interrupted turn saved instead of redoing it, without calling the model", async () => {
    const { priya, line, model, deps } = await setup([]);
    const msg = await backdated("Had coffee with Priya at Blue Bottle", 5);
    const turnId = await killedTurn(msg);
    const ctx = { userId: OWNER, turnId, sourceMessageId: msg, now: deps.now(), tz: NY };
    await runAsOwner(OWNER, "channel", async () => {
      await executeToolCall(toolCall("find_people", { query: "Priya" }).tool_calls![0], ctx); // read-only
      await executeToolCall(toolCall("log_interaction", { person_id: shortId(priya), type: "meeting", summary: "Coffee at Blue Bottle" }).tool_calls![0], ctx);
      await executeToolCall(toolCall("get_person", { person_id: "p_unknown" }).tool_calls![0], ctx); // failed
    });
    expect(await getDb().select().from(agentActions)).toHaveLength(3);

    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: false, skipped: "window_passed", recovered: 1 }]);
    expect(model.requests).toHaveLength(0);
    expect(line.texts()).toEqual([
      "Sorry, I got cut off while handling your last message. Before that I saved: Logged meeting with Priya Patel: Coffee at Blue Bottle. Tell me if anything's missing.",
    ]);
    expect((await outbound()).map((m) => [m.kind, m.error])).toEqual([["system", null]]);
    expect(await row(msg)).toMatchObject({ processed: true, error: "interrupted" });
    expect(await getDb().select().from(agentTurns)).toHaveLength(1);
    expect(await getDb().select().from(interactions)).toHaveLength(1);

    // Already reported: the next tick leaves it alone.
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: false, skipped: "window_passed" }]);
    expect(line.sent).toHaveLength(1);
  });

  it("says nothing was saved when the interrupted turn had made no changes", async () => {
    const { line, model, deps } = await setup([]);
    const msg = await backdated("Who should I call this week?", 3);
    await killedTurn(msg);
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: false, skipped: "window_passed", recovered: 1 }]);
    expect(model.requests).toHaveLength(0);
    expect(line.texts()).toEqual([CUT_OFF_NOTHING]);
    expect(await row(msg)).toMatchObject({ processed: true, error: "interrupted" });
  });

  it("still answers a new text that arrives after an interrupted run, not just the cut-off notice", async () => {
    const { line, model, deps } = await setup([say("Priya is an LP prospect at Halcyon.")]);
    const killed = await backdated("Who should I call this week?", 1);
    await killedTurn(killed);
    const r = accepted(await text(deps, "what do I know about Priya?"));

    expect(await row(killed)).toMatchObject({ processed: true, error: "interrupted" });
    expect(line.texts()).toEqual([CUT_OFF_NOTHING, "Priya is an LP prospect at Halcyon."]);
    expect(model.requests).toHaveLength(1);
    expect(String(model.requests[0].messages.at(-1)?.content).endsWith("\n\nwhat do I know about Priya?")).toBe(true);
    expect(await row(r.messageId)).toMatchObject({ processed: true, error: null });
  });

  it("gives up on attachments stuck unread for 10 minutes with one apology, and leaves younger ones", async () => {
    const { line, model, deps } = await setup([]);
    const dead1 = await backdated("", 15, false);
    const dead2 = await backdated("look at this", 12, false);
    const young = await backdated("", 5, false);
    await runBriefTick(deps);

    expect(line.texts()).toEqual(["Sorry, I couldn't finish reading something you sent me earlier. Could you send it again?"]);
    expect((await outbound()).map((m) => m.kind)).toEqual(["system"]);
    expect(await row(dead1)).toEqual({ kind: "chat", processed: true, ready: false, error: "attachment processing interrupted" });
    expect(await row(dead2)).toEqual({ kind: "chat", processed: true, ready: false, error: "attachment processing interrupted" });
    expect(await row(young)).toEqual({ kind: "chat", processed: false, ready: false, error: null });
    expect(model.requests).toHaveLength(0);
  });

  it("answers a stale ready message that no run ever started", async () => {
    const { line, model, deps } = await setup([say("Noted: coffee with Priya.")]);
    const msg = await backdated("Had coffee with Priya", 4);
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: false, skipped: "window_passed", recovered: 1 }]);

    expect(model.requests).toHaveLength(1);
    expect(String(model.requests[0].messages.at(-1)?.content).endsWith("\n\nHad coffee with Priya")).toBe(true);
    expect(line.texts()).toEqual(["Noted: coffee with Priya."]);
    expect(await row(msg)).toMatchObject({ processed: true, error: null });
    const turns = await getDb().select().from(agentTurns);
    expect(turns.map((t) => [t.inboundMessageId, t.steps])).toEqual([[msg, 1]]);
  });
});

describe("cut-off and reasoning output (findings 10, 17, 18)", () => {
  it("retries a length-truncated answer once with maxTokens 3000", async () => {
    const { line, model, deps } = await setup([{ truncated: say("<think>The owner had coffee with Priya, so I should") }, say("Noted: coffee with Priya.")]);
    await text(deps, "Had coffee with Priya");
    expect(model.requests.map((r) => [r.maxTokens, r.toolChoice])).toEqual([
      [1500, "auto"],
      [3000, "auto"],
    ]);
    // The retry starts from the same prompt; the cut-off reasoning is not fed back.
    expect(model.requests[1].messages).toEqual(model.requests[0].messages);
    expect(line.texts()).toEqual(["Noted: coffee with Priya."]);
    expect((await getDb().select().from(agentTurns))[0]).toMatchObject({ steps: 2, error: null });
  });

  it("never leaks <think> text when the answer is cut off twice", async () => {
    const { line, model, deps } = await setup([
      { truncated: say("<think>The owner wants a call logged with Priya Patel, LP commitment $2M") },
      { truncated: say("<think>The owner wants a call logged with Priya Patel, LP commitment $2M, so first I") },
    ]);
    const r = accepted(await text(deps, "log the call with Priya"));
    expect(model.requests).toHaveLength(2); // retried once, not again
    expect(line.texts()).toEqual(["I didn't manage to answer that, and nothing was saved. Could you say it another way?"]);
    const stored = (await outbound()).map((m) => m.body).join("\n");
    expect(stored).not.toMatch(/think|owner wants|\$2M/i);
    expect(await row(r.messageId)).toMatchObject({ processed: true, error: null });
  });

  it("strips reasoning that ends in a lone </think> (no opening tag)", async () => {
    const { line, deps } = await setup([say("The owner had coffee with Priya; her LP check is $2M.\n</think>\n\nNoted: coffee with Priya.")]);
    await text(deps, "Had coffee with Priya");
    expect(line.texts()).toEqual(["Noted: coffee with Priya."]);
  });
});

describe("real-clock budget (findings 7, 13)", () => {
  async function stored(body: string) {
    const id = await insertInbound({ userId: OWNER, provider: "test", providerMessageId: `now-${body}`, body });
    return (await getMessage(id!))!;
  }

  it("keeps the webhook work and the tick inside their routes' maxDuration", () => {
    const maxDuration = (route: string) => {
      const src = readFileSync(fileURLToPath(new URL(`../../src/app/api/${route}/route.ts`, import.meta.url)), "utf8");
      const m = /export const maxDuration = (\d+);/.exec(src);
      expect(m, `${route} declares maxDuration`).not.toBeNull();
      return Number(m![1]) * 1000;
    };
    expect(WORK_BUDGET_MS).toBeLessThan(maxDuration("channels/sendblue"));
    expect(TICK_BUDGET_MS).toBeLessThan(maxDuration("cron/tick"));
    // An attachment can't eat the time a turn needs.
    expect(MEDIA_BUDGET_MS + MIN_TURN_MS).toBeLessThanOrEqual(WORK_BUDGET_MS);
  });

  it("sends 'ran out of time … nothing was saved' without calling the model when the deadline is too close", async () => {
    const { line, model, deps } = await setup([]);
    const msg = await stored("Had coffee with Priya");
    const result = await runTurn(deps, { userId: OWNER, messages: [msg], now: deps.now(), to: OWNER_PHONE, deadline: Date.now() + 5_000 });
    expect(model.requests).toHaveLength(0);
    expect(result).toMatchObject({ reply: "I ran out of time on that one and nothing was saved. Could you send it again?", steps: 0, sent: true });
    expect(line.texts()).toEqual(["I ran out of time on that one and nothing was saved. Could you send it again?"]);
    expect((await getDb().select().from(agentTurns))[0]).toMatchObject({ steps: 0, model: null, error: "turn ran out of time" });
  });

  it("caps each model call's timeout to the time left before the deadline", async () => {
    const { model, deps } = await setup([say("Hi.")]);
    const msg = await stored("hello");
    await runTurn(deps, { userId: OWNER, messages: [msg], now: deps.now(), to: OWNER_PHONE, deadline: Date.now() + 14_000 });
    const timeout = model.requests[0].timeoutMs!;
    expect(timeout).toBeLessThanOrEqual(9_000); // 14s minus the 5s send reserve
    expect(timeout).toBeGreaterThan(4_000);
  });

  it("leaves a message for a later run when there isn't time to start a turn", async () => {
    const { line, model, deps } = await setup([]);
    const msg = await stored("Had coffee with Priya");
    await runAsOwner(OWNER, "channel", () => drainQueue(deps, OWNER, OWNER_PHONE, Date.now() + MIN_TURN_MS - 2_000));
    expect(model.requests).toHaveLength(0);
    expect(line.sent).toEqual([]);
    expect(await row(msg.id)).toEqual({ kind: "chat", processed: false, ready: true, error: null });
  });
});

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBindingCode, getAgentPrefs } from "@/agent/store";
import { shortId } from "@/agent/tools";
import { getDb } from "@/db/client";
import { agentActions, agentTurns, channelMessages, followUps, interactions, pendingActions, threadSummaries } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { getDashboard } from "@/server/queries/dashboard";
import { maybeUpdateThreadSummary, receiveInbound, runTurn } from "@/agent/runtime";
import { CONTEXT_BUDGET_TOKENS, HISTORY_KEEP, HISTORY_MAX } from "@/agent/context";
import { getMessage } from "@/agent/store";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, inbound, makeDeps, OWNER_PHONE, say, scriptedModel, text, THURSDAY_11AM_NY, toolCall, toolResults } from "./agent-harness";

const OWNER = "owner-1";

async function bindOwner(deps: ReturnType<typeof makeDeps>) {
  const { code } = await createBindingCode(OWNER, "test", deps.now());
  const r = await text(deps, code);
  expect(r.status).toBe("bound");
}

async function seedPeople() {
  actAs(OWNER);
  await updateSettings({ timezone: "America/New_York", defaultCadences: {} });
  const priya = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"], company: "Halcyon" });
  const leo = await createPerson({ fullName: "Leo Park", roles: ["co_investor"], email: "leo@northstar.vc" });
  return { priya: priya.id, leo: leo.id };
}

const countRows = async (table: typeof channelMessages | typeof interactions) =>
  Number((await getDb().select({ id: table.id }).from(table)).length);

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
});
afterAll(teardownDb);

describe("intake and binding (HA-1..HA-4)", () => {
  it("HAC-4: ignores unknown senders without writing or replying", async () => {
    const line = new FakeLine();
    const model = scriptedModel([]);
    const deps = makeDeps(line, model.llm);
    expect((await text(deps, "hello?")).status).toBe("ignored");
    expect((await text(deps, "123456")).status).toBe("ignored");
    expect(await countRows(channelMessages)).toBe(0);
    expect(line.sent).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });

  it("binds the phone that texts a live code, once, and welcomes the owner", async () => {
    const line = new FakeLine();
    const deps = makeDeps(line, scriptedModel([]).llm);
    const { code } = await createBindingCode(OWNER, "test", deps.now());
    expect((await text(deps, code)).status).toBe("bound");
    expect(line.texts()[0]).toMatch(/You're connected/);
    // Code is single use: another phone can't reuse it.
    expect((await text(deps, inbound(code, { from: "+14155550999" }))).status).toBe("ignored");
  });

  it("rejects expired codes and messages addressed to another line", async () => {
    const line = new FakeLine();
    const deps = makeDeps(line, scriptedModel([]).llm);
    await createBindingCode(OWNER, "test", new Date(THURSDAY_11AM_NY.getTime() - 16 * 60_000)).then(async ({ code }) => {
      expect((await text(deps, code)).status).toBe("ignored");
    });
    await bindOwner(deps);
    expect((await text(deps, inbound("hi", { to: "+19999999999" }))).status).toBe("ignored");
  });

  it("HAC-5: processes a replayed webhook once", async () => {
    const line = new FakeLine();
    const model = scriptedModel([say("Hi!")]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    const msg = inbound("hello");
    expect((await text(deps, msg)).status).toBe("accepted");
    expect((await receiveInbound(deps, msg)).status).toBe("duplicate");
    expect(model.requests).toHaveLength(1);
  });

  it("stores message bodies encrypted", async () => {
    const line = new FakeLine();
    const deps = makeDeps(line, scriptedModel([say("Noted.")]).llm);
    await bindOwner(deps);
    await text(deps, "Priya's fund is $40M");
    const rows = await getDb().select({ body: channelMessages.bodyEnc }).from(channelMessages);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.body).not.toContain("Priya");
  });
});

describe("agent turns", () => {
  it("HAC-2: logs a meeting with a follow-up due Friday and confirms in one line", async () => {
    const { priya } = await seedPeople();
    const line = new FakeLine();
    const model = scriptedModel([
      toolCall("log_interaction", {
        person_id: shortId(priya),
        type: "meeting",
        summary: "Coffee; keen on Fund I",
        follow_ups: [{ description: "Send the Fund I deck", due_on: "2026-09-25" }],
      }),
      say("Logged coffee with Priya; deck reminder Friday."),
    ]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await text(deps, "Had coffee with Priya, promised the deck Friday");

    // The model saw the stable system prompt first and the context block last.
    const first = model.requests[0];
    expect(first.messages[0].role).toBe("system");
    const last = String(first.messages.at(-1)?.content);
    expect(last).toMatch(/^<context>/);
    expect(last).toContain("Today is Thursday, 2026-09-24");
    expect(last).toContain(`Priya Patel [${shortId(priya)}]`);
    expect(last.endsWith("Had coffee with Priya, promised the deck Friday")).toBe(true);
    expect(first.tools?.map((t) => t.function.name)).toContain("log_interaction");

    // The tool result fed back to the model.
    expect(toolResults(model.requests[1])[0]).toMatch(/Logged meeting with Priya Patel on 2026-09-24 with 1 follow-up/);

    const [i] = await getDb().select().from(interactions).where(eq(interactions.personId, priya));
    expect(i.type).toBe("meeting");
    const [f] = await getDb().select().from(followUps).where(eq(followUps.interactionId, i.id));
    expect(f.dueAt?.toISOString()).toBe("2026-09-25T16:00:00.000Z"); // noon in New York
    expect(line.texts().at(-1)).toBe("Logged coffee with Priya; deck reminder Friday.");

    const [turn] = await getDb().select().from(agentTurns);
    expect(turn).toMatchObject({ steps: 2, model: "scripted", error: null });
    expect(turn.contextTokens).toBeLessThan(20_000);
  });

  it("HAC-3: who's going cold matches the dashboard's order", async () => {
    await seedPeople();
    actAs(OWNER);
    const dash = await getDashboard(undefined, THURSDAY_11AM_NY);
    const line = new FakeLine();
    const model = scriptedModel([toolCall("whats_due", {}), (req) => say(toolResults(req)[0])]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await text(deps, "who's going cold?");
    const result = toolResults(model.requests[1])[0];
    const order = dash.attention.map((p) => result.indexOf(p.fullName));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("returns errors that teach instead of failing the turn", async () => {
    await seedPeople();
    const line = new FakeLine();
    const model = scriptedModel([
      toolCall("get_person", { person_id: "p_unknown" }),
      toolCall("set_reminder", { person_id: "abc", due_on: "next week", reason: "x" }),
      toolCall("bogus_tool", {}),
      say("Which Priya do you mean?"),
    ]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await text(deps, "remind me about her");
    expect(toolResults(model.requests[1])[0]).toMatch(/No person with id "p_unknown".*find_people/);
    expect(toolResults(model.requests[2])[1]).toMatch(/Invalid arguments for set_reminder: due_on: Use YYYY-MM-DD/);
    expect(toolResults(model.requests[3])[2]).toMatch(/Unknown tool "bogus_tool"/);
    const actions = await getDb().select().from(agentActions);
    expect(actions.map((a) => a.ok)).toEqual([false, false, false]);
  });

  it("replies safely when the model is unreachable", async () => {
    const line = new FakeLine();
    const deps = makeDeps(line, scriptedModel([new Error("All providers failed")]).llm);
    await bindOwner(deps);
    await text(deps, "hello");
    expect(line.texts().at(-1)).toMatch(/couldn't reach my model/);
    const [turn] = await getDb().select().from(agentTurns);
    expect(turn.error).toMatch(/All providers failed/);
  });

  it("after the last tool round, makes the model answer in text having seen every result", async () => {
    const { priya } = await seedPeople();
    const loop = Array.from({ length: 6 }, (_, k) => toolCall("remember", { person_id: shortId(priya), fact: `fact ${k}` }));
    const line = new FakeLine();
    const model = scriptedModel([...loop, toolCall("remember", { person_id: shortId(priya), fact: "ignored" }), say("Saved six things about Priya.")]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await text(deps, "Priya likes many things");
    const final = model.requests.at(-1)!;
    expect(final.toolChoice).toBe("none");
    expect(toolResults(final)).toHaveLength(6);
    // A tool call returned despite tool_choice "none" is ignored, and the text step is never reached.
    expect(line.texts().at(-1)).toMatch(/^Done: Remembered about Priya Patel: fact 0;/);
    expect(await getDb().select().from(agentActions)).toHaveLength(6);
  });

  it("uses the final text answer when the model gives one", async () => {
    const { priya } = await seedPeople();
    const loop = Array.from({ length: 6 }, (_, k) => toolCall("remember", { person_id: shortId(priya), fact: `fact ${k}` }));
    const line = new FakeLine();
    const deps = makeDeps(line, scriptedModel([...loop, say("Saved six things about Priya.")]).llm);
    await bindOwner(deps);
    await text(deps, "Priya likes many things");
    expect(line.texts().at(-1)).toBe("Saved six things about Priya.");
  });

  it("never answers 'Got it.' when nothing was saved", async () => {
    const line = new FakeLine();
    const model = scriptedModel([say("<think>The owner wants"), say("   ")]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await text(deps, "log the call with Priya");
    expect(line.texts().at(-1)).toMatch(/didn't manage to answer that, and nothing was saved/);
    expect(line.texts().join("\n")).not.toMatch(/think|Got it/);
  });
});

describe("commands", () => {
  it("undo reverses the last turn's changes and why explains it", async () => {
    const { priya } = await seedPeople();
    const line = new FakeLine();
    const model = scriptedModel([
      toolCall("log_interaction", { person_id: shortId(priya), type: "call", summary: "Quick call" }),
      say("Logged."),
    ]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await text(deps, "called Priya");
    expect(await countRows(interactions)).toBe(1);

    await text(deps, "why");
    expect(line.texts().at(-1)).toMatch(/based on:\n- Logged call with Priya Patel: Quick call/);

    await text(deps, "undo");
    expect(line.texts().at(-1)).toMatch(/^Undid: Logged call with Priya Patel/);
    expect(await countRows(interactions)).toBe(0);
    await text(deps, "undo");
    expect(line.texts().at(-1)).toBe("There's nothing to undo.");
    expect(model.remaining()).toBe(0); // commands never reached the model
  });

  it("stop, start and pause change when the agent may text first", async () => {
    const line = new FakeLine();
    const deps = makeDeps(line, scriptedModel([]).llm);
    await bindOwner(deps);
    await text(deps, "stop");
    expect((await getAgentPrefs(OWNER)).proactiveEnabled).toBe(false);
    await text(deps, "start");
    expect((await getAgentPrefs(OWNER)).proactiveEnabled).toBe(true);
    await text(deps, "pause 2h");
    expect((await getAgentPrefs(OWNER)).pausedUntil?.toISOString()).toBe("2026-09-24T17:00:00.000Z");
    expect(line.texts().at(-1)).toMatch(/Paused for 2 hours/);
  });
});

describe("drafts (HA-6)", () => {
  async function draftForLeo() {
    const { leo } = await seedPeople();
    const line = new FakeLine();
    const model = scriptedModel([
      toolCall("draft_message", { person_id: shortId(leo), channel: "email", intent: "Co-invest in Acme", body: "Subject: Acme\nHey Leo, want to co-invest in Acme's seed?" }),
      say("Drafted an email to Leo about Acme. Tap 👍 once you've sent it."),
      say("Sure."),
    ]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await text(deps, "Draft a note to Leo about co-investing in Acme");
    return { leo, line, deps, model };
  }

  it("HAC-6: shows the draft separately and never contacts the person", async () => {
    const { line } = await draftForLeo();
    expect(line.texts().slice(-2)).toEqual([
      "Drafted an email to Leo about Acme. Tap 👍 once you've sent it.",
      "Subject: Acme\nHey Leo, want to co-invest in Acme's seed?",
    ]);
    expect(line.sent.every((s) => s.to === OWNER_PHONE)).toBe(true);
    const [d] = await getDb().select().from(pendingActions);
    expect(d.status).toBe("pending");
  });

  it("👍 logs the sent email and closes the draft; undo removes the log", async () => {
    const { leo, line, deps } = await draftForLeo();
    await text(deps, "👍");
    expect(line.texts().at(-1)).toBe("Logged as sent to Leo Park.");
    const [i] = await getDb().select().from(interactions).where(eq(interactions.personId, leo));
    expect(i).toMatchObject({ type: "email", summary: "Sent: Hey Leo, want to co-invest in Acme's seed?" });
    expect((await getDb().select().from(pendingActions))[0].status).toBe("approved");
    await text(deps, "undo");
    expect(await countRows(interactions)).toBe(0);
    // Undo puts the draft back, so it can be approved again later.
    expect((await getDb().select().from(pendingActions))[0].status).toBe("pending");
  });

  it("skip discards it; 'yes' is about the wording, so it goes to the model", async () => {
    const { line, deps, model } = await draftForLeo();
    await text(deps, "skip");
    expect(line.texts().at(-1)).toBe("Discarded the draft to Leo Park.");
    expect((await getDb().select().from(pendingActions))[0].status).toBe("rejected");
    await text(deps, "undo");
    expect((await getDb().select().from(pendingActions))[0].status).toBe("pending");
    await text(deps, "yes");
    expect(line.texts().at(-1)).toBe("Sure."); // went to the model, not treated as approval
    expect((await getDb().select().from(pendingActions))[0].status).toBe("pending");
    expect(model.remaining()).toBe(0);
  });
});

describe("context budget and thread summary (HA-7)", () => {
  const long = (k: number, chars: number) => `${k}: ${"Long update about the fund and many people. ".repeat(Math.ceil(chars / 45)).slice(0, chars)}`;

  async function seedThread(n: number, chars: number) {
    const db = getDb();
    for (let k = 0; k < n; k++) {
      await db.insert(channelMessages).values({
        userId: OWNER,
        provider: "test",
        providerMessageId: `seed-${k}`,
        direction: k % 2 ? "out" : "in",
        kind: "chat",
        bodyEnc: encrypt(long(k, chars)),
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, k)),
        processedAt: new Date(Date.UTC(2026, 8, 1, 0, k)),
      });
    }
  }

  async function newMessage(body: string) {
    const [row] = await getDb()
      .insert(channelMessages)
      .values({ userId: OWNER, provider: "test", providerMessageId: `now-${body}`, direction: "in", kind: "chat", bodyEnc: encrypt(body) })
      .returning({ id: channelMessages.id });
    return (await getMessage(row.id))!;
  }

  it("trims the oldest history to stay under budget when the unsummarized thread is too big", async () => {
    await seedPeople();
    const line = new FakeLine();
    const model = scriptedModel([say("ok")]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await seedThread(HISTORY_MAX, 4_000); // ~1k tokens each: 24k of history alone
    const result = await runTurn(deps, { userId: OWNER, messages: [await newMessage("hi")], now: deps.now(), to: OWNER_PHONE, deadline: Date.now() + 50_000 });
    expect(result.contextTokens).toBeLessThanOrEqual(CONTEXT_BUDGET_TOKENS);
    const history = model.requests[0].messages.slice(1, -1);
    const all = history.map((m) => String(m.content)).join("\n");
    expect(all).toContain(`${HISTORY_MAX - 1}: Long update`); // newest kept
    expect(all).not.toMatch(/(^|\n)0: Long update/); // oldest trimmed
    expect(history.length).toBeLessThan(HISTORY_MAX);
  });

  it("folds the oldest messages into the summary, keeps the newest verbatim, and leaves no gap", async () => {
    await seedPeople();
    const line = new FakeLine();
    const model = scriptedModel([say("Owner is raising Fund I; Priya keen; promised deck."), say("ok")]);
    const deps = makeDeps(line, model.llm);
    await bindOwner(deps);
    await seedThread(40, 200);
    expect(await maybeUpdateThreadSummary(deps, OWNER, deps.now())).toBe(true);
    const [s] = await getDb().select().from(threadSummaries);
    // 40 messages, keep 12: messages 0..27 folded.
    expect(s.coversThrough.toISOString()).toBe(new Date(Date.UTC(2026, 8, 1, 0, 40 - HISTORY_KEEP - 1)).toISOString());
    // The transcript uses the owner's local time (America/New_York), not UTC.
    expect(String(model.requests[0].messages[1].content)).toContain("Owner (2026-08-31 20:00): 0: Long update");
    // Nothing more to fold, and the cursor is exact: message 27 isn't folded twice.
    expect(await maybeUpdateThreadSummary(deps, OWNER, deps.now())).toBe(false);

    await runTurn(deps, { userId: OWNER, messages: [await newMessage("hi")], now: deps.now(), to: OWNER_PHONE, deadline: Date.now() + 50_000 });
    const req = model.requests[1];
    expect(String(req.messages.at(-1)?.content)).toContain("Earlier in this conversation (summary):\nOwner is raising Fund I");
    const replay = req.messages.slice(1, -1).map((m) => String(m.content)).join("\n");
    expect(replay).toContain("28: Long update");
    expect(replay).toContain("39: Long update");
    expect(replay).not.toContain("27: Long update");
  });
});

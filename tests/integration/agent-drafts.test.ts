import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@/agent/llm";
import { createBindingCode } from "@/agent/store";
import { runBriefTick } from "@/agent/tick";
import { shortId } from "@/agent/tools";
import { getDb } from "@/db/client";
import { agentActions, channelMessages, interactions, pendingActions } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { localDate } from "@/lib/time";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { actAs, resetDb, teardownDb } from "./helpers";
import { receiveInbound } from "@/agent/runtime";
import { FakeLine, inbound, makeDeps, say, scriptedModel, text, toolCall, toolResults } from "./agent-harness";

/**
 * Drafts (spec 0002 HA-6) after the hardening pass: findings 4, 5, 23, 29 and 43.
 * A draft can be resolved after the conversation moves on, tapbacks resolve
 * the draft they quote, wording feedback goes to the model, the model can close
 * drafts itself, bodies never sit in plaintext audit rows, and stale drafts expire.
 */

const OWNER = "owner-drafts";
const TZ = "America/New_York";
const DAY = 86_400_000;
const LEO_BODY = "Subject: Acme\nHey Leo, want to co-invest in Acme's seed?";
const LEO_LINE = "Hey Leo, want to co-invest in Acme's seed?";
const PRIYA_BODY = "Hi Priya, sending the Fund I deck now. Thoughts welcome!";

type Step = Parameters<typeof scriptedModel>[0][number];
interface Ids {
  leo: string;
  priya: string;
}

const draftLeo = (p: Ids) => toolCall("draft_message", { person_id: shortId(p.leo), channel: "email", intent: "Co-invest in Acme", body: LEO_BODY });
const draftPriya = (p: Ids) => toolCall("draft_message", { person_id: shortId(p.priya), channel: "imessage", intent: "Send the deck", body: PRIYA_BODY });
/** One assistant message carrying several tool calls. */
const calls = (...msgs: ChatMessage[]): ChatMessage => ({ role: "assistant", content: null, tool_calls: msgs.flatMap((m) => m.tool_calls ?? []) });

async function setup(script: (p: Ids) => Step[]) {
  actAs(OWNER);
  await updateSettings({ timezone: TZ, defaultCadences: {} });
  const priya = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"], company: "Halcyon" });
  const leo = await createPerson({ fullName: "Leo Park", roles: ["co_investor"], email: "leo@northstar.vc" });
  const ids = { leo: leo.id, priya: priya.id };
  const line = new FakeLine();
  const model = scriptedModel(script(ids));
  const deps = makeDeps(line, model.llm);
  const { code } = await createBindingCode(OWNER, "test", deps.now());
  expect((await text(deps, code)).status).toBe("bound");
  return { ...ids, line, model, deps };
}

/** Two drafts in one turn (Leo's first, Priya's newer), then a chat reply, so neither was just shown. */
async function twoDraftsThenChat(extra: Step[] = []) {
  const s = await setup((p) => [draftLeo(p), draftPriya(p), say("Drafted notes to Leo and Priya."), say("Anytime."), ...extra]);
  await text(s.deps, "Draft a note to Leo about Acme and send Priya the deck");
  expect(s.line.texts().slice(-3)).toEqual(["Drafted notes to Leo and Priya.", LEO_BODY, PRIYA_BODY]);
  await text(s.deps, "thanks");
  expect(s.line.texts().at(-1)).toBe("Anytime.");
  return s;
}

/** Draft status keyed by the person it's for. */
async function statuses(): Promise<Record<string, string>> {
  const rows = await getDb().select({ personId: pendingActions.personId, status: pendingActions.status }).from(pendingActions);
  return Object.fromEntries(rows.map((r) => [r.personId, r.status]));
}

async function draftId(personId: string): Promise<string> {
  const [row] = await getDb().select({ id: pendingActions.id }).from(pendingActions).where(eq(pendingActions.personId, personId));
  return row.id;
}

const interactionCount = async () => (await getDb().select({ id: interactions.id }).from(interactions)).length;

/** The owner's messages, oldest first. */
const inboundRows = () => getDb().select().from(channelMessages).where(eq(channelMessages.direction, "in")).orderBy(asc(channelMessages.createdAt));

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
});
afterAll(teardownDb);

/** A model step that resolves a waiting draft, reading its id from the drafts listed in the context. */
const resolveFromContext =
  (who: string, action: "sent" | "discard"): Step =>
  (req) => {
    const ctx = String(req.messages.at(-1)?.content);
    const id = new RegExp(`\\[([0-9a-f]{8})\\] \\w+ to ${who}`).exec(ctx)?.[1];
    if (!id) throw new Error(`no draft to ${who} in the context`);
    return toolCall("resolve_draft", { draft_id: id, action });
  };

describe("resolving a draft after the conversation moved on (finding 4)", () => {
  it("a bare 👍 after other chat goes to the model, which sees the drafts waiting and can resolve one", async () => {
    const { leo, line, model, deps } = await setup((p) => [
      draftLeo(p),
      say("Drafted an email to Leo about Acme. Tap 👍 once you've sent it."),
      say("Nobody is going cold this week."),
      resolveFromContext("Leo Park", "sent"),
      say("Logged the email to Leo as sent."),
    ]);
    await text(deps, "Draft a note to Leo about co-investing in Acme");
    await text(deps, "who's going cold?");
    expect(line.texts().at(-1)).toBe("Nobody is going cold this week.");

    await text(deps, "👍");
    expect(line.texts().at(-1)).toBe("Logged the email to Leo as sent.");
    const ask = String(model.requests[3].messages.at(-1)?.content);
    expect(ask).toContain("Drafts waiting for the owner to send");
    expect(ask.endsWith("👍")).toBe(true);
    const [d] = await getDb().select().from(pendingActions);
    expect(d.status).toBe("approved");
    const [i] = await getDb().select().from(interactions).where(eq(interactions.personId, leo));
    expect(i).toMatchObject({ type: "email", summary: `Sent: ${LEO_LINE}` });
    expect((await inboundRows()).at(-1)).toMatchObject({ kind: "chat", error: null });
  });

  it("with two drafts waiting, the model asks which one; the answer arrives with the question in history", async () => {
    const { leo, priya, line, model, deps } = await twoDraftsThenChat([
      say("Which one did you send: the email to Leo or the iMessage to Priya?"),
      resolveFromContext("Leo Park", "sent"),
      say("Logged the email to Leo as sent."),
    ]);
    await text(deps, "👍");
    expect(line.texts().at(-1)).toBe("Which one did you send: the email to Leo or the iMessage to Priya?");
    expect(await statuses()).toEqual({ [leo]: "pending", [priya]: "pending" });
    expect(await interactionCount()).toBe(0);

    await text(deps, "the one to Leo");
    expect(line.texts().at(-1)).toBe("Logged the email to Leo as sent.");
    const replay = model.requests[5].messages.map((m) => String(m.content)).join("\n");
    expect(replay).toContain("👍");
    expect(replay).toContain("Which one did you send");
    expect(await statuses()).toEqual({ [leo]: "approved", [priya]: "pending" });
  });

  it("a Liked tapback quoting the older draft approves that one, and a truncated Reacted 👍 quote the other", async () => {
    const { leo, priya, line, model, deps } = await twoDraftsThenChat();
    await text(deps, `Liked “${LEO_LINE}”`);
    expect(line.texts().at(-1)).toBe("Logged as sent to Leo Park.");
    expect(await statuses()).toEqual({ [leo]: "approved", [priya]: "pending" });
    const logged = await getDb().select().from(interactions);
    expect(logged.map((i) => [i.personId, i.type, i.summary])).toEqual([[leo, "email", `Sent: ${LEO_LINE}`]]);

    // Newer iOS relays reactions as "Reacted 👍 to “…”", and long quotes arrive cut off.
    await text(deps, "Reacted 👍 to “Hi Priya, sending the Fund I deck…”");
    expect(line.texts().at(-1)).toBe("Logged as sent to Priya Patel.");
    expect(await statuses()).toEqual({ [leo]: "approved", [priya]: "approved" });
    const [p] = await getDb().select().from(interactions).where(eq(interactions.personId, priya));
    expect(p).toMatchObject({ type: "message", summary: `Sent: ${PRIYA_BODY}` });
    expect(model.requests).toHaveLength(4);
  });

  it("'skip' with several drafts waiting goes to the model; a Disliked tapback drops one directly", async () => {
    const { leo, priya, line, model, deps } = await twoDraftsThenChat([say("Which one should I drop?")]);
    await text(deps, "skip");
    expect(line.texts().at(-1)).toBe("Which one should I drop?");
    expect(await statuses()).toEqual({ [leo]: "pending", [priya]: "pending" });
    await text(deps, `Disliked “${LEO_LINE}”`);
    expect(line.texts().at(-1)).toBe("Discarded the draft to Leo Park.");
    expect(await statuses()).toEqual({ [leo]: "rejected", [priya]: "pending" });
    expect(model.requests).toHaveLength(5);
  });

  it("'sent' resolves the draft the owner had been shown, not one created after they texted", async () => {
    const { leo, priya, line, deps } = await setup((p) => [
      draftLeo(p),
      say("Drafted an email to Leo."),
      draftPriya(p),
      say("Drafted a note to Priya."),
    ]);
    await text(deps, "Draft a note to Leo about Acme");
    expect(line.texts().at(-1)).toBe(LEO_BODY);
    // Two texts land before either is handled: a new request, then "sent" about Leo's email.
    const first = await receiveInbound(deps, inbound("also draft a note to Priya about the deck"));
    const second = await receiveInbound(deps, inbound("sent"));
    if (!("work" in first) || !("work" in second)) throw new Error("expected accepted");
    await first.work();
    await second.work();
    expect(line.texts().slice(-3)).toEqual(["Drafted a note to Priya.", PRIYA_BODY, "Logged as sent to Leo Park."]);
    expect(await statuses()).toEqual({ [leo]: "approved", [priya]: "pending" });
  });
});

describe("reactions and wording feedback (findings 5 and 29)", () => {
  it("a tapback on a normal agent reply is a reaction: no reply, no model call, kept out of history", async () => {
    const { line, model, deps } = await setup(() => [say("Logged coffee with Priya; deck reminder Friday."), say("That's all for now.")]);
    await text(deps, "Had coffee with Priya");
    const sent = line.sent.length;
    await text(deps, "Liked “Logged coffee with Priya; deck reminder Friday.”");
    await text(deps, "Reacted 👍 to “Logged coffee with Priya; deck reminder Friday.”");
    expect(line.sent).toHaveLength(sent);
    expect(model.requests).toHaveLength(1);
    const rows = (await inboundRows()).slice(-2);
    expect(rows.map((r) => [r.kind, r.error, r.processedAt !== null])).toEqual([
      ["reaction", null, true],
      ["reaction", null, true],
    ]);

    await text(deps, "anything else?");
    expect(line.texts().at(-1)).toBe("That's all for now.");
    const replay = model.requests[1].messages.map((m) => String(m.content)).join("\n");
    expect(replay).toContain("Logged coffee with Priya; deck reminder Friday.");
    expect(replay).not.toMatch(/Liked|Reacted/);
  });

  it("a tapback on the reply that came with a draft doesn't approve the draft", async () => {
    const { leo, line, model, deps } = await setup((p) => [draftLeo(p), say("Drafted an email to Leo about Acme. Tap 👍 once you've sent it.")]);
    await text(deps, "Draft a note to Leo about Acme");
    expect(line.texts().at(-1)).toBe(LEO_BODY); // the draft was the last thing shown
    const sent = line.sent.length;
    await text(deps, "Liked “Drafted an email to Leo about Acme. Tap 👍 once you've sent it.”");
    expect(line.sent).toHaveLength(sent);
    expect(model.requests).toHaveLength(2);
    expect(await statuses()).toEqual({ [leo]: "pending" });
    expect(await interactionCount()).toBe(0);
    expect((await inboundRows()).at(-1)?.kind).toBe("reaction");
  });

  it("👍 with no drafts waiting is a reaction: no reply and no model call", async () => {
    const { line, model, deps } = await setup(() => []);
    const sent = line.sent.length;
    await text(deps, "👍");
    await text(deps, "👍🏽");
    expect(line.sent).toHaveLength(sent);
    expect(model.requests).toHaveLength(0);
    expect((await inboundRows()).slice(-2).map((r) => r.kind)).toEqual(["reaction", "reaction"]);
    expect(await getDb().select().from(agentActions)).toHaveLength(0);
  });

  it.each(["looks good", "yes", "lgtm", "no"])("%s right after a draft goes to the model and leaves the draft pending", async (word) => {
    const { leo, line, model, deps } = await setup((p) => [draftLeo(p), say("Drafted an email to Leo. Tap 👍 once you've sent it."), say("Okay, it's ready whenever you are.")]);
    await text(deps, "Draft a note to Leo about Acme");
    expect(line.texts().at(-1)).toBe(LEO_BODY);
    await text(deps, word);
    expect(line.texts().at(-1)).toBe("Okay, it's ready whenever you are.");
    expect(model.requests).toHaveLength(3);
    expect(String(model.requests[2].messages.at(-1)?.content).endsWith(`\n\n${word}`)).toBe(true);
    expect(await statuses()).toEqual({ [leo]: "pending" });
    expect(await interactionCount()).toBe(0);
    expect((await inboundRows()).at(-1)?.kind).toBe("chat");
  });
});

describe("resolve_draft tool and the context block", () => {
  it("lists waiting drafts by short id, closes them by id (sent and discard), and undo reopens them", async () => {
    const d: Partial<Ids> = {};
    const { leo, priya, line, model, deps } = await setup((p) => [
      draftLeo(p),
      draftPriya(p),
      say("Drafted notes to Leo and Priya."),
      () => toolCall("resolve_draft", { draft_id: `[${shortId(d.leo!)}]`, action: "sent" }),
      say("Logged the Leo email."),
      () => calls(toolCall("resolve_draft", { draft_id: shortId(d.priya!), action: "discard" }), toolCall("resolve_draft", { draft_id: shortId(d.priya!), action: "discard" })),
      say("Dropped the Priya note."),
    ]);
    await text(deps, "Draft a note to Leo about Acme and send Priya the deck");
    d.leo = await draftId(leo);
    d.priya = await draftId(priya);
    const created = Object.fromEntries((await getDb().select().from(pendingActions)).map((r) => [r.id, localDate(r.createdAt, TZ)]));

    await text(deps, "I sent the Leo email");
    const context = String(model.requests[3].messages.at(-1)?.content);
    expect(context).toMatch(/^<context>/);
    expect(context).toContain(
      [
        "Drafts waiting for the owner to send (draft id, newest first):",
        `- [${shortId(d.priya)}] imessage to Priya Patel (${created[d.priya]}): "${PRIYA_BODY}…"`,
        `- [${shortId(d.leo)}] email to Leo Park (${created[d.leo]}): "${LEO_LINE}…"`,
      ].join("\n"),
    );
    expect(toolResults(model.requests[4])).toEqual(["Logged as sent to Leo Park."]);
    expect(line.texts().at(-1)).toBe("Logged the Leo email.");
    expect(await statuses()).toEqual({ [leo]: "approved", [priya]: "pending" });
    const [sentLog] = await getDb().select().from(interactions);
    expect(sentLog).toMatchObject({ personId: leo, type: "email", summary: `Sent: ${LEO_LINE}`, notes: LEO_BODY });
    const [resolved] = await getDb().select().from(agentActions).where(eq(agentActions.tool, "resolve_draft"));
    expect(resolved).toMatchObject({
      ok: true,
      input: { draft_id: `[${shortId(d.leo)}]`, action: "sent" },
      summary: "Logged the email you sent to Leo Park",
      undo: { kind: "unapprove_draft", id: d.leo, interactionId: sentLog.id },
    });

    await text(deps, "undo");
    expect(line.texts().at(-1)).toBe("Undid: Logged the email you sent to Leo Park.");
    expect(await statuses()).toEqual({ [leo]: "pending", [priya]: "pending" });
    expect(await interactionCount()).toBe(0);

    // Discarding twice: the second call is told the draft is no longer waiting.
    await text(deps, "drop the Priya one");
    expect(toolResults(model.requests[6])).toEqual(["Discarded the draft to Priya Patel.", "That draft is no longer waiting (already logged or discarded)."]);
    expect(await statuses()).toEqual({ [leo]: "pending", [priya]: "rejected" });
    await text(deps, "undo");
    expect(line.texts().at(-1)).toBe("Undid: Discarded the imessage draft to Priya Patel.");
    expect(await statuses()).toEqual({ [leo]: "pending", [priya]: "pending" });
    expect(model.remaining()).toBe(0);
  });
});

describe("draft bodies at rest (findings 23 and 43)", () => {
  it("keeps the draft body out of agent_actions.input and only encrypted in pending_actions", async () => {
    const { leo, line, deps } = await setup((p) => [draftLeo(p), say("Drafted an email to Leo. Tap 👍 once you've sent it.")]);
    await text(deps, "Draft a note to Leo about Acme");
    await text(deps, "👍");
    expect(line.texts().at(-1)).toBe("Logged as sent to Leo Park.");

    const actions = await getDb().select().from(agentActions).orderBy(asc(agentActions.createdAt));
    expect(actions.map((a) => a.tool)).toEqual(["draft_message", "approve_draft"]);
    expect(actions[0].input).toEqual({
      person_id: shortId(leo),
      channel: "email",
      intent: "Co-invest in Acme",
      body: `[${LEO_BODY.length} characters, not stored]`,
    });
    expect(JSON.stringify(actions)).not.toContain("co-invest in Acme's seed");

    const [draft] = await getDb().select().from(pendingActions);
    expect(draft.bodyEnc).not.toContain("Leo");
    expect(decrypt(draft.bodyEnc)).toBe(LEO_BODY);
    const shown = await getDb().select().from(channelMessages).where(eq(channelMessages.kind, "draft"));
    expect(shown).toHaveLength(1);
    expect(shown[0].bodyEnc).not.toContain("Leo");
    expect(decrypt(shown[0].bodyEnc)).toBe(LEO_BODY);
  });
});

describe("stale drafts (finding 4)", () => {
  /** Thursday 2026-09-24, 07:35 in New York: inside the brief window. */
  const THU_0735 = new Date("2026-09-24T11:35:00Z");

  it("drafts older than 7 days expire in the tick and stop the daily 'draft waiting' brief", async () => {
    actAs(OWNER);
    await updateSettings({ timezone: TZ, defaultCadences: {} });
    const leo = await createPerson({ fullName: "Leo Park" }); // no cadence, so never "needs attention"
    const line = new FakeLine();
    const deps = makeDeps(line, scriptedModel([new Error("model down")]).llm, THU_0735);
    const { code } = await createBindingCode(OWNER, "test", THU_0735);
    await text(deps, code);
    line.sent = [];
    const insertDraft = async (ageDays: number) => {
      const [row] = await getDb()
        .insert(pendingActions)
        .values({ userId: OWNER, personId: leo.id, channel: "email", bodyEnc: encrypt(LEO_BODY), createdAt: new Date(THU_0735.getTime() - ageDays * DAY) })
        .returning({ id: pendingActions.id });
      return row.id;
    };
    const statusOf = async (id: string) => (await getDb().select().from(pendingActions).where(eq(pendingActions.id, id)))[0];

    const stale = await insertDraft(8);
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: false, skipped: "nothing_due" }]);
    expect(await statusOf(stale)).toMatchObject({ status: "expired", resolvedAt: THU_0735 });
    expect(line.sent).toEqual([]);

    // A 6-day-old draft is still live, so the brief mentions it (and only it).
    const fresh = await insertDraft(6);
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: true }]);
    expect(line.texts()).toEqual(["Good morning. Thursday's brief:\n1 draft waiting for you to send."]);
    expect((await statusOf(fresh)).status).toBe("pending");
    expect((await statusOf(stale)).status).toBe("expired");
  });
});

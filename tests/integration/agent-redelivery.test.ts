import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitMessage, type AgentDeps } from "@/agent/runtime";
import { createBindingCode, NOT_DELIVERED, RESENT } from "@/agent/store";
import { runBriefTick } from "@/agent/tick";
import { shortId } from "@/agent/tools";
import { getDb } from "@/db/client";
import { channelMessages, interactions, pendingActions } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, makeDeps, OWNER_PHONE, say, scriptedModel, text, toolCall } from "./agent-harness";

/**
 * Redelivery: the tick re-sends, once and in order, whatever the provider failed
 * to deliver (a reply's parts and its drafts), unless the owner has since written
 * again and been answered. A re-send becomes a new message dated when it arrived.
 */

const OWNER = "owner-redelivery";
const NY = "America/New_York";
const DRAFT_BODY = "Subject: Deck\nHi Priya, here's the Fund I deck.";
const DRAFT_ASK = "Drafted an email to Priya. Tap 👍 once you've sent it.";
const GAVE_UP = `${NOT_DELIVERED} (gave up)`;
/** What the tick returns at 11am, after the brief window, with nothing else to do. */
const TICK = { userId: OWNER, sent: false, skipped: "window_passed" };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/** A line that fails the sends `failWhen` picks, and records every attempt. */
class FlakyLine extends FakeLine {
  failWhen: (body: string) => boolean = () => false;
  tried: string[] = [];
  override async sendText(to: string, body: string) {
    this.tried.push(body);
    if (this.failWhen(body)) throw new Error("provider down");
    return super.sendText(to, body);
  }
}

type Steps = Parameters<typeof scriptedModel>[0];

/** Seed Priya, bind the owner's phone, script the model, and record hand-offs. */
async function setup(steps: Steps | ((priya: string) => Steps), opts: { line?: FakeLine; delayMs?: number } = {}) {
  actAs(OWNER);
  await updateSettings({ timezone: NY, defaultCadences: {} });
  const priya = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"], company: "Halcyon" });
  const line = opts.line ?? new FakeLine();
  const model = scriptedModel(typeof steps === "function" ? steps(priya.id) : steps, { delayMs: opts.delayMs });
  const handOffs: string[] = [];
  const deps: AgentDeps = {
    ...makeDeps(line, model.llm),
    handOff: async (userId) => {
      handOffs.push(userId);
    },
  };
  const { code } = await createBindingCode(OWNER, "test", deps.now());
  expect((await text(deps, code)).status).toBe("bound");
  line.sent = [];
  if (line instanceof FlakyLine) line.tried = [];
  return { priya: priya.id, line, model, deps, handOffs };
}

async function msg(id: string) {
  const [r] = await getDb().select().from(channelMessages).where(eq(channelMessages.id, id));
  return { body: decrypt(r.bodyEnc), kind: r.kind, processed: r.processedAt !== null, error: r.error, providerMessageId: r.providerMessageId };
}

/** An outbound row an earlier run left `minutes` ago: undelivered unless `error` is null. */
async function sentEarlier(body: string, minutes: number, error: string | null = NOT_DELIVERED): Promise<string> {
  const at = minutesAgo(minutes);
  const [r] = await getDb()
    .insert(channelMessages)
    .values({ userId: OWNER, provider: "test", providerMessageId: error ? null : `early-${minutes}`, direction: "out", kind: "chat", bodyEnc: encrypt(body), readyAt: at, processedAt: at, createdAt: at, error })
    .returning({ id: channelMessages.id });
  return r.id;
}

/** An owner message, already answered, from `minutes` ago. */
async function ownerWroteEarlier(body: string, minutes: number): Promise<void> {
  const at = minutesAgo(minutes);
  await getDb()
    .insert(channelMessages)
    .values({ userId: OWNER, provider: "test", providerMessageId: `in-early-${minutes}`, direction: "in", kind: "chat", bodyEnc: encrypt(body), readyAt: at, processedAt: at, createdAt: at });
}

const outboundRows = () => getDb().select().from(channelMessages).where(eq(channelMessages.direction, "out"));

/** Move the binding code and welcome back two hours, so they neither supersede nor fall inside the re-send window. */
const ageEverything = () => getDb().update(channelMessages).set({ createdAt: minutesAgo(120) });

const draftStatuses = async () => (await getDb().select().from(pendingActions)).map((d) => d.status);

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(teardownDb);

describe("the tick re-sends replies the provider failed to deliver", () => {
  it("re-sends an undelivered reply from 10 minutes ago once, as a new message, and retires the original", async () => {
    const { line, deps } = await setup([]);
    await ageEverything();
    const id = await sentEarlier("Logged coffee with Priya.", 10);
    const before = new Date();

    expect(await runBriefTick(deps)).toEqual([{ ...TICK, redelivered: 1 }]);
    expect(line.sent).toEqual([{ to: OWNER_PHONE, text: "Logged coffee with Priya." }]);
    expect(await msg(id)).toMatchObject({ error: RESENT, providerMessageId: null });
    const copies = (await outboundRows()).filter((r) => r.id !== id && decrypt(r.bodyEnc) === "Logged coffee with Priya.");
    expect(copies).toHaveLength(1);
    // The copy is dated when it actually reached the owner, so history and "just shown" stay truthful.
    expect(copies[0]).toMatchObject({ kind: "chat", error: null, providerMessageId: expect.stringMatching(/^out-\d+$/) });
    expect(copies[0].createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);

    expect(await runBriefTick(deps)).toEqual([TICK]);
    expect(line.sent).toHaveLength(1);
  });

  it("leaves a reply superseded once the owner wrote again and got an answer, but re-sends one after that", async () => {
    const { line, deps } = await setup([]);
    await ageEverything();
    const superseded = await sentEarlier("Logged coffee with Priya.", 10);
    await ownerWroteEarlier("hello?", 9);
    await sentEarlier("Yes: coffee with Priya is logged.", 8, null);
    const after = await sentEarlier("Done: logged the intro to Leo.", 3);

    expect(await runBriefTick(deps)).toEqual([{ ...TICK, redelivered: 1 }]);
    expect(line.texts()).toEqual(["Done: logged the intro to Leo."]);
    expect(await msg(superseded)).toMatchObject({ error: NOT_DELIVERED, providerMessageId: null });
    expect(await msg(after)).toMatchObject({ error: RESENT });
  });

  it("a later message the owner didn't ask for (another part, a draft, a brief) doesn't supersede a reply", async () => {
    const { line, deps } = await setup([]);
    await ageEverything();
    await sentEarlier("Logged coffee with Priya.", 10);
    await sentEarlier("Good morning. Thursday's brief: 1 draft waiting.", 8, null);

    expect(await runBriefTick(deps)).toEqual([{ ...TICK, redelivered: 1 }]);
    expect(line.texts()).toEqual(["Logged coffee with Priya."]);
  });

  it("doesn't re-send a reply older than 30 minutes", async () => {
    const { line, deps } = await setup([]);
    await ageEverything();
    const old = await sentEarlier("Logged coffee with Priya.", 31);
    const recent = await sentEarlier("Reminder set: deck to Priya Friday.", 25);

    expect(await runBriefTick(deps)).toEqual([{ ...TICK, redelivered: 1 }]);
    expect(line.texts()).toEqual(["Reminder set: deck to Priya Friday."]);
    expect(await msg(old)).toMatchObject({ error: NOT_DELIVERED });
    expect(await msg(recent)).toMatchObject({ error: RESENT });
  });

  it("gives up after one failed re-send, never retries it, and history still says the owner never saw it", async () => {
    const line = new FlakyLine();
    const { model, deps } = await setup([say("I'm not sure it reached you: coffee with Priya is logged.")], { line });
    await ageEverything();
    const id = await sentEarlier("Logged coffee with Priya.", 10);
    line.failWhen = () => true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runBriefTick(deps)).toEqual([TICK]);
    expect(await msg(id)).toMatchObject({ error: GAVE_UP });
    line.failWhen = () => false;
    expect(await runBriefTick(deps)).toEqual([TICK]);
    expect(line.tried).toEqual(["Logged coffee with Priya."]); // one try in all
    expect(line.sent).toEqual([]);
    expect(await msg(id)).toMatchObject({ error: GAVE_UP });

    await text(deps, "did that save?");
    const replay = model.requests[0].messages.map((m) => String(m.content)).join("\n");
    expect(replay).toContain("[NOT delivered: the owner never saw this]\nLogged coffee with Priya.");
  });

  it("stops at a failed re-send and sends the later reply on the next tick, in order", async () => {
    const line = new FlakyLine();
    const { deps } = await setup([], { line });
    await ageEverything();
    const first = await sentEarlier("Logged coffee with Priya.", 20);
    const second = await sentEarlier("Reminder set: deck to Priya Friday.", 15);
    line.failWhen = (b) => b.startsWith("Logged");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runBriefTick(deps)).toEqual([TICK]);
    expect(line.tried).toEqual(["Logged coffee with Priya."]);
    expect(await msg(first)).toMatchObject({ error: GAVE_UP });
    expect(await msg(second)).toMatchObject({ error: NOT_DELIVERED });

    expect(await runBriefTick(deps)).toEqual([{ ...TICK, redelivered: 1 }]);
    expect(line.tried).toEqual(["Logged coffee with Priya.", "Reminder set: deck to Priya Friday."]);
    expect(line.texts()).toEqual(["Reminder set: deck to Priya Friday."]);
    expect(await msg(second)).toMatchObject({ error: RESENT });
  });

  it("a reply that failed during a turn arrives on the next tick and loses its NOT delivered label", async () => {
    const { line, model, deps } = await setup([say("Logged coffee with Priya."), say("Yes, it's logged.")]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    line.fail = true;
    await text(deps, "Had coffee with Priya");
    line.fail = false;
    expect(line.sent).toEqual([]);

    expect(await runBriefTick(deps)).toEqual([{ ...TICK, redelivered: 1 }]);
    expect(line.texts()).toEqual(["Logged coffee with Priya."]);
    await text(deps, "did that save?");
    expect(model.requests[1].messages.slice(1, -1)).toEqual([
      { role: "user", content: "Had coffee with Priya" },
      { role: "assistant", content: "Logged coffee with Priya." },
    ]);
    expect(line.texts()).toEqual(["Logged coffee with Priya.", "Yes, it's logged."]);
  });

  it("a long reply that failed during a turn reaches the owner whole on the next tick", async () => {
    const LONG = [`Priya: ${"keen on Fund I, wants the deck and the LPA. ".repeat(22).trim()}`, `Leo: ${"co-invest in Acme's seed if the round holds. ".repeat(22).trim()}`].join("\n\n");
    expect(splitMessage(LONG)).toHaveLength(2);
    const { line, deps } = await setup([say(LONG)]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    line.fail = true;
    await text(deps, "catch me up on Priya and Leo");
    line.fail = false;

    expect(await runBriefTick(deps)).toMatchObject([TICK]);
    expect(line.texts()).toEqual(splitMessage(LONG)); // both parts, in order, not just the first
  });
});

describe("a draft that never reached the owner", () => {
  const draftPriya = (priya: string) => toolCall("draft_message", { person_id: shortId(priya), channel: "email", intent: "Send the deck", body: DRAFT_BODY });
  const draftsFail = () => {
    const line = new FlakyLine();
    line.failWhen = (b) => b.startsWith("Subject:");
    return line;
  };

  it.each(["👍", "sent"])("%s after it goes to the model, which sees the draft labelled undelivered", async (word) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const line = draftsFail();
    const RESEND = "That draft never reached you. Want me to send it again?";
    const { model, deps } = await setup((priya) => [draftPriya(priya), say(DRAFT_ASK), say(RESEND)], { line });
    await text(deps, "Draft Priya a note with the deck");
    expect(line.texts()).toEqual([DRAFT_ASK]);

    await text(deps, word);
    expect(model.requests).toHaveLength(3);
    const ask = model.requests[2];
    expect(String(ask.messages.at(-1)?.content).endsWith(`\n\n${word}`)).toBe(true);
    expect(ask.messages.slice(1, -1)).toEqual([
      { role: "user", content: "Draft Priya a note with the deck" },
      { role: "assistant", content: `${DRAFT_ASK}\n\n[Draft NOT delivered: the owner never saw it]\n${DRAFT_BODY}` },
    ]);
    expect(line.texts()).toEqual([DRAFT_ASK, RESEND]);
    expect(await draftStatuses()).toEqual(["pending"]);
    expect(await getDb().select().from(interactions)).toHaveLength(0);
  });

  it("once the tick re-sends it, a 👍 logs it as sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const line = draftsFail();
    const { model, deps } = await setup((priya) => [draftPriya(priya), say(DRAFT_ASK)], { line });
    await text(deps, "Draft Priya a note with the deck");
    expect(line.texts()).toEqual([DRAFT_ASK]);

    line.failWhen = () => false;
    expect(await runBriefTick(deps)).toEqual([{ ...TICK, redelivered: 1 }]);
    expect(line.texts()).toEqual([DRAFT_ASK, DRAFT_BODY]);

    await text(deps, "👍");
    expect(line.texts().at(-1)).toBe("Logged as sent to Priya Patel.");
    expect(model.requests).toHaveLength(2);
    expect(await draftStatuses()).toEqual(["approved"]);
    expect(await getDb().select().from(interactions)).toHaveLength(1);
  });
});

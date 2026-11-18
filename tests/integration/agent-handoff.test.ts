import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/cron/drain/route";
import { HELP_TEXT } from "@/agent/commands";
import { defaultAgentDeps, drainOwner, drainQueue, MIN_TURN_MS, receiveInbound, type AgentDeps } from "@/agent/runtime";
import { createBindingCode, insertInbound, unbind } from "@/agent/store";
import { runBriefTick } from "@/agent/tick";
import { getDb } from "@/db/client";
import { channelMessages } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { runAsOwner } from "@/server/auth";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, inbound, makeDeps, OWNER_PHONE, say, scriptedModel, text } from "./agent-harness";

/**
 * Hand-off: a run out of budget hands the owner's queue to a fresh run (the
 * drain route). Redelivery by the tick is in agent-redelivery.test.ts.
 * `after()` needs a live request scope, so the drain route's background work is captured and run by hand.
 */
const afterTasks = vi.hoisted(() => [] as (() => Promise<void>)[]);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => {
    afterTasks.push(task);
  },
}));

const OWNER = "owner-handoff";
const NY = "America/New_York";
const SECRET = "cron-secret-for-tests";
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

/** A ready inbound message whose own webhook run never got to it. */
async function queued(body: string, userId = OWNER): Promise<string> {
  const id = await insertInbound({ userId, provider: "test", providerMessageId: `q-${Math.random().toString(36).slice(2)}`, body });
  return id!;
}

async function msg(id: string) {
  const [r] = await getDb().select().from(channelMessages).where(eq(channelMessages.id, id));
  return { body: decrypt(r.bodyEnc), kind: r.kind, processed: r.processedAt !== null, error: r.error, providerMessageId: r.providerMessageId };
}

beforeEach(async () => {
  actAs(OWNER);
  afterTasks.length = 0;
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(teardownDb);

describe("hand-off when a run's budget runs out", () => {
  it("hands the queue to a fresh run exactly once when there's no time left to start a turn", async () => {
    const { line, model, deps, handOffs } = await setup([]);
    const id = await queued("Had coffee with Priya");
    await runAsOwner(OWNER, "channel", () => drainQueue(deps, OWNER, OWNER_PHONE, Date.now() + MIN_TURN_MS - 2_000));

    expect(handOffs).toEqual([OWNER]);
    expect(model.requests).toHaveLength(0);
    expect(line.sent).toEqual([]);
    expect(await msg(id)).toMatchObject({ processed: false, error: null });
  });

  it("answers what fits, hands off the rest, and the fresh run answers it with the first reply in history", async () => {
    const { line, model, deps, handOffs } = await setup([say("Logged coffee with Priya."), say("Noted: deck to Priya Friday.")], { delayMs: 2_500 });
    const first = await queued("Had coffee with Priya");
    let lateId = "";
    const llm = deps.llm;
    deps.llm = async (req) => {
      if (!lateId) {
        // The owner's next text lands mid-turn; its own webhook run gave up waiting for the lock.
        const r = await receiveInbound(deps, inbound("she wants the deck Friday"));
        if (r.status !== "accepted") throw new Error(`expected accepted, got ${r.status}`);
        lateId = r.messageId;
      }
      return llm(req);
    };
    // Room for one turn; after it, less than MIN_TURN_MS is left.
    await runAsOwner(OWNER, "channel", () => drainQueue(deps, OWNER, OWNER_PHONE, Date.now() + MIN_TURN_MS + 1_000));

    expect(line.texts()).toEqual(["Logged coffee with Priya."]);
    expect(handOffs).toEqual([OWNER]);
    expect(await msg(first)).toMatchObject({ processed: true, error: null });
    expect(await msg(lateId)).toMatchObject({ processed: false, error: null });

    await drainOwner(deps, OWNER);
    expect(line.texts()).toEqual(["Logged coffee with Priya.", "Noted: deck to Priya Friday."]);
    expect(line.sent.map((s) => s.to)).toEqual([OWNER_PHONE, OWNER_PHONE]);
    expect(model.requests).toHaveLength(2);
    expect(String(model.requests[1].messages.at(-1)?.content).endsWith("\n\nshe wants the deck Friday")).toBe(true);
    expect(model.requests[1].messages.slice(1, -1)).toEqual([
      { role: "user", content: "Had coffee with Priya" },
      { role: "assistant", content: "Logged coffee with Priya." },
    ]);
    expect(await msg(lateId)).toMatchObject({ processed: true, error: null });
    expect(handOffs).toEqual([OWNER]); // the fresh run drained everything: no second hand-off
  });

  it("never hands off when the queue drained: a concurrent burst, then a command", async () => {
    const { line, model, deps, handOffs } = await setup([say("Logged coffee with Priya; deck reminder Friday.")], { delayMs: 100 });
    const a = await receiveInbound(deps, inbound("Had coffee with Priya"));
    const b = await receiveInbound(deps, inbound("she wants the deck Friday"));
    if (!("work" in a) || !("work" in b)) throw new Error("expected accepted");
    await Promise.all([a.work(), b.work()]);
    await text(deps, "help");

    expect(line.texts()).toEqual(["Logged coffee with Priya; deck reminder Friday.", HELP_TEXT]);
    expect(model.requests).toHaveLength(1);
    expect(handOffs).toEqual([]);
  });

  it("a hand-off that fails doesn't break the run; the message waits and the tick answers it", async () => {
    const { line, model, deps } = await setup([say("Noted: coffee with Priya.")]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handOff = vi.fn<(userId: string) => Promise<void>>(async () => {
      throw new Error("drain route unreachable");
    });
    deps.handOff = handOff;
    const id = await queued("Had coffee with Priya");

    await expect(runAsOwner(OWNER, "channel", () => drainQueue(deps, OWNER, OWNER_PHONE, Date.now() + MIN_TURN_MS - 2_000))).resolves.toBeUndefined();
    expect(handOff).toHaveBeenCalledOnce();
    expect(handOff).toHaveBeenCalledWith(OWNER);
    expect(line.sent).toEqual([]);
    expect(await msg(id)).toMatchObject({ processed: false, error: null });

    // Nothing was marked and the lock was released: once stale, the tick answers it.
    await getDb().update(channelMessages).set({ createdAt: minutesAgo(3), readyAt: minutesAgo(3) }).where(eq(channelMessages.id, id));
    expect(await runBriefTick(deps)).toEqual([{ ...TICK, recovered: 1 }]);
    expect(line.texts()).toEqual(["Noted: coffee with Priya."]);
    expect(model.requests).toHaveLength(1);
    expect(await msg(id)).toMatchObject({ processed: true, error: null });
    expect(handOff).toHaveBeenCalledOnce();
  });
});

describe("drainOwner (the hand-off's fresh run)", () => {
  it("answers a queued message for a verified owner, once", async () => {
    const { line, model, deps, handOffs } = await setup([say("Nobody is going cold this week.")]);
    const id = await queued("who's going cold?");
    await drainOwner(deps, OWNER);

    expect(line.sent).toEqual([{ to: OWNER_PHONE, text: "Nobody is going cold this week." }]);
    expect(String(model.requests[0].messages.at(-1)?.content).endsWith("\n\nwho's going cold?")).toBe(true);
    expect(await msg(id)).toMatchObject({ kind: "chat", processed: true, error: null });

    await drainOwner(deps, OWNER);
    expect(model.requests).toHaveLength(1);
    expect(line.sent).toHaveLength(1);
    expect(handOffs).toEqual([]);
  });

  it("does nothing for an unknown user, an unverified binding, or an owner who unbound", async () => {
    const { line, model, deps } = await setup([]);
    await drainOwner(deps, "nobody-at-all");

    const PENDING = "owner-pending";
    await createBindingCode(PENDING, "test", deps.now()); // code issued, never texted
    const pendingMsg = await queued("hello?", PENDING);
    await drainOwner(deps, PENDING);

    const ownerMsg = await queued("Had coffee with Priya");
    await unbind(OWNER);
    await drainOwner(deps, OWNER);

    expect(model.requests).toHaveLength(0);
    expect(line.sent).toEqual([]);
    expect(await msg(pendingMsg)).toMatchObject({ processed: false, error: null });
    expect(await msg(ownerMsg)).toMatchObject({ processed: false, error: null });
  });
});

describe("POST /api/cron/drain", () => {
  const post = (body: string, auth?: string) =>
    POST(
      new Request("https://rmos.example.com/api/cron/drain", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth === undefined ? {} : { authorization: auth }) },
        body,
      }),
    );
  const AUTH = `Bearer ${SECRET}`;

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("SENDBLUE_API_KEY_ID", "key-id");
    vi.stubEnv("SENDBLUE_API_SECRET", "key-secret");
    vi.stubEnv("SENDBLUE_SIGNING_SECRET", "signing-secret");
    vi.stubEnv("SENDBLUE_BASE_URL", "https://sendblue.test");
    vi.stubEnv("SENDBLUE_FROM_NUMBER", "");
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("VERCEL_URL", "");
  });

  it("401 without the bearer, with a wrong one, or when no secret is configured", async () => {
    const body = JSON.stringify({ userId: OWNER });
    for (const auth of [undefined, "Bearer wrong", SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`]) {
      const res = await post(body, auth);
      expect(res.status, String(auth)).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    vi.stubEnv("CRON_SECRET", "");
    expect((await post(body, "Bearer ")).status).toBe(401);
    expect(afterTasks).toHaveLength(0);
  });

  it("400 on bad JSON or a missing userId, 503 when the channel isn't configured", async () => {
    for (const body of ["{not json", "", "null"]) {
      const res = await post(body, AUTH);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid json" });
    }
    for (const body of ["{}", "[]", JSON.stringify({ userId: "" }), JSON.stringify({ userId: 42 }), JSON.stringify({ userId: "u".repeat(201) })]) {
      const res = await post(body, AUTH);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: "userId required" });
    }
    vi.stubEnv("SENDBLUE_API_KEY_ID", "");
    expect((await post(JSON.stringify({ userId: OWNER }), AUTH)).status).toBe(503);
    expect(afterTasks).toHaveLength(0);
  });

  it("202 at once, then drains that owner's queue in after()", async () => {
    const { model } = await setup([]);
    const id = await queued("help");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ message_handle: "sb-1", status: "QUEUED" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await post(JSON.stringify({ userId: OWNER }), AUTH);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(afterTasks).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled(); // responded before draining
    expect(await msg(id)).toMatchObject({ processed: false });

    await afterTasks[0]();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://sendblue.test/api/send-message");
    expect(JSON.parse(String(init?.body))).toEqual({ number: OWNER_PHONE, content: HELP_TEXT });
    expect(await msg(id)).toMatchObject({ kind: "command", processed: true, error: null });
    const [out] = await getDb().select().from(channelMessages).where(eq(channelMessages.provider, "sendblue"));
    expect(out).toMatchObject({ direction: "out", providerMessageId: "sb-1", error: null });
    expect(decrypt(out.bodyEnc)).toBe(HELP_TEXT);
    expect(model.requests).toHaveLength(0);
  });

  it("the default hand-off posts exactly what this route accepts, and rejects when the route refuses", async () => {
    vi.stubEnv("APP_URL", "https://rmos.example.com");
    const seen: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(req.clone());
      return POST(req);
    });
    const { handOff } = defaultAgentDeps(new FakeLine());
    expect(handOff).toBeDefined();

    await handOff!("owner-elsewhere");
    expect(seen.map((r) => [r.method, r.url, r.headers.get("authorization")])).toEqual([["POST", "https://rmos.example.com/api/cron/drain", AUTH]]);
    expect(await seen[0].json()).toEqual({ userId: "owner-elsewhere" });
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0](); // nobody bound: nothing to drain, and no error

    // The route refuses (secret rotated under a running instance): the hand-off rejects so the caller falls back to the tick.
    vi.stubEnv("CRON_SECRET", "rotated-secret");
    await expect(handOff!("owner-elsewhere")).rejects.toThrow(/401/);
    expect(afterTasks).toHaveLength(1);
  });
});

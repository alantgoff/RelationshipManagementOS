import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBindingCode, MAX_FAILURES_GLOBAL, MAX_FAILURES_PER_PHONE, redeemBindingCode, withOwnerLock } from "@/agent/store";
import { getDb } from "@/db/client";
import { agentTurns, bindingFailures, channelBindings, channelMessages } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, inbound, makeDeps, OWNER_PHONE, say, scriptedModel, text, THURSDAY_11AM_NY } from "./agent-harness";

/**
 * Concurrency regressions: per-owner locks must not starve their holders'
 * queries (the lock pool is separate from the query pool), one owner's work
 * never overlaps, and binding-code attempts are counted exactly under a burst.
 */

const OWNER = "owner-conc";
const NOW = THURSDAY_11AM_NY;

/** Rejects instead of hanging forever when the work deadlocks. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms (deadlock?)`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One query through the app's query pool that takes a little while. */
async function slowQuery(tag: string, seconds = 0.05): Promise<string> {
  const rows = await getDb().execute<{ tag: string }>(sql`select ${tag}::text as tag, pg_sleep(${sql.raw(String(seconds))})`);
  return rows[0].tag;
}

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
});
afterAll(teardownDb);

describe("withOwnerLock under load", () => {
  it("14 owners holding their locks at once all finish their queries (no pool deadlock)", async () => {
    const owners = Array.from({ length: 14 }, (_, k) => `owner-lock-${k}`);
    const started = Date.now();
    const results = await within(
      10_000,
      Promise.all(
        owners.map((o) =>
          withOwnerLock(o, 5_000, async () => {
            const tags: string[] = [];
            for (let q = 0; q < 5; q++) tags.push(await slowQuery(`${o}#${q}`));
            return tags;
          }),
        ),
      ),
    );
    expect(results).toEqual(owners.map((o) => [0, 1, 2, 3, 4].map((q) => `${o}#${q}`)));
    // Different owners are not serialized behind each other: far less than 14 × 5 × 50ms.
    expect(Date.now() - started).toBeLessThan(3_000);

    // Every lock was released: each owner can be locked again right away.
    const again = await within(5_000, Promise.all(owners.map((o) => withOwnerLock(o, 0, async () => o))));
    expect(again).toEqual(owners);
  });

  it("25 waiters on one owner: the holder finishes, one holder at a time, short waits give up with null", async () => {
    let inside = 0;
    let maxInside = 0;
    let shortRan = 0;
    const order: string[] = [];
    const hold = async (name: string, queries: number, seconds: number) => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      try {
        for (let q = 0; q < queries; q++) await slowQuery(`${name}#${q}`, seconds);
        order.push(name);
        return name;
      } finally {
        inside--;
      }
    };

    let entered!: () => void;
    const holderIn = new Promise<void>((r) => (entered = r));
    const holderStarted = Date.now();
    const holder = withOwnerLock(OWNER, 0, async () => {
      entered();
      return hold("holder", 8, 0.1);
    });
    await within(5_000, holderIn);

    // 15 give up quickly (two with no wait at all); 10 are willing to wait.
    const short = Array.from({ length: 15 }, (_, k) =>
      withOwnerLock(OWNER, k < 2 ? 0 : 100, async () => {
        shortRan++;
        return `short-${k}`;
      }),
    );
    const long = Array.from({ length: 10 }, (_, k) => withOwnerLock(OWNER, 15_000, () => hold(`long-${k}`, 2, 0.02)));

    expect(await within(5_000, Promise.all(short))).toEqual(Array(15).fill(null));
    expect(shortRan).toBe(0);
    expect(await within(5_000, holder)).toBe("holder");
    // The holder's own queries were never starved by the waiters.
    expect(Date.now() - holderStarted).toBeLessThan(3_000);

    const longResults = await within(15_000, Promise.all(long));
    expect(longResults).toEqual(Array.from({ length: 10 }, (_, k) => `long-${k}`));
    expect(order[0]).toBe("holder");
    expect(order).toHaveLength(11);
    expect(maxInside).toBe(1);
  });

  it("a holder that throws releases the lock for the next caller", async () => {
    await expect(
      withOwnerLock(OWNER, 0, async () => {
        await slowQuery("before-throw");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await within(5_000, withOwnerLock(OWNER, 0, async () => "next"))).toBe("next");
  });
});

describe("binding codes under a burst of concurrent guesses", () => {
  const wrongCodes = (n: number, ...avoid: string[]) => {
    const out: string[] = [];
    for (let k = 0; out.length < n; k++) {
      const g = String(k).padStart(6, "0");
      if (!avoid.includes(g)) out.push(g);
    }
    return out;
  };
  const phone = (k: number) => `+1555003${String(k).padStart(4, "0")}`;
  const failures = async () => getDb().select().from(bindingFailures);
  const binding = async (userId: string) => (await getDb().select().from(channelBindings).where(eq(channelBindings.userId, userId)))[0];

  it("20 concurrent wrong codes from one phone record exactly 5 failures; the right code is then refused there", async () => {
    const { code } = await createBindingCode(OWNER, "test", NOW);
    const attacker = phone(1);
    const results = await within(15_000, Promise.all(wrongCodes(20, code).map((g) => redeemBindingCode(g, attacker, NOW))));
    expect(results).toEqual(Array(20).fill(null));
    const rows = await failures();
    expect(rows).toHaveLength(MAX_FAILURES_PER_PHONE);
    expect(new Set(rows.map((r) => r.phoneHash)).size).toBe(1);

    expect(await redeemBindingCode(code, attacker, NOW)).toBeNull();
    expect(await failures()).toHaveLength(MAX_FAILURES_PER_PHONE);
    const b = await binding(OWNER);
    expect(b.phone).toBeNull();
    expect(b.verifiedAt).toBeNull();
    // Under the line-wide limit the code is still live for the owner's own phone.
    expect(b.pendingCodeHash).not.toBeNull();
    expect(await redeemBindingCode(code, OWNER_PHONE, NOW)).toBe(OWNER);
  });

  it("40 concurrent wrong codes from 40 phones record exactly 30 failures and revoke every pending code", async () => {
    const a = await createBindingCode(OWNER, "test", NOW);
    const b = await createBindingCode("owner-conc-2", "test", NOW);
    const guesses = wrongCodes(40, a.code, b.code);
    const results = await within(15_000, Promise.all(guesses.map((g, k) => redeemBindingCode(g, phone(100 + k), NOW))));
    expect(results).toEqual(Array(40).fill(null));
    expect(await failures()).toHaveLength(MAX_FAILURES_GLOBAL);

    const rows = await getDb().select().from(channelBindings).orderBy(asc(channelBindings.userId));
    expect(rows.map((r) => [r.userId, r.pendingCodeHash, r.codeExpiresAt, r.phone])).toEqual([
      [OWNER, null, null, null],
      ["owner-conc-2", null, null, null],
    ]);
    // The real codes are dead, even from numbers that never guessed.
    expect(await redeemBindingCode(a.code, OWNER_PHONE, NOW)).toBeNull();
    expect(await redeemBindingCode(b.code, phone(999), NOW)).toBeNull();
  });

  it("a correct code racing guesses still binds while under both limits", async () => {
    const a = await createBindingCode(OWNER, "test", NOW);
    const b = await createBindingCode("owner-conc-2", "test", NOW);
    const p = phone(7);
    // Four wrong codes from the same phone, and 25 from others, all at once with the right one.
    const wrong = wrongCodes(29, a.code, b.code);
    const attempts = [
      ...wrong.slice(0, MAX_FAILURES_PER_PHONE - 1).map((g) => redeemBindingCode(g, p, NOW)),
      redeemBindingCode(a.code, p, NOW),
      ...wrong.slice(MAX_FAILURES_PER_PHONE - 1).map((g, k) => redeemBindingCode(g, phone(200 + k), NOW)),
    ];
    const results = await within(15_000, Promise.all(attempts));
    expect(results.filter((r) => r !== null)).toEqual([OWNER]);
    expect(await failures()).toHaveLength(MAX_FAILURES_GLOBAL - 1);
    expect((await binding(OWNER)).phone).toBe(p);
    // 29 failures is under the line-wide limit: the other owner's code was not revoked.
    expect((await binding("owner-conc-2")).pendingCodeHash).not.toBeNull();
    expect(await redeemBindingCode(b.code, OWNER_PHONE, NOW)).toBe("owner-conc-2");
  });

  it("one code redeemed from two phones at once binds exactly one of them", async () => {
    const { code } = await createBindingCode(OWNER, "test", NOW);
    const results = await within(5_000, Promise.all([redeemBindingCode(code, phone(1), NOW), redeemBindingCode(code, phone(2), NOW)]));
    expect(results.filter((r) => r === OWNER)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    const winner = results[0] === OWNER ? phone(1) : phone(2);
    expect((await binding(OWNER)).phone).toBe(winner);
    expect(await failures()).toHaveLength(1);
  });

  it("one phone redeeming two owners' codes at once binds to exactly one owner, without an error", async () => {
    const a = await createBindingCode(OWNER, "test", NOW);
    const b = await createBindingCode("owner-conc-2", "test", NOW);
    const p = phone(3);
    const results = await within(5_000, Promise.all([redeemBindingCode(a.code, p, NOW), redeemBindingCode(b.code, p, NOW)]));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const winner = results.find((r) => r !== null)!;
    const loser = winner === OWNER ? "owner-conc-2" : OWNER;
    expect((await binding(winner)).phone).toBe(p);
    const lost = await binding(loser);
    expect(lost.phone).toBeNull();
    expect(lost.pendingCodeHash).not.toBeNull();
    expect(await failures()).toHaveLength(1);
  });
});

describe("concurrent webhook runs", () => {
  async function bind(deps: ReturnType<typeof makeDeps>, line: FakeLine, userId: string, from: string) {
    const { code } = await createBindingCode(userId, "test", deps.now());
    expect((await text(deps, inbound(code, { from }))).status).toBe("bound");
    line.sent = [];
  }
  const inboundRows = async () =>
    (await getDb().select().from(channelMessages).where(eq(channelMessages.direction, "in")).orderBy(asc(channelMessages.createdAt))).map(
      (r) => ({ userId: r.userId, body: decrypt(r.bodyEnc), kind: r.kind, processed: r.processedAt !== null, error: r.error }),
    );

  it("two texts from the same owner arriving at once are answered one turn at a time, each exactly once", async () => {
    const line = new FakeLine();
    const model = scriptedModel([say("Reply one."), say("Reply two.")], { delayMs: 150 });
    const deps = makeDeps(line, model.llm);
    await bind(deps, line, OWNER, OWNER_PHONE);

    const runs = await within(15_000, Promise.all([text(deps, "first text"), text(deps, "second text")]));
    expect(runs.map((r) => r.status)).toEqual(["accepted", "accepted"]);

    expect(model.maxInFlight()).toBe(1);
    const turns = model.requests.length;
    expect([1, 2]).toContain(turns);
    expect(line.texts()).toEqual(["Reply one.", "Reply two."].slice(0, turns));
    expect(line.sent.every((s) => s.to === OWNER_PHONE)).toBe(true);
    expect(await getDb().select().from(agentTurns)).toHaveLength(turns);
    // Each text is the new message of exactly one model call.
    const asked = model.requests.map((r) => String(r.messages.at(-1)?.content)).join("\n---\n");
    expect(asked.split("first text")).toHaveLength(2);
    expect(asked.split("second text")).toHaveLength(2);
    const rows = (await inboundRows()).filter((r) => r.kind !== "command");
    expect(rows.map((r) => [r.body, r.processed, r.error]).sort()).toEqual([
      ["first text", true, null],
      ["second text", true, null],
    ]);
  });

  it("two different owners are not serialized behind each other", async () => {
    const OTHER = "owner-conc-2";
    const OTHER_PHONE = "+14155550777";
    const line = new FakeLine();
    const model = scriptedModel([say("Noted."), say("Noted.")], { delayMs: 300 });
    const deps = makeDeps(line, model.llm);
    await bind(deps, line, OWNER, OWNER_PHONE);
    await bind(deps, line, OTHER, OTHER_PHONE);

    await within(15_000, Promise.all([text(deps, "from the owner"), text(deps, inbound("from the other owner", { from: OTHER_PHONE }))]));
    expect(model.requests).toHaveLength(2);
    expect(model.maxInFlight()).toBe(2);
    expect(line.sent.map((s) => s.to).sort()).toEqual([OTHER_PHONE, OWNER_PHONE].sort());
    const rows = (await inboundRows()).filter((r) => r.kind !== "command");
    const byOwner = Object.fromEntries(rows.map((r) => [r.userId, [r.body, r.processed, r.error]]));
    expect(rows).toHaveLength(2);
    expect(byOwner).toEqual({ [OWNER]: ["from the owner", true, null], [OTHER]: ["from the other owner", true, null] });
  });
});

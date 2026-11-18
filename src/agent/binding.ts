import { createHmac, randomInt } from "node:crypto";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { bindingFailures, channelBindings, type ChannelBinding } from "@/db/schema";

/**
 * Phone binding: the owner generates a 6-digit code in Settings and texts it
 * to the line. Codes are single use, expire, and are rate limited per number
 * and across the line. Attempts are serialized by an advisory lock, so a burst
 * of concurrent guesses can't all pass the limit check before any is counted.
 */

export const BINDING_CODE_TTL_MS = 15 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
/** Failed code attempts allowed per unknown number per window. */
export const MAX_FAILURES_PER_PHONE = 5;
/** Failed attempts across all numbers per window before every pending code is revoked. */
export const MAX_FAILURES_GLOBAL = 30;

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

function pepper(): string {
  const key = process.env.RMOS_ENCRYPTION_KEY;
  if (!key) throw new Error("RMOS_ENCRYPTION_KEY is not set");
  return key;
}

function codeHash(code: string): string {
  return createHmac("sha256", pepper()).update(`bind:${code}`).digest("hex");
}

function phoneHash(phone: string): string {
  return createHmac("sha256", pepper()).update(`phone:${phone}`).digest("hex");
}

const liveCode = (hash: string, now: Date) =>
  and(eq(channelBindings.pendingCodeHash, hash), sql`${channelBindings.codeExpiresAt} > ${now.toISOString()}::timestamptz`);

/**
 * Create (or replace) a 6-digit code the owner texts to the line to bind their
 * phone. Never one that another owner's live code already uses, so a code
 * always names exactly one account.
 */
export async function createBindingCode(userId: string, provider: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + BINDING_CODE_TTL_MS);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agent:binding'))`);
    for (let attempt = 0; ; attempt++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const hash = codeHash(code);
      const [taken] = await tx
        .select({ userId: channelBindings.userId })
        .from(channelBindings)
        .where(and(liveCode(hash, now), sql`${channelBindings.userId} <> ${userId}`))
        .limit(1);
      if (taken && attempt < 50) continue;
      if (taken) throw new Error("could not find a free binding code");
      await tx
        .insert(channelBindings)
        .values({ userId, provider, pendingCodeHash: hash, codeExpiresAt: expiresAt })
        .onConflictDoUpdate({ target: channelBindings.userId, set: { provider, pendingCodeHash: hash, codeExpiresAt: expiresAt, updatedAt: now } });
      return { code, expiresAt };
    }
  });
}

/** True when this unknown number, or the line as a whole, has failed too many codes recently. */
async function bindingThrottled(tx: Tx, phone: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - FAILURE_WINDOW_MS);
  const [mine] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(bindingFailures)
    .where(and(eq(bindingFailures.phoneHash, phoneHash(phone)), gte(bindingFailures.createdAt, since)));
  if (Number(mine?.n ?? 0) >= MAX_FAILURES_PER_PHONE) return true;
  const [all] = await tx.select({ n: sql<number>`count(*)` }).from(bindingFailures).where(gte(bindingFailures.createdAt, since));
  return Number(all?.n ?? 0) >= MAX_FAILURES_GLOBAL;
}

async function recordBindingFailure(tx: Tx, phone: string, now: Date): Promise<void> {
  await tx.insert(bindingFailures).values({ phoneHash: phoneHash(phone), createdAt: now });
  const since = new Date(now.getTime() - FAILURE_WINDOW_MS);
  const [all] = await tx.select({ n: sql<number>`count(*)` }).from(bindingFailures).where(gte(bindingFailures.createdAt, since));
  if (Number(all?.n ?? 0) >= MAX_FAILURES_GLOBAL) {
    // Someone is guessing: revoke every live code; owners generate a new one in Settings.
    await tx.update(channelBindings).set({ pendingCodeHash: null, codeExpiresAt: null }).where(isNotNull(channelBindings.pendingCodeHash));
  }
}

/**
 * Bind `phone` to whoever generated `code`, if the code is live. Single use,
 * rate limited per number and globally. A phone already bound to another
 * account is not moved.
 */
export async function redeemBindingCode(code: string, phone: string, now = new Date()): Promise<string | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const hash = codeHash(code);
  return getDb().transaction(async (tx) => {
    // One attempt at a time across the line: check, redeem and count as a unit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agent:binding'))`);
    if (await bindingThrottled(tx, phone, now)) return null;
    // createBindingCode keeps live codes unique; if two ever matched, bind neither.
    const matches = await tx.select().from(channelBindings).where(liveCode(hash, now)).limit(2);
    const pending = matches.length === 1 ? matches[0] : null;
    let userId: string | null = null;
    if (pending) {
      const [owner] = await tx.select({ userId: channelBindings.userId }).from(channelBindings).where(eq(channelBindings.phone, phone));
      if (!owner || owner.userId === pending.userId) {
        const updated = await tx
          .update(channelBindings)
          .set({ phone, verifiedAt: now, pendingCodeHash: null, codeExpiresAt: null, updatedAt: now })
          .where(and(eq(channelBindings.userId, pending.userId), eq(channelBindings.pendingCodeHash, hash)))
          .returning({ userId: channelBindings.userId });
        userId = updated[0]?.userId ?? null;
      }
    }
    if (!userId) await recordBindingFailure(tx, phone, now);
    return userId;
  });
}

export async function findOwnerByPhone(phone: string): Promise<ChannelBinding | null> {
  const [row] = await getDb()
    .select()
    .from(channelBindings)
    .where(and(eq(channelBindings.phone, phone), isNotNull(channelBindings.verifiedAt)));
  return row ?? null;
}

export async function getBinding(userId: string): Promise<ChannelBinding | null> {
  const [row] = await getDb().select().from(channelBindings).where(eq(channelBindings.userId, userId));
  return row ?? null;
}

export async function listVerifiedBindings(): Promise<ChannelBinding[]> {
  return getDb().select().from(channelBindings).where(isNotNull(channelBindings.verifiedAt));
}

export async function unbind(userId: string): Promise<void> {
  await getDb().delete(channelBindings).where(eq(channelBindings.userId, userId));
}

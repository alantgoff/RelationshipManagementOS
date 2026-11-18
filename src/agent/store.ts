import { createHmac, randomInt } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  bindingFailures,
  channelBindings,
  channelMessages,
  notificationLog,
  pendingActions,
  people,
  userSettings,
  type ChannelBinding,
  type StoredMedia,
} from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { localDate, safeTimeZone } from "@/lib/time";

/**
 * Persistence for the headless agent: phone binding, the encrypted message
 * log, agent preferences and the unprompted-message budget. Functions take an
 * explicit userId because webhook code runs before the owner is known.
 *
 * Inbound message lifecycle: received (row inserted) → ready (attachments
 * processed, body holds the full text) → processed (reply sent, or failed
 * with `error`). Anything stuck before "processed" is picked up by the tick.
 */

export const BINDING_CODE_TTL_MS = 15 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
/** Failed code attempts allowed per unknown number per window. */
export const MAX_FAILURES_PER_PHONE = 5;
/** Failed attempts across all numbers per window before every pending code is revoked. */
export const MAX_FAILURES_GLOBAL = 30;

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

/** Create (or replace) a 6-digit code the owner texts to the line to bind their phone. */
export async function createBindingCode(userId: string, provider: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + BINDING_CODE_TTL_MS);
  await getDb()
    .insert(channelBindings)
    .values({ userId, provider, pendingCodeHash: codeHash(code), codeExpiresAt: expiresAt })
    .onConflictDoUpdate({
      target: channelBindings.userId,
      set: { provider, pendingCodeHash: codeHash(code), codeExpiresAt: expiresAt, updatedAt: now },
    });
  return { code, expiresAt };
}

/** True when this unknown number, or the line as a whole, has failed too many codes recently. */
async function bindingThrottled(phone: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - FAILURE_WINDOW_MS);
  const db = getDb();
  const [mine] = await db
    .select({ n: sql<number>`count(*)` })
    .from(bindingFailures)
    .where(and(eq(bindingFailures.phoneHash, phoneHash(phone)), gte(bindingFailures.createdAt, since)));
  if (Number(mine?.n ?? 0) >= MAX_FAILURES_PER_PHONE) return true;
  const [all] = await db.select({ n: sql<number>`count(*)` }).from(bindingFailures).where(gte(bindingFailures.createdAt, since));
  return Number(all?.n ?? 0) >= MAX_FAILURES_GLOBAL;
}

async function recordBindingFailure(phone: string, now: Date): Promise<void> {
  const db = getDb();
  await db.insert(bindingFailures).values({ phoneHash: phoneHash(phone), createdAt: now });
  const since = new Date(now.getTime() - FAILURE_WINDOW_MS);
  const [all] = await db.select({ n: sql<number>`count(*)` }).from(bindingFailures).where(gte(bindingFailures.createdAt, since));
  if (Number(all?.n ?? 0) >= MAX_FAILURES_GLOBAL) {
    // Someone is guessing: revoke every live code; owners generate a new one in Settings.
    await db.update(channelBindings).set({ pendingCodeHash: null, codeExpiresAt: null }).where(isNotNull(channelBindings.pendingCodeHash));
  }
}

/**
 * Bind `phone` to whoever generated `code`, if the code is live. Single use,
 * rate limited per number and globally. A phone already bound to another
 * account is not moved.
 */
export async function redeemBindingCode(code: string, phone: string, now = new Date()): Promise<string | null> {
  if (!/^\d{6}$/.test(code)) return null;
  if (await bindingThrottled(phone, now)) return null;
  const hash = codeHash(code);
  const db = getDb();
  const userId = await db.transaction(async (tx) => {
    const [pending] = await tx
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.pendingCodeHash, hash), sql`${channelBindings.codeExpiresAt} > ${now.toISOString()}::timestamptz`))
      .limit(1);
    if (!pending) return null;
    const [owner] = await tx.select({ userId: channelBindings.userId }).from(channelBindings).where(eq(channelBindings.phone, phone));
    if (owner && owner.userId !== pending.userId) return null;
    // Conditional on the code still being pending, so two concurrent redeems can't both win.
    const updated = await tx
      .update(channelBindings)
      .set({ phone, verifiedAt: now, pendingCodeHash: null, codeExpiresAt: null, updatedAt: now })
      .where(and(eq(channelBindings.userId, pending.userId), eq(channelBindings.pendingCodeHash, hash)))
      .returning({ userId: channelBindings.userId });
    return updated[0]?.userId ?? null;
  });
  if (!userId) await recordBindingFailure(phone, now);
  return userId;
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

/* ───────────── Per-owner serialization ───────────── */

/**
 * Run `fn` while holding a per-owner Postgres advisory lock, so one owner's
 * turns never overlap. Waits up to `waitMs`; returns null if the lock wasn't
 * free in time (whoever holds it will pick up this owner's ready messages).
 */
export async function withOwnerLock<T>(userId: string, waitMs: number, fn: () => Promise<T>): Promise<T | null> {
  const key = `agent:${userId}`;
  const giveUpAt = Date.now() + Math.max(0, waitMs);
  return getDb().transaction(async (tx) => {
    for (;;) {
      const [row] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${key})) as locked`);
      if (row?.locked) return fn();
      if (Date.now() >= giveUpAt) return null;
      await new Promise((r) => setTimeout(r, 250));
    }
  });
}

/* ───────────── Messages ───────────── */

export interface StoredMessage {
  id: string;
  direction: "in" | "out";
  kind: string;
  body: string;
  media: StoredMedia[];
  createdAt: Date;
}

/**
 * Insert an inbound message once. Returns null if this provider message id was
 * already stored (HA-3). Text-only messages are ready immediately; pass
 * `ready: false` when attachments still need processing, and `processed: true`
 * for messages handled on the spot (binding codes).
 */
export async function insertInbound(args: {
  userId: string;
  provider: string;
  providerMessageId: string;
  body: string;
  kind?: string;
  ready?: boolean;
  processed?: boolean;
  createdAt?: Date;
}): Promise<string | null> {
  const rows = await getDb()
    .insert(channelMessages)
    .values({
      userId: args.userId,
      provider: args.provider,
      providerMessageId: args.providerMessageId,
      direction: "in",
      kind: args.kind ?? "chat",
      bodyEnc: encrypt(args.body),
      ...(args.ready === false ? { readyAt: null } : {}),
      ...(args.processed ? { processedAt: new Date() } : {}),
      ...(args.createdAt ? { createdAt: args.createdAt, ...(args.ready === false ? {} : { readyAt: args.createdAt }) } : {}),
    })
    .onConflictDoNothing({ target: [channelMessages.provider, channelMessages.providerMessageId] })
    .returning({ id: channelMessages.id });
  return rows[0]?.id ?? null;
}

/** Store the full text (owner text plus attachment text, encrypted) and mark the message ready. */
export async function markReady(messageId: string, body: string, media: StoredMedia[]): Promise<void> {
  await getDb()
    .update(channelMessages)
    .set({ bodyEnc: encrypt(body), media, readyAt: new Date() })
    .where(eq(channelMessages.id, messageId));
}

/** Record an outbound message. `error` marks one that never reached the owner (kept so history stays truthful). */
export async function insertOutbound(args: {
  userId: string;
  provider: string;
  providerMessageId?: string;
  body: string;
  kind: string;
  error?: string;
}): Promise<string> {
  const [row] = await getDb()
    .insert(channelMessages)
    .values({
      userId: args.userId,
      provider: args.provider,
      providerMessageId: args.providerMessageId ?? null,
      direction: "out",
      kind: args.kind,
      bodyEnc: encrypt(args.body),
      readyAt: new Date(),
      processedAt: new Date(),
      error: args.error ?? null,
    })
    .returning({ id: channelMessages.id });
  return row.id;
}

/** Mark inbound messages done (or failed). Called after the reply is sent. */
export async function markProcessed(messageIds: string[], update: { kind?: string; error?: string | null } = {}): Promise<void> {
  if (messageIds.length === 0) return;
  await getDb()
    .update(channelMessages)
    .set({
      processedAt: new Date(),
      ...(update.kind ? { kind: update.kind } : {}),
      ...(update.error !== undefined ? { error: update.error } : {}),
    })
    .where(inArray(channelMessages.id, messageIds));
}

function toStored(row: typeof channelMessages.$inferSelect): StoredMessage {
  let body: string;
  try {
    body = decrypt(row.bodyEnc);
  } catch {
    body = "[unreadable message]";
  }
  return { id: row.id, direction: row.direction, kind: row.kind, body, media: row.media, createdAt: row.createdAt };
}

/** Ready, unprocessed inbound messages for an owner, oldest first. */
export async function readyUnprocessed(userId: string): Promise<StoredMessage[]> {
  const rows = await getDb()
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.userId, userId),
        eq(channelMessages.direction, "in"),
        isNull(channelMessages.processedAt),
        isNull(channelMessages.error),
        isNotNull(channelMessages.readyAt),
      ),
    )
    .orderBy(asc(channelMessages.createdAt), asc(channelMessages.id));
  return rows.map(toStored);
}

/** Inbound messages received before `olderThan` that never finished, oldest first. */
export async function stuckInbound(userId: string, olderThan: Date): Promise<(StoredMessage & { ready: boolean })[]> {
  const rows = await getDb()
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.userId, userId),
        eq(channelMessages.direction, "in"),
        isNull(channelMessages.processedAt),
        isNull(channelMessages.error),
        lt(channelMessages.createdAt, olderThan),
      ),
    )
    .orderBy(asc(channelMessages.createdAt));
  return rows.map((r) => ({ ...toStored(r), ready: r.readyAt !== null }));
}

/** The most recent messages, oldest first. */
export async function recentMessages(userId: string, limit: number, opts: { before?: Date; kinds?: string[] } = {}): Promise<StoredMessage[]> {
  const where = [eq(channelMessages.userId, userId)];
  if (opts.before) where.push(lt(channelMessages.createdAt, opts.before));
  if (opts.kinds?.length) where.push(inArray(channelMessages.kind, opts.kinds));
  const rows = await getDb()
    .select()
    .from(channelMessages)
    .where(and(...where))
    .orderBy(desc(channelMessages.createdAt), desc(channelMessages.id))
    .limit(limit);
  return rows.reverse().map(toStored);
}

/** created_at has microseconds but JS Dates have milliseconds; compare at millisecond precision. */
const afterCursor = (after: Date) => sql`date_trunc('milliseconds', ${channelMessages.createdAt}) > ${after.toISOString()}::timestamptz`;

function conversationWhere(userId: string, after: Date | null, before: Date | null, kinds: string[]) {
  const where = [eq(channelMessages.userId, userId), inArray(channelMessages.kind, kinds), isNotNull(channelMessages.readyAt)];
  if (after) where.push(afterCursor(after));
  if (before) where.push(lt(channelMessages.createdAt, before));
  return and(...where);
}

/**
 * Conversation messages after the summary cursor (exclusive) and before
 * `before` (exclusive), returned oldest first. `take: "newest"` keeps the
 * newest `limit` (for replay); `take: "oldest"` the oldest (for folding).
 */
export async function conversationSince(
  userId: string,
  after: Date | null,
  before: Date | null,
  kinds: string[],
  limit: number,
  take: "newest" | "oldest" = "newest",
): Promise<StoredMessage[]> {
  const rows = await getDb()
    .select()
    .from(channelMessages)
    .where(conversationWhere(userId, after, before, kinds))
    .orderBy(
      ...(take === "newest"
        ? [desc(channelMessages.createdAt), desc(channelMessages.id)]
        : [asc(channelMessages.createdAt), asc(channelMessages.id)]),
    )
    .limit(limit);
  return (take === "newest" ? rows.reverse() : rows).map(toStored);
}

export async function countConversationSince(userId: string, after: Date | null, kinds: string[]): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(channelMessages)
    .where(conversationWhere(userId, after, null, kinds));
  return Number(row?.n ?? 0);
}

/** Kind of the agent's latest message sent before `before`, if any. */
export async function lastOutboundKind(userId: string, before: Date): Promise<string | null> {
  const [row] = await getDb()
    .select({ kind: channelMessages.kind })
    .from(channelMessages)
    .where(and(eq(channelMessages.userId, userId), eq(channelMessages.direction, "out"), lt(channelMessages.createdAt, before)))
    .orderBy(desc(channelMessages.createdAt), desc(channelMessages.id))
    .limit(1);
  return row?.kind ?? null;
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  const [row] = await getDb().select().from(channelMessages).where(eq(channelMessages.id, id));
  return row ? toStored(row) : null;
}

/* ───────────── Drafts ───────────── */

export const DRAFT_TTL_DAYS = 7;

export interface PendingDraft {
  id: string;
  personId: string;
  name: string;
  channel: string;
  body: string;
  createdAt: Date;
}

/** Pending drafts, newest first. */
export async function pendingDrafts(userId: string): Promise<PendingDraft[]> {
  const rows = await getDb()
    .select({
      id: pendingActions.id,
      personId: pendingActions.personId,
      channel: pendingActions.channel,
      bodyEnc: pendingActions.bodyEnc,
      createdAt: pendingActions.createdAt,
      name: people.fullName,
    })
    .from(pendingActions)
    .innerJoin(people, eq(people.id, pendingActions.personId))
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, "pending")))
    .orderBy(desc(pendingActions.createdAt), desc(pendingActions.id));
  return rows.map((r) => {
    let body = "";
    try {
      body = decrypt(r.bodyEnc);
    } catch {
      body = "";
    }
    return { id: r.id, personId: r.personId, name: r.name, channel: r.channel, body, createdAt: r.createdAt };
  });
}

/** Expire drafts nobody acted on within DRAFT_TTL_DAYS. */
export async function expireOldDrafts(userId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DRAFT_TTL_DAYS * 86_400_000);
  const rows = await getDb()
    .update(pendingActions)
    .set({ status: "expired", resolvedAt: now })
    .where(and(eq(pendingActions.userId, userId), eq(pendingActions.status, "pending"), lt(pendingActions.createdAt, cutoff)))
    .returning({ id: pendingActions.id });
  return rows.length;
}

/* ───────────── Agent preferences and budget ───────────── */

export interface AgentPrefs {
  timezone: string;
  proactiveEnabled: boolean;
  pausedUntil: Date | null;
  briefTime: string;
  quietStart: string;
  quietEnd: string;
  dailyUnpromptedLimit: number;
}

export async function getAgentPrefs(userId: string): Promise<AgentPrefs> {
  const [row] = await getDb().select().from(userSettings).where(eq(userSettings.userId, userId));
  return {
    timezone: safeTimeZone(row?.timezone),
    proactiveEnabled: row?.proactiveEnabled ?? true,
    pausedUntil: row?.pausedUntil ?? null,
    briefTime: row?.briefTime ?? "07:30",
    quietStart: row?.quietStart ?? "21:00",
    quietEnd: row?.quietEnd ?? "07:00",
    dailyUnpromptedLimit: row?.dailyUnpromptedLimit ?? 3,
  };
}

export async function updateAgentPrefs(
  userId: string,
  patch: Partial<Pick<AgentPrefs, "proactiveEnabled" | "pausedUntil" | "briefTime" | "quietStart" | "quietEnd" | "dailyUnpromptedLimit">>,
): Promise<void> {
  await getDb()
    .insert(userSettings)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: userSettings.userId, set: { ...patch, updatedAt: new Date() } });
}

/** Unprompted messages already sent on the owner's local date. */
export async function unpromptedCountToday(userId: string, now: Date, tz: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(notificationLog)
    .where(and(eq(notificationLog.userId, userId), eq(notificationLog.localDate, localDate(now, tz))));
  return Number(row?.n ?? 0);
}

/**
 * Claim today's brief slot before composing it, so two overlapping cron ticks
 * can't both send. Returns null if another tick already claimed it.
 */
export async function claimBriefSlot(userId: string, now: Date, tz: string): Promise<string | null> {
  const rows = await getDb()
    .insert(notificationLog)
    .values({ userId, kind: "brief", localDate: localDate(now, tz), sentAt: now })
    .onConflictDoNothing()
    .returning({ id: notificationLog.id });
  return rows[0]?.id ?? null;
}

export async function attachNotificationMessage(logId: string, messageId: string): Promise<void> {
  await getDb().update(notificationLog).set({ messageId }).where(eq(notificationLog.id, logId));
}

export async function releaseNotification(logId: string): Promise<void> {
  await getDb().delete(notificationLog).where(eq(notificationLog.id, logId));
}

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, getLockClient } from "@/db/client";
import { channelMessages, notificationLog, pendingActions, people, userSettings, type StoredMedia } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { localDate, safeTimeZone } from "@/lib/time";

/**
 * Persistence for the headless agent: the encrypted message log, per-owner
 * serialization, drafts, agent preferences and the unprompted-message budget.
 * Functions take an explicit userId because webhook code runs before the
 * owner is known. Phone binding lives in ./binding (re-exported here).
 *
 * Inbound message lifecycle: received (row inserted) → ready (attachments
 * processed, body holds the full text) → processed (reply sent, or failed
 * with `error`). Anything stuck before "processed" is picked up by the tick.
 */

export {
  BINDING_CODE_TTL_MS,
  MAX_FAILURES_GLOBAL,
  MAX_FAILURES_PER_PHONE,
  createBindingCode,
  findOwnerByPhone,
  getBinding,
  listVerifiedBindings,
  redeemBindingCode,
  unbind,
} from "./binding";

/* ───────────── Per-owner serialization ───────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding a per-owner Postgres advisory lock, so one owner's
 * turns never overlap. Waits up to `waitMs`; returns null if the lock wasn't
 * free in time (whoever holds it will pick up this owner's ready messages).
 *
 * Each attempt is its own short transaction on the lock pool, so a waiter
 * holds no connection between attempts, and the holder's connection never
 * comes from the pool its own queries need.
 */
export async function withOwnerLock<T>(userId: string, waitMs: number, fn: () => Promise<T>): Promise<T | null> {
  const key = `agent:${userId}`;
  const giveUpAt = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const attempt = (await getLockClient().begin(async (tx) => {
      const [row] = await tx`select pg_try_advisory_xact_lock(hashtext(${key})) as locked`;
      if (!row?.locked) return { held: false };
      return { held: true, value: await fn() };
    })) as { held: boolean; value?: T };
    if (attempt.held) return attempt.value as T;
    if (Date.now() >= giveUpAt) return null;
    await sleep(250);
  }
}

/* ───────────── Messages ───────────── */

export interface StoredMessage {
  id: string;
  direction: "in" | "out";
  kind: string;
  body: string;
  media: StoredMedia[];
  createdAt: Date;
  /** Why it failed; for outbound, "not delivered" means the owner never saw it. */
  error: string | null;
  /** For a draft shown to the owner: the pending_actions id it shows. */
  refId: string | null;
}

/** Outbound error for a message that never reached the owner. */
export const NOT_DELIVERED = "not delivered";

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
  refId?: string;
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
      refId: args.refId ?? null,
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
  return { id: row.id, direction: row.direction, kind: row.kind, body, media: row.media, createdAt: row.createdAt, error: row.error, refId: row.refId };
}

/**
 * How long an attachment still being read holds back the messages after it, so
 * a photo and the text sent right after it are answered together, in order.
 * Longer than the media budget; an older unready message was abandoned and is
 * left to the tick.
 */
export const ATTACHMENT_HOLD_MS = 35_000;

/**
 * Ready, unprocessed inbound messages for an owner, oldest first, stopping at
 * an attachment that is still being read (its own run answers it and the
 * messages after it).
 */
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
      ),
    )
    .orderBy(asc(channelMessages.createdAt), asc(channelMessages.id));
  const ready: StoredMessage[] = [];
  for (const row of rows) {
    if (row.readyAt) ready.push(toStored(row));
    else if (row.createdAt.getTime() > Date.now() - ATTACHMENT_HOLD_MS) break;
  }
  return ready;
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

/**
 * The conversation: the agent's messages, and the owner's once answered.
 * Messages still queued (including the ones a turn is answering) are left out,
 * so history never shows an owner message as unanswered that is about to be.
 */
function conversationWhere(userId: string, after: Date | null, before: Date | null, kinds: string[]) {
  const where = [
    eq(channelMessages.userId, userId),
    inArray(channelMessages.kind, kinds),
    or(eq(channelMessages.direction, "out"), isNotNull(channelMessages.processedAt))!,
  ];
  if (after) where.push(afterCursor(after));
  if (before) where.push(lt(channelMessages.createdAt, before));
  return and(...where);
}

/**
 * Conversation messages after the summary cursor (exclusive) and before
 * `before` (exclusive, or no bound), returned oldest first. `take: "newest"`
 * keeps the newest `limit` (for replay); `take: "oldest"` the oldest (for folding).
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

/** The agent's latest message that reached the owner before `before`, if any. */
export async function lastDeliveredOutbound(userId: string, before: Date): Promise<StoredMessage | null> {
  const [row] = await getDb()
    .select()
    .from(channelMessages)
    .where(
      and(eq(channelMessages.userId, userId), eq(channelMessages.direction, "out"), isNull(channelMessages.error), lt(channelMessages.createdAt, before)),
    )
    .orderBy(desc(channelMessages.createdAt), desc(channelMessages.id))
    .limit(1);
  return row ? toStored(row) : null;
}

/**
 * Replies that never reached the owner since `since`, oldest first, skipping
 * any already superseded by a later message that did reach them.
 */
export async function undeliveredReplies(userId: string, since: Date): Promise<StoredMessage[]> {
  const rows = await getDb()
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.userId, userId),
        eq(channelMessages.direction, "out"),
        eq(channelMessages.error, NOT_DELIVERED),
        gte(channelMessages.createdAt, since),
        sql`not exists (select 1 from channel_messages later where later.user_id = ${userId} and later.direction = 'out' and later.error is null and later.created_at > ${channelMessages.createdAt})`,
      ),
    )
    .orderBy(asc(channelMessages.createdAt), asc(channelMessages.id));
  return rows.map(toStored);
}

/** Record the outcome of re-sending an undelivered message. */
export async function markRedelivered(id: string, outcome: { providerMessageId?: string } | "failed"): Promise<void> {
  await getDb()
    .update(channelMessages)
    .set(outcome === "failed" ? { error: `${NOT_DELIVERED} (gave up)` } : { error: null, providerMessageId: outcome.providerMessageId ?? null })
    .where(eq(channelMessages.id, id));
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

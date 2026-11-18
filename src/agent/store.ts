import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, getLockClient } from "@/db/client";
import { channelMessages, pendingActions, people, type StoredMedia } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";

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
export {
  attachNotificationMessage,
  claimBriefSlot,
  getAgentPrefs,
  releaseNotification,
  unpromptedCountToday,
  updateAgentPrefs,
  type AgentPrefs,
} from "./prefs";

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
/** An undelivered message whose content was later sent as a new message; left out of history. */
export const RESENT = "not delivered (re-sent later)";

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
    sql`${channelMessages.error} is distinct from ${RESENT}`,
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

/**
 * What the agent last showed the owner before `before`: its latest message
 * that reached them, with the rest of that run (everything delivered since the
 * owner's message it answered; reactions don't count), newest first. A turn's
 * reply and its drafts form one run.
 */
export async function lastAgentRun(userId: string, before: Date): Promise<StoredMessage[]> {
  const db = getDb();
  const delivered = (from: Date | null) =>
    and(
      eq(channelMessages.userId, userId),
      eq(channelMessages.direction, "out"),
      isNull(channelMessages.error),
      lt(channelMessages.createdAt, before),
      ...(from ? [sql`${channelMessages.createdAt} > ${from.toISOString()}::timestamptz`] : []),
    );
  const [last] = await db.select({ createdAt: channelMessages.createdAt }).from(channelMessages).where(delivered(null)).orderBy(desc(channelMessages.createdAt)).limit(1);
  if (!last) return [];
  const [answered] = await db
    .select({ createdAt: channelMessages.createdAt })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.userId, userId),
        eq(channelMessages.direction, "in"),
        sql`${channelMessages.kind} <> 'reaction'`,
        lt(channelMessages.createdAt, last.createdAt),
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(1);
  const rows = await db
    .select()
    .from(channelMessages)
    .where(delivered(answered?.createdAt ?? null))
    .orderBy(desc(channelMessages.createdAt), desc(channelMessages.id))
    .limit(20);
  return rows.map(toStored);
}

/**
 * Messages that never reached the owner since `since`, oldest first, unless
 * superseded: the owner wrote again afterwards and got a reply that did reach
 * them. Parts and drafts of the same reply never supersede each other.
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
        sql`not exists (
          select 1 from channel_messages owner_msg
          join channel_messages answer on answer.user_id = owner_msg.user_id
            and answer.direction = 'out' and answer.error is null and answer.created_at > owner_msg.created_at
          where owner_msg.user_id = ${userId} and owner_msg.direction = 'in' and owner_msg.kind <> 'reaction'
            and owner_msg.created_at > ${channelMessages.createdAt}
        )`,
      ),
    )
    .orderBy(asc(channelMessages.createdAt), asc(channelMessages.id));
  return rows.map(toStored);
}

/** Claim an undelivered message for one re-send attempt; false if someone else already did. */
export async function claimForResend(id: string): Promise<boolean> {
  const rows = await getDb()
    .update(channelMessages)
    .set({ error: `${NOT_DELIVERED} (re-sending)` })
    .where(and(eq(channelMessages.id, id), eq(channelMessages.error, NOT_DELIVERED)))
    .returning({ id: channelMessages.id });
  return rows.length === 1;
}

/**
 * Record a claimed re-send. A delivered re-send becomes a new message at the
 * time it actually arrived (so history and "just shown" stay truthful) and the
 * original is retired; a failed one is given up on.
 */
export async function finishResend(m: StoredMessage, userId: string, provider: string, outcome: { providerMessageId?: string } | "failed"): Promise<void> {
  if (outcome === "failed") {
    await getDb().update(channelMessages).set({ error: `${NOT_DELIVERED} (gave up)` }).where(eq(channelMessages.id, m.id));
    return;
  }
  await getDb().transaction(async (tx) => {
    await tx.update(channelMessages).set({ error: RESENT }).where(eq(channelMessages.id, m.id));
    const now = new Date();
    await tx.insert(channelMessages).values({
      userId,
      provider,
      providerMessageId: outcome.providerMessageId ?? null,
      direction: "out",
      kind: m.kind,
      bodyEnc: encrypt(m.body),
      readyAt: now,
      processedAt: now,
      refId: m.refId,
    });
  });
}

/** When the owner's oldest still-queued message arrived, if any. */
export async function oldestQueuedInbound(userId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ createdAt: channelMessages.createdAt })
    .from(channelMessages)
    .where(and(eq(channelMessages.userId, userId), eq(channelMessages.direction, "in"), isNull(channelMessages.processedAt), isNull(channelMessages.error)))
    .orderBy(asc(channelMessages.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
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

import { createHmac, randomInt } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  channelBindings,
  channelMessages,
  notificationLog,
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
 */

export const BINDING_CODE_TTL_MS = 15 * 60_000;

function codeHash(code: string): string {
  const pepper = process.env.RMOS_ENCRYPTION_KEY;
  if (!pepper) throw new Error("RMOS_ENCRYPTION_KEY is not set");
  return createHmac("sha256", pepper).update(`bind:${code}`).digest("hex");
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

/**
 * Bind `phone` to whoever generated `code`, if the code is live. Single use.
 * A phone already bound to another account is not moved.
 */
export async function redeemBindingCode(code: string, phone: string, now = new Date()): Promise<string | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const db = getDb();
  return db.transaction(async (tx) => {
    const [pending] = await tx
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.pendingCodeHash, codeHash(code)), gt(channelBindings.codeExpiresAt, now)))
      .limit(1);
    if (!pending) return null;
    const [owner] = await tx.select({ userId: channelBindings.userId }).from(channelBindings).where(eq(channelBindings.phone, phone));
    if (owner && owner.userId !== pending.userId) return null;
    await tx
      .update(channelBindings)
      .set({ phone, verifiedAt: now, pendingCodeHash: null, codeExpiresAt: null, updatedAt: now })
      .where(eq(channelBindings.userId, pending.userId));
    return pending.userId;
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

/* ───────────── Messages ───────────── */

export interface StoredMessage {
  id: string;
  direction: "in" | "out";
  kind: string;
  body: string;
  media: StoredMedia[];
  createdAt: Date;
}

/** Insert an inbound message once. Returns null if this provider message id was already stored (HA-3). */
export async function insertInbound(args: {
  userId: string;
  provider: string;
  providerMessageId: string;
  body: string;
  kind?: string;
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
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    })
    .onConflictDoNothing({ target: [channelMessages.provider, channelMessages.providerMessageId] })
    .returning({ id: channelMessages.id });
  return rows[0]?.id ?? null;
}

export async function insertOutbound(args: {
  userId: string;
  provider: string;
  providerMessageId?: string;
  body: string;
  kind: string;
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
      processedAt: new Date(),
    })
    .returning({ id: channelMessages.id });
  return row.id;
}

export async function markProcessed(messageId: string, update: { media?: StoredMedia[]; kind?: string; error?: string | null }): Promise<void> {
  await getDb()
    .update(channelMessages)
    .set({
      processedAt: new Date(),
      ...(update.media ? { media: update.media } : {}),
      ...(update.kind ? { kind: update.kind } : {}),
      ...(update.error !== undefined ? { error: update.error } : {}),
    })
    .where(eq(channelMessages.id, messageId));
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

/** The most recent messages before `beforeId` (exclusive), oldest first. */
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

export async function getMessage(id: string): Promise<StoredMessage | null> {
  const [row] = await getDb().select().from(channelMessages).where(eq(channelMessages.id, id));
  return row ? toStored(row) : null;
}

/** Messages after `after` (exclusive) up to and including `through`, oldest first. */
export async function messagesBetween(userId: string, after: Date | null, through: Date, kinds: string[]): Promise<StoredMessage[]> {
  const where = [eq(channelMessages.userId, userId), lte(channelMessages.createdAt, through), inArray(channelMessages.kind, kinds)];
  if (after) where.push(gt(channelMessages.createdAt, after));
  const rows = await getDb().select().from(channelMessages).where(and(...where)).orderBy(asc(channelMessages.createdAt));
  return rows.map(toStored);
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

export async function briefSentToday(userId: string, now: Date, tz: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: notificationLog.id })
    .from(notificationLog)
    .where(and(eq(notificationLog.userId, userId), eq(notificationLog.kind, "brief"), eq(notificationLog.localDate, localDate(now, tz))));
  return Boolean(row);
}

/**
 * Claim today's brief slot before composing it, so two overlapping cron ticks
 * can't both send. Returns false if another tick already claimed it.
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

/** Recent unprompted log entries, for diagnostics. */
export async function notificationsSince(userId: string, since: Date) {
  return getDb()
    .select()
    .from(notificationLog)
    .where(and(eq(notificationLog.userId, userId), gte(notificationLog.sentAt, since)))
    .orderBy(desc(notificationLog.sentAt));
}

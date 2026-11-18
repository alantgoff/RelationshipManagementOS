import { runAsOwner } from "@/server/auth";
import { briefIsEmpty, briefScheduleCheck, composeBrief, gatherBriefData, type BriefSkipReason } from "./brief";
import { drainQueue, MIN_TURN_MS, WORK_BUDGET_MS, type AgentDeps } from "./runtime";
import {
  attachNotificationMessage,
  claimBriefSlot,
  expireOldDrafts,
  getAgentPrefs,
  insertOutbound,
  listVerifiedBindings,
  markProcessed,
  claimForResend,
  finishResend,
  releaseNotification,
  stuckInbound,
  undeliveredReplies,
  unpromptedCountToday,
  withOwnerLock,
} from "./store";
import { maybeUpdateThreadSummary, SEND_RESERVE_MS, sendOut } from "./turn";

/**
 * The scheduled tick (cron, every ~15 minutes). Per owner, isolated so one
 * owner's failure can't stop the rest:
 *   1. recover messages a killed webhook run left behind, and re-send recent
 *      replies the provider failed to deliver,
 *   2. expire stale drafts and keep the thread summary caught up,
 *   3. send the weekday morning brief once, inside its window and budget (HA-8).
 */

/** A ready message this old was abandoned by its webhook run. */
export const STALE_READY_MS = 2 * 60_000;
/** An attachment still unread after this long never will be. */
export const STALE_UNREADY_MS = 10 * 60_000;
/** Total real-clock budget for one tick; the cron route allows 120s. */
export const TICK_BUDGET_MS = 100_000;
/** Undelivered replies younger than this get one more try; older ones would arrive out of context. */
export const REDELIVER_WINDOW_MS = 30 * 60_000;

export interface BriefTickResult {
  userId: string;
  sent: boolean;
  skipped?: BriefSkipReason | "no_phone" | "error";
  preview?: string;
  /** Abandoned messages picked back up this tick. */
  recovered?: number;
  /** Undelivered replies re-sent this tick. */
  redelivered?: number;
}

/**
 * Re-send messages that never reached the owner and weren't superseded, in
 * order. Runs under the owner's lock, so it can't interleave with a turn, and
 * claims each message first, so overlapping ticks never send one twice. At
 * most one try per message.
 */
async function redeliver(deps: AgentDeps, userId: string, phone: string): Promise<number> {
  const sent = await withOwnerLock(userId, 10_000, async () => {
    const missed = await undeliveredReplies(userId, new Date(Date.now() - REDELIVER_WINDOW_MS));
    let n = 0;
    for (const m of missed) {
      if (!(await claimForResend(m.id))) continue;
      let res: { providerMessageId?: string };
      try {
        res = await deps.adapter.sendText(phone, m.body);
      } catch (err) {
        console.error("[agent] re-send failed", err);
        await finishResend(m, userId, deps.adapter.name, "failed");
        break; // the rest stay queued, in order, for the next tick
      }
      await finishResend(m, userId, deps.adapter.name, res);
      n++;
    }
    return n;
  });
  return sent ?? 0;
}

async function recoverStuck(deps: AgentDeps, userId: string, phone: string, tickDeadline: number): Promise<number> {
  const stuck = await stuckInbound(userId, new Date(Date.now() - STALE_READY_MS));
  if (stuck.length === 0) return 0;
  const dead = stuck.filter((m) => !m.ready && m.createdAt.getTime() < Date.now() - STALE_UNREADY_MS);
  if (dead.length) {
    await markProcessed(
      dead.map((m) => m.id),
      { error: "attachment processing interrupted" },
    );
    await sendOut(deps, userId, phone, "Sorry, I couldn't finish reading something you sent me earlier. Could you send it again?", "system");
  }
  if (stuck.some((m) => m.ready) && tickDeadline - Date.now() > MIN_TURN_MS + 5_000) {
    await drainQueue(deps, userId, phone, Math.min(tickDeadline, Date.now() + WORK_BUDGET_MS));
  }
  return stuck.length;
}

export async function runBriefTick(deps: AgentDeps, opts: { dryRun?: boolean } = {}): Promise<BriefTickResult[]> {
  const tickDeadline = Date.now() + TICK_BUDGET_MS;
  const now = deps.now();
  const results: BriefTickResult[] = [];
  for (const binding of await listVerifiedBindings()) {
    const userId = binding.userId;
    const result = await runAsOwner(userId, "cron", async (): Promise<BriefTickResult> => {
      if (!binding.phone) return { userId, sent: false, skipped: "no_phone" };
      const phone = binding.phone;
      let recovered = 0;
      let redelivered = 0;
      if (!opts.dryRun) {
        try {
          redelivered = await redeliver(deps, userId, phone);
          recovered = await recoverStuck(deps, userId, phone, tickDeadline);
          await expireOldDrafts(userId, now);
          if (tickDeadline - Date.now() > MIN_TURN_MS) {
            await maybeUpdateThreadSummary(deps, userId, now, Math.min(20_000, tickDeadline - Date.now() - SEND_RESERVE_MS));
          }
        } catch (err) {
          console.error("[agent] tick maintenance failed", userId, err);
        }
      }
      const withRecovered = (r: BriefTickResult): BriefTickResult => ({ ...r, ...(recovered ? { recovered } : {}), ...(redelivered ? { redelivered } : {}) });

      const prefs = await getAgentPrefs(userId);
      const skip = briefScheduleCheck(prefs, now, await unpromptedCountToday(userId, now, prefs.timezone));
      if (skip) return withRecovered({ userId, sent: false, skipped: skip });
      const data = await gatherBriefData(userId, now, prefs.timezone);
      if (briefIsEmpty(data)) return withRecovered({ userId, sent: false, skipped: "nothing_due" });
      const timeoutMs = Math.max(3_000, Math.min(30_000, tickDeadline - Date.now() - SEND_RESERVE_MS));
      if (opts.dryRun) {
        const { text } = await composeBrief(deps.llm, data, timeoutMs);
        return { userId, sent: false, preview: text };
      }
      const logId = await claimBriefSlot(userId, now, prefs.timezone);
      if (!logId) return withRecovered({ userId, sent: false, skipped: "already_sent" });
      const { text } = await composeBrief(deps.llm, data, timeoutMs);
      let providerMessageId: string | undefined;
      try {
        ({ providerMessageId } = await deps.adapter.sendText(phone, text));
      } catch (err) {
        // Not delivered: free the slot so a later tick can try again.
        console.error("[agent] brief send failed", err);
        await releaseNotification(logId);
        return withRecovered({ userId, sent: false, skipped: "error" });
      }
      // Delivered: keep the slot even if recording it fails, so the owner never gets two briefs.
      try {
        const messageId = await insertOutbound({ userId, provider: deps.adapter.name, providerMessageId, body: text, kind: "brief" });
        await attachNotificationMessage(logId, messageId);
      } catch (err) {
        console.error("[agent] brief sent but not recorded", err);
      }
      return withRecovered({ userId, sent: true });
    }).catch((err): BriefTickResult => {
      console.error("[agent] tick failed for owner", userId, err);
      return { userId, sent: false, skipped: "error" };
    });
    results.push(result);
  }
  return results;
}

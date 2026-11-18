import { after, NextResponse } from "next/server";
import { defaultAgentDeps, drainOwner } from "@/agent/runtime";
import { channelConfigured, getChannelAdapter } from "@/channels";
import { safeEqual } from "@/lib/crypto";

export const dynamic = "force-dynamic";
/** Same room as the webhook: one work budget of turns. */
export const maxDuration = 60;

/**
 * Hand-off from an agent run that ran out of budget with an owner's messages
 * still queued (`Authorization: Bearer $CRON_SECRET`, body `{"userId": "…"}`).
 * Responds at once and drains that owner's queue in a fresh run.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!channelConfigured()) return NextResponse.json({ error: "channel not configured" }, { status: 503 });
  let userId: unknown;
  try {
    ({ userId } = (await req.json()) as { userId?: unknown });
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof userId !== "string" || !userId || userId.length > 200) return NextResponse.json({ error: "userId required" }, { status: 400 });
  const deps = defaultAgentDeps(getChannelAdapter());
  after(async () => {
    try {
      await drainOwner(deps, userId);
    } catch (err) {
      console.error("[agent] drain failed", err);
    }
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}

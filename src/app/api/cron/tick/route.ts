import { NextResponse } from "next/server";
import { defaultAgentDeps, runBriefTick } from "@/agent/runtime";
import { channelConfigured, getChannelAdapter } from "@/channels";
import { safeEqual } from "@/lib/crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Scheduled tick, every ~15 minutes (GitHub Actions or Vercel Cron), sending
 * `Authorization: Bearer $CRON_SECRET`. Sends due morning briefs.
 * `?dryRun=1` composes briefs and returns them without sending.
 */
async function handle(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!channelConfigured()) return NextResponse.json({ error: "channel not configured" }, { status: 503 });
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const results = await runBriefTick(defaultAgentDeps(getChannelAdapter()), { dryRun });
  return NextResponse.json({ ok: true, dryRun, results });
}

export const GET = handle;
export const POST = handle;

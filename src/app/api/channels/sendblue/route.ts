import { after, NextResponse } from "next/server";
import { defaultAgentDeps, receiveInbound } from "@/agent/runtime";
import { channelConfigured, getChannelAdapter } from "@/channels";

export const dynamic = "force-dynamic";
/** Agent turns run in after(); give them room. */
export const maxDuration = 60;

/**
 * Sendblue inbound webhook (spec 0002 HA-1..HA-4): verify the signing secret,
 * allowlist the owner, insert idempotently, respond, then run the agent.
 */
export async function POST(req: Request): Promise<Response> {
  if (!channelConfigured()) return NextResponse.json({ error: "channel not configured" }, { status: 503 });
  const adapter = getChannelAdapter();
  const raw = await req.text();
  if (!adapter.verify(req.headers, raw)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const msg = adapter.parseInbound(body);
  if (!msg) return NextResponse.json({ ok: true, ignored: true });

  const deps = defaultAgentDeps(adapter);
  const result = await receiveInbound(deps, msg);
  if (result.status === "accepted" || result.status === "bound") {
    const work = result.work;
    after(async () => {
      try {
        await work();
      } catch (err) {
        console.error("[agent] background work failed", err);
      }
    });
  }
  // Same response whether or not the sender is known, so the endpoint reveals nothing.
  return NextResponse.json({ ok: true });
}

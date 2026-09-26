import { z } from "zod";
import { safeEqual } from "@/lib/crypto";
import { toE164, type ChannelAdapter, type InboundMessage, type SendResult } from "./types";

/**
 * Sendblue iMessage adapter.
 *
 * Env: SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET, SENDBLUE_SIGNING_SECRET,
 * optional SENDBLUE_FROM_NUMBER (the line to send from) and SENDBLUE_BASE_URL.
 *
 * API shapes follow Sendblue's public docs as of 2026; re-check field names in
 * the sandbox with `npm run check:sendblue` before relying on them. Parsing is
 * deliberately lenient: unknown fields pass through, and a payload without
 * the fields we need is ignored rather than crashing the webhook.
 */

const inboundSchema = z
  .object({
    message_handle: z.string().min(1),
    content: z.string().nullish(),
    from_number: z.string().min(1),
    to_number: z.string().nullish(),
    sendblue_number: z.string().nullish(),
    is_outbound: z.boolean().nullish(),
    media_url: z.string().nullish(),
    date_sent: z.string().nullish(),
    service: z.string().nullish(),
  })
  .passthrough();

export interface SendblueConfig {
  apiKeyId: string;
  apiSecret: string;
  signingSecret: string;
  fromNumber?: string;
  baseUrl: string;
}

export function sendblueConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SendblueConfig {
  const apiKeyId = env.SENDBLUE_API_KEY_ID;
  const apiSecret = env.SENDBLUE_API_SECRET;
  if (!apiKeyId || !apiSecret) throw new Error("SENDBLUE_API_KEY_ID and SENDBLUE_API_SECRET are required");
  return {
    apiKeyId,
    apiSecret,
    signingSecret: env.SENDBLUE_SIGNING_SECRET ?? "",
    fromNumber: env.SENDBLUE_FROM_NUMBER || undefined,
    baseUrl: env.SENDBLUE_BASE_URL ?? "https://api.sendblue.co",
  };
}

function contentTypeFromUrl(url: string): string | undefined {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    caf: "audio/x-caf",
    m4a: "audio/mp4",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    heic: "image/heic",
    gif: "image/gif",
    vcf: "text/vcard",
    pdf: "application/pdf",
  };
  return ext ? map[ext] : undefined;
}

export function createSendblueAdapter(cfg: SendblueConfig): ChannelAdapter {
  async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": cfg.apiKeyId,
        "sb-api-secret-key": cfg.apiSecret,
      },
      body: JSON.stringify({ ...body, ...(cfg.fromNumber ? { from_number: cfg.fromNumber } : {}) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new Error(`Sendblue ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return json;
  }

  const toResult = (json: Record<string, unknown>): SendResult => ({
    providerMessageId: typeof json.message_handle === "string" ? json.message_handle : undefined,
    status: typeof json.status === "string" ? json.status : undefined,
  });

  return {
    name: "sendblue",

    verify(headers) {
      if (!cfg.signingSecret) return false;
      const provided = headers.get("sb-signing-secret") ?? "";
      return safeEqual(provided, cfg.signingSecret);
    },

    parseInbound(body): InboundMessage | null {
      const parsed = inboundSchema.safeParse(body);
      if (!parsed.success) return null;
      const m = parsed.data;
      if (m.is_outbound) return null; // status callbacks for our own sends
      const from = toE164(m.from_number);
      if (!from) return null;
      const to = m.sendblue_number ?? m.to_number;
      return {
        providerMessageId: m.message_handle,
        from,
        to: to ? (toE164(to) ?? undefined) : undefined,
        text: m.content ?? "",
        media: m.media_url ? [{ url: m.media_url, contentType: contentTypeFromUrl(m.media_url) }] : [],
        receivedAt: m.date_sent ? new Date(m.date_sent) : new Date(),
        service: m.service ?? undefined,
      };
    },

    async sendText(to, text) {
      return toResult(await post("/api/send-message", { number: to, content: text }));
    },

    async sendMedia(to, mediaUrl, caption) {
      return toResult(await post("/api/send-message", { number: to, media_url: mediaUrl, ...(caption ? { content: caption } : {}) }));
    },

    async sendTyping(to) {
      await post("/api/send-typing-indicator", { number: to });
    },
  };
}

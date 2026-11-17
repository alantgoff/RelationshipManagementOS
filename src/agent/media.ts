import type { StoredMedia } from "@/db/schema";
import type { InboundMedia } from "@/channels/types";
import { describeContact, parseVCards } from "@/channels/vcard";
import { chat, providersFromEnv, type ChatResult, type ProviderConfig } from "./llm";

/**
 * Turns inbound attachments into text the agent can read. Provider media URLs
 * expire and binaries are sensitive, so attachments are processed once and
 * only the derived text is stored (StoredMedia.derivedText).
 *
 * Voice notes: an OpenAI-compatible /audio/transcriptions endpoint
 *   (TRANSCRIBE_BASE_URL, TRANSCRIBE_API_KEY, TRANSCRIBE_MODEL, e.g. Whisper
 *   large-v3-turbo on Groq or DeepInfra).
 * Images: an OpenAI-compatible vision chat model (VISION_PRIMARY_*).
 * Contact cards: parsed locally.
 *
 * Every step fails soft: the agent gets a note that the attachment couldn't be
 * read instead of the turn failing.
 */

const MAX_BYTES = 20 * 1024 * 1024;

export interface MediaDeps {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the gateway's chat(). */
  vision?: (messages: Parameters<typeof chat>[0]["messages"], providers: ProviderConfig[]) => Promise<ChatResult>;
}

export const defaultMediaDeps = (): MediaDeps => ({ fetch, env: process.env });

export function mediaKind(m: InboundMedia): StoredMedia["kind"] {
  const type = (m.contentType ?? "").toLowerCase();
  const path = m.url.split("?")[0].toLowerCase();
  if (type.startsWith("audio/") || /\.(caf|m4a|mp3|wav|aac|ogg|opus|amr)$/.test(path)) return "audio";
  if (type.startsWith("image/") || /\.(jpe?g|png|heic|heif|gif|webp)$/.test(path)) return "image";
  if (type.includes("vcard") || path.endsWith(".vcf")) return "contact";
  return "file";
}

async function download(m: InboundMedia, deps: MediaDeps): Promise<{ bytes: ArrayBuffer; type: string }> {
  const res = await deps.fetch(m.url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("attachment too large");
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new Error("attachment too large");
  return { bytes, type: m.contentType ?? res.headers.get("content-type") ?? "application/octet-stream" };
}

async function transcribe(m: InboundMedia, deps: MediaDeps): Promise<string> {
  const base = deps.env.TRANSCRIBE_BASE_URL;
  if (!base) throw new Error("voice notes are not configured (TRANSCRIBE_BASE_URL)");
  const { bytes, type } = await download(m, deps);
  const name = m.url.split("?")[0].split("/").pop() || "voice-note.caf";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  form.append("model", deps.env.TRANSCRIBE_MODEL ?? "whisper-large-v3-turbo");
  form.append("response_format", "json");
  const res = await deps.fetch(`${base.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: deps.env.TRANSCRIBE_API_KEY ? { authorization: `Bearer ${deps.env.TRANSCRIBE_API_KEY}` } : {},
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`transcription failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  const text = json.text?.trim();
  if (!text) throw new Error("transcription was empty");
  return text;
}

async function describeImage(m: InboundMedia, deps: MediaDeps): Promise<string> {
  const providers = providersFromEnv(deps.env, "VISION");
  if (providers.length === 0) throw new Error("image understanding is not configured (VISION_PRIMARY_*)");
  const { bytes, type } = await download(m, deps);
  const dataUrl = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  const run = deps.vision ?? ((messages, p) => chat({ messages, maxTokens: 600, temperature: 0.1 }, p));
  const res = await run(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Describe this image for a relationship manager in 1-3 sentences. If it shows a business card, profile, or message thread, transcribe the names, titles, companies, emails, phone numbers and key text exactly.",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    providers,
  );
  const text = typeof res.message.content === "string" ? res.message.content.trim() : "";
  if (!text) throw new Error("image description was empty");
  return text;
}

async function readContact(m: InboundMedia, deps: MediaDeps): Promise<string> {
  const { bytes } = await download(m, deps);
  const cards = parseVCards(new TextDecoder().decode(bytes));
  if (cards.length === 0) throw new Error("no contacts found in the card");
  return cards.map(describeContact).join("\n");
}

const LABEL: Record<StoredMedia["kind"], string> = {
  audio: "Voice note",
  image: "Image",
  contact: "Contact card",
  file: "Attachment",
};

/** Process each attachment; never throws. */
export async function processMedia(media: InboundMedia[], deps: MediaDeps = defaultMediaDeps()): Promise<StoredMedia[]> {
  return Promise.all(
    media.map(async (m): Promise<StoredMedia> => {
      const kind = mediaKind(m);
      try {
        if (kind === "audio") return { kind, contentType: m.contentType, derivedText: await transcribe(m, deps) };
        if (kind === "image") return { kind, contentType: m.contentType, derivedText: await describeImage(m, deps) };
        if (kind === "contact") return { kind, contentType: m.contentType, derivedText: await readContact(m, deps) };
        return { kind, contentType: m.contentType, error: "unsupported attachment type" };
      } catch (err) {
        return { kind, contentType: m.contentType, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/** Text appended to the owner's message so the model sees attachments. */
export function mediaToText(media: StoredMedia[]): string {
  return media
    .map((m) =>
      m.derivedText
        ? `[${LABEL[m.kind]}] ${m.derivedText}`
        : `[${LABEL[m.kind]} could not be read: ${m.error ?? "unknown error"}]`,
    )
    .join("\n");
}

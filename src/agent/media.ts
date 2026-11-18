import type { StoredMedia } from "@/db/schema";
import type { InboundMedia } from "@/channels/types";
import { describeContact, parseVCards } from "@/channels/vcard";
import { chat, providersFromEnv, type ChatResult, type ProviderConfig } from "./llm";
import { escapeTagText, stripReasoning } from "./text";

/**
 * Turns inbound attachments into text the agent can read. Provider media URLs
 * expire and binaries are sensitive, so attachments are processed once; the
 * derived text becomes part of the message body (encrypted like any body) and
 * the media column keeps only the kind, type and any error.
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

/** An attachment after processing. derivedText is never stored in the media column. */
export interface ProcessedMedia extends StoredMedia {
  derivedText?: string;
}

/** Default cap on all attachment work for one message, so a turn still fits the webhook budget. */
export const MEDIA_BUDGET_MS = 20_000;

/** A timeout signal that also fires when the message's overall media budget runs out. */
const within = (ms: number, budget?: AbortSignal) => (budget ? AbortSignal.any([AbortSignal.timeout(ms), budget]) : AbortSignal.timeout(ms));

export function mediaKind(m: InboundMedia): StoredMedia["kind"] {
  const type = (m.contentType ?? "").toLowerCase();
  const path = m.url.split("?")[0].toLowerCase();
  if (type.startsWith("audio/") || /\.(caf|m4a|mp3|wav|aac|ogg|opus|amr)$/.test(path)) return "audio";
  if (type.startsWith("image/") || /\.(jpe?g|png|heic|heif|gif|webp)$/.test(path)) return "image";
  if (type.includes("vcard") || path.endsWith(".vcf")) return "contact";
  return "file";
}

async function download(m: InboundMedia, deps: MediaDeps, budget?: AbortSignal): Promise<{ bytes: ArrayBuffer; type: string }> {
  const res = await deps.fetch(m.url, { signal: within(20_000, budget) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("attachment too large");
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new Error("attachment too large");
  return { bytes, type: m.contentType ?? res.headers.get("content-type") ?? "application/octet-stream" };
}

async function transcribe(m: InboundMedia, deps: MediaDeps, budget?: AbortSignal): Promise<string> {
  const base = deps.env.TRANSCRIBE_BASE_URL;
  if (!base) throw new Error("voice notes are not configured (TRANSCRIBE_BASE_URL)");
  const { bytes, type } = await download(m, deps, budget);
  const name = m.url.split("?")[0].split("/").pop() || "voice-note.caf";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  form.append("model", deps.env.TRANSCRIBE_MODEL ?? "whisper-large-v3-turbo");
  form.append("response_format", "json");
  const res = await deps.fetch(`${base.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: deps.env.TRANSCRIBE_API_KEY ? { authorization: `Bearer ${deps.env.TRANSCRIBE_API_KEY}` } : {},
    body: form,
    signal: within(60_000, budget),
  });
  if (!res.ok) throw new Error(`transcription failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  const text = json.text?.trim();
  if (!text) throw new Error("transcription was empty");
  return text;
}

async function describeImage(m: InboundMedia, deps: MediaDeps, deadline: number, budget?: AbortSignal): Promise<string> {
  const providers = providersFromEnv(deps.env, "VISION");
  if (providers.length === 0) throw new Error("image understanding is not configured (VISION_PRIMARY_*)");
  const { bytes, type } = await download(m, deps, budget);
  const dataUrl = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  const timeoutMs = Math.max(1_000, deadline - Date.now());
  const run = deps.vision ?? ((messages, p) => chat({ messages, maxTokens: 600, temperature: 0.1, timeoutMs }, p));
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
  const text = typeof res.message.content === "string" ? stripReasoning(res.message.content) : "";
  if (!text || res.finishReason === "length") throw new Error("image description was empty or cut off");
  return text;
}

async function readContact(m: InboundMedia, deps: MediaDeps, budget?: AbortSignal): Promise<string> {
  const { bytes } = await download(m, deps, budget);
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

/** Process each attachment within `budgetMs` in total; never throws. */
export async function processMedia(
  media: InboundMedia[],
  deps: MediaDeps = defaultMediaDeps(),
  budgetMs = MEDIA_BUDGET_MS,
): Promise<ProcessedMedia[]> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  const budget = AbortSignal.timeout(Math.max(1, budgetMs));
  return Promise.all(
    media.map(async (m): Promise<ProcessedMedia> => {
      const kind = mediaKind(m);
      try {
        if (budgetMs <= 0) throw new Error("no time left to read it");
        if (kind === "audio") return { kind, contentType: m.contentType, derivedText: await transcribe(m, deps, budget) };
        if (kind === "image") return { kind, contentType: m.contentType, derivedText: await describeImage(m, deps, deadline, budget) };
        if (kind === "contact") return { kind, contentType: m.contentType, derivedText: await readContact(m, deps, budget) };
        return { kind, contentType: m.contentType, error: "unsupported attachment type" };
      } catch (err) {
        const timedOut = budget.aborted || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));
        return { kind, contentType: m.contentType, error: timedOut ? "took too long to read" : err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/** What gets stored in the media column: no derived text (it lives in the encrypted body). */
export function storableMedia(media: ProcessedMedia[]): StoredMedia[] {
  return media.map(({ kind, contentType, error }) => ({ kind, ...(contentType ? { contentType } : {}), ...(error ? { error: error.slice(0, 300) } : {}) }));
}

/**
 * Attachment text for the model. A voice note is the owner's own words, so its
 * transcript reads as their message. Image descriptions and contact cards come
 * from someone else's content: they are wrapped in <attachment> with tags
 * escaped, and the system prompt says to treat them as data, not instructions.
 */
export function mediaToText(media: ProcessedMedia[]): string {
  return media
    .map((m) => {
      if (!m.derivedText) return `[${LABEL[m.kind]} could not be read: ${m.error ?? "unknown error"}]`;
      if (m.kind === "audio") return `[${LABEL.audio}] ${m.derivedText}`;
      const type = m.kind === "contact" ? "contact card" : m.kind === "image" ? "image" : "file";
      return `<attachment type="${type}">\n${escapeTagText(m.derivedText)}\n</attachment>`;
    })
    .join("\n");
}

/**
 * The full text of an inbound message: what the owner typed, then each
 * attachment, cut to `maxChars` without leaving an attachment block open.
 */
export function composeInboundText(text: string, media: ProcessedMedia[], maxChars = 12_000): string {
  const full = [text.trim(), media.length ? mediaToText(media) : ""].filter(Boolean).join("\n");
  if (full.length <= maxChars) return full;
  const close = "…\n</attachment>";
  let cut = full.slice(0, maxChars - close.length);
  // Attachment text is escaped, so a "<" with no ">" after it is a tag the cut split: drop the fragment.
  const lt = cut.lastIndexOf("<");
  if (lt >= 0 && !cut.includes(">", lt)) cut = cut.slice(0, lt);
  const open = (cut.match(/<attachment\b/g) ?? []).length - (cut.match(/<\/attachment>/g) ?? []).length;
  return open > 0 ? `${cut.trimEnd()}${close}` : `${cut.trimEnd()}…`;
}

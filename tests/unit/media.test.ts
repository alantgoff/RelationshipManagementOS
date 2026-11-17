import { describe, expect, it, vi } from "vitest";
import { mediaKind, mediaToText, processMedia, type MediaDeps } from "@/agent/media";

const card = "BEGIN:VCARD\nFN:Tom Becker\nEMAIL:tom@beckerfo.com\nEND:VCARD";

function deps(env: Record<string, string>, handler: (url: string, init?: RequestInit) => Response): MediaDeps {
  return { env: env as unknown as NodeJS.ProcessEnv, fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch };
}

describe("mediaKind", () => {
  it("classifies by content type or extension", () => {
    expect(mediaKind({ url: "https://x/voice.caf" })).toBe("audio");
    expect(mediaKind({ url: "https://x/a", contentType: "image/heic" })).toBe("image");
    expect(mediaKind({ url: "https://x/c.vcf?sig=1" })).toBe("contact");
    expect(mediaKind({ url: "https://x/doc.pdf" })).toBe("file");
  });
});

describe("processMedia", () => {
  it("parses contact cards locally", async () => {
    const out = await processMedia([{ url: "https://cdn/c.vcf" }], deps({}, () => new Response(card)));
    expect(out).toEqual([{ kind: "contact", contentType: undefined, derivedText: "Tom Becker; email tom@beckerfo.com" }]);
  });

  it("transcribes voice notes through the configured endpoint", async () => {
    const d = deps({ TRANSCRIBE_BASE_URL: "https://stt.test/v1", TRANSCRIBE_API_KEY: "k" }, (url) =>
      url.startsWith("https://stt.test") ? Response.json({ text: "Coffee with Priya, she's in." }) : new Response(new Uint8Array([1, 2, 3])),
    );
    const out = await processMedia([{ url: "https://cdn/v.caf", contentType: "audio/x-caf" }], d);
    expect(out[0].derivedText).toBe("Coffee with Priya, she's in.");
    const [, init] = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("describes images with the vision model", async () => {
    const vision = vi.fn(async () => ({ message: { role: "assistant" as const, content: "Business card: Tom Becker, Becker FO." }, finishReason: "stop", provider: "primary" as const, model: "v", latencyMs: 1 }));
    const d = { ...deps({ VISION_PRIMARY_BASE_URL: "https://v.test/v1", VISION_PRIMARY_MODEL: "qwen-vl" }, () => new Response(new Uint8Array([9]), { headers: { "content-type": "image/png" } })), vision };
    const out = await processMedia([{ url: "https://cdn/card.png" }], d);
    expect(out[0].derivedText).toContain("Tom Becker");
    const parts = (vision.mock.calls[0] as unknown as [{ content: { type: string; image_url?: { url: string } }[] }[]])[0][0].content;
    expect(parts[1].image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("fails soft when a feature isn't configured or a download fails", async () => {
    const out = await processMedia(
      [{ url: "https://cdn/v.m4a" }, { url: "https://cdn/p.jpg" }, { url: "https://cdn/c.vcf" }, { url: "https://cdn/x.zip" }],
      deps({}, () => new Response("gone", { status: 410 })),
    );
    expect(out.map((m) => m.error)).toEqual([
      expect.stringMatching(/TRANSCRIBE_BASE_URL/),
      expect.stringMatching(/VISION_PRIMARY/),
      expect.stringMatching(/HTTP 410/),
      "unsupported attachment type",
    ]);
    expect(mediaToText(out).split("\n")[0]).toMatch(/^\[Voice note could not be read: /);
  });
});

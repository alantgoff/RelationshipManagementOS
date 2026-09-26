import { afterEach, describe, expect, it, vi } from "vitest";
import { createSendblueAdapter, type SendblueConfig } from "@/channels/sendblue";
import { toE164 } from "@/channels/types";

const cfg: SendblueConfig = {
  apiKeyId: "key",
  apiSecret: "secret",
  signingSecret: "whsec_test",
  baseUrl: "https://api.sendblue.test",
};
const adapter = createSendblueAdapter(cfg);

afterEach(() => vi.unstubAllGlobals());

describe("verify", () => {
  it("accepts only the matching signing secret", () => {
    expect(adapter.verify(new Headers({ "sb-signing-secret": "whsec_test" }), "{}")).toBe(true);
    expect(adapter.verify(new Headers({ "sb-signing-secret": "wrong" }), "{}")).toBe(false);
    expect(adapter.verify(new Headers(), "{}")).toBe(false);
  });

  it("rejects everything when no signing secret is configured", () => {
    const open = createSendblueAdapter({ ...cfg, signingSecret: "" });
    expect(open.verify(new Headers({ "sb-signing-secret": "" }), "{}")).toBe(false);
  });
});

describe("parseInbound", () => {
  const inbound = {
    accountEmail: "owner@fund.com",
    content: "met Priya for coffee",
    is_outbound: false,
    status: "RECEIVED",
    message_handle: "msg-123",
    date_sent: "2026-09-24T15:00:00.000Z",
    from_number: "+14155550123",
    number: "+14155550123",
    to_number: "+13055550999",
    sendblue_number: "+13055550999",
    media_url: "https://cdn.sendblue.test/abc/voice.caf",
    service: "iMessage",
    some_future_field: 1,
  };

  it("parses an inbound message with media", () => {
    expect(adapter.parseInbound(inbound)).toEqual({
      providerMessageId: "msg-123",
      from: "+14155550123",
      to: "+13055550999",
      text: "met Priya for coffee",
      media: [{ url: "https://cdn.sendblue.test/abc/voice.caf", contentType: "audio/x-caf" }],
      receivedAt: new Date("2026-09-24T15:00:00.000Z"),
      service: "iMessage",
    });
  });

  it("ignores outbound status callbacks and malformed payloads", () => {
    expect(adapter.parseInbound({ ...inbound, is_outbound: true })).toBeNull();
    expect(adapter.parseInbound({ content: "no handle" })).toBeNull();
    expect(adapter.parseInbound("nope")).toBeNull();
  });
});

describe("sendText", () => {
  it("posts to the send-message endpoint with API key headers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message_handle: "out-1", status: "QUEUED" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const withFrom = createSendblueAdapter({ ...cfg, fromNumber: "+13055550999" });
    const res = await withFrom.sendText("+14155550123", "hi");
    expect(res).toEqual({ providerMessageId: "out-1", status: "QUEUED" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sendblue.test/api/send-message");
    expect((init.headers as Record<string, string>)["sb-api-key-id"]).toBe("key");
    expect(JSON.parse(init.body as string)).toEqual({ number: "+14155550123", content: "hi", from_number: "+13055550999" });
  });

  it("surfaces API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unverified contact", { status: 400 })));
    await expect(adapter.sendText("+14155550123", "hi")).rejects.toThrow(/HTTP 400/);
  });
});

describe("toE164", () => {
  it("normalizes common US formats", () => {
    expect(toE164("(415) 555-0123")).toBe("+14155550123");
    expect(toE164("1-415-555-0123")).toBe("+14155550123");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("555-0123")).toBeNull();
  });
});

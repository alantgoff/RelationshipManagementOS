import { afterEach, describe, expect, it, vi } from "vitest";
import { chat, LlmError, parseToolArguments, providersFromEnv, type ProviderConfig } from "@/agent/llm";

const providers: ProviderConfig[] = [
  { name: "primary", baseUrl: "https://primary.test/v1", apiKey: "k1", model: "qwen-lora" },
  { name: "fallback", baseUrl: "https://fallback.test/v1/", apiKey: "k2", model: "qwen-base" },
];

function ok(content: string) {
  return new Response(
    JSON.stringify({ model: "served-model", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("chat", () => {
  it("returns the primary response and sends the OpenAI-compatible request", async () => {
    const fetchMock = vi.fn(async () => ok("hi"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await chat({ messages: [{ role: "user", content: "hello" }] }, providers);
    expect(res.provider).toBe("primary");
    expect(res.message.content).toBe("hi");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://primary.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k1");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("qwen-lora");
    expect(body.tools).toBeUndefined();
  });

  it("retries the primary once, then fails over to the fallback on transient errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok("from fallback"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await chat({ messages: [{ role: "user", content: "x" }] }, providers);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.provider).toBe("fallback");
    expect((fetchMock.mock.calls[2] as unknown as [string])[0]).toBe("https://fallback.test/v1/chat/completions");
  });

  it("does not fail over on a client error", async () => {
    const fetchMock = vi.fn(async () => new Response("bad schema", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chat({ messages: [{ role: "user", content: "x" }] }, providers)).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("includes tools with auto tool choice when given", async () => {
    const fetchMock = vi.fn(async () => ok("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await chat(
      {
        messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: { name: "whats_due", description: "d", parameters: { type: "object" } } }],
      },
      providers,
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toHaveLength(1);
  });

  it("errors clearly when no provider is configured", async () => {
    await expect(chat({ messages: [] }, [])).rejects.toBeInstanceOf(LlmError);
  });
});

describe("providersFromEnv", () => {
  it("reads primary and fallback, skipping incomplete ones", () => {
    const p = providersFromEnv({
      LLM_PRIMARY_BASE_URL: "https://a/v1",
      LLM_PRIMARY_MODEL: "m1",
      LLM_PRIMARY_API_KEY: "k",
      LLM_FALLBACK_BASE_URL: "https://b/v1",
    } as unknown as NodeJS.ProcessEnv);
    expect(p).toEqual([{ name: "primary", baseUrl: "https://a/v1", model: "m1", apiKey: "k" }]);
  });
});

describe("parseToolArguments", () => {
  const call = (args: string) => ({ id: "1", type: "function" as const, function: { name: "t", arguments: args } });
  it("parses objects and rejects invalid JSON or non-objects", () => {
    expect(parseToolArguments(call('{"a":1}'))).toEqual({ a: 1 });
    expect(parseToolArguments(call(""))).toEqual({});
    expect(parseToolArguments(call("{bad"))).toBeNull();
    expect(parseToolArguments(call("[1,2]"))).toBeNull();
  });
});

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

  it("fails over when the primary returns a client error such as 404 (adapter missing)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("no such adapter", { status: 404 }))
      .mockResolvedValueOnce(ok("from fallback"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await chat({ messages: [{ role: "user", content: "x" }] }, providers);
    expect(res.provider).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails over when the primary hangs, within the overall budget", async () => {
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      if (url.startsWith("https://primary.test")) {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
        });
      }
      return Promise.resolve(ok("rescued"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    const res = await chat({ messages: [{ role: "user", content: "x" }], timeoutMs: 600 }, providers);
    expect(res.provider).toBe("fallback");
    expect(res.message.content).toBe("rescued");
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("does not retry a bad request when there is no fallback", async () => {
    const fetchMock = vi.fn(async () => new Response("bad schema", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chat({ messages: [{ role: "user", content: "x" }] }, [providers[0]])).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports every provider's error when all fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(chat({ messages: [{ role: "user", content: "x" }], timeoutMs: 5_000 }, providers)).rejects.toThrow(/primary: HTTP 503.*fallback: HTTP 503/);
  });

  it("sends tool_choice none and provider extra body fields", async () => {
    const fetchMock = vi.fn(async () => ok("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await chat(
      {
        messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: { name: "whats_due", description: "d", parameters: { type: "object" } } }],
        toolChoice: "none",
      },
      [{ ...providers[0], extraBody: { chat_template_kwargs: { enable_thinking: false } } }],
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tool_choice).toBe("none");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
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
  it("parses EXTRA_BODY JSON and ignores invalid values", () => {
    const p = providersFromEnv({
      LLM_PRIMARY_BASE_URL: "https://a/v1",
      LLM_PRIMARY_MODEL: "m1",
      LLM_PRIMARY_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}',
      LLM_FALLBACK_BASE_URL: "https://b/v1",
      LLM_FALLBACK_MODEL: "m2",
      LLM_FALLBACK_EXTRA_BODY: "not json",
    } as unknown as NodeJS.ProcessEnv);
    expect(p[0].extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(p[1].extraBody).toBeUndefined();
  });

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

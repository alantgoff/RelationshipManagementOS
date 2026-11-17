/**
 * LLM gateway for the live agent. Speaks the OpenAI-compatible Chat
 * Completions protocol, which Tinker sampling, OpenRouter, DeepInfra, vLLM,
 * SGLang and mlx-lm all expose. Providers are configured by environment:
 *
 *   LLM_PRIMARY_BASE_URL / LLM_PRIMARY_API_KEY / LLM_PRIMARY_MODEL
 *   LLM_FALLBACK_BASE_URL / LLM_FALLBACK_API_KEY / LLM_FALLBACK_MODEL
 *
 * The primary serves the fine-tuned adapter; the fallback serves the base
 * model. On a transient failure (network, timeout, 408/409/429/5xx) the
 * gateway retries once on the primary, then fails over. Client errors (other
 * 4xx) are not retried: they mean the request itself is wrong.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI-compatible multimodal content part (used for images). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Abort the whole call (including failover) after this many ms. */
  timeoutMs?: number;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
  provider: "primary" | "fallback";
  model: string;
  latencyMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface ProviderConfig {
  name: "primary" | "fallback";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Providers from environment. `group` "LLM" reads LLM_PRIMARY_* and
 * LLM_FALLBACK_*; "VISION" reads VISION_PRIMARY_* / VISION_FALLBACK_*.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env, group = "LLM"): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const name of ["primary", "fallback"] as const) {
    const prefix = `${group}_${name.toUpperCase()}_`;
    const baseUrl = env[`${prefix}BASE_URL`];
    const model = env[`${prefix}MODEL`];
    if (baseUrl && model) out.push({ name, baseUrl, model, apiKey: env[`${prefix}API_KEY`] ?? "" });
  }
  return out;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

async function callProvider(p: ProviderConfig, req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: p.model,
        messages: req.messages,
        ...(req.tools?.length ? { tools: req.tools, tool_choice: "auto" } : {}),
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 2048,
      }),
      signal,
    });
  } catch (err) {
    throw new LlmError(`${p.name}: ${err instanceof Error ? err.message : "network error"}`, null, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LlmError(`${p.name}: HTTP ${res.status} ${body.slice(0, 300)}`, res.status, RETRYABLE.has(res.status));
  }
  const json = (await res.json()) as {
    model?: string;
    choices?: { message?: ChatMessage; finish_reason?: string | null }[];
    usage?: ChatResult["usage"];
  };
  const choice = json.choices?.[0];
  if (!choice?.message) throw new LlmError(`${p.name}: response had no choices`, res.status, true);
  return {
    message: { ...choice.message, content: choice.message.content ?? null },
    finishReason: choice.finish_reason ?? null,
    provider: p.name,
    model: json.model ?? p.model,
    latencyMs: Date.now() - started,
    usage: json.usage,
  };
}

/** One chat turn with retry and failover across the configured providers. */
export async function chat(req: ChatRequest, providers: ProviderConfig[] = providersFromEnv()): Promise<ChatResult> {
  if (providers.length === 0) {
    throw new LlmError("No LLM provider configured (set LLM_PRIMARY_BASE_URL and LLM_PRIMARY_MODEL)", null, false);
  }
  const signal = AbortSignal.timeout(req.timeoutMs ?? 60_000);
  let last: LlmError | undefined;
  for (const p of providers) {
    const attempts = p.name === "primary" ? 2 : 1;
    for (let i = 0; i < attempts; i++) {
      try {
        return await callProvider(p, req, signal);
      } catch (err) {
        last = err instanceof LlmError ? err : new LlmError(String(err), null, true);
        if (!last.retryable || signal.aborted) throw last;
      }
    }
  }
  throw last ?? new LlmError("All providers failed", null, true);
}

/** Parse a tool call's JSON arguments; returns null when the model emitted invalid JSON. */
export function parseToolArguments(call: ToolCall): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

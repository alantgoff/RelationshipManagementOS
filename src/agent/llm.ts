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
  /** "none" makes the model answer in text even though tools are declared. */
  toolChoice?: "auto" | "none";
  /** Overall budget for the call, including retries and failover. */
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
  /** Provider-specific request fields, e.g. {"chat_template_kwargs":{"enable_thinking":false}}. */
  extraBody?: Record<string, unknown>;
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
 * Each may set *_EXTRA_BODY to a JSON object merged into every request
 * (for example to turn off a hybrid model's thinking mode).
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env, group = "LLM"): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const name of ["primary", "fallback"] as const) {
    const prefix = `${group}_${name.toUpperCase()}_`;
    const baseUrl = env[`${prefix}BASE_URL`];
    const model = env[`${prefix}MODEL`];
    if (!baseUrl || !model) continue;
    let extraBody: Record<string, unknown> | undefined;
    const rawExtra = env[`${prefix}EXTRA_BODY`];
    if (rawExtra) {
      try {
        const parsed: unknown = JSON.parse(rawExtra);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraBody = parsed as Record<string, unknown>;
      } catch {
        console.warn(`[llm] ignoring ${prefix}EXTRA_BODY: not valid JSON`);
      }
    }
    out.push({ name, baseUrl, model, apiKey: env[`${prefix}API_KEY`] ?? "", ...(extraBody ? { extraBody } : {}) });
  }
  return out;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
/** Longest a single primary attempt may take when a fallback is configured. */
export const PRIMARY_ATTEMPT_CAP_MS = 30_000;

async function callProvider(p: ProviderConfig, req: ChatRequest, timeoutMs: number): Promise<ChatResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
  let res: Response;
  let json: {
    model?: string;
    choices?: { message?: ChatMessage; finish_reason?: string | null }[];
    usage?: ChatResult["usage"];
  };
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
        ...(req.tools?.length ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 2048,
        ...p.extraBody,
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LlmError(`${p.name}: HTTP ${res.status} ${body.slice(0, 300)}`, res.status, RETRYABLE.has(res.status));
    }
    json = await res.json();
  } catch (err) {
    if (err instanceof LlmError) throw err;
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new LlmError(`${p.name}: ${timedOut ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : "network error"}`, null, !timedOut);
  }
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

/**
 * One chat turn with retry and failover (HA-9). Each attempt has its own
 * deadline inside the overall budget. When a fallback is configured, a
 * primary attempt may use at most 60% of the remaining time (capped at
 * PRIMARY_ATTEMPT_CAP_MS), so a hung or erroring primary still leaves time
 * for the fallback. Any primary failure moves on to the fallback; only fast,
 * transient errors are retried on the same provider.
 */
export async function chat(req: ChatRequest, providers: ProviderConfig[] = providersFromEnv()): Promise<ChatResult> {
  if (providers.length === 0) {
    throw new LlmError("No LLM provider configured (set LLM_PRIMARY_BASE_URL and LLM_PRIMARY_MODEL)", null, false);
  }
  const deadline = Date.now() + (req.timeoutMs ?? 60_000);
  const errors: LlmError[] = [];
  for (let pi = 0; pi < providers.length; pi++) {
    const p = providers[pi];
    const hasNext = pi < providers.length - 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 50) break;
      const budget = hasNext ? Math.min(PRIMARY_ATTEMPT_CAP_MS, Math.floor(remaining * 0.6)) : remaining;
      try {
        return await callProvider(p, req, budget);
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError(String(err), null, true);
        errors.push(e);
        // Retry the same provider only for fast transient failures; anything else goes to the next provider.
        if (!e.retryable || deadline - Date.now() < 2_000) break;
      }
    }
    if (deadline - Date.now() <= 50) break;
  }
  const last = errors.at(-1) ?? new LlmError("LLM call ran out of time before any provider answered", null, true);
  throw new LlmError(errors.length > 1 ? errors.map((e) => e.message).join(" | ") : last.message, last.status, last.retryable);
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

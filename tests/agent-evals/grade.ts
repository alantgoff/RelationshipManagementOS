import { parseToolArguments, type ChatResult } from "@/agent/llm";
import { isToolName, validateToolInput } from "@/agent/tool-specs";
import type { ArgMatcher, ToolScenario } from "./tool-scenarios";

export interface GradeResult {
  id: string;
  pass: boolean;
  /** The first tool the model called, or null. */
  tool: string | null;
  /** Tool arguments were valid JSON (true when no tool was called). */
  jsonValid: boolean;
  /** Tool arguments satisfied the tool's schema (true when no tool was called). */
  schemaValid: boolean;
  reasons: string[];
  latencyMs?: number;
  provider?: string;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function matches(value: unknown, m: ArgMatcher): boolean {
  if (typeof m !== "object") return value === m;
  if ("present" in m) return value !== undefined && value !== null && value !== "";
  if ("absent" in m) return value === undefined || value === null;
  if ("oneOf" in m) return m.oneOf.includes(value as string | number | boolean);
  if ("includes" in m) {
    const needle = m.includes.toLowerCase();
    if (typeof value === "string") return value.toLowerCase().includes(needle);
    if (Array.isArray(value)) return value.some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
    return false;
  }
  if ("contains" in m) return Array.isArray(value) && value.includes(m.contains);
  return false;
}

/** Grade the first tool call of a model response against a scenario. Pure. */
export function gradeFirstCall(s: ToolScenario, r: Pick<ChatResult, "message" | "latencyMs" | "provider">): GradeResult {
  const call = r.message.tool_calls?.[0];
  const base = { id: s.id, latencyMs: r.latencyMs, provider: r.provider };

  if (!call) {
    const pass = s.expectTool === null;
    return {
      ...base,
      pass,
      tool: null,
      jsonValid: true,
      schemaValid: true,
      reasons: pass ? [] : [`expected ${s.expectTool?.join(" | ")}, got no tool call`],
    };
  }

  const reasons: string[] = [];
  const tool = call.function.name;
  if (s.expectTool === null) reasons.push(`expected no tool, got ${tool}`);
  else if (!s.expectTool.includes(tool as never)) reasons.push(`expected ${s.expectTool.join(" | ")}, got ${tool}`);

  const args = parseToolArguments(call);
  const jsonValid = args !== null;
  if (!jsonValid) reasons.push("arguments were not a JSON object");

  let schemaValid = false;
  if (!isToolName(tool)) reasons.push(`unknown tool ${tool}`);
  else if (args) {
    const parsed = validateToolInput(tool, args);
    schemaValid = parsed.success;
    if (!parsed.success) reasons.push(`schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }

  if (args && s.expectArgs) {
    for (const [path, matcher] of Object.entries(s.expectArgs)) {
      const value = getPath(args, path);
      if (!matches(value, matcher)) reasons.push(`${path}: got ${JSON.stringify(value)}, want ${JSON.stringify(matcher)}`);
    }
  }

  return { ...base, pass: reasons.length === 0, tool, jsonValid, schemaValid, reasons };
}

export interface Summary {
  total: number;
  passed: number;
  passRate: number;
  toolAccuracy: number;
  jsonValidity: number;
  schemaValidity: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  fallbackRate: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function summarize(results: GradeResult[]): Summary {
  const n = results.length || 1;
  const withCall = results.filter((r) => r.tool !== null);
  const latencies = results.map((r) => r.latencyMs).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    passRate: results.filter((r) => r.pass).length / n,
    toolAccuracy: results.filter((r) => !r.reasons.some((x) => x.startsWith("expected"))).length / n,
    jsonValidity: withCall.length ? withCall.filter((r) => r.jsonValid).length / withCall.length : 1,
    schemaValidity: withCall.length ? withCall.filter((r) => r.schemaValid).length / withCall.length : 1,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    fallbackRate: results.filter((r) => r.provider === "fallback").length / n,
  };
}

import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/agent/llm";
import { TOOL_NAMES, toolSpecs, validateToolInput } from "@/agent/tool-specs";
import { gradeFirstCall, matches, summarize } from "../agent-evals/grade";
import { TOOL_SCENARIOS, type ToolScenario } from "../agent-evals/tool-scenarios";

function reply(toolName?: string, args?: unknown): { message: ChatMessage; latencyMs: number; provider: "primary" } {
  return {
    latencyMs: 100,
    provider: "primary",
    message: {
      role: "assistant",
      content: toolName ? null : "Anytime!",
      tool_calls: toolName
        ? [{ id: "c1", type: "function", function: { name: toolName, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } }]
        : undefined,
    },
  };
}

describe("tool specs", () => {
  it("produce a sorted, deterministic list of JSON-schema tools", () => {
    const a = toolSpecs();
    const b = toolSpecs();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.map((t) => t.function.name)).toEqual([...TOOL_NAMES].sort());
    for (const t of a) {
      expect(t.function.parameters.type).toBe("object");
      expect(t.function.description.length).toBeGreaterThan(10);
    }
  });

  it("validate arguments against the tool schema", () => {
    expect(validateToolInput("set_reminder", { person_id: "p1", due_on: "2026-10-08", reason: "bday" }).success).toBe(true);
    expect(validateToolInput("set_reminder", { person_id: "p1", due_on: "Oct 8", reason: "bday" }).success).toBe(false);
  });
});

describe("scenarios", () => {
  it("have unique ids and only reference real tools", () => {
    const ids = TOOL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of TOOL_SCENARIOS) for (const t of s.expectTool ?? []) expect(TOOL_NAMES).toContain(t);
  });
});

describe("matches", () => {
  it("supports each matcher kind", () => {
    expect(matches("call", "call")).toBe(true);
    expect(matches(250000, 250000)).toBe(true);
    expect(matches("Tom Becker", { includes: "tom" })).toBe(true);
    expect(matches(["climate", "Boston"], { includes: "bos" })).toBe(true);
    expect(matches("p_raj", { oneOf: ["p_raj", "p_leo"] })).toBe(true);
    expect(matches(undefined, { present: true })).toBe(false);
    expect(matches(undefined, { absent: true })).toBe(true);
    expect(matches(["a", "b"], { contains: "b" })).toBe(true);
  });
});

describe("gradeFirstCall", () => {
  const scenario = TOOL_SCENARIOS.find((s) => s.id === "log-call-with-promise") as ToolScenario;

  it("passes a correct call, including nested argument paths", () => {
    const g = gradeFirstCall(
      scenario,
      reply("log_interaction", {
        person_id: "p_raj",
        type: "call",
        summary: "Seed round",
        occurred_on: "2026-09-23",
        follow_ups: [{ description: "3 angel intros", due_on: "2026-09-25" }],
      }),
    );
    expect(g).toMatchObject({ pass: true, jsonValid: true, schemaValid: true, reasons: [] });
  });

  it("fails the wrong tool, wrong args, invalid JSON, and schema violations with reasons", () => {
    expect(gradeFirstCall(scenario, reply("whats_due", {})).reasons[0]).toMatch(/expected log_interaction/);
    const wrongDate = gradeFirstCall(
      scenario,
      reply("log_interaction", { person_id: "p_raj", type: "call", summary: "x", occurred_on: "2026-09-24" }),
    );
    expect(wrongDate.pass).toBe(false);
    expect(wrongDate.reasons.join(" ")).toMatch(/occurred_on/);
    expect(gradeFirstCall(scenario, reply("log_interaction", "{not json")).jsonValid).toBe(false);
    const badSchema = gradeFirstCall(scenario, reply("log_interaction", { person_id: "p_raj", type: "coffee" }));
    expect(badSchema.schemaValid).toBe(false);
  });

  it("handles no-tool scenarios both ways", () => {
    const smallTalk = TOOL_SCENARIOS.find((s) => s.expectTool === null) as ToolScenario;
    expect(gradeFirstCall(smallTalk, reply()).pass).toBe(true);
    expect(gradeFirstCall(smallTalk, reply("whats_due", {})).pass).toBe(false);
    expect(gradeFirstCall(scenario, reply()).pass).toBe(false);
  });
});

describe("summarize", () => {
  it("computes rates and latency percentiles", () => {
    const s = summarize([
      { id: "a", pass: true, tool: "x", jsonValid: true, schemaValid: true, reasons: [], latencyMs: 100, provider: "primary" },
      { id: "b", pass: false, tool: "y", jsonValid: false, schemaValid: false, reasons: ["arguments were not a JSON object"], latencyMs: 300, provider: "fallback" },
    ]);
    expect(s).toMatchObject({ total: 2, passed: 1, passRate: 0.5, toolAccuracy: 1, jsonValidity: 0.5, fallbackRate: 0.5 });
    expect(s.p50LatencyMs).toBe(300);
  });
});

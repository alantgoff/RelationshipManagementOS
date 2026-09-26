/**
 * Agent eval runner.
 *
 *   npm run eval                     # all first-call tool scenarios, once
 *   npm run eval -- --repeat 3       # run each scenario 3 times (catch flakiness)
 *   npm run eval -- --only soft-circle,intro
 *   npm run eval -- --min 0.9        # exit 1 if pass rate is below 90%
 *
 * Reads LLM_PRIMARY_* / LLM_FALLBACK_* from .env.local (see src/agent/llm.ts).
 * Results are written to .eval-results/<timestamp>.json.
 */
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { chat, providersFromEnv } from "../src/agent/llm";
import { AGENT_SYSTEM_PROMPT, buildTurnContext } from "../src/agent/prompt";
import { toolSpecs } from "../src/agent/tool-specs";
import { gradeFirstCall, summarize, type GradeResult } from "../tests/agent-evals/grade";
import { EVAL_TODAY, EVAL_WEEKDAY, EVAL_WORKING_SET, TOOL_SCENARIOS } from "../tests/agent-evals/tool-scenarios";

config({ path: ".env.local" });
config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const providers = providersFromEnv();
  if (providers.length === 0) {
    console.error("No LLM provider configured. Set LLM_PRIMARY_BASE_URL, LLM_PRIMARY_API_KEY and LLM_PRIMARY_MODEL.");
    process.exit(2);
  }
  const repeat = Number(arg("repeat") ?? 1);
  const only = arg("only")?.split(",");
  const min = arg("min") ? Number(arg("min")) : undefined;
  const scenarios = TOOL_SCENARIOS.filter((s) => !only || only.includes(s.id));
  const tools = toolSpecs();
  const context = buildTurnContext({ today: EVAL_TODAY, weekday: EVAL_WEEKDAY, workingSet: EVAL_WORKING_SET });

  console.log(`Providers: ${providers.map((p) => `${p.name}=${p.model}`).join(", ")}`);
  console.log(`Running ${scenarios.length} scenarios × ${repeat}\n`);

  const results: GradeResult[] = [];
  for (let r = 0; r < repeat; r++) {
    for (const s of scenarios) {
      try {
        const res = await chat(
          {
            messages: [
              { role: "system", content: `${AGENT_SYSTEM_PROMPT}\n\n${context}` },
              { role: "user", content: s.message },
            ],
            tools,
            temperature: 0.2,
            timeoutMs: 90_000,
          },
          providers,
        );
        const g = gradeFirstCall(s, res);
        results.push(g);
        console.log(`${g.pass ? "PASS" : "FAIL"}  ${s.id.padEnd(30)} ${String(g.tool ?? "(no tool)").padEnd(20)} ${g.latencyMs}ms ${g.provider}`);
        for (const reason of g.reasons) console.log(`        ${reason}`);
      } catch (err) {
        results.push({ id: s.id, pass: false, tool: null, jsonValid: false, schemaValid: false, reasons: [String(err)] });
        console.log(`ERROR ${s.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const summary = summarize(results);
  console.log("\nSummary");
  console.table({
    "pass rate": summary.passRate.toFixed(2),
    "tool accuracy": summary.toolAccuracy.toFixed(2),
    "json validity": summary.jsonValidity.toFixed(2),
    "schema validity": summary.schemaValidity.toFixed(2),
    "p50 latency ms": summary.p50LatencyMs,
    "p95 latency ms": summary.p95LatencyMs,
    "fallback rate": summary.fallbackRate.toFixed(2),
  });

  mkdirSync(".eval-results", { recursive: true });
  const file = `.eval-results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ providers: providers.map((p) => ({ name: p.name, model: p.model })), summary, results }, null, 2));
  console.log(`\nSaved ${file}`);

  if (min !== undefined && summary.passRate < min) {
    console.error(`Pass rate ${summary.passRate.toFixed(2)} is below --min ${min}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

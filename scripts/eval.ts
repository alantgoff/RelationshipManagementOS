/**
 * Agent eval runner.
 *
 *   npm run eval                     # first-call suite: the model's first tool call for 20 messages
 *   npm run eval -- --suite turns    # full turns: real runtime + tools on a scratch DB, checks records written
 *   npm run eval -- --repeat 3       # run each scenario 3 times (catch flakiness)
 *   npm run eval -- --only soft-circle,intro
 *   npm run eval -- --min 0.9        # exit 1 if pass rate is below 90%
 *
 * Reads LLM_PRIMARY_* / LLM_FALLBACK_* from .env.local (see src/agent/llm.ts).
 * The turns suite WIPES its database: it uses EVAL_DATABASE_URL (default: the
 * local rmos_test database) and refuses to run against DATABASE_URL.
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

interface TurnOutcome {
  id: string;
  pass: boolean;
  reasons: string[];
  reply: string;
  latencyMs: number;
}

/** Full turns against a scratch database with the live model. */
async function runTurnsSuite(providers: ReturnType<typeof providersFromEnv>, repeat: number, only?: string[]): Promise<TurnOutcome[]> {
  const evalUrl = process.env.EVAL_DATABASE_URL ?? "postgres://rmos:rmos@localhost:5432/rmos_test";
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === evalUrl && !process.argv.includes("--force")) {
    throw new Error("EVAL_DATABASE_URL equals DATABASE_URL; the turns suite wipes its database. Point it at a scratch database (or pass --force).");
  }
  process.env.DATABASE_URL = evalUrl;
  process.env.RMOS_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");

  const { receiveInbound } = await import("../src/agent/runtime");
  const { defaultMediaDeps } = await import("../src/agent/media");
  const { closeDb } = await import("../src/db/client");
  const { TURN_SCENARIOS, TURN_NOW, EVAL_OWNER, EVAL_PHONE, resetEvalDb, seedTurnFixture } = await import("../tests/agent-evals/turn-scenarios");

  const outcomes: TurnOutcome[] = [];
  const scenarios = TURN_SCENARIOS.filter((s) => !only || only.includes(s.id));
  console.log(`Running ${scenarios.length} full-turn scenarios × ${repeat} against ${evalUrl.replace(/:[^:@/]+@/, ":***@")}\n`);
  try {
    for (let r = 0; r < repeat; r++) {
      for (const s of scenarios) {
        await resetEvalDb();
        const ids = await seedTurnFixture();
        const sent: string[] = [];
        let n = 0;
        const adapter = {
          name: "eval",
          verify: () => true,
          parseInbound: (b: unknown) => b as never,
          sendText: async (_to: string, text: string) => {
            sent.push(text);
            return { providerMessageId: `eval-out-${++n}` };
          },
        };
        const deps = { adapter, llm: (req: Parameters<typeof chat>[0]) => chat(req, providers), media: defaultMediaDeps(), now: () => TURN_NOW };
        const started = Date.now();
        let reasons: string[];
        try {
          const res = await receiveInbound(deps, {
            providerMessageId: `eval-${s.id}-${r}`,
            from: EVAL_PHONE,
            text: s.message,
            media: [],
            receivedAt: TURN_NOW,
          });
          if (!("work" in res)) throw new Error(`message was not accepted: ${res.status}`);
          await res.work();
          reasons = await s.check({ userId: EVAL_OWNER, ids, reply: sent[0] ?? "", sent });
        } catch (err) {
          reasons = [`error: ${err instanceof Error ? err.message : String(err)}`];
        }
        const outcome = { id: s.id, pass: reasons.length === 0, reasons, reply: sent[0] ?? "", latencyMs: Date.now() - started };
        outcomes.push(outcome);
        console.log(`${outcome.pass ? "PASS" : "FAIL"}  ${s.id.padEnd(24)} ${outcome.latencyMs}ms  ${outcome.reply.slice(0, 80).replace(/\n/g, " ")}`);
        for (const reason of reasons) console.log(`        ${reason}`);
      }
    }
  } finally {
    await closeDb();
  }
  return outcomes;
}

async function main() {
  const providers = providersFromEnv();
  if (providers.length === 0) {
    console.error("No LLM provider configured. Set LLM_PRIMARY_BASE_URL, LLM_PRIMARY_API_KEY and LLM_PRIMARY_MODEL.");
    process.exit(2);
  }
  const suite = arg("suite") ?? "first-call";
  if (suite === "turns") {
    const repeat = Number(arg("repeat") ?? 1);
    const min = arg("min") ? Number(arg("min")) : undefined;
    const outcomes = await runTurnsSuite(providers, repeat, arg("only")?.split(","));
    const passRate = outcomes.filter((o) => o.pass).length / (outcomes.length || 1);
    console.log(`\nTurns pass rate: ${passRate.toFixed(2)} (${outcomes.filter((o) => o.pass).length}/${outcomes.length})`);
    mkdirSync(".eval-results", { recursive: true });
    const file = `.eval-results/turns-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify({ providers: providers.map((p) => ({ name: p.name, model: p.model })), passRate, outcomes }, null, 2));
    console.log(`Saved ${file}`);
    if (min !== undefined && passRate < min) process.exit(1);
    return;
  }
  if (suite !== "first-call") {
    console.error(`Unknown suite "${suite}". Use first-call or turns.`);
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
              { role: "system", content: AGENT_SYSTEM_PROMPT },
              { role: "user", content: `${context}\n\n${s.message}` },
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

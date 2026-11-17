import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runBriefTick } from "@/agent/runtime";
import { createBindingCode, updateAgentPrefs } from "@/agent/store";
import { getDb } from "@/db/client";
import { channelMessages, notificationLog } from "@/db/schema";
import { createPerson } from "@/server/actions/people";
import { updateSettings } from "@/server/actions/settings";
import { actAs, resetDb, teardownDb } from "./helpers";
import { FakeLine, makeDeps, say, scriptedModel, text } from "./agent-harness";

const OWNER = "owner-brief";
/** Thursday 2026-09-24, 07:35 in New York. */
const THU_0735 = new Date("2026-09-24T11:35:00Z");

async function setup(now = THU_0735, steps: Parameters<typeof scriptedModel>[0] = [say("Morning! Priya is going cold — ask how the Halcyon raise is going.")]) {
  actAs(OWNER);
  await updateSettings({ timezone: "America/New_York", defaultCadences: {} });
  const line = new FakeLine();
  const model = scriptedModel(steps);
  const deps = makeDeps(line, model.llm, now);
  const { code } = await createBindingCode(OWNER, "test", now);
  await text(deps, code);
  line.sent = [];
  return { line, model, deps };
}

beforeEach(async () => {
  actAs(OWNER);
  await resetDb();
});
afterAll(teardownDb);

describe("morning brief tick (HAC-7)", () => {
  it("sends once on a weekday inside the window and logs it", async () => {
    await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const { line, deps } = await setup();
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: true }]);
    expect(line.texts()).toEqual(["Morning! Priya is going cold — ask how the Halcyon raise is going."]);
    expect(await runBriefTick(deps)).toEqual([{ userId: OWNER, sent: false, skipped: "already_sent" }]);
    expect(line.sent).toHaveLength(1);
    const logs = await getDb().select().from(notificationLog);
    expect(logs).toMatchObject([{ kind: "brief", localDate: "2026-09-24" }]);
    expect(logs[0].messageId).not.toBeNull();
  });

  it("skips weekends, pauses, stop, and days with nothing to say", async () => {
    const saturday = await setup(new Date("2026-09-26T11:35:00Z"));
    expect((await runBriefTick(saturday.deps))[0].skipped).toBe("weekend");

    await resetDb();
    const quiet = await setup();
    expect((await runBriefTick(quiet.deps))[0].skipped).toBe("nothing_due");

    await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    await updateAgentPrefs(OWNER, { pausedUntil: new Date("2026-09-24T14:00:00Z") });
    expect((await runBriefTick(quiet.deps))[0].skipped).toBe("paused");
    await updateAgentPrefs(OWNER, { pausedUntil: null, proactiveEnabled: false });
    expect((await runBriefTick(quiet.deps))[0].skipped).toBe("stopped");
    expect(quiet.line.sent).toHaveLength(0);
  });

  it("falls back to a template when the model fails, and dry runs send nothing", async () => {
    await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const { line, deps } = await setup(THU_0735, [say("preview text that is long enough"), new Error("model down")]);
    const dry = await runBriefTick(deps, { dryRun: true });
    expect(dry[0].preview).toBe("preview text that is long enough");
    expect(line.sent).toHaveLength(0);
    expect(await getDb().select().from(notificationLog)).toHaveLength(0);

    expect((await runBriefTick(deps))[0].sent).toBe(true);
    expect(line.texts()[0]).toBe("Good morning. Thursday's brief:\nReach out: Priya Patel (never contacted).");
  });

  it("releases the slot when sending fails so a later tick can retry", async () => {
    await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const { line, deps } = await setup(THU_0735, [say("Brief one is long enough."), say("Brief two is long enough.")]);
    line.fail = true;
    expect((await runBriefTick(deps))[0].skipped).toBe("error");
    line.fail = false;
    expect((await runBriefTick(deps))[0].sent).toBe(true);
    const briefs = (await getDb().select().from(channelMessages)).filter((m) => m.kind === "brief");
    expect(briefs).toHaveLength(1);
  });

  it("the brief command works any time and doesn't count against the budget", async () => {
    await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const { line, deps } = await setup(new Date("2026-09-26T20:00:00Z"), [say("On-demand brief text here.")]);
    await text(deps, "brief");
    expect(line.texts().at(-1)).toBe("On-demand brief text here.");
    expect(await getDb().select().from(notificationLog)).toHaveLength(0);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPerson } from "@/server/actions/people";
import { currentAgentRun, requireUserId, runAsOwner } from "@/server/auth";
import { listPeople } from "@/server/queries/people";
import { actAs, resetDb, teardownDb } from "./helpers";

beforeEach(async () => {
  actAs("web-user");
  await resetDb();
});
afterAll(teardownDb);

describe("runAsOwner", () => {
  it("scopes existing actions and queries to the agent's owner", async () => {
    await createPerson({ fullName: "Web Person" });
    const created = await runAsOwner("agent-owner", "channel", async () => {
      expect(await requireUserId()).toBe("agent-owner");
      expect(currentAgentRun()).toEqual({ userId: "agent-owner", source: "channel" });
      await createPerson({ fullName: "Agent Person" });
      return (await listPeople()).map((p) => p.fullName);
    });
    expect(created).toEqual(["Agent Person"]);
    expect((await listPeople()).map((p) => p.fullName)).toEqual(["Web Person"]);
    expect(currentAgentRun()).toBeUndefined();
  });

  it("keeps concurrent runs isolated", async () => {
    const [a, b] = await Promise.all([
      runAsOwner("owner-a", "cron", async () => {
        await new Promise((r) => setTimeout(r, 20));
        return requireUserId();
      }),
      runAsOwner("owner-b", "cron", async () => requireUserId()),
    ]);
    expect([a, b]).toEqual(["owner-a", "owner-b"]);
  });

  it("refuses an empty user id", () => {
    expect(() => runAsOwner("", "script", async () => 1)).toThrow();
  });
});

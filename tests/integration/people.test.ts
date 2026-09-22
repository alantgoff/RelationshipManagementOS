import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { archivePerson, createPerson, mergePeople, restorePerson, setLpStage, updatePerson } from "@/server/actions/people";
import { logInteraction } from "@/server/actions/interactions";
import { listPeople, listPeopleForPicker } from "@/server/queries/people";
import { getPerson } from "@/server/queries/person";
import { actAs, daysAgo, resetDb, teardownDb } from "./helpers";

beforeEach(async () => {
  actAs("test-user");
  await resetDb();
});
afterAll(teardownDb);

describe("people", () => {
  it("AC-1: creating a prospective LP applies the 21-day default cadence", async () => {
    const { id } = await createPerson({ fullName: "Priya Patel", roles: ["prospective_lp"] });
    const p = await getPerson(id);
    expect(p?.cadenceDays).toBe(21);
    expect(p?.health).toBe("never");
  });

  it("shortest role default wins; explicit cadence is kept", async () => {
    const a = await createPerson({ fullName: "A", roles: ["co_investor", "family"] });
    const b = await createPerson({ fullName: "B", roles: ["co_investor"], cadenceDays: 7 });
    expect((await getPerson(a.id))?.cadenceDays).toBe(30);
    expect((await getPerson(b.id))?.cadenceDays).toBe(7);
  });

  it("stores tags, roles, and fund fields; edits replace tags", async () => {
    const { id } = await createPerson({
      fullName: "Dana Deal",
      roles: ["deal_source"],
      tags: ["YC", "Boston"],
      dealSourceQuality: "high",
      email: "Dana@Example.com",
    });
    let p = await getPerson(id);
    expect(p?.tags).toEqual(["Boston", "YC"]);
    expect(p?.dealSourceQuality).toBe("high");
    expect(p?.email).toBe("dana@example.com");
    await updatePerson(id, { fullName: "Dana Deal", roles: ["deal_source"], tags: ["climate"] });
    p = await getPerson(id);
    expect(p?.tags).toEqual(["climate"]);
  });

  it("AC-8: setting lpStage to committed adds the committed_lp role", async () => {
    const { id } = await createPerson({ fullName: "Lee LP", roles: ["prospective_lp"] });
    await setLpStage(id, "committed");
    const p = await getPerson(id);
    expect(p?.lpStage).toBe("committed");
    expect(p?.roles).toContain("committed_lp");
    expect(p?.roles).toContain("prospective_lp");
  });

  it("archive hides from lists; restore brings back", async () => {
    const { id } = await createPerson({ fullName: "Old Friend", roles: ["friend"] });
    await archivePerson(id);
    expect((await listPeople()).map((p) => p.id)).not.toContain(id);
    expect((await listPeople({ includeArchived: true })).map((p) => p.id)).toContain(id);
    expect((await listPeopleForPicker()).map((p) => p.id)).not.toContain(id);
    await restorePerson(id);
    expect((await listPeople()).map((p) => p.id)).toContain(id);
  });

  it("FR-5: merge keeps interactions, unions roles and tags, deletes source", async () => {
    const t = await createPerson({ fullName: "Target", roles: ["friend"], tags: ["a"] });
    const s = await createPerson({ fullName: "Source", roles: ["founder"], tags: ["b"], company: "Acme" });
    await logInteraction({ personId: s.id, type: "call", summary: "from source" });
    await mergePeople(t.id, s.id);
    const merged = await getPerson(t.id);
    expect(merged?.roles.sort()).toEqual(["founder", "friend"]);
    expect(merged?.tags).toEqual(["a", "b"]);
    expect(merged?.company).toBe("Acme");
    expect(merged?.timeline.map((i) => i.summary)).toEqual(["from source"]);
    expect(await getPerson(s.id)).toBeNull();
  });

  it("FR-18: search matches name, company, tags, and interaction notes", async () => {
    const a = await createPerson({ fullName: "Alice Aardvark", company: "Zephyr Capital", tags: ["climate"] });
    const b = await createPerson({ fullName: "Bob Brook" });
    await logInteraction({ personId: b.id, type: "meeting", summary: "Coffee", notes: "Talked about quantum widgets" });
    expect((await listPeople({ q: "zephyr" })).map((p) => p.id)).toEqual([a.id]);
    expect((await listPeople({ q: "climate" })).map((p) => p.id)).toEqual([a.id]);
    expect((await listPeople({ q: "quantum" })).map((p) => p.id)).toEqual([b.id]);
    expect((await listPeople({ q: "aardvark" })).map((p) => p.id)).toEqual([a.id]);
  });

  it("filters by role and sorts by health", async () => {
    const cold = await createPerson({ fullName: "Cold", roles: ["prospective_lp"] });
    await logInteraction({ personId: cold.id, type: "call", summary: "long ago", occurredAt: daysAgo(60) });
    const fresh = await createPerson({ fullName: "Fresh", roles: ["prospective_lp"] });
    await logInteraction({ personId: fresh.id, type: "call", summary: "today" });
    await createPerson({ fullName: "Friend", roles: ["friend"] });
    const lps = await listPeople({ role: "prospective_lp", sort: "health" });
    expect(lps.map((p) => p.fullName)).toEqual(["Cold", "Fresh"]);
    expect(lps[0].health).toBe("cold");
  });

  it("AC-9: another user sees nothing and cannot read by id", async () => {
    const { id } = await createPerson({ fullName: "Mine", roles: ["friend"] });
    actAs("other-user");
    expect(await listPeople()).toEqual([]);
    expect(await getPerson(id)).toBeNull();
    await expect(updatePerson(id, { fullName: "Hijack" })).rejects.toThrow();
    await expect(logInteraction({ personId: id, type: "call", summary: "x" })).rejects.toThrow();
    actAs("test-user");
    expect((await getPerson(id))?.fullName).toBe("Mine");
  });
});

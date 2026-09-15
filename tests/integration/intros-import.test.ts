import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { importPeople } from "@/server/actions/import";
import { logInteraction } from "@/server/actions/interactions";
import { createPerson } from "@/server/actions/people";
import { listPeople, listPeopleWithEmail } from "@/server/queries/people";
import { getPerson } from "@/server/queries/person";
import { findDuplicates, mapRows, type ImportedPerson } from "@/domain/csv";
import { actAs, resetDb, teardownDb } from "./helpers";

beforeEach(async () => {
  actAs("test-user");
  await resetDb();
});
afterAll(teardownDb);

describe("intros", () => {
  it("AC-5: an intro from A to B shows on both timelines and counts as received for B", async () => {
    const a = await createPerson({ fullName: "Ann", roles: ["deal_source"] });
    const b = await createPerson({ fullName: "Ben", roles: ["founder"] });
    await logInteraction({ personId: a.id, type: "intro", summary: "Intro to Ben", introducedPersonId: b.id });

    const pa = await getPerson(a.id);
    const pb = await getPerson(b.id);
    expect(pa?.timeline.map((i) => [i.summary, i.introducedPersonName])).toEqual([["Intro to Ben", "Ben"]]);
    expect(pb?.timeline.map((i) => [i.summary, i.viaPersonName])).toEqual([["Intro to Ben", "Ann"]]);
    expect(pa?.introsGiven).toBe(1);
    expect(pa?.introsReceived).toBe(0);
    expect(pb?.introsReceived).toBe(1);
    expect(pb?.introsGiven).toBe(0);
    // Being introduced does not count as contact with B for health purposes.
    expect(pb?.lastInteractionAt).toBeNull();
  });

  it("rejects self-intros and cross-owner intro targets", async () => {
    const a = await createPerson({ fullName: "Ann" });
    await expect(logInteraction({ personId: a.id, type: "intro", summary: "x", introducedPersonId: a.id })).rejects.toThrow();
    actAs("other-user");
    const stranger = await createPerson({ fullName: "Stranger" });
    actAs("test-user");
    await expect(logInteraction({ personId: a.id, type: "intro", summary: "x", introducedPersonId: stranger.id })).rejects.toThrow();
  });
});

function rows(n: number, dupeEmails: string[]): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let i = 0; i < n; i++) {
    const email = dupeEmails[i] ?? `person${i}@example.com`;
    out.push({ Name: `Person ${i}`, Email: email, Roles: i % 2 ? "friend" : "LP", Tags: "import" });
  }
  return out;
}

describe("import", () => {
  it("AC-6: 50 rows with 2 duplicate emails prompts on both; skip gives 48, merge gives 50 rows but 48 new", async () => {
    await createPerson({ fullName: "Existing One", email: "dupe1@example.com" });
    await createPerson({ fullName: "Existing Two", email: "dupe2@example.com" });

    const mapping = { Name: "fullName", Email: "email", Roles: "roles", Tags: "tags" } as const;
    const mapped = mapRows(rows(50, ["dupe1@example.com", "dupe2@example.com"]), mapping);
    expect(mapped.people).toHaveLength(50);
    const dupes = findDuplicates(mapped.people, await listPeopleWithEmail());
    expect(dupes.size).toBe(2);

    // Skip both
    const skipped = await importPeople({
      people: mapped.people,
      decisions: Object.fromEntries([...dupes.keys()].map((i) => [i, { action: "skip" as const }])),
    });
    expect(skipped).toEqual({ created: 48, merged: 0, skipped: 2 });
    expect(await listPeople()).toHaveLength(50);

    // Reset and merge both instead
    await resetDb();
    const e1 = await createPerson({ fullName: "Existing One", email: "dupe1@example.com" });
    const e2 = await createPerson({ fullName: "Existing Two", email: "dupe2@example.com" });
    const dupes2 = findDuplicates(mapped.people, await listPeopleWithEmail());
    const decisions = Object.fromEntries([...dupes2.entries()].map(([i, ex]) => [i, { action: "merge" as const, existingId: ex.id }]));
    const merged = await importPeople({ people: mapped.people, decisions });
    expect(merged).toEqual({ created: 48, merged: 2, skipped: 0 });
    expect(await listPeople()).toHaveLength(50);
    const m1 = await getPerson(e1.id);
    expect(m1?.roles).toContain("prospective_lp");
    expect(m1?.tags).toEqual(["import"]);
    expect(m1?.cadenceDays).toBe(21);
    expect((await getPerson(e2.id))?.roles).toContain("friend");
  });

  it("applies default cadence to imported people and rejects merge into another owner's person", async () => {
    actAs("other-user");
    const stranger = await createPerson({ fullName: "Stranger", email: "s@x.com" });
    actAs("test-user");
    const people: ImportedPerson[] = [{ fullName: "New LP", email: "s@x.com", roles: ["prospective_lp"], tags: [] }];
    const r = await importPeople({ people, decisions: { 0: { action: "merge", existingId: stranger.id } } });
    expect(r).toEqual({ created: 0, merged: 0, skipped: 1 });
    const r2 = await importPeople({ people, decisions: {} });
    expect(r2.created).toBe(1);
    const [p] = await listPeople();
    expect(p.cadenceDays).toBe(21);
  });
});

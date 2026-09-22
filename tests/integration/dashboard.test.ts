import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addFollowUp, deleteInteraction, logInteraction, setFollowUpDone } from "@/server/actions/interactions";
import { createPerson } from "@/server/actions/people";
import { completeReminder, createReminder, snoozeReminder } from "@/server/actions/reminders";
import { updateSettings } from "@/server/actions/settings";
import { getDashboard } from "@/server/queries/dashboard";
import { getPerson } from "@/server/queries/person";
import { actAs, daysAgo, daysFromNow, resetDb, teardownDb } from "./helpers";

beforeEach(async () => {
  actAs("test-user");
  await resetDb();
});
afterAll(teardownDb);

describe("dashboard", () => {
  it("AC-2: a never-contacted LP shows; logging a meeting removes them and makes them fresh", async () => {
    const { id } = await createPerson({ fullName: "Priya", roles: ["prospective_lp"] });
    let d = await getDashboard();
    expect(d.attention.map((p) => p.id)).toEqual([id]);
    expect(d.attention[0].health).toBe("never");

    await logInteraction({ personId: id, type: "meeting", summary: "Intro coffee" });
    d = await getDashboard();
    expect(d.attention).toEqual([]);
    expect((await getPerson(id))?.health).toBe("fresh");
  });

  it("AC-3: a meeting 32 days ago makes a 21-day LP cold, ordered above a due person", async () => {
    const cold = await createPerson({ fullName: "Cold", roles: ["prospective_lp"] });
    await logInteraction({ personId: cold.id, type: "meeting", summary: "old", occurredAt: daysAgo(32) });
    const due = await createPerson({ fullName: "Due", roles: ["prospective_lp"] });
    await logInteraction({ personId: due.id, type: "meeting", summary: "a while", occurredAt: daysAgo(25) });
    const d = await getDashboard();
    expect(d.attention.map((p) => [p.fullName, p.health])).toEqual([
      ["Cold", "cold"],
      ["Due", "due"],
    ]);
  });

  it("AC-4: a follow-up due in 3 days shows; completing it removes it", async () => {
    const { id } = await createPerson({ fullName: "Sam", roles: ["founder"] });
    await logInteraction({
      personId: id,
      type: "call",
      summary: "Pitch",
      followUps: [{ description: "Send deck", dueAt: daysFromNow(3) }, { description: "Far away", dueAt: daysFromNow(30) }],
    });
    let d = await getDashboard();
    expect(d.followUps.map((f) => f.description)).toEqual(["Send deck"]);
    expect(d.followUps[0].overdue).toBe(false);
    await setFollowUpDone(d.followUps[0].id, true);
    d = await getDashboard();
    expect(d.followUps).toEqual([]);
  });

  it("overdue follow-ups and undated ones are listed; deleting the interaction cascades", async () => {
    const { id } = await createPerson({ fullName: "Sam" });
    const { id: iid } = await logInteraction({ personId: id, type: "call", summary: "x", followUps: [{ description: "late", dueAt: daysAgo(2) }] });
    await addFollowUp(iid, { description: "undated" });
    let d = await getDashboard();
    expect(d.followUps.map((f) => [f.description, f.overdue])).toEqual([["late", true], ["undated", false]]);
    await deleteInteraction(iid);
    d = await getDashboard();
    expect(d.followUps).toEqual([]);
  });

  it("reminders: due within 7 days show, snooze hides, complete removes", async () => {
    const { id } = await createPerson({ fullName: "Ria" });
    const r1 = await createReminder({ personId: id, dueAt: daysFromNow(2), reason: "birthday" });
    await createReminder({ personId: id, dueAt: daysFromNow(20), reason: "later" });
    let d = await getDashboard();
    expect(d.reminders.map((r) => r.reason)).toEqual(["birthday"]);
    await snoozeReminder(r1.id, 7);
    d = await getDashboard();
    expect(d.reminders).toEqual([]);
    const r3 = await createReminder({ personId: id, dueAt: daysAgo(1), reason: "overdue" });
    d = await getDashboard();
    expect(d.reminders.map((r) => [r.reason, r.overdue])).toEqual([["overdue", true]]);
    await completeReminder(r3.id);
    expect((await getDashboard()).reminders).toEqual([]);
  });

  it("FR-13: role filter narrows attention and follow-ups", async () => {
    const lp = await createPerson({ fullName: "LP", roles: ["prospective_lp"] });
    const fr = await createPerson({ fullName: "Friend", roles: ["friend"] });
    await logInteraction({ personId: fr.id, type: "call", summary: "x", followUps: [{ description: "friend task", dueAt: daysFromNow(1) }] });
    await logInteraction({ personId: lp.id, type: "call", summary: "y", occurredAt: daysAgo(40), followUps: [{ description: "lp task", dueAt: daysFromNow(1) }] });
    const d = await getDashboard("prospective_lp");
    expect(d.attention.map((p) => p.id)).toEqual([lp.id]);
    expect(d.followUps.map((f) => f.description)).toEqual(["lp task"]);
  });

  it("settings overrides change default cadence for new people", async () => {
    await updateSettings({ timezone: "America/New_York", defaultCadences: { prospective_lp: 10 } as Record<"prospective_lp", number> });
    const { id } = await createPerson({ fullName: "Quick LP", roles: ["prospective_lp"] });
    expect((await getPerson(id))?.cadenceDays).toBe(10);
  });
});

import { describe, expect, it } from "vitest";
import { compareForDashboard, computeHealth, daysBetween, defaultCadenceForRoles } from "@/domain/health";

const now = new Date("2026-09-12T12:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe("computeHealth", () => {
  it("is no_cadence without a cadence", () => {
    expect(computeHealth({ cadenceDays: null, lastInteractionAt: ago(3), now })).toBe("no_cadence");
    expect(computeHealth({ cadenceDays: 0, lastInteractionAt: ago(3), now })).toBe("no_cadence");
  });
  it("is never with a cadence but no interactions", () => {
    expect(computeHealth({ cadenceDays: 21, lastInteractionAt: null, now })).toBe("never");
  });
  it("follows the 0.5 / 1 / 1.5 multipliers", () => {
    const c = 20;
    expect(computeHealth({ cadenceDays: c, lastInteractionAt: ago(0), now })).toBe("fresh");
    expect(computeHealth({ cadenceDays: c, lastInteractionAt: ago(10), now })).toBe("fresh");
    expect(computeHealth({ cadenceDays: c, lastInteractionAt: ago(11), now })).toBe("warm");
    expect(computeHealth({ cadenceDays: c, lastInteractionAt: ago(20), now })).toBe("warm");
    expect(computeHealth({ cadenceDays: c, lastInteractionAt: ago(21), now })).toBe("due");
    expect(computeHealth({ cadenceDays: c, lastInteractionAt: ago(30), now })).toBe("due");
    expect(computeHealth({ cadenceDays: c, lastInteractionAt: ago(31), now })).toBe("cold");
  });
  it("AC-3: a 21-day LP contacted 30 days ago is due, 32 days ago is cold", () => {
    expect(computeHealth({ cadenceDays: 21, lastInteractionAt: ago(30), now })).toBe("due");
    expect(computeHealth({ cadenceDays: 21, lastInteractionAt: ago(32), now })).toBe("cold");
  });
});

describe("defaultCadenceForRoles", () => {
  it("applies spec defaults", () => {
    expect(defaultCadenceForRoles(["prospective_lp"])).toBe(21);
    expect(defaultCadenceForRoles(["friend"])).toBe(45);
    expect(defaultCadenceForRoles(["family"])).toBe(30);
  });
  it("shortest default wins across roles", () => {
    expect(defaultCadenceForRoles(["co_investor", "prospective_lp", "friend"])).toBe(21);
  });
  it("returns null for roles without defaults", () => {
    expect(defaultCadenceForRoles(["other", "service_provider"])).toBeNull();
    expect(defaultCadenceForRoles([])).toBeNull();
  });
  it("respects user overrides", () => {
    expect(defaultCadenceForRoles(["prospective_lp"], { prospective_lp: 14 })).toBe(14);
    expect(defaultCadenceForRoles(["prospective_lp", "friend"], { friend: 7 })).toBe(7);
  });
});

describe("compareForDashboard", () => {
  it("orders cold, due, never then shortest cadence then name", () => {
    const rows = [
      { health: "never" as const, cadenceDays: 21, fullName: "Zed" },
      { health: "due" as const, cadenceDays: 45, fullName: "Amy" },
      { health: "cold" as const, cadenceDays: 60, fullName: "Bob" },
      { health: "cold" as const, cadenceDays: 21, fullName: "Cal" },
      { health: "cold" as const, cadenceDays: 21, fullName: "Abe" },
    ];
    expect(rows.sort(compareForDashboard).map((r) => r.fullName)).toEqual(["Abe", "Cal", "Bob", "Amy", "Zed"]);
  });
});

describe("daysBetween", () => {
  it("floors partial days", () => {
    expect(daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T23:00:00Z"))).toBe(1);
  });
});

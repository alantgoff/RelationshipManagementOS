import { describe, expect, it } from "vitest";
import { findDuplicates, mapRows, suggestMapping } from "@/domain/csv";

describe("suggestMapping", () => {
  it("maps common header aliases", () => {
    expect(suggestMapping(["Name", "E-mail", "Organization", "Role", "Tags", "City", "Ignore me"])).toEqual({
      Name: "fullName",
      "E-mail": "email",
      Organization: "company",
      Role: "roles",
      Tags: "tags",
      City: "location",
      "Ignore me": null,
    });
  });
  it("never maps two columns to the same target", () => {
    const m = suggestMapping(["name", "full name"]);
    expect(Object.values(m).filter((v) => v === "fullName")).toHaveLength(1);
  });
});

describe("mapRows", () => {
  const mapping = { Name: "fullName", Email: "email", Roles: "roles", Tags: "tags", Cadence: "cadenceDays" } as const;

  it("builds people and normalizes roles, emails, lists", () => {
    const { people, issues } = mapRows(
      [{ Name: "Ada", Email: "ADA@Example.com", Roles: "LP; founder", Tags: "climate|Boston", Cadence: "14" }],
      mapping,
    );
    expect(issues).toEqual([]);
    expect(people).toEqual([
      { fullName: "Ada", email: "ada@example.com", roles: ["prospective_lp", "founder"], tags: ["climate", "Boston"], cadenceDays: 14 },
    ]);
  });
  it("skips rows without a name and reports unknown roles and bad cadence", () => {
    const { people, issues } = mapRows(
      [
        { Name: "", Email: "x@y.z", Roles: "", Tags: "", Cadence: "" },
        { Name: "Bo", Email: "", Roles: "wizard", Tags: "", Cadence: "soon" },
      ],
      mapping,
    );
    expect(people.map((p) => p.fullName)).toEqual(["Bo"]);
    expect(issues.map((i) => i.row)).toEqual([1, 2, 2]);
    expect(issues.some((i) => i.message.includes("wizard"))).toBe(true);
  });
});

describe("findDuplicates", () => {
  it("matches on exact lower-cased email only", () => {
    const incoming = mapRows(
      [
        { Name: "A", Email: "a@x.com" },
        { Name: "B", Email: "b@x.com" },
        { Name: "C", Email: "" },
      ],
      { Name: "fullName", Email: "email" },
    ).people;
    const dupes = findDuplicates(incoming, [{ id: "1", email: "A@X.COM" }, { id: "2", email: null }]);
    expect([...dupes.keys()]).toEqual([0]);
    expect(dupes.get(0)?.id).toBe("1");
  });
});

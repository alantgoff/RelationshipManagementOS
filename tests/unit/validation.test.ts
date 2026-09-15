import { describe, expect, it } from "vitest";
import { interactionInput, personInput } from "@/server/validation";

describe("personInput", () => {
  it("normalizes blanks to null and lower-cases email", () => {
    const p = personInput.parse({ fullName: "  Ada ", email: " ADA@x.com ", company: "", roles: ["friend"] });
    expect(p.fullName).toBe("Ada");
    expect(p.email).toBe("ada@x.com");
    expect(p.company).toBeNull();
    expect(p.tags).toEqual([]);
  });
  it("rejects invalid email and empty name", () => {
    expect(() => personInput.parse({ fullName: "A", email: "nope" })).toThrow();
    expect(() => personInput.parse({ fullName: "   " })).toThrow();
  });
  it("accepts an empty email as null", () => {
    expect(personInput.parse({ fullName: "A", email: "" }).email).toBeNull();
  });
});

describe("interactionInput", () => {
  it("coerces dates and defaults follow-ups", () => {
    const i = interactionInput.parse({
      personId: "018f3c1e-1b2d-7c3a-9d4e-5f6a7b8c9d0e",
      type: "call",
      summary: "Caught up",
      occurredAt: "2026-09-01T10:00:00Z",
    });
    expect(i.occurredAt).toBeInstanceOf(Date);
    expect(i.followUps).toEqual([]);
  });
});

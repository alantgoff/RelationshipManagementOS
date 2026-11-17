import { describe, expect, it } from "vitest";
import { addDays, inWindow, isValidTimeZone, localDate, localMinutes, parseHM, safeTimeZone, weekdayName, zonedTimeToUtc } from "@/lib/time";

describe("time helpers", () => {
  const t = new Date("2026-09-25T02:30:00Z"); // Thursday 22:30 in New York, Friday in UTC

  it("computes local dates, weekdays and minutes", () => {
    expect(localDate(t, "America/New_York")).toBe("2026-09-24");
    expect(localDate(t, "UTC")).toBe("2026-09-25");
    expect(weekdayName(t, "America/New_York")).toBe("Thursday");
    expect(localMinutes(t, "America/New_York")).toBe(22 * 60 + 30);
  });

  it("converts local wall time to UTC across DST", () => {
    expect(zonedTimeToUtc("2026-09-25", 12, 0, "America/New_York").toISOString()).toBe("2026-09-25T16:00:00.000Z"); // EDT
    expect(zonedTimeToUtc("2026-12-01", 12, 0, "America/New_York").toISOString()).toBe("2026-12-01T17:00:00.000Z"); // EST
    expect(zonedTimeToUtc("2026-03-08", 9, 0, "America/New_York").toISOString()).toBe("2026-03-08T13:00:00.000Z"); // DST start day
    expect(zonedTimeToUtc("2026-09-25", 9, 30, "Asia/Kolkata").toISOString()).toBe("2026-09-25T04:00:00.000Z");
    expect(() => zonedTimeToUtc("Sep 25", 9, 0, "UTC")).toThrow();
  });

  it("parses HH:MM and handles windows that wrap midnight", () => {
    expect(parseHM("07:30")).toBe(450);
    expect(parseHM("7:05")).toBe(425);
    expect(parseHM("24:00")).toBeNull();
    expect(parseHM("noon")).toBeNull();
    expect(inWindow(22 * 60, 21 * 60, 7 * 60)).toBe(true);
    expect(inWindow(6 * 60, 21 * 60, 7 * 60)).toBe(true);
    expect(inWindow(8 * 60, 21 * 60, 7 * 60)).toBe(false);
    expect(inWindow(10 * 60, 9 * 60, 17 * 60)).toBe(true);
    expect(inWindow(10 * 60, 9 * 60, 9 * 60)).toBe(false);
  });

  it("validates time zones and adds days across month ends", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
    expect(safeTimeZone(null)).toBe("UTC");
    expect(addDays("2026-09-24", 14)).toBe("2026-10-08");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

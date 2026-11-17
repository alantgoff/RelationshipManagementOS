import { describe, expect, it } from "vitest";
import { briefScheduleCheck, renderBriefFallback, type BriefData } from "@/agent/brief";
import { estimateTokens, findMentionedPeople } from "@/agent/context";
import { cleanReply, splitMessage } from "@/agent/runtime";
import type { AgentPrefs } from "@/agent/store";
import type { PersonRow } from "@/server/queries/people";

const prefs: AgentPrefs = {
  timezone: "America/New_York",
  proactiveEnabled: true,
  pausedUntil: null,
  briefTime: "07:30",
  quietStart: "21:00",
  quietEnd: "07:00",
  dailyUnpromptedLimit: 3,
};
// Thursday 2026-09-24, 07:35 in New York.
const thu0735 = new Date("2026-09-24T11:35:00Z");

describe("briefScheduleCheck", () => {
  it("sends on a weekday inside the window", () => {
    expect(briefScheduleCheck(prefs, thu0735, 0)).toBeNull();
  });
  it("respects time, weekends, stop, pause, quiet hours and the daily limit", () => {
    expect(briefScheduleCheck(prefs, new Date("2026-09-24T11:00:00Z"), 0)).toBe("not_time_yet");
    expect(briefScheduleCheck(prefs, new Date("2026-09-24T14:30:00Z"), 0)).toBe("window_passed");
    expect(briefScheduleCheck(prefs, new Date("2026-09-26T11:35:00Z"), 0)).toBe("weekend");
    expect(briefScheduleCheck({ ...prefs, proactiveEnabled: false }, thu0735, 0)).toBe("stopped");
    expect(briefScheduleCheck({ ...prefs, pausedUntil: new Date("2026-09-24T13:00:00Z") }, thu0735, 0)).toBe("paused");
    expect(briefScheduleCheck({ ...prefs, pausedUntil: new Date("2026-09-24T10:00:00Z") }, thu0735, 0)).toBeNull();
    expect(briefScheduleCheck({ ...prefs, quietEnd: "08:00" }, thu0735, 0)).toBe("quiet_hours");
    expect(briefScheduleCheck(prefs, thu0735, 3)).toBe("daily_limit");
  });
});

describe("renderBriefFallback", () => {
  it("summarizes due items, people and drafts", () => {
    const d: BriefData = {
      today: "2026-09-24",
      weekday: "Thursday",
      reachOut: [{ name: "Priya Patel", id: "a1b2c3d4", health: "cold", lastContact: "2026-08-01", lastSummary: null, cadenceDays: 21, facts: [] }],
      dueToday: [{ text: "Send deck", person: "Priya Patel", overdue: true }],
      draftsWaiting: 1,
      needAttentionTotal: 1,
    };
    const text = renderBriefFallback(d);
    expect(text).toContain("Send deck (Priya Patel, overdue)");
    expect(text).toContain("Priya Patel (cold, last 2026-08-01)");
    expect(text).toContain("1 draft waiting");
  });
});

describe("cleanReply and splitMessage", () => {
  it("removes reasoning tags and markdown", () => {
    expect(cleanReply("<think>plan</think>**Logged** coffee.\n\n\n## Next\nok")).toBe("Logged coffee.\n\nNext\nok");
  });
  it("splits long text at natural breaks into at most three parts", () => {
    const para = "Sentence one is here. ".repeat(40);
    const parts = splitMessage(`${para}\n\n${para}\n\n${para}\n\n${para}`, 1200, 3);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1200);
    expect(splitMessage("short")).toEqual(["short"]);
  });
});

function person(id: string, fullName: string, preferredName: string | null = null): PersonRow {
  return { id, fullName, preferredName } as PersonRow;
}

describe("findMentionedPeople", () => {
  const rows = [person("1", "Priya Patel"), person("2", "Sarah Chen"), person("3", "Sarah Kim"), person("4", "Jonathan Ive", "Jony"), person("5", "Al Smith")];

  it("matches full, first and preferred names on word boundaries, newest text first", () => {
    const found = findMentionedPeople(rows, ["coffee with Jony today", "Priya said hi"]);
    expect(found.map((p) => p.id)).toEqual(["4", "1"]);
  });
  it("pulls in everyone who shares a first name, and ignores substrings", () => {
    expect(findMentionedPeople(rows, ["call Sarah"]).map((p) => p.id)).toEqual(["2", "3"]);
    expect(findMentionedPeople(rows, ["the algorithm Alex wrote"]).map((p) => p.id)).toEqual([]);
  });
  it("caps the number of people", () => {
    expect(findMentionedPeople(rows, ["Priya Sarah Jony Al"], 2)).toHaveLength(2);
  });
});

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

import { describe, expect, it } from "vitest";
import { parseCommand } from "@/agent/commands";

const idle = { draftAwaitingReply: false };
const draft = { draftAwaitingReply: true };

describe("parseCommand", () => {
  it("recognizes fixed commands regardless of case and punctuation", () => {
    expect(parseCommand("Help", idle)).toEqual({ kind: "help" });
    expect(parseCommand("STOP", idle)).toEqual({ kind: "stop" });
    expect(parseCommand("start", idle)).toEqual({ kind: "start" });
    expect(parseCommand("brief", idle)).toEqual({ kind: "brief" });
    expect(parseCommand("undo!", idle)).toEqual({ kind: "undo" });
    expect(parseCommand("why?", idle)).toEqual({ kind: "why" });
  });

  it("parses pause durations with a 2h default and a 14-day cap", () => {
    expect(parseCommand("pause", idle)).toEqual({ kind: "pause", minutes: 120 });
    expect(parseCommand("pause 2h", idle)).toEqual({ kind: "pause", minutes: 120 });
    expect(parseCommand("pause 30 min", idle)).toEqual({ kind: "pause", minutes: 30 });
    expect(parseCommand("pause for 3 days", idle)).toEqual({ kind: "pause", minutes: 3 * 24 * 60 });
    expect(parseCommand("snooze 1 week", idle)).toEqual({ kind: "pause", minutes: 7 * 24 * 60 });
    expect(parseCommand("pause 99 weeks", idle)).toEqual({ kind: "pause", minutes: 14 * 24 * 60 });
    expect(parseCommand("pause 3 fortnights", idle)).toBeNull();
  });

  it("does not treat normal sentences as commands", () => {
    expect(parseCommand("stop by Raj's office tomorrow", idle)).toBeNull();
    expect(parseCommand("why did Priya pass?", idle)).toBeNull();
    expect(parseCommand("help me draft a note to Leo", idle)).toBeNull();
    expect(parseCommand("   ", idle)).toBeNull();
  });

  it("only treats approval words and emoji as approval when a draft is the open question", () => {
    expect(parseCommand("yes", idle)).toBeNull();
    expect(parseCommand("👍", idle)).toBeNull();
    expect(parseCommand("yes", draft)).toEqual({ kind: "approve" });
    expect(parseCommand("Sent", draft)).toEqual({ kind: "approve" });
    expect(parseCommand("👍🏽", draft)).toEqual({ kind: "approve" });
    expect(parseCommand("skip", draft)).toEqual({ kind: "reject" });
    expect(parseCommand("👎", draft)).toEqual({ kind: "reject" });
  });

  it("maps quoted tapbacks to approve or reject", () => {
    expect(parseCommand('Liked “Hey Leo, want to co-invest in Acme?”', draft)).toEqual({ kind: "approve" });
    expect(parseCommand('Loved "Hey Leo"', draft)).toEqual({ kind: "approve" });
    expect(parseCommand('Disliked “Hey Leo”', draft)).toEqual({ kind: "reject" });
    expect(parseCommand('Liked “something else”', idle)).toBeNull();
  });
});

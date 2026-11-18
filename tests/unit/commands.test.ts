import { describe, expect, it } from "vitest";
import { draftQuotedBy, parseCommand, type CommandContext } from "@/agent/commands";

const leo = { id: "d-leo", body: "Subject: Acme\nHey Leo, want to co-invest in Acme's seed?" };
const sam = { id: "d-sam", body: "Sam, congrats on the launch! Coffee next week?" };

const idle: CommandContext = { drafts: [], shownDraft: null, lastOutboundAsked: false };
/** The agent's last message was the Leo draft. */
const justShown: CommandContext = { drafts: [leo], shownDraft: leo, lastOutboundAsked: false };
/** One draft waiting, but the conversation moved on since. */
const oneWaiting: CommandContext = { drafts: [leo], shownDraft: null, lastOutboundAsked: false };
/** Two drafts waiting, newest first, neither just shown. */
const twoWaiting: CommandContext = { drafts: [sam, leo], shownDraft: null, lastOutboundAsked: false };
/** No drafts; the agent's last message asked a question. */
const asked: CommandContext = { drafts: [], shownDraft: null, lastOutboundAsked: true };

describe("parseCommand", () => {
  it("recognizes fixed commands regardless of case and punctuation", () => {
    expect(parseCommand("Help", idle)).toEqual({ kind: "help" });
    expect(parseCommand("?", idle)).toEqual({ kind: "help" });
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
});

describe("drafts", () => {
  it("👍 and 'sent' right after a draft log exactly that draft", () => {
    expect(parseCommand("👍", justShown)).toEqual({ kind: "approve", draftId: "d-leo" });
    expect(parseCommand("👍🏽", justShown)).toEqual({ kind: "approve", draftId: "d-leo" });
    expect(parseCommand("Sent", justShown)).toEqual({ kind: "approve", draftId: "d-leo" });
    expect(parseCommand("sent it!", justShown)).toEqual({ kind: "approve", draftId: "d-leo" });
    // The draft shown is the one resolved, even when a newer one is also waiting.
    expect(parseCommand("👍", { ...twoWaiting, shownDraft: leo })).toEqual({ kind: "approve", draftId: "d-leo" });
  });

  it("sends a bare 👍 or 'sent' to the model once the conversation moved on, so it can ask which", () => {
    for (const ctx of [oneWaiting, twoWaiting]) {
      expect(parseCommand("👍", ctx)).toBeNull();
      expect(parseCommand("sent", ctx)).toBeNull();
      expect(parseCommand("skip", ctx)).toBeNull();
      expect(parseCommand("👎", ctx)).toBeNull();
    }
  });

  it("leaves wording feedback ('yes', 'looks good', 'no') to the model", () => {
    for (const ctx of [justShown, oneWaiting]) {
      expect(parseCommand("yes", ctx)).toBeNull();
      expect(parseCommand("looks good", ctx)).toBeNull();
      expect(parseCommand("no", ctx)).toBeNull();
      expect(parseCommand("done", ctx)).toBeNull();
    }
  });

  it("skip/👎 discard the draft just shown; with no draft, words go to the model and emoji are reactions", () => {
    expect(parseCommand("skip", justShown)).toEqual({ kind: "reject", draftId: "d-leo" });
    expect(parseCommand("👎", justShown)).toEqual({ kind: "reject", draftId: "d-leo" });
    expect(parseCommand("sent", idle)).toBeNull();
    expect(parseCommand("skip", idle)).toBeNull();
    expect(parseCommand("👍", idle)).toEqual({ kind: "reaction" });
    expect(parseCommand("👎", idle)).toEqual({ kind: "reaction" });
  });

  it("an emoji answering the agent's question goes to the model", () => {
    expect(parseCommand("👍", asked)).toBeNull();
    expect(parseCommand("🙏", asked)).toBeNull();
    expect(parseCommand("👍", { ...justShown, lastOutboundAsked: true })).toEqual({ kind: "approve", draftId: "d-leo" });
  });

  it("a tapback resolves the draft it quotes, wherever it is in the list", () => {
    expect(parseCommand("Liked “Hey Leo, want to co-invest in Acme's seed?”", twoWaiting)).toEqual({ kind: "approve", draftId: "d-leo" });
    expect(parseCommand("Liked “Subject: Acme Hey Leo, want to co-invest…”", twoWaiting)).toEqual({ kind: "approve", draftId: "d-leo" });
    expect(parseCommand('Loved "Sam, congrats on the launch!…"', twoWaiting)).toEqual({ kind: "approve", draftId: "d-sam" });
    expect(parseCommand("Disliked “Sam, congrats on the launch! Coffee next week?”", twoWaiting)).toEqual({ kind: "reject", draftId: "d-sam" });
    expect(parseCommand("Reacted 👍 to “Hey Leo, want to co-invest”", twoWaiting)).toEqual({ kind: "approve", draftId: "d-leo" });
  });

  it("any other tapback, an un-tap, or one on a non-draft message is a reaction that needs no reply", () => {
    expect(parseCommand("Liked “Logged coffee with Priya; deck Friday.”", twoWaiting)).toEqual({ kind: "reaction" });
    expect(parseCommand("Laughed at “Hey Leo, want to co-invest”", twoWaiting)).toEqual({ kind: "reaction" });
    expect(parseCommand("Emphasized “anything”", idle)).toEqual({ kind: "reaction" });
    expect(parseCommand("Removed a like from “Logged coffee with Priya; deck reminder Friday.”", twoWaiting)).toEqual({ kind: "reaction" });
    expect(parseCommand("Removed an exclamation from “Hey Leo”", idle)).toEqual({ kind: "reaction" });
    expect(parseCommand("❤️", idle)).toEqual({ kind: "reaction" });
    expect(parseCommand("🙏", oneWaiting)).toEqual({ kind: "reaction" });
  });
});

describe("draftQuotedBy", () => {
  it("matches truncated quotes and ignores very short ones", () => {
    expect(draftQuotedBy("Hey Leo, want to…", [sam, leo])?.id).toBe("d-leo");
    expect(draftQuotedBy("Hey", [sam, leo])).toBeNull();
    expect(draftQuotedBy("Something unrelated entirely", [sam, leo])).toBeNull();
  });
  it("needs the quote to open the draft or one of its lines, not just appear in it", () => {
    expect(draftQuotedBy("Coffee next week?", [sam, leo])).toBeNull();
    expect(draftQuotedBy("congrats on the launch", [sam, leo])).toBeNull();
  });
});

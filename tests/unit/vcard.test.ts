import { describe, expect, it } from "vitest";
import { describeContact, parseVCards } from "@/channels/vcard";

const CARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Becker;Tom;;;",
  "FN:Tom Becker",
  "ORG:Becker Family Office;",
  "TITLE:Managing Partner",
  "item1.EMAIL;type=INTERNET;type=pref:Tom@BeckerFO.com",
  "TEL;type=CELL;type=VOICE;type=pref:+1 (212) 555-0199",
  "NOTE:Met at Climate Week\\, wants Fund I deck",
  "END:VCARD",
].join("\r\n");

describe("parseVCards", () => {
  it("parses common fields, parameters and escapes", () => {
    const [c] = parseVCards(CARD);
    expect(c).toEqual({
      fullName: "Tom Becker",
      emails: ["tom@beckerfo.com"],
      phones: ["+1 (212) 555-0199"],
      company: "Becker Family Office",
      title: "Managing Partner",
      note: "Met at Climate Week, wants Fund I deck",
    });
    expect(describeContact(c)).toBe(
      "Tom Becker; Managing Partner at Becker Family Office; email tom@beckerfo.com; phone +1 (212) 555-0199; note: Met at Climate Week, wants Fund I deck",
    );
  });

  it("falls back to N when FN is missing, unfolds lines, and reads several cards", () => {
    const text = "BEGIN:VCARD\nN:Lee;Dana;;;\nEMAIL:dana@\n example.com\nEND:VCARD\nBEGIN:VCARD\nFN:Second Person\nEND:VCARD";
    const cards = parseVCards(text);
    expect(cards.map((c) => c.fullName)).toEqual(["Dana Lee", "Second Person"]);
    expect(cards[0].emails).toEqual(["dana@example.com"]);
  });

  it("ignores empty or malformed input", () => {
    expect(parseVCards("")).toEqual([]);
    expect(parseVCards("BEGIN:VCARD\nEND:VCARD")).toEqual([]);
    expect(parseVCards("not a card")).toEqual([]);
  });
});

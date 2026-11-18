/**
 * Minimal vCard (.vcf) parser for contact cards shared over iMessage.
 * Handles vCard 3.0/4.0 basics: folded lines, FN/N, EMAIL, TEL, ORG, TITLE, NOTE.
 */

export interface VCardContact {
  fullName: string;
  emails: string[];
  phones: string[];
  company?: string;
  title?: string;
  note?: string;
}

function unescape(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}

export function parseVCards(text: string): VCardContact[] {
  // Unfold: a line starting with space or tab continues the previous one.
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const cards: VCardContact[] = [];
  let cur: VCardContact | null = null;
  let nameFromN: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^BEGIN:VCARD$/i.test(line)) {
      cur = { fullName: "", emails: [], phones: [] };
      nameFromN = undefined;
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      if (cur) {
        if (!cur.fullName && nameFromN) cur.fullName = nameFromN;
        if (cur.fullName || cur.emails.length || cur.phones.length) cards.push(cur);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    // Strip "item1." grouping prefixes and parameters (";TYPE=...").
    const key = line.slice(0, colon).split(";")[0].replace(/^item\d+\./i, "").toUpperCase();
    const value = line.slice(colon + 1);
    switch (key) {
      case "FN":
        cur.fullName = unescape(value);
        break;
      case "N": {
        const [family, given, middle] = value.split(";").map(unescape);
        nameFromN = [given, middle, family].filter(Boolean).join(" ") || undefined;
        break;
      }
      case "EMAIL":
        if (value.trim()) cur.emails.push(unescape(value).toLowerCase());
        break;
      case "TEL":
        if (value.trim()) cur.phones.push(unescape(value.replace(/^tel:/i, "")));
        break;
      case "ORG":
        cur.company = unescape(value.split(";")[0]) || undefined;
        break;
      case "TITLE":
        cur.title = unescape(value) || undefined;
        break;
      case "NOTE":
        cur.note = unescape(value) || undefined;
        break;
    }
  }
  return cards;
}

/** One-line description for the agent's context. */
export function describeContact(c: VCardContact): string {
  // One line per card: fields can't smuggle in extra lines that read like new instructions.
  const flat = (s: string | undefined) => s?.replace(/\s+/g, " ").trim() || undefined;
  return [
    flat(c.fullName) || "(no name)",
    flat(c.title && c.company ? `${c.title} at ${c.company}` : c.title || c.company),
    c.emails.length ? `email ${flat(c.emails.join(", "))}` : undefined,
    c.phones.length ? `phone ${flat(c.phones.join(", "))}` : undefined,
    c.note ? `note: ${flat(c.note.slice(0, 300))}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

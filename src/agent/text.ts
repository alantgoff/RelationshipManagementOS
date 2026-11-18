/**
 * Text helpers shared by replies, the brief and the thread summary.
 */

/**
 * Remove model reasoning. Keeps only what follows the last `</think>`, then
 * drops an unterminated `<think>` tail (a reply cut off mid-reasoning), so
 * neither a lone closing tag nor a truncated block reaches the owner.
 */
export function stripReasoning(text: string): string {
  let t = text;
  const close = t.toLowerCase().lastIndexOf("</think>");
  if (close >= 0) t = t.slice(close + "</think>".length);
  const open = t.search(/<think>/i);
  if (open >= 0) t = t.slice(0, open);
  return t.trim();
}

/** Strip reasoning and markdown that doesn't render in iMessage. */
export function cleanReply(text: string): string {
  return stripReasoning(text)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split long text into at most `maxParts` messages at paragraph or sentence boundaries. */
export function splitMessage(text: string, maxChars = 1200, maxParts = 3): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars && parts.length < maxParts - 1) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". ") + 1);
    const at = cut > maxChars / 3 ? cut : maxChars;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  parts.push(rest.length > maxChars ? `${rest.slice(0, maxChars - 1)}…` : rest);
  return parts.filter(Boolean);
}

/** Escape text placed inside an XML-ish delimiter so it can't close or forge tags. */
export function escapeTagText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

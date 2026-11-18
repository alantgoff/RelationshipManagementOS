/**
 * Commands handled by code, never by the model (spec 0002 §2), so they work
 * even when the model is down and can't be talked out of by a prompt.
 *
 * Drafts: code resolves a draft only on an unambiguous signal about a draft
 * the owner has seen. 👍 or "sent" right after a draft means "I sent it"
 * (logged as an interaction); "skip"/👎 means drop it. A tapback resolves the
 * draft it quotes. Anything less certain (a 👍 that may answer a question, a
 * "sent" after the conversation moved on, "yes", "looks good") goes to the
 * model, which sees the drafts waiting and can ask or call resolve_draft.
 * Other tapbacks and emoji are reactions and get no reply.
 */

export type Command =
  | { kind: "help" }
  | { kind: "stop" }
  | { kind: "start" }
  | { kind: "pause"; minutes: number }
  | { kind: "brief" }
  | { kind: "undo" }
  | { kind: "why" }
  | { kind: "approve"; draftId: string }
  | { kind: "reject"; draftId: string }
  /** A tapback or emoji that needs no reply. */
  | { kind: "reaction" };

export interface DraftRef {
  id: string;
  body: string;
}

export interface CommandContext {
  /** Pending drafts the owner had already been sent when they wrote this message, newest first. */
  drafts: DraftRef[];
  /** The draft in the agent's latest delivered message, if that message was a draft still pending. */
  shownDraft: DraftRef | null;
  /** True when the agent's latest delivered message asked the owner something. */
  lastOutboundAsked: boolean;
}

const MAX_PAUSE_MINUTES = 14 * 24 * 60;

const QUOTE = `["“”'‘’]`;
/** iMessage tapbacks relayed as text: Liked “…”, or on newer iOS: Reacted 👍 to “…”. */
const TAPBACK = new RegExp(`^(liked|loved|disliked|emphasized|laughed at|questioned)\\s+${QUOTE}([\\s\\S]*?)${QUOTE}?$`, "iu");
const REACTED = new RegExp(`^reacted\\s+(\\S+)\\s+to\\s+${QUOTE}([\\s\\S]*?)${QUOTE}?$`, "iu");

const SKIN = "[\\u{1F3FB}-\\u{1F3FF}]?";
const THUMBS_UP = new RegExp(`^(?:👍${SKIN}|✅)+$`, "u");
const THUMBS_DOWN = new RegExp(`^(?:👎${SKIN}|❌)+$`, "u");
/** A lone emoji or short emoji run: a reaction, not a request. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍)+$/u;

const SENT_WORDS = new Set(["sent", "sent it", "i sent it", "just sent it", "done, sent", "sent!"]);
const REJECT_WORDS = new Set(["skip", "skip it", "discard", "discard it", "don't send", "dont send", "don't send it", "cancel draft", "drop it"]);

function parseDuration(amount: string | undefined, unit: string | undefined): number | null {
  const n = amount ? Number(amount) : 2;
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (unit ?? "h").toLowerCase();
  let minutes: number;
  if (/^m(in(ute)?s?)?$/.test(u)) minutes = n;
  else if (/^h(ou)?r?s?$/.test(u)) minutes = n * 60;
  else if (/^d(ays?)?$/.test(u)) minutes = n * 24 * 60;
  else if (/^w(ee)?k?s?$/.test(u)) minutes = n * 7 * 24 * 60;
  else return null;
  return Math.min(Math.round(minutes), MAX_PAUSE_MINUTES);
}

const normQuote = (s: string) =>
  s
    .replace(/[“”"'‘’]/g, "")
    .replace(/(…|\.\.\.)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * The pending draft a tapback quotes, if any. iMessage quotes the start of the
 * message, sometimes truncated, so the quote must open the draft or one of its
 * lines (a draft may start with a "Subject:" line).
 */
export function draftQuotedBy(quote: string, drafts: DraftRef[]): DraftRef | null {
  const q = normQuote(quote);
  if (q.length < 6) return null;
  return (
    drafts.find((d) => {
      const lines = d.body.split("\n");
      return lines.some((_, i) => normQuote(lines.slice(i).join(" ")).startsWith(q));
    }) ?? null
  );
}

/** iMessage relays an un-tap as text, e.g. Removed a like from “…”. */
const REMOVED_TAPBACK = new RegExp(`^removed\\s+(?:a|an)\\s+\\S+(?:\\s+\\S+)?\\s+from\\s+${QUOTE}`, "iu");

export function parseCommand(raw: string, ctx: CommandContext): Command | null {
  const text = raw.trim();
  if (!text) return null;
  const norm = text.toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();

  if (norm === "help" || norm === "commands" || text === "?") return { kind: "help" };
  if (norm === "stop" || norm === "stop all" || norm === "unsubscribe") return { kind: "stop" };
  if (norm === "start" || norm === "resume" || norm === "unpause") return { kind: "start" };
  if (norm === "brief" || norm === "morning brief") return { kind: "brief" };
  if (norm === "undo") return { kind: "undo" };
  if (norm === "why") return { kind: "why" };

  const pause = /^(?:pause|snooze|quiet)(?:\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*([a-z]+)?)?$/.exec(norm);
  if (pause) {
    const minutes = parseDuration(pause[1], pause[2]);
    if (minutes) return { kind: "pause", minutes };
  }

  // Tapbacks quote the message they react to: act only on a quoted draft.
  const tap = TAPBACK.exec(text);
  const reacted = tap ? null : REACTED.exec(text);
  if (tap || reacted) {
    const verb = tap ? tap[1].toLowerCase() : reacted![1];
    const quote = tap ? tap[2] : reacted![2];
    const positive = verb === "liked" || verb === "loved" || /^(👍|❤️|❤|✅)/u.test(verb);
    const negative = verb === "disliked" || /^👎/u.test(verb);
    const draft = positive || negative ? draftQuotedBy(quote, ctx.drafts) : null;
    if (draft && positive) return { kind: "approve", draftId: draft.id };
    if (draft && negative) return { kind: "reject", draftId: draft.id };
    return { kind: "reaction" };
  }
  if (REMOVED_TAPBACK.test(text)) return { kind: "reaction" };

  const shown = ctx.shownDraft;
  // A bare emoji is a reaction unless it might be an answer: to a question, or about a waiting draft.
  const emojiAnswer = ctx.lastOutboundAsked || ctx.drafts.length > 0 ? null : ({ kind: "reaction" } as const);
  if (THUMBS_UP.test(text)) return shown ? { kind: "approve", draftId: shown.id } : emojiAnswer;
  if (THUMBS_DOWN.test(text)) return shown ? { kind: "reject", draftId: shown.id } : emojiAnswer;
  if (SENT_WORDS.has(norm)) return shown ? { kind: "approve", draftId: shown.id } : null;
  if (REJECT_WORDS.has(norm)) return shown ? { kind: "reject", draftId: shown.id } : null;
  if (EMOJI_ONLY.test(text)) return ctx.lastOutboundAsked ? null : { kind: "reaction" };
  return null;
}

export const HELP_TEXT = [
  "Text me what happened (\"coffee with Priya, send her the deck Friday\") or ask (\"who's going cold?\").",
  "Commands: brief · undo · why · pause 2h · stop · start · help",
  "Drafts never send themselves: once you've sent one, reply 👍 (or tap 👍 on it) and I'll log it, or \"skip\" to drop it.",
].join("\n");

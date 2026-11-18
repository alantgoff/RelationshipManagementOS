/**
 * Commands handled by code, never by the model (spec 0002 §2), so they work
 * even when the model is down and can't be talked out of by a prompt.
 *
 * Drafts: only unambiguous signals resolve a draft here: 👍 or "sent" means
 * "I sent it" (logged as an interaction), "skip"/"discard"/👎 means drop it.
 * "yes", "looks good" and "no" are about the wording, so they go to the model,
 * which can revise the draft or call resolve_draft. A tapback resolves the
 * draft it quotes; any other tapback is just a reaction and gets no reply.
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
  /** Several drafts are pending and the signal doesn't say which. */
  | { kind: "which_draft"; action: "approve" | "reject" }
  /** A tapback or emoji that needs no reply. */
  | { kind: "reaction" };

export interface DraftRef {
  id: string;
  body: string;
}

export interface CommandContext {
  /** Pending drafts, newest first. */
  drafts: DraftRef[];
  /** True when the agent's latest message before this one was a draft. */
  lastOutboundWasDraft: boolean;
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

/** The pending draft a tapback quotes, if any. Quotes may be truncated, so match by prefix or containment. */
export function draftQuotedBy(quote: string, drafts: DraftRef[]): DraftRef | null {
  const q = normQuote(quote);
  if (q.length < 6) return null;
  return drafts.find((d) => normQuote(d.body).includes(q)) ?? null;
}

/** Which draft a bare "sent"/👍/"skip" refers to: the one just shown, or the only one waiting. */
function targetDraft(ctx: CommandContext): DraftRef | "ambiguous" | null {
  if (ctx.drafts.length === 0) return null;
  if (ctx.lastOutboundWasDraft || ctx.drafts.length === 1) return ctx.drafts[0];
  return "ambiguous";
}

function resolve(action: "approve" | "reject", ctx: CommandContext, fallback: Command | null): Command | null {
  const target = targetDraft(ctx);
  if (!target) return fallback;
  if (target === "ambiguous") return { kind: "which_draft", action };
  return action === "approve" ? { kind: "approve", draftId: target.id } : { kind: "reject", draftId: target.id };
}

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

  if (THUMBS_UP.test(text)) return resolve("approve", ctx, { kind: "reaction" });
  if (THUMBS_DOWN.test(text)) return resolve("reject", ctx, { kind: "reaction" });
  if (SENT_WORDS.has(norm)) return resolve("approve", ctx, null);
  if (REJECT_WORDS.has(norm)) return resolve("reject", ctx, null);
  if (EMOJI_ONLY.test(text)) return { kind: "reaction" };
  return null;
}

export const HELP_TEXT = [
  "Text me what happened (\"coffee with Priya, send her the deck Friday\") or ask (\"who's going cold?\").",
  "Commands: brief · undo · why · pause 2h · stop · start · help",
  "Drafts never send themselves: once you've sent one, reply 👍 (or tap 👍 on it) and I'll log it, or \"skip\" to drop it.",
].join("\n");

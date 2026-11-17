/**
 * Commands handled by code, never by the model (spec 0002 §2), so they work
 * even when the model is down and can't be talked out of by a prompt.
 */

export type Command =
  | { kind: "help" }
  | { kind: "stop" }
  | { kind: "start" }
  | { kind: "pause"; minutes: number }
  | { kind: "brief" }
  | { kind: "undo" }
  | { kind: "why" }
  | { kind: "approve" }
  | { kind: "reject" };

export interface CommandContext {
  /** True when a draft is awaiting approval and it was the last thing the agent sent. */
  draftAwaitingReply: boolean;
}

const MAX_PAUSE_MINUTES = 14 * 24 * 60;

/** iMessage tapbacks arrive over SMS-style relays as text like: Liked "…" or Loved “…”. */
const POSITIVE_TAPBACK = /^(liked|loved|emphasized|laughed at)\s+["“”']/i;
const NEGATIVE_TAPBACK = /^(disliked)\s+["“”']/i;
const POSITIVE_EMOJI = /^(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|❤️|❤|✅|💯)+$/u;
const NEGATIVE_EMOJI = /^(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿|❌)+$/u;

const APPROVE_WORDS = new Set(["send", "sent", "yes", "yep", "yup", "approve", "approved", "looks good", "lgtm", "ok send", "done", "sent it"]);
const REJECT_WORDS = new Set(["no", "nope", "skip", "cancel", "discard", "don't send", "dont send", "reject"]);

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

export function parseCommand(raw: string, ctx: CommandContext): Command | null {
  const text = raw.trim();
  if (!text) return null;
  const norm = text.toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();

  if (norm === "help" || norm === "commands" || norm === "?") return { kind: "help" };
  if (norm === "stop" || norm === "stop all" || norm === "unsubscribe") return { kind: "stop" };
  if (norm === "start" || norm === "resume" || norm === "unpause") return { kind: "start" };
  if (norm === "brief" || norm === "morning brief") return { kind: "brief" };
  if (norm === "undo") return { kind: "undo" };
  if (norm === "why" || norm === "why?") return { kind: "why" };

  const pause = /^(?:pause|snooze|quiet)(?:\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*([a-z]+)?)?$/.exec(norm);
  if (pause) {
    const minutes = parseDuration(pause[1], pause[2]);
    if (minutes) return { kind: "pause", minutes };
  }

  // Tapbacks quote the message they react to, so they are unambiguous.
  if (POSITIVE_TAPBACK.test(text)) return ctx.draftAwaitingReply ? { kind: "approve" } : null;
  if (NEGATIVE_TAPBACK.test(text)) return ctx.draftAwaitingReply ? { kind: "reject" } : null;

  // Bare words and emoji only count as approval when a draft is the open question.
  if (ctx.draftAwaitingReply) {
    if (POSITIVE_EMOJI.test(text) || APPROVE_WORDS.has(norm)) return { kind: "approve" };
    if (NEGATIVE_EMOJI.test(text) || REJECT_WORDS.has(norm)) return { kind: "reject" };
  }
  return null;
}

export const HELP_TEXT = [
  "Text me what happened (\"coffee with Priya, send her the deck Friday\") or ask (\"who's going cold?\").",
  "Commands: brief · undo · why · pause 2h · stop · start · help",
  "Drafts never send themselves: reply 👍 once you've sent one and I'll log it, or \"skip\".",
].join("\n");

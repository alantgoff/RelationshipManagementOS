# Spec 0002: Headless iMessage agent (v2, milestone M1)

Date: 2026-09-26
Status: Accepted
Depends on: spec 0001, ADR-0002, ADR-0003

## 1. Purpose

Make the relationship manager usable entirely by text. The owner texts an
iMessage line; an agent logs what happened, answers questions about anyone,
drafts messages for approval, and texts the owner first with a morning brief
and nudges. The web app stays the settings and review surface.

## 2. M1 scope ("Text it", weeks 1–3)

In scope:
- Bind the owner's phone to their account with a 6-digit code.
- Inbound text, voice notes (transcribed) and images; outbound short texts.
- Log interactions and follow-ups, answer "who's going cold?" and "what do I
  know about X?", set reminders, move LP stages, draft messages.
- A weekday 7:30 morning brief.
- Commands handled in code: `stop`, `pause 2h`, `undo`, `why`, `brief`, `help`.

Out of scope for M1: Calendar and Gmail sync (M2–M3), memory facts beyond
`remember` (M2), fine-tuned adapters (M4), sending anything to third parties.

## 3. Requirements

- **HA-1** Webhook requests are authenticated with the provider's signing
  secret (constant-time compare) and dropped otherwise.
- **HA-2** Only the bound owner number is served; all other senders are
  ignored without reply.
- **HA-3** Processing is idempotent on the provider message id.
- **HA-4** The webhook returns 200 within 1 second; agent work runs after the
  response.
- **HA-5** Every agent action runs inside `runAsOwner()` and reuses the
  owner-scoped server actions and queries from v1.
- **HA-6** The agent never contacts anyone but the owner. Messages to others are
  `pending_actions` that the owner approves; M1 only drafts them.
- **HA-7** Per-turn context stays under 20k tokens (see ADR-0003 layout).
- **HA-8** Unprompted messages: at most 3 a day, none in quiet hours
  (21:00–07:00 owner time), none while paused.
- **HA-9** The model provider can fail over from the fine-tuned primary to a
  base-model fallback without user-visible errors.

## 4. Tools (M1)

`find_people`, `get_person`, `create_person`, `update_person`,
`log_interaction`, `add_follow_up`, `complete_follow_up`, `set_reminder`,
`set_lp_stage`, `whats_due`, `remember`, `draft_message`.
Schemas: `src/agent/tool-specs.ts`.

## 5. Acceptance criteria

- **HAC-1** `npm run eval` against the live model passes ≥ 90% of first-call
  tool scenarios, with 100% JSON validity, before the webhook is switched on.
- **HAC-2** Texting "Had coffee with Priya, promised the deck Friday" logs a
  meeting and a follow-up due that Friday, and replies with a one-line
  confirmation.
- **HAC-3** "who's going cold?" lists the same people, in the same order, as the
  web dashboard.
- **HAC-4** A message from any number other than the owner's gets no reply and
  writes nothing.
- **HAC-5** Replaying the same webhook twice produces one interaction.
- **HAC-6** "Draft a note to Leo about Acme" produces a draft and sends nothing
  to Leo.
- **HAC-7** The morning brief arrives on a weekday at 7:30 owner time and is
  skipped while paused.

## 6. Open questions

1. Does Sendblue's free shared line allow agent-initiated messages after the
   owner verifies? Checked by `npm run check:sendblue` before Phase 1 work.
2. Is base Qwen3.8-27B reliable enough at first-call tool use? Checked by
   `npm run eval` against Tinker before Phase 2 work.

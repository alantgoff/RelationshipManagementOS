# ADR-0003: Open-weight agent model, memory, and channel

Date: 2026-09-26
Status: Accepted

## Context

The owner wants a headless iMessage agent (spec 0002) that improves its own
weights over time, costs little to run for one user, and keeps data under the
owner's control. There is no always-on Mac available.

## Decisions

### Model
- **Live model:** Qwen3.8-27B (Apache 2.0, 262K context). Qwen3.6-35B-A3B is
  the faster alternative if latency matters more.
- **Serving:** Tinker's OpenAI-compatible sampling with the active LoRA adapter
  as primary; base Qwen on OpenRouter or DeepInfra as fallback. All access goes
  through `src/agent/llm.ts`, so any OpenAI-compatible host can be swapped in.
- **Frontier model:** Claude Opus 5 is used offline only, as eval judge and
  teacher for distillation. Never on the request path.
- **Second-choice model:** if Qwen cannot meet the tool-use eval bar, use a
  larger open model (GLM-5.x or Kimi K2.6) through a per-token API, keeping the
  fine-tuned Qwen for drafting in the owner's voice.

### What goes in the weights versus the database
- Weights learn style, judgment, tool-use habits and preferences, from the
  owner's accepted and edited drafts (SFT, DPO, KTO on Tinker, LoRA rank 32).
- Facts about people always live in Postgres and are retrieved each turn.
  Fine-tuning learns new facts poorly and raises hallucination (Gekhman et al.
  2024; Ovadia et al. 2023), so facts are scrubbed from training targets.
- A new adapter is promoted only if it passes the eval gate: no drop in tool
  accuracy, JSON validity or memory QA, a pairwise style win, and sycophancy
  probes. The last three adapters are kept for rollback.

### Context layout per turn
Stable first, volatile last, so providers can reuse the cached prefix:
system prompt and sorted tool list → learned playbook → owner profile →
rolling thread summary → working set (people in play, due items, pending
drafts, calendar window) → the 12–24 messages after the summary's cursor,
with old tool results cleared (older ones are folded into the summary) →
the new message. Target under 20k tokens. Anything else is fetched by tools.

### Memory
Postgres with pgvector. Facts carry provenance (source message, email or event)
and validity windows; a newer fact supersedes an older one instead of deleting
it. Nightly jobs rebuild per-person dossiers and consolidate facts.
Retrieval is entity resolution, then full-text plus vector plus graph
expansion, then reranking by recency and relationship health.

### Channel
Sendblue's free shared line first, behind the `ChannelAdapter` interface in
`src/channels/types.ts`. Fallbacks, in order: Photon Pro, a self-hosted Mac
bridge (imessage-kit or imsg with a Cloudflare Tunnel), Telegram.

### Owner scoping for headless runs
`runAsOwner(userId, source, fn)` in `src/server/auth.ts` sets an
AsyncLocalStorage context that `requireUserId()` reads before Clerk. Webhooks
and cron jobs resolve the owner, then call existing actions unchanged.

### Encryption
`src/lib/crypto.ts` (AES-256-GCM) encrypts OAuth tokens and raw channel
message bodies. Searchable CRM text stays plaintext in the database, protected
by the host's at-rest encryption, because search runs in SQL.

## Consequences
- Per-token hosting keeps the run cost around $20–110 a month for one user.
- Tinker inference is a beta intended for low traffic; the fallback covers it.
- A 27B open model is less reliable at multi-step tool use than frontier
  models, so tool-use evals gate every model and adapter change.
- Hosted iMessage relies on providers Apple does not sanction; Telegram is the
  no-risk fallback.

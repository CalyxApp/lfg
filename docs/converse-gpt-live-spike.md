# Converse voice — GPT-Live-1 spike (client delegation)

**Status:** plan · **Repo:** lfg (develop in `lfg`, deploy to `lfg-fork`) · **Date:** 2026-10-09

> First round, deliberately high-level. The point is a **throwaway spike that de-risks the idea on
> a real phone** before any production refactor. Verify the API details flagged at the end against
> OpenAI's SDK before building — GPT-Live-1 is ~1 month old (released 2026-09-10).

## Why

Give Converse OpenAI's **GPT-Live-1** full-duplex voice (it listens and speaks at once) while
**keeping our own intelligence and tools**. This is a **performance / feel** play, not a cost one —
GPT-Live bills $0.05/min for the voice layer *plus* our own brain's model tokens on top, so it can
cost more than `gpt-realtime-2.1`. (Cost reduction is a separate lever — Gemini Live, or
`gpt-realtime-2.1-mini`.)

## The shape (OpenAI's documented recommendation — "client delegation")

GPT-Live-1 **never calls tools itself.** With `delegation: { type: "client" }` it is a pure voice
layer; our app supplies all the intelligence.

- **Browser (mobile)** holds mic + speaker over **WebRTC**, using a short-lived ephemeral key our
  server mints (same pattern as today's realtime path). It mints nothing itself.
- **Our server** mints the Live session (`model: "gpt-live-1"`, `delegation: { type: "client" }`,
  **no tools declared on Live**, minimal `instructions` like "be concise; narrate progress"), and
  holds the control/data channel.
- **On user speech**, GPT-Live emits `session.delegation.created` — an `id` only, **no transcript**.
  We reconstruct intent from `session.input_transcript.delta` + our own state.
- **Our existing function-calling brain runs server-side** (reuse the typed-chat tool loop in
  `src/chat-providers.ts` → `runVaultTool` in `src/vault-tools.ts`) with the **full tool suite**:
  `search`, `read`, `create`, `update`, create/move files & folders — **and** `start_coding_session`.
- **We narrate back** on the same `delegation_id`:
  - `session.commentary.append` → spoken aloud (paraphrased).
  - `session.thinking.append` → silent context the model can reference if the user follows up.
- **We own "done."** There is no completion event — our backend emits the final `commentary.append`
  ("Done — updated the title").

### Agentic / long-running (spawn a coding agent) — the documented happy path

OpenAI explicitly supports streaming progress on an open delegation:

1. User: "go build X." Our brain calls `start_coding_session` (async — returns immediately).
2. `commentary.append` → "Starting that now." (spoken instantly; full-duplex, so the user can keep
   talking).
3. More `commentary.append` on the **same `delegation_id`** as state changes ("it's spinning up…").
4. Terminal `commentary.append` when the agent finishes or needs input ("Done" / "It needs your
   okay on X").

Routine ops (update a title, search) are the same loop without the async wait.

## Phase 0 — the spike (build FIRST; throwaway; test on a phone)

A minimal, **isolated** surface — do **not** touch production Converse or build the adapter yet.

Build:
- Server endpoint that mints a `gpt-live-1` client-delegation session + ephemeral key.
- A bare phone web page that connects over WebRTC and streams mic/speaker.
- A small server-side brain: reuse the existing `runVaultTool` + a function-calling model (the
  typed-chat path) wired to a handful of real tools — e.g. `search`, `create`, and **one agentic
  stub** (`start_coding_session` that sleeps a few seconds then reports "done").
- Narrate every result via `commentary.append`; stream the spawn progress.

**Success criteria (what the spike must answer):**
1. **Does full-duplex actually feel better** than `gpt-realtime-2.1` on a phone? (the whole point.)
2. Does the client-delegation loop work end-to-end (`delegation.created` → our brain → spoken
   result)?
3. Latency to first spoken word; tool round-trip feel.
4. Can we **narrate a multi-second spawn while the user keeps talking** (barge-in holds up)?
5. Echo / robustness on a phone over WebRTC (should be fine — WebRTC is retained, unlike the Gemini
   path).
6. Rough real cost for a few minutes of use.

If the spike wins, proceed. If full-duplex doesn't feel meaningfully better, stop here — we've spent
days, not weeks.

## Later phases (high-level; detail after the spike)

1. **Provider adapter** — introduce a `VoiceTransport` seam (borrow the extension's
   `voice-provider-adapter` design) so OpenAI Realtime and GPT-Live are swappable behind one
   interface, `useVoiceSession`-style.
2. **Move production Converse** behind the seam; add GPT-Live as a selectable provider/setting
   alongside `gpt-realtime-2.1`.
3. (Optional, later) Gemini Live as a third backend for the cost case.

## Constraints / gotchas to respect

- **Image input is gone** in GPT-Live-1 — Converse's image replay into voice must stay chat-only.
- **`instructions` are immutable after startup**; our just-shipped mid-call context refresh (the
  `session.update` instructions path) doesn't apply — keep rich context (date/projects/tasks/areas)
  in **our brain**, push only small speech-relevant summaries via `thinking.append`.
- **~500-token cap per append** — chunk/summarize long tool output before narrating.
- **No completion event** — model "job done" ourselves.
- **Backend-model 403 delegation bug** is a `responses`-delegation issue — **irrelevant in client
  mode** (we run our own brain), which is one reason client mode is the safer choice.

## Verify against the SDK before building

- The exact ephemeral client-secret field/endpoint for `/v1/live/*` (confirmed concept via the
  Realtime lineage; the Live-specific field name was not pinned from a primary page).
- Whether a single client delegation has a **max open duration / idle timeout** (undocumented) —
  matters for long agent runs; design a keep-alive or re-open path if needed.
- Whether `session.delegation.created` / the transcript deltas arrive as expected on the WebRTC
  data channel in a mobile browser.

## References

- OpenAI, Client delegation for GPT-Live — https://developers.openai.com/api/docs/guides/live-delegation
- OpenAI, GPT-Live getting started — https://developers.openai.com/api/docs/guides/live
- OpenAI, TS reference (Live resource) — https://developers.openai.com/api/reference/typescript/resources/live
- GPT-Live-1 model page (modalities, pricing, transports) — https://developers.openai.com/api/docs/models/gpt-live-1
- Microsoft Foundry GPT-Live event reference (secondary; wire-level detail) — https://learn.microsoft.com/en-us/azure/foundry/openai/gpt-live-reference
- Our current path for reference: `src/voice-rt.ts`, `src/chat-providers.ts`, `src/vault-tools.ts`, `web/src/converse.tsx`.
- Companion plan (spawn-sessions, which `start_coding_session` comes from): `docs/converse-voice-gap.md`.

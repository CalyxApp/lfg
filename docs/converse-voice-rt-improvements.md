# Converse voice (OpenAI Realtime) — improvements, Rev 1

Branch: `converse-voice-rt-improvements`. Owner: Sam + Claude, 2026-07-29.

This documents a batch of improvements to the **Converse** realtime voice feature
(OpenAI `gpt-realtime`), driven by Sam's feedback and OpenAI's realtime best-practice
guidance. It covers what changed, why, and how to tune it. The one thing explicitly
**out of scope** is a cross-device "universal chat" transcript store — deferred as a
bigger design (see §Deferred).

## Where the feature lives
- `src/voice-rt.ts` — server: mints the ephemeral token bound to the session config,
  runs relayed tool calls, saves a finished conversation as a vault note, and (new)
  receives debug-log batches.
- `web/src/converse.tsx` — browser: holds the WebRTC peer connection directly to
  OpenAI, renders the thread, relays tool calls.
- `src/converse-persona.ts` — **new**: the shared assistant persona (voice + text).
- `src/vault-tools.ts` — the tool suite + (new) `buildVaultContext` + `wait_for_user`.
- `src/chat-providers.ts` — typed-chat sibling (now shares the persona).
- `web/src/lib/earcons.ts` — **new**: synthesized audio cues.
- `src/commands/serve.ts` — routes.

## Decisions locked with Sam (2026-07-29)
- **Model:** full `gpt-realtime-2.1` (was `gpt-realtime-2.1-mini`) — the full-size
  sibling in the same current generation (released 2026-07-06). Env-overridable via
  `CONVERSE_RT_MODEL`.
- **Mic profile:** `near_field` noise reduction (earbuds + phone; never laptop).
- **Injected tasks:** overdue within the **past 7 days** + due in the **next 7 days**,
  **no cap**. Projects: **all active**, by name (+ status if not plain "active").
- **Email addresses:** injection **deferred** (Sam to gather them first).
- **Push-to-talk:** not now (hands-free only).

## Workstreams

### A — Ambient noise & accidental interruptions
- `audio.input.noise_reduction: { type: "near_field" }` — OpenAI-side ambient
  suppression so a TV / second voice is far less likely to false-trigger a barge-in.
- `turn_detection.eagerness: "low"` (was `auto`) — waits longer before deciding the
  user is done / is interrupting. Still `semantic_vad` with `interrupt_response: true`
  (deliberate barge-in stays possible).
- `max_output_tokens: 2048` — bounds runaway replies.
- Prompt-level guard: `wait_for_user` tool + "unclear audio & silence" rules (see B).

### B — System instructions, restructured + de-duplicated
- New `src/converse-persona.ts`: `PERSONA_CORE` (shared) + `VOICE_ADDENDUM` /
  `TEXT_ADDENDUM`. Structured as short labelled sections per OpenAI's realtime
  prompting guide (Role, Tools-by-risk, Verbosity; voice adds Personality, Preambles,
  Unclear-audio & silence, Entity capture, Language). Write-tool confirmation scoped
  narrowly ("confirm the title before create/rename"), not a blanket "always confirm".
- `wait_for_user` no-op tool: the model calls it to **stay silent** on ambient
  noise/silence instead of replying. The client acknowledges it but sends **no**
  `response.create`, so the model isn't forced to speak, and shows no chip.
- Voice + text now share one persona core (no more drift between the two literals).

### C — Live session context at conversation start
- `buildVaultContext(repoCwd)` assembles a `# Session context` block: today's date +
  weekday, **all active projects**, tasks **overdue (past 7 days)** and **due (next 7
  days)**. Appended to the spoken `instructions` at token-mint time. Best-effort —
  any failure returns `""` so the token still mints. Labelled "may be stale" so the
  model re-checks with `list_by_type` when it needs certainty.
- `serve.ts` resolves the single workspace vault (`CONVERSE_WORKSPACE`, default
  `PlatosRaveCave`) and passes its cwd into `handleRtToken`.

### D — Transcript "who's speaking" race
- `transcription: { language: "en" }` — steadier/faster user-side transcription.
- Placeholder TTL: an unresolved `"…"` user placeholder is cleared after 9 s (fixes
  the stuck placeholder from noise-triggered VAD / empty transcription).
- Distinct **"🎤 transcribing…"** render vs a finished user bubble.
- `resolveUserTranscript`: matches the transcript onto its placeholder by item id,
  falling back to the newest unresolved `"…"` so text can't land after the reply.

### E — Synthesized audio cues (`web/src/lib/earcons.ts`)
- **Ready chime** (soft rising two-note) when the session goes live — so you know it's
  listening instead of waiting in silence.
- **Working heartbeat** (quiet pulse, ref-counted) while a tool call runs; stops on
  result. This is the "something's happening" cue.
- **Error tone** (gentle descending) on connect failure / dropped connection.
- All synthesized (no asset files), ducked quiet, muteable (persisted to
  `localStorage`), with a speaker toggle in the voice footer. Audio unlocked on the
  tap that enters voice mode.

### F — Robustness
- Auto-reconnect: on WebRTC `connectionState === "failed"`, reconnect up to 2× (via a
  `connNonce` that re-runs the connect effect); a clean open resets the budget.
- Preamble + concise-verbosity rules baked into the persona (B).
- `max_output_tokens` cap (A).

### G — Automatic per-session debug log
- Sam wants **every** Converse call recorded locally for debugging. The browser holds
  WebRTC directly to OpenAI, so the client **batches** its events and POSTs them to
  `POST /api/voice/rt/log`; the server appends **JSONL, one file per surface** to
  `data/converse-logs/<sessionId>.jsonl` (**git-ignored, local-only**).
- Captured: every realtime event verbatim (`speech_started`, transcripts, `response.
  done`, errors), each tool call with args + result, connection-state changes, and
  typed chat turns. Buffered + flushed on a 2.5 s timer, at 20 events, and on teardown
  (with `keepalive`) so a crash mid-call still leaves a trail.
- This is **separate** from the manual "save as vault note" flow, which stays a curated
  keepsake. It is also the natural substrate for a future universal store.

## How to tune / operate
- Change the persona: edit `src/converse-persona.ts` (one place for both engines).
- Wrong model id? set `CONVERSE_RT_MODEL` in the env — no code change.
- Noisier environment: raise interruption resistance by keeping `eagerness: "low"`;
  for a laptop mic switch `noise_reduction.type` to `"far_field"` in `voice-rt.ts`.
- Read a debug log: `data/converse-logs/*.jsonl` (JSON per line).

## Verification
- `web` and server both pass `tsc --noEmit` (0 errors).
- **Session config validated against the live key** (2026-07-29): the full new config
  (`model: gpt-realtime-2.1`, `noise_reduction: near_field`, `transcription.language:
  "en"`, `semantic_vad`/`eagerness: low`, `max_output_tokens`, `voice: marin`) minted a
  client secret with **HTTP 200**. The mint endpoint DOES schema-validate the session —
  bogus values 400 with the supported list (e.g. noise_reduction supports exactly
  `near_field`/`far_field`; turn_detection `server_vad`/`semantic_vad`) — so a 200
  confirms every field/value name is accepted.
- Still to do: a real WebRTC round-trip on-device (mint validates config but not the
  model string; the model is only exercised when the call connects).

## Risks / notes
- **Model id.** `gpt-realtime-2.1` confirmed as the current-generation full model from
  OpenAI's changelog (released alongside the `-mini` we already ran). The mint endpoint
  does not validate the model string, so if a call ever fails on the model, set
  `CONVERSE_RT_MODEL` — no code change.

## Deferred (NOT in this branch)
- Cross-device **universal chat / transcript store** spanning mobile + desktop. The
  local debug log (G) is a stepping stone but the durable, synced conversation store
  is a separate design.
- **Email-address** injection into session context (pending Sam's list).

## Progress
- [x] A — noise reduction + eagerness low + model + max tokens
- [x] B — persona restructure + shared core + wait_for_user
- [x] C — startup context injection
- [x] D — transcript race + language hint
- [x] E — audio cues
- [x] F — reconnect + verbosity/preamble + token cap
- [x] G — per-session debug log
- [x] typecheck (web + server) green
- [ ] on-device smoke test with a live key (Sam)

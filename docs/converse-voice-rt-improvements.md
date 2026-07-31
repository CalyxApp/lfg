# Converse voice + chat — improvements log

Branch: `converse-voice-rt-improvements` → merged to `main`. Owner: Sam + Claude.
Started 2026-07-29. This is the running record of the Converse overhaul (OpenAI
Realtime **voice** + hosted **chat**). Companion doc: `docs/converse-universal-view.md`
(Phase 4 storage design).

Out of scope throughout: nothing now — the deferred "universal chat" was built (Phase 4).
Only genuinely deferred item: **email-address** injection (pending Sam's list).

## Where the feature lives
- `src/voice-rt.ts` — voice: token mint + session config, tool relay, file-upload +
  file-text proxies, fresh-instructions endpoint, save-conversation.
- `src/chat-providers.ts` — hosted typed chat (OpenAI; Gemini/Claude registered).
- `src/converse-persona.ts` — shared persona (voice + text).
- `src/vault-tools.ts` — 9-tool suite + `buildVaultContext` + `wait_for_user`.
- `src/converse-store.ts` — universal-view storage adapter (the seam).
- `web/src/converse.tsx` — the unified chat↔voice surface.
- `web/src/components/` — `conversation-turns.tsx` (shared renderer), `tool-card.tsx`,
  `voice-meter.tsx`, `earcons.ts`.
- `web/src/conversation-history.tsx` — the universal view.
- `src/commands/serve.ts` — routes.

## Decisions locked with Sam
- **Model:** voice `gpt-realtime-2.1` (env-overridable `CONVERSE_RT_MODEL`); confirmed
  current-gen via changelog + live mint. Typed chat: user-selectable `gpt-5.6-*`.
- **Mic:** `near_field` noise reduction (earbuds + phone).
- **Injected tasks:** overdue past 7 days + due next 7 days, no cap. Projects: all active.
- **Email injection:** deferred. **Push-to-talk:** not wanted (mic-mute suffices).
- **Files into voice:** option (b) — extract text and inject as context (realtime can't
  read documents; confirmed by OpenAI guidance).

## Shipped (chronological)

### Core A–G (foundation)
- **A** — `input_audio_noise_reduction: near_field`, `semantic_vad` `eagerness: low`,
  `max_output_tokens: 2048` on the voice session.
- **B** — persona restructured into OpenAI's labelled sections; shared `PERSONA_CORE`
  across voice+text (no drift); voice addendum adds preambles / unclear-audio / silence
  / entity read-back. `wait_for_user` no-op tool (voice stays silent on ambient noise).
- **C** — live `buildVaultContext` injected at session start: today's date, all active
  projects, tasks overdue (past 7d) + due (next 7d).
- **D** — transcript race fixes: `transcription.language: "en"`, stale-`"…"`-placeholder
  TTL, distinct "transcribing…" state, order-based transcript reconciliation.
- **E** — synthesized earcons (no assets): ready chime, working heartbeat, error tone;
  mute toggle.
- **F** — auto-reconnect on dropped WebRTC (2 retries); verbosity/preamble rules.
- **G** — automatic per-session debug log: every realtime event + tool call + chat turn
  → append-only JSONL at `data/converse-logs/` (git-ignored, local).

### Transparency
- Persona now recites its own setup/instructions/context when asked (was refusing).

### Phase 1 — revisit essentials
- **Auto-save** every conversation on close (markdown note in the vault) — no manual step.
- **Voice meter** — live mic-level bars so you can see it's hearing you.
- "transcribing…" indicator is text-only (dropped the emoji).

### Phase 2 — tool-call previews
- Tool chips gained per-tool icons and expand-on-click to show input args + result
  (`tool-card.tsx`); shared by voice + text; server returns the tool result for typed mode.

### Phase 3 — attachments (typed chat)
- **Images** inline as base64 `image_url` parts. **Files** (PDF/doc) via the OpenAI Files
  API (`purpose=user_data` → `file_id`, referenced as a `file` content part). Paperclip +
  paste + drag-drop; preview with upload status; thumbnails/chips on the turn.

### Phase 4 — universal view (see companion doc)
- Storage adapter `converse-store.ts` + normalized HTTP contract
  (`/api/converse/conversations[/:id]`) + read-only viewer + shared `conversation-turns`
  renderer. On close, a **structured record** (turns incl. tool calls + attachments) is
  saved alongside the markdown note. History button in the Converse header opens it.

### Voice/chat parity pass (users expect identical capability)
- **Context in typed chat** — the `buildVaultContext` snapshot is now injected into the
  chat system prompt too (was voice-only; the bug Sam caught: it knew the date but not
  his projects).
- **#1** — typed replies capped (`max_completion_tokens: 1500`; `max_tokens` is rejected
  by these models) to match voice's brevity.
- **#2** — voice context stays fresh: `GET /api/voice/rt/instructions` returns a rebuilt
  snapshot; the client re-pushes it via `session.update` every ~2.5 min.
- **#3a** — chat→voice thread replay carries user **images** into the session as
  `input_image`.
- **#3b** — chat→voice carries **files** too: `POST /api/voice/rt/file-text` extracts a
  file's text (via a model that can read it) and the replay injects it as `input_text`
  (cached per turn). Typed chat rebuilds history as rich content (`buildChatHistory`) so
  it re-references prior images (natively) + files (by `file_id`) across turns and mode
  switches — not just on the turn attached.

### Misc
- LFG logo removed from the app UI (nav button → neutral `Activity` icon; picker header
  logo removed). PWA install/home-screen icon left as-is.

## Verification (against the live key / deployed endpoints)
- Session config mints 200 with all fields; model confirmed `gpt-realtime-2.1`.
- Image chat: model reads a real image (replies "Red").
- File chat: upload → `file_id` → model reads the PDF ("Pineapple 7391" / "42").
- File-text extraction: returns the exact PDF contents ("Project Aurora budget…").
- Context injection: typed chat lists 42 active projects + 19 overdue tasks.
- #2 instructions endpoint returns fresh context; universal-view store round-trips
  (save→list→get) with tool calls preserved.
- `tsc --noEmit` green for web; server clean apart from pre-existing optional-backend
  module stubs (`@openai/codex-sdk`, `@mariozechner/pi-*`).

## How to tune / operate
- Persona: edit `src/converse-persona.ts` (one place, both engines).
- Wrong model id? set `CONVERSE_RT_MODEL`. Extraction model: `CONVERSE_EXTRACT_MODEL`.
- Laptop mic instead of earbuds: switch `noise_reduction.type` to `far_field`.
- Debug logs: `data/converse-logs/*.jsonl`. Saved records: `data/converse-conversations/*.json`.

## Known limits / follow-ups
- First voice switch after attaching a file adds a few seconds (extraction; cached after).
- Typed chat re-sends prior images each turn — fine at normal volumes, optimizable later.
- Attachments originate in typed chat only (voice has no composer) — appropriate.
- **Deferred:** email-address injection; cross-device sync of the universal store (the
  adapter seam is ready for it).

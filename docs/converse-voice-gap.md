# Converse voice — close the gap with the desktop agent

**Status:** plan · **Scope:** mobile app (Converse) only · **Date:** 2026-10-08

## Goal

Make Converse — the team-built voice chat on the OpenAI Realtime API — able to **start and
manage background coding-agent sessions by voice**, and make it **chatty enough to run eyes-free**
(Sam is not looking at the phone). Close the obvious capability gap with the VS Code extension's
voice agent, and harden the realtime layer while we are in here.

This plan covers mobile only. The desktop extension voice agent is the reference for *what* is
possible, not a thing we change here.

## Current state (origin/main, audited 2026-10-08)

- **Model / transport:** `gpt-realtime-2.1` over WebRTC, voice `marin`, ephemeral token minted
  server-side (`src/voice-rt.ts:35`, `:92`, `:105`). Provider is fixed in `voice-rt.ts`, *not*
  routed through `voice-providers.ts`.
- **Tools (10):** `describe_vault`, `search`, `list_by_type`, `browse`, `read`, `create`,
  `create_project`, `update`, `web_search`, `wait_for_user` (`src/vault-tools.ts:633-786`,
  dispatched by `runVaultTool` at `:792`).
- **Gap:** Converse **cannot spawn a coding session**. That lives only on the other, weaker voice
  surfaces (the push-to-talk orb → `/api/voice/intent` → `/api/sessions/new`, and the upstream
  LiveKit agent). It also cannot list or steer running sessions.
- **Persona:** tuned to be *brief* (`src/converse-persona.ts`, `VOICE_ADDENDUM`) — the opposite of
  what eyes-free needs.

### What already exists server-side (reuse, do not rebuild)

- **Spawn:** `POST /api/sessions/new` (`src/commands/serve.ts:3327`) already takes
  `{ prompt, cwd, user, voice, worktree, model, thinkingLevel, parentSessionId, spawnedBy, agent }`,
  validates the repo against an allowlist (`:3406`), validates/allowlists models per agent
  (`:3365-3384`), and tags `spawnedBy: "voice"` (`src/managed.ts:35`).
- **List:** `voiceStatusSnapshot(user)` (`serve.ts:1092`) already renders a voice-readable list —
  per session a clipped label, agent family, `IDLE`/`WORKING`/`BLOCKED` status, the blocking
  question with its options, and the time since last activity. It also appends **pending questions
  for the human** to read out (`:1164`). Scoped to the speaking user (`:1101`).
- **Steer / answer:** `POST /api/sessions/:id/send` (used at `serve.ts:2474`), `/close` (`:2502`),
  and `plannedSessionAction()` (`:1078`) which maps a free-text answer to close / send / none.

So the feature is mostly **wiring this infra into Converse's realtime tool set**, not new
machinery.

## Decisions (locked with Sam, 2026-10-08)

1. **Spawn is trust-and-go. No brief confirmation.** The spoken request becomes the session brief
   and is sent automatically — no "is this right?" step. Confirmation is reserved for genuinely
   destructive *vault* edits, never for spawning.
2. **Multiple concurrent sessions.** Converse can kick off more than one and list/steer them. This
   raises the bar on naming them back clearly (see persona).
3. **Research is done.** Prior-art pass complete (see References); we have enough to build.

## Design

### New tools (added to `VAULT_TOOL_SCHEMAS`, dispatched in `runVaultTool`)

| Tool | Args | Backend | Notes |
|---|---|---|---|
| `start_coding_session` | `instructions` (req), `repo?`, `agent?`, `model?`, `thinkingLevel?`, `worktree?` | `POST /api/sessions/new` with `voice:true, spawnedBy:"voice", user` | Trust-and-go. `instructions` is the spoken brief, passed verbatim as `prompt`. `repo` resolves a friendly name → `cwd` (reuse `listRepos`); omitted → default repo. Returns the new session id + label so Converse can name it back. |
| `list_sessions` | — | `voiceStatusSnapshot(user)` | Already voice-shaped. Wire it straight through. Include pending human questions. |
| `steer_session` | `session` (req), `message` (req) | resolve `session` → id, `POST /api/sessions/:id/send` | `session` is matched by fuzzy label/agent (not a raw id — Sam speaks names). Ambiguous → return candidates for read-back (mirror `resolveDoc` at `vault-tools.ts:86`). |
| `close_session` | `session` (req) | resolve → `POST /api/sessions/:id/close` | **Confirm before closing** — losing a running agent is destructive. |

`start_coding_session` and `list_sessions` are voice-only in spirit but harmless in typed chat, so
add them to both envelopes; `runVaultTool` stays the single backend (matches the existing voice/
typed split where only `wait_for_user` is voice-only).

### Chat-supervisor split for spawn (do not block the voice turn)

The Realtime API gives **no built-in way to stop the model going silent during a long tool call**
(confirmed against the official realtime docs). Spawning a session + first agent output is slow, so:

- `start_coding_session` returns **immediately** after the session is created (it does not wait for
  the agent's first output). The realtime model speaks a preamble ("Starting that now…") *before*
  the call and a confirmation ("Kicked off — I'll tell you when it needs you") *after* the id comes
  back.
- Progress and completion are pushed back **out-of-band** so they never block or pollute the main
  turn: when a session goes `BLOCKED` (needs an answer) or finishes, narrate it via an out-of-band
  `response.create` (`conversation:"none"`). These are the **only two moments** worth narrating
  unprompted (per the agent-voice prior art); everything else is available on demand via
  `list_sessions`.

Wiring: the server already knows session state transitions (`voiceStatusSnapshot` computes them). A
lightweight poll or the existing session event stream drives a "needs you / finished" nudge to the
Converse client, which raises it as an out-of-band spoken line + earcon.

### Chattiness / persona (eyes-free) — `converse-persona.ts`

Rework `VOICE_ADDENDUM` from "brief" toward eyes-free narration:

- **Tool-call preambles are mandatory** for every side-effecting tool — a spoken placeholder before
  the call ("Let me start that…"), never a silent invocation.
- **Narrate results out loud.** The tool-call chips are invisible to an eyes-free user — the model
  must speak the outcome ("Found 3 tasks due this week: …"), not assume the screen.
- **Read entities back** — project slugs, branch names, session labels, task ids are mis-hear
  magnets. Keep/extend the existing read-back rule and give the model a **pronunciation/alias list**
  of common vault entities and repo names.
- **Name sessions back clearly** so multiple concurrent sessions are tellable apart by voice ("the
  auth-refactor one finished").
- **A Variety rule** to kill robotic repetition (per the OpenAI prompting guide).
- Bump `max_output_tokens` (2048 today, `voice-rt.ts:74`) modestly to allow fuller spoken summaries.

### Confirmation policy

- **Reversible / read-only** (`search`, `read`, `list_sessions`, `start_coding_session`,
  `steer_session`): act, then narrate. No confirmation.
- **Destructive** (`close_session`, a vault `update` that nulls a field, future delete): two-turn
  confirm — read the entity back, require an explicit "yes," tolerate the user saying yes over the
  agent. Confirmation is the exception, not the default (VUI guidance) or eyes-free becomes nagging.

## Hardening (worth doing while we are in here)

1. **Long-session handoff.** The realtime session has a **hard 60-minute cap** and usable quality
   decays well before it (community reports ~15 min). Our current 2.5-min `session.update` refresh
   (`converse.tsx:777`) does *not* address this. Add an **overlapping-session handoff**: mint a fresh
   token, seed the new session's instructions with a transcript summary + recent turns, drop the old
   one. Trigger on a timer well under 60 min.
2. **Own reconnection explicitly.** Watch `pc.connectionState` / `connectionstatechange`; on an ICE
   or network drop, resume with the summary rather than losing the thread. (The existing 2-retry
   reconnect at `converse.tsx:710` is a start; make it resume-with-context.)
3. **Injection resistance on composed commands.** The vault is untrusted input. When the model
   composes `start_coding_session.instructions` or `steer_session.message` partly from vault text,
   run an input/tool guardrail (injection-detection) before dispatch. Keep the repo allowlist and
   per-agent model allowlist that `/api/sessions/new` already enforces — never a silent fallback.
4. **Long-tool-call UX.** Keep the "working" earcon going during slow tools and require the model to
   say "give me a second" so latency never reads as a hang. Pair with the existing
   `semantic_vad` + `eagerness:low` (validated as correct for think-aloud dictation).
5. **Error narration.** When a tool throws, the model must *say so*. Eyes-free, a silent failure is
   invisible. Add explicit "tell the user when a tool fails" to the persona and make `runVaultTool`
   return speakable error text.
6. **Token expiry mid-call.** Long calls can outlive the ephemeral secret — refresh it as part of
   the handoff path.
7. **Tests.** Mobile has far less voice coverage than the extension. Add unit tests for the new
   tools (schema + dispatch), the session-name resolver (fuzzy + ambiguous → candidates), the repo
   allowlist guard, and the injection guard.

## Open questions

- **`near_field` noise reduction** (`voice-rt.ts:81`) has no official backing — validate on-device,
  or expose `far_field` as a fallback.
- **Which repo is the default** for a voice-spawned session? Default to the primary repo
  (`CONVERSE_WORKSPACE` / PlatosRaveCave) unless Sam names one, or make it a setting.
- **Agent/model default** for voice spawns — follow `/api/sessions/new`'s default (`aisdk`), or let
  Converse pick Claude vs Codex by voice?

## Phasing

1. **Slice 1 (MVP, useful alone):** `start_coding_session` (trust-and-go) + `list_sessions`, with
   preambles and result narration in the persona. This alone lets Sam start and check on coding
   work hands-free.
2. **Slice 2:** `steer_session` + `close_session` (with confirm), session-name resolver, out-of-band
   "needs you / finished" narration.
3. **Slice 3 (hardening):** long-session handoff, resume-with-summary reconnection, injection guard,
   tests.

Each slice ships independently.

## References

- Audit (this repo, mobile Converse) and the VS Code extension voice agent comparison — session
  notes 2026-10-08.
- Prior-art research 2026-10-08: OpenAI Realtime prompting guide (preambles, two-turn confirm,
  pronunciation lists), `openai/openai-realtime-agents` (chat-supervisor), official Realtime
  Conversations guide (tool loop, out-of-band `response.create`, 60-min cap, `session.update`),
  Realtime VAD guide (`semantic_vad`/`eagerness`), community long-session handoff pattern, OpenAI
  Agents SDK guardrails/approvals (injection detection, serializable approval), `duongntbk/voice-to-code`
  and `LucasZaia/agent-voice` (eyes-free coding-agent narration), `symunona/obsidian-hermes` /
  `smixs/agent-second-brain` / Khoj (live voice over a vault that acts).
- Key source anchors: `src/voice-rt.ts`, `src/vault-tools.ts`, `src/converse-persona.ts`,
  `src/commands/serve.ts:1092` (`voiceStatusSnapshot`), `:3327` (`/api/sessions/new`),
  `web/src/converse.tsx`.

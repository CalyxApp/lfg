# Artifacts: upstream catch-up + chat-surface wiring

**Date:** 2026-10-08
**Branch:** `session-artifacts-port`
**Goal (Sam):** Talk to an agent, have it produce a file / HTML / image / video, and
open & review that output on the phone. Primary surface = **coding-agent sessions**
(the review surface). Secondary = **Converse** (typed OpenAI chat + gpt-realtime voice).
Mentioned, deferred = the **floating voice orb**.

---

## What we already have (origin/main)

Artifacts are live in production: a store (`src/artifacts.ts`), byte server with
Range support (`GET /api/artifacts/:id`), a gallery tab (`ArtifactsView.tsx`),
inline cards in the session transcript (`ArtifactInlineCard`, `App.tsx:8614`), and
three agent tools in the LFG MCP server (`lfg_display_image`, `lfg_display_video`,
`lfg_publish_artifact`). Backend lineage is upstream's P2; the web viewer is ours.

## What the research settled

- **We are ~3287 commits behind upstream (BennyKok/lfg), which is mid-rebrand to
  "omg".** A wholesale merge is out of scope and high-risk.
- **Most upstream artifact work does not apply to us.** They added a `mobile/` Expo
  app and a `packages/` monorepo (protocol/client/cloud) — **we have neither**. Their
  web-viewer rewrite (`native-artifact`, `authenticated-artifact`, signed-URL hosted
  media) assumes that monorepo + an auth/cloud model we don't run. Adopting it means
  replacing our working viewer for no gain toward the goal. **Keep ours.**
- **The one high-value, clean-to-port upstream addition is `display_file`** — let an
  agent hand the user *any* file (PDF, CSV, log, zip, …) as a downloadable card. It
  shares ancestry with our code and the `omg` rename does **not** contaminate it.
- **Converse and the floating orb are fork-original.** Upstream can't help wire them;
  but the Converse seam is small and covers typed chat *and* voice at once (they share
  one tool dispatcher `runVaultTool` and one renderer `ConversationTurns`).

---

## Phase 1 — `display_file` end-to-end (coding-agent sessions) — PRIMARY

Add a fourth artifact kind, `file`, served as a **download** (never rendered in place,
so an agent-written `.html`/`.svg` can't execute as the user). This is the direct
"it produced a file, I open it" path, in the surface Sam reviews in.

**Server**
1. `src/sessions.ts` — add `"file"` to the `SessionMsg.kind` union.
2. `src/artifact-headers.ts` — **new** (port verbatim from upstream; brand-clean):
   `contentDisposition("inline"|"attachment", name)`, RFC-6266, response-splitting-safe.
3. `src/artifacts.ts` — `MediaKind` gains `"file"`; `MAX_FILE_BYTES = 100 MB`;
   `fileMimeFor()` (known types + `application/octet-stream` fallback, never null);
   generalize `createMediaArtifact` for `file`; export `createFileArtifact`; add
   `"file"` to the retry-collapse and hydrate guards.
4. `src/commands/serve.ts` — new `POST /api/sessions/:id/artifacts/files` (clone of the
   videos route, calls `createFileArtifact` + `indexArtifactMessage`); in
   `GET /api/artifacts/:id`, set `Content-Disposition: attachment` (via the new header)
   when `media === "file"`.
5. `src/transcript-index.ts` — add `"file"` to the `rowMessage` hydration guard so a
   file placement rehydrates with url/name/size/mime on the transcript page.
   (Leave the historical v9 migration SQL untouched.)
6. `src/commands/mcp.ts` — register `lfg_display_file` (clone of `lfg_display_video`,
   POSTs to `/artifacts/files`).
7. `src/lfg-capabilities.ts` — one guidance line + contract bullet for file display.

**Web**
8. `web/src/components/ArtifactsView.tsx` — `ArtifactCard.kind` gains `"file"`; a
   `"Files"` filter; `KindIcon` file case; a **download card** branch in `ArtifactMedia`
   (gallery) and in `ArtifactInlineCard` (transcript) — icon · name · size · Download.
9. `web/src/App.tsx` — add `"file"` to the inline-render guard (`:8609`); widen the
   `Message` type with `name?`/`size?`.

**Gate:** `bun test src/artifact*.test.ts src/transcript-artifact-join.test.ts`
(extended to cover `file`) + port `src/artifact-headers.test.ts`; `cd web && bun run build`.

## Phase 2 — image/video dimensions (optional fast-follow)

Upstream reads intrinsic `width`/`height` at publish (sharp for images, ffprobe for
video) to stop layout shift. `ffprobe`/`ffmpeg` and `sharp` are present on this box.
Deferred: nice-to-have, not required for the goal. Revisit after Phases 1 & 3.

## Phase 3 — artifacts in Converse (typed chat + gpt-realtime voice) — SECONDARY

Converse has no SQLite transcript (its thread is client state), so we do **not** use
the transcript-index delivery path. Instead carry the artifact in the tool result.

1. `src/vault-tools.ts` — add a `display_image` + `publish_html` tool to
   `VAULT_TOOL_SCHEMAS` and a case in `runVaultTool`. Both typed chat and voice get
   them for free (shared dispatcher).
2. Thread a per-Converse **UUID session id** down `runChatTurn` / `runRtTool` /
   `runVaultTool` (additive param) so the artifact store's UUID check passes. Mint it
   once in `converse.tsx` and send it in the chat + tool POST bodies.
3. The tool returns `{ artifact: imageArtifactToMessage(...) }`; do **not** index to
   SQLite.
4. `web/src/converse.tsx` + `web/src/components/conversation-turns.tsx` — add
   artifact fields to `LogEntry` and one render branch that reuses `ArtifactInlineCard`.
   Works in voice mode too (same `log` + renderer on screen during a call).

**Gate:** typed-chat + voice manual check that a published artifact renders inline;
`cd web && bun run build`.

## Phase 4 — floating voice orb (LiveKit/ElevenLabs) — DEFERRED, needs a decision

The orb (`voice-call.tsx`, brain `voice-eleven-llm.ts`, `FLEET_TOOLS`) runs over a
different transport, has fleet-only tools, and **has no message/transcript surface** to
render a card into. Options: (a) add a card strip to the call screen, or (b) route any
artifact to the *launching* coding session's transcript instead. This is a real product
decision + a new UI surface — build it as a separate effort once (a) vs (b) is chosen.

---

## Why not just pull upstream

Keeps a working production app intact; avoids the `omg` rebrand churn and a 3287-commit
merge; avoids adopting a `packages/`+`mobile/` architecture we don't have. We take the
one thing that's both valuable and ancestry-clean (`display_file`) and build the
fork-original chat wiring ourselves.

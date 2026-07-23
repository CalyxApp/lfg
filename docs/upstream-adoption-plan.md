# Upstream Adoption Plan — pulling BennyKok/lfg features into CalyxApp/lfg

> **Priority: HIGH.** Status: **plan of record — not yet started.**
> Author: exploration pass, 2026-07-23. Owner: Sam.
>
> This plan is based on a deep read of the upstream code at tag `8c86d77`. Re-verify
> line numbers before implementing — upstream moves fast (was the tip on 2026-07-23).

## TL;DR

We forked `BennyKok/lfg` on **2026-07-04** at commit `1c6b32a`
(*"feat: add agent browser and subagent lineage"* — i.e. right after the browser feature).
Since then upstream shipped **224 commits** (47 features). Our fork added **34 commits**
(mobile/Capacitor shell, Calyx vault endpoints, our own voice/chat stack).

**The work is mostly parallel.** Only **9 of our 46 changed files** overlap upstream's 170,
and only three of those are real semantic hot-spots:
- `src/commands/serve.ts` — the monolithic router; everyone piles routes in here.
- `web/src/App.tsx` — upstream rebuilt the web app (+6918/−2767); we're diverging into our own shell.
- `src/voice-providers.ts` — the one genuinely shared voice file (small).

The rest (lockfiles, `package.json`, `vite.config.ts`, `report-error.ts`) are mechanical.

**Conclusion: cherry-pick, don't bulk-merge.** A full `git merge upstream/main` would drag in
the 6.9k-line `App.tsx` rewrite and force reconciliation against our mobile fork all at once.
Cherry-picking the engine work gives us the good parts with small, contained `serve.ts` edits.

### Reference points
- Fork base: `1c6b32a`
- Upstream tip read for this plan: `8c86d77`
- Upstream remote (ad-hoc, not added to config): `https://github.com/BennyKok/lfg.git`
- To re-fetch: `git fetch https://github.com/BennyKok/lfg.git main`

---

## Priority 1 (P0) — Agent engine modernization  ⭐ take first

**What it is.** Upstream moved the Claude/Codex/OpenCode agent harnesses off a homemade
"Vercel AI SDK" middle-layer and onto each vendor's **official SDK**, and added **managed resume**.

**Why it matters (user-facing wins):**
- **Real interrupt** — stop an agent mid-turn via the SDK's native `interrupt()`, no kill/restart.
- **Managed resume** — disconnect and return to the *same live session* (one persistent session id;
  resumes the exact thread instead of forking a confused duplicate). Replaces a brittle tmux trick.
- **Live token streaming** — replies stream in (~150ms draft updates).
- **Full env inheritance** — the old wrapper silently dropped `LFG_*`/`ANTHROPIC_*`, orphaning
  subagents and breaking proxy routing. Fixed by going direct.

**How it works (mental model).** Each agent runs as one long-lived process supervised in a tmux
pane (pane = process babysitter only). The app communicates via two plain files on disk:
a **command file** (`data/aisdk/<id>.cmd`, append-only JSONL: send/interrupt/close — agent tails it
every 250ms) and a **registry entry** (`data/aisdk/<id>.json` — agent writes its live draft + status).
Transcripts are indexed straight into SQLite. No magic.

**Upstream commits to cherry-pick (in order):**
| Commit | What |
|--------|------|
| `20e85f0` | codex + opencode harnesses on their official SDKs — ⭐ cleanest, only new files + `package.json` |
| `ae03092` | claude harness on the official Agent SDK; managed resume — new `aisdk-session.ts` + a `serve.ts` wiring hunk |
| `170303c` | GitHub Copilot CLI as an 8th agent — lots of new files + `serve.ts` registration hunk (optional) |
| `d981e20` | add `pi` backend — new `pi-session.ts` (optional) |

**Files involved.** Backends are **self-contained new files** in `src/agents/backends/`
(`aisdk-session.ts`, `codex-aisdk-session.ts`, `opencode-aisdk-session.ts`, `pi-session.ts`).
Adding an agent kind also touches the dispatch surface: `src/coding-agents.ts`,
`src/coding-agent-adapters.ts`, `src/agent-catalog.ts`, `src/tmux.ts`, and the if/else dispatch in
`src/commands/serve.ts` (new-session, resume, send/interrupt). Repetitive but small edits.

**Collision with our fork.** Only `serve.ts` (dispatch wiring) and `package.json` (deps). The
harness files themselves don't collide with anything we've changed. **Low risk.**

**New deps.** `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`
(and `@mariozechner/pi-coding-agent` if we take pi).

**Effort: Low–Medium.** ~cherry-pick + hand-resolve the `serve.ts` dispatch hunks + `bun install`.
Consider refactoring the if/else dispatch into a `Record<kind, spawner>` map while we're in there.

---

## Priority 2 (P1) — Make agents "LFG-aware"  (ask-user, send-to-origin, capability contract, MCP tools)

**What it is.** The layer that turns a blind coding bot into something that participates in the
workflow. Three parts, all well-aligned with our phone/voice-driven model.

1. **Capability contract + MCP tools.** Every agent prompt gets a short plain-text "LFG runtime
   contract" prepended (what tools exist, when to use them). Plus ~20 **MCP tools**: list/spawn/
   steer/close sessions, delegate to a subagent, publish artifacts, ship, ask-user, send-to-origin.
   - Files: `src/lfg-capabilities.ts` (just string-prepending — trivially portable), `src/commands/mcp.ts`.
   - Injected in `src/tmux.ts` via `withLfgRuntimeContract()`.
2. **Ask-the-user, done right (`lfg_ask_user`).** Fire-and-forget: the agent poses a question, gets
   an id, and keeps working / ends its turn. When *you* answer (web/voice/whenever), the answer is
   **injected back into that session as a new message** — no blocking, no polling. There's also
   `lfg_ask_question` (consult a deeper advisor model and wait).
   - Files: `src/ask/` (filesystem + in-memory waiter), routes in `serve.ts`. Hooks a notification step.
3. **Send-to-origin (`lfg_send_to_origin`).** Agent sends a result "back to where the job came from"
   (text + media). **LFG stores only the payload and knows nothing about the channel** — an external
   adapter (our iMessage/Slack/voice bridge) picks it up and delivers it. Credentials never touch LFG.
   - Files: `src/origin-deliveries.ts` (self-contained filesystem I/O), routes in `serve.ts`.

**Upstream commits:** `6d7fe1a` (teach capabilities), `7f99238` (mcp session tools),
`c9add1e` (ask-question advisor), `aae7459` (send results to originating channels).

**Collision with our fork.** `7f99238` touches `serve.ts`, `App.tsx`, `vite.config.ts`, `package.json`
(4 of our files) — the messiest of this group. The `ask/` and `origin-deliveries` modules are
self-contained. **Low–Medium.** The main wiring is registering the MCP server with each agent CLI
and pointing the "notify me" step at our own notification path.

**Why now:** ask-user and send-to-origin are almost tailor-made for a phone/voice front-end. High
strategic fit for us.

---

## Priority 3 (P2) — Artifacts + "Shipped"  (feature project, not a quick pick)

**What it is.** The biggest *new capability*.
- **Artifacts:** agent output (image / video / **HTML**) becomes viewable/refreshable/deletable cards
  with a gallery + full-page viewer. **Live HTML artifacts**: publish self-contained HTML under a
  stable id; re-publishing the same id updates in place with a version badge; renders in a locked-down
  sandboxed iframe (`sandbox allow-scripts; default-src 'none'; img-src data:`). An artifact can carry
  a **server-side refresh script** LFG runs on a timer — so a "live dashboard" is just an agent
  re-publishing one artifact.
- **Shipped:** a showcase feed. On finishing work an agent posts a card (title + summary + media);
  images auto-optimized to webp; re-posting the same id shows "updated · v2".

**Files.** Backend (~2k lines, cleanly separable): `src/artifacts.ts`, `src/artifact-previews.ts`,
`src/artifact-refresh.ts`, `src/shipped.ts`, indexing helpers in `src/transcript-index.ts`, routes in
`serve.ts`, MCP tools in `src/commands/mcp.ts`. **Web UI lives inside `web/src/App.tsx`** (ArtifactViewer,
ShippedPage, ShipMedia) — our collision/divergence file.
**New deps:** `sharp` (image optimization). Needs the SQLite transcript table.

**Collision with our fork.** Backend is safe to bring across; the **front-end is the real work**
because it sits in the `App.tsx` we've diverged on — likely rebuild in our own shell rather than merge.

**Effort: Medium–High.** Treat as a deliberate feature project after P0/P1 land.

---

## Sequencing & risks

1. **P0 first.** Cherry-pick `20e85f0` → `ae03092` (→ optionally `170303c`, `d981e20`), resolve the
   `serve.ts` dispatch hunks, `bun install`, smoke-test create → turn → interrupt → resume.
2. **P1 next.** Bring `ask/`, `origin-deliveries`, `lfg-capabilities`, and the MCP tools; wire the
   notification + MCP-registration steps to our setup.
3. **P2 as a scoped project.** Backend first (verifiable headlessly), UI in our own shell.

**Risks / watch-items:**
- `serve.ts` is the recurring conflict point on every pick — hunks are small (route/dispatch
  registration) but touch a file we also edit. Consider the dispatch-map refactor early to reduce churn.
- `App.tsx`: do **not** try to merge upstream's rewrite. Keep ours; port features deliberately.
- Voice: upstream's provider work overlaps our own stack (`src/voice-providers.ts`) — decide per-feature
  which to keep; default to ours.
- Re-verify all hashes/line numbers against a fresh `git fetch` before implementing.

## Suggested first action

Prototype P0 on a throwaway branch off our `main`:
```
git fetch https://github.com/BennyKok/lfg.git main
git checkout -b spike/upstream-agent-engine main
git cherry-pick 20e85f0 ae03092     # resolve serve.ts / package.json, then bun install
```
Report exactly what conflicts, then decide scope for the real branch.

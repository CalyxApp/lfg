# Upstream Adoption Plan — pulling BennyKok/lfg features into CalyxApp/lfg

> **Priority: HIGH.** Status: **spikes 1+2 complete — P0 execution in progress** (branch
> `upstream/p0-engine-lift`).
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

## ✅ Spike 2 (2026-07-23) — full engine lift driven to typecheck; surface is MAPPED

I did the actual subsystem lift on a throwaway branch and ran `tsc --noEmit` to find the real
integration surface. **Result: the blast radius converges to essentially ONE file (`serve.ts`).**

**What I lifted (all `ours: 0` — we never touched any of them, so "take upstream's version" is
conflict-free):** ~25 files. `bun install` of the 4 SDK deps was clean. The dependency closure is:
- **Engine (13):** `agents/backends/{aisdk,codex-aisdk,opencode-aisdk,pi}-session.ts`, `draft.ts`,
  `agent-profile.ts`, `aisdk-registry.ts`, `sessions.ts`, `transcript-index.ts`, `coding-agents.ts`,
  `coding-agent-adapters.ts`, `agent-catalog.ts`, `tmux.ts`
- **Transitive ring (8):** `managed.ts`, `lfg-capabilities.ts`, `model-discovery.ts`, `resume-cache.ts`,
  `trace-log.ts`, `artifacts.ts`, `settings.ts`, `session-cache.ts`
- **Non-serve callers of the changed API (4):** `actions/index.ts`, `commands/whatsapp.ts`, `sendq.ts`,
  `commands/agents.ts` — also `ours: 0`, take upstream's.

**Notable coupling discovery:** lifting the engine **pulls in `artifacts.ts` (a P2 file)** because the
new `transcript-index.ts` imports it. So P0 and P2 are coupled through the new transcript index — you
can't take the modern engine without at least the artifacts *module* (the UI is still separate).
Similarly, **`lfg-capabilities.ts` (a P1 file) rides along in the transitive ring** — when scoping P1,
its module is already present after P0; P1's remaining work is the MCP tools + wiring, not this file.

**Residual typecheck errors after the lift — the actual work, and it's tiny + localized:**
1. **`src/commands/serve.ts` (~12 errors) — THE reconciliation, and it's ours.** Upstream *deleted*
   the old transcript-read helpers (`recentMessages`, `recentMessagesCached`, `warmRecentMessages`,
   `messagePage` — 0 occurrences left upstream; `searchTranscript` relocated) as part of the
   direct-indexing rewrite. Our `serve.ts` still imports them from `sessions.ts`. So this is a small
   **API migration** (map ~5 old transcript calls onto the new transcript API), plus a couple of
   `HtmlMessage` typing fixes — **on top of** re-applying our own 5 commits of added routes.
2. **`src/session-brain/*` — upstream deleted this whole subsystem.** Our `runner.ts` uses the removed
   API. We never modified it (`ours: 0`), so follow upstream and **delete session-brain** (or adapt if
   we still want it). Trivial.
3. **`src/commands/agents.ts` — one union touch-up** (`AutoAgentBackend` vs `grok`). One line.

### Bottom line
The subsystem lift is **real but bounded and low-risk**: ~25 files adopted wholesale with **zero
conflicts against our work**, and the *entire* manual reconciliation collapses to (a) a small
transcript-API migration in `serve.ts` where our routes also live, (b) deleting `session-brain`,
(c) one union fix. No sprawling merge. **Revised effort: Medium, concentrated almost entirely in
`serve.ts`.** The spike branch was discarded (findings captured here); reproduce via the recipe below.

---

## ⚠️ Spike 1 results (2026-07-23) — P0 strategy corrected

I ran the suggested P0 spike (`git cherry-pick 20e85f0 ae03092` on a throwaway branch off
`main`). **The naive cherry-pick does NOT work — but for a reassuring reason.** Findings:

1. **Cherry-picking individual commits conflicts.** `20e85f0` conflicted on
   `codex-aisdk-session.ts` and `opencode-aisdk-session.ts`. Cause: those files **already
   existed at our fork base** and upstream evolved them across a *chain* of commits (codex: 7,
   opencode: 5). A single cherry-pick applies one commit's diff onto a baseline that has moved,
   so the context doesn't match. This is a sequencing artifact, **not** a conflict with our work.

2. **We have made ZERO changes to the entire agent-engine subsystem.** Across all core files —
   `aisdk-session.ts`, `codex-aisdk-session.ts`, `opencode-aisdk-session.ts`, `draft.ts`,
   `aisdk-registry.ts`, `sessions.ts`, `transcript-index.ts`, `coding-agents.ts`,
   `coding-agent-adapters.ts`, `agent-catalog.ts`, `tmux.ts` — **our fork = 0 commits**, while
   upstream changed them a lot (`sessions.ts` 25, `transcript-index.ts` 20, `tmux.ts` 16,
   `agent-catalog.ts` 12, `coding-agents.ts` 11…). **So there are no true semantic conflicts
   with our own code here.** Every conflict is just "we're behind upstream on files we never edited."

3. **Taking upstream's final file versions wholesale is clean** (valid precisely because we have
   no local changes to them). I did this for the 5 backend files + `agent-profile.ts` with zero
   conflicts. The only genuinely *missing* module our fork lacks is **`src/agent-profile.ts`**
   (one small new file — grab it too). Everything else the harnesses import already exists.

4. **New npm deps required (all absent in our fork):**
   `@anthropic-ai/claude-agent-sdk ^0.3.205`, `@openai/codex-sdk 0.144.1`,
   `@opencode-ai/sdk ^1.17.7`, `@mariozechner/pi-coding-agent 0.73.1` (last one only if we take pi).

### Corrected P0 strategy: **subsystem lift, not commit cherry-pick**

Because we've never touched this subsystem, don't fight `git cherry-pick`. Instead:

- **Take upstream's final versions of the whole engine cluster wholesale** (`git checkout 8c86d77 -- <files>`):
  the 5 backends + `agent-profile.ts`, and — because the harnesses call into them and upstream
  rewrote them heavily — likely also `aisdk-registry.ts`, `sessions.ts`, `transcript-index.ts`,
  `coding-agents.ts`, `coding-agent-adapters.ts`, `agent-catalog.ts`, `tmux.ts`. All are 0-local-change,
  so "take theirs" is safe *content-wise*.
- **The one real integration seam is `src/commands/serve.ts`** — the only engine-adjacent file we
  *both* changed (upstream +2427/−470, us +358). This is where our routes meet their engine. Budget
  the real effort here: reconcile our added routes against their rewritten dispatch by hand.
- **Ripple risk:** `sessions.ts` (25 upstream commits) and `tmux.ts` (16) are central files called
  widely; lifting them may pull adjustments in other callers. Do it on a branch and let the
  typechecker/tests drive the fixups.

**Revised effort: Medium** (not Low) — dominated by the `serve.ts` reconciliation and the
`sessions.ts`/`tmux.ts` ripple. Still low *risk*, because none of it competes with our own changes.

### ~~Corrected first action~~ (superseded)

> The file list below was Spike 1's best guess; **Spike 2 mapped the true dependency closure
> (~25 files, including the transitive ring). Use the canonical execution recipe at the bottom
> of this doc instead.**

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

**Upstream commits (reference only — do NOT cherry-pick; Spike 1 proved single-commit picks
conflict on files upstream evolved across chains. Use the subsystem-lift recipe instead):**
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

### ✅ P1 executed (2026-07-23, branch `upstream/p0-engine-lift`)

Much smaller than scoped — **most of P1 rode in with P0** (`lfg-capabilities.ts`, `tmux.ts`
contract injection, and the whole MCP registration/doctor layer inside `coding-agents.ts` were in
the P0 transitive ring; the fork already had `src/ask/` + `/api/ask` + `/api/voice/consult` from
its own earlier work). What remained:
- **Lifted** (`ours: 0` / new): `ask/store.ts` (+`pushback` field), `commands/mcp.ts` (+test,
  23 tools), `origin-deliveries.ts` (+test).
- **Wired**: `cli.ts` `mcp` case; `serve.ts` — ask `pushback` fire-and-forget + verbatim
  steer-injection on answer, `/api/sessions/reparent`, origin-deliveries GET/POST
  (owner-scoped via `x-lfg-session-id`), and an honest `/api/shipped` **501 stub**
  (Shipped is P2; GET returns an empty feed so clients don't break).
- **Verified live**: tsc clean; both lifted test files pass (6/6); `lfg mcp` serves all 23 tools
  over stdio; full pushback loop on a real haiku session (ask → instant id → answer → injected
  as steer → agent acted on it) ; origin-delivery 403-without-owner-header + create/list
  roundtrip; shipped stub responses.
- **Not done (deliberate)**: registering the LFG MCP server into each agent CLI's config on this
  box (`claude mcp add lfg …` etc.) — that's per-machine setup, not repo code; the doctor
  output in `lfg agents doctor` shows the exact commands. And the "notify me" step already
  rides our existing push path (`notifyAll`).

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

## ✅ P2 executed + test deployment (2026-07-23, branch `upstream/p0-engine-lift`)

**P2 backend** — lifted `shipped.ts`, `artifact-previews.ts`, `artifact-refresh.ts` (+4 test
files, 28/28 pass), added `sharp`; ported the full artifact route cluster into our `serve.ts`
(gallery, file serving with webp previews / sandboxed live-HTML CSP / byte-range video,
owner-scoped delete, publish image/video/html, refresh config + refresh-now, real
`/api/shipped`). Note: `POST /api/shipped` with an `id` only *updates* an existing post —
omit `id` to create.

**P2 UI** — built in our own shell (no `App.tsx` merge, as planned): new `ArtifactsView` +
`ShippedView` components, routable as `#artifacts` / `#shipped`, in the desktop icon tabs and
the mobile "Also under Agents" chips. Session-brain *entry points* removed (chips, Settings
row); the dead deep plumbing (swipe-to-brain, `SessionBrainView`) is unreachable and left for
a dedicated cleanup pass.

**Deployment (test, parallel to production)** — this box:
- Checkout: `/home/openclaw/lfg-next` (clone of the branch; `.env` copied from
  `lfg-fork` with `LFG_PORT=8768`). Gotcha: systemd reads `EnvironmentFile` *after*
  `Environment=`, so the port lives in `.env`, not the unit.
- Service: `systemd --user` unit `lfg-next.service` (enabled; mirror of `lfg-fork.service`).
- URL: **https://chiron-server.tail5226b1.ts.net:8446** (tailscale serve → 127.0.0.1:8768;
  added via passwordless `sudo tailscale serve --bg --https 8446 …`).
- Production (`lfg-fork.service`, :8444/:8445 → 8767) untouched. Both instances share the
  tmux server + transcript discovery, so the fleet is visible from both; data dirs
  (asks, artifacts, shipped, titles) are per-checkout.
- Seeded: one live HTML artifact ("Adoption build status") + one Shipped post, so the new
  views render real content on first open.

## Sequencing & risks

1. **P0 first.** Subsystem lift per the canonical recipe below (NOT cherry-picks — see Spike 1),
   reconcile `serve.ts`, `bun install`, smoke-test create → turn → interrupt → resume.
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

## Canonical P0 execution recipe (from Spike 2's mapped closure)

> Supersedes the cherry-pick prototype originally suggested here (Spike 1 proved cherry-picking
> fails on sequencing artifacts) and Spike 1's shorter file list (missing the transitive ring).

```
git fetch https://github.com/BennyKok/lfg.git main          # verify tip is still 8c86d77
git checkout -b upstream/p0-engine-lift main

# 1. Wholesale lift — all files are ours:0, so "take theirs" is conflict-free:
git checkout FETCH_HEAD -- \
    src/agents/backends/aisdk-session.ts src/agents/backends/codex-aisdk-session.ts \
    src/agents/backends/opencode-aisdk-session.ts src/agents/backends/pi-session.ts \
    src/agents/backends/draft.ts src/agent-profile.ts \
    src/aisdk-registry.ts src/sessions.ts src/transcript-index.ts \
    src/coding-agents.ts src/coding-agent-adapters.ts src/agent-catalog.ts src/tmux.ts \
    src/managed.ts src/lfg-capabilities.ts src/model-discovery.ts src/resume-cache.ts \
    src/trace-log.ts src/artifacts.ts src/settings.ts src/session-cache.ts \
    src/actions/index.ts src/commands/whatsapp.ts src/sendq.ts src/commands/agents.ts \
    src/auto/store.ts

# 2. Deps: add @anthropic-ai/claude-agent-sdk ^0.3.205, @openai/codex-sdk 0.144.1,
#    @opencode-ai/sdk ^1.17.7, @mariozechner/pi-coding-agent 0.73.1; then bun install.

# 3. Delete src/session-brain/ (upstream removed it; we never modified it).

# 4. Typecheck (no `typecheck` script in our package.json — run tsc directly):
#      bunx tsc --noEmit
#    Expected residual errors, all local:
#      - serve.ts: migrate ~5 old transcript-read calls (recentMessages, messagePage, …)
#        onto the new transcript-index API + HtmlMessage typing fixes,
#        while KEEPING our own added routes.
#      - commands/agents.ts should be clean (lifted); if a union error appears
#        (AutoAgentBackend vs grok), it's a one-line fix.

# 5. Smoke-test: create session → send turn → interrupt → resume.
```

### ✅ P0 executed (2026-07-23, branch `upstream/p0-engine-lift`)

Ran exactly as mapped. Deltas vs Spike 2, for the record:
- **`src/auto/store.ts` also belongs in the closure** (ours: 0): upstream widened
  `AutoAgentBackend` with `grok`/`cursor`; without it the lifted `commands/agents.ts`
  fails the union check. Added to the recipe above.
- The predicted `HtmlMessage` errors were **cascades** from the unresolved old imports —
  they vanished once the ~10 call sites migrated to `indexedMessagePage`/`indexedRecentMessages`
  (the new API needs `(path, sessionId)`; every site already had a session id in scope).
- `/api/sessions` warming: `warmRecentMessages` → `warmTranscriptIndexes(sessions)`.
- session-brain: routes + scheduler wiring removed from `serve.ts`. The web Brain panel
  polls with `.catch(() => {})` so it degrades silently — **follow-up: remove the Brain UI
  section from our shell.**
- Verified: `tsc --noEmit` clean; server boots; `/api/sessions`, `/messages`,
  `/transcript/search` all serve real data off the new SQLite index path.
- **Live smoke passed** (real haiku session on this box): create → turn (streamed reply) →
  long turn → **native interrupt** (busy→idle, output cut) → follow-up turn answered on the
  **same persistent session** → close. The disconnect/reconnect flavor of managed resume
  (`/api/sessions/resume`) is still unexercised but rides the same registry path.

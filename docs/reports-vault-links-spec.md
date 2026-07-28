# Spec — Vault links in reports (mobile)

Tap a vault reference inside a report and open that file **in the mobile app**,
with correct back-navigation. This mirrors the Calyx **desktop app** (the VS Code
fork), so users carry the same expectations across platforms.

Two separate products:
- **Desktop app** = Calyx VS Code fork (`repos/mdEditorTestExtenstionVscode`),
  with cloud sync etc. Reference for *behavior*.
- **Mobile app** = this LFG PWA (`lfg-fork`, `web/src`). Where we build.

Reuse principle: **reuse the platform code where it counts** (link recognition /
chip affordance / shared report model). Rendering + navigation *plumbing* may
differ per platform — that's expected.

---

## Current state

Reports are already live in the mobile app (Home "Today's reports" section +
Reports screen via the "Also under Agents" hub, `/api/calyx-reports`). Reports are
self-contained HTML in `~/.openclaw/workspace/reports/*.html` with `chiron:*`
meta tags; they render in the shared full-screen `HtmlViewerOverlay`
(sandboxed iframe, `allow-scripts`).

---

## The decisive constraint

The files reports link to (`tasks/…`, `projects/…`) live in the reports **vault**
`~/.openclaw/workspace`. The app's file endpoints (`/api/repos/file`,
`/api/repos/raw`) are **repo-scoped** to `LFG_REPOS_ROOT=~/repos`. The vault is a
git repo but sits **outside** that root and is **not registered**, so those
endpoints 404 on vault paths. (`PlatosRaveCave` is a *different* dir under
`~/repos`, not the vault.)

**Decision (Sam):** users expect to browse their **whole workspace**. So in
Phase 2 we **register `~/.openclaw/workspace` as a repo** — the report link then
opens through the *same* `/api/repos/file` + `FilesView` pipeline as everything
else (max reuse, identical behavior), and the vault becomes browsable in Files.

---

## Reuse from the desktop (where it counts)

The desktop's `webui .../reports/ReportViewer.tsx` turns `<code>projects/foo/</code>`
spans into Notion-style **mention chips** via pure helpers: `linkifyVaultPaths`,
`RELATIVE_PATH`, `prettifyName`, `CHIP_STYLES`, `CHIP_ICON`. These have zero VS
Code deps and are ported **verbatim** so the mobile chips look/detect identically.

Difference by necessity: the desktop post-processes the report DOM in React (its
iframe is `sandbox=allow-same-origin`). Our iframe is `allow-scripts` (cross-origin),
so we apply the same transform to the HTML **at serve time** and inject a small
click-forwarder that `postMessage`s the tapped path to the app.

---

## Phases

### Phase 1 — chips + tap events  ✅ DONE
- `src/reports.ts`: `renderReportHtml(html)` = `linkifyVaultPaths` (ported, +
  `data-vault-path` so the path survives) → inject `CHIP_STYLES` → inject the
  click-forwarder script. Applied in the `GET /api/calyx-reports/:id` route.
- Result: all reports render the **same chips as the desktop**, and a tap emits
  `postMessage({ type: "calyx-open-vault", path })`. Commands (`calyx list …`,
  has spaces) and non-paths are left untouched, matching the desktop regex.
- No frontend / navigation changes; nothing listens for the message yet.

### Phase 2 — open the file
- Register the workspace vault as a repo (custom-repo store or `LFG_REPOS_ROOT`
  handling) so `/api/repos/file` (md → JSON, rendered by `MarkdownDoc`/`streamdown`)
  and `/api/repos/raw` (html → `HtmlViewerOverlay`) resolve `tasks/…`,`projects/…`.
- App-level `message` listener (verify `event.source === iframe.contentWindow`,
  the pattern `ArtifactsView` uses) receives `calyx-open-vault` → opens the file
  using the **existing** viewer components (reuse, so it matches the Files tab).
- Markdown currently renders *inline* in the Files pane; extract a read-only
  full-screen variant of `MarkdownDoc` for the overlay case.

### Phase 3 — back-navigation (the hard part)
Desired stack: `tab` (routed) → report overlay → file overlay. One "back" pops
one layer.

Today: router is **`replaceState`-only** ("no history-stack games"); **no
`pushState`/`popstate`/`beforeunload`**; overlays are pure local state closed
only by X/Escape and are **invisible to history**; **nothing intercepts phone
hardware/gesture back**; no `@capacitor/app` back handler. Two stacked
`HtmlViewerOverlay`s both listen for Escape (would both close).

Plan:
1. **Centralized overlay stack** (App-level or a small nav context): an array of
   overlays; only the **topmost** handles Escape/back (fixes the double-close).
2. **History integration**: `pushState` a marker per overlay open; one `popstate`
   handler pops the top overlay instead of changing tab; explicit close calls
   `history.back()` to stay in sync. Tabs keep `replaceState`.
3. **iOS native back** (Capacitor shell) needs `@capacitor/app` + a `backButton`
   listener — that requires a **native rebuild + reinstall**, so it's a Phase 3b
   follow-up; the web/`popstate` path covers the installed PWA first.

This overlay-stack is **not** report-specific — it upgrades every overlay
(files, artifacts, diffs) to real, gesture-friendly back.

---

## Security / edges
- Vault endpoints: path-traversal guard + extension allowlist; `sandbox` for any
  linked HTML (no more privilege than a report).
- Dead links / unsupported types (`.canvas`, `.pdf`, images): graceful fallback
  (toast + "open in browser" / inline message).
- Nesting depth: start with report → one file; the stack supports N-deep later.

## Known cosmetic follow-up (pre-existing, not Phase 1)
Reports with wide multi-column tables overflow horizontally on a phone (their own
`max-width:1120px` CSS). Consider a mobile-friendly report stylesheet later.

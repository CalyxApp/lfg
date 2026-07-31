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

Reports are live in the mobile app (Home "Today's reports" section + Reports
screen via the "Also under Agents" hub, `/api/calyx-reports`). Reports are
self-contained HTML with meta tags — `calyx:*` (product) or the older `chiron:*`
codename, both parsed — rendered in the shared full-screen `HtmlViewerOverlay`
(sandboxed iframe, `allow-scripts`).

**Source = the primary repo.** `reports.ts` resolves `<reposRoot>/<primary>/reports`
where `primary` defaults to **PlatosRaveCave** (env: `CALYX_PRIMARY_REPO`, else
`CONVERSE_WORKSPACE`, else `PlatosRaveCave`; `LFG_REPORTS_DIR` overrides the path).

> History: this initially (wrongly) read `~/.openclaw/workspace/reports` — a
> *separate, older* vault (using `chiron:`) that isn't registered in the app and
> that the user doesn't browse. Corrected to PlatosRaveCave, the canonical vault.

---

## The primary-repo model (Sam)

LFG can operate across many repos (agents do dev work in various folders), but
there is one **primary/main repo** — **PlatosRaveCave**:
- **Writes default here** (new file / new task).
- **Reports live here.**
- Other registered repos stay **accessible** for agent work (reads/edits), just
  not the default write target.

**Consequence for vault links:** PlatosRaveCave is **already a registered repo**
(`~/repos/PlatosRaveCave`, listed in `/api/repos`, selectable in the app). So a
tapped link resolves through the **existing** `/api/repos/file` (md) + `/api/repos/raw`
(html) endpoints with `repo=PlatosRaveCave` — **no new repo registration needed**
(an earlier draft of this doc wrongly called for that, based on the wrong vault).

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

### Phase 2 — open the file  ✅ DONE
- `reports.ts`: each ReportItem now carries `repo` (= `primaryRepoName()`), so the
  client knows where to resolve links.
- `ReportOverlay.tsx` (new): wraps the report `HtmlViewerOverlay`, listens for the
  `calyx-open-vault` message, and stacks a `VaultFileOverlay` on top. Passes
  `escEnabled={!vaultPath}` so only the topmost overlay handles Escape (fixes the
  double-close). Used by both `ReportsView` and `HomeView`.
- `VaultFileOverlay.tsx` (new): resolves the path against `repo` (PlatosRaveCave)
  via the **existing** endpoints — `/api/repos/file` → `<Streamdown>` for markdown
  (same renderer as the Files tab), `/api/repos/raw` → `HtmlViewerOverlay` for html,
  inline for image/pdf, `<pre>` for other text. A bare `projects/foo` path resolves
  to `projects/foo/index.md` (Calyx folder convention). Graceful error on miss.
- `HtmlViewerOverlay.tsx`: added `escEnabled` prop (default true).
- Back-stack (this phase, via the in-app buttons): list → report → file → back →
  report → back → list, verified. Phone hardware/gesture back is still Phase 3.

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

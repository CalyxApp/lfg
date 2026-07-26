# Note & file creation on mobile — gaps and where to take it

> Status: **idea / exploration** (2026-07-26). Captured by Sam via lfg.
> This is a design note, not a committed plan. It maps what the lfg PWA does
> today for creating and reopening notes, names the gaps, and sketches a
> direction that borrows from Notion mobile and reuses the Calyx extension's
> already-shipped template machinery.

## The job to be done

> "If I have an idea or want to quickly save something, I can open a file,
> create it, choose the type it belongs to (if relevant) — and do the classic
> things one wants from an editor. I also want to open things I've opened
> before and write well on them."

Two intents, one surface:

1. **Capture** — get a thought down fast, minimal friction, sort it later.
2. **Compose** — deliberately start (or reopen) a note of a known *kind* and
   write on it well.

Today the PWA leans hard on (1) and barely supports (2).

## What exists today

Three **disconnected** creation entry points, none of which lets you pick a
type or a template:

| Surface | File | What it does | Ceiling |
|---|---|---|---|
| **Quick Capture** (＋ tab) | `web/src/components/CaptureView.tsx` | Title (optional) + body + dictation mic → writes `inbox/YYYY-MM-DD-HHMM-slug.md`, auto-commits, remembers last repo | Hardcodes `type: note`; always files to `inbox/`; no tags/properties; no template |
| **Files "+"** | `web/src/components/FilesView.tsx` (`createNote`) | Inline filename box in the current dir; if `.md`, scaffolds bare `---\ntype: note\n---`; then raw-textarea edit → save→commit | Hardcodes `type: note`; no title/frontmatter form; editing is raw text over the whole file (frontmatter included) |
| **New Task** drawer | `web/src/components/CreateTaskDrawer.tsx` | Bottom sheet: title + priority + due → Calyx CLI `createContent()` → `tasks/` | Task-only; the only *typed* creation the UI exposes, and it's a bespoke one-off |

### The capability that's already there but hidden

The backend **already supports typed creation** — it's just not wired to the
manual UI:

- `src/vault-tools.ts` → `createNote({ type, title, properties, body })`
  builds frontmatter and files the note into the folder where notes of that
  type *already live* (`folderForType` learns from the existing vault), then
  commits. **But this is exposed only to the voice/converse agent** (the
  `create` tool), never to a human tapping "new note."
- `src/vault-tools.ts` → `describe_vault` already returns the vault's **types +
  counts** and, per type, the **fields** inferred from existing notes. That is
  a ready-made basis for "types as templates."
- `web/src/note-meta-editor.tsx` (`NoteMetaEditor`) is a generic title + tags +
  arbitrary-properties editor — but it's wired **only** to the Converse
  save-review step, not to manual creation.

So the pieces for "create a typed note with the right fields" exist; they're
scattered and only the agent can reach the good one.

## Gaps

1. **No type choice at creation.** Capture and Files both force `type: note`.
   The one place you can pick a type is the Task drawer, and it's task-only.
2. **No templates.** No "new from template." A type should imply a starter
   shape (frontmatter fields + a body skeleton). Sam's framing: *templates are
   types, initially.*
3. **No properties/tags at creation.** `NoteMetaEditor` exists but isn't on the
   creation path — you can't set fields when you make the note, only later by
   hand-editing raw frontmatter.
4. **No "recents / continue writing."** The explicit second intent — *reopen
   what I opened before and write on it* — has no support. Navigation is
   tree-only, per repo. No recents, no pinned/favorites, no jump-back-in.
5. **Editing is raw text.** `FilesView` edits the whole markdown file (including
   frontmatter) in a plain `<Textarea>`. Fine for capture, poor for composing.
6. **Three creation flows, inconsistent.** Capture ＋, Files +, and the Task
   drawer don't share a model. A single "New" flow (kind → template →
   destination) would unify them.
7. **Destination is implicit and unchangeable.** Capture → always `inbox/`;
   Files → current dir; typed `createNote` → learned folder. The user never
   chooses where it lands.

## Types-as-templates — and the extension already did this

Sam's instinct ("those templates would be types initially") **matches the Calyx
VS Code extension's existing model exactly.** From the extension repo
(`mdEditorTestExtenstionVscode`):

- Templates there are **type-specific by design** — each content type owns one
  template. This is **already shipped and load-bearing**, not a plan:
  - `src/content-types/ContentCreationService.ts` — `createContent(type, title,
    customFields)` renders the type's authored template body via
    `TemplateEngine`, writes any `additionalFiles` (folder types), and merges
    frontmatter.
  - `src/content-types/TemplateEngine.ts` — `{{title}}`, `{{date}}`, `{{now}}`,
    custom field vars. This is the shared substitution engine.
  - `src/content-types/UserDefinedTypes.ts` — a type carries
    `template_type: 'file' | 'folder'` and a `template` (content + fields +
    variables). Authored visually via the **shipped** Template Editor
    (`docs/tracking/features/template-editor/`).
- **Storage:** `.chiron/content-types/` (template files +
  `user-defined-types.json`), with a *proposed* move to a visible `templates/`
  root folder.
- **Still planned (not built) in the extension:**
  - **Multiple templates per type + a picker** — `templates-system`
    (`docs/tracking/features/templates-system/`, marked possibly stale) via a
    `createsType` manifest so a type can have several templates and a QuickPick
    chooses.
  - **Calyx-native create modal** replacing native Cmd+N —
    `docs/tracking/features/new-content-modal/` (type selector + fields, high
    priority).
  - **Notion-style template gallery** — the consolidated direction,
    `docs/tracking/features/calyx-pages/` §B3 ("template library").

**Implication for lfg:** the mobile app should not invent its own template
format. The vault is the source of truth and the extension already renders
type templates on write. The mobile flow should either (a) call the same
vault-side creation path so a note gets the type's template for free, or (b) at
minimum read `describe_vault` to offer the type's known fields at creation.
Whatever we build should stay forward-compatible with the extension's
`.chiron/content-types/` templates and the future `templates/` folder — mobile
picks a type/template, the vault owns what that means.

## Learning from Notion mobile

The recurring pattern (see sources): Notion mobile's weakness is that "open app
→ new page → wait to load" isn't actually quick, so people bolt on quick-capture
tools. Takeaways for us:

- **Two-speed model.** Keep a genuinely instant capture (our ＋ tab is already
  good — dictation, one tap, lands in `inbox/`) *and* a deliberate "compose"
  path. Don't make capture pay the cost of the type/template picker; make it an
  optional step, or a second button.
- **Capture-to-inbox, organize later.** Our `inbox/` default is the right
  instinct; add a lightweight "triage inbox" (assign type/destination after the
  fact) instead of forcing decisions up front.
- **Template as a first-class starting point.** A "New" affordance that opens a
  small gallery of types/templates (Task, Project, Note, Essay…) — mirrors
  Notion's template picker and the extension's per-type templates.
- **Custom properties at creation**, editable inline — we already have
  `NoteMetaEditor`; put it on the path.
- **Home-screen widget / share-sheet capture** is Notion's power-move on mobile;
  worth noting as a future capacitor/PWA capability (the app is already a
  Capacitor iOS shell — `web/capacitor.config.ts`).

## Sketch of a direction (for later, not committing here)

1. **One "New" sheet** replacing the three ad-hoc flows: pick a **kind**
   (from `describe_vault` types + a plain Note), then optionally a **template**
   (once the vault has more than one per type), title, and a compact
   properties form (`NoteMetaEditor`). Destination defaults to the type's
   learned folder but is overridable.
2. **Wire manual creation to `createNote`** (the typed, self-filing backend
   path) instead of the hardcoded `type: note` writes — or, better, to a shared
   vault-side creation endpoint that also applies the type's template so mobile
   and the extension agree byte-for-byte.
3. **Keep instant capture instant.** ＋ tab stays one-tap-to-`inbox`; the type
   picker is opt-in (e.g. a "…" on the capture screen), not a gate.
4. **Add "Recents / Continue writing"** — a list of recently opened/edited
   notes on Home (or the top of Files), so reopening to "write well on it" is
   one tap. Likely a small server-side or localStorage recent-paths list.
5. **Better compose editing** — at least a structured frontmatter panel
   separated from the body (stop editing YAML by hand in a textarea); a
   markdown-aware editor is a bigger, later step.

## Open questions

- Does mobile create through its **own** endpoint (fast, but re-implements
  template rendering) or call a **shared vault creation service** so the
  extension's type templates apply automatically? Prefer the latter to avoid a
  second, drifting template engine.
- Where do templates live for the vault the phone is editing — `.chiron/…`
  (current) vs the proposed visible `templates/` folder? Track the extension's
  decision rather than pre-empt it.
- Recents: server-tracked (works across devices) vs local (simpler)?
- How much of the "compose" editor do we build on mobile vs defer to desktop?

## Cross-references

- Extension template system (shipped): `mdEditorTestExtenstionVscode/src/content-types/{ContentCreationService,TemplateEngine,UserDefinedTypes}.ts`
- Extension plans: `docs/tracking/features/{template-editor,templates-system,new-content-modal,calyx-pages}/`
- lfg backend typed creation: `src/vault-tools.ts` (`createNote`, `describe_vault`, `createProject`)
- lfg UI surfaces: `web/src/components/{CaptureView,FilesView,VaultView,CreateTaskDrawer}.tsx`, `web/src/note-meta-editor.tsx`

Sources on Notion mobile capture patterns:
- https://matthiasfrank.de/en/notion-quick-capture/
- https://super.so/blog/how-to-create-quick-capture-notion
- https://thesweetsetup.com/notion-quick-capture-hacks/

# Converse — universal conversation view (Phase 4), Rev 1

Branch: `converse-voice-rt-improvements` → merged to `main`. 2026-07-30.
**Status: shipped & verified** — store round-trips (save→list→get) with tool calls
preserved; viewer opens via the History button in the Converse header.

A read-only page to browse and re-read every past Converse conversation (voice or
typed). The point of this rev is **not** the UI — it's building it so the storage
underneath can be reworked later (local file → synced cross-device store) **without
touching the UI**, because the shape of that "universal" store is still undecided.

## Why this way (the seam)

Sam: "would Phase 4 be done in a way it'd be easier to rework later?" Yes — by putting
a **stable API contract + a storage adapter** between the viewer and wherever the data
actually lives. Three deliberate decisions:

1. **The UI only knows an API, never the storage format.** The viewer calls
   `GET /api/converse/conversations` (list) and `GET /api/converse/conversations/:id`
   (one), which return a **normalized shape**. Swap the backing store later and the
   viewer is untouched.

2. **A single storage adapter** (`src/converse-store.ts`) is the only code that knows
   where records live. Today it reads/writes `data/converse-conversations/<id>.json`
   (local, durable on disk, git-ignored). Tomorrow it can front a real DB or a synced
   service — same three functions (`save`, `listSummaries`, `get`), same output shape.
   This is the one seam we rework; nothing else moves.

3. **Structured records, not the lossy markdown.** Auto-save already writes a human
   markdown note to the vault (nice export), but that drops tool calls and images. So
   we *also* persist a **structured record** (id, title, date, model, `turns[]` with
   role/text/tool-call/attachments) — the machine-readable source the viewer renders
   richly. The markdown note stays as the pretty vault copy; the JSON record is the
   source of truth for the view. This is what makes the view faithful *and* the store
   evolvable.

Plus: **reuse the render components.** The per-turn rendering is extracted into a
shared `<ConversationTurns>` used by BOTH the live Converse thread and the history
viewer, so they can't drift and improvements land in both.

## The contract (normalized shape)

```
ConversationTurn   = { role: "you"|"assistant"|"tool"|"system", text, tool?, images?, files? }
ConversationRecord = { id, title, date, model?, durationMs?, createdAt, turns: ConversationTurn[] }
ConversationSummary= { id, title, date, model?, createdAt, turnCount }   // list rows
```

## Pieces

- **`src/converse-store.ts`** — the adapter: `saveConversationRecord`,
  `listConversationSummaries`, `getConversationRecord`, over `data/converse-conversations/`.
- **serve.ts routes** — `POST /api/converse/conversations` (save),
  `GET /api/converse/conversations` (list), `GET /api/converse/conversations/:id` (one).
- **`web/src/components/conversation-turns.tsx`** — shared per-turn renderer (reuses
  `ToolCard`, image/file chips, markdown); used by the live thread and the viewer.
- **`web/src/conversation-history.tsx`** — the viewer overlay (list → open → read).
- **converse.tsx** — on close, also POST a structured record; a History button in the
  header opens the viewer.

## Explicit non-goals for this rev (so they're easy to add later)
- **No cross-device sync yet.** Records are local. The adapter is the swap point when
  we decide what sync looks like.
- **Read-only.** No edit/delete/resume from the viewer yet — but stable IDs are in
  place so those slot in.
- **Images are stored inline (base64) in the record** for v1 simplicity; if records get
  heavy we move image bytes behind a ref in the adapter (UI unaffected).

## Rollback
Additive: a new store module, three new routes, two new components, and small
converse.tsx wiring. The prior live commit is the rollback point.

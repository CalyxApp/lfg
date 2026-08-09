# Bug: session composer is frozen at one line + drafts are lost on dismiss

Reported by Sam (mobile PWA), 2026-08-09. Two related problems with the agent-session
message composer (the `Message` box with the paperclip / mic / send buttons).

## Symptom 1 — the box never grows; you can't see long / dictated text

Voice-to-text (and plain typing/pasting) drops the transcript into the composer, but the box
**does not change shape**. You get a single visible line and have to scrub a 44px-tall field to
read back what was transcribed. Confirmed in the reporter's screenshot: the composer shows ~1.5
lines of a long message, clipped.

### Root cause

`web/src/App.tsx`, the `SessionChat` composer (~line 6694). The textarea className hard-clamps it:

```
h-11 min-h-11 max-h-11 ... overflow-y-auto ... [field-sizing:fixed]  (md: h-9 min-h-9 max-h-9)
```

- `h-11 / min-h-11 / max-h-11` pin the height to exactly 44px (36px on desktop) — one line.
- `[field-sizing:fixed]` explicitly **overrides** the auto-grow (`field-sizing-content`) that the
  base `components/ui/textarea.tsx` sets — so the browser's native grow-to-content is disabled.
- `overflow-y-auto` means the extra text scrolls *inside* the frozen pill instead of expanding it.

So no amount of typed or dictated text can enlarge the box; it can only scroll internally. This is
unique to this composer — the Converse composer (~line 10282, `max-h-28`) and the ask-center
composer (~line 9744, `max-h-[32dvh]`) both grow correctly. The session composer is the outlier.

### Fix (small, safe)

Let the pill grow from its collapsed one-line height up to a cap, using the browser's native
field-sizing (works for typed **and** programmatically-inserted dictation text, since it's pure CSS
that recomputes on any content change). Replace the clamp:

- Drop `h-11 max-h-11` and `[field-sizing:fixed]`; keep `min-h-11` as the collapsed floor.
- Add a growth cap, e.g. `max-h-32` (~5 lines), keep `overflow-y-auto` so it scrolls past the cap.
- Mirror on the `md:` variant (drop `h-9 max-h-9`, keep `min-h-9`, add `md:max-h-40`).

The base `Textarea` already carries `field-sizing-content`, so simply removing the `fixed` override
+ the fixed heights restores auto-grow.

## Symptom 2 — misclick out of the *preview* window loses everything you typed

When a session is open in the small **preview / stage column** (not full-screen) and you misclick
outside it, the whole preview closes and the text you'd typed is gone.

### Root cause

`messageText` is component-local `useState("")` inside `SessionChat`
(`web/src/App.tsx:6386`) with **no draft persistence**. `SessionChat` is mounted twice:

- full-screen (~line 7473)
- inside the `variant === "stage"` preview column (~line 8208), which fully **unmounts** on close
  (the X at line 8195, or `setPreview(null)` fired by an outside click, ~line 5136/5143).

When that instance unmounts, its `messageText` is discarded. There's no keep-alive and no draft
store, so the typed text can't survive the dismiss. (Each mount also has its *own* `messageText`,
so a draft doesn't carry between preview and full-screen either.)

### Fix (needs a small design decision)

Persist the per-session composer draft outside the component lifecycle. Options, cheapest first:

1. **Persist drafts by sid** in a small store (a top-level `Map`/ref or `localStorage`, keyed by
   `session.id`). `SessionChat` seeds `messageText` from it on mount and writes back on change;
   clear the entry on successful send. Survives unmount, preview↔full-screen switches, and reloads.
2. **Guard the accidental dismiss**: don't let an outside click close a preview that has unsent text
   (require the explicit X), and/or confirm. Complementary to (1), not a substitute.

Recommend (1) as the real fix; (2) as a nice-to-have guardrail.

## Files

- `web/src/App.tsx` — `SessionChat` composer (~6656–6730), `messageText` state (6386), stage-column
  mount (~8208), preview dismiss (`setPreview(null)`, ~5136/5143).
- `web/src/components/ui/textarea.tsx` — base `field-sizing-content` that the composer overrides.
- `web/src/components/dictation.tsx` — dictation writes transcript into `messageText` via `onText`;
  not itself buggy, but it's how the un-growable text arrives (Symptom 1).

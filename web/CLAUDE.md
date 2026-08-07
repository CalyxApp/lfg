# lfg web UI — conventions

The phone is the primary target. `web/` is a Capacitor-wrapped iOS PWA; the
same React SPA also runs in a desktop browser, but **design touch-first and
treat the desktop as the enhancement, not the other way round.**

## Mobile-first rules

- **Every feature needs a touch entry point.** Keyboard shortcuts (e.g.
  `Cmd/Ctrl+K`) are a desktop convenience — never the only way to reach
  something. A phone has no Cmd/Ctrl key, so a keyboard-only trigger is
  invisible on mobile.
- **Branch layout on `useIsMobile()`** when a surface should feel different on a
  phone (full-height sheets, safe-area insets) vs. a pointer device (centered
  cards, hover states).
- **Respect safe areas** (`env(safe-area-inset-*)`) and the bottom `TabBar` — the
  phone's primary navigation.

## Command palette (`components/CommandPalette.tsx`)

A `Cmd/Ctrl+K` fuzzy launcher (navigation, actions, projects, sessions). It is
dependency-free (no `cmdk`) — a Base UI `Dialog` wrapping a hand-rolled fuzzy
filter with keyboard nav.

- **Desktop:** opened by the global `Cmd/Ctrl+K` listener in `App.tsx`; renders
  as a centered card near the top.
- **Mobile:** opened by tapping the **Search** icon in the bottom `TabBar`
  (`onSearch` → `setPaletteOpen(true)`); renders as a full-height sheet
  (`mobile` prop). This is the touch entry point — keep it wired.

Add new palette entries by extending the `paletteCommands` list in `App.tsx`;
they work on both form factors because the actions just call `setTab(...)` etc.

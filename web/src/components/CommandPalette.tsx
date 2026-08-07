"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { Search } from "lucide-react"

import { cn } from "@/lib/utils"

export type PaletteCommand = {
  /** Stable unique key. */
  id: string
  /** Primary line shown in the list. */
  label: string
  /** Optional dim second line (e.g. a session's project / agent). */
  sublabel?: string
  /** Section heading this row lives under. */
  group: string
  /** Extra text folded into the fuzzy match but not displayed. */
  keywords?: string
  /** Leading icon (usually a lucide element). */
  icon?: React.ReactNode
  /** Fired when the row is chosen. */
  run: () => void
}

// Subsequence fuzzy scorer. Returns -Infinity when the query isn't a
// subsequence of the target; higher scores are better matches. Rewards matches
// at word boundaries and contiguous runs, and lightly penalises longer targets
// so the tightest label wins ties. Deliberately small — no dependency, good
// enough for a launcher over a few hundred rows.
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let prev = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let bonus = 1
      if (prev === ti - 1) bonus += 3 // contiguous run
      const before = ti === 0 ? " " : t[ti - 1]
      if (/[\s/_\-.:]/.test(before)) bonus += 4 // word boundary
      if (ti === 0) bonus += 2 // very start of the string
      score += bonus
      prev = ti
      qi += 1
    }
  }
  if (qi < q.length) return -Infinity
  return score - t.length * 0.02
}

// Sections render in this order; unknown groups fall to the end in insertion
// order.
const GROUP_ORDER = ["Go to", "Sessions", "Projects", "Actions"]

/**
 * Cmd/Ctrl+K launcher. A controlled Base UI Dialog (focus-trapped, scroll-
 * locked) wrapping a hand-rolled fuzzy-filtered, keyboard-navigable list.
 * Modelled on Calyx's SearchDialog but dependency-free — no cmdk.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  placeholder = "Search or jump to…",
  mobile = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: PaletteCommand[]
  placeholder?: string
  /**
   * Render as a near-fullscreen sheet (touch-first) instead of the centered
   * desktop card. On phones the palette is opened by tapping the Search tab,
   * not a keyboard shortcut, and wants the whole screen for its results + the
   * soft keyboard.
   */
  mobile?: boolean
}) {
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  // Fresh query + selection every time the palette opens.
  React.useEffect(() => {
    if (open) {
      setQuery("")
      setActive(0)
    }
  }, [open])

  // Grouped sections (fixed group order) plus a flat, visually-ordered list the
  // keyboard cursor indexes into.
  const { ordered, sections } = React.useMemo(() => {
    const q = query.trim()
    const scored = commands
      .map((c) => ({
        c,
        score: q
          ? fuzzyScore(q, `${c.label} ${c.sublabel ?? ""} ${c.keywords ?? ""}`)
          : 0,
      }))
      .filter((r) => r.score > -Infinity)
    if (q) scored.sort((a, b) => b.score - a.score)

    const groups = new Map<string, PaletteCommand[]>()
    for (const { c } of scored) {
      const arr = groups.get(c.group)
      if (arr) arr.push(c)
      else groups.set(c.group, [c])
    }
    const groupNames = [
      ...GROUP_ORDER.filter((g) => groups.has(g)),
      ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g)),
    ]
    const built = groupNames.map((g) => ({ group: g, items: groups.get(g)! }))
    return { ordered: built.flatMap((s) => s.items), sections: built }
  }, [query, commands])

  // Keep the cursor inside the (possibly shrunken) result list.
  React.useEffect(() => {
    setActive((a) => Math.min(Math.max(0, a), Math.max(0, ordered.length - 1)))
  }, [ordered.length])

  // Scroll the highlighted row into view as the cursor moves.
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    )
    el?.scrollIntoView({ block: "nearest" })
  }, [active])

  const runAt = (i: number) => {
    const cmd = ordered[i]
    if (!cmd) return
    onOpenChange(false)
    // Defer so the dialog's close/focus-restore settles before the command
    // navigates or opens another surface.
    setTimeout(() => cmd.run(), 0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, ordered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      runAt(active)
    }
  }

  // Running flat index, incremented as rows render so it matches `ordered`.
  let flat = -1

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="pointer-events-auto fixed inset-0 z-[85] bg-black/40 backdrop-blur-sm duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          initialFocus={inputRef}
          className={cn(
            "pointer-events-auto fixed z-[85] flex flex-col overflow-hidden bg-background text-sm shadow-2xl ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            mobile
              ? // Touch: a full-height sheet with small margins + safe-area insets.
                "inset-x-2 top-[max(env(safe-area-inset-top),0.5rem)] bottom-[max(env(safe-area-inset-bottom),0.5rem)] rounded-3xl data-open:slide-in-from-bottom-4 data-closed:slide-out-to-bottom-4"
              : // Pointer: a centered command-palette card near the top.
                "left-1/2 top-[12vh] max-h-[70vh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-3xl data-open:zoom-in-95 data-closed:zoom-out-95 sm:max-w-xl",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            Command palette
          </DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-foreground/5 px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className="h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto overscroll-contain p-2"
          >
            {ordered.length === 0 ? (
              <div className="px-3 py-8 text-center text-muted-foreground">
                No results
              </div>
            ) : (
              sections.map((section) => (
                <div key={section.group} className="mb-1 last:mb-0">
                  <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground/70">
                    {section.group}
                  </div>
                  {section.items.map((cmd) => {
                    flat += 1
                    const index = flat
                    const isActive = index === active
                    return (
                      <button
                        key={cmd.id}
                        type="button"
                        data-index={index}
                        onMouseMove={() => setActive(index)}
                        onClick={() => runAt(index)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors",
                          isActive ? "bg-secondary" : "hover:bg-secondary/60",
                        )}
                      >
                        {cmd.icon ? (
                          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                            {cmd.icon}
                          </span>
                        ) : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground">
                            {cmd.label}
                          </span>
                          {cmd.sublabel ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {cmd.sublabel}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// conversation-history.tsx — the universal view: browse & re-read saved Converse
// conversations. Read-only, decoupled from storage via the /api/converse/
// conversations contract (see docs/converse-universal-view.md). Renders turns with
// the shared <ConversationTurns> so it matches the live thread exactly.

import { useEffect, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { ConversationTurns, type ConversationTurn } from "./components/conversation-turns";

type Summary = { id: string; title: string; date: string; model?: string; createdAt: string; turnCount: number };
type Record = {
  id: string;
  title: string;
  date: string;
  model?: string;
  durationMs?: number;
  createdAt: string;
  turns: ConversationTurn[];
};

export function ConversationHistory({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [open, setOpen] = useState<Record | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/converse/conversations")
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => setList(j as Summary[]))
      .catch(() => {
        setList([]);
        setError("Couldn't load conversations.");
      });
  }, []);

  async function openOne(id: string) {
    setError(null);
    try {
      const r = await fetch(`/api/converse/conversations/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error();
      setOpen((await r.json()) as Record);
    } catch {
      setError("Couldn't open that conversation.");
    }
  }

  // ---- detail: one conversation ----
  if (open) {
    return (
      <div className="fixed inset-0 z-[1100] flex flex-col bg-background text-foreground">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <button
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(null)}
            aria-label="Back"
            title="Back"
          >
            <ArrowLeft className="size-4" />
          </button>
          <strong className="line-clamp-1 flex-1 text-base font-semibold">{open.title || "Untitled"}</strong>
          <button
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-3 text-xs text-muted-foreground">
            {open.date}
            {open.model ? ` · ${open.model}` : ""}
          </div>
          <div className="flex flex-col gap-3">
            <ConversationTurns turns={open.turns} />
          </div>
        </div>
      </div>
    );
  }

  // ---- list ----
  return (
    <div className="fixed inset-0 z-[1100] flex flex-col bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <strong className="text-base font-semibold">Conversations</strong>
        <button
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {error && <div className="px-4 py-2 text-sm text-destructive">{error}</div>}
        {list === null ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : list.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            No saved conversations yet. They'll appear here after you close a chat.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left hover:bg-muted/40"
                  onClick={() => void openOne(s.id)}
                >
                  <span className="line-clamp-1 text-sm font-medium">{s.title || "Untitled"}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.date}
                    {s.model ? ` · ${s.model}` : ""} · {s.turnCount} turn{s.turnCount === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

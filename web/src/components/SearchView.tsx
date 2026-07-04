// SearchView — two corpora behind one box, chosen by a segmented control:
//   • Files       → GET  /api/repos/search  (git grep across the selected repo)
//   • Transcripts → POST /api/transcripts/search  (existing FTS5 index)
//
// Results are read-only for MVP (tapping doesn't yet jump into Files / the
// session — that's cross-tab wiring left for a follow-up).

import { useState } from "react";
import { FileText, Loader2, MessageSquare, Search } from "lucide-react";
import { getJson, postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "./ui/input";
import { EmptyState } from "./ui/empty-state";

type Repo = { name: string; project?: string; custom?: boolean };
type FileMatch = { path: string; line: number; text: string };
type TranscriptMatch = { sessionId: string; role: string; kind: string; snippet: string };

type Mode = "files" | "transcripts";

export function SearchView({ repos }: { repos: Repo[] }) {
  const [mode, setMode] = useState<Mode>("files");
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState<string | null>(repos[0]?.name ?? null);
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    if (mode === "files" && !repo) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      if (mode === "files") {
        const res = await getJson<{ matches: FileMatch[] }>(
          `/api/repos/search?repo=${encodeURIComponent(repo!)}&q=${encodeURIComponent(q)}`,
        );
        setFileMatches(res.matches);
      } else {
        const res = await postJson<{ results: TranscriptMatch[] }>("/api/transcripts/search", { query: q });
        setTranscripts(res.results);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFileMatches([]);
      setTranscripts([]);
    } finally {
      setLoading(false);
    }
  }

  const results = mode === "files" ? fileMatches : transcripts;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 pb-10">
      {/* Segmented control */}
      <div className="flex rounded-full bg-secondary p-1">
        {(["files", "transcripts"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setSearched(false);
              setError(null);
            }}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150 ease-ios",
              mode === m ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {m === "files" ? <FileText className="size-4" /> : <MessageSquare className="size-4" />}
            {m === "files" ? "Files" : "Transcripts"}
          </button>
        ))}
      </div>

      {/* Repo selector (files mode only) */}
      {mode === "files" && repos.length > 1 ? (
        <div className="flex gap-1.5 overflow-x-auto px-0.5 pb-0.5">
          {repos.map((r) => (
            <button
              key={r.name}
              type="button"
              onClick={() => setRepo(r.name)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-xs font-medium tracking-[-0.01em] transition-colors",
                repo === r.name
                  ? "bg-primary text-white"
                  : "bg-secondary text-muted-foreground hover:text-foreground",
              )}
            >
              {r.name}
            </button>
          ))}
        </div>
      ) : null}

      {/* Query box */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
        className="relative"
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "files" ? "Search file contents…" : "Search agent transcripts…"}
          className="pl-9"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </form>

      {error ? (
        <div className="mx-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : searched && results.length === 0 ? (
        <EmptyState icon={<Search className="size-5" />} title="No matches" description={`Nothing found for “${query.trim()}”.`} />
      ) : results.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
          {mode === "files"
            ? fileMatches.map((m, i) => (
                <div key={`${m.path}:${m.line}:${i}`} className="px-4 py-2.5">
                  <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                    <span className="truncate font-medium text-foreground">{m.path}</span>
                    <span className="shrink-0">:{m.line}</span>
                  </div>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                    {m.text}
                  </pre>
                </div>
              ))
            : transcripts.map((m, i) => (
                <div key={`${m.sessionId}:${i}`} className="px-4 py-2.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {m.role}
                    {m.kind && m.kind !== m.role ? ` · ${m.kind}` : ""}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-foreground/90">{m.snippet}</p>
                </div>
              ))}
        </div>
      ) : (
        <EmptyState
          icon={mode === "files" ? <FileText className="size-5" /> : <MessageSquare className="size-5" />}
          title={mode === "files" ? "Search your files" : "Search your transcripts"}
          description={
            mode === "files"
              ? "Find text across the selected repository's files."
              : "Find messages across your agent sessions."
          }
        />
      )}
    </div>
  );
}

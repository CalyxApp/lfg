// FilesView — browse a repo's files on the phone and read one.
//
// Repo picker → lazy, .gitignore-aware file tree (one directory per fetch) →
// read-only viewer. Backend: GET /api/repos/tree and /api/repos/file, both
// path-scoped server-side (safeResolve). Editing is post-MVP; this is read-only.

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderGit2,
  Loader2,
} from "lucide-react";
import { getJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "./ui/empty-state";

type Repo = { name: string; project?: string; custom?: boolean };
type TreeEntry = { name: string; path: string; type: "dir" | "file" };
type FileResult = {
  path: string;
  size: number;
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
};

const rowClass =
  "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]";

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function FilesView({ repos }: { repos: Repo[] }) {
  const [repo, setRepo] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<FileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTree = useCallback(async (repoName: string, path: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJson<{ entries: TreeEntry[] }>(
        `/api/repos/tree?repo=${encodeURIComponent(repoName)}&path=${encodeURIComponent(path)}`,
      );
      setEntries(res.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (repo) void loadTree(repo, dir);
  }, [repo, dir, loadTree]);

  const openFile = useCallback(
    async (path: string) => {
      if (!repo) return;
      setLoading(true);
      setError(null);
      try {
        setFile(
          await getJson<FileResult>(
            `/api/repos/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
          ),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [repo],
  );

  // --- Repo picker ---
  if (!repo) {
    if (!repos.length) {
      return (
        <EmptyState
          icon={<FolderGit2 className="size-5" />}
          title="No repositories"
          description="Add a repo in Settings, or drop one under your repos root, to browse it here."
        />
      );
    }
    return (
      <div className="mx-auto max-w-xl space-y-2 pb-10">
        <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Repositories
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
          {repos.map((r) => (
            <button
              key={r.name}
              type="button"
              onClick={() => {
                setDir("");
                setRepo(r.name);
              }}
              className={rowClass}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-foreground text-background">
                  <FolderGit2 className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{r.name}</span>
                  {r.project && r.project !== r.name ? (
                    <span className="block truncate text-xs text-muted-foreground">{r.project}</span>
                  ) : null}
                </span>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  const crumbs = dir ? dir.split("/") : [];

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 pb-10">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => {
            if (file) setFile(null);
            else if (dir) setDir(parentDir(dir));
            else setRepo(null);
          }}
          aria-label="Back"
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]"
        >
          <ArrowLeft className="size-[18px]" />
        </button>
        <div className="min-w-0 flex-1 truncate text-sm">
          <button
            type="button"
            onClick={() => {
              setFile(null);
              setDir("");
            }}
            className="font-semibold tracking-[-0.01em] hover:underline"
          >
            {repo}
          </button>
          {crumbs.map((seg, i) => (
            <span key={i} className="text-muted-foreground">
              {" / "}
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  setDir(crumbs.slice(0, i + 1).join("/"));
                }}
                className="text-foreground hover:underline"
              >
                {seg}
              </button>
            </span>
          ))}
          {file ? <span className="text-muted-foreground">{` / ${file.path.split("/").pop()}`}</span> : null}
        </div>
      </div>

      {error ? (
        <div className="mx-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : file ? (
        // --- File viewer (read-only) ---
        file.binary ? (
          <EmptyState icon={<FileText className="size-5" />} title="Binary file" description="Can't preview this file type." />
        ) : file.tooLarge ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title="File too large"
            description={`${(file.size / 1_000_000).toFixed(1)} MB — too big to preview on mobile.`}
          />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-border bg-card/40 px-4 py-3 font-mono text-xs leading-relaxed">
            {file.content}
          </pre>
        )
      ) : entries.length === 0 ? (
        <EmptyState icon={<Folder className="size-5" />} title="Empty" description="Nothing to show in this folder." />
      ) : (
        // --- Directory listing ---
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
          {entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => (e.type === "dir" ? setDir(e.path) : void openFile(e.path))}
              className={rowClass}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-[7px]",
                    e.type === "dir" ? "bg-primary text-white" : "bg-foreground/[0.06] text-muted-foreground",
                  )}
                >
                  {e.type === "dir" ? <Folder className="size-4" /> : <FileText className="size-4" />}
                </span>
                <span className="truncate text-sm font-medium">{e.name}</span>
              </div>
              {e.type === "dir" ? <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

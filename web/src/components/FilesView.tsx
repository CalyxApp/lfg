// FilesView — the Files pane of the Files tab: lazy, .gitignore-aware tree →
// rendered-markdown viewer (frontmatter chips + Streamdown body), plain-text
// editing with save→auto-commit, image/HTML/PDF preview via /api/repos/raw,
// and a new-note flow. Backend: /api/repos/{tree,file,raw,write}.
//
// Controlled: the parent (VaultView) owns which repo is open; this pane owns
// navigation inside it. `openPath` lets sibling panes (Tasks) deep-link a file.

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  Loader2,
  MessageSquare,
  Pencil,
  X,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { getJson, postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./ui/drawer";

type TreeEntry = { name: string; path: string; type: "dir" | "file" };
type FileResult = {
  path: string;
  size: number;
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
  /** client-side marker: preview via /api/repos/raw instead of JSON content */
  raw?: "image" | "frame";
};

const MD_RE = /\.mdx?$/i;
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const FRAME_RE = /\.(html?|pdf)$/i;

const rowClass =
  "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]";

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Display-only frontmatter split (writes go through the server, never this). */
function splitFrontmatter(src: string): { fm: [string, string][]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { fm: [], body: src };
  const fm: [string, string][] = [];
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv && kv[2]) fm.push([kv[1], kv[2].replace(/^["']|["']$/g, "")]);
  }
  return { fm, body: src.slice(m[0].length) };
}

export function FilesView({
  repo,
  openPath,
  onOpenPathConsumed,
  onExitRepo,
  onContinueChat,
}: {
  repo: string;
  openPath?: string | null;
  onOpenPathConsumed?: () => void;
  onExitRepo?: () => void;
  /** Reopen a saved AI chat note back in the chat surface to keep it going. */
  onContinueChat?: (path: string, content: string) => void;
}) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<FileResult | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadTree = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await getJson<{ entries: TreeEntry[] }>(
          `/api/repos/tree?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
        );
        setEntries(res.entries);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [repo],
  );

  useEffect(() => {
    if (!file) void loadTree(dir);
  }, [dir, loadTree, file]);

  // Repo switched from above: reset navigation.
  useEffect(() => {
    setDir("");
    setFile(null);
    setMode("view");
    setCreating(false);
  }, [repo]);

  const openFile = useCallback(
    async (path: string) => {
      setMode("view");
      setError(null);
      if (IMG_RE.test(path)) {
        setFile({ path, size: 0, raw: "image" });
        return;
      }
      if (FRAME_RE.test(path)) {
        setFile({ path, size: 0, raw: "frame" });
        return;
      }
      setLoading(true);
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

  // Deep-link from a sibling pane (e.g. tapping a task opens its file).
  useEffect(() => {
    if (!openPath) return;
    setDir(parentDir(openPath));
    void openFile(openPath);
    onOpenPathConsumed?.();
  }, [openPath, openFile, onOpenPathConsumed]);

  async function save() {
    if (!file || saving) return;
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/repos/write", { repo, path: file.path, content: draft });
      setFile({ ...file, content: draft, size: draft.length });
      setMode("view");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function createNote() {
    let name = newName.trim();
    if (!name || saving) return;
    if (!/\.[A-Za-z0-9]+$/.test(name)) name += ".md";
    const path = dir ? `${dir}/${name}` : name;
    setSaving(true);
    setError(null);
    try {
      const content = MD_RE.test(name) ? "---\ntype: note\n---\n\n" : "";
      await postJson("/api/repos/write", { repo, path, content, createOnly: true });
      setCreating(false);
      setNewName("");
      setFile({ path, size: content.length, content });
      setDraft(content);
      setMode("edit");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const crumbs = dir ? dir.split("/") : [];
  const rawUrl = file
    ? `/api/repos/raw?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(file.path)}`
    : "";
  const editable = !!file && !file.raw && !file.binary && !file.tooLarge;
  const isMd = !!file && MD_RE.test(file.path);
  // A saved AI chat (from Converse): lives under ai-voice-conversations/, or is
  // typed as such in frontmatter. These get a "Continue chat" affordance.
  const isConversation =
    !!file &&
    (file.path.startsWith("ai-voice-conversations/") ||
      splitFrontmatter(file.content ?? "").fm.some(
        ([k, v]) => k === "type" && v === "ai-voice-conversation",
      ));

  return (
    <div className="flex flex-col gap-3">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => {
            if (mode === "edit") {
              setMode("view");
            } else if (file) {
              setFile(null);
            } else if (dir) {
              setDir(parentDir(dir));
            } else {
              onExitRepo?.();
            }
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
              setMode("view");
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
                  setMode("view");
                  setFile(null);
                  setDir(crumbs.slice(0, i + 1).join("/"));
                }}
                className="text-foreground hover:underline"
              >
                {seg}
              </button>
            </span>
          ))}
          {file ? (
            <span className="text-muted-foreground">{` / ${file.path.split("/").pop()}`}</span>
          ) : null}
        </div>

        {/* Contextual actions */}
        {file && isConversation && mode === "view" && onContinueChat ? (
          <button
            type="button"
            onClick={() => onContinueChat(file.path, file.content ?? "")}
            aria-label="Continue chat"
            title="Continue this chat"
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]"
          >
            <MessageSquare className="size-4" />
          </button>
        ) : null}
        {file && editable && mode === "view" ? (
          <button
            type="button"
            onClick={() => {
              setDraft(file.content ?? "");
              setMode("edit");
            }}
            aria-label="Edit"
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]"
          >
            <Pencil className="size-4" />
          </button>
        ) : null}
        {file && mode === "edit" ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMode("view")}
              aria-label="Cancel"
              className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="size-[18px]" />
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              aria-label="Save"
              className="flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-[13px] font-semibold text-white transition-transform active:scale-[0.96]"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Save
            </button>
          </div>
        ) : null}
        {!file ? (
          <button
            type="button"
            onClick={() => setCreating((c) => !c)}
            aria-label="New note"
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]"
          >
            <FilePlus2 className="size-4" />
          </button>
        ) : null}
      </div>

      {/* New-note inline form */}
      {creating && !file ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createNote();
          }}
          className="flex items-center gap-2 px-1"
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`New note in ${dir || "root"}… (name.md)`}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button
            type="submit"
            disabled={!newName.trim() || saving}
            className="flex h-9 shrink-0 items-center rounded-full bg-primary px-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            Create
          </button>
        </form>
      ) : null}

      {error ? (
        <div className="mx-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : file && mode === "edit" ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[60dvh] font-mono text-[13px] leading-relaxed"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      ) : file ? (
        file.raw === "image" ? (
          <img
            src={rawUrl}
            alt={file.path}
            className="max-w-full rounded-2xl border border-border bg-card/40"
          />
        ) : file.raw === "frame" ? (
          <iframe
            src={rawUrl}
            sandbox="allow-scripts"
            title={file.path}
            className="h-[75dvh] w-full rounded-2xl border border-border bg-white"
          />
        ) : file.binary ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title="Binary file"
            description="Can't preview this file type."
          />
        ) : file.tooLarge ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title="File too large"
            description={`${(file.size / 1_000_000).toFixed(1)} MB — too big to preview on mobile.`}
          />
        ) : isMd ? (
          <MarkdownDoc
            source={file.content ?? ""}
            editProps={{
              repo,
              filePath: file.path,
              onSaved: (newSource) => setFile({ ...file, content: newSource, size: newSource.length }),
            }}
          />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-border bg-card/40 px-4 py-3 font-mono text-xs leading-relaxed">
            {file.content}
          </pre>
        )
      ) : entries.length === 0 && !creating ? (
        <EmptyState
          icon={<Folder className="size-5" />}
          title="Empty"
          description="Nothing to show in this folder."
        />
      ) : (
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
                    e.type === "dir"
                      ? "bg-primary text-white"
                      : "bg-foreground/[0.06] text-muted-foreground",
                  )}
                >
                  {e.type === "dir" ? <Folder className="size-4" /> : <FileText className="size-4" />}
                </span>
                <span className="truncate text-sm font-medium">{e.name}</span>
              </div>
              {e.type === "dir" ? (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type EditableField = "due" | "priority" | "project";
const EDITABLE_FIELDS = new Set<string>(["due", "priority", "project"]);
const PRIORITIES = ["low", "normal", "high"];

interface MarkdownDocEditProps {
  repo: string;
  filePath: string;
  onSaved: (newSource: string) => void;
}

/** Rendered markdown: frontmatter as chips; due/priority/project chips are tappable. */
function MarkdownDoc({ source, editProps }: { source: string; editProps?: MarkdownDocEditProps }) {
  const { fm, body } = splitFrontmatter(source);
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [fieldValue, setFieldValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openEdit(k: EditableField, current: string) {
    setFieldValue(current);
    setError(null);
    setEditingField(k);
  }

  async function saveField() {
    if (!editProps || !editingField || saving) return;
    setSaving(true);
    setError(null);
    try {
      const resp = await postJson<{ path: string; commit: string | null }>("/api/vault/update", {
        repo: editProps.repo,
        path: editProps.filePath,
        updates: { [editingField]: fieldValue.trim() || null },
      });
      // Reload the file to get the updated frontmatter.
      const fresh = await fetch(
        `/api/repos/file?repo=${encodeURIComponent(editProps.repo)}&path=${encodeURIComponent(editProps.filePath)}`,
      ).then((r) => r.json() as Promise<{ content?: string }>);
      if (fresh.content != null) editProps.onSaved(fresh.content);
      setEditingField(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const editingLabel =
    editingField === "due" ? "Due date" :
    editingField === "priority" ? "Priority" :
    editingField === "project" ? "Project" : "";

  return (
    <div className="flex flex-col gap-3">
      {fm.length ? (
        <div className="flex flex-wrap gap-1.5 px-1">
          {fm.map(([k, v]) => {
            const editable = editProps && EDITABLE_FIELDS.has(k);
            if (editable) {
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => openEdit(k as EditableField, v)}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary/70 active:scale-[0.96]"
                >
                  <span className="opacity-70">{k}</span>
                  <span className="truncate text-foreground/80">{v}</span>
                  <Pencil className="size-2.5 shrink-0 opacity-50" />
                </button>
              );
            }
            return (
              <span
                key={k}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
              >
                <span className="opacity-70">{k}</span>
                <span className="truncate text-foreground/80">{v}</span>
              </span>
            );
          })}
        </div>
      ) : null}

      {/* Property edit drawer */}
      <Drawer open={!!editingField} onOpenChange={(open) => { if (!open) setEditingField(null); }}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{editingLabel}</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col gap-3 px-4 pb-2">
            {editingField === "priority" ? (
              <div className="flex gap-2">
                {PRIORITIES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setFieldValue(p)}
                    className={cn(
                      "flex-1 rounded-xl py-2.5 text-[13px] font-medium capitalize transition-colors",
                      fieldValue === p
                        ? "bg-primary text-white"
                        : "bg-secondary text-muted-foreground hover:bg-secondary/70",
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            ) : editingField === "due" ? (
              <Input
                type="date"
                value={fieldValue}
                onChange={(e) => setFieldValue(e.target.value)}
                className="text-[15px]"
              />
            ) : (
              <Input
                value={fieldValue}
                onChange={(e) => setFieldValue(e.target.value)}
                placeholder="Project name…"
                className="text-[15px]"
                autoFocus
              />
            )}
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
          </div>
          <DrawerFooter>
            <button
              type="button"
              onClick={() => void saveField()}
              disabled={saving}
              className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-primary text-[15px] font-semibold text-white disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </button>
            <DrawerClose asChild>
              <button
                type="button"
                className="flex h-11 items-center justify-center rounded-2xl bg-secondary text-[15px] font-medium text-muted-foreground"
              >
                Cancel
              </button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <article className="markdown rounded-2xl border border-border bg-card/40 px-4 py-4 text-[15px] leading-relaxed [&_pre]:overflow-x-auto">
        <Streamdown>{body}</Streamdown>
      </article>
    </div>
  );
}

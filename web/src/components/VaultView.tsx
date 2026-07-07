// VaultView — the Files tab shell: repo picker → segmented Files / Tasks /
// Projects panes. Tasks & Projects appear only when the repo carries Calyx
// frontmatter (type: task / project) — same semantics as desktop Calyx (the
// server scan is a port of Calyx's CLI scanner). Task status flips are
// optimistic and byte-preserving server-side.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  FolderGit2,
  KanbanSquare,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { getJson, postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "./ui/empty-state";
import { FilesView } from "./FilesView";

type Repo = { name: string; project?: string; custom?: boolean };
type VaultSummary = { isVault: boolean; counts: Record<string, number>; truncated: boolean };
type VaultItem = {
  path: string;
  title: string;
  status?: string;
  priority?: string;
  due?: string;
  project?: string;
  area?: string;
  description?: string;
};

type Pane = "files" | "tasks" | "projects";

const rowClass =
  "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]";

const OPEN_STATUS_ORDER = ["in-progress", "todo", "needs-review"];
const CLOSED_STATUSES = new Set(["done", "cancelled"]);

function statusIcon(status: string | undefined, className: string) {
  switch (status) {
    case "done":
      return <CircleCheck className={cn(className, "text-[var(--success)]")} />;
    case "in-progress":
      return <CircleDot className={cn(className, "text-primary")} />;
    case "needs-review":
      return <CircleDashed className={cn(className, "text-[var(--warning)]")} />;
    case "cancelled":
      return <CircleX className={cn(className, "text-muted-foreground/60")} />;
    default:
      return <Circle className={cn(className, "text-muted-foreground/70")} />;
  }
}

function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dueLabel(due: string, today: string): { text: string; tone: "overdue" | "today" | "later" } {
  if (due < today) return { text: `Overdue · ${due.slice(5)}`, tone: "overdue" };
  if (due === today) return { text: "Today", tone: "today" };
  return { text: due.slice(5), tone: "later" };
}

export function VaultView({
  repos,
  deepLink,
  onDeepLinkConsumed,
}: {
  repos: Repo[];
  deepLink?: { repo: string; path: string } | null;
  onDeepLinkConsumed?: () => void;
}) {
  const [repo, setRepo] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("files");
  const [summary, setSummary] = useState<VaultSummary | null>(null);
  const [tasks, setTasks] = useState<VaultItem[] | null>(null);
  const [projects, setProjects] = useState<VaultItem[] | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  // Cross-tab deep link (a Search result): select the repo, land on the Files
  // pane with the file open, then consume the link so later visits to the tab
  // aren't re-hijacked. openPath survives the repo-probe effect below (which
  // only resets panes/items), so ordering is safe for both same-repo and
  // switch-repo arrivals.
  useEffect(() => {
    if (!deepLink) return;
    setRepo(deepLink.repo);
    setPane("files");
    setOpenPath(deepLink.path);
    onDeepLinkConsumed?.();
  }, [deepLink, onDeepLinkConsumed]);

  // Probe vault-ness on repo select (cheap scan server-side).
  useEffect(() => {
    if (!repo) return;
    setSummary(null);
    setTasks(null);
    setProjects(null);
    setPane("files");
    setProjectFilter(null);
    getJson<VaultSummary>(`/api/vault/summary?repo=${encodeURIComponent(repo)}`)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [repo]);

  const loadItems = useCallback(async () => {
    if (!repo) return;
    setLoadingItems(true);
    setError(null);
    try {
      const [t, p] = await Promise.all([
        getJson<{ items: VaultItem[] }>(
          `/api/vault/items?repo=${encodeURIComponent(repo)}&type=task`,
        ),
        getJson<{ items: VaultItem[] }>(
          `/api/vault/items?repo=${encodeURIComponent(repo)}&type=project`,
        ),
      ]);
      setTasks(t.items);
      setProjects(p.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingItems(false);
    }
  }, [repo]);

  useEffect(() => {
    if ((pane === "tasks" || pane === "projects") && tasks === null && !loadingItems) {
      void loadItems();
    }
  }, [pane, tasks, loadingItems, loadItems]);

  async function flipStatus(item: VaultItem) {
    if (!repo) return;
    const next = item.status === "done" ? "todo" : "done";
    const prev = item.status;
    setTasks((ts) => ts?.map((t) => (t.path === item.path ? { ...t, status: next } : t)) ?? null);
    try {
      await postJson("/api/vault/update", {
        repo,
        path: item.path,
        updates: { status: next },
      });
    } catch (e) {
      setTasks((ts) => ts?.map((t) => (t.path === item.path ? { ...t, status: prev } : t)) ?? null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const hasTasks = (summary?.counts.task ?? 0) > 0;
  const hasProjects = (summary?.counts.project ?? 0) > 0;
  const segments = useMemo(() => {
    const s: { id: Pane; label: string }[] = [{ id: "files", label: "Files" }];
    if (hasTasks) s.push({ id: "tasks", label: "Tasks" });
    if (hasProjects) s.push({ id: "projects", label: "Projects" });
    return s;
  }, [hasTasks, hasProjects]);

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
            <button key={r.name} type="button" onClick={() => setRepo(r.name)} className={rowClass}>
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

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 pb-10">
      {/* Segmented control — only when the repo has Calyx content */}
      {segments.length > 1 ? (
        <div className="flex rounded-full bg-secondary p-1">
          {segments.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setPane(s.id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150 ease-ios",
                pane === s.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
              {s.id === "tasks" && summary ? (
                <span className="text-[11px] opacity-60">{summary.counts.task}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="mx-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {pane === "files" ? (
        <FilesView
          repo={repo}
          openPath={openPath}
          onOpenPathConsumed={() => setOpenPath(null)}
          onExitRepo={() => setRepo(null)}
        />
      ) : pane === "tasks" ? (
        <TasksPane
          tasks={tasks}
          loading={loadingItems}
          projectFilter={projectFilter}
          onClearFilter={() => setProjectFilter(null)}
          onRefresh={loadItems}
          onFlip={flipStatus}
          onOpen={(p) => {
            setOpenPath(p);
            setPane("files");
          }}
        />
      ) : (
        <ProjectsPane
          projects={projects}
          tasks={tasks}
          loading={loadingItems}
          onRefresh={loadItems}
          onSelect={(title) => {
            setProjectFilter(title);
            setPane("tasks");
          }}
          onOpen={(p) => {
            setOpenPath(p);
            setPane("files");
          }}
        />
      )}
    </div>
  );
}

function TasksPane({
  tasks,
  loading,
  projectFilter,
  onClearFilter,
  onRefresh,
  onFlip,
  onOpen,
}: {
  tasks: VaultItem[] | null;
  loading: boolean;
  projectFilter: string | null;
  onClearFilter: () => void;
  onRefresh: () => void;
  onFlip: (item: VaultItem) => void;
  onOpen: (path: string) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const today = localToday();

  const filtered = useMemo(() => {
    if (!tasks) return [];
    return projectFilter ? tasks.filter((t) => t.project === projectFilter) : tasks;
  }, [tasks, projectFilter]);

  const { open, closed } = useMemo(() => {
    const open: VaultItem[] = [];
    const closed: VaultItem[] = [];
    for (const t of filtered) (CLOSED_STATUSES.has(t.status ?? "") ? closed : open).push(t);
    const rank = (t: VaultItem) => {
      const s = OPEN_STATUS_ORDER.indexOf(t.status ?? "todo");
      return s < 0 ? OPEN_STATUS_ORDER.length : s;
    };
    open.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
        a.title.localeCompare(b.title),
    );
    return { open, closed };
  }, [filtered]);

  if (loading && tasks === null) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Tasks
          </h2>
          {projectFilter ? (
            <button
              type="button"
              onClick={onClearFilter}
              className="flex min-w-0 items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary"
            >
              <span className="truncate">{projectFilter}</span>
              <X className="size-3 shrink-0" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh"
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {open.length === 0 && closed.length === 0 ? (
        <EmptyState
          icon={<CircleCheck className="size-5" />}
          title="No tasks"
          description={projectFilter ? "No tasks in this project." : "This repo has no open tasks."}
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
            {open.map((t) => (
              <TaskRow key={t.path} item={t} today={today} onFlip={onFlip} onOpen={onOpen} />
            ))}
            {open.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                All clear — nothing open.
              </div>
            ) : null}
          </div>
          {closed.length ? (
            <button
              type="button"
              onClick={() => setShowClosed((s) => !s)}
              className="px-4 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {showClosed ? "Hide" : "Show"} completed ({closed.length})
            </button>
          ) : null}
          {showClosed && closed.length ? (
            <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border opacity-70">
              {closed.map((t) => (
                <TaskRow key={t.path} item={t} today={today} onFlip={onFlip} onOpen={onOpen} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function TaskRow({
  item,
  today,
  onFlip,
  onOpen,
}: {
  item: VaultItem;
  today: string;
  onFlip: (item: VaultItem) => void;
  onOpen: (path: string) => void;
}) {
  const due = item.due ? dueLabel(item.due, today) : null;
  const closed = CLOSED_STATUSES.has(item.status ?? "");
  return (
    <div className="flex items-center gap-1 pr-2">
      <button
        type="button"
        onClick={() => onFlip(item)}
        aria-label={closed ? "Reopen" : "Mark done"}
        className="flex size-11 shrink-0 items-center justify-center rounded-full transition-transform active:scale-[0.88]"
      >
        {statusIcon(item.status, "size-[22px]")}
      </button>
      <button
        type="button"
        onClick={() => onOpen(item.path)}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-2.5 text-left"
      >
        <span
          className={cn(
            "w-full truncate text-sm font-medium",
            closed && "text-muted-foreground line-through decoration-muted-foreground/40",
          )}
        >
          {item.title}
        </span>
        {due || item.project || item.priority === "high" ? (
          <span className="flex w-full items-center gap-2 text-[11px] text-muted-foreground">
            {item.priority === "high" && !closed ? (
              <span className="font-semibold text-[var(--warning)]">High</span>
            ) : null}
            {due && !closed ? (
              <span
                className={cn(
                  due.tone === "overdue" && "font-medium text-destructive",
                  due.tone === "today" && "font-medium text-primary",
                )}
              >
                {due.text}
              </span>
            ) : null}
            {item.project ? <span className="truncate">{item.project}</span> : null}
          </span>
        ) : null}
      </button>
    </div>
  );
}

function ProjectsPane({
  projects,
  tasks,
  loading,
  onRefresh,
  onSelect,
  onOpen,
}: {
  projects: VaultItem[] | null;
  tasks: VaultItem[] | null;
  loading: boolean;
  onRefresh: () => void;
  onSelect: (title: string) => void;
  onOpen: (path: string) => void;
}) {
  const openCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks ?? []) {
      if (!t.project || CLOSED_STATUSES.has(t.status ?? "")) continue;
      counts.set(t.project, (counts.get(t.project) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);

  if (loading && projects === null) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh"
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {!projects?.length ? (
        <EmptyState
          icon={<KanbanSquare className="size-5" />}
          title="No projects"
          description="No files with `type: project` frontmatter in this repo."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
          {projects.map((p) => {
            const open = openCounts.get(p.title) ?? 0;
            return (
              <div key={p.path} className="flex items-center pr-2">
                <button
                  type="button"
                  onClick={() => onSelect(p.title)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="truncate text-sm font-medium">{p.title}</span>
                    {p.status ? (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                          p.status === "active"
                            ? "bg-primary/10 text-primary"
                            : "bg-secondary text-muted-foreground",
                        )}
                      >
                        {p.status}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex w-full items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{open ? `${open} open task${open === 1 ? "" : "s"}` : "No open tasks"}</span>
                    {p.area ? <span className="truncate">· {p.area}</span> : null}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpen(p.path)}
                  aria-label="Open project file"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

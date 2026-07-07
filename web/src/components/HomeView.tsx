// HomeView — the mobile app's landing page. Opens on a vault-first dashboard
// (greeting, today's tasks, live agent sessions, quick actions) instead of
// dropping straight into the chat feed; chat is one tap away (Agents tab or
// the New chat tile). Task data comes from the Calyx vault endpoints; the
// vault repo is auto-detected once and remembered.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Folder,
  PenLine,
  Search,
} from "lucide-react";
import { getJson, postJson } from "@/lib/api";
import { cn } from "@/lib/utils";

type Repo = { name: string; project?: string; custom?: boolean };
type HomeSession = {
  sessionId: string | null;
  title?: string | null;
  project?: string;
  lastActivityAt?: number | null;
};
type VaultTask = {
  path: string;
  title: string;
  status?: string;
  priority?: string;
  due?: string;
  project?: string;
};

const VAULT_REPO_KEY = "lfg.home.vaultRepo";
const CLOSED = new Set(["done", "cancelled"]);

function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const tileClass =
  "flex flex-col items-start gap-2 rounded-2xl border border-border bg-card/40 px-4 py-3.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]";

export function HomeView({
  repos,
  sessions,
  onOpen,
  onNewChat,
}: {
  repos: Repo[];
  sessions: HomeSession[];
  onOpen: (tab: string) => void;
  onNewChat: () => void;
}) {
  const [vaultRepo, setVaultRepo] = useState<string | null>(null);
  const [tasks, setTasks] = useState<VaultTask[] | null>(null);
  const today = localToday();

  // Detect (once) which repo carries Calyx tasks; remember the answer.
  useEffect(() => {
    if (vaultRepo || !repos.length) return;
    let cancelled = false;
    (async () => {
      const remembered = localStorage.getItem(VAULT_REPO_KEY);
      const order = [
        ...repos.filter((r) => r.name === remembered),
        ...repos.filter((r) => r.name !== remembered),
      ].slice(0, 8);
      for (const r of order) {
        try {
          const s = await getJson<{ isVault: boolean; counts: Record<string, number> }>(
            `/api/vault/summary?repo=${encodeURIComponent(r.name)}`,
          );
          if (cancelled) return;
          if (s.isVault || (s.counts.task ?? 0) > 0) {
            localStorage.setItem(VAULT_REPO_KEY, r.name);
            setVaultRepo(r.name);
            return;
          }
        } catch {
          // unreachable repo — try the next
        }
      }
      if (!cancelled) setVaultRepo(""); // probed everything, no vault
    })();
    return () => {
      cancelled = true;
    };
  }, [repos, vaultRepo]);

  const loadTasks = useCallback(async () => {
    if (!vaultRepo) return;
    try {
      const res = await getJson<{ items: VaultTask[] }>(
        `/api/vault/items?repo=${encodeURIComponent(vaultRepo)}&type=task`,
      );
      setTasks(res.items);
    } catch {
      setTasks([]);
    }
  }, [vaultRepo]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const todayTasks = useMemo(() => {
    const open = (tasks ?? []).filter((t) => !CLOSED.has(t.status ?? ""));
    const rank = (t: VaultTask) => {
      if (t.due && t.due < today) return 0; // overdue
      if (t.due === today) return 1; // today
      if (t.status === "in-progress") return 2;
      return 3;
    };
    return open
      .sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999"))
      .slice(0, 6);
  }, [tasks, today]);

  async function flip(t: VaultTask) {
    if (!vaultRepo) return;
    const next = t.status === "done" ? "todo" : "done";
    const prev = t.status;
    setTasks((ts) => ts?.map((x) => (x.path === t.path ? { ...x, status: next } : x)) ?? null);
    try {
      await postJson("/api/vault/update", { repo: vaultRepo, path: t.path, updates: { status: next } });
    } catch {
      setTasks((ts) => ts?.map((x) => (x.path === t.path ? { ...x, status: prev } : x)) ?? null);
    }
  }

  const active = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
        .slice(0, 3),
    [sessions],
  );

  const dateLine = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 pb-10 pt-2">
      {/* Greeting */}
      <div className="px-1">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{greeting()}</h1>
        <p className="text-sm text-muted-foreground">{dateLine}</p>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-2.5">
        <button type="button" onClick={onNewChat} className={tileClass}>
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-primary text-white">
            <Bot className="size-[18px]" />
          </span>
          <span className="text-sm font-medium">New chat</span>
        </button>
        <button type="button" onClick={() => onOpen("capture")} className={tileClass}>
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-foreground text-background">
            <PenLine className="size-[18px]" />
          </span>
          <span className="text-sm font-medium">Capture</span>
        </button>
        <button type="button" onClick={() => onOpen("files")} className={tileClass}>
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-foreground/[0.08] text-foreground">
            <Folder className="size-[18px]" />
          </span>
          <span className="text-sm font-medium">Files</span>
        </button>
        <button type="button" onClick={() => onOpen("search")} className={tileClass}>
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-foreground/[0.08] text-foreground">
            <Search className="size-[18px]" />
          </span>
          <span className="text-sm font-medium">Search</span>
        </button>
      </div>

      {/* Today's tasks — only when a vault exists */}
      {vaultRepo && todayTasks.length ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Today
            </h2>
            <button
              type="button"
              onClick={() => onOpen("files")}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Open vault
            </button>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
            {todayTasks.map((t) => {
              const overdue = !!t.due && t.due < today;
              const dueToday = t.due === today;
              return (
                <div key={t.path} className="flex items-center gap-1 pr-3">
                  <button
                    type="button"
                    onClick={() => void flip(t)}
                    aria-label="Mark done"
                    className="flex size-11 shrink-0 items-center justify-center rounded-full transition-transform active:scale-[0.88]"
                  >
                    {t.status === "done" ? (
                      <CircleCheck className="size-[20px] text-[var(--success)]" />
                    ) : t.status === "in-progress" ? (
                      <CircleDot className="size-[20px] text-primary" />
                    ) : (
                      <Circle className="size-[20px] text-muted-foreground/70" />
                    )}
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col py-2">
                    <span className="truncate text-sm font-medium">{t.title}</span>
                    {t.due || t.project ? (
                      <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        {t.due ? (
                          <span
                            className={cn(
                              overdue && "font-medium text-destructive",
                              dueToday && "font-medium text-primary",
                            )}
                          >
                            {overdue ? `Overdue · ${t.due.slice(5)}` : dueToday ? "Today" : t.due.slice(5)}
                          </span>
                        ) : null}
                        {t.project ? <span className="truncate">{t.project}</span> : null}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Live sessions */}
      <section className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Agents
          </h2>
          <button
            type="button"
            onClick={() => onOpen("live")}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            All sessions
          </button>
        </div>
        {active.length ? (
          <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
            {active.map((s, i) => (
              <button
                key={s.sessionId ?? i}
                type="button"
                onClick={() => onOpen("live")}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-primary/10 text-primary">
                    <Bot className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {s.title || "Untitled session"}
                    </span>
                    {s.project ? (
                      <span className="block truncate text-xs text-muted-foreground">{s.project}</span>
                    ) : null}
                  </span>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={onNewChat}
            className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border px-4 py-3.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Bot className="size-4" />
            No live sessions — start one
          </button>
        )}
      </section>
    </div>
  );
}

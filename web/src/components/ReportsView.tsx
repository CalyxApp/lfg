// ReportsView — full-screen list of Calyx reports (the vault's generated
// `reports/*.html`, newest first), reachable from the "Also under Agents" hub.
// Reports are self-contained HTML docs, so tapping one opens the shared
// HtmlViewerOverlay (same sandboxed reader used for HTML artifacts / vault docs).
// Filter pills switch between report types (daily briefing, weekly summary, ...).

import { useEffect, useMemo, useState } from "react";
import { Bot, FileText, Loader2, Newspaper, RefreshCw, Sparkles } from "lucide-react";
import { getJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { HtmlViewerOverlay } from "./HtmlViewerOverlay";

export type ReportItem = {
  id: string;
  title: string;
  source: string; // briefing | agent | scheduled | manual
  status: string; // ready | generating | failed
  created: string; // ISO
  reportType?: string;
  format?: string;
  url: string;
};

// briefing → sparkles, agent → bot, scheduled → newspaper, else document.
function SourceIcon({ source, className }: { source: string; className?: string }) {
  const Icon =
    source === "briefing" ? Sparkles : source === "agent" ? Bot : source === "scheduled" ? Newspaper : FileText;
  return <Icon className={className} />;
}

function titleCase(slug?: string): string {
  if (!slug) return "Other";
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export function ReportsView() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [open, setOpen] = useState<ReportItem | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ items: ReportItem[] }>("/api/calyx-reports");
      setReports(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Distinct report types present, ordered by frequency, for the filter pills.
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of reports) {
      const key = r.reportType || "other";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  }, [reports]);

  const visible = useMemo(
    () => (type ? reports.filter((r) => (r.reportType || "other") === type) : reports),
    [reports, type],
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-3 pb-24 pt-3">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-lg font-semibold">Reports</h1>
        <button
          onClick={() => void load()}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          title="Refresh"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </button>
      </div>

      {/* Type filter pills — "different types" of reports */}
      {types.length > 1 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button
            onClick={() => setType(null)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium",
              type === null ? "bg-foreground text-background" : "bg-accent text-muted-foreground hover:text-foreground",
            )}
          >
            All {reports.length}
          </button>
          {types.map((t) => (
            <button
              key={t.key}
              onClick={() => setType(t.key)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium",
                type === t.key ? "bg-foreground text-background" : "bg-accent text-muted-foreground hover:text-foreground",
              )}
            >
              {titleCase(t.key)} {t.count}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">{error}</div>
      ) : null}

      {!loading && !error && visible.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No reports yet. The Calyx vault generates these (nightly briefings and more) — they'll show up here.
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
        {visible.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setOpen(r)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary/10 text-primary">
              <SourceIcon source={r.source} className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{r.title}</span>
              <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{formatDate(r.created)}</span>
                {r.reportType ? <span className="truncate">· {titleCase(r.reportType)}</span> : null}
                {r.status && r.status !== "ready" ? (
                  <span className="rounded-full bg-accent px-1.5 py-0.5 uppercase tracking-wide">{r.status}</span>
                ) : null}
              </span>
            </span>
          </button>
        ))}
      </div>

      {open ? (
        <HtmlViewerOverlay title={open.title} src={open.url} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

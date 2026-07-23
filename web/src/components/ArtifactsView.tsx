// ArtifactsView — gallery of everything agents have published (images, videos,
// live HTML dashboards) across sessions, newest first. Tap a card for the full
// viewer. HTML artifacts render in the same locked-down sandboxed iframe the
// backend enforces via CSP; re-published ids show a version badge.

import { useCallback, useEffect, useRef, useState } from "react";
import { Film, Globe, Image as ImageIcon, Loader2, Maximize2, RefreshCw, X } from "lucide-react";
import { getJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { HtmlViewerOverlay } from "./HtmlViewerOverlay";

export type ArtifactCard = {
  id: string;
  kind: "image" | "video" | "html";
  url: string;
  name?: string;
  title?: string;
  caption?: string;
  sessionId: string;
  sessionTitle?: string;
  ts?: number;
  version?: number;
  size?: number;
  mimeType?: string;
  refreshEnabled?: boolean;
  refreshStatus?: string;
};

const KINDS = [
  { key: null, label: "All" },
  { key: "image", label: "Images" },
  { key: "video", label: "Videos" },
  { key: "html", label: "Live" },
] as const;

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function KindIcon({ kind, className }: { kind: ArtifactCard["kind"]; className?: string }) {
  const Icon = kind === "video" ? Film : kind === "html" ? Globe : ImageIcon;
  return <Icon className={className} />;
}

// Sandboxed live-HTML embed. The frame is cross-origin by CSP sandbox, so the
// injected height reporter postMessages its content height and we match it.
function HtmlEmbed({ artifact, full }: { artifact: ArtifactCard; full?: boolean }) {
  const [height, setHeight] = useState<number>(full ? 480 : 220);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (
        e.source === frameRef.current?.contentWindow &&
        e.data?.type === "lfg-artifact-height" &&
        typeof e.data.height === "number"
      ) {
        setHeight(Math.min(Math.max(e.data.height, 120), full ? 4000 : 320));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [full]);
  return (
    <iframe
      ref={frameRef}
      title={artifact.title || artifact.id}
      src={artifact.url}
      sandbox="allow-scripts"
      className="w-full border-0 bg-white dark:bg-zinc-900"
      style={{ height, pointerEvents: full ? "auto" : "none" }}
    />
  );
}

function ArtifactMedia({ artifact, full }: { artifact: ArtifactCard; full?: boolean }) {
  if (artifact.kind === "html") return <HtmlEmbed artifact={artifact} full={full} />;
  if (artifact.kind === "video")
    return (
      <video
        src={artifact.url}
        controls={full}
        muted={!full}
        playsInline
        preload="metadata"
        className={cn("w-full bg-black", full ? "max-h-[70vh]" : "aspect-video object-cover")}
      />
    );
  return (
    <img
      src={full ? artifact.url : `${artifact.url}?preview=1`}
      alt={artifact.caption || artifact.name || artifact.id}
      loading="lazy"
      className={cn("w-full", full ? "max-h-[70vh] object-contain" : "aspect-video object-cover")}
    />
  );
}

// Inline chat card — how an artifact renders at its placement point inside a
// session transcript (the backend appends an artifact message when an agent
// publishes). Media + label row; tap opens the raw artifact in a new tab.
export function ArtifactInlineCard({
  artifact,
}: {
  artifact: {
    kind?: string;
    url?: string;
    artifactId?: string;
    title?: string;
    caption?: string;
    text?: string;
    version?: number;
  };
}) {
  const [reader, setReader] = useState(false);
  if (!artifact.url) return null;
  const kind = (artifact.kind === "video" || artifact.kind === "html" ? artifact.kind : "image") as
    | "image"
    | "video"
    | "html";
  const card: ArtifactCard = {
    id: artifact.artifactId ?? artifact.url,
    kind,
    url: artifact.url,
    title: artifact.title,
    caption: artifact.caption ?? artifact.text,
    sessionId: "",
    version: artifact.version,
  };
  const label = artifact.title || artifact.caption || artifact.text;

  // HTML documents: compact tappable preview → full-screen reader, the same
  // doc-open gesture as tapping an .html file in Files.
  if (kind === "html") {
    return (
      <>
        <button
          type="button"
          onClick={() => setReader(true)}
          className="my-1.5 block w-full max-w-md overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-shadow active:scale-[0.99] hover:shadow-md"
        >
          <div className="relative h-40 overflow-hidden">
            <HtmlEmbed artifact={card} />
            {/* scrim so the mini preview reads as a tappable card, not a live page */}
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/25" />
            <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] font-medium text-white">
              <Maximize2 className="h-3 w-3" /> Tap to open
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-2">
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {label || card.id}
              {artifact.version && artifact.version > 1 ? (
                <span className="ml-2 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                  v{artifact.version}
                </span>
              ) : null}
            </span>
          </div>
        </button>
        {reader ? (
          <HtmlViewerOverlay
            title={label || card.id}
            src={artifact.url}
            onClose={() => setReader(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="my-1.5 w-full max-w-md overflow-hidden rounded-xl border bg-card shadow-sm">
      <ArtifactMedia artifact={card} />
      <div className="flex items-center gap-1.5 px-3 py-2">
        <KindIcon kind={kind} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {label || card.id}
          {artifact.version && artifact.version > 1 ? (
            <span className="ml-2 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              v{artifact.version}
            </span>
          ) : null}
        </span>
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
        >
          Open
        </a>
      </div>
    </div>
  );
}

export function ArtifactsView({
  onOpenSession,
}: {
  onOpenSession?: (sessionId: string) => void;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactCard[]>([]);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ArtifactCard | null>(null);

  const load = useCallback(async (k: string | null, offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set("limit", "60");
      if (offset) q.set("offset", String(offset));
      if (k) q.set("kind", k);
      const data = await getJson<{ artifacts: ArtifactCard[]; total: number }>(
        `/api/artifacts?${q}`,
      );
      setArtifacts((prev) => (offset ? [...prev, ...(data.artifacts ?? [])] : (data.artifacts ?? [])));
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(kind);
  }, [kind, load]);

  return (
    <div className="mx-auto w-full max-w-5xl px-3 pb-24 pt-3">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-lg font-semibold">Artifacts</h1>
        <button
          onClick={() => void load(kind)}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          title="Refresh"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </button>
        <div className="ml-auto flex gap-1">
          {KINDS.map((k) => (
            <button
              key={k.label}
              onClick={() => setKind(k.key)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium",
                kind === k.key
                  ? "bg-foreground text-background"
                  : "bg-accent text-muted-foreground hover:text-foreground",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
          {error}
        </div>
      ) : null}

      {!loading && !error && artifacts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Nothing published yet. Agents create artifacts with the LFG tools
          (display image / video, publish live HTML) — they'll show up here.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {artifacts.map((a) => (
          <button
            key={a.id}
            onClick={() => setOpen(a)}
            className="group overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="relative">
              <ArtifactMedia artifact={a} />
              <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
                <KindIcon kind={a.kind} className="h-3 w-3" />
                {a.kind}
                {a.version && a.version > 1 ? ` · v${a.version}` : ""}
              </span>
            </div>
            <div className="p-2">
              <div className="truncate text-xs font-medium">
                {a.title || a.caption || a.name || a.id}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {a.sessionTitle || a.sessionId.slice(0, 8)} · {timeAgo(a.ts)}
              </div>
            </div>
          </button>
        ))}
      </div>

      {artifacts.length < total ? (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => void load(kind, artifacts.length)}
            disabled={loading}
            className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : `Load more (${total - artifacts.length})`}
          </button>
        </div>
      ) : null}

      {open ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
          onClick={() => setOpen(null)}
        >
          <div
            className="mx-auto mt-6 w-full max-w-3xl flex-1 overflow-y-auto px-3 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="overflow-hidden rounded-xl border bg-card shadow-xl">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <KindIcon kind={open.kind} className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1 truncate text-sm font-medium">
                  {open.title || open.caption || open.name || open.id}
                  {open.version && open.version > 1 ? (
                    <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-[10px] text-muted-foreground">
                      updated · v{open.version}
                    </span>
                  ) : null}
                </div>
                <button
                  onClick={() => setOpen(null)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <ArtifactMedia artifact={open} full />
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {open.sessionTitle || open.sessionId.slice(0, 8)} · {timeAgo(open.ts)}
                </span>
                {onOpenSession ? (
                  <button
                    className="ml-auto shrink-0 rounded-md border px-2 py-1 hover:bg-accent"
                    onClick={() => {
                      onOpenSession(open.sessionId);
                      setOpen(null);
                    }}
                  >
                    Open session
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

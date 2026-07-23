// ShippedView — the showcase feed. When an agent finishes something real it
// posts a card here (title + summary + media) via the lfg_ship MCP tool.
// Re-posting the same id updates in place with an "updated · vN" badge.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Package, RefreshCw } from "lucide-react";
import { getJson } from "@/lib/api";
import { cn } from "@/lib/utils";

type ShipMedia = {
  artifactId: string;
  kind: "image" | "video" | "html";
  url: string;
  name?: string;
  caption?: string;
  version?: number;
  updatedAt?: number;
};

type ShipPost = {
  id: string;
  rev: number;
  ts: number;
  firstTs: number;
  revisions: number;
  title: string;
  summary?: string;
  sessionId?: string;
  sessionTitle?: string;
  agent?: string;
  project?: string;
  mediaItems?: ShipMedia[];
};

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

function PostMedia({ media }: { media: ShipMedia[] }) {
  const visible = media.filter((m) => m.url);
  if (!visible.length) return null;
  return (
    <div className={cn("grid gap-1", visible.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
      {visible.map((m, i) => {
        const src = m.url;
        if (m.kind === "video")
          return (
            <video
              key={i}
              src={src}
              controls
              playsInline
              preload="metadata"
              className="max-h-96 w-full bg-black"
            />
          );
        if (m.kind === "html")
          return (
            <iframe
              key={i}
              src={src}
              title={m.caption || `embed-${i}`}
              sandbox="allow-scripts"
              className="h-64 w-full border-0 bg-white dark:bg-zinc-900"
            />
          );
        return (
          <img
            key={m.artifactId}
            src={src}
            alt={m.caption || ""}
            loading="lazy"
            className="max-h-96 w-full object-cover"
          />
        );
      })}
    </div>
  );
}

export function ShippedView({
  onOpenSession,
}: {
  onOpenSession?: (sessionId: string) => void;
}) {
  const [posts, setPosts] = useState<ShipPost[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set("limit", "30");
      if (offset) q.set("offset", String(offset));
      const data = await getJson<{ posts: ShipPost[]; total: number }>(`/api/shipped?${q}`);
      setPosts((prev) => (offset ? [...prev, ...(data.posts ?? [])] : (data.posts ?? [])));
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-2xl px-3 pb-24 pt-3">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-lg font-semibold">Shipped</h1>
        <button
          onClick={() => void load()}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          title="Refresh"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
          {error}
        </div>
      ) : null}

      {!loading && !error && posts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          <Package className="mx-auto mb-2 h-6 w-6" />
          Nothing shipped yet. When an agent finishes real work it posts the
          result here (the lfg_ship tool).
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        {posts.map((post) => (
          <article key={post.id} className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-start gap-2 px-3 pt-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold leading-snug">
                  {post.title}
                  {post.revisions > 1 ? (
                    <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
                      updated · v{post.revisions}
                    </span>
                  ) : null}
                </h2>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {[post.agent, post.sessionTitle || post.sessionId?.slice(0, 8), post.project]
                    .filter(Boolean)
                    .join(" · ")}
                  {" · "}
                  {timeAgo(post.ts)}
                </div>
              </div>
              {post.sessionId && onOpenSession ? (
                <button
                  className="shrink-0 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                  onClick={() => onOpenSession(post.sessionId!)}
                >
                  Session
                </button>
              ) : null}
            </div>
            {post.summary ? (
              <p className="whitespace-pre-wrap px-3 pb-1 pt-2 text-sm text-foreground/90">
                {post.summary}
              </p>
            ) : null}
            <div className="mt-2">
              <PostMedia media={post.mediaItems ?? []} />
            </div>
          </article>
        ))}
      </div>

      {posts.length < total ? (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => void load(posts.length)}
            disabled={loading}
            className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : `Load more (${total - posts.length})`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

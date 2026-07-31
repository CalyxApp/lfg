// VaultFileOverlay — opens a vault file tapped inside a report, using the SAME
// endpoints + renderers as the Files tab (reuse where it counts):
//   markdown -> /api/repos/file + <Streamdown>   (matches FilesView's MarkdownDoc)
//   html     -> /api/repos/raw  + HtmlViewerOverlay (the shared reader)
//   image/pdf-> /api/repos/raw  inline
// Stacks above the report overlay (z-[110]); its own X/Escape returns to the
// report. Resolved against the primary repo (repo prop, e.g. PlatosRaveCave).

import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { getJson } from "@/lib/api";
import { HtmlViewerOverlay } from "./HtmlViewerOverlay";

const MD_RE = /\.mdx?$/i;
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const HTML_RE = /\.html?$/i;
const PDF_RE = /\.pdf$/i;

type FileResult = { path: string; size: number; content?: string; binary?: boolean; tooLarge?: boolean };

// A bare vault path (e.g. `projects/foo` or `projects/foo/`) refers to that
// folder's canonical doc — Calyx's convention is `index.md`. Explicit files
// (already carry an extension) pass through untouched.
function resolveVaultPath(path: string): string {
  const clean = path.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const leaf = clean.split("/").pop() || clean;
  return /\.[A-Za-z0-9]+$/.test(leaf) ? clean : `${clean}/index.md`;
}

function stripFrontmatter(src: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(src);
  return m ? src.slice(m[0].length) : src;
}

function OverlayShell({
  title,
  rawUrl,
  onClose,
  children,
}: {
  title: string;
  rawUrl?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[110] flex flex-col bg-background">
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 pb-2 backdrop-blur"
        style={{ paddingTop: "max(env(safe-area-inset-top), 0.5rem)" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
        >
          <X className="size-[18px]" />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-sm font-medium">{title}</div>
        {rawUrl ? (
          <a
            href={rawUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in browser"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
          >
            <ExternalLink className="size-[18px]" />
          </a>
        ) : (
          <span className="size-8 shrink-0" />
        )}
      </div>
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {children}
      </div>
    </div>
  );
}

export function VaultFileOverlay({
  repo,
  path,
  onClose,
}: {
  repo: string;
  path: string;
  onClose: () => void;
}) {
  const resolved = resolveVaultPath(path);
  const isHtml = HTML_RE.test(resolved);
  const isImg = IMG_RE.test(resolved);
  const isPdf = PDF_RE.test(resolved);
  const isMd = MD_RE.test(resolved);
  // Text content is fetched for markdown and any other non-binary text file.
  const needsContent = !isHtml && !isImg && !isPdf;

  const title = (resolved.split("/").pop() || resolved).replace(/\.mdx?$/i, "");
  const rawUrl = `/api/repos/raw?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(resolved)}`;

  const [state, setState] = useState<{ loading: boolean; error?: string; file?: FileResult }>({
    loading: needsContent,
  });

  useEffect(() => {
    if (!needsContent) return;
    let cancelled = false;
    setState({ loading: true });
    getJson<FileResult>(
      `/api/repos/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(resolved)}`,
    )
      .then((file) => {
        if (!cancelled) setState({ loading: false, file });
      })
      .catch((e) => {
        if (!cancelled) setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [repo, resolved, needsContent]);

  // HTML reuses the shared full-screen reader (owns its own Esc/close).
  if (isHtml) return <HtmlViewerOverlay title={title} src={rawUrl} onClose={onClose} />;

  return (
    <OverlayShell title={title} rawUrl={rawUrl} onClose={onClose}>
      <div className="mx-auto w-full max-w-2xl px-3 py-4">
        {isImg ? (
          <img src={rawUrl} alt={resolved} className="mx-auto max-w-full rounded-2xl border border-border bg-card/40" />
        ) : isPdf ? (
          <iframe
            src={rawUrl}
            title={resolved}
            sandbox="allow-scripts"
            className="h-[80dvh] w-full rounded-2xl border border-border bg-white"
          />
        ) : state.loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : state.error ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
            Couldn’t open <span className="font-mono">{resolved}</span> — {state.error}
          </div>
        ) : state.file?.binary ? (
          <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Binary file — can’t preview.
          </div>
        ) : state.file?.tooLarge ? (
          <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Too large to preview on mobile.
          </div>
        ) : isMd ? (
          <article className="markdown rounded-2xl border border-border bg-card/40 px-4 py-4 text-[15px] leading-relaxed [&_pre]:overflow-x-auto">
            <Streamdown>{stripFrontmatter(state.file?.content ?? "")}</Streamdown>
          </article>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-border bg-card/40 px-4 py-3 font-mono text-xs leading-relaxed">
            {state.file?.content}
          </pre>
        )}
      </div>
    </OverlayShell>
  );
}

// HtmlViewerOverlay — full-screen reader for HTML documents (repo files and
// artifacts). Sam's vault treats single-file HTML dashboards the way most
// vaults treat markdown, so opening one should feel like opening a doc: tap →
// full-screen takeover, slim toolbar (title · open in browser · close), body
// rendered in the same locked-down sandbox the artifact pipeline uses.

import { useEffect } from "react";
import { ExternalLink, X } from "lucide-react";

export function HtmlViewerOverlay({
  title,
  src,
  onClose,
}: {
  title: string;
  src: string;
  onClose: () => void;
}) {
  // Escape closes; lock body scroll while open.
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
    <div className="fixed inset-0 z-[100] flex flex-col bg-background">
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
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in browser"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
        >
          <ExternalLink className="size-[18px]" />
        </a>
      </div>
      <iframe
        src={src}
        title={title}
        sandbox="allow-scripts"
        className="w-full flex-1 border-0 bg-white dark:bg-zinc-900"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      />
    </div>
  );
}

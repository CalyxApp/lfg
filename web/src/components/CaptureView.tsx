// CaptureView — the ＋ tab: jot or dictate a thought on the phone, land it in a
// repo as a dated markdown note under inbox/, auto-committed. Obsidian-style
// quick capture; remembers the last-used repo. The mic is dictation-only (fills
// the body; no silence-auto-save) — committing a file stays a deliberate tap.

import { useEffect, useState } from "react";
import { Check, Loader2, PenLine } from "lucide-react";
import { postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Textarea } from "./ui/textarea";
import { Input } from "./ui/input";
import { MicButton } from "./dictation";

type Repo = { name: string; project?: string; custom?: boolean };

const LAST_REPO_KEY = "lfg.capture.repo";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function CaptureView({ repos }: { repos: Repo[] }) {
  const [repo, setRepo] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Repos arrive async; resolve the default (last used → first) once they land.
  useEffect(() => {
    if (repo || !repos.length) return;
    const last = localStorage.getItem(LAST_REPO_KEY);
    setRepo(last && repos.some((r) => r.name === last) ? last : repos[0]!.name);
  }, [repos, repo]);

  async function save() {
    const text = body.trim();
    if (!text || !repo || saving) return;
    setSaving(true);
    setError(null);
    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const slug = slugify(title || text.split("\n")[0] || "");
    const path = `inbox/${date}-${pad(now.getHours())}${pad(now.getMinutes())}${slug ? `-${slug}` : ""}.md`;
    const fm = [
      "---",
      "type: note",
      ...(title.trim() ? [`title: ${JSON.stringify(title.trim())}`] : []),
      `captured: ${date} ${time}`,
      "---",
      "",
    ].join("\n");
    try {
      const res = await postJson<{ path: string; commit: string | null }>("/api/repos/write", {
        repo,
        path,
        content: `${fm}${text}\n`,
        createOnly: true,
        message: `mobile: capture ${path}`,
      });
      localStorage.setItem(LAST_REPO_KEY, repo);
      setSavedPath(res.path);
      setTitle("");
      setBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 pb-10">
      <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Quick capture
      </h2>

      {/* Repo pills */}
      {repos.length > 1 ? (
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

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        autoCapitalize="sentences"
      />
      <div className="relative">
        <Textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (savedPath) setSavedPath(null);
          }}
          placeholder="What's on your mind?"
          rows={8}
          className="min-h-40 pb-12 text-[15px] leading-relaxed"
        />
        <MicButton
          minimal
          className="absolute bottom-2 right-2 size-9"
          baseText={body}
          onText={(text, base) => {
            setBody(base.trim() ? `${base.trimEnd()} ${text}` : text);
            if (savedPath) setSavedPath(null);
          }}
          onInterim={(text, base) => setBody(base.trim() ? `${base.trimEnd()} ${text}` : text)}
          onCancel={(base) => setBody(base)}
        />
      </div>

      {error ? (
        <div className="mx-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {savedPath ? (
        <div className="mx-1 flex items-center gap-2 rounded-xl border border-border bg-card/40 px-3 py-2 text-sm text-muted-foreground">
          <Check className="size-4 shrink-0 text-[var(--success)]" />
          <span className="min-w-0 truncate">
            Saved to <span className="font-medium text-foreground">{savedPath}</span>
          </span>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={!body.trim() || !repo || saving}
        className={cn(
          "flex h-11 items-center justify-center gap-2 rounded-full text-sm font-semibold tracking-[-0.01em] transition-all duration-150 ease-ios active:scale-[0.98]",
          body.trim() && repo && !saving
            ? "bg-primary text-white"
            : "bg-secondary text-muted-foreground",
        )}
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : <PenLine className="size-4" />}
        {saving ? "Saving…" : "Save note"}
      </button>
    </div>
  );
}

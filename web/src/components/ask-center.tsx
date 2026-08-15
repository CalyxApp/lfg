// AskCenter — the human-in-the-loop reply surface. Polls /api/ask for open
// questions raised by headless agents (the supervisor) and lets the user answer
// by tapping a suggested option or typing. Answers POST back to
// /api/ask/<id>/answer, which wakes the agent's blocked long-poll.
//
// Three surfaces share one poll loop via <AskProvider>:
//   • <AskNavButton/>  — a top-right island button with an unanswered badge;
//                        the persistent home for the feature. Opens the page,
//                        and is where a collapsed queue re-surfaces from.
//   • <AskCenter/>     — a compact floating card for the next question. Can be
//                        collapsed (tucked away to the nav badge) or expanded
//                        to the full page.
//   • <AskPage/>       — a full app page (its own tab) listing every open
//                        question, each answerable inline. Front and centre for
//                        working the whole queue.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Streamdown } from "streamdown";
import { HtmlViewerOverlay } from "./HtmlViewerOverlay";
import {
  Bot,
  Check,
  FileText,
  Image as ImageIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Maximize2,
  MessageCircleQuestion,
  Send,
  X,
} from "lucide-react";

type Question = {
  id: string;
  question: string;
  options?: string[];
  agentId?: string | null;
  sessionId?: string | null;
  createdAt: number;
};

// ── Calyx asks ───────────────────────────────────────────────────────────────
// A second kind of question, from a different world. An LFG question comes from
// an agent that is still running and long-polling for your reply. A Calyx ask
// comes from an agent task that hit a fork, wrote its question into the vault,
// and *exited* — so it survives restarts and days of silence, and your answer is
// what starts the work again. Same inbox, different promise; the UI says which.
type CalyxAskOption = {
  label: string;
  description?: string;
  recommended?: boolean;
  /** A vault file that IS this option — an HTML mockup, a diagram. */
  preview?: string;
};

type CalyxAskQuestion = {
  text: string;
  header?: string;
  options: CalyxAskOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  /** Vault files to look at before deciding. */
  attachments?: string[];
};

type CalyxAsk = {
  id: string;
  path: string;
  title: string;
  reason?: string;
  questions: CalyxAskQuestion[];
  project?: string;
  agent?: string;
  /** Answer already written; the runner just hasn't picked it up yet. */
  answered: boolean;
  answer?: string;
  repo: string;
};

const POLL_MS = 5000;

type AskContextValue = {
  questions: Question[];
  busy: boolean;
  answer: (q: Question, text: string) => Promise<void>;
  /** Tuck the floating card away "for later" without answering. */
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  /** Stopped agent tasks waiting on a decision. */
  calyxAsks: CalyxAsk[];
  answerCalyx: (ask: CalyxAsk, text: string) => Promise<void>;
};

const AskContext = createContext<AskContextValue | null>(null);

function useAsk(): AskContextValue {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAsk must be used within <AskProvider>");
  return ctx;
}

// Read-only count of everything waiting on you — for nav badges etc.
// Answered-but-not-yet-resumed Calyx asks are excluded: they no longer need you.
export function useAskCount(): number {
  const { questions, calyxAsks } = useAsk();
  return questions.length + calyxAsks.filter((a) => !a.answered).length;
}

// Owns the single poll loop + queue + shared UI state so the nav button, the
// floating card, and the page all read one source of truth.
export function AskProvider({ children }: { children: React.ReactNode }) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [calyxAsks, setCalyxAsks] = useState<CalyxAsk[]>([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const seenCalyx = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      // Prefer this device's filtered feed (scoped to the push-bound user) so we
      // never surface another user's question. Falls back to the open list when
      // notifications aren't enabled on this device.
      let feedUrl = "/api/ask?status=open";
      try {
        if ("serviceWorker" in navigator && "PushManager" in window) {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub?.endpoint)
            feedUrl = `/api/push/pending?endpoint=${encodeURIComponent(sub.endpoint)}`;
        }
      } catch {
        // no subscription — keep the unscoped fallback
      }
      const res = await fetch(feedUrl, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { questions: Question[] };
      const qs = data.questions || [];
      // Oldest-first so we work the queue in order.
      qs.sort((a, b) => a.createdAt - b.createdAt);
      setQuestions(qs);
      let fresh = false;
      for (const q of qs) {
        if (!seen.current.has(q.id)) {
          seen.current.add(q.id);
          fresh = true;
          toast("An agent needs your input", { description: q.question });
        }
      }
      // A genuinely new question overrides a "collapse for later" — surface it.
      if (fresh) setCollapsed(false);
    } catch {
      // transient — next tick retries
    }
  }, []);

  // Calyx asks live in the vault, so they change on the runner's clock, not
  // ours — a slower poll is plenty and keeps a phone off the network.
  const refreshCalyx = useCallback(async () => {
    try {
      const res = await fetch("/api/vault/asks", { cache: "no-store" });
      if (!res.ok) return; // no vault configured on this server — feature is simply absent
      const data = (await res.json()) as { asks?: CalyxAsk[] };
      const asks = data.asks || [];
      setCalyxAsks(asks);
      for (const a of asks) {
        if (a.answered || seenCalyx.current.has(a.id)) continue;
        seenCalyx.current.add(a.id);
        toast("An agent task stopped to ask you something", { description: a.title });
      }
    } catch {
      // transient — next tick retries
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshCalyx();
    const t = setInterval(() => void refresh(), POLL_MS);
    const tc = setInterval(() => void refreshCalyx(), POLL_MS * 3);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(t);
      clearInterval(tc);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [refresh, refreshCalyx]);

  const answer = useCallback(
    async (q: Question, text: string) => {
      if (busy || !text.trim()) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/ask/${q.id}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: text.trim(), via: "web" }),
        });
        if (!res.ok) throw new Error(await res.text());
        // Drop it locally so the next question shows immediately; the poll
        // reconciles shortly after.
        setQuestions((prev) => prev.filter((x) => x.id !== q.id));
        toast("Sent to the agent");
      } catch {
        toast.error("Could not send your answer");
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  // Answering a Calyx ask writes into the task file — which IS the resumption.
  // There is no "send to the agent" here: the agent is gone. The runner notices
  // the written answer on its next tick and starts a fresh attempt with your
  // words in its context.
  const answerCalyx = useCallback(
    async (ask: CalyxAsk, text: string) => {
      if (busy || !text.trim()) return;
      setBusy(true);
      try {
        const res = await fetch("/api/vault/asks/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: ask.repo, path: ask.path, answer: text.trim() }),
        });
        if (!res.ok) throw new Error(await res.text());
        // Optimistic: flip to "answered" rather than removing it, so you can see
        // what you said while the runner picks it up.
        setCalyxAsks((prev) =>
          prev.map((a) => (a.id === ask.id ? { ...a, answered: true, answer: text.trim() } : a)),
        );
        toast("Answer saved — the task will pick it up", {
          description: "Runs on your server, so it resumes even with this closed.",
        });
      } catch {
        toast.error("Could not save your answer");
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  return (
    <AskContext.Provider
      value={{ questions, busy, answer, collapsed, setCollapsed, calyxAsks, answerCalyx }}
    >
      {children}
    </AskContext.Provider>
  );
}

// Top-right island button — the persistent entry point. Shows an unanswered
// count badge and a gentle pulse when agents are waiting; muted when the queue
// is empty. Tapping opens the page (and un-collapses).
export function AskNavButton({
  active,
  onOpen,
}: {
  active?: boolean;
  onOpen: () => void;
}) {
  const { questions, calyxAsks, setCollapsed } = useAsk();
  // One badge for both kinds — the user doesn't care which system asked, only
  // that something is waiting on them.
  const count = questions.length + calyxAsks.filter((a) => !a.answered).length;
  const waiting = count > 0;
  // Always present (Sam, 2026-08-16). This is the inbox — a door you can only
  // find when something is already behind it isn't a door. It used to hide when
  // the queue was empty, which meant answering the last question made the way
  // back disappear. Empty state is muted; the badge and the pulse are what
  // change, not the button's existence.
  return (
    <button
      type="button"
      onClick={() => {
        setCollapsed(false);
        onOpen();
      }}
      aria-current={active ? "page" : undefined}
      aria-label={
        waiting
          ? `Inbox — ${count} waiting for you`
          : "Inbox — nothing waiting"
      }
      title={waiting ? `${count} waiting for you` : "Inbox"}
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ease-out active:scale-[0.96]",
        active
          ? "bg-primary/12 text-primary"
          : waiting
            ? "bg-primary/12 text-primary"
            : "text-muted-foreground hover:text-foreground",
      )}
    >
      {waiting && !active ? (
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/15" />
      ) : null}
      <MessageCircleQuestion className="relative size-[18px]" />
      {waiting ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground">
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </button>
  );
}

// Compact floating card for the next question. Hidden when collapsed.
export function AskCenter({ onExpand }: { onExpand: () => void }) {
  const { questions, busy, answer, setCollapsed, collapsed } = useAsk();
  const [draft, setDraft] = useState("");
  const current = questions[0] ?? null;

  // Reset the draft whenever the active question changes.
  useEffect(() => {
    setDraft("");
  }, [current?.id]);

  if (!current || collapsed) return null;

  const queued = questions.length - 1;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-[var(--lfg-orb-stack-bottom)]">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-primary/30 bg-background p-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.28)]">
        <div className="mb-2 flex items-start gap-2">
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <MessageCircleQuestion className="size-3.5" />
          </div>
          <button
            type="button"
            onClick={onExpand}
            className="min-w-0 flex-1 text-left"
          >
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Agent needs your input{queued > 0 ? ` · ${queued} more` : ""}
            </div>
            <div className="mt-0.5 text-sm font-medium leading-snug">
              {current.question}
            </div>
          </button>
          <div className="-mr-1 -mt-1 flex shrink-0 items-center">
            <button
              type="button"
              onClick={onExpand}
              aria-label="Open all questions"
              title="Open all questions"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Maximize2 className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse for later"
              title="Collapse for later"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
        </div>

        {current.options?.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {current.options.map((o) => (
              <Button
                key={o}
                variant="tint"
                size="sm"
                disabled={busy}
                onClick={() => void answer(current, o)}
              >
                {o}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-1.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type a reply…"
            rows={1}
            className="max-h-28 min-h-9 flex-1 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void answer(current, draft);
              }
            }}
          />
          <Button
            size="icon-sm"
            disabled={busy || !draft.trim()}
            onClick={() => void answer(current, draft)}
            aria-label="Send answer"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// Full app page (its own tab) — a Tinder-style deck of open questions. The top
// card is answerable inline; swipe (or arrow) to move through the stack.
// ── The Calyx ask card ───────────────────────────────────────────────────────
// Order is deliberate and settled with Sam: orientation → the question → the
// options → the briefing. You need to know what you're reading *for*; and when
// you already have the context you answer in one glance instead of scrolling
// past a briefing you didn't need.
//
// Every option stays visible — they get smaller, never fewer. A hidden option is
// one you won't consider. What collapses is the briefing.
function CalyxAskCard({ ask }: { ask: CalyxAsk }) {
  const { answerCalyx, busy } = useAsk();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [body, setBody] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);

  const q = ask.questions[0];
  const multi = q?.multiSelect === true;


  // The briefing is fetched only when opened — a list of twenty asks shouldn't
  // drag twenty note bodies onto a phone.
  useEffect(() => {
    if (!open || body !== null) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/vault/asks/body?repo=${encodeURIComponent(ask.repo)}&path=${encodeURIComponent(ask.path)}`,
          { cache: "no-store" },
        );
        const data = res.ok ? ((await res.json()) as { body?: string }) : {};
        if (alive) setBody(data.body || "");
      } catch {
        if (alive) setBody("");
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, body, ask.repo, ask.path]);

  const send = (value: string) => void answerCalyx(ask, value);

  const toggle = (label: string) => {
    if (!multi) {
      send(label);
      return;
    }
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  };

  if (ask.answered) {
    return (
      <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Check className="size-4 text-primary" />
          Answered — restarting
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{ask.title}</div>
        {ask.answer ? (
          <div className="mt-2 rounded-lg bg-background/60 px-3 py-2 text-sm">“{ask.answer}”</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="p-4">
        {/* Orientation — which piece of work is stopped. */}
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Bot className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {ask.project ? `${ask.project} · ` : ""}
            {ask.title}
          </span>
        </div>

        {/* The question. */}
        <div className="mt-2 text-[15px] font-medium leading-snug">
          {q?.text || ask.reason || "This task needs a decision from you."}
        </div>

        {/* Things to look at before deciding. Above the options deliberately —
            if the agent thought you needed to see something, you need it before
            you choose, not after. */}
        {q?.attachments?.length ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {q.attachments.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setViewing(a)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs hover:bg-muted/60 active:scale-[0.98]"
              >
                {isImagePath(a) ? (
                  <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="max-w-[13rem] truncate">{fileLabel(a)}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* The options — each stating its consequence. */}
        {q?.options?.length ? (
          <div className="mt-3 flex flex-col gap-2">
            {q.options.map((o) => {
              const on = picked.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(o.label)}
                  className={cn(
                    "w-full rounded-xl border px-3 py-2.5 text-left transition-colors active:scale-[0.99] disabled:opacity-60",
                    on
                      ? "border-primary bg-primary/10"
                      : "border-border bg-background hover:bg-muted/60",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{o.label}</span>
                    {o.recommended ? (
                      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Recommended
                      </span>
                    ) : null}
                    {multi && on ? <Check className="ml-auto size-4 text-primary" /> : null}
                  </div>
                  {o.description ? (
                    <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
                      {o.description}
                    </div>
                  ) : null}
                  {/* Looking must not mean choosing. When the option IS a
                      rendered thing, you need to open it before you can decide,
                      so previewing is its own tap. */}
                  {o.preview ? (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setViewing(o.preview!);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setViewing(o.preview!);
                        }
                      }}
                      className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/70"
                    >
                      <Maximize2 className="size-3" />
                      Preview
                    </span>
                  ) : null}
                </button>
              );
            })}
            {multi ? (
              <Button
                size="sm"
                disabled={busy || picked.length === 0}
                onClick={() => send(picked.join(", "))}
              >
                Send {picked.length || ""}
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Free text. Any reply wakes the agent — including "I don't follow". */}
        <div className="mt-3 flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={q?.options?.length ? "Or say something else…" : "Your answer…"}
            rows={2}
            className="min-h-[44px] resize-none text-sm"
          />
          <Button
            size="icon"
            disabled={busy || !text.trim()}
            onClick={() => {
              send(text);
              setText("");
            }}
            aria-label="Send answer"
          >
            <Send className="size-4" />
          </Button>
        </div>

        {/* The promise — honest about where it runs. */}
        <div className="mt-2 text-[11px] text-muted-foreground">
          Answering restarts this task on your server — it resumes even with this closed.
        </div>
      </div>

      {/* The briefing, collapsed. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground hover:bg-muted/40"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {open ? "Hide the details" : "Why it stopped, and where it got to"}
      </button>
      {open ? (
        <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
          {ask.reason ? (
            <div className="mb-2 text-xs font-medium">{ask.reason}</div>
          ) : null}
          {body === null ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : body ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
              {body}
            </pre>
          ) : (
            <div className="text-xs text-muted-foreground">
              No briefing was written for this one.
            </div>
          )}
        </div>
      ) : null}

      {viewing ? (
        <AttachmentOverlay repo={ask.repo} path={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const isImagePath = (p: string) => IMAGE_RE.test(p);
/** What the raw endpoint will actually serve — anything else needs the text path. */
const IFRAME_RE = /\.(html?|png|jpe?g|gif|webp|svg|avif|pdf)$/i;
/** Last path segment, which is what a human recognises. */
const fileLabel = (p: string) => p.split("/").filter(Boolean).pop() || p;

/**
 * Open one attachment, by the route its type actually supports.
 *
 * HTML, images and PDFs go through the raw endpoint and the shared sandboxed
 * viewer — CSP `sandbox allow-scripts`, nosniff, no network. Markdown and plain
 * text do NOT: the raw endpoint's type allowlist deliberately excludes them, so
 * they come back as JSON and render through the app's own markdown renderer.
 * That is the safer half anyway — React rendering, no iframe, nothing executes.
 */
function AttachmentOverlay({
  repo,
  path,
  onClose,
}: {
  repo: string;
  path: string;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const iframeable = IFRAME_RE.test(path);

  useEffect(() => {
    if (iframeable) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/repos/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error("unreadable");
        const data = (await res.json()) as {
          content?: string;
          tooLarge?: boolean;
          binary?: boolean;
        };
        if (!alive) return;
        // readRepoFile answers honestly instead of returning junk for these.
        if (data.tooLarge) setText("_This file is too large to preview here._");
        else if (data.binary) setText("_This file isn't text, so there's nothing to show._");
        else setText(data.content ?? "");
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [repo, path, iframeable]);

  if (iframeable) {
    return (
      <HtmlViewerOverlay
        title={fileLabel(path)}
        src={`/api/repos/raw?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`}
        onClose={onClose}
      />
    );
  }

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
          className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <X className="size-5" />
        </button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{fileLabel(path)}</div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {failed ? (
          <div className="text-sm text-muted-foreground">Couldn't open this file.</div>
        ) : text === null ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <Streamdown>{text}</Streamdown>
          </div>
        )}
      </div>
    </div>
  );
}

/** The "work is stopped" section — Calyx agent tasks waiting on a decision. */
function CalyxAskSection() {
  const { calyxAsks } = useAsk();
  if (calyxAsks.length === 0) return null;
  const waiting = calyxAsks.filter((a) => !a.answered).length;
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-medium">Work is stopped</h2>
        <span className="text-xs text-muted-foreground">
          {waiting > 0
            ? `${waiting} task${waiting === 1 ? "" : "s"} waiting on you`
            : "all answered"}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {calyxAsks.map((a) => (
          <CalyxAskCard key={a.id} ask={a} />
        ))}
      </div>
    </div>
  );
}

export function AskPage() {
  const { questions, calyxAsks } = useAsk();
  const count = questions.length;
  const calyxWaiting = calyxAsks.filter((a) => !a.answered).length;
  const total = count + calyxWaiting;
  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col overflow-y-auto">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <MessageCircleQuestion className="size-6" />
        </div>
        <div>
          <h1 className="font-heading text-lg font-medium tracking-[-0.01em]">
            Questions for you
          </h1>
          <p className="text-sm text-muted-foreground">
            {total > 0
              ? `${total} waiting on your input`
              : "You're all caught up"}
          </p>
        </div>
      </div>

      {/* Stopped agent tasks first — these are the ones holding work up. */}
      <CalyxAskSection />

      {count === 0 && calyxAsks.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Inbox className="size-7" />
          </div>
          <div className="text-sm font-medium">No questions right now</div>
          <div className="max-w-xs text-xs text-muted-foreground">
            When an agent needs a decision, it'll show up here and you'll get a
            notification.
          </div>
        </div>
      ) : count > 0 ? (
        <SwipeStack questions={questions} />
      ) : null}
    </div>
  );
}

const SWIPE_THRESHOLD = 90; // px of horizontal drag that commits a navigation
const FLY_MS = 200; // off-screen / settle animation duration

// The card deck. Holds the active index and the live drag offset; renders the
// top card (draggable, interactive) plus up to two scaled "peek" cards behind.
function SwipeStack({ questions }: { questions: Question[] }) {
  const { answer } = useAsk();
  const [pos, setPos] = useState(0);
  const [dx, setDx] = useState(0);
  const [releasing, setReleasing] = useState<
    null | "next" | "prev" | "back" | "answered"
  >(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const len = questions.length;
  // Keep pos valid as questions get answered/added underneath us.
  useEffect(() => {
    if (pos > len - 1) setPos(Math.max(0, len - 1));
  }, [len, pos]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const cur = Math.min(pos, len - 1);
  const hasNext = cur < len - 1;
  const hasPrev = cur > 0;

  const go = useCallback(
    (dir: "next" | "prev") => {
      if ((dir === "next" && !hasNext) || (dir === "prev" && !hasPrev)) {
        // Nothing there — rubber-band back to centre.
        setReleasing("back");
        setDx(0);
        timer.current = setTimeout(() => setReleasing(null), FLY_MS);
        return;
      }
      setReleasing(dir);
      timer.current = setTimeout(() => {
        setPos((p) =>
          Math.max(0, Math.min(len - 1, dir === "next" ? p + 1 : p - 1)),
        );
        setDx(0);
        setReleasing(null);
      }, FLY_MS);
    },
    [hasNext, hasPrev, len],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    if (releasing) return;
    dragging.current = true;
    startX.current = e.clientX;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setDx(e.clientX - startX.current);
  };
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (dx <= -SWIPE_THRESHOLD) go("next");
    else if (dx >= SWIPE_THRESHOLD) go("prev");
    else {
      setReleasing("back");
      setDx(0);
      timer.current = setTimeout(() => setReleasing(null), FLY_MS);
    }
  };

  // Answer the top card with a fly-up, then hand off to the queue (which drops
  // it and floats the next card forward).
  const handleAnswer = useCallback(
    (text: string) => {
      if (!text.trim() || releasing) return;
      const q = questions[cur];
      setReleasing("answered");
      timer.current = setTimeout(() => {
        void answer(q, text);
        setDx(0);
        setReleasing(null);
      }, FLY_MS);
    },
    [answer, cur, questions, releasing],
  );

  // Top-card transform: follow the finger while dragging, fly off on commit,
  // up-and-out when answered, spring back otherwise.
  let topTransform: string;
  let topOpacity = 1;
  if (releasing === "next") topTransform = "translateX(-130%) rotate(-12deg)";
  else if (releasing === "prev") topTransform = "translateX(130%) rotate(12deg)";
  else if (releasing === "answered") {
    topTransform = "translateY(-130%) scale(0.92)";
    topOpacity = 0;
  } else {
    const rot = Math.max(-12, Math.min(12, dx * 0.05));
    topTransform = `translateX(${dx}px) rotate(${rot}deg)`;
  }
  const topStyle: React.CSSProperties = {
    transform: topTransform,
    opacity: topOpacity,
    transition: dragging.current
      ? "none"
      : `transform ${FLY_MS}ms ease-out, opacity ${FLY_MS}ms ease-out`,
    touchAction: "pan-y",
  };

  // As you drag, the next peek card eases forward.
  const progress = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);
  const peeks = [questions[cur + 1], questions[cur + 2]].filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-1">
        {/* Peek cards behind, furthest first so the nearest paints on top. */}
        {peeks
          .map((q, depth) => ({ q, depth }))
          .reverse()
          .map(({ q, depth }) => {
            const base = (depth + 1) * 0.05;
            const scale = 1 - base + (depth === 0 ? base * progress : 0);
            const translateY = (depth + 1) * 14 - (depth === 0 ? 14 * progress : 0);
            return (
              <div
                key={q.id}
                className="absolute inset-0"
                style={{
                  transform: `translateY(${translateY}px) scale(${scale})`,
                  opacity: depth === 0 ? 0.7 + 0.3 * progress : 0.5,
                  transition: dragging.current ? "none" : "transform 200ms ease-out, opacity 200ms ease-out",
                }}
              >
                <QuestionCard q={q} index={cur + 1 + depth} interactive={false} />
              </div>
            );
          })}

        {/* Active card. */}
        <div
          key={questions[cur].id}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          style={topStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <QuestionCard
            q={questions[cur]}
            index={cur}
            interactive
            onAnswer={handleAnswer}
          />
          {/* Swipe-direction hints, fading in with drag distance. */}
          {hasPrev ? (
            <span
              className="pointer-events-none absolute left-4 top-4 rounded-full border border-border bg-background/90 px-3 py-1 text-xs font-bold uppercase tracking-wide text-muted-foreground shadow-sm"
              style={{ opacity: dx > 0 ? progress : 0 }}
            >
              ← Back
            </span>
          ) : null}
          {hasNext ? (
            <span
              className="pointer-events-none absolute right-4 top-4 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary shadow-sm"
              style={{ opacity: dx < 0 ? progress : 0 }}
            >
              Next →
            </span>
          ) : null}
        </div>
      </div>

      {/* Footer: arrows + position. Hidden for a single question. */}
      {len > 1 ? (
        <div className="mt-4 flex items-center justify-center gap-4">
          <Button
            variant="tint"
            size="icon-sm"
            disabled={!hasPrev || !!releasing}
            onClick={() => go("prev")}
            aria-label="Previous question"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="flex items-center gap-1.5">
            {questions.map((q, i) => (
              <span
                key={q.id}
                className={cn(
                  "h-1.5 rounded-full transition-all duration-200",
                  i === cur ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30",
                )}
              />
            ))}
          </div>
          <Button
            variant="tint"
            size="icon-sm"
            disabled={!hasNext || !!releasing}
            onClick={() => go("next")}
            aria-label="Next question"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// One question card. `interactive` cards (the top of the deck) own a draft and
// can be answered; peek cards behind are inert.
function QuestionCard({
  q,
  index,
  interactive,
  onAnswer,
}: {
  q: Question;
  index: number;
  interactive: boolean;
  onAnswer?: (text: string) => void;
}) {
  const { busy } = useAsk();
  const [draft, setDraft] = useState("");
  return (
    <div
      className={cn(
        "flex h-full select-none flex-col rounded-3xl border border-border bg-card p-5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]",
        // Entrance: the card surfacing to the top eases in. Keyed remount in the
        // stack replays this each time the deck advances.
        interactive && "animate-in fade-in zoom-in-95 duration-200 ease-out",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-[11px] font-bold text-primary">
          {index + 1}
        </div>
        {q.sessionId ? (
          <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {q.sessionId}
          </div>
        ) : (
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Agent needs your input
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="text-xl font-medium leading-snug tracking-[-0.01em]">
          {q.question}
        </div>
      </div>

      {interactive ? (
        <div className="mt-4 flex shrink-0 flex-col" data-no-drag>
          {q.options?.length ? (
            // Cap the option list so a long/large set scrolls instead of
            // shoving the reply box off the card; options wrap their own text.
            <div className="mb-2.5 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto overscroll-contain">
              {q.options.map((o) => (
                <Button
                  key={o}
                  variant="tint"
                  size="sm"
                  disabled={busy}
                  onClick={() => onAnswer?.(o)}
                  className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left"
                >
                  {o}
                </Button>
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-1.5">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a reply…"
              rows={1}
              className="max-h-32 min-h-9 flex-1 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onAnswer?.(draft);
                }
              }}
            />
            <Button
              size="icon-sm"
              disabled={busy || !draft.trim()}
              onClick={() => onAnswer?.(draft)}
              aria-label="Send answer"
            >
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

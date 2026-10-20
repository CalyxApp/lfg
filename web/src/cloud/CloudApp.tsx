// LFG on Calyx Cloud (LFG plan, L0): pair this phone with Calyx on a computer,
// and keep the pass.
//
// The pass is an HttpOnly cookie the chat server sets; this page never sees it.
// It asks the server who it is (/v1/me) instead. L2 replaces the plain chat
// list below with LFG's own chat screens.

import { backend } from "@/lib/backend";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessagesSquare, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Caption } from "@/components/ui/caption";
import { EmptyState } from "@/components/ui/empty-state";

type Chat = { chatId: string; title: string; updatedAt: number; engine: string | null };

type State =
  | { kind: "loading" }
  | { kind: "unpaired"; error?: string }
  | { kind: "pairing"; code: string; secret: string }
  | { kind: "expired" }
  | { kind: "paired"; vaultId: string; expiresAt: number; chats: Chat[] | null };

async function call(path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await backend.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function when(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const mins = Math.round((now.getTime() - t) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function CloudApp() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const pollTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    const me = await call("/v1/me").catch(() => null);
    if (!me || me.status !== 200) {
      setState({ kind: "unpaired" });
      return;
    }
    const { vaultId, expiresAt } = me.data as { vaultId: string; expiresAt: number };
    setState({ kind: "paired", vaultId, expiresAt, chats: null });
    const list = await call(`/v1/vaults/${encodeURIComponent(vaultId)}/chats`).catch(() => null);
    if (list?.status === 401) return setState({ kind: "unpaired" });
    setState({ kind: "paired", vaultId, expiresAt, chats: list?.status === 200 ? (list.data.chats as Chat[]) : [] });
  }, []);

  useEffect(() => {
    void load();
    return () => window.clearTimeout(pollTimer.current);
  }, [load]);

  const startPairing = async () => {
    const r = await call("/v1/pair/start", {}).catch(() => null);
    if (!r || r.status !== 200) return setState({ kind: "unpaired", error: "Could not get a code. Try again." });
    const { code, secret } = r.data as { code: string; secret: string };
    setState({ kind: "pairing", code, secret });
    const poll = async () => {
      const p = await call("/v1/pair/poll", { code, secret }).catch(() => null);
      if (p?.status === 200 && p.data?.status === "approved") return void load();
      if (!p || (p.status === 200 && p.data?.status === "waiting")) {
        pollTimer.current = window.setTimeout(poll, 2000);
        return;
      }
      setState({ kind: "expired" });
    };
    pollTimer.current = window.setTimeout(poll, 2000);
  };

  const forget = async () => {
    window.clearTimeout(pollTimer.current);
    await call("/v1/pair/forget", {}).catch(() => null);
    setState({ kind: "unpaired" });
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0 px-5 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">Calyx</h1>
      </header>

      {state.kind === "loading" && <div className="flex-1" />}

      {(state.kind === "unpaired" || state.kind === "expired") && (
        <EmptyState
          icon={<Smartphone className="size-5" />}
          title={state.kind === "expired" ? "This code expired" : "Pair this phone"}
          description="Follow and continue your Calyx chats from this phone. Pair it once with the computer Calyx runs on."
          action={
            <div className="flex flex-col items-center gap-2">
              <Button size="lg" onClick={() => void startPairing()}>
                {state.kind === "expired" ? "Get a new code" : "Pair this phone"}
              </Button>
              {state.kind === "unpaired" && state.error && <p className="text-xs text-destructive">{state.error}</p>}
            </div>
          }
        />
      )}

      {state.kind === "pairing" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
          <p className="max-w-[320px] text-sm leading-[1.45] text-muted-foreground">
            On your computer, open Calyx and run “Calyx: Pair a Phone for Chat”. Type this code:
          </p>
          <div className="rounded-2xl bg-foreground/[0.06] px-6 py-4 font-mono text-3xl font-semibold tracking-[0.08em] tabular-nums">
            {state.code.slice(0, 4)}-{state.code.slice(4)}
          </div>
          <Caption variant="meta">Waiting for your computer…</Caption>
        </div>
      )}

      {state.kind === "paired" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-1 px-5 pb-3">
            <p className="text-sm text-muted-foreground">This phone is paired with your vault.</p>
            <Caption variant="meta">
              Stays paired until {new Date(state.expiresAt).toLocaleDateString([], { day: "numeric", month: "short" })}
            </Caption>
          </div>
          <Caption className="px-5 pb-1 pt-3">Chats</Caption>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {state.chats === null ? null : state.chats.length === 0 ? (
              <EmptyState
                className="py-10"
                icon={<MessagesSquare className="size-5" />}
                title="No chats yet"
                description="Chats you open in Calyx on your computer show here."
              />
            ) : (
              state.chats.map((c) => (
                <div key={c.chatId} className="flex flex-col gap-0.5 rounded-xl px-3 py-2.5">
                  <span className="truncate text-[15px] font-medium tracking-[-0.01em]">{c.title || "Untitled chat"}</span>
                  <Caption variant="meta">{[when(c.updatedAt), c.engine].filter(Boolean).join(" · ")}</Caption>
                </div>
              ))
            )}
          </div>
          <div className="flex shrink-0 justify-center pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
            <Button variant="ghost" size="sm" onClick={() => void forget()}>
              Forget this phone
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

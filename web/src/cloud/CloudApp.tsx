// LFG on Calyx Cloud: pair this phone with Calyx on a computer (L0), then
// follow and answer Calyx chats with LFG's own chat screens (L2), and answer
// the agent's questions in them (L3a).
//
// The pass is an HttpOnly cookie the chat server sets; this page never sees it.
// It asks the server who it is (/v1/me) instead.

import { backend } from "@/lib/backend";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare, MoreVertical, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Caption } from "@/components/ui/caption";
import { EmptyState } from "@/components/ui/empty-state";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LiveView, SessionOpsContext, type SessionOps } from "../App";
import { ChatAsksContext, ChatAsksPanel, type ChatAsksValue } from "./ChatAsks";
import { onlineLine } from "./hub-state";
import { useCloudChats } from "./useCloudChats";

type State =
  | { kind: "loading" }
  | { kind: "unpaired"; error?: string }
  | { kind: "pairing"; code: string; secret: string }
  | { kind: "expired" }
  | { kind: "paired"; vaultId: string; expiresAt: number };

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

const noop = () => {};
const resolved = async () => {};
const noOlder = async () => false;

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
    setState({ kind: "paired", vaultId, expiresAt });
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

  if (state.kind === "paired") {
    return <CloudChats vaultId={state.vaultId} expiresAt={state.expiresAt} onForget={() => void forget()} />;
  }

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
    </div>
  );
}

/** The paired phone: the vault's Calyx chats in LFG's own list and chat screens. */
function CloudChats({ vaultId, expiresAt, onForget }: { vaultId: string; expiresAt: number; onForget: () => void }) {
  const chats = useCloudChats(vaultId);
  const online = chats.hub.online.length > 0;
  const ops: SessionOps = useMemo(
    () => ({ ...chats.ops, asks: (sid: string) => <ChatAsksPanel chatId={sid} /> }),
    [chats.ops],
  );
  const asks: ChatAsksValue = useMemo(
    () => ({ asksBySid: chats.asksBySid, askInfoBySid: chats.askInfoBySid, answer: chats.answer }),
    [chats.asksBySid, chats.askInfoBySid, chats.answer],
  );

  return (
    <SessionOpsContext.Provider value={ops}>
    <ChatAsksContext.Provider value={asks}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <header className="flex shrink-0 items-center gap-3 px-5 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))]">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-[-0.03em]">Calyx</h1>
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  online ? "bg-success" : "bg-muted-foreground/40",
                )}
              />
              <Caption variant="meta" className="truncate">
                {onlineLine(chats.hub, chats.hubOpen)}
              </Caption>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Phone menu"
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
                />
              }
            >
              <MoreVertical className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  Paired until {new Date(expiresAt).toLocaleDateString([], { day: "numeric", month: "short" })}
                </DropdownMenuLabel>
                <DropdownMenuItem variant="destructive" onClick={onForget}>
                  Forget this phone
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
          {chats.sessions.length === 0 ? (
            <EmptyState
              className="min-h-[60dvh]"
              icon={<MessagesSquare className="size-5" />}
              title={chats.hubOpen ? "No chats yet" : "Connecting…"}
              description="Chats you open in Calyx on your computer show here."
            />
          ) : (
            <LiveView
              sessions={chats.sessions}
              users={[]}
              userFilter="__all"
              projectFilter="__all"
              messagesBySid={chats.messagesBySid}
              busyBySid={chats.busyBySid}
              promptsBySid={chats.promptsBySid}
              queuesBySid={chats.queuesBySid}
              loadingBySid={chats.loadingBySid}
              onLoadOlderMessages={noOlder}
              onOptimisticMessage={noop}
              onRemoveOptimisticMessage={noop}
              onTrackSendStatus={noop}
              onRefresh={resolved}
              onRemove={noop}
              onBrain={resolved}
              onNew={noop}
              findings={[]}
              autoAgents={[]}
              onOpenFinding={noop}
            />
          )}
        </main>
      </div>
    </ChatAsksContext.Provider>
    </SessionOpsContext.Provider>
  );
}

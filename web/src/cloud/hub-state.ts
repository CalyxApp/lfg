// The vault's chat list and which computers are online, as the phone sees it
// (LFG plan, L2). From the chat server's hub (calyx-api chat-worker,
// src/hub.ts): one socket per vault, messages `list`, `chat` and `presence`.

import type { Session } from "../App";

export interface ChatSummary {
  chatId: string;
  title: string;
  updatedAt: number;
  /** Who drives the chat now: a computer, the cloud box, or nobody. */
  driver: "computer" | "cloud" | null;
  /** The engine that runs it (`claude`, `pi-durable`, …), as its driver last said. */
  engine: string | null;
}

export interface Online {
  deviceId: string;
  label: string;
  since: number;
}

export interface HubState {
  chats: ChatSummary[];
  online: Online[];
}

export const EMPTY_HUB: HubState = { chats: [], online: [] };

type Json = Record<string, unknown>;

const newestFirst = (a: ChatSummary, b: ChatSummary) => b.updatedAt - a.updatedAt;

export function reduceHub(state: HubState, msg: Json): HubState {
  switch (msg.t) {
    case "list":
      return {
        chats: ((msg.chats as ChatSummary[]) ?? []).slice().sort(newestFirst),
        online: (msg.online as Online[]) ?? [],
      };
    case "chat": {
      const chat = msg.chat as ChatSummary | undefined;
      if (!chat?.chatId) return state;
      return { ...state, chats: [chat, ...state.chats.filter((c) => c.chatId !== chat.chatId)].sort(newestFirst) };
    }
    case "presence":
      return { ...state, online: (msg.online as Online[]) ?? [] };
    default:
      return state;
  }
}

/** LFG's agent kind for a Calyx engine: picks the icon on the card. */
export function engineAgent(engine: string | null): string | undefined {
  if (engine === "pi-durable") return "pi";
  return engine ?? undefined;
}

/** The engine's name, shown where LFG shows a session's model. */
export function engineLabel(engine: string | null): string | null {
  if (!engine) return null;
  if (engine === "claude") return "Claude";
  if (engine === "pi-durable") return "Pi";
  return engine;
}

/** The chat list as LFG sessions, so LFG's own list and cards draw it. */
export function chatsToSessions(chats: ChatSummary[]): Session[] {
  return chats.map((c) => ({
    sessionId: c.chatId,
    title: c.title || "Untitled chat",
    agent: engineAgent(c.engine),
    model: engineLabel(c.engine),
    startedAt: c.updatedAt,
    lastActivityAt: c.updatedAt,
    busy: false,
  }));
}

export function onlineLine(hub: HubState, connected: boolean): string {
  // Two windows of one computer show as one name.
  if (hub.online.length) return `${[...new Set(hub.online.map((o) => o.label))].join(", ")} online`;
  return connected ? "No computer online" : "Connecting…";
}

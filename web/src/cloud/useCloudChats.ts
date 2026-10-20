// Calyx Cloud chats for LFG's own chat screens (LFG plan, L2).
//
// One hub socket gives the chat list and which computers are online. Each chat
// the screens open (an expanded card, the full-height sheet) gets a room socket;
// collapsed cards hold none. The result is exactly what LFG's LiveView takes, so
// the phone draws Calyx chats with LFG's list, cards, transcript and composer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useExpandedIds,
  type Message,
  type QueueMsg,
  type Session,
  type SessionOps,
  type SessionPrompt,
} from "../App";
import { chatsToSessions, EMPTY_HUB, engineAgent, engineLabel, reduceHub, type HubState } from "./hub-state";
import { liveSocket, type LiveSocket } from "./live-socket";
import { reduceRoom, roomMessages, roomStatus, type RoomState, type Sending } from "./room-state";

interface Room {
  sock: LiveSocket;
  state: RoomState | null;
  sending: Map<string, Sending>;
  /** What the screens draw, rebuilt only after news for this room. */
  view: { messages: Message[]; busy: boolean } | null;
}

const NO_PROMPTS: Record<string, SessionPrompt | null> = {};
const NO_QUEUES: Record<string, QueueMsg[]> = {};

/** The phone's name in a chat ("From iPhone"). */
export function deviceLabel(ua = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `req-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function useCloudChats(vaultId: string) {
  const base = `/v1/vaults/${encodeURIComponent(vaultId)}`;
  const label = useMemo(() => deviceLabel(), []);
  const [hub, setHub] = useState<HubState>(EMPTY_HUB);
  const [hubOpen, setHubOpen] = useState(false);
  const roomsRef = useRef(new Map<string, Room>());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const sock = liveSocket(`${base}/hub/ws`, {
      onMessage: (m) => setHub((h) => reduceHub(h, m)),
      onState: setHubOpen,
    });
    return () => sock.close();
  }, [base]);

  const listed = useMemo(() => chatsToSessions(hub.chats), [hub.chats]);
  const expandedIds = useExpandedIds(listed);

  const openRoom = useCallback(
    (chatId: string): Room => {
      const existing = roomsRef.current.get(chatId);
      if (existing) return existing;
      const room = { state: null, sending: new Map(), view: null } as unknown as Room;
      const flush = () => {
        for (const [id, m] of room.sending) {
          if (!m.failed) room.sock.send({ t: "send", ref: id, requestId: id, text: m.text });
        }
      };
      room.sock = liveSocket(`${base}/chats/${encodeURIComponent(chatId)}/ws?label=${encodeURIComponent(label)}`, {
        onOpen: (sock) => {
          // Catch up from where this phone got to, or take the whole snapshot.
          sock.send(room.state ? { t: "hello", after: room.state.lastSeq } : { t: "hello" });
          flush();
        },
        onMessage: (m) => {
          if (m.t === "ack") {
            const id = ((m.item as { requestId?: string } | undefined)?.requestId ?? m.ref) as string | undefined;
            const pending = id ? room.sending.get(id) : undefined;
            if (!id || !pending) return;
            if (m.ok === false) room.sending.set(id, { ...pending, failed: true });
            else room.sending.delete(id);
          } else {
            const next = reduceRoom(room.state, m);
            if (next === room.state) return;
            room.state = next;
            // The room has it now: no longer "on its way".
            for (const item of next?.inbox ?? []) room.sending.delete(item.requestId);
          }
          room.view = null;
          bump();
        },
      });
      roomsRef.current.set(chatId, room);
      return room;
    },
    [base, label, bump],
  );

  // Hold a room socket for each chat on screen; let go of the rest (unless a
  // message is still on its way to it).
  const expandedKey = expandedIds.join(",");
  useEffect(() => {
    const want = new Set(expandedIds);
    for (const id of want) openRoom(id);
    for (const [id, room] of roomsRef.current) {
      if (want.has(id) || room.sending.size) continue;
      room.sock.close();
      roomsRef.current.delete(id);
    }
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKey, openRoom, bump]);

  useEffect(
    () => () => {
      for (const room of roomsRef.current.values()) room.sock.close();
      roomsRef.current.clear();
    },
    [],
  );

  const send = useCallback(
    (chatId: string, text: string) => {
      const room = openRoom(chatId);
      const id = newRequestId();
      room.sending.set(id, { text, at: Date.now() });
      room.sock.send({ t: "send", ref: id, requestId: id, text });
      room.view = null;
      bump();
    },
    [openRoom, bump],
  );

  const view = useMemo(() => {
    const messagesBySid: Record<string, Message[]> = {};
    const busyBySid: Record<string, boolean> = {};
    const loadingBySid: Record<string, boolean> = {};
    for (const [id, room] of roomsRef.current) {
      room.view ??= roomMessages(room.state, room.sending);
      messagesBySid[id] = room.view.messages;
      busyBySid[id] = room.view.busy;
      loadingBySid[id] = !room.state;
    }
    // What a chat's open room knows is newer than the list: its title, engine, and where it is.
    const sessions: Session[] = listed.map((s) => {
      const state = roomsRef.current.get(s.sessionId ?? "")?.state;
      if (!state) return s;
      const status = roomStatus(state);
      return {
        ...s,
        title: state.title || s.title,
        agent: engineAgent(state.engine) ?? s.agent,
        model: engineLabel(state.engine) ?? s.model,
        busy: busyBySid[s.sessionId ?? ""] ?? false,
        ...(status.kind === "paused"
          ? { status: "blocked" as const, statusReason: "computer_away" as const, statusDetail: status.label }
          : {}),
      };
    });
    return { sessions, messagesBySid, busyBySid, loadingBySid };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, listed]);

  const ops: SessionOps = useMemo(
    () => ({
      can: { manage: false, upload: false, interrupt: false, close: false, brain: false, summary: false, diff: false },
      // The room takes a message whether or not a computer drives the chat now.
      canDrive: () => true,
      send: async (sid, text) => {
        send(sid, text);
        return {};
      },
    }),
    [send],
  );

  return {
    hub,
    hubOpen,
    ...view,
    promptsBySid: NO_PROMPTS,
    queuesBySid: NO_QUEUES,
    ops,
  };
}

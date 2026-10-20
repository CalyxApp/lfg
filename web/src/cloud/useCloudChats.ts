// Calyx Cloud chats for LFG's own chat screens (LFG plan, L2).
//
// One hub socket gives the chat list and which computers are online. Each chat
// the screens open (an expanded card, the full-height sheet) gets a room socket;
// collapsed cards hold none. The result is exactly what LFG's LiveView takes, so
// the phone draws Calyx chats with LFG's list, cards, transcript and composer.
// The agent's questions in those chats (L3a) come and are answered on the same
// room sockets.

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
import { reduceRoom, roomMessages, roomStatus, type AskAnswerPart, type RoomAsk, type RoomState, type Sending } from "./room-state";

interface Room {
  sock: LiveSocket;
  state: RoomState | null;
  sending: Map<string, Sending>;
  /** Answers on their way: the message ref → the question's id. */
  answering: Map<string, string>;
  /** Questions the room took this phone's answer for. */
  answeredHere: Set<string>;
  /** Why an answer did not go through, by question id. */
  askErrors: Map<string, string>;
  /** What the screens draw, rebuilt only after news for this room. */
  view: { messages: Message[]; busy: boolean } | null;
}

/** A question in a chat, as the phone shows it. */
export interface ChatAskView {
  ask: RoomAsk;
  /** This phone's answer is the one the room took. */
  answeredHere: boolean;
  /** An answer from this phone is on its way. */
  busy: boolean;
  error: string | null;
}

/** What a chat's question card needs besides the question. */
export interface ChatAskInfo {
  title: string;
  /** The computer that will apply the answer: the one driving, or the one that drove last. */
  computer: string | null;
}

const ASK_ERRORS: Record<string, string> = {
  empty_answer: "Choose an option or type an answer first.",
  unknown_ask: "This question has closed.",
  offline: "Not connected to the chat. Try again in a moment.",
};

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
  const onlineKeyRef = useRef("");
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
      const room = {
        state: null,
        sending: new Map(),
        answering: new Map(),
        answeredHere: new Set(),
        askErrors: new Map(),
        view: null,
      } as unknown as Room;
      const flush = () => {
        for (const [id, m] of room.sending) {
          if (!m.failed) room.sock.send({ t: "send", ref: id, requestId: id, text: m.text });
        }
      };
      room.sock = liveSocket(`${base}/chats/${encodeURIComponent(chatId)}/ws?label=${encodeURIComponent(label)}`, {
        onOpen: (sock) => {
          // An answer whose reply was lost with the old socket: the room's list says how it went.
          room.answering.clear();
          // Catch up from where this phone got to, or take the whole snapshot.
          sock.send(room.state ? { t: "hello", after: room.state.lastSeq } : { t: "hello" });
          flush();
        },
        onMessage: (m) => {
          const answeredAsk = typeof m.ref === "string" ? room.answering.get(m.ref) : undefined;
          if (answeredAsk && (m.t === "ack" || m.t === "error")) {
            room.answering.delete(m.ref as string);
            if (m.ok) room.answeredHere.add(answeredAsk);
            // not_open: another device answered first; its answer rides along and shows instead.
            else if (m.code !== "not_open") room.askErrors.set(answeredAsk, ASK_ERRORS[m.code as string] ?? "Could not send the answer.");
            if (m.ask) room.state = reduceRoom(room.state, { t: "ask", ask: m.ask });
          } else if (m.t === "ack") {
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

  const answer = useCallback(
    (chatId: string, askId: string, text: string, answers: AskAnswerPart[]) => {
      const room = openRoom(chatId);
      const ref = `ans-${newRequestId().slice(4)}`;
      room.askErrors.delete(askId);
      if (room.sock.send({ t: "answer", ref, askId, text, answers })) room.answering.set(ref, askId);
      else room.askErrors.set(askId, ASK_ERRORS.offline);
      room.view = null;
      bump();
    },
    [openRoom, bump],
  );

  const view = useMemo(() => {
    const messagesBySid: Record<string, Message[]> = {};
    const busyBySid: Record<string, boolean> = {};
    const loadingBySid: Record<string, boolean> = {};
    const asksBySid: Record<string, ChatAskView[]> = {};
    const askInfoBySid: Record<string, ChatAskInfo> = {};
    // Which computers are online changes the wording ("Paused until … is back"), so a change redraws every chat.
    const online = hub.online.map((o) => o.label);
    const onlineKey = online.join("\n");
    if (onlineKey !== onlineKeyRef.current) {
      onlineKeyRef.current = onlineKey;
      for (const room of roomsRef.current.values()) room.view = null;
    }
    for (const [id, room] of roomsRef.current) {
      room.view ??= roomMessages(room.state, room.sending, online);
      messagesBySid[id] = room.view.messages;
      busyBySid[id] = room.view.busy;
      loadingBySid[id] = !room.state;
      const answering = new Set(room.answering.values());
      asksBySid[id] = (room.state?.asks ?? []).map((ask) => ({
        ask,
        // After a reload the room still names this phone as the one that answered.
        answeredHere: room.answeredHere.has(ask.id) || ask.answer?.from === label,
        busy: answering.has(ask.id),
        error: room.askErrors.get(ask.id) ?? null,
      }));
      const status = roomStatus(room.state, online);
      askInfoBySid[id] = {
        title: room.state?.title ?? "",
        computer: status.kind === "none" ? (room.state?.lease?.lastLabel ?? null) : status.label,
      };
    }
    // What a chat's open room knows is newer than the list: its title, engine, and where it is.
    const sessions: Session[] = listed.map((s) => {
      const state = roomsRef.current.get(s.sessionId ?? "")?.state;
      if (!state) return s;
      const status = roomStatus(state, online);
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
    return { sessions, messagesBySid, busyBySid, loadingBySid, asksBySid, askInfoBySid };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, listed, hub.online]);

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
    answer,
  };
}

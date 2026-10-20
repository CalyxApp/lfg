// A Calyx chat room, as the phone sees it (LFG plan, L2).
//
// The room lives on Calyx's chat server (calyx-api chat-worker, src/room.ts):
// a trimmed history the driving computer pushes after each turn, the live tail
// of the turn in progress, the inbox of messages waiting for a computer, and
// the lease (which computer drives the chat now). This file keeps a viewer's
// copy of that state from the room's socket messages, and turns it into the
// Message list LFG's own chat screens draw.
//
// Ported from the S4 phone page (chat-worker src/page.html: onRoom, liveItems,
// renderChat), which passed Sam's iPhone test on 2026-10-16.

import type { Message } from "../App";

export interface Holder {
  deviceId: string;
  label: string;
  kind: "computer" | "cloud";
}

export interface LeaseView {
  epoch: number;
  holder: Holder | null;
  expiresAt: number;
  live: boolean;
  /** Who drove last, when nobody drives now. */
  lastLabel?: string | null;
}

export interface InboxItem {
  seq: number;
  requestId: string;
  text: string;
  by: "user" | "system";
  from: string;
  at: number;
  status: "waiting" | "claimed" | "done" | "cut";
  epoch: number | null;
}

export interface RoomEvent {
  seq: number;
  epoch: number;
  kind: string;
  data: unknown;
  at: number;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
  status?: string;
  tools?: Array<{ name: string; label?: string; ok: boolean }>;
}

export interface RoomState {
  title: string;
  engine: string | null;
  lease: LeaseView | null;
  history: HistoryMessage[];
  /** The history covers the room's events up to here; the tail holds the ones after. */
  upToSeq: number;
  tail: RoomEvent[];
  inbox: InboxItem[];
  lastSeq: number;
}

/** A message this phone sent that the room has not confirmed yet. */
export interface Sending {
  text: string;
  at: number;
  failed?: boolean;
}

type Json = Record<string, unknown>;

const bySeq = (a: RoomEvent, b: RoomEvent) => a.seq - b.seq;

function mergeTail(tail: RoomEvent[], incoming: RoomEvent[], after: number): RoomEvent[] {
  const seen = new Set(tail.map((e) => e.seq));
  const out = tail.slice();
  for (const e of incoming) {
    if (typeof e?.seq !== "number" || e.seq <= after || seen.has(e.seq)) continue;
    seen.add(e.seq);
    out.push(e);
  }
  return out.sort(bySeq);
}

function leaseOf(msg: Json): LeaseView {
  const { t: _t, ref: _ref, ...rest } = msg;
  return rest as unknown as LeaseView;
}

/**
 * The next state after one message from the room's socket. Unknown messages
 * and news for a room not loaded yet leave it as it is.
 */
export function reduceRoom(state: RoomState | null, msg: Json): RoomState | null {
  switch (msg.t) {
    case "snapshot": {
      const history = (msg.history ?? {}) as { upToSeq?: number; messages?: HistoryMessage[] };
      const upToSeq = history.upToSeq ?? 0;
      return {
        title: (msg.title as string) || "",
        engine: (msg.engine as string | null) ?? null,
        lease: (msg.lease as LeaseView) ?? null,
        history: history.messages ?? [],
        upToSeq,
        tail: mergeTail([], (msg.tail as RoomEvent[]) ?? [], upToSeq),
        inbox: ((msg.inbox as InboxItem[]) ?? []).filter((i) => i.status !== "done"),
        lastSeq: (msg.lastSeq as number) ?? 0,
      };
    }
    case "resume": {
      if (!state) return state;
      return {
        ...state,
        engine: (msg.engine as string | null) || state.engine,
        lease: (msg.lease as LeaseView) ?? state.lease,
        tail: mergeTail(state.tail, (msg.tail as RoomEvent[]) ?? [], state.upToSeq),
        inbox: ((msg.inbox as InboxItem[]) ?? []).filter((i) => i.status !== "done"),
        lastSeq: Math.max(state.lastSeq, (msg.lastSeq as number) ?? 0),
      };
    }
    case "event": {
      if (!state) return state;
      const event = { seq: msg.seq, epoch: msg.epoch, kind: msg.kind, data: msg.data, at: msg.at } as RoomEvent;
      return {
        ...state,
        tail: mergeTail(state.tail, [event], state.upToSeq),
        lastSeq: Math.max(state.lastSeq, event.seq),
      };
    }
    case "history": {
      if (!state) return state;
      const upToSeq = (msg.upToSeq as number) ?? state.upToSeq;
      return {
        ...state,
        history: (msg.messages as HistoryMessage[]) ?? [],
        upToSeq,
        title: (msg.title as string) || state.title,
        tail: state.tail.filter((e) => e.seq > upToSeq),
        lastSeq: Math.max(state.lastSeq, upToSeq),
      };
    }
    case "inbox": {
      const item = msg.item as InboxItem | null;
      if (!state || !item) return state;
      const inbox = state.inbox.filter((i) => i.requestId !== item.requestId);
      if (item.status !== "done") inbox.push(item);
      inbox.sort((a, b) => a.seq - b.seq);
      return { ...state, inbox };
    }
    case "lease":
      return state ? { ...state, lease: leaseOf(msg) } : state;
    case "meta":
      return state && typeof msg.engine === "string" ? { ...state, engine: msg.engine } : state;
    default:
      return state;
  }
}

/** Where the chat is now, as one short line for the phone. */
export type RoomStatus =
  | { kind: "live"; label: string }
  | { kind: "paused"; label: string }
  | { kind: "none" };

export function roomStatus(state: RoomState | null): RoomStatus {
  const lease = state?.lease;
  if (lease?.live && lease.holder) return { kind: "live", label: lease.holder.label };
  // A Pi chat lives on the computer that ran it: nobody else can carry it on yet (phase 2, S6b).
  if (state?.engine === "pi-durable" && lease?.lastLabel) return { kind: "paused", label: lease.lastLabel };
  return { kind: "none" };
}

export function statusLine(status: RoomStatus): string {
  if (status.kind === "live") return `Open on ${status.label}`;
  if (status.kind === "paused") return `Paused until ${status.label} is back`;
  return "Not open on a computer";
}

interface Turn {
  requestId: string;
  text: string;
  events: RoomEvent[];
  done: boolean;
  outcome?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

const note = (id: string, text: string, ts?: number): Message => ({ id, role: "system", kind: "note", text, ts });

/**
 * The chat as LFG's Message list: the history, the turn in progress (its text
 * still a `draft-…` message, so LFG streams it in), then what waits to run and
 * what is still on its way to the room. `busy` while a turn runs or a computer
 * has taken a message.
 */
export function roomMessages(
  state: RoomState | null,
  sending: ReadonlyMap<string, Sending>,
): { messages: Message[]; busy: boolean } {
  const out: Message[] = [];
  if (!state) {
    for (const [id, m] of sending) out.push(pendingUser(`sending-${id}`, m));
    return { messages: out, busy: false };
  }

  for (const m of state.history) {
    if (m.role === "system") {
      if (m.text) out.push(note(m.id, m.text, m.at));
      continue;
    }
    if (m.role === "assistant" && m.tools?.length) {
      m.tools.forEach((tool, i) =>
        out.push({ id: `${m.id}-tool-${i}`, role: "assistant", kind: "tool_use", text: tool.name || tool.label || "tool", ts: m.at }),
      );
    }
    if (!m.text) continue;
    out.push({ id: m.id, role: m.role, kind: "text", text: m.text, ts: m.at });
  }

  // The live tail: turns in the order they started, and notes.
  const turns: Turn[] = [];
  let turn: Turn | null = null;
  for (const e of state.tail) {
    const d = (e.data ?? {}) as Json;
    if (e.kind === "turn_start") {
      turn = { requestId: str(d.requestId) || `seq-${e.seq}`, text: str(d.text), events: [], done: false };
      turns.push(turn);
      out.push({ id: `turn-user-${turn.requestId}`, role: "user", kind: "text", text: turn.text, ts: e.at });
    } else if (e.kind === "note") {
      out.push(note(`note-${e.seq}`, str(d.text), e.at));
    } else if (turn) {
      if (e.kind === "turn_end") {
        turn.done = true;
        turn.outcome = str(d.outcome);
        out.push(...turnMessages(turn));
        turn = null;
      } else {
        turn.events.push(e);
      }
    }
  }
  if (turn) out.push(...turnMessages(turn));

  // Messages the room holds that have not started, then ones still on their way.
  const started = new Set(turns.map((t) => t.requestId));
  const status = roomStatus(state);
  const who = status.kind === "live" ? status.label : null;
  for (const item of state.inbox) {
    if (started.has(item.requestId) || item.status === "done") continue;
    out.push({ ...pendingUser(`inbox-${item.requestId}`, { text: item.text, at: item.at }), pending: item.status !== "cut" });
    out.push(
      note(
        `inbox-note-${item.requestId}`,
        item.status === "cut"
          ? "Stopped when the connection was lost"
          : item.status === "claimed"
            ? `Starting on ${who || "your computer"}…`
            : who
              ? `Waiting for ${who}…`
              : status.kind === "paused"
                ? `Waits for ${status.label} to be back`
                : "Waiting for a computer to open this chat",
        item.at,
      ),
    );
  }
  const inRoom = new Set(state.inbox.map((i) => i.requestId));
  for (const [id, m] of sending) {
    if (inRoom.has(id) || started.has(id)) continue;
    out.push(pendingUser(`sending-${id}`, m));
    if (m.failed) out.push(note(`sending-note-${id}`, "Not sent. The chat server refused it.", m.at));
  }

  const busy = turns.some((t) => !t.done) || state.inbox.some((i) => i.status === "claimed");
  return { messages: out, busy };
}

function pendingUser(id: string, m: { text: string; at: number }): Message {
  return { id, role: "user", kind: "text", text: m.text, ts: m.at, pending: true };
}

/**
 * One turn's tool steps and text, in the order they happened. The last text
 * of a turn still running is a draft (id `draft-…`), so LFG reveals it as it
 * streams; it settles when the turn ends.
 */
function turnMessages(turn: Turn): Message[] {
  const out: Message[] = [];
  let text = "";
  let part = 0;
  let at = 0;
  const flush = (last: boolean) => {
    if (!text) return;
    const draft = last && !turn.done;
    out.push({
      id: `${draft ? "draft" : "turn"}-${turn.requestId}-${part}`,
      role: "assistant",
      kind: "text",
      text,
      ts: at,
    });
    part += 1;
    text = "";
  };
  for (const e of turn.events) {
    const d = (e.data ?? {}) as Json;
    if (e.kind === "text") {
      text += str(d.text);
      at = e.at;
    } else if (e.kind === "tool_start") {
      flush(false);
      out.push({
        id: `turn-${turn.requestId}-tool-${str(d.id) || e.seq}`,
        role: "assistant",
        kind: "tool_use",
        text: str(d.name) || str(d.label) || "tool",
        ts: e.at,
      });
    }
  }
  flush(true);
  if (turn.done && turn.outcome && turn.outcome !== "completed") {
    out.push(note(`turn-end-${turn.requestId}`, turn.outcome === "cancelled" ? "Stopped" : "Something went wrong"));
  }
  return out;
}

// A Calyx chat room as the phone sees it (LFG plan, L2).
// Run: bun test web/src/cloud   (from the repo root)

import { describe, expect, test } from "bun:test";
import { reduceRoom, roomMessages, roomStatus, statusLine, type RoomState, type Sending } from "./room-state";

const lease = (label: string | null, extra: Record<string, unknown> = {}) =>
  label
    ? { epoch: 1, holder: { deviceId: "mac-1", label, kind: "computer" }, expiresAt: 9e15, live: true, ...extra }
    : { epoch: 1, holder: null, expiresAt: 0, live: false, ...extra };

function snapshot(over: Record<string, unknown> = {}) {
  return {
    t: "snapshot",
    chatId: "chat-1",
    title: "Plan the week",
    engine: "claude",
    lease: lease("MacBook"),
    history: {
      upToSeq: 4,
      messages: [
        { id: "h1", role: "user", text: "What is on today?", at: 1 },
        { id: "h2", role: "assistant", text: "Two meetings.", at: 2, tools: [{ name: "Read", label: "Read today.md", ok: true }] },
        { id: "h3", role: "system", text: "Moved to the cloud.", at: 3 },
      ],
    },
    tail: [],
    inbox: [],
    lastSeq: 4,
    ...over,
  };
}

const ev = (seq: number, kind: string, data: Record<string, unknown>) => ({ t: "event", seq, epoch: 1, kind, data, at: 100 + seq });
const none = new Map<string, Sending>();
const ids = (state: RoomState | null, sending = none) => roomMessages(state, sending).messages.map((m) => `${m.kind}:${m.id}`);

describe("reduceRoom", () => {
  test("a snapshot gives the history, title, engine and lease", () => {
    const s = reduceRoom(null, snapshot())!;
    expect(s.title).toBe("Plan the week");
    expect(s.engine).toBe("claude");
    expect(s.upToSeq).toBe(4);
    expect(ids(s)).toEqual(["text:h1", "tool_use:h2-tool-0", "text:h2", "note:h3"]);
  });

  test("news before any snapshot changes nothing", () => {
    expect(reduceRoom(null, ev(5, "text", { text: "x" }))).toBeNull();
    expect(reduceRoom(null, { t: "history", upToSeq: 3, messages: [] })).toBeNull();
  });

  test("events arriving twice or out of order land once, in order", () => {
    let s = reduceRoom(null, snapshot())!;
    s = reduceRoom(s, ev(6, "text", { text: "world" }))!;
    s = reduceRoom(s, ev(5, "turn_start", { requestId: "req-a", text: "hi" }))!;
    s = reduceRoom(s, ev(6, "text", { text: "world" }))!;
    s = reduceRoom(s, ev(3, "text", { text: "old" }))!; // already in the history
    expect(s.tail.map((e) => e.seq)).toEqual([5, 6]);
    expect(s.lastSeq).toBe(6);
  });

  test("resume after a gap adds only what is new", () => {
    let s = reduceRoom(null, snapshot())!;
    s = reduceRoom(s, ev(5, "turn_start", { requestId: "req-a", text: "hi" }))!;
    s = reduceRoom(s, {
      t: "resume",
      after: 5,
      engine: "claude",
      lease: lease("MacBook"),
      tail: [ev(5, "turn_start", { requestId: "req-a", text: "hi" }), ev(6, "text", { text: "Hel" }), ev(7, "text", { text: "lo" })],
      inbox: [{ seq: 1, requestId: "req-a", text: "hi", by: "user", from: "iPhone", at: 1, status: "claimed", epoch: 1 }],
      lastSeq: 7,
    })!;
    expect(s.tail.map((e) => e.seq)).toEqual([5, 6, 7]);
    const { messages, busy } = roomMessages(s, none);
    expect(busy).toBe(true);
    expect(messages.at(-1)).toMatchObject({ id: "draft-req-a-0", role: "assistant", kind: "text", text: "Hello" });
  });

  test("a history snapshot replaces the tail it covers", () => {
    let s = reduceRoom(null, snapshot())!;
    s = reduceRoom(s, ev(5, "turn_start", { requestId: "req-a", text: "hi" }))!;
    s = reduceRoom(s, ev(6, "turn_end", { requestId: "req-a", outcome: "completed" }))!;
    s = reduceRoom(s, ev(7, "note", { text: "after" }))!;
    s = reduceRoom(s, {
      t: "history",
      upToSeq: 6,
      title: "Renamed",
      messages: [
        { id: "h4", role: "user", text: "hi", at: 5 },
        { id: "h5", role: "assistant", text: "Hello", at: 6 },
      ],
    })!;
    expect(s.title).toBe("Renamed");
    expect(s.tail.map((e) => e.seq)).toEqual([7]);
    expect(ids(s)).toEqual(["text:h4", "text:h5", "note:note-7"]);
  });

  test("lease and engine news", () => {
    let s = reduceRoom(null, snapshot())!;
    s = reduceRoom(s, { t: "meta", engine: "pi-durable" })!;
    s = reduceRoom(s, { t: "lease", ref: "x", ...lease(null, { lastLabel: "MacBook" }) })!;
    expect(s.engine).toBe("pi-durable");
    expect(s.lease).toEqual(lease(null, { lastLabel: "MacBook" }) as never);
  });
});

describe("roomMessages", () => {
  test("a live turn: its message, tool steps and text in order; text streams as a draft, settles at the end", () => {
    let s = reduceRoom(null, snapshot({ history: { upToSeq: 0, messages: [] }, lastSeq: 0 }))!;
    s = reduceRoom(s, ev(1, "turn_start", { requestId: "req-a", text: "Plan it", from: "iPhone" }))!;
    s = reduceRoom(s, ev(2, "text", { text: "Looking. " }))!;
    s = reduceRoom(s, ev(3, "tool_start", { id: "t1", name: "Read", label: "Read plan.md" }))!;
    s = reduceRoom(s, ev(4, "tool_end", { id: "t1", ok: true }))!;
    s = reduceRoom(s, ev(5, "text", { text: "Done" }))!;
    let view = roomMessages(s, none);
    expect(view.busy).toBe(true);
    expect(view.messages.map((m) => [m.role, m.kind, m.id, m.text])).toEqual([
      ["user", "text", "turn-user-req-a", "Plan it"],
      ["assistant", "text", "turn-req-a-0", "Looking. "],
      ["assistant", "tool_use", "turn-req-a-tool-t1", "Read"],
      ["assistant", "text", "draft-req-a-1", "Done"],
    ]);
    s = reduceRoom(s, ev(6, "turn_end", { requestId: "req-a", outcome: "completed" }))!;
    view = roomMessages(s, none);
    expect(view.busy).toBe(false);
    expect(view.messages.at(-1)).toMatchObject({ id: "turn-req-a-1", text: "Done" });
  });

  test("a stopped or failed turn says so", () => {
    let s = reduceRoom(null, snapshot({ history: { upToSeq: 0, messages: [] }, lastSeq: 0 }))!;
    s = reduceRoom(s, ev(1, "turn_start", { requestId: "req-a", text: "x" }))!;
    s = reduceRoom(s, ev(2, "turn_end", { requestId: "req-a", outcome: "cancelled" }))!;
    s = reduceRoom(s, ev(3, "turn_start", { requestId: "req-b", text: "y" }))!;
    s = reduceRoom(s, ev(4, "turn_end", { requestId: "req-b", outcome: "error" }))!;
    const notes = roomMessages(s, none).messages.filter((m) => m.kind === "note").map((m) => m.text);
    expect(notes).toEqual(["Stopped", "Something went wrong"]);
  });

  test("inbox: waiting, starting, cut — and a started one shows as its turn, not twice", () => {
    const item = (requestId: string, status: string) => ({ seq: 1, requestId, text: requestId, by: "user", from: "iPhone", at: 1, status, epoch: null });
    let s = reduceRoom(null, snapshot({ history: { upToSeq: 0, messages: [] }, lastSeq: 0 }))!;
    for (const [id, status] of [["req-w", "waiting"], ["req-c", "claimed"], ["req-x", "cut"], ["req-s", "claimed"]] as const) {
      s = reduceRoom(s, { t: "inbox", item: item(id, status) })!;
    }
    s = reduceRoom(s, ev(1, "turn_start", { requestId: "req-s", text: "req-s" }))!;
    const notes = roomMessages(s, none).messages.filter((m) => m.kind === "note").map((m) => m.text);
    expect(notes).toEqual(["Waiting for MacBook…", "Starting on MacBook…", "Stopped when the connection was lost"]);
    expect(roomMessages(s, none).messages.filter((m) => m.text === "req-s")).toHaveLength(1);
    // Done leaves the inbox.
    s = reduceRoom(s, { t: "inbox", item: item("req-w", "done") })!;
    expect(s.inbox.map((i) => i.requestId)).not.toContain("req-w");
  });

  test("with no computer: waiting for one; a Pi chat waits for its own computer", () => {
    const waiting = { t: "inbox", item: { seq: 1, requestId: "req-w", text: "hi", by: "user", from: "iPhone", at: 1, status: "waiting", epoch: null } };
    let claude = reduceRoom(null, snapshot({ lease: lease(null, { lastLabel: "MacBook" }) }))!;
    claude = reduceRoom(claude, waiting)!;
    expect(roomMessages(claude, none).messages.at(-1)?.text).toBe("Waiting for a computer to open this chat");
    expect(statusLine(roomStatus(claude))).toBe("Not open on a computer");

    let pi = reduceRoom(null, snapshot({ engine: "pi-durable", lease: lease(null, { lastLabel: "MacBook" }) }))!;
    pi = reduceRoom(pi, waiting)!;
    expect(roomMessages(pi, none).messages.at(-1)?.text).toBe("Waits for MacBook to be back");
    expect(statusLine(roomStatus(pi))).toBe("Paused until MacBook is back");
    expect(statusLine(roomStatus(reduceRoom(null, snapshot())))).toBe("Open on MacBook");
  });

  test("a message on its way shows as pending until the room has it; a refused one says so", () => {
    const s = reduceRoom(null, snapshot({ history: { upToSeq: 0, messages: [] }, lastSeq: 0 }))!;
    const sending = new Map<string, Sending>([
      ["req-1", { text: "first", at: 1 }],
      ["req-2", { text: "second", at: 2, failed: true }],
    ]);
    const msgs = roomMessages(s, sending).messages;
    expect(msgs.map((m) => [m.text, !!m.pending])).toEqual([
      ["first", true],
      ["second", true],
      ["Not sent. The chat server refused it.", false],
    ]);
    // Before the room loads, what is on its way still shows.
    expect(roomMessages(null, sending).messages).toHaveLength(2);
    // Once the room lists it, it shows once, as the room's.
    const inRoom = reduceRoom(s, { t: "inbox", item: { seq: 1, requestId: "req-1", text: "first", by: "user", from: "iPhone", at: 1, status: "waiting", epoch: null } })!;
    expect(roomMessages(inRoom, sending).messages.filter((m) => m.text === "first")).toHaveLength(1);
  });
});


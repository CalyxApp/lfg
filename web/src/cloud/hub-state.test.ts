// The chat list and presence as the phone sees it (LFG plan, L2).
// Run: bun test web/src/cloud   (from the repo root)

import { describe, expect, test } from "bun:test";
import { chatsToSessions, EMPTY_HUB, onlineLine, reduceHub } from "./hub-state";

const chat = (chatId: string, updatedAt: number, engine: string | null = "claude") => ({ chatId, title: chatId, updatedAt, driver: null, engine });

describe("reduceHub", () => {
  test("list, then a chat's news moves it to the top, then presence", () => {
    let s = reduceHub(EMPTY_HUB, { t: "list", chats: [chat("a", 1), chat("b", 2)], online: [] });
    expect(s.chats.map((c) => c.chatId)).toEqual(["b", "a"]);
    s = reduceHub(s, { t: "chat", chat: chat("a", 3) });
    expect(s.chats.map((c) => c.chatId)).toEqual(["a", "b"]);
    s = reduceHub(s, { t: "chat", chat: chat("c", 0) });
    expect(s.chats.map((c) => c.chatId)).toEqual(["a", "b", "c"]);
    s = reduceHub(s, { t: "presence", online: [{ deviceId: "m", label: "MacBook", since: 1 }] });
    expect(onlineLine(s, true)).toBe("MacBook online");
    s = reduceHub(s, { t: "presence", online: [{ deviceId: "m", label: "MacBook", since: 1 }, { deviceId: "n", label: "MacBook", since: 2 }, { deviceId: "o", label: "Studio", since: 3 }] });
    expect(onlineLine(s, true)).toBe("MacBook, Studio online");
    expect(onlineLine(EMPTY_HUB, true)).toBe("No computer online");
    expect(onlineLine(EMPTY_HUB, false)).toBe("Connecting…");
  });
});

describe("chatsToSessions", () => {
  test("each chat is a session with its engine as the agent and the chip", () => {
    const [claude, pi, unknown] = chatsToSessions([chat("a", 5), chat("b", 4, "pi-durable"), { ...chat("c", 3, null), title: "" }]);
    expect(claude).toMatchObject({ sessionId: "a", agent: "claude", model: "Claude", lastActivityAt: 5 });
    expect(pi).toMatchObject({ sessionId: "b", agent: "pi", model: "Pi" });
    expect(unknown).toMatchObject({ sessionId: "c", title: "Untitled chat", agent: undefined, model: null });
  });
});

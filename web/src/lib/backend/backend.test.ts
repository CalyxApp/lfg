// Contract tests for the backend seam (LFG plan, L1).
//
// "server" must do exactly what LFG's screens did by hand before the seam:
// same path, same options, same error text, same socket address. "cloud" must
// reach only the chat server's API and refuse the rest without a request.
//
// Run: bun test web/src/lib/backend   (from the repo root)

import { describe, expect, test } from "bun:test";
import { CLOUD_CAPABILITIES, createCloudBackend } from "./cloud";
import { SERVER_CAPABILITIES, createServerBackend } from "./server";
import { BackendUnsupportedError, type BrowserDeps } from "./types";

type Call = { kind: string; url: string; init?: unknown; body?: unknown };

function fakeBrowser(opts: {
  protocol?: string;
  host?: string;
  respond?: (url: string) => Response;
  beacon?: boolean | null;
}) {
  const calls: Call[] = [];
  const deps: BrowserDeps = {
    fetch: async (url, init) => {
      calls.push({ kind: "fetch", url, init });
      return opts.respond?.(url) ?? Response.json({ ok: true });
    },
    webSocket: (url) => {
      calls.push({ kind: "socket", url });
      return { url } as unknown as WebSocket;
    },
    eventSource: (url) => {
      calls.push({ kind: "events", url });
      return { url } as unknown as EventSource;
    },
    sendBeacon:
      opts.beacon === null
        ? undefined
        : (url, body) => {
            calls.push({ kind: "beacon", url, body });
            return opts.beacon ?? true;
          },
    location: () => ({ protocol: opts.protocol ?? "https:", host: opts.host ?? "lfg.example:8445" }),
  };
  return { calls, deps: () => deps };
}

describe("server backend (My server): today's calls, unchanged", () => {
  test("fetch passes the path and options through untouched", async () => {
    const b = fakeBrowser({});
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", keepalive: true };
    await createServerBackend(b.deps).fetch("/api/evlog", init);
    await createServerBackend(b.deps).fetch("/api/sessions");
    expect(b.calls).toEqual([
      { kind: "fetch", url: "/api/evlog", init },
      { kind: "fetch", url: "/api/sessions", init: undefined },
    ]);
  });

  test("request returns the parsed body", async () => {
    const b = fakeBrowser({ respond: () => Response.json({ sessions: [1, 2] }) });
    expect(await createServerBackend(b.deps).request("/api/sessions")).toEqual({ sessions: [1, 2] });
  });

  test("request throws the server's error, else status and text, as App.tsx's api() did", async () => {
    const withError = fakeBrowser({ respond: () => Response.json({ error: "no such session" }, { status: 404 }) });
    await expect(createServerBackend(withError.deps).request("/api/x")).rejects.toThrow("no such session");
    const plain = fakeBrowser({ respond: () => new Response("oops", { status: 502, statusText: "Bad Gateway" }) });
    await expect(createServerBackend(plain.deps).request("/api/x")).rejects.toThrow("502 Bad Gateway");
  });

  test("assetUrl is the path itself", () => {
    const raw = "/api/repos/raw?repo=vault&path=a%20b.png";
    expect(createServerBackend(fakeBrowser({}).deps).assetUrl(raw)).toBe(raw);
  });

  test("openSocket builds the address every socket used to build by hand", () => {
    const https = fakeBrowser({ protocol: "https:", host: "chiron-server.ts.net:8445" });
    createServerBackend(https.deps).openSocket("/api/term?session=lfg&cols=80&rows=24");
    const http = fakeBrowser({ protocol: "http:", host: "localhost:8766" });
    createServerBackend(http.deps).openSocket("/api/voice/stt-stream");
    expect(https.calls[0]).toEqual({ kind: "socket", url: "wss://chiron-server.ts.net:8445/api/term?session=lfg&cols=80&rows=24" });
    expect(http.calls[0]).toEqual({ kind: "socket", url: "ws://localhost:8766/api/voice/stt-stream" });
  });

  test("openEvents opens the stream at the path", () => {
    const b = fakeBrowser({});
    createServerBackend(b.deps).openEvents("/api/live/status?ids=a,b");
    expect(b.calls).toEqual([{ kind: "events", url: "/api/live/status?ids=a,b" }]);
  });

  test("beacon answers what the browser answered, and false with no sendBeacon", () => {
    const queued = fakeBrowser({ beacon: true });
    expect(createServerBackend(queued.deps).beacon("/api/evlog", "x")).toBe(true);
    expect(queued.calls).toEqual([{ kind: "beacon", url: "/api/evlog", body: "x" }]);
    expect(createServerBackend(fakeBrowser({ beacon: false }).deps).beacon("/api/evlog", "x")).toBe(false);
    expect(createServerBackend(fakeBrowser({ beacon: null }).deps).beacon("/api/evlog", "x")).toBe(false);
  });

  test("offers everything LFG's own server does, and no Calyx Cloud features", () => {
    const b = createServerBackend(fakeBrowser({}).deps);
    expect(b.kind).toBe("server");
    expect(b.serviceWorker).toBe("/sw.js");
    expect(b.capabilities).toEqual(SERVER_CAPABILITIES);
    expect(b.capabilities.chatRooms).toBe(false);
    expect(b.capabilities.pairing).toBe(false);
    const rest = Object.entries(b.capabilities).filter(([k]) => k !== "chatRooms" && k !== "pairing");
    expect(rest.every(([, v]) => v === true)).toBe(true);
  });
});

describe("cloud backend (Calyx Cloud): the chat server's API only", () => {
  test("fetch reaches /v1 with the page's own cookie", async () => {
    const b = fakeBrowser({});
    await createCloudBackend(b.deps).fetch("/v1/me");
    await createCloudBackend(b.deps).fetch("/v1/pair/start", { method: "POST", body: "{}" });
    expect(b.calls).toEqual([
      { kind: "fetch", url: "/v1/me", init: { credentials: "same-origin" } },
      { kind: "fetch", url: "/v1/pair/start", init: { credentials: "same-origin", method: "POST", body: "{}" } },
    ]);
  });

  test("refuses an own-server path without making the request", async () => {
    const b = fakeBrowser({});
    const cloud = createCloudBackend(b.deps);
    await expect(cloud.fetch("/api/sessions")).rejects.toBeInstanceOf(BackendUnsupportedError);
    await expect(cloud.request("/api/sessions")).rejects.toBeInstanceOf(BackendUnsupportedError);
    expect(() => cloud.openSocket("/api/term")).toThrow(BackendUnsupportedError);
    expect(() => cloud.openEvents("/v1/vaults/v/chats")).toThrow(BackendUnsupportedError);
    expect(() => cloud.assetUrl("/api/repos/raw?path=a")).toThrow(BackendUnsupportedError);
    expect(cloud.beacon("/api/evlog", "x")).toBe(false);
    expect(b.calls).toEqual([]);
  });

  test("a /v1 socket goes to this page's own host", () => {
    const b = fakeBrowser({ protocol: "https:", host: "mac.tailnet.ts.net:8447" });
    createCloudBackend(b.deps).openSocket("/v1/vaults/v1234567/hub/ws");
    expect(b.calls).toEqual([{ kind: "socket", url: "wss://mac.tailnet.ts.net:8447/v1/vaults/v1234567/hub/ws" }]);
  });

  test("offers chats and pairing, nothing of the own server", () => {
    const b = createCloudBackend(fakeBrowser({}).deps);
    expect(b.kind).toBe("cloud");
    expect(b.serviceWorker).toBe("/sw-cloud.js");
    expect(b.capabilities).toEqual(CLOUD_CAPABILITIES);
    const on = Object.entries(b.capabilities).filter(([, v]) => v).map(([k]) => k).sort();
    expect(on).toEqual(["chatRooms", "pairing"]);
  });

  test("the two versions name the same features", () => {
    expect(Object.keys(CLOUD_CAPABILITIES).sort()).toEqual(Object.keys(SERVER_CAPABILITIES).sort());
  });
});

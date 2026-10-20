// The seam: every way LFG's screens reach a backend goes through one of these.
//
// Shaped like upstream LFG's transport (`fetch`, `request`, `openSocket`,
// `assetUrl`; BennyKok/lfg web/src/lib/omg-client.ts). Two differences, both
// to keep today's call sites unchanged: `openSocket` returns the WebSocket
// itself (callers attach handlers at once), and streams have their own
// `openEvents`. Plan: extension repo, docs/tracking/infra/
// calyx-cloud-backend-architecture/lfg-cloud-mode-plan.md, section 2.

import type { BackendKind } from "./kind";

/**
 * What a backend can do. A screen whose feature is `false` here must not be
 * shown: Calyx Cloud never offers a terminal button that goes nowhere.
 * One flag per row of the plan's section 4 table.
 */
export interface Capabilities {
  /** LFG's own agent sessions (tmux, Agent SDK): list, live stream, send, diff, files. */
  sessions: boolean;
  /** A shell on the server (`/api/term`). */
  terminal: boolean;
  /** The server's cloud browser and its saved sign-ins. */
  cloudBrowser: boolean;
  /** The server's notes repo: browse, open, edit, create, search, capture, vault tasks. */
  serverFiles: boolean;
  /** Converse, dictation, read-aloud, the voice orb. */
  voice: boolean;
  /** LFG's own scheduled agents and their findings. */
  scheduledAgents: boolean;
  /** Artifacts, reports, the Shipped feed, usage. */
  artifacts: boolean;
  /** Questions from agents (`/api/ask`, the vault's chat asks). */
  asks: boolean;
  /** Web Push notifications. */
  push: boolean;
  /** Uncaught browser errors reported to the backend. */
  errorReporting: boolean;
  /** Calyx chat rooms (LFG plan L2). */
  chatRooms: boolean;
  /** Pairing this phone with Calyx on a computer. */
  pairing: boolean;
}

export interface Backend {
  readonly kind: BackendKind;
  readonly capabilities: Capabilities;
  /** The service worker this backend's screens register. */
  readonly serviceWorker: string;
  /** A call to the backend, with the same contract as `fetch`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** A JSON call: the parsed body, or an Error with the server's `error` (else "<status> <text>"). */
  request<T>(path: string, init?: RequestInit): Promise<T>;
  /** An address an element (`img`, `iframe`, `video`, `a`) can load by itself. */
  assetUrl(path: string): string;
  /** A WebSocket to the backend; throws as `new WebSocket` throws. */
  openSocket(path: string): WebSocket;
  /** A server-sent-events stream. */
  openEvents(path: string): EventSource;
  /** Fire-and-forget as the page goes away; false when the browser did not queue it. */
  beacon(path: string, body: BodyInit): boolean;
}

/** A call the current backend has no answer for. Screens should have hidden it. */
export class BackendUnsupportedError extends Error {
  constructor(
    readonly backend: BackendKind,
    readonly path: string,
  ) {
    super(`Not available on ${backend === "cloud" ? "Calyx Cloud" : "your server"}: ${path}`);
    this.name = "BackendUnsupportedError";
  }
}

/** The browser pieces a backend uses, so tests can stand them in. Resolved at call time. */
export interface BrowserDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  webSocket: (url: string) => WebSocket;
  eventSource: (url: string) => EventSource;
  /** Absent when the browser has no `navigator.sendBeacon`. */
  sendBeacon?: (url: string, body: BodyInit) => boolean;
  location: () => { protocol: string; host: string };
}

export function browserDeps(): BrowserDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    webSocket: (url) => new WebSocket(url),
    eventSource: (url) => new EventSource(url),
    sendBeacon:
      typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
        ? (url, body) => navigator.sendBeacon(url, body)
        : undefined,
    location: () => window.location,
  };
}

/** `ws(s)://<this page's host><path>`, as every socket in LFG built it by hand. */
export function socketUrl(loc: { protocol: string; host: string }, path: string): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}${path}`;
}

/** JSON in, parsed JSON out; the server's `error` field becomes the Error's message. */
export async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

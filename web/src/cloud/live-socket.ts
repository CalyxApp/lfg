// A socket to the chat server that comes back on its own, with backoff
// (1 s doubling to 15 s), through the backend seam. As the S4 phone page did.

import { backend } from "@/lib/backend";

export interface LiveSocket {
  /** Sends now if the socket is open; false otherwise (the caller resends on open). */
  send(msg: unknown): boolean;
  readonly open: boolean;
  close(): void;
}

export function liveSocket(
  path: string,
  handlers: {
    onOpen?: (socket: LiveSocket) => void;
    onMessage: (msg: Record<string, unknown>) => void;
    onState?: (open: boolean) => void;
  },
): LiveSocket {
  let ws: WebSocket | null = null;
  let closed = false;
  let wait = 1000;
  let timer: number | undefined;

  const socket: LiveSocket = {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    get open() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    close() {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    },
  };

  const connect = () => {
    if (closed) return;
    try {
      ws = backend.openSocket(path);
    } catch {
      timer = window.setTimeout(connect, wait);
      wait = Math.min(wait * 2, 15_000);
      return;
    }
    const current = ws;
    current.onopen = () => {
      wait = 1000;
      handlers.onState?.(true);
      handlers.onOpen?.(socket);
    };
    current.onmessage = (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return; // "pong" and the like
      }
      if (msg && typeof msg === "object") handlers.onMessage(msg as Record<string, unknown>);
    };
    current.onclose = () => {
      if (ws !== current) return;
      handlers.onState?.(false);
      if (closed) return;
      timer = window.setTimeout(connect, wait);
      wait = Math.min(wait * 2, 15_000);
    };
  };
  connect();
  return socket;
}

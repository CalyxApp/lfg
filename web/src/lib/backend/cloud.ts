// Calyx Cloud: Calyx's chat server (and, from L4, the sync server behind it).
//
// A stub for now: only what the pairing screen uses (LFG plan, L0). L2 adds
// the chat rooms, L4 the files. Anything else is refused here, so a screen
// that forgot to check `capabilities` fails loudly instead of calling an
// `/api` that Calyx Cloud does not have.
//
// The phone's pass is an HttpOnly cookie on this origin: same-origin calls
// carry it, and no script can read it.

import {
  BackendUnsupportedError,
  browserDeps,
  readJson,
  socketUrl,
  type Backend,
  type BrowserDeps,
  type Capabilities,
} from "./types";

export const CLOUD_CAPABILITIES: Capabilities = {
  sessions: false,
  terminal: false,
  cloudBrowser: false,
  serverFiles: false,
  voice: false,
  scheduledAgents: false,
  artifacts: false,
  asks: false,
  push: false,
  errorReporting: false,
  chatRooms: true,
  pairing: true,
};

/** The chat server's API (calyx-api chat-worker). */
const CLOUD_PATH = /^\/v1\//;

export function createCloudBackend(deps: () => BrowserDeps = browserDeps): Backend {
  const check = (path: string) => {
    if (!CLOUD_PATH.test(path)) throw new BackendUnsupportedError("cloud", path);
  };
  const call = (path: string, init?: RequestInit) => {
    try {
      check(path);
    } catch (e) {
      return Promise.reject(e);
    }
    return deps().fetch(path, { credentials: "same-origin", ...init });
  };
  return {
    kind: "cloud",
    capabilities: CLOUD_CAPABILITIES,
    serviceWorker: "/sw-cloud.js",
    fetch: call,
    request: async (path, init) => readJson(await call(path, init)),
    assetUrl: (path) => {
      check(path);
      return path;
    },
    openSocket: (path) => {
      check(path);
      const d = deps();
      return d.webSocket(socketUrl(d.location(), path));
    },
    openEvents: (path) => {
      // The chat server streams over sockets only.
      throw new BackendUnsupportedError("cloud", path);
    },
    beacon: () => false,
  };
}

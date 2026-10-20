// "My server": the user's own LFG server, as LFG has always worked. Every call
// goes to the page's own origin, unchanged. Nothing here may change behaviour:
// Sam's day of use on the VPS is this file's test (LFG plan, L1).

import { browserDeps, readJson, socketUrl, type Backend, type BrowserDeps, type Capabilities } from "./types";

export const SERVER_CAPABILITIES: Capabilities = {
  sessions: true,
  terminal: true,
  cloudBrowser: true,
  serverFiles: true,
  voice: true,
  scheduledAgents: true,
  artifacts: true,
  asks: true,
  push: true,
  errorReporting: true,
  chatRooms: false,
  pairing: false,
};

export function createServerBackend(deps: () => BrowserDeps = browserDeps): Backend {
  return {
    kind: "server",
    capabilities: SERVER_CAPABILITIES,
    serviceWorker: "/sw.js",
    fetch: (path, init) => deps().fetch(path, init),
    request: async (path, init) => readJson(await deps().fetch(path, init)),
    assetUrl: (path) => path,
    openSocket: (path) => {
      const d = deps();
      return d.webSocket(socketUrl(d.location(), path));
    },
    openEvents: (path) => deps().eventSource(path),
    beacon: (path, body) => deps().sendBeacon?.(path, body) ?? false,
  };
}

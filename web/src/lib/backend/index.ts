// The one door to the backend. Screens import `backend` from here and never
// call `fetch("/api/…")`, `new WebSocket`, `new EventSource` or
// `navigator.sendBeacon` themselves; `seam.test.ts` fails if one does.

import { createCloudBackend } from "./cloud";
import { backendKind } from "./kind";
import { createServerBackend } from "./server";
import type { Backend } from "./types";

export const backend: Backend = backendKind() === "cloud" ? createCloudBackend() : createServerBackend();

export { backendKind, type BackendKind } from "./kind";
export { BackendUnsupportedError, type Backend, type Capabilities } from "./types";

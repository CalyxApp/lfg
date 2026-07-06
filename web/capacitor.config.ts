import type { CapacitorConfig } from "@capacitor/cli";

// The native shell loads the deployed PWA from the user's own server over
// Tailscale (BYO-server model): UI updates ship by redeploying the server —
// no app-store round trip. `webDir` only seeds the bundle Capacitor requires;
// with server.url set it is not what users see.
const config: CapacitorConfig = {
  appId: "co.calyxapp.mobile",
  appName: "Calyx",
  webDir: "dist",
  server: {
    url: "https://chiron-server.tail5226b1.ts.net:8445",
  },
  ios: {
    // Let the web app own safe-areas via env(safe-area-inset-*) — the PWA
    // already handles them (viewport-fit=cover in index.html).
    contentInset: "never",
    backgroundColor: "#000000",
  },
};

export default config;

// Which backend served these screens.
//
// - "server": the user's own LFG server (a VPS over Tailscale), as LFG has
//   always worked. Every call goes to its /api.
// - "cloud": Calyx Cloud. Calyx's chat server served the screens and marks the
//   page with <meta name="lfg-backend" content="cloud"> (calyx-api
//   chat-worker). Chats are rooms there; the phone pairs with Calyx on a
//   computer instead of relying on Tailscale.
//
// Plan: extension repo, docs/tracking/infra/calyx-cloud-backend-architecture/
// lfg-cloud-mode-plan.md (L0 now; L1 builds the seam around this).

export type BackendKind = "server" | "cloud";

export function backendKind(): BackendKind {
  const meta = document.querySelector('meta[name="lfg-backend"]');
  return meta?.getAttribute("content") === "cloud" ? "cloud" : "server";
}

# lfg Mobile App — Architecture & Roadmap

**Status:** v1 shell built (branch `session_052e2d_mobile`, `mobile/` dir) — awaiting first Mac/Xcode build
**Date:** 2026-07-24
**Owner context:** Sam, iPhone, personal use first; designed to become the product path (users on their own VPS, later on on-demand sandboxes).

---

## 0. TL;DR

The mobile app is a **thin native shell around the existing lfg PWA**. It bundles only a local pairing screen; after the user saves their server URL, the WKWebView loads the lfg frontend **live from their server** ("remote origin" mode). All web-side updates ship with zero app rebuilds. Native code exists only for what the web platform can't do on iOS: reliable **background voice calls** (the primary motivator), later native push and deep-link pairing.

```
┌─ iOS app (Capacitor) ────────────────────┐
│  pairing screen (local www/)             │
│      │ saves URL → navigates             │
│      ▼                                   │
│  WKWebView ──► https://<user-server>     │  ← entire lfg frontend, live
│  mic perms · UIBackgroundModes=audio     │
│  (later: native LiveKit audio, APNs)     │
└──────────────────────────────────────────┘
```

## 1. Why "remote origin" mode (key decision)

The lfg frontend uses **same-origin relative URLs everywhere** (`/api/*`, WS/SSE built from `location.host`). Options were:

- **(A) Bundle the frontend in the app** → requires a base-URL refactor through every fetch/WS/SSE call site, and every UI tweak needs an app rebuild. Rejected for v1.
- **(B) Point the WebView at the server** (chosen) → frontend works completely unchanged because the server *is* the origin; web updates are instant; the app is just permissions + pairing.

Consequence: the only frontend refactor ever needed is a **single client-side "connection" module** — and only when native plugins must talk to the page or when the sandbox future (§5) arrives. Rule until then: **never scatter server URLs through the codebase.**

## 2. Background voice calls (the whole point) — Option A vs B

- **Option A (shipped in v1, an experiment):** keep the call in the WebView (`livekit-client` + WebRTC), add `UIBackgroundModes: audio` + an active `playAndRecord` AVAudioSession (AppDelegate). This *may* keep calls alive on lock/background — WKWebView background mic capture is historically flaky (drops on lock, Siri, phone-call interruptions). Test checklist is in `mobile/README.md`.
- **Option B (the committed fix if A is flaky):** a small Capacitor plugin joining the LiveKit room via **LiveKit's native Swift SDK**. Token from the same `/api/livekit/token` endpoint on whatever server the app is paired with; UI stays web, audio goes native. Optionally **CallKit** on top (lock-screen call controls, survives aggressive suspension, "incoming call from your agent" later).
- Plugin design rule: **dumb plugin — URL + token in, audio out.** Nothing server-specific baked in, so every user's self-hosted stack works.

Decision procedure: build A (near-free), run the background checklist for a day, go to B if any step fails. Do **not** spend time tweaking audio-session flags beyond what's there.

## 3. Multi-user / product path (BYO VPS)

Same shape as Home Assistant's companion app (one App Store app, every user pairs to their own server — proven model, passed review). Design rules locked in now:

1. **Pairing is first-class onboarding**, not a debug field. v1 = URL entry (prefilled). v2 = QR scan (`{url, token}` payload rendered by the server) + `lfg://pair?url=…&token=…` deep link (register the URL scheme early; retrofitting is annoying).
2. **Auth hooks now, auth later.** Pairing payload carries a bearer token; app sends it on every request; server ignores it today (Tailscale is the real boundary — API currently has **zero auth**, loopback bind + `tailscale serve`). When users arrive, validate server-side; app unchanged.
3. **Push needs a relay** in the multi-user world: APNs/FCM keys belong to the app, not each VPS. Pattern: user's VPS → our relay → APNs. The server's existing **payload-less wake-and-fetch** Web Push design (`src/push.ts`, `/api/push/pending`) ports perfectly — relay carries only "something happened", no user content (good privacy story). Server-side: keep the push sender behind a swappable interface (Web Push today, relay later).
4. **Voice is already multi-tenant:** each VPS runs its own livekit-server and mints its own tokens. Keep it that way.

## 4. Current deployment facts (personal v1)

- Server: bun process on `127.0.0.1:8767`, fronted by `tailscale serve` at **`https://chiron-server.tail5226b1.ts.net:8444`** (also :8445). This is the pairing default in `mobile/www/index.html`.
- Phone must run the Tailscale app; the pairing screen says so on failure.
- Distribution: Xcode dev build or TestFlight (App Store not needed for personal use; thin-wrapper review risk only matters later, and the HA precedent covers it).
- Repo layout note: `/home/openclaw/lfg/` is the deployed runtime (not a git repo); source of truth is `/home/openclaw/repos/lfg/` (frontend source in `web/`, mobile shell in `mobile/`).

## 5. Sandbox future (on-demand infra instead of 24/7 VPS)

The one assumption that changes: **"my server" stops being a fixed address and becomes something the app resolves** (token → control plane → current endpoint). Compatibility is preserved if:

- All server communication goes through one client connection module (§1 rule) — migration is one indirection added there.
- The push relay exists (§3.3) — it becomes the always-on heart: agent finishes → relay → APNs → user taps → control plane wakes sandbox → app fetches.
- The voice plugin stays dumb (§2) — it doesn't care if the LiveKit server woke up four seconds ago.

New work the sandbox future adds (server-side, later): detachable state (vault/sessions/transcripts survive sandbox death), and cold-start UX ("waking up…" states, CallKit ringing while sandbox boots, keep-warm windows).

## 6. Roadmap

| Phase | What | Trigger |
|---|---|---|
| 1 ✅ | Capacitor shell + pairing + mic/background-audio entitlements | done (this branch) |
| 1.5 | First Mac build + background-call checklist (`mobile/README.md`) | Sam has a free evening |
| 2 | Native LiveKit call plugin (+ CallKit optional) | checklist fails (likely) |
| 3 | APNs push via wake-and-fetch (`/api/push/pending`) | after voice works |
| 4 | Pairing v2: QR + deep link + bearer token pass-through | first external user |
| 5 | Push relay + server-side auth validation | multi-user for real |
| 6 | PNG icons / splash / App Store or TestFlight polish | distribution needs |

## 7. Gotchas already hit

- **TypeScript 7 breaks the Capacitor CLI** (`capacitor.config.ts` parsing) — TS pinned to 5.9 in `mobile/`. Don't upgrade.
- Shared npm cache on the VPS has root-owned entries → `npm install --cache /tmp/<something>` when EACCES appears.
- iOS suspends WebView JS in background → SSE/WS drop; frontend reconnect logic must be validated inside the wrapper (part of the 1.5 checklist).
- `allowNavigation` is `*.ts.net` — widen when users bring their own domains.

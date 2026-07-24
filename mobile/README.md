# lfg mobile (iOS)

A thin native iOS shell around the lfg PWA. **None of the lfg UI lives here** —
the app bundles only a local pairing screen (`www/index.html`); after pairing,
the WebView loads the lfg frontend **live from your server**, so every web-side
update ships instantly with no app rebuild. Rebuilds are only needed when the
*native* side changes (permissions, plugins, icons, push).

## Architecture (v1 — "remote origin" mode)

```
┌─ iOS app ────────────────────────────────┐
│  pairing screen (local www/)             │
│      │  saves server URL, then navigates │
│      ▼                                   │
│  WKWebView ──► https://<your-server>     │   ← the entire lfg frontend,
│  (mic OK, background-audio entitlement)  │     served live from the VPS
└──────────────────────────────────────────┘
```

- All `/api/*` fetch/WS/SSE calls in the frontend are same-origin relative —
  they work unchanged because the server *is* the WebView origin.
- Security = Tailscale, same as the PWA: the phone must have the Tailscale app
  connected; the server URL is the tailnet HTTPS host (e.g.
  `https://chiron-server.tail5226b1.ts.net:8444`).
- Native side so far: `NSMicrophoneUsageDescription` (mic in voice calls),
  `UIBackgroundModes: audio` + an active `AVAudioSession` (AppDelegate) — the
  "Option A" background-voice-call experiment.

## Building (must happen on a Mac with Xcode)

```sh
git fetch && git checkout session_052e2d_mobile   # or the branch this merged to
cd mobile
npm install
npx cap sync ios          # copies www/ + runs pod install
npx cap open ios          # opens Xcode
```

In Xcode:
1. Select the **App** target → *Signing & Capabilities* → set your Team
   (personal Apple ID is fine for a dev build; use TestFlight for something
   that doesn't expire weekly).
2. Plug in the iPhone, select it as the run destination, hit **Run**.

First launch: make sure **Tailscale is connected on the phone**, accept the
prefilled server address (or edit it), tap Connect.

## Background-voice-call test checklist (the whole point)

With a voice call active:
1. Lock the screen → does audio keep flowing both ways?
2. Switch to another app for 2–3 minutes → still alive?
3. Interruptions: receive a phone call / trigger Siri, then return → does the
   call recover?
4. Screen off for 10+ minutes → still connected?

If any of these fail, that's expected — WKWebView mic capture in the background
is the flaky part. The committed fix is **Option B**: a small Capacitor plugin
that joins the LiveKit room via LiveKit's native Swift SDK (token from the same
`/api/livekit/token` endpoint), so call audio is native while the UI stays web.
Optionally CallKit on top for lock-screen call controls.

## Roadmap after this shell works

1. **Option B native call audio** (if/when Option A proves flaky) — LiveKit
   Swift SDK plugin, `URL + token in → audio out`, nothing server-specific
   baked in (keeps every user's self-hosted stack working).
2. **Native push** — APNs wake-ping reusing the server's payload-less
   wake-and-fetch design (`/api/push/pending`); later via a shared relay for
   multi-user.
3. **Pairing v2** — QR scan + `lfg://pair?url=…&token=…` deep link; bearer
   token sent on every request (server can ignore it until auth exists).
4. **Assets** — PNG icon set + splash screens (current icons are SVG-only).

## Notes / gotchas

- `capacitor.config.ts` `allowNavigation` is `*.ts.net` — widen this when
  users bring their own domains.
- TypeScript is pinned to 5.x in `devDependencies`: the Capacitor CLI cannot
  parse `capacitor.config.ts` under TypeScript 7.
- iOS suspends WebView JS when backgrounded — SSE/WS streams drop and must
  reconnect on foreground. The frontend already has reconnect logic; validate
  it inside the wrapper.

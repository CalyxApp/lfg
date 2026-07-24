import type { CapacitorConfig } from '@capacitor/cli';

/**
 * lfg mobile — Capacitor shell.
 *
 * v1 architecture ("remote origin" mode):
 *   The app bundles ONLY a tiny local pairing screen (www/index.html).
 *   Once the user saves their server URL, the WebView navigates to the
 *   server itself and the existing lfg frontend runs unchanged — all its
 *   same-origin /api/* fetch/WS/SSE calls keep working because the server
 *   IS the origin.
 *
 *   `allowNavigation` keeps that navigation inside the WebView (instead of
 *   bouncing out to Safari). Tailnet hosts only for now; widen when users
 *   bring their own domains.
 */
const config: CapacitorConfig = {
  appId: 'xyz.wondererlabs.lfg',
  appName: 'lfg',
  webDir: 'www',
  server: {
    allowNavigation: ['*.ts.net'],
  },
  ios: {
    contentInset: 'automatic',
    // Voice call UI keeps its own wake lock; link previews just get in the way.
    allowsLinkPreview: false,
  },
};

export default config;

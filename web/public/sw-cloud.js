// lfg service worker for Calyx Cloud (LFG plan, L1). The own-server one is
// sw.js; this one stays apart so nothing of that server's API runs here.
//
// It does almost nothing on purpose: a home-screen web app gets a worker of
// its own, and Web Push (L7) will live here. It caches nothing, so a phone
// always loads the build the chat server serves now, and the chat server's API
// (/v1, the phone's pass) never passes through a cache.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // A phone that first ran the own-server worker here kept its shell cache.
      const keys = await caches.keys();
      await Promise.all([...keys.map((key) => caches.delete(key)), self.clients.claim()]);
    })(),
  );
});

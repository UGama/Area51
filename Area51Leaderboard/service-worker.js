// service-worker.js
const CACHE_NAME = "leaderboard-v1.2"; // ← bump on each deploy

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./main.js",
  "./manifest.json",
  "./pic/logo.png",
  "./pic/icon-192.png",
  "./pic/icon-512.png",
];

// Install: pre-cache core assets
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Activate: clear old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});

// Fetch:
// - HTML (navigations): network-first (so new deploy shows immediately)
// - Other same-origin assets: cache-first but RESPECT query strings (so ?v= busts cache)
self.addEventListener("fetch", (e) => {
  const req = e.request;

  // For SPA/page navigations
  if (req.mode === "navigate" || (req.destination === "document")) {
    e.respondWith(
      fetch(req).then((net) => {
        const copy = net.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return net;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // For same-origin static assets
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req /* do NOT ignoreSearch */).then((cached) => {
        const fetchPromise = fetch(req).then((net) => {
          caches.open(CACHE_NAME).then((c) => c.put(req, net.clone()));
          return net;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});

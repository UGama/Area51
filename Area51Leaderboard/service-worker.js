/* service-worker.js — network-first for HTML/CSS/JS; SW updates immediately */

const CACHE_PREFIX = "leaderboard";
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-v2`;

self.addEventListener("install", (event) => {
  // Take control without waiting for a manual reload
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Claim control of all clients (tabs) immediately
    await self.clients.claim();
    // Delete old caches with our prefix
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k))
    );
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Same-origin only. Let cross-origin (e.g., CDNs, APIs) pass through untouched.
  if (url.origin !== self.location.origin) return;

  // 1) HTML (navigations, index.html): NETWORK FIRST (bypass HTTP cache)
  const acceptsHTML = req.headers.get("accept")?.includes("text/html");
  if (acceptsHTML) {
    event.respondWith(networkFirst(req, { cacheBypass: true, fallbackTo: "/index.html" }));
    return;
  }

  // 2) JS & CSS: NETWORK FIRST (so new code loads right away)
  if (req.destination === "script" || req.destination === "style") {
    event.respondWith(networkFirst(req, { cacheBypass: false }));
    return;
  }

  // 3) Images: STALE-WHILE-REVALIDATE (fast, then refresh in background)
  if (req.destination === "image") {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 4) Everything else: try cache, fall back to network
  event.respondWith(cacheFirst(req));
});

async function networkFirst(request, { cacheBypass = false, fallbackTo = null } = {}) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const freshReq = cacheBypass ? new Request(request.url, { cache: "reload" }) : request;
    const fresh = await fetch(freshReq);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackTo) {
      const fallback = await cache.match(fallbackTo);
      if (fallback) return fallback;
    }
    // as a last resort rethrow to show a real error offline
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then((resp) => {
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  }).catch(() => null);

  // Return cached immediately if present, otherwise wait for network
  return cached || networkPromise || fetch(request);
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  return cached || fetch(request).then((resp) => {
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  });
}

// Optional: allow your page to tell the SW to activate immediately
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

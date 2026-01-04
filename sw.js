/* Service Worker — And-Suivi (PWA)
   Offline-first shell (pages + JS/CSS). Map tiles are NOT cached here.
*/
const CACHE_NAME = "and-suivi-shell-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./client.html",
  "./driver.html",
  "./app.js",
  "./config.js",
  "./shared.js",
  "./client.js",
  "./driver.js",
  "./manifest.webmanifest",
  "./offline.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Don't cache cross-origin requests (OSM tiles, Worker API, etc.)
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Navigation requests: network-first with offline fallback
    if (req.mode === "navigate") {
      try {
        const fresh = await fetch(req);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(req);
        return cached || cache.match("./offline.html");
      }
    }

    // Assets: cache-first
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (e) {
      // If asset missing, fall back to offline for html
      if (req.headers.get("accept")?.includes("text/html")) {
        return cache.match("./offline.html");
      }
      throw e;
    }
  })());
});

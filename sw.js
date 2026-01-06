/* OneSignal Web Push SDK (v16) — intégré dans le SW PWA pour éviter un conflit de scope */
try {
  importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
  // Best-effort : si OneSignal est temporairement indisponible, on garde le SW PWA fonctionnel.
}

// ADN66 Suivi Livreur — Service Worker (force update)
const CACHE = "adn66-suivi-driver-v1767583271";
const ASSETS = [
  "./driver.html",
  "./style.css",
  "./driver.js",
  "./shared.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/marker-client.svg",
  "./icons/marker-driver.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map(u => new Request(u, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // same-origin only
  if (url.origin !== location.origin) return;

  // network-first for HTML
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || caches.match("./offline.html") || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // cache-first for assets
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE);
    cache.put(req, fresh.clone());
    return fresh;
  })());
});

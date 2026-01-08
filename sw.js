/* /maps/sw.js
   ✅ Version stable: OneSignal branché dans TON service worker
   ✅ Pas de conflit de SW sur /maps/
*/

// 1) OneSignal SDK (OBLIGATOIRE en tout premier)
try {
  importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
  // si offline au moment de l'install, on ne casse pas le SW
}

// 2) Ton SW (cache simple & safe)
const VERSION = "maps-sw-2026-01-06";
const CACHE = `maps-cache-${VERSION}`;
const CORE = [
  "/maps/",
  "/maps/driver.html",
  "/maps/driver.js",
  "/maps/config.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE);
    } catch (e) { /* safe */ }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => (k.startsWith("maps-cache-") && k !== CACHE) ? caches.delete(k) : Promise.resolve()));
    } catch (e) { /* safe */ }

    await self.clients.claim();
  })());
});

// Cache-first pour les assets, network-first pour le HTML (safe)
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // laisse passer OneSignal / push endpoints sans toucher
  if (url.hostname.includes("onesignal") || url.pathname.includes("OneSignal")) return;

  // Ne gère que /maps/
  if (!url.pathname.startsWith("/maps/")) return;

  // HTML => network-first
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) || (await cache.match("/maps/driver.html")) || Response.error();
      }
    })());
    return;
  }

  // Assets => cache-first
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const fresh = await fetch(req);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (e) {
      return hit || Response.error();
    }
  })());
});

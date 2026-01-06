// ADN66 Suivi Livreur — Service Worker (force update)
// IMPORTANT: ce SW sert à la fois pour le cache OFFLINE ET pour les notifications push (OneSignal).
// => un seul SW pour le scope ./ (maps/)
try {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
} catch (e) {
  // si offline au moment de l'install, on n'empêche pas l'app de fonctionner.
  // (mais les push ne marcheront pas tant que le SDK SW n'a pas été chargé)
}

const VERSION = "v2026-01-06";
const CACHE = `adn-suivi-${VERSION}`;

const ASSETS = [
  "./",
  "./driver.html",
  "./driver.js",
  "./config.js",
  "./shared.js",
  "./style.css",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/logo.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : null)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  if (req.method !== "GET") return;

  // Bypass cache for OneSignal SDK (évite bugs / mismatch)
  try {
    const u = new URL(req.url);
    if (u.hostname.includes('onesignal.com') || u.hostname.includes('cdn.onesignal.com') || u.pathname.includes('OneSignal')) {
      e.respondWith(fetch(req));
      return;
    }
  } catch (_) {}

  e.respondWith(
    (async () => {
      const url = new URL(req.url);

      // Always network for API
      if (url.hostname.endsWith("workers.dev")) {
        try {
          return await fetch(req);
        } catch (err) {
          // fallback cache if any
          const cached = await caches.match(req);
          if (cached) return cached;
          throw err;
        }
      }

      // Cache-first for small assets
      const cached = await caches.match(req);
      if (cached) return cached;

      const res = await fetch(req);
      const ct = res.headers.get("content-type") || "";
      if (res.ok && (ct.includes("text") || ct.includes("javascript") || ct.includes("css") || ct.includes("image") || ct.includes("json"))) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
      }
      return res;
    })()
  );
});

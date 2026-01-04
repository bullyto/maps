/* Apéro de Nuit • Suivi — Service Worker (agressif + offline)
   - Incrémente APP_VERSION à chaque déploiement
*/
const APP_VERSION = "2.0.0";
const CACHE = "adn-suivi-cache-v2";

const PRECACHE = [
  "./",
  "./index.html",
  "./client.html",
  "./driver.html",
  "./offline.html",
  "./styles.css",
  "./app.js",
  "./shared.js",
  "./client.js",
  "./driver.js",
  "./manifest.webmanifest",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE.map(u => new Request(u, { cache: "reload" })));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE) ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(CACHE);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await caches.match(request);
    return cached || caches.match("./offline.html");
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    fetch(request).then(async (fresh) => {
      const cache = await caches.open(CACHE);
      cache.put(request, fresh.clone());
    }).catch(() => {});
    return cached;
  }
  const fresh = await fetch(request);
  const cache = await caches.open(CACHE);
  cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }

  const isAsset =
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".webmanifest") ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/";

  if (isAsset) {
    event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(networkFirst(req));
});

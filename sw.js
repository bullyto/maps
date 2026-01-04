/* Apéro de Nuit • Service Worker — forcing updates (agressif)
   - Incrémente APP_VERSION à chaque déploiement
   - skipWaiting + clientsClaim (activation immédiate)
   - purge anciens caches
   - stratégie:
       * navigation: network-first + fallback offline
       * assets: cache-first + refresh en arrière plan
*/
const APP_VERSION = "1.0.0";
const CACHE = "adn-pwa-2.0";

const PRECACHE = [
  "./",
  "./index.html",
  "./offline.html",
  "./map.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Requête "no-cache" pour éviter de précacher une ancienne version si le serveur renvoie du cache HTTP
    await cache.addAll(PRECACHE.map(u => new Request(u, { cache: "reload" })));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE) ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.postMessage({ type: "SW_READY", version: APP_VERSION });
    }
  })());
});

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
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
    // refresh en arrière plan
    fetch(request).then(async (fresh) => {
      const cache = await caches.open(CACHE);
      cache.put(request, fresh.clone());
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.postMessage({ type: "SW_UPDATED", version: APP_VERSION });
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

  // Ne gère que le même origin
  if (url.origin !== location.origin) return;

  // Navigations (index, map, etc.)
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }

  // Pour les fichiers statiques: cache-first
  const isAsset =
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".webmanifest") ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/";

  if (isAsset) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Par défaut: network-first
  event.respondWith(networkFirst(req));
});

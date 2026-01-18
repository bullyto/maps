/*
  Service Worker (optionnel)
  - On garde un SW simple (cache statique) au cas où tu veux l'activer plus tard.
  - AUCUN OneSignal ici.
*/

const VERSION = "v2026-01-18-client";
const CACHE = `adn66-client-${VERSION}`;

const ASSETS = [
  "./",
  "./index.html",
  "./client.html",
  "./client.js",
  "./config.js",
  "./style.css",
  "./offline.html",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // On ne cache pas les requêtes vers le Worker (API)
  try {
    const url = new URL(req.url);
    if (url.hostname.endsWith("workers.dev")) return;
  } catch (_) {}

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // Cache uniquement GET OK
        if (req.method === "GET" && resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match("./offline.html"));
    })
  );
});

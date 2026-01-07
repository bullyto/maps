// Apéro de Nuit 66 • Maps — Service Worker (Offline cache + OneSignal Web Push)
// Scope: /maps/
//
// Objectifs:
// 1) OneSignal: permettre de recevoir des notifications même PWA fermée (driver).
// 2) Offline cache: rendre l’UI utilisable hors-ligne (best effort).
// 3) Robustesse: ne jamais faire échouer l’install si un fichier listé n’existe pas.
// 4) Eviter les bugs: ne pas cacher OneSignal ni l’API Cloudflare Workers.

try {
  // OneSignal (push)
  importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
  // Si offline à l'install, l'app reste utilisable; les push arriveront quand le SDK sera accessible.
}

const VERSION = "v2026-01-07";
const CACHE_NAME = `adn66-maps-${VERSION}`;

// Assets "core" (best effort)
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./client.html",
  "./driver.html",
  "./offline.html",

  "./app.js",
  "./client.js",
  "./driver.js",
  "./shared.js",
  "./config.js",

  "./style.css",
  "./styles.css",
  "./manifest.webmanifest",

  "./icons/marker-client.svg",
  "./icons/marker-driver.svg",

  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
];

// Cache un asset s'il existe (sinon ignore)
async function cacheIfOk(cache, url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res && res.ok) {
      await cache.put(url, res.clone());
      return true;
    }
  } catch (_) {}
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const asset of CORE_ASSETS) {
      await cacheIfOk(cache, asset);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // 1) OneSignal => réseau direct (évite mismatch SDK)
  if (
    url.hostname.includes("onesignal.com") ||
    url.hostname.includes("cdn.onesignal.com") ||
    url.pathname.includes("OneSignal")
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // 2) API Cloudflare Workers => réseau direct + fallback cache
  if (url.hostname.endsWith("workers.dev")) {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch {
        const cached = await caches.match(req);
        return cached || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // 3) Cache-first pour le reste
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);

      if (res && res.ok) {
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (
          ct.includes("text/") ||
          ct.includes("javascript") ||
          ct.includes("application/json") ||
          ct.includes("image/") ||
          ct.includes("font/") ||
          ct.includes("css")
        ) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, res.clone());
        }
      }
      return res;
    } catch {
      // Offline fallback pour navigation
      const accept = req.headers.get("accept") || "";
      if (accept.includes("text/html")) {
        const offline = await caches.match("./offline.html");
        if (offline) return offline;
        const index = await caches.match("./index.html");
        if (index) return index;
      }
      return new Response("Offline", { status: 503 });
    }
  })());
});

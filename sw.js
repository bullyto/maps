// ADN66 Suivi Livreur — Service Worker (Offline cache + OneSignal Web Push)
// Scope: /maps/
//
// Objectifs:
// 1) Permettre à OneSignal de recevoir des notifications même PWA fermée (via SW).
// 2) Garder un cache offline pour les assets essentiels.
// 3) Ne JAMAIS casser l'install si un asset listé n'existe pas (pas de addAll "fragile").
// 4) Ne pas mettre en cache OneSignal / API Cloudflare (toujours network).

// --- OneSignal SW (push) ---
try {
  importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch (e) {
  // Offline au moment de l'install => le SW continue quand même.
  // Les push ne seront dispo qu'une fois la ressource OneSignal accessible.
}

const VERSION = "v2026-01-06";
const CACHE_NAME = `adn66-maps-${VERSION}`;

// Liste d'assets "essentiels" (best effort).
// IMPORTANT: on ne doit PAS échouer si un fichier manque.
const CORE_ASSETS = [
  "./",
  "./driver.html",
  "./driver.js",
  "./client.html",
  "./client.js",
  "./index.html",
  "./offline.html",
  "./shared.js",
  "./config.js",
  "./app.js",
  "./style.css",
  "./manifest.webmanifest",

  // icons fréquents dans ton repo maps
  "./icons/marker-client.svg",
  "./icons/marker-driver.svg",

  // pwa icons (si présents)
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

// Petite fonction: cache un fichier si dispo, sinon ignore.
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

    // Cache "best effort": on tente chaque asset un par un (aucun échec global)
    for (const asset of CORE_ASSETS) {
      await cacheIfOk(cache, asset);
    }

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // On ne gère que GET
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // 1) Bypass OneSignal (TOUJOURS réseau)
  if (
    url.hostname.includes("onesignal.com") ||
    url.hostname.includes("cdn.onesignal.com") ||
    url.pathname.includes("OneSignal")
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // 2) Bypass API Cloudflare Workers (TOUJOURS réseau + fallback cache si dispo)
  if (url.hostname.endsWith("workers.dev")) {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (_) {
        const cached = await caches.match(req);
        return cached || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // 3) Stratégie pour le reste:
  // - Cache-first pour assets statiques
  // - Network fallback
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);

      // Mettre en cache uniquement si OK et type plausible
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
    } catch (_) {
      // Fallback offline:
      // - si c'est une navigation (page), on renvoie offline.html si dispo
      const accept = req.headers.get("accept") || "";
      if (accept.includes("text/html")) {
        const offline = await caches.match("./offline.html");
        if (offline) return offline;

        const driver = await caches.match("./driver.html");
        if (driver) return driver;
      }

      // Sinon, dernier recours
      return new Response("Offline", { status: 503 });
    }
  })());
});

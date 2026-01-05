const CACHE = "and-suivi-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./client.html",
  "./driver.html",
  "./style.css",
  "./client.js",
  "./driver.js",
  "./shared.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./icons/marker-client.svg",
  "./icons/marker-driver.svg",
];

self.addEventListener("install", (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", (e)=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", (e)=>{
  const url = new URL(e.request.url);
  if(url.origin !== location.origin) return; // laisse réseau pour OSM + Worker CF
  e.respondWith(
    caches.match(e.request).then(r=> r || fetch(e.request).then(res=>{
      const copy = res.clone();
      caches.open(CACHE).then(c=>c.put(e.request, copy));
      return res;
    }).catch(()=>caches.match("./client.html")))
  );
});

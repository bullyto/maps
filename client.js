import { qs, apiFetchJson, setText, shortToken, getOrCreateClientId, fmtAgo } from "./shared.js";

const els = {
  api: document.getElementById("api"),
  session: document.getElementById("session"),
  status: document.getElementById("status"),
  pill: document.getElementById("pill"),
  dot: document.getElementById("dot"),
  meta: document.getElementById("meta"),
  countdown: document.getElementById("countdown"),
  btnRequest: document.getElementById("btnRequest"),
  btnRecenter: document.getElementById("btnRecenter"),
  btnNotif: document.getElementById("btnNotif"),
};

const params = qs();
if(params.get("api")) els.api.value = decodeURIComponent(params.get("api"));
if(params.get("session")) els.session.value = decodeURIComponent(params.get("session"));

const clientId = getOrCreateClientId();

let map, meMarker, driverMarker, link;
let lastMe = null;
let lastDriver = null;
let pollTimer = null;
let watchId = null;
let sessionId = null;
let expiresAt = null;
let arrivalNotified = false;

function setState(kind, txt){
  setText(els.pill, txt);
  els.dot.classList.remove("ok","bad");
  if(kind==="ok") els.dot.classList.add("ok");
  if(kind==="bad") els.dot.classList.add("bad");
}

function initMap(){
  map = L.map('map', { zoomControl: true }).setView([42.6887, 2.8948], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  meMarker = L.circleMarker([42.6887, 2.8948], { radius: 7 }).addTo(map).bindPopup("Moi");
  driverMarker = L.circleMarker([42.6887, 2.8948], { radius: 9 }).addTo(map).bindPopup("Livreur");
  link = L.polyline([[42.6887, 2.8948],[42.6887, 2.8948]], { weight: 6, opacity: 0.25 }).addTo(map);
}

function center(){
  const pts = [];
  if(lastMe) pts.push(lastMe);
  if(lastDriver) pts.push(lastDriver);
  if(pts.length===0) return;
  if(pts.length===1) map.setView(pts[0], Math.max(map.getZoom(), 16));
  else map.fitBounds(L.latLngBounds(pts).pad(0.25));
}
els.btnRecenter.addEventListener("click", center);

els.btnNotif.addEventListener("click", async () => {
  try {
    if(!("Notification" in window)) throw new Error("Notifications non supportées");
    const p = await Notification.requestPermission();
    if(p !== "granted") throw new Error("Permission refusée");
    els.btnNotif.textContent = "Notif ✓";
  } catch(e) {
    alert(e.message || e);
  }
});

function updateCountdown(){
  if(!expiresAt) { setText(els.countdown, ""); return; }
  const ms = expiresAt - Date.now();
  if(ms <= 0) {
    setText(els.countdown, "Accès terminé.");
    return;
  }
  const m = Math.floor(ms/60000);
  const s = Math.floor((ms%60000)/1000);
  setText(els.countdown, `Accès actif • expire dans ${m}m ${s}s`);
}
setInterval(updateCountdown, 1000);

async function startWatchPosition() {
  if(!navigator.geolocation) throw new Error("GPS non disponible");
  if(watchId) return;

  watchId = navigator.geolocation.watchPosition(async (pos) => {
    lastMe = [pos.coords.latitude, pos.coords.longitude];
    meMarker.setLatLng(lastMe);

    if(sessionId) {
      const api = els.api.value.trim().replace(/\/+$/,"");
      fetch(api + "/client/ping", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          session: sessionId,
          client_id: clientId,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: pos.coords.accuracy || null,
          ts: Date.now()
        })
      }).catch(()=>{});
    }

    link.setLatLngs([lastMe, lastDriver || lastMe]);
  }, () => {
    setText(els.status, "GPS refusé");
    setState("bad","GPS refusé");
  }, { enableHighAccuracy:true, maximumAge:1000, timeout:15000 });
}

async function requestFollow() {
  const api = els.api.value.trim().replace(/\/+$/,"");
  if(!api) return alert("Ajoute l'URL de ton Worker");
  setText(els.status, "Demande…");
  setState("", "Demande…");

  // GPS obligatoire
  const pos = await new Promise((resolve, reject) => {
    if(!navigator.geolocation) return reject(new Error("GPS non disponible"));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy:true,
      timeout:15000,
      maximumAge:0
    });
  }).catch(() => null);

  if(!pos) {
    setText(els.status, "GPS requis");
    setState("bad","GPS requis");
    return alert("Tu dois accepter la géolocalisation pour suivre la commande.");
  }

  const data = await apiFetchJson(api + "/client/request", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      client_id: clientId,
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      acc: pos.coords.accuracy || null,
      home_lat: pos.coords.latitude,
      home_lng: pos.coords.longitude,
      ts: Date.now(),
    })
  });

  sessionId = data.session;
  expiresAt = null;
  arrivalNotified = false;
  els.session.value = sessionId;

  const u = new URL(location.href);
  u.searchParams.set("api", encodeURIComponent(api));
  u.searchParams.set("session", encodeURIComponent(sessionId));
  history.replaceState(null, "", u.toString());

  setText(els.status, "En attente d'acceptation…");
  setState("", "En attente");

  await startWatchPosition();
  startPolling();
}

els.btnRequest.addEventListener("click", () => requestFollow().catch(e => {
  alert(e.message || e);
  setText(els.status, "Erreur");
  setState("bad","Erreur");
}));

async function pollState(){
  const api = els.api.value.trim().replace(/\/+$/,"");
  if(!api || !sessionId) return;

  const data = await apiFetchJson(api + "/client/state?session=" + encodeURIComponent(sessionId));

  if(data.status === "pending") {
    setText(els.status, "En attente d'acceptation…");
    setState("", "En attente");
  } else if(data.status === "denied") {
    setText(els.status, "Refusé");
    setState("bad", "Refusé");
    stopAll();
    return;
  } else if(data.status === "expired") {
    setText(els.status, "Expiré");
    setState("bad", "Expiré");
    stopAll();
    return;
  } else if(data.status === "active") {
    setText(els.status, "Suivi actif");
    setState("ok", "En ligne");
    expiresAt = data.expires_at || null;
  }

  if(data.driver?.lat != null && data.driver?.lng != null) {
    lastDriver = [Number(data.driver.lat), Number(data.driver.lng)];
    driverMarker.setLatLng(lastDriver);
    link.setLatLngs([lastMe || lastDriver, lastDriver]);
    setText(els.meta, `Maj: ${fmtAgo(Number(data.driver.ts)||0)} • Session: ${shortToken(sessionId)}`);
  }

  if(data.arrival === true && !arrivalNotified) {
    arrivalNotified = true;
    try {
      if("Notification" in window && Notification.permission === "granted") {
        new Notification("Apéro de Nuit", { body: "Ton livreur est presque là (≈ 500m) 🍻" });
      }
      if(navigator.vibrate) navigator.vibrate([150, 80, 150]);
      alert("Ton livreur est presque là 🍻");
    } catch(e) {}
  }
}

function startPolling(){
  if(pollTimer) return;
  pollState().catch(()=>{});
  pollTimer = setInterval(() => pollState().catch(()=>{}), 3000);
}

function stopAll(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if(watchId) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function hydrateFromUrl(){
  const api = els.api.value.trim().replace(/\/+$/,"");
  const sess = els.session.value.trim();
  if(api && sess) {
    sessionId = sess;
    startWatchPosition().catch(()=>{});
    startPolling();
    setText(els.status, "Connexion…");
    setState("", "Connexion");
  }
}

initMap();
hydrateFromUrl();

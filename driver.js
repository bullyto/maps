/* driver.js — version clean & robuste
   - PIN (0000 par défaut)
   - Carte Leaflet
   - GPS start/stop
   - Dashboard: affiche réellement pending + active
   - Bouton Notifications propre (OneSignal plus tard, UI déjà clean)
*/

import { CONFIG } from "./config.js";

/* -------------------- CONFIG / CONSTANTES -------------------- */
const API_BASE = (CONFIG && CONFIG.API_BASE) ? String(CONFIG.API_BASE).replace(/\/+$/, "") : "";
const DRIVER_PIN = (CONFIG && (CONFIG.DRIVER_PIN || CONFIG.DRIVER_PIN_CODE || CONFIG.PIN)) ? String(CONFIG.DRIVER_PIN || CONFIG.DRIVER_PIN_CODE || CONFIG.PIN) : "0000";

// OneSignal (tu m’as dit: on finalise après – mais on prépare un bouton propre)
const ONESIGNAL_APP_ID = (CONFIG && (CONFIG.ONESIGNAL_APP_ID || CONFIG.ONE_SIGNAL_APP_ID)) ? String(CONFIG.ONESIGNAL_APP_ID || CONFIG.ONE_SIGNAL_APP_ID) : "62253f55-1377-45fe-a47b-6676d43db125";

/* LocalStorage keys */
const LS_TOKEN = "adn_driver_token";
const LS_GPS_ON = "adn_driver_gps_on";

/* Timers */
const DASH_INTERVAL_MS = 3500;
const GPS_INTERVAL_MS = 3500;

/* -------------------- DOM -------------------- */
const els = {
  chipDot: document.getElementById("chipDot"),
  chipText: document.getElementById("chipText"),

  gpsStatus: document.getElementById("gpsStatus"),
  gpsSub: document.getElementById("gpsSub"),
  lastUpdate: document.getElementById("lastUpdate"),
  lastUpdateSub: document.getElementById("lastUpdateSub"),

  demandsCount: document.getElementById("demandsCount"),
  demandsSub: document.getElementById("demandsSub"),

  notifStatus: document.getElementById("notifStatus"),
  notifSub: document.getElementById("notifSub"),

  pendingList: document.getElementById("pendingList"),
  activeList: document.getElementById("activeList"),
  pendingEmpty: document.getElementById("pendingEmpty"),
  activeEmpty: document.getElementById("activeEmpty"),

  btnStartGps: document.getElementById("btnStartGps"),
  btnStopGps: document.getElementById("btnStopGps"),
  btnRecenter: document.getElementById("btnRecenter"),
  btnNotif: document.getElementById("btnNotif"),

  status: document.getElementById("status"),

  pinOverlay: document.getElementById("pinOverlay"),
  pinInput: document.getElementById("pinInput"),
  pinSubmit: document.getElementById("pinSubmit"),
  pinError: document.getElementById("pinError"),
};

/* -------------------- ÉTAT -------------------- */
let driverToken = localStorage.getItem(LS_TOKEN) || "";
let dashTimer = null;
let gpsTimer = null;

let map = null;
let marker = null;
let lastPos = null;

/* -------------------- UTILS -------------------- */
function setStatus(msg, isError=false){
  if (!els.status) return;
  els.status.textContent = msg || "";
  els.status.style.color = isError ? "rgba(255,210,215,.95)" : "rgba(234,244,255,.72)";
}

function formatTime(ts){
  try{
    if (!ts) return "—";
    const d = (typeof ts === "number") ? new Date(ts) : new Date(String(ts));
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("fr-FR", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  }catch{ return "—"; }
}

function safeText(v, fallback="—"){
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

function setOnlineChip(isOnline){
  els.chipDot.classList.remove("good","bad","warn");
  els.chipDot.classList.add(isOnline ? "good" : "bad");
  els.chipText.textContent = isOnline ? "Livreur en ligne" : "Livreur hors ligne";
}

async function apiFetch(path, opts={}){
  if (!API_BASE) throw new Error("CONFIG.API_BASE manquant");
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(opts.headers || {})
    },
    cache: "no-store",
  });
  const text = await res.text();
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch{ data = { raw:text }; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/* -------------------- PIN -------------------- */
function showPin(){
  els.pinOverlay.classList.add("show");
  els.pinError.classList.remove("show");
  setTimeout(() => els.pinInput?.focus(), 50);
}
function hidePin(){
  els.pinOverlay.classList.remove("show");
}

function checkPin(pin){
  return String(pin || "").trim() === DRIVER_PIN;
}

function ensureAuth(){
  // token présent => ok
  if (driverToken) return true;

  // sinon on force PIN
  showPin();
  return false;
}

/* -------------------- MAP -------------------- */
function initMap(){
  if (map) return;

  map = L.map("miniMap", { zoomControl:true, attributionControl:true }).setView([42.6887, 2.8948], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  marker = L.marker([42.6887, 2.8948]).addTo(map);

  // petite correction quand c’est dans des cards
  setTimeout(() => map.invalidateSize(true), 250);
}

function updateMarker(lat, lon){
  if (!map || !marker) return;
  if (typeof lat !== "number" || typeof lon !== "number") return;
  lastPos = { lat, lon };
  marker.setLatLng([lat, lon]);
}

function recenter(){
  if (!map || !lastPos) return;
  map.setView([lastPos.lat, lastPos.lon], 15, { animate:true });
}

/* -------------------- GPS -------------------- */
function setGpsUi(isOn){
  if (isOn){
    els.gpsStatus.textContent = "Actif";
    els.gpsSub.textContent = "Envoi position…";
    els.btnStartGps.classList.add("disabled");
    els.btnStartGps.disabled = true;

    els.btnStopGps.classList.remove("disabled");
    els.btnStopGps.disabled = false;

    setOnlineChip(true);
  } else {
    els.gpsStatus.textContent = "Inactif";
    els.gpsSub.textContent = "GPS arrêté";
    els.btnStartGps.classList.remove("disabled");
    els.btnStartGps.disabled = false;

    els.btnStopGps.classList.add("disabled");
    els.btnStopGps.disabled = true;

    setOnlineChip(false);
  }
}

async function pushGpsOnce(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Géolocalisation indisponible"));

    navigator.geolocation.getCurrentPosition(async (pos) => {
      try{
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        updateMarker(lat, lon);

        // On envoie au backend (si endpoint dispo)
        // (on reste tolérant si ton worker n’attend pas exactement ça)
        try{
          await apiFetch(`/driver/update`, {
            method: "POST",
            body: JSON.stringify({
              driver_token: driverToken,
              lat,
              lon,
              ts: Date.now(),
              accuracy: pos.coords.accuracy,
            }),
          });
        }catch(e){
          // pas bloquant : on veut surtout que l’UI continue
          console.warn("driver/update failed:", e?.message || e);
        }

        els.lastUpdate.textContent = "à l'instant";
        els.lastUpdateSub.textContent = formatTime(Date.now());
        resolve(true);
      }catch(err){ reject(err); }
    }, (err) => reject(err), { enableHighAccuracy:true, maximumAge:1000, timeout:12000 });
  });
}

function startGps(){
  if (!ensureAuth()) return;
  localStorage.setItem(LS_GPS_ON, "1");
  setGpsUi(true);

  // 1er envoi direct
  pushGpsOnce().catch(e => setStatus(`GPS: ${e.message || e}`, true));

  clearInterval(gpsTimer);
  gpsTimer = setInterval(() => {
    pushGpsOnce().catch(() => {});
  }, GPS_INTERVAL_MS);
}

function stopGps(){
  localStorage.removeItem(LS_GPS_ON);
  clearInterval(gpsTimer);
  gpsTimer = null;
  setGpsUi(false);
}

/* -------------------- RENDER DEMANDES -------------------- */
function renderEmpty(listEl, emptyEl, isEmpty){
  if (!listEl || !emptyEl) return;
  emptyEl.style.display = isEmpty ? "block" : "none";
}

function buildPendingItem(req){
  // On reste ultra tolérant (car ton backend peut envoyer des champs différents)
  const id = req.id || req.request_id || req.session_id || req.sid || req.token || "";
  const title = safeText(req.title || req.customer_name || req.name || req.client || "Nouvelle demande");
  const city = safeText(req.city || req.ville || "");
  const address = safeText(req.address || req.adresse || req.addr || "");
  const when = safeText(req.created_at || req.ts || req.time || "");

  const wrap = document.createElement("div");
  wrap.className = "item";

  const top = document.createElement("div");
  top.className = "itemTop";

  const left = document.createElement("div");
  const t = document.createElement("div");
  t.className = "itemTitle";
  t.textContent = title;

  const meta = document.createElement("div");
  meta.className = "itemMeta";
  meta.textContent = [address, city].filter(Boolean).join(" • ") || "—";

  const meta2 = document.createElement("div");
  meta2.className = "itemMeta";
  meta2.textContent = when ? `Reçue: ${safeText(when)}` : "";

  left.appendChild(t);
  left.appendChild(meta);
  if (when) left.appendChild(meta2);

  const right = document.createElement("div");
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = "En attente";
  right.appendChild(pill);

  top.appendChild(left);
  top.appendChild(right);

  const actions = document.createElement("div");
  actions.className = "itemActions";

  const btnOk = document.createElement("button");
  btnOk.className = "miniBtn";
  btnOk.textContent = "Accepter";

  const btnNo = document.createElement("button");
  btnNo.className = "miniBtn bad";
  btnNo.textContent = "Refuser";

  btnOk.onclick = async () => {
    btnOk.disabled = true; btnNo.disabled = true;
    setStatus("Acceptation…");
    try{
      await sendDecision(id, "accept");
      await refreshDashboard(true);
      setStatus("Demande acceptée ✅");
    }catch(e){
      setStatus(`Erreur acceptation: ${e.message || e}`, true);
      btnOk.disabled = false; btnNo.disabled = false;
    }
  };

  btnNo.onclick = async () => {
    btnOk.disabled = true; btnNo.disabled = true;
    setStatus("Refus…");
    try{
      await sendDecision(id, "reject");
      await refreshDashboard(true);
      setStatus("Demande refusée ✅");
    }catch(e){
      setStatus(`Erreur refus: ${e.message || e}`, true);
      btnOk.disabled = false; btnNo.disabled = false;
    }
  };

  actions.appendChild(btnOk);
  actions.appendChild(btnNo);

  wrap.appendChild(top);
  wrap.appendChild(actions);
  return wrap;
}

function buildActiveItem(it){
  const title = safeText(it.title || it.customer_name || it.name || it.client || "Suivi");
  const city = safeText(it.city || it.ville || "");
  const address = safeText(it.address || it.adresse || it.addr || "");
  const eta = it.eta_min || it.eta || it.minutes || null;

  const wrap = document.createElement("div");
  wrap.className = "item";

  const top = document.createElement("div");
  top.className = "itemTop";

  const left = document.createElement("div");
  const t = document.createElement("div");
  t.className = "itemTitle";
  t.textContent = title;

  const meta = document.createElement("div");
  meta.className = "itemMeta";
  meta.textContent = [address, city].filter(Boolean).join(" • ") || "—";

  left.appendChild(t);
  left.appendChild(meta);

  const right = document.createElement("div");
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = eta ? `ETA ~ ${eta} min` : "Actif";
  right.appendChild(pill);

  top.appendChild(left);
  top.appendChild(right);
  wrap.appendChild(top);

  return wrap;
}

/* -------------------- API DECISION / DASHBOARD -------------------- */
async function sendDecision(requestId, decision){
  if (!ensureAuth()) return;
  // backend tolérant: on envoie plusieurs clés possibles
  return apiFetch(`/driver/decision`, {
    method:"POST",
    body: JSON.stringify({
      driver_token: driverToken,
      request_id: requestId,
      id: requestId,
      decision,
    }),
  });
}

function normalizeDashboard(d){
  // On tolère tout:
  // - d.pending / d.pending_requests / d.requests_pending
  // - d.active / d.active_tracks / d.tracks
  const pending =
    d?.pending ||
    d?.pending_requests ||
    d?.requests_pending ||
    d?.demands_pending ||
    [];

  const active =
    d?.active ||
    d?.active_tracks ||
    d?.tracks ||
    d?.actifs ||
    [];

  const gps =
    d?.gps_active ?? d?.gps ?? d?.driver_gps ?? null;

  return { pending: Array.isArray(pending) ? pending : [], active: Array.isArray(active) ? active : [], gps };
}

async function refreshDashboard(silent=false){
  if (!ensureAuth()) return;

  try{
    if (!silent) setStatus("Actualisation…");

    // IMPORTANT: je garde le param driver_token car c’est ce que tu avais avant
    const d = await apiFetch(`/driver/dashboard?driver_token=${encodeURIComponent(driverToken)}`, { method:"GET" });
    const { pending, active } = normalizeDashboard(d);

    // compteur demandes = pending
    els.demandsCount.textContent = String(pending.length);
    els.demandsSub.textContent = pending.length > 0 ? "En attente" : "Aucune";

    // PENDING list
    els.pendingList.innerHTML = "";
    if (pending.length === 0){
      renderEmpty(els.pendingList, els.pendingEmpty, true);
    } else {
      renderEmpty(els.pendingList, els.pendingEmpty, false);
      pending.forEach(req => els.pendingList.appendChild(buildPendingItem(req)));
    }

    // ACTIVE list
    els.activeList.innerHTML = "";
    if (active.length === 0){
      renderEmpty(els.activeList, els.activeEmpty, true);
    } else {
      renderEmpty(els.activeList, els.activeEmpty, false);
      active.forEach(it => els.activeList.appendChild(buildActiveItem(it)));
    }

    // dernière maj UI
    els.lastUpdate.textContent = formatTime(Date.now());
    els.lastUpdateSub.textContent = "Dashboard";

    if (!silent) setStatus("OK");
  }catch(e){
    setStatus(`Dashboard: ${e.message || e}`, true);
  }
}

/* -------------------- NOTIFICATIONS (UI propre) -------------------- */
function setNotifUi(state, sub=""){
  els.notifStatus.textContent = state;
  els.notifSub.textContent = sub || "—";
  if (state === "Activées"){
    els.btnNotif.textContent = "Notifications activées";
    els.btnNotif.classList.add("disabled");
    els.btnNotif.disabled = true;
  }else{
    els.btnNotif.textContent = "Activer notifications";
    els.btnNotif.classList.remove("disabled");
    els.btnNotif.disabled = false;
  }
}

async function initOneSignal(){
  // on fait soft: si le SDK n’est pas prêt, on n’explose pas l’app
  try{
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async function(OneSignal) {
      await OneSignal.init({
        appId: ONESIGNAL_APP_ID,
        allowLocalhostAsSecureOrigin: true,
      });
    });
  }catch(e){
    console.warn("OneSignal init err:", e);
  }
}

async function requestNotifications(){
  try{
    if (!("Notification" in window)){
      setNotifUi("Indispo", "Notifications non supportées");
      return;
    }

    // déjà accepté ?
    if (Notification.permission === "granted"){
      setNotifUi("Activées", "Permission déjà accordée");
      return;
    }

    // OneSignal si dispo, sinon permission native
    let usedOneSignal = false;
    if (window.OneSignalDeferred){
      usedOneSignal = true;
      window.OneSignalDeferred.push(async function(OneSignal){
        try{
          await OneSignal.Notifications.requestPermission();
        }catch(e){
          console.warn("OneSignal permission err:", e);
        }
      });
    }

    if (!usedOneSignal){
      const p = await Notification.requestPermission();
      if (p !== "granted"){
        setNotifUi("Refusées", "Permission refusée");
        return;
      }
    }

    // Update UI
    if (Notification.permission === "granted"){
      setNotifUi("Activées", "OK");
    }else{
      setNotifUi("Refusées", "Permission refusée");
    }
  }catch(e){
    setNotifUi("Erreur", e.message || String(e));
  }
}

/* -------------------- EVENTS -------------------- */
els.btnStartGps.addEventListener("click", startGps);
els.btnStopGps.addEventListener("click", stopGps);
els.btnRecenter.addEventListener("click", () => recenter());
els.btnNotif.addEventListener("click", () => requestNotifications());

els.pinSubmit.addEventListener("click", () => {
  const pin = els.pinInput.value;
  if (checkPin(pin)){
    driverToken = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    localStorage.setItem(LS_TOKEN, driverToken);
    hidePin();
    setStatus("Accès OK ✅");
    // démarre ce qui doit démarrer
    initAfterAuth();
  } else {
    els.pinError.classList.add("show");
  }
});

els.pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.pinSubmit.click();
});

/* -------------------- INIT -------------------- */
function initAfterAuth(){
  initMap();

  // notif UI
  if ("Notification" in window && Notification.permission === "granted"){
    setNotifUi("Activées", "Permission accordée");
  }else{
    setNotifUi("Désactivées", "À activer");
  }

  // dashboard loop
  refreshDashboard(true);
  clearInterval(dashTimer);
  dashTimer = setInterval(() => refreshDashboard(true), DASH_INTERVAL_MS);

  // si GPS auto
  if (localStorage.getItem(LS_GPS_ON) === "1"){
    startGps();
  }else{
    setGpsUi(false);
  }
}

(function boot(){
  // Map init tout de suite (sinon écran “vide”)
  initMap();

  // one signal soft init
  initOneSignal();

  // Auth
  if (driverToken){
    hidePin();
    initAfterAuth();
  }else{
    // pas de token => pin
    showPin();
    setGpsUi(false);
    setNotifUi("Désactivées", "À activer");
    setOnlineChip(false);
  }
})();

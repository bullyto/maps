import { API_BASE, MAX_MINUTES, DRIVER_PIN, ONESIGNAL_APP_ID } from "./config.js";
import { apiFetchJson, setText, fmtAgo, getOrCreateDriverToken } from "./shared.js";

const els = {
  overlay: document.getElementById("pinOverlay"),
  pinInput: document.getElementById("pinInput"),
  pinBtn: document.getElementById("pinBtn"),
  pinErr: document.getElementById("pinErr"),
  app: document.getElementById("app"),

  driverStatus: document.getElementById("driverStatus"),
  gpsState: document.getElementById("gpsState"),
  lastUpdate: document.getElementById("lastUpdate"),
  pendingCount: document.getElementById("pendingCount"),

  btnGps: document.getElementById("btnGps"),
  btnGpsStop: document.getElementById("btnGpsStop"),
  btnRecenter: document.getElementById("btnRecenter"),
  btnNotif: document.getElementById("btnNotif"),

  listPending: document.getElementById("listPending"),
  listActive: document.getElementById("listActive"),
};

const LS = {
  pinOk: "adn_driver_pin_ok_v1",
};

const driverToken = getOrCreateDriverToken();

let map, markerDriver;
let watchId = null;
let lastDriverLatLng = null;
let didCenterOnce = false;

const markers = new Map(); // session -> marker
const sessionData = new Map(); // session -> row (pending/active)

const ICON_CLIENT = L.icon({ iconUrl: "./icons/marker-client.svg", iconSize: [44, 44], iconAnchor: [22, 44] });
const ICON_DRIVER  = L.icon({ iconUrl: "./icons/marker-driver.svg",  iconSize: [48, 48], iconAnchor: [24, 48] });

function initMap() {
  map = L.map("map", { zoomControl: true });
  map.setView([42.6887, 2.8948], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  markerDriver = L.marker([42.6887, 2.8948], { icon: ICON_DRIVER }).addTo(map);
}

function updateDriverMarker(lat, lng) {
  lastDriverLatLng = [lat, lng];
  if (markerDriver) markerDriver.setLatLng(lastDriverLatLng);
}


function showPinGate() {
  els.overlay.style.display = "flex";
  els.app.style.display = "none";
  els.pinInput.value = "";
  els.pinInput.focus();
}

function hidePinGate() {
  els.overlay.style.display = "none";
  els.app.style.display = "block";
}

function checkPin() {
  const ok = localStorage.getItem(LS.pinOk) === "1";
  if (ok) return true;
  showPinGate();
  return false;
}

function acceptPin() {
  const v = (els.pinInput.value || "").trim();
  if (v === DRIVER_PIN) {
    localStorage.setItem(LS.pinOk, "1");
    hidePinGate();
    bootAfterGate();
  } else {
    els.pinErr.style.display = "block";
    els.pinInput.focus();
  }
}


// --- Notifications (OneSignal) ---
// Objectif: ajouter un simple bouton "Activer notifications" sans impacter la carte / GPS.
const OneSignal = window.OneSignal || [];
window.OneSignal = OneSignal;
let oneSignalInited = false;

function ensureOneSignalStub() {
  // OneSignal v16 charge un global, mais on sécurise au cas où
  window.OneSignal = window.OneSignal || [];
  return window.OneSignal;
}

function setNotifBtnState(state) {
  // state: "idle" | "working" | "granted" | "denied"
  if (!els.btnNotif) return;
  if (state === "working") {
    els.btnNotif.disabled = true;
    els.btnNotif.textContent = "⏳ Demande en cours…";
    return;
  }
  if (state === "granted") {
    els.btnNotif.disabled = true;
    els.btnNotif.textContent = "✅ Notifications activées";
    return;
  }
  if (state === "denied") {
    els.btnNotif.disabled = true;
    els.btnNotif.textContent = "⛔ Notifications refusées";
    return;
  }
  // idle
  els.btnNotif.disabled = false;
  els.btnNotif.textContent = "🔔 Activer notifications";
}

function initOneSignal() {
  if (oneSignalInited) return true;
  if (!ONESIGNAL_APP_ID) return false;

  try {
    ensureOneSignalStub();

    // On force OneSignal à utiliser TON sw.js + ton scope (évite le conflit de SW)
    OneSignal.push(async () => {
      try {
        await OneSignal.init({
          appId: ONESIGNAL_APP_ID,
          notifyButton: { enable: false },

          // 🔒 IMPORTANT : OneSignal utilise le même SW que ta PWA
          serviceWorkerPath: "./sw.js",
          serviceWorkerUpdaterPath: "./sw.js",
          serviceWorkerParam: { scope: "./" },
        });
      } catch (e) {
        console.log("[OneSignal] init error:", e);
      }
    });

    oneSignalInited = true;
    return true;
  } catch (e) {
    console.log("[OneSignal] init failed:", e);
    return false;
  }
}

async function requestNotifications() {
  // ✅ La version "qui marche" : SW -> init -> requestPermission dans OneSignal.push
  try {
    setNotifBtnState("working");

    // SW d'abord (sinon OneSignal peut partir sur un autre scope)
    await registerSW();

    const ok = initOneSignal();
    if (!ok) {
      // fallback si OneSignal pas dispo
      const perm = await (Notification?.requestPermission?.() ?? Promise.resolve("default"));
      const granted = perm === "granted" || (Notification && Notification.permission === "granted");
      setNotifBtnState(granted ? "granted" : (perm === "denied" ? "denied" : "idle"));
      return;
    }

    // OneSignal API v16 : doit se faire après init, donc on met tout dans push()
    await new Promise((resolve) => {
      OneSignal.push(async () => {
        try {
          await OneSignal.Notifications.requestPermission();
        } catch (e) {
          console.log("[OneSignal] requestPermission error:", e);
          try { await Notification.requestPermission(); } catch (_) {}
        }
        resolve();
      });
    });

    const perm = (Notification && Notification.permission) ? Notification.permission : "default";
    if (perm === "granted") setNotifBtnState("granted");
    else if (perm === "denied") setNotifBtnState("denied");
    else setNotifBtnState("idle");
  } catch (e) {
    console.log("[Notif] error:", e);
    setNotifBtnState("idle");
  }
}


async function registerSW() {
  // SW uniquement ici (livreur)
  try {
    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    }
  } catch (_) {}
}

function recenter() {
  if (lastDriverLatLng) {
    map.setView(lastDriverLatLng, 15);
  }
}

async function startDriverGps() {
  if (!("geolocation" in navigator)) {
    alert("GPS indisponible.");
    return;
  }
  if (watchId != null) return;

  setText(els.gpsState, "Actif");
  if (els.btnGps) { els.btnGps.disabled = true; els.btnGps.textContent = "GPS ON"; }
  if (els.btnGpsStop) { els.btnGpsStop.disabled = false; }

  watchId = navigator.geolocation.watchPosition(async (pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy;
    const speed = pos.coords.speed ?? null;
    const heading = pos.coords.heading ?? null;

    // Met à jour la carte
    updateDriverMarker(lat, lng);
    // Premier fix: on recentre une fois
    if (!didCenterOnce) {
      didCenterOnce = true;
      try { map.setView([lat, lng], 15); } catch {}
    }

    try {
      await apiFetchJson(`${API_BASE}/driver/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driver_token: driverToken,
          driverToken,
          lat, lng,
          acc,
          speed, heading,
          battery: null,
          ts: Date.now(),
        }),
      });
      setText(els.lastUpdate, "OK");
    } catch {
      setText(els.lastUpdate, "Erreur réseau");
    }
  }, () => {
    setText(els.gpsState, "Refusé");
    watchId = null;
    if (els.btnGps) { els.btnGps.disabled = false; els.btnGps.textContent = "Activer GPS"; }
    if (els.btnGpsStop) { els.btnGpsStop.disabled = true; }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

function stopDriverGps() {
  try {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
  } catch {}
  watchId = null;
  setText(els.gpsState, "Inactif");
  if (els.btnGps) { els.btnGps.disabled = false; els.btnGps.textContent = "Activer GPS"; }
  if (els.btnGpsStop) { els.btnGpsStop.disabled = true; }
}

function minutesRemaining(expiresTs) {
  if (!expiresTs) return null;
  const ms = Number(expiresTs) - Date.now();
  return Math.max(0, Math.ceil(ms / 60000));
}

async function decide(session, decision, minutes=null) {
  const payload = { driver_token: driverToken, session, decision };
  if (minutes != null) payload.minutes = minutes;
  return apiFetchJson(`${API_BASE}/driver/decision`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function actionRow(row, kind) {
  const name = (row.client_name || "").trim() || (row.client_id || "Client");
  const rem = minutesRemaining(row.expires_ts);
  const meta = kind === "pending"
    ? `Demande • expire dans ${Math.max(0, Math.ceil((Number(row.expires_ts||0)-Date.now())/60000))} min`
    : `Actif • reste ~${rem ?? "?"} min`;

  const div = document.createElement("div");
  div.className = "item";

  const top = document.createElement("div");
  top.className = "itemTop";

  const left = document.createElement("div");
  left.innerHTML = `<div class="itemName">${escapeHtml(name)}</div><div class="itemMeta">${escapeHtml(meta)}</div>`;

  const right = document.createElement("div");
  right.style.opacity = ".85";
  right.style.fontWeight = "900";
  right.textContent = kind === "pending" ? "⏳" : "🟢";

  top.appendChild(left);
  top.appendChild(right);

  const actions = document.createElement("div");
  actions.className = "actions";

  const btnAccept = mkBtn("Accepter", "smallBtn good");
  const btnDeny   = mkBtn("Refuser", "smallBtn bad");
  const btnPlus   = mkBtn("+5", "smallBtn cyan");
  const btnMinus  = mkBtn("-5", "smallBtn cyan");
  const btnStop   = mkBtn("Stop", "smallBtn bad");

  // Defaults
  if (kind === "pending") {
    btnPlus.disabled = true;
    btnMinus.disabled = true;
    btnStop.disabled = true;
  } else {
    btnAccept.disabled = true;
    btnDeny.disabled = true;
  }

  btnAccept.onclick = async () => {
    btnAccept.disabled = true;
    try { await decide(row.session, "accept", MAX_MINUTES); } finally {}
  };
  btnDeny.onclick = async () => {
    btnDeny.disabled = true;
    try { await decide(row.session, "deny"); } finally {}
  };

  btnPlus.onclick = async () => {
    const cur = (row.status === "pending" ? DEFAULT_ACCEPT_MINUTES : (minutesRemaining(row.expires_ts) ?? DEFAULT_ACCEPT_MINUTES));
    const next = Math.min(MAX_MINUTES, Math.max(1, cur + 5));
    try { await decide(row.session, "accept", next); } finally {}
  };
  btnMinus.onclick = async () => {
    const cur = (row.status === "pending" ? DEFAULT_ACCEPT_MINUTES : (minutesRemaining(row.expires_ts) ?? DEFAULT_ACCEPT_MINUTES));
    const next = Math.min(MAX_MINUTES, Math.max(1, cur - 5));
    try { await decide(row.session, "accept", next); } finally {}
  };
  btnStop.onclick = async () => {
    btnStop.disabled = true;
    try { await decide(row.session, "stop"); } finally {}
  };

  actions.append(btnAccept, btnDeny, btnPlus, btnMinus, btnStop);

  div.appendChild(top);
  div.appendChild(actions);

  // Click recentre sur le client
  div.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (typeof row.client_lat === "number" && typeof row.client_lng === "number") {
      map.setView([row.client_lat, row.client_lng], 15);
    }
  });

  return div;
}

function mkBtn(label, cls) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function upsertClientMarker(row, kind) {
  const s = row.session;
  sessionData.set(s, row);

  const hasCoords = typeof row.client_lat === "number" && typeof row.client_lng === "number";
  if (!hasCoords) return;

  const ll = [row.client_lat, row.client_lng];
  let m = markers.get(s);

  if (!m) {
    m = L.marker(ll, { icon: ICON_CLIENT });
    m.addTo(map);
    m.on("click", () => openClientPopup(row));
    markers.set(s, m);
  } else {
    m.setLatLng(ll);
  }
}

function openClientPopup(row) {
  const name = (row.client_name || "").trim() || (row.client_id || "Client");
  const rem = minutesRemaining(row.expires_ts);
  const kind = row.status === "pending" ? "pending" : "active";

  const wrap = document.createElement("div");
  wrap.style.minWidth = "220px";
  wrap.innerHTML = `<div style="font-weight:900;margin-bottom:6px">${escapeHtml(name)}</div>
                    <div style="opacity:.8;font-size:12px;margin-bottom:8px">${kind==="pending"?"Demande en attente":"Suivi actif"}${rem!=null?` • ~${rem}min`: ""}</div>`;

  const rowBtns = document.createElement("div");
  rowBtns.style.display = "flex";
  rowBtns.style.gap = "8px";
  rowBtns.style.flexWrap = "wrap";

  const bA = mkBtn("Accepter", "smallBtn good");
  const bR = mkBtn("Refuser", "smallBtn bad");
  const bP = mkBtn("+5", "smallBtn cyan");
  const bM = mkBtn("-5", "smallBtn cyan");
  const bS = mkBtn("Stop", "smallBtn bad");

  if (kind === "pending") { bP.disabled = true; bM.disabled = true; bS.disabled = true; }
  else { bA.disabled = true; bR.disabled = true; }

  bA.onclick = async () => { try { await decide(row.session,"accept",MAX_MINUTES); } finally {} };
  bR.onclick = async () => { try { await decide(row.session,"deny"); } finally {} };
  bP.onclick = async () => {
    const cur = (row.status === "pending" ? DEFAULT_ACCEPT_MINUTES : (minutesRemaining(row.expires_ts) ?? DEFAULT_ACCEPT_MINUTES));
    const next = Math.min(MAX_MINUTES, Math.max(1, cur + 5));
    try { await decide(row.session,"accept",next); } finally {}
  };
  bM.onclick = async () => {
    const cur = (row.status === "pending" ? DEFAULT_ACCEPT_MINUTES : (minutesRemaining(row.expires_ts) ?? DEFAULT_ACCEPT_MINUTES));
    const next = Math.min(MAX_MINUTES, Math.max(1, cur - 5));
    try { await decide(row.session,"accept",next); } finally {}
  };
  bS.onclick = async () => { try { await decide(row.session,"stop"); } finally {} };

  rowBtns.append(bA,bR,bP,bM,bS);
  wrap.appendChild(rowBtns);

  const m = markers.get(row.session);
  if (m) m.bindPopup(wrap).openPopup();
}

function pruneMarkers(validSessions) {
  for (const [session, marker] of markers.entries()) {
    if (!validSessions.has(session)) {
      map.removeLayer(marker);
      markers.delete(session);
      sessionData.delete(session);
    }
  }
}

async function refreshDashboard() {
  try {
    const data = await apiFetchJson(`${API_BASE}/driver/dashboard?driver_token=${encodeURIComponent(driverToken)}`);
    if (!data?.ok) return;

    const pending = Array.isArray(data.pending) ? data.pending : [];
    const active = Array.isArray(data.active) ? data.active : [];

    setText(els.pendingCount, String(pending.length));
    setText(els.lastUpdate, "—");

    // Latest driver pos (optional)
    if (data.latest && typeof data.latest.lat === "number" && typeof data.latest.lng === "number") {
      lastDriverLatLng = [data.latest.lat, data.latest.lng];
      markerDriver.setLatLng(lastDriverLatLng);
    }

    // Render lists
    els.listPending.innerHTML = "";
    if (pending.length === 0) {
      els.listPending.innerHTML = `<div class="item" style="opacity:.8">Aucune demande.</div>`;
    } else {
      for (const r of pending) els.listPending.appendChild(actionRow(r, "pending"));
    }

    els.listActive.innerHTML = "";
    if (active.length === 0) {
      els.listActive.innerHTML = `<div class="item" style="opacity:.8">Aucun suivi actif.</div>`;
    } else {
      for (const r of active) els.listActive.appendChild(actionRow(r, "active"));
    }

    // Markers
    const valid = new Set();
    for (const r of pending) { valid.add(r.session); r.status="pending"; upsertClientMarker(r,"pending"); }
    for (const r of active)  { valid.add(r.session); r.status="active";  upsertClientMarker(r,"active"); }
    pruneMarkers(valid);

  } catch {
    // ignore (réseau)
  }
}

let dashTimer = null;
function startDashboardLoop() {
  refreshDashboard();
  if (dashTimer) clearInterval(dashTimer);
  dashTimer = setInterval(refreshDashboard, 2000);
}

function bootAfterGate() {
  // État initial bouton notifications
  try {
    const perm = (Notification && Notification.permission) ? Notification.permission : 'default';
    if (perm === 'granted') setNotifBtnState('granted');
    else if (perm === 'denied') setNotifBtnState('denied');
    else setNotifBtnState('idle');
  } catch (_) {}
  initMap();
  registerSW();
  setText(els.gpsState, "Inactif");
  setText(els.lastUpdate, "—");

  els.btnGps.addEventListener("click", startDriverGps);
  if (els.btnGpsStop) els.btnGpsStop.addEventListener("click", stopDriverGps);
  els.btnRecenter.addEventListener("click", recenter);
  if (els.btnNotif) els.btnNotif.addEventListener("click", requestNotifications);

  startDashboardLoop();
}

function boot() {
  // Gate PIN
  if (localStorage.getItem(LS.pinOk) === "1") {
    hidePinGate();
    bootAfterGate();
  } else {
    showPinGate();
  }

  els.pinBtn.addEventListener("click", acceptPin);
  els.pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") acceptPin(); });
}

boot();

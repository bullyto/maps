import { API_BASE, MAX_MINUTES, DRIVER_PIN, ONESIGNAL_APP_ID } from "./config.js";
import { apiFetchJson, setText, getOrCreateDriverToken } from "./shared.js";

const els = {
  overlay: document.getElementById("pinOverlay"),
  pinInput: document.getElementById("pinInput"),
  pinBtn: document.getElementById("pinBtn"),
  pinErr: document.getElementById("pinErr"),
  app: document.getElementById("app"),

  gpsState: document.getElementById("gpsState"),
  lastUpdate: document.getElementById("lastUpdate"),
  pendingCount: document.getElementById("pendingCount"),

  pushState: document.getElementById("pushState"),
  btnPushEnable: document.getElementById("btnPushEnable"),

  btnGps: document.getElementById("btnGps"),
  btnGpsStop: document.getElementById("btnGpsStop"),
  btnRecenter: document.getElementById("btnRecenter"),

  listPending: document.getElementById("listPending"),
  listActive: document.getElementById("listActive"),
};

const LS = {
  pinOk: "adn_driver_pin_ok_v1",
  pushRegisteredSubId: "adn_push_registered_subid_v1",
};

const driverToken = getOrCreateDriverToken();

function setPushUI(state) {
  // state: "OK" | "KO" | "BLOCKED" | "PENDING"
  const labels = {
    OK: "✅ Activées",
    KO: "⚠️ KO (à activer)",
    BLOCKED: "⛔ Bloquées",
    PENDING: "⏳ Autorisation…",
  };
  if (els.pushState) setText(els.pushState, labels[state] || state);
}

async function getOneSignal() {
  return await new Promise((resolve) => {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push((OneSignal) => resolve(OneSignal));
  });
}

let _osReady = false;
let _osInitTried = false;
let _registerInFlight = false;

async function initOneSignal() {
  if (_osInitTried) return _osReady;
  _osInitTried = true;

  if (!("Notification" in window) || !ONESIGNAL_APP_ID) {
    setPushUI("KO");
    return false;
  }

  try {
    const OneSignal = await getOneSignal();

    await OneSignal.init({
      appId: ONESIGNAL_APP_ID,
      notifyButton: { enable: false },
      serviceWorkerPath: "./sw.js",
      serviceWorkerUpdaterPath: "./OneSignalSDKUpdaterWorker.js",
    });

    _osReady = true;

    const perm = Notification.permission;
    if (perm === "granted") setPushUI("OK");
    else if (perm === "denied") setPushUI("BLOCKED");
    else setPushUI("KO");

    // Si déjà accordé, on tente l’enregistrement silencieux
    if (perm === "granted") {
      registerPushSubscription().catch(() => {});
    }

    return true;
  } catch {
    _osReady = false;
    setPushUI("KO");
    return false;
  }
}

async function registerToWorker(payload) {
  const url = `${API_BASE}/push/register`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}

  if (!res.ok) {
    const msg = (json && (json.error || json.message)) ? (json.error || json.message) : (text || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  if (json && json.ok === false) throw new Error(json.error || "ok=false");

  return json || { ok: true };
}

async function waitForSubId(OneSignal, maxMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const subId = OneSignal?.User?.PushSubscription?.id || null;
    if (subId) return subId;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function registerPushSubscription() {
  if (!_osReady || _registerInFlight) return;
  _registerInFlight = true;

  try {
    const OneSignal = await getOneSignal();

    // On récupère (ou déclenche) la souscription
    let subId = OneSignal?.User?.PushSubscription?.id || null;

    if (!subId) {
      try { await OneSignal?.User?.PushSubscription?.optIn?.(); } catch (_) {}
      subId = await waitForSubId(OneSignal);
    }

    if (!subId) {
      setPushUI("KO");
      return;
    }

    // Anti double register (si déjà enregistré)
    const last = localStorage.getItem(LS.pushRegisteredSubId);
    if (last && last === subId) {
      setPushUI("OK");
      return;
    }

    await registerToWorker({
      role: "driver",
      subscription_id: subId,
      driver_token: driverToken,
      ts: Date.now(),
    });

    localStorage.setItem(LS.pushRegisteredSubId, subId);
    setPushUI("OK");
  } catch {
    setPushUI("KO");
  } finally {
    _registerInFlight = false;
  }
}

async function requestPushPermission() {
  setPushUI("PENDING");

  const ok = await initOneSignal();
  if (!ok) { setPushUI("KO"); return; }

  try {
    const OneSignal = await getOneSignal();

    if (Notification.permission !== "granted") {
      try { await OneSignal?.Notifications?.requestPermission?.(); }
      catch (_) { await Notification.requestPermission(); }
    }

    if (Notification.permission === "granted") {
      await registerPushSubscription();
    } else if (Notification.permission === "denied") {
      setPushUI("BLOCKED");
    } else {
      setPushUI("KO");
    }
  } catch {
    setPushUI("KO");
  }
}

// -------------------- MAP / GPS --------------------
let map, markerDriver;
let watchId = null;
let lastDriverLatLng = null;
let didCenterOnce = false;

const markers = new Map();

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

async function registerSW() {
  try {
    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    }
  } catch (_) {}
}

function recenter() {
  if (lastDriverLatLng) map.setView(lastDriverLatLng, 15);
}

async function startDriverGps() {
  if (!("geolocation" in navigator)) { alert("GPS indisponible."); return; }
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

    updateDriverMarker(lat, lng);
    if (!didCenterOnce) { didCenterOnce = true; try { map.setView([lat, lng], 15); } catch {} }

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
  try { if (watchId != null) navigator.geolocation.clearWatch(watchId); } catch {}
  watchId = null;
  setText(els.gpsState, "Inactif");
  if (els.btnGps) { els.btnGps.disabled = false; els.btnGps.textContent = "Activer GPS"; }
  if (els.btnGpsStop) { els.btnGpsStop.disabled = true; }
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

const DEFAULT_ACCEPT_MINUTES = Math.min(15, MAX_MINUTES);

function actionRow(row, kind) {
  const name = (row.client_name || "").trim() || (row.client_id || "Client");
  const rem = minutesRemaining(row.expires_ts);
  const meta = kind === "pending"
    ? `Demande • expire bientôt`
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

  if (kind === "pending") { btnPlus.disabled = true; btnMinus.disabled = true; btnStop.disabled = true; }
  else { btnAccept.disabled = true; btnDeny.disabled = true; }

  btnAccept.onclick = async () => { btnAccept.disabled = true; try { await decide(row.session, "accept", MAX_MINUTES); } finally {} };
  btnDeny.onclick   = async () => { btnDeny.disabled = true;   try { await decide(row.session, "deny"); } finally {} };
  btnPlus.onclick   = async () => {
    const cur = minutesRemaining(row.expires_ts) ?? DEFAULT_ACCEPT_MINUTES;
    const next = Math.min(MAX_MINUTES, Math.max(1, cur + 5));
    try { await decide(row.session, "accept", next); } finally {}
  };
  btnMinus.onclick  = async () => {
    const cur = minutesRemaining(row.expires_ts) ?? DEFAULT_ACCEPT_MINUTES;
    const next = Math.min(MAX_MINUTES, Math.max(1, cur - 5));
    try { await decide(row.session, "accept", next); } finally {}
  };
  btnStop.onclick   = async () => { btnStop.disabled = true;   try { await decide(row.session, "stop"); } finally {} };

  actions.append(btnAccept, btnDeny, btnPlus, btnMinus, btnStop);

  div.appendChild(top);
  div.appendChild(actions);

  div.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (typeof row.client_lat === "number" && typeof row.client_lng === "number") {
      map.setView([row.client_lat, row.client_lng], 15);
    }
  });

  return div;
}

function upsertClientMarker(row) {
  const s = row.session;
  const hasCoords = typeof row.client_lat === "number" && typeof row.client_lng === "number";
  if (!hasCoords) return;

  const ll = [row.client_lat, row.client_lng];
  let m = markers.get(s);

  if (!m) {
    m = L.marker(ll, { icon: ICON_CLIENT }).addTo(map);
    markers.set(s, m);
  } else {
    m.setLatLng(ll);
  }
}

function pruneMarkers(validSessions) {
  for (const [session, marker] of markers.entries()) {
    if (!validSessions.has(session)) {
      map.removeLayer(marker);
      markers.delete(session);
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

    els.listPending.innerHTML = "";
    els.listActive.innerHTML = "";

    if (pending.length === 0) els.listPending.innerHTML = `<div class="item" style="opacity:.8">Aucune demande.</div>`;
    else for (const r of pending) els.listPending.appendChild(actionRow(r, "pending"));

    if (active.length === 0) els.listActive.innerHTML = `<div class="item" style="opacity:.8">Aucun suivi actif.</div>`;
    else for (const r of active) els.listActive.appendChild(actionRow(r, "active"));

    const valid = new Set();
    for (const r of pending) { valid.add(r.session); upsertClientMarker(r); }
    for (const r of active)  { valid.add(r.session); upsertClientMarker(r); }
    pruneMarkers(valid);

  } catch { /* ignore */ }
}

let dashTimer = null;
function startDashboardLoop() {
  refreshDashboard();
  if (dashTimer) clearInterval(dashTimer);
  dashTimer = setInterval(refreshDashboard, 2000);
}

// -------------------- PIN Gate + Boot --------------------
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

function bootAfterGate() {
  initMap();
  registerSW();

  setText(els.gpsState, "Inactif");
  setText(els.lastUpdate, "—");

  if (els.btnPushEnable) els.btnPushEnable.addEventListener("click", requestPushPermission);
  initOneSignal(); // état initial sans popup

  els.btnGps.addEventListener("click", startDriverGps);
  if (els.btnGpsStop) els.btnGpsStop.addEventListener("click", stopDriverGps);
  els.btnRecenter.addEventListener("click", recenter);

  startDashboardLoop();
}

function boot() {
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

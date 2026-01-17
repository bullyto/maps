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
  lastPushSubId: "adn_driver_push_subid_v1",
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

// ----------------------------
// NOTIFICATIONS (OneSignal v16)
// ----------------------------

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
  els.btnNotif.disabled = false;
  els.btnNotif.textContent = "🔔 Activer notifications";
}

async function registerSWForDriverPwa() {
  // SW PWA (offline/cache) pour /maps/
  try {
    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    }
  } catch (_) {}
}

let oneSignalInitPromise = null;

function initOneSignal() {
  if (oneSignalInitPromise) return oneSignalInitPromise;

  oneSignalInitPromise = (async () => {
    if (!ONESIGNAL_APP_ID) return null;

    // Pattern recommandé v16 : OneSignalDeferred
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    const OneSignalDeferred = window.OneSignalDeferred;

    // On wrap dans une Promise pour attendre que init soit vraiment fini
    return await new Promise((resolve) => {
      OneSignalDeferred.push(async (OneSignal) => {
        try {
          await OneSignal.init({
            appId: ONESIGNAL_APP_ID,
            notifyButton: { enable: false },

            // OneSignal SW dédié (évite conflit avec ton sw.js)
            serviceWorkerPath: "./OneSignalSDKWorker.js",
            serviceWorkerUpdaterPath: "./OneSignalSDKUpdaterWorker.js",
            serviceWorkerParam: { scope: "./push/" }, // le dossier push/ doit exister
          });

          // Dès qu’un abonnement change (opt-in / token / etc.), on resync
          try {
            OneSignal.User.PushSubscription.addEventListener("change", async () => {
              await syncPushToWorker(OneSignal).catch(() => {});
            });
          } catch (_) {}

          resolve(OneSignal);
        } catch (e) {
          console.log("[OneSignal] init error:", e);
          resolve(null);
        }
      });
    });
  })();

  return oneSignalInitPromise;
}

async function syncPushToWorker(OneSignal) {
  // Récupère l’ID d’abonnement (subscription id) côté OneSignal
  // C’est LA valeur à stocker chez toi pour pouvoir cibler le push.
  const optedIn = !!OneSignal?.User?.PushSubscription?.optedIn;
  const subId = OneSignal?.User?.PushSubscription?.id || "";

  if (!optedIn || !subId) return { ok: false, reason: "not_opted_in_or_no_id" };

  // Anti-spam: n’enregistre pas 50 fois le même id
  const last = localStorage.getItem(LS.lastPushSubId) || "";
  if (last === subId) return { ok: true, already: true, subscription_id: subId };

  // 👉 ICI : ton Worker doit stocker driver_token -> subscription_id dans D1
  const res = await apiFetchJson(`${API_BASE}/push/register`, {
    method: "POST",
    body: JSON.stringify({
      driver_token: driverToken,
      subscription_id: subId,
      ts: Date.now(),
    }),
  });

  localStorage.setItem(LS.lastPushSubId, subId);
  return { ok: true, subscription_id: subId, res };
}

async function requestNotifications() {
  try {
    setNotifBtnState("working");

    // 1) Ton SW PWA (pas obligatoire pour OneSignal, mais ok)
    await registerSWForDriverPwa();

    // 2) Init OneSignal (avec son scope push/)
    const OneSignal = await initOneSignal();
    if (!OneSignal) {
      // fallback navigateur (rare)
      const perm = await (Notification?.requestPermission?.() ?? Promise.resolve("default"));
      setNotifBtnState(perm === "granted" ? "granted" : (perm === "denied" ? "denied" : "idle"));
      return;
    }

    // 3) Demande permission OneSignal
    await OneSignal.Notifications.requestPermission();

    const perm = (Notification && Notification.permission) ? Notification.permission : "default";
    if (perm === "granted") {
      // 4) IMPORTANT : enregistre la subscription chez TON Worker
      await syncPushToWorker(OneSignal).catch((e) => console.log("[push/register] error", e));
      setNotifBtnState("granted");
    } else if (perm === "denied") {
      setNotifBtnState("denied");
    } else {
      setNotifBtnState("idle");
    }
  } catch (e) {
    console.log("[Notif] error:", e);
    setNotifBtnState("idle");
  }
}

// ----------------------------

function recenter() {
  if (lastDriverLatLng) map.setView(lastDriverLatLng, 15);
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

    updateDriverMarker(lat, lng);
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
  try { if (watchId != null) navigator.geolocation.clearWatch(watchId); } catch {}
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

function mkBtn(label, cls) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  return b;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

const DEFAULT_ACCEPT_MINUTES = MAX_MINUTES;

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

  if (kind === "pending") { btnPlus.disabled = true; btnMinus.disabled = true; btnStop.disabled = true; }
  else { btnAccept.disabled = true; btnDeny.disabled = true; }

  btnAccept.onclick = async () => { btnAccept.disabled = true; try { await decide(row.session, "accept", MAX_MINUTES); } finally {} };
  btnDeny.onclick   = async () => { btnDeny.disabled = true;   try { await decide(row.session, "deny"); } finally {} };

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
  btnStop.onclick = async () => { btnStop.disabled = true; try { await decide(row.session, "stop"); } finally {} };

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
  sessionData.set(s, row);
  const hasCoords = typeof row.client_lat === "number" && typeof row.client_lng === "number";
  if (!hasCoords) return;

  const ll = [row.client_lat, row.client_lng];
  let m = markers.get(s);

  if (!m) {
    m = L.marker(ll, { icon: ICON_CLIENT });
    m.addTo(map);
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

    if (data.latest && typeof data.latest.lat === "number" && typeof data.latest.lng === "number") {
      lastDriverLatLng = [data.latest.lat, data.latest.lng];
      markerDriver.setLatLng(lastDriverLatLng);
    }

    els.listPending.innerHTML = "";
    if (pending.length === 0) els.listPending.innerHTML = `<div class="item" style="opacity:.8">Aucune demande.</div>`;
    else for (const r of pending) els.listPending.appendChild(actionRow(r, "pending"));

    els.listActive.innerHTML = "";
    if (active.length === 0) els.listActive.innerHTML = `<div class="item" style="opacity:.8">Aucun suivi actif.</div>`;
    else for (const r of active) els.listActive.appendChild(actionRow(r, "active"));

    const valid = new Set();
    for (const r of pending) { valid.add(r.session); r.status="pending"; upsertClientMarker(r); }
    for (const r of active)  { valid.add(r.session); r.status="active";  upsertClientMarker(r); }
    pruneMarkers(valid);
  } catch {
    // ignore
  }
}

let dashTimer = null;
function startDashboardLoop() {
  refreshDashboard();
  if (dashTimer) clearInterval(dashTimer);
  dashTimer = setInterval(refreshDashboard, 2000);
}

function bootAfterGate() {
  try {
    const perm = (Notification && Notification.permission) ? Notification.permission : "default";
    if (perm === "granted") setNotifBtnState("granted");
    else if (perm === "denied") setNotifBtnState("denied");
    else setNotifBtnState("idle");
  } catch (_) {}

  initMap();
  registerSWForDriverPwa();
  setText(els.gpsState, "Inactif");
  setText(els.lastUpdate, "—");

  els.btnGps.addEventListener("click", startDriverGps);
  if (els.btnGpsStop) els.btnGpsStop.addEventListener("click", stopDriverGps);
  els.btnRecenter.addEventListener("click", recenter);
  if (els.btnNotif) els.btnNotif.addEventListener("click", requestNotifications);

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

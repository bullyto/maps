import { API_BASE, MAX_MINUTES, DRIVER_PIN, ONESIGNAL_APP_ID } from "./config.js";
import { apiFetchJson, setText, fmtAgo, getOrCreateDriverToken } from "./shared.js";

const els = {
  overlay: document.getElementById("pinOverlay"),
  pinInput: document.getElementById("pinInput"),
  pinBtn: document.getElementById("pinBtn"),
  pinErr: document.getElementById("pinErr"),
  app: document.getElementById("app"),

  driverOnlineLabel: document.getElementById("driverOnlineLabel"),
  gpsStatus: document.getElementById("gpsStatus"),
  lastUpdate: document.getElementById("lastUpdate"),
  requestCount: document.getElementById("requestCount"),

  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnCenter: document.getElementById("btnCenter"),

  pushState: document.getElementById("pushState"),
  btnPushEnable: document.getElementById("btnPushEnable"),
  pushDebug: document.getElementById("pushDebug"),

  listPending: document.getElementById("listPending"),
  listActive: document.getElementById("listActive"),
};

let map = null;
let meMarker = null;

let watchId = null;
let lastPos = null;
let lastPosAt = 0;

let pollTimer = null;
let driverToken = null;

const OneSignal = window.OneSignal || [];
let oneSignalInited = false;

function qsParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

function setBadgeOnline(isOnline) {
  if (!els.driverOnlineLabel) return;
  els.driverOnlineLabel.textContent = isOnline ? "Livreur en ligne" : "Livreur hors ligne";
  els.driverOnlineLabel.classList.toggle("ok", !!isOnline);
  els.driverOnlineLabel.classList.toggle("off", !isOnline);
}

function showApp() {
  els.overlay.style.display = "none";
  els.app.style.display = "block";
}

function showPinError(msg) {
  if (!els.pinErr) return;
  els.pinErr.textContent = msg || "";
  els.pinErr.style.display = msg ? "block" : "none";
}

function checkPinOrShow() {
  // PIN attendu via config.js (DRIVER_PIN)
  const saved = localStorage.getItem("driver_pin_ok_v1");
  if (saved === "1") {
    showApp();
    return;
  }
  els.overlay.style.display = "flex";
  els.app.style.display = "none";

  const doCheck = () => {
    const pin = (els.pinInput.value || "").trim();
    if (!pin) return showPinError("Entre le PIN.");
    if (pin !== String(DRIVER_PIN)) {
      showPinError("PIN incorrect.");
      return;
    }
    localStorage.setItem("driver_pin_ok_v1", "1");
    showPinError("");
    showApp();
    boot();
  };

  els.pinBtn.addEventListener("click", doCheck);
  els.pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doCheck();
  });
}

function initMap() {
  if (!window.L) {
    console.warn("Leaflet n'est pas chargé.");
    return;
  }
  map = L.map("map", { zoomControl: true }).setView([42.6887, 2.8948], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  meMarker = L.marker([42.6887, 2.8948]).addTo(map);
}

function updateMap(lat, lng) {
  if (!map || !meMarker) return;
  const ll = [lat, lng];
  meMarker.setLatLng(ll);
}

function centerMap() {
  if (!map || !lastPos) return;
  map.setView([lastPos.lat, lastPos.lng], Math.max(map.getZoom(), 15));
}

async function apiPost(path, body) {
  return apiFetchJson(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

/* =========================
   GPS / Tracking
========================= */

function setGpsUI(active) {
  els.btnStart.disabled = !!active;
  els.btnStop.disabled = !active;
  setText(els.gpsStatus, active ? "Actif" : "Inactif");
  setBadgeOnline(active);
}

async function sendGpsPosition(lat, lng) {
  lastPosAt = Date.now();
  setText(els.lastUpdate, fmtAgo(lastPosAt));

  // IMPORTANT: driverToken identifie le livreur (persistant)
  await apiPost("/driver/position", {
    driver_token: driverToken,
    lat,
    lng,
    ts: Date.now(),
  });
}

function startGps() {
  if (!navigator.geolocation) {
    alert("GPS non supporté sur ce téléphone.");
    return;
  }

  setGpsUI(true);

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      lastPos = { lat, lng };
      updateMap(lat, lng);

      try {
        await sendGpsPosition(lat, lng);
      } catch (e) {
        console.warn("Erreur envoi position:", e);
      }
    },
    (err) => {
      console.warn("Erreur GPS:", err);
      setGpsUI(false);
      alert("Impossible d'activer le GPS. Autorise la localisation et réessaie.");
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  setGpsUI(false);
}

/* =========================
   OneSignal Push
========================= */

function pushLog(msg) {
  if (!els.pushDebug) return;
  els.pushDebug.textContent = msg || "";
}

async function initOneSignal() {
  if (oneSignalInited) return true;
  if (!ONESIGNAL_APP_ID) {
    pushLog("ONESIGNAL_APP_ID manquant dans config.js");
    return false;
  }

  try {
    OneSignal.push(() => {
      OneSignal.init({
        appId: ONESIGNAL_APP_ID,
        // IMPORTANT: ton scope est /maps/ (comme tu l’avais)
        serviceWorkerParam: { scope: "/maps/" },
        serviceWorkerPath: "/maps/OneSignalSDKWorker.js",
        notifyButton: { enable: false },
        allowLocalhostAsSecureOrigin: false,
      });
    });
    oneSignalInited = true;
    return true;
  } catch (e) {
    console.warn("Init OneSignal error", e);
    pushLog("Erreur init OneSignal: " + (e?.message || e));
    return false;
  }
}

async function refreshPushState() {
  try {
    const okInit = await initOneSignal();
    if (!okInit) {
      setText(els.pushState, "Indisponible");
      return;
    }

    let perm = Notification.permission; // 'default' | 'granted' | 'denied'
    if (perm === "granted") {
      setText(els.pushState, "Activées");
      els.btnPushEnable.disabled = true;
      els.btnPushEnable.textContent = "Notifications activées";
      els.btnPushEnable.classList.add("disabled");
    } else if (perm === "denied") {
      setText(els.pushState, "Bloquées");
      els.btnPushEnable.disabled = true;
      els.btnPushEnable.textContent = "Bloquées (réactiver dans Android)";
      pushLog("Permission notifications: denied (bloquées au niveau système).");
    } else {
      setText(els.pushState, "Désactivées");
      els.btnPushEnable.disabled = false;
      els.btnPushEnable.textContent = "Activer notifications";
    }
  } catch (e) {
    console.warn("refreshPushState", e);
    setText(els.pushState, "Erreur");
  }
}

async function enablePush() {
  pushLog("");

  const okInit = await initOneSignal();
  if (!okInit) return;

  try {
    // Demande la permission (Android affichera le prompt)
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      pushLog("Permission refusée. Va dans Paramètres > Notifications pour autoriser.");
      await refreshPushState();
      return;
    }

    // Récupère l'ID OneSignal (player/user id)
    let subId = null;

    // v16: getSubscriptionId existe côté SDK web
    OneSignal.push(async () => {
      try {
        if (OneSignal.User?.PushSubscription?.id) {
          subId = OneSignal.User.PushSubscription.id;
        } else if (typeof OneSignal.getSubscriptionId === "function") {
          subId = await OneSignal.getSubscriptionId();
        }
      } catch (e) {
        console.warn("Subscription id error", e);
      }
    });

    // Attendre un petit peu que le SDK remplisse l'id
    await new Promise((r) => setTimeout(r, 800));

    // Re-check si OneSignal a rempli l'ID
    try {
      if (!subId && OneSignal.User?.PushSubscription?.id) {
        subId = OneSignal.User.PushSubscription.id;
      }
    } catch {}

    if (!subId) {
      pushLog("Abonnement OK mais ID OneSignal introuvable. Vérifie OneSignalSDKWorker.js dans /maps/");
      await refreshPushState();
      return;
    }

    // Enregistre l'abonnement côté Worker Cloudflare
    await apiPost("/push/register", {
      driver_token: driverToken,
      subscription_id: subId,
      ts: Date.now(),
    });

    pushLog("✅ Notifications activées et enregistrées.");
    await refreshPushState();
  } catch (e) {
    console.warn("enablePush error", e);
    pushLog("Erreur activation notifications: " + (e?.message || e));
    await refreshPushState();
  }
}

/* =========================
   Demandes / Dashboard
========================= */

function minutesClamp(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_MINUTES, n));
}

function clearList(el) {
  if (!el) return;
  el.innerHTML = "";
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = `btn ${cls || ""}`.trim();
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderRequestItem(req, container, isActive) {
  const item = document.createElement("div");
  item.className = "item";

  const top = document.createElement("div");
  top.className = "item-top";

  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = req.name || "Demande";

  const meta = document.createElement("div");
  meta.className = "item-meta";
  meta.textContent = isActive ? "Suivi • actif" : "Demande • expire bientôt";

  top.appendChild(title);
  top.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "item-actions";

  if (!isActive) {
    actions.appendChild(
      mkBtn("Accepter", "btn-ok", async () => {
        await apiPost("/driver/decision", { driver_token: driverToken, id: req.id, decision: "accept" });
        await fetchDashboard();
      })
    );
    actions.appendChild(
      mkBtn("Refuser", "btn-no", async () => {
        await apiPost("/driver/decision", { driver_token: driverToken, id: req.id, decision: "refuse" });
        await fetchDashboard();
      })
    );

    actions.appendChild(
      mkBtn("+5", "btn-secondary", async () => {
        await apiPost("/driver/extend", { driver_token: driverToken, id: req.id, minutes: 5 });
        await fetchDashboard();
      })
    );
    actions.appendChild(
      mkBtn("-5", "btn-secondary", async () => {
        await apiPost("/driver/extend", { driver_token: driverToken, id: req.id, minutes: -5 });
        await fetchDashboard();
      })
    );

    actions.appendChild(
      mkBtn("Stop", "btn-danger", async () => {
        await apiPost("/driver/decision", { driver_token: driverToken, id: req.id, decision: "stop" });
        await fetchDashboard();
      })
    );
  } else {
    actions.appendChild(
      mkBtn("Stop", "btn-danger", async () => {
        await apiPost("/driver/decision", { driver_token: driverToken, id: req.id, decision: "stop" });
        await fetchDashboard();
      })
    );
  }

  item.appendChild(top);
  item.appendChild(actions);
  container.appendChild(item);
}

async function fetchDashboard() {
  try {
    const data = await apiFetchJson(`${API_BASE}/driver/dashboard?driver_token=${encodeURIComponent(driverToken)}`);
    const pending = Array.isArray(data?.pending) ? data.pending : [];
    const active = Array.isArray(data?.active) ? data.active : [];

    setText(els.requestCount, String(pending.length));

    clearList(els.listPending);
    clearList(els.listActive);

    if (pending.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Aucune demande en attente.";
      els.listPending.appendChild(empty);
    } else {
      pending.forEach((r) => renderRequestItem(r, els.listPending, false));
    }

    if (active.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Aucun suivi actif.";
      els.listActive.appendChild(empty);
    } else {
      active.forEach((r) => renderRequestItem(r, els.listActive, true));
    }
  } catch (e) {
    console.warn("fetchDashboard error", e);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(fetchDashboard, 5000);
  fetchDashboard();
}

/* =========================
   Boot
========================= */

async function boot() {
  driverToken = getOrCreateDriverToken(qsParam("token"));

  initMap();
  setGpsUI(false);
  setText(els.lastUpdate, "—");
  setText(els.requestCount, "—");

  els.btnStart.addEventListener("click", startGps);
  els.btnStop.addEventListener("click", stopGps);
  els.btnCenter.addEventListener("click", centerMap);

  els.btnPushEnable.addEventListener("click", enablePush);

  await refreshPushState();
  startPolling();
}

// Start
checkPinOrShow();
if (localStorage.getItem("driver_pin_ok_v1") === "1") {
  // Déjà validé
  boot();
}

import { CONFIG } from "./config.js";

/**
 * Driver (livreur) - Dashboard + GPS + demandes
 * + OneSignal push (DRIVER_MAPS)
 */

const els = {
  gpsState: document.getElementById("gpsState"),
  lastUpdate: document.getElementById("lastUpdate"),
  pendingCount: document.getElementById("pendingCount"),
  notifStatus: document.getElementById("notifStatus"),

  driverOnlineLabel: document.getElementById("driverOnlineLabel"),
  driverOnlinePill: document.getElementById("driverOnlinePill"),
  driverOnlineDot: document.getElementById("driverOnlineDot"),
  driverOnlineText: document.getElementById("driverOnlineText"),

  btnGps: document.getElementById("btnGps"),
  btnGpsStop: document.getElementById("btnGpsStop"),
  btnRecenter: document.getElementById("btnRecenter"),
  btnNotif: document.getElementById("btnNotif"),

  requestsList: document.getElementById("requestsList"),
};

const API_BASE = (CONFIG.API_BASE || "").replace(/\/+$/, "");
const DRIVER_POLL_MS = CONFIG.DRIVER_POLL_MS ?? 3000;
const GPS_SEND_MS = CONFIG.GPS_SEND_MS ?? 3500;

// Token local “livreur”
const driverToken = getOrCreateDriverToken();

function setText(el, txt) {
  if (!el) return;
  el.textContent = txt;
}

function fmtTime(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return "—";
  }
}

function getOrCreateDriverToken() {
  const k = "and_driver_token_v1";
  let t = localStorage.getItem(k);
  if (t && t.length > 8) return t;
  t = `drv_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  localStorage.setItem(k, t);
  return t;
}

// =====================
// Push OneSignal (DRIVER_MAPS)
// =====================
// App ID OneSignal (DRIVER_MAPS)
const ONESIGNAL_APP_ID = "62253f55-1377-45fe-a47b-6676d43db125";
// IMPORTANT: ton driver est dans /maps/ donc scope /maps/
const ONESIGNAL_SCOPE = "/maps/";
const ONESIGNAL_SW_PATH = "OneSignalSDKWorker.js";
const ONESIGNAL_SW_UPDATER_PATH = "OneSignalSDKUpdaterWorker.js";

let oneSignalInitStarted = false;

function ensureOneSignalInit() {
  if (oneSignalInitStarted) return;
  oneSignalInitStarted = true;

  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(async function (OneSignal) {
    try {
      await OneSignal.init({
        appId: ONESIGNAL_APP_ID,
        notifyButton: { enable: false }, // on gère notre propre UI
        serviceWorkerParam: { scope: ONESIGNAL_SCOPE },
        serviceWorkerPath: ONESIGNAL_SW_PATH,
        serviceWorkerUpdaterPath: ONESIGNAL_SW_UPDATER_PATH,
        allowLocalhostAsSecureOrigin: true,
      });

      await refreshNotifUI();
    } catch (e) {
      console.error("[push] init error", e);
      setText(els.notifStatus, "Erreur");
    }
  });
}

async function getOneSignalSubId() {
  const OneSignal = window.OneSignal;
  if (!OneSignal) return null;

  try {
    const sub = OneSignal.User?.PushSubscription;
    if (!sub) return null;

    if (typeof sub.getId === "function") return await sub.getId();
    if (sub.id) return sub.id;

    return sub.subscriptionId || sub.token || null;
  } catch (e) {
    console.warn("[push] get id error", e);
    return null;
  }
}

async function isOptedIn() {
  const OneSignal = window.OneSignal;
  if (!OneSignal) return false;

  try {
    const sub = OneSignal.User?.PushSubscription;
    if (!sub) return false;

    if (typeof sub.optedIn !== "undefined") return !!sub.optedIn;
    if (typeof sub.enabled !== "undefined") return !!sub.enabled;

    if (typeof sub.getOptedIn === "function") return await sub.getOptedIn();
    return false;
  } catch {
    return false;
  }
}

function permLabel(p) {
  if (p === "granted") return "Activées";
  if (p === "denied") return "Bloquées";
  return "À activer";
}

async function refreshNotifUI() {
  if (!els.notifStatus || !els.btnNotif) return;

  if (!("Notification" in window)) {
    setText(els.notifStatus, "Non supporté");
    els.btnNotif.disabled = true;
    return;
  }

  const perm = Notification.permission;
  setText(els.notifStatus, permLabel(perm));

  if (perm === "granted" && window.OneSignal) {
    const opted = await isOptedIn();
    setText(els.notifStatus, opted ? "Activées" : "À finaliser");
  }

  if (perm === "denied") {
    els.btnNotif.textContent = "Notifications bloquées";
    els.btnNotif.disabled = true;
  } else if (perm === "granted") {
    els.btnNotif.textContent = "Notifications actives";
    els.btnNotif.disabled = true;
  } else {
    els.btnNotif.textContent = "Activer notifications";
    els.btnNotif.disabled = false;
  }
}

async function registerPushOnBackend(subscription_id) {
  // Côté Cloudflare Worker: POST /push/register
  // On envoie driver_token + subscription_id
  const url = `${API_BASE}/push/register`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driver_token: driverToken,
        subscription_id,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("[push] /push/register not ok", res.status, txt);
      return null;
    }
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.warn("[push] backend register failed", e);
    return null;
  }
}

async function requestNotifications() {
  ensureOneSignalInit();

  // Attendre que le SDK soit prêt
  for (let i = 0; i < 20; i++) {
    if (window.OneSignal) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const OneSignal = window.OneSignal;
  if (!OneSignal) {
    alert("OneSignal n'est pas chargé. Recharge la page et réessaie.");
    return;
  }

  try {
    // 1) Permission navigateur
    if (OneSignal.Notifications?.requestPermission) {
      await OneSignal.Notifications.requestPermission();
    } else if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }

    // 2) Opt-in (SDK v16)
    if (OneSignal.User?.PushSubscription?.optIn) {
      await OneSignal.User.PushSubscription.optIn();
    } else if (OneSignal.Slidedown?.promptPush) {
      await OneSignal.Slidedown.promptPush();
    }

    // 3) Récupérer l'id de subscription et l'envoyer au Worker
    const subId = await getOneSignalSubId();
    if (subId) await registerPushOnBackend(subId);

    await refreshNotifUI();
    alert("✅ Notifications activées !");
  } catch (e) {
    console.error("[push] request error", e);
    alert("Impossible d'activer les notifications. Vérifie les autorisations et réessaie.");
  }
}

// =====================
// GPS / Map / Dashboard
// =====================

let gpsWatchId = null;
let gpsSendTimer = null;

let map = null;
let marker = null;

function initMap() {
  // Mini-map Leaflet (si déjà présent dans ton projet)
  if (!window.L) return;

  map = L.map("miniMap", { zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  map.setView([42.6887, 2.8948], 12); // Perpignan (fallback)
}

function recenter() {
  if (!map || !marker) return;
  const latlng = marker.getLatLng();
  map.setView([latlng.lat, latlng.lng], 15);
}

async function registerSW() {
  // Garde ton SW existant si tu en as un
  try {
    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    }
  } catch (e) {
    console.warn("[sw] register failed", e);
  }
}

async function startDriverGps() {
  if (!navigator.geolocation) {
    alert("GPS non disponible sur ce navigateur.");
    return;
  }

  setText(els.gpsState, "En cours...");
  els.btnGps.disabled = true;

  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;

      setText(els.gpsState, "Actif");
      setDriverOnline(true);

      if (window.L && map) {
        if (!marker) {
          marker = L.marker([latitude, longitude]).addTo(map);
          map.setView([latitude, longitude], 15);
        } else {
          marker.setLatLng([latitude, longitude]);
        }
      }

      // Envoi périodique au worker
      scheduleGpsSend(latitude, longitude, accuracy);
    },
    (err) => {
      console.warn("[gps] error", err);
      setText(els.gpsState, "Inactif");
      setDriverOnline(false);
      els.btnGps.disabled = false;
      alert("Impossible d'activer le GPS. Autorise la localisation et réessaie.");
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );

  els.btnGpsStop.disabled = false;
}

function stopDriverGps() {
  try {
    if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
  } catch {}
  gpsWatchId = null;

  if (gpsSendTimer) clearInterval(gpsSendTimer);
  gpsSendTimer = null;

  setText(els.gpsState, "Inactif");
  setDriverOnline(false);

  els.btnGps.disabled = false;
  els.btnGpsStop.disabled = true;
}

function scheduleGpsSend(lat, lng, accuracy) {
  // On garde les dernières coords dans des variables closures via timer
  let last = { lat, lng, accuracy };

  // Si déjà en route, juste update
  if (gpsSendTimer) {
    gpsSendTimer.__last = last;
    return;
  }

  gpsSendTimer = setInterval(async () => {
    const data = gpsSendTimer.__last || last;
    await sendGps(data.lat, data.lng, data.accuracy);
  }, GPS_SEND_MS);

  gpsSendTimer.__last = last;
}

async function sendGps(lat, lng, accuracy) {
  if (!API_BASE) return;

  try {
    await fetch(`${API_BASE}/gps/point`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driver_token: driverToken,
        lat,
        lng,
        accuracy,
        ts: Date.now(),
      }),
    });

    setText(els.lastUpdate, fmtTime(Date.now()));
  } catch (e) {
    console.warn("[gps] send failed", e);
  }
}

function setDriverOnline(on) {
  if (!els.driverOnlineLabel || !els.driverOnlinePill) return;

  if (on) {
    els.driverOnlineLabel.textContent = "Livreur en ligne";
    els.driverOnlineText.textContent = "Livreur en ligne";
    els.driverOnlineDot.classList.add("on");
    els.driverOnlinePill.classList.add("on");
  } else {
    els.driverOnlineLabel.textContent = "Livreur hors ligne";
    els.driverOnlineText.textContent = "Livreur hors ligne";
    els.driverOnlineDot.classList.remove("on");
    els.driverOnlinePill.classList.remove("on");
  }
}

async function fetchDriverDashboard() {
  if (!API_BASE) return null;
  try {
    const res = await fetch(`${API_BASE}/driver/dashboard?driver_token=${encodeURIComponent(driverToken)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function renderRequests(list) {
  if (!els.requestsList) return;

  if (!Array.isArray(list) || list.length === 0) {
    els.requestsList.innerHTML = `<div class="empty">Aucune demande pour le moment.</div>`;
    return;
  }

  els.requestsList.innerHTML = list
    .map((r) => {
      const name = r?.name || r?.client_name || "Client";
      const ttl = r?.ttl_sec ?? r?.ttl ?? 0;
      const badge = ttl <= 120 ? "⏳" : "⏳";
      return `
      <div class="reqCard">
        <div class="reqTop">
          <div class="reqTitle">${escapeHtml(name)}</div>
          <div class="reqBadge">${badge}</div>
        </div>
        <div class="reqSub">Demande • expire bientôt</div>

        <div class="reqActions">
          <button class="btn small ok" data-act="accept" data-id="${escapeAttr(r.id)}">Accepter</button>
          <button class="btn small danger" data-act="refuse" data-id="${escapeAttr(r.id)}">Refuser</button>
          <button class="btn small ghost" data-act="plus" data-id="${escapeAttr(r.id)}">+5</button>
          <button class="btn small ghost" data-act="minus" data-id="${escapeAttr(r.id)}">-5</button>
          <button class="btn small danger2" data-act="stop" data-id="${escapeAttr(r.id)}">Stop</button>
        </div>
      </div>`;
    })
    .join("");

  els.requestsList.querySelectorAll("button[data-act]").forEach((b) => {
    b.addEventListener("click", async () => {
      const act = b.getAttribute("data-act");
      const id = b.getAttribute("data-id");
      await driverDecision(act, id);
    });
  });
}

async function driverDecision(action, id) {
  if (!API_BASE) return;
  try {
    await fetch(`${API_BASE}/driver/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driver_token: driverToken,
        action,
        id,
      }),
    });
  } catch (e) {
    console.warn("[driver] decision failed", e);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("`", "&#096;");
}

async function startDashboardLoop() {
  const tick = async () => {
    const dash = await fetchDriverDashboard();
    if (!dash) return;

    const pending = dash?.pending_count ?? dash?.pending ?? 0;
    setText(els.pendingCount, String(pending));

    const list = dash?.requests ?? dash?.pending_requests ?? [];
    renderRequests(list);
  };

  await tick();
  setInterval(tick, DRIVER_POLL_MS);
}

// =====================
// Boot
// =====================

function bootAfterGate() {
  initMap();
  registerSW();
  setText(els.gpsState, "Inactif");
  setText(els.lastUpdate, "—");

  els.btnGps.addEventListener("click", startDriverGps);
  if (els.btnGpsStop) els.btnGpsStop.addEventListener("click", stopDriverGps);
  els.btnRecenter.addEventListener("click", recenter);

  // Push notifications (OneSignal)
  if (els.btnNotif) {
    ensureOneSignalInit();
    els.btnNotif.addEventListener("click", requestNotifications);
    refreshNotifUI();
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshNotifUI();
  });

  startDashboardLoop();
}

bootAfterGate();

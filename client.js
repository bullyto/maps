import { API_BASE, MAPS } from "./config.js";
import { apiFetchJson, fmtAgo, setText, qs, sleep } from "./shared.js";

const els = {
  gpsState: document.getElementById("gpsState"),
  lastPing: document.getElementById("lastPing"),
  pendingCount: document.getElementById("pendingCount"),

  notifState: document.getElementById("notifState"),
  btnNotif: document.getElementById("btnNotif"),

  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnCenter: document.getElementById("btnCenter"),
  hint: document.getElementById("hint"),
  map: document.getElementById("map"),
};

let watchId = null;
let lastSentTs = 0;
let map = null;
let marker = null;

// ---------------------------
// OneSignal (Web Push) — DRIVER ONLY
// Objectif: recevoir une notif même si la PWA driver est fermée (si l'OS autorise les notifs web).
// Limite: sur Android/iOS, le "son" dépend des réglages système; on ne peut pas forcer une sonnerie custom via Web Push.
// ---------------------------
let onesignalReady = false;
let pushRegisterInFlight = false;

function setNotifUI(state, extra = "") {
  // state: "KO" | "OK" | "BLOCKED" | "PENDING"
  const map = {
    OK: "✅ Activées",
    KO: "⚠️ OneSignal KO",
    BLOCKED: "⛔ Bloquées",
    PENDING: "⏳ Autorisation..."
  };
  setText(els.notifState, (map[state] || state) + (extra ? (" " + extra) : ""));
  if (els.btnNotif) {
    if (state === "OK") {
      els.btnNotif.disabled = true;
      els.btnNotif.textContent = "Notifications activées";
    } else if (state === "PENDING") {
      els.btnNotif.disabled = true;
      els.btnNotif.textContent = "Autorisation…";
    } else {
      els.btnNotif.disabled = false;
      els.btnNotif.textContent = "Activer notifications";
    }
  }
}

async function initOneSignalAndRefreshUI() {
  if (!("Notification" in window)) {
    setNotifUI("KO", "(incompatible)");
    return;
  }
  // Si OneSignal n'est pas chargé, on affiche KO
  if (!window.OneSignalDeferred) {
    setNotifUI("KO", "(SDK absent)");
    return;
  }

  // Attendre que OneSignal init soit passé dans le script du <head>
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (window.__onesignal_ready === true || window.__onesignal_ready === false) break;
    await sleep(100);
  }

  onesignalReady = window.__onesignal_ready === true;

  if (!onesignalReady) {
    setNotifUI("KO");
    return;
  }

  // Etat permissions
  const perm = Notification.permission; // "granted" | "denied" | "default"
  if (perm === "denied") {
    setNotifUI("BLOCKED");
    return;
  }
  if (perm !== "granted") {
    setNotifUI("KO", "(à activer)");
    return;
  }

  // Permission ok => tenter d'enregistrer l'id de subscription côté worker
  await registerPushSubscription();
}

async function registerPushSubscription() {
  if (!onesignalReady) return;
  if (pushRegisterInFlight) return;
  pushRegisterInFlight = true;
  try {
    const OneSignal = await new Promise(resolve => {
      window.OneSignalDeferred.push(function(os){ resolve(os); });
    });

    // Dans OneSignal v16, l'id de souscription est accessible via OneSignal.User.PushSubscription.id
    const subId = OneSignal?.User?.PushSubscription?.id;
    const optedIn = OneSignal?.User?.PushSubscription?.optedIn;
    if (!subId || optedIn === false) {
      // On est autorisé mais pas encore abonné: on force opt-in
      try { await OneSignal?.User?.PushSubscription?.optIn(); } catch (_) {}
    }

    const finalId = OneSignal?.User?.PushSubscription?.id;
    if (!finalId) {
      setNotifUI("KO", "(pas d'ID)");
      return;
    }

    // Enregistrer côté Cloudflare Worker (D1)
    const payload = {
      subscription_id: finalId,
      role: "driver",
      ua: navigator.userAgent || "",
      ts: Date.now()
    };
    await apiFetchJson(API_BASE + "/push/register", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    setNotifUI("OK");
  } catch (e) {
    console.warn("push register failed", e);
    setNotifUI("KO");
  } finally {
    pushRegisterInFlight = false;
  }
}

async function requestNotifPermission() {
  setNotifUI("PENDING");
  try {
    const OneSignal = await new Promise(resolve => {
      window.OneSignalDeferred.push(function(os){ resolve(os); });
    });

    // Demande permission (natif navigateur)
    try {
      await OneSignal?.Notifications?.requestPermission();
    } catch (_) {
      // fallback
      await Notification.requestPermission();
    }

    // Si autorisé => opt-in + register
    if (Notification.permission === "granted") {
      try { await OneSignal?.User?.PushSubscription?.optIn?.(); } catch (_) {}
      await registerPushSubscription();
    } else if (Notification.permission === "denied") {
      setNotifUI("BLOCKED");
    } else {
      setNotifUI("KO", "(refusée)");
    }
  } catch (e) {
    console.warn("notif permission error", e);
    setNotifUI("KO");
  }
}

// ---------------------------
// MAP
// ---------------------------
function initMap() {
  if (map) return;
  map = L.map(els.map, {
    zoomControl: true,
    attributionControl: false,
  }).setView(MAPS.defaultCenter, MAPS.defaultZoom);

  L.tileLayer(MAPS.tileUrl, {
    maxZoom: MAPS.maxZoom,
  }).addTo(map);

  marker = L.marker(MAPS.defaultCenter).addTo(map);
}

function setGpsUI(active) {
  setText(els.gpsState, active ? "Actif" : "Inactif");
  els.btnStart.disabled = active;
  els.btnStop.disabled = !active;
}

// ---------------------------
// GPS
// ---------------------------
async function sendDriverPing(lat, lng) {
  const now = Date.now();
  if (now - lastSentTs < 1500) return;
  lastSentTs = now;

  await apiFetchJson(API_BASE + "/driver/ping", {
    method: "POST",
    body: JSON.stringify({
      lat,
      lng,
      ts: now
    })
  });

  setText(els.lastPing, "à l'instant");
}

async function startGps() {
  if (!("geolocation" in navigator)) {
    setText(els.hint, "GPS non supporté sur cet appareil.");
    return;
  }

  setText(els.hint, "Autorisation…");

  initMap();

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;

      marker.setLatLng([lat, lng]);
      map.panTo([lat, lng], { animate: true });

      setGpsUI(true);
      setText(els.hint, "");

      try {
        await sendDriverPing(lat, lng);
      } catch (e) {
        console.warn(e);
      }
    },
    (err) => {
      console.warn(err);
      setText(els.hint, "Autorisation GPS refusée ou indisponible.");
      setGpsUI(false);
      if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function stopGps() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  setGpsUI(false);
}

// ---------------------------
// Polling / demandes
// ---------------------------
async function refreshPending() {
  const r = await apiFetchJson(API_BASE + "/driver/pending", { method: "GET" });
  setText(els.pendingCount, String(r?.count ?? 0));
}

function startPolling() {
  refreshPending().catch(() => {});
  setInterval(() => {
    refreshPending().catch(() => {});
    // "Dernière mise à jour"
    const txt = fmtAgo(Date.now());
    setText(els.lastPing, txt);
  }, 3000);
}

// ---------------------------
// Boot
// ---------------------------
function bootAfterGate() {
  initMap();
  setGpsUI(false);

  els.btnStart.addEventListener("click", () => startGps());
  els.btnStop.addEventListener("click", () => stopGps());
  els.btnCenter.addEventListener("click", () => {
    if (!map || !marker) return;
    map.panTo(marker.getLatLng(), { animate: true });
  });

  startPolling();

  // Notifications push (OneSignal)
  if (els.btnNotif) {
    els.btnNotif.addEventListener("click", () => requestNotifPermission());
  }
  initOneSignalAndRefreshUI();
}

bootAfterGate();

import { API_BASE, MAX_MINUTES, DRIVER_PIN, ONESIGNAL_APP_ID } from "./config.js";
import { fmtAgo, clamp, apiFetchJson, qs, setText } from "./shared.js";

// =====================
// UI Elements
// =====================

const els = {
  gpsState: document.getElementById("gpsState"),
  lastUpdate: document.getElementById("lastUpdate"),
  pendingCount: document.getElementById("pendingCount"),
  notifState: document.getElementById("notifState"),
  btnNotif: document.getElementById("btnNotif"),
  statusLine: document.getElementById("statusLine"),
  hintText: document.getElementById("hintText"),
  btnGps: document.getElementById("btnGps"),
  btnStop: document.getElementById("btnStop"),
  btnRecenter: document.getElementById("btnRecenter"),
};

// =====================
// State
// =====================

let watchId = null;
let lastGpsTs = 0;

// =====================
// SW
// =====================

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    // Scope ./ => /maps/
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  } catch (e) {
    console.warn("SW register failed", e);
  }
}

// =====================
// Token / Gate
// =====================

function getOrCreateDriverToken() {
  let t = localStorage.getItem("driver_token");
  if (!t) {
    t = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    localStorage.setItem("driver_token", t);
  }
  return t;
}

function gatePin() {
  // Mode B (PIN)
  const okKey = "driver_pin_ok_v1";
  if (localStorage.getItem(okKey) === "1") return true;

  const pin = prompt("Code livreur ?");
  if (!pin) return false;
  if (pin !== DRIVER_PIN) {
    alert("Code incorrect.");
    return false;
  }
  localStorage.setItem(okKey, "1");
  return true;
}

// =====================
// NOTIFICATIONS (OneSignal)
// =====================
//
// Objectif:
// - Le livreur reçoit une notification même si la PWA est fermée (push Web via Service Worker).
// - Dès que la notif est activée, on enregistre l'ID de subscription côté Worker Cloudflare (/push/register).
//
// Note "sonnerie":
// - Sur Web Push (Chrome Android), tu auras le son/vibration système par défaut.
// - Une sonnerie personnalisée n'est pas fiable en Web Push (réservé aux apps natives).
// - Par contre, quand la page est ouverte, on peut faire sonner via un <audio> si tu veux plus tard.

let oneSignalReady = false;

function setNotifState(txt) {
  if (els.notifState) setText(els.notifState, txt);
}

async function onesignalInit() {
  if (!ONESIGNAL_APP_ID) {
    setNotifState("ID manquant");
    return;
  }

  window.OneSignalDeferred = window.OneSignalDeferred || [];

  window.OneSignalDeferred.push(async function (OneSignal) {
    try {
      await OneSignal.init({
        appId: ONESIGNAL_APP_ID,

        // Très important: on réutilise TON sw.js (cache + push) => un seul SW sur le scope ./ (maps/)
        serviceWorkerPath: "./sw.js",
        serviceWorkerUpdaterPath: "./sw.js",

        notifyButton: { enable: false },
      });

      oneSignalReady = true;

      const perm = await OneSignal.Notifications.permission;
      if (perm === "granted") {
        setNotifState("OK");
        await onesignalRegisterToBackend(OneSignal);
      } else if (perm === "denied") {
        setNotifState("Bloqué");
      } else {
        setNotifState("À activer");
      }
    } catch (e) {
      setNotifState("KO");
      console.warn("OneSignal init error", e);
    }
  });
}

async function onesignalAskPermission() {
  if (!oneSignalReady) {
    await onesignalInit();
  }

  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(async function (OneSignal) {
    try {
      const perm = await OneSignal.Notifications.permission;
      if (perm === "denied") {
        setNotifState("Bloqué");
        alert("Notifications bloquées pour ce site. Va dans les paramètres du site (Chrome) et autorise les notifications.");
        return;
      }

      await OneSignal.Notifications.requestPermission();

      const perm2 = await OneSignal.Notifications.permission;
      if (perm2 === "granted") {
        setNotifState("OK");
        await onesignalRegisterToBackend(OneSignal);
      } else {
        setNotifState("Refusé");
      }
    } catch (e) {
      setNotifState("KO");
      console.warn("OneSignal permission error", e);
      alert("Impossible d'activer les notifications (voir console).");
    }
  });
}

async function onesignalRegisterToBackend(OneSignal) {
  try {
    let sid = OneSignal?.User?.PushSubscription?.id || null;

    // Fallback: attendre un peu si pas encore dispo
    if (!sid) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        sid = OneSignal?.User?.PushSubscription?.id || null;
        if (sid) break;
      }
    }

    if (!sid) {
      setNotifState("KO");
      console.warn("OneSignal: subscription id introuvable");
      return;
    }

    const driver_token = getOrCreateDriverToken();

    await apiFetchJson(`${API_BASE}/push/register`, {
      method: "POST",
      body: JSON.stringify({
        role: "driver",
        subscription_id: sid,
        driver_token,
        ua: navigator.userAgent,
        ts: Date.now(),
      }),
    });

    setNotifState("OK");
  } catch (e) {
    console.warn("push/register failed", e);
    setNotifState("KO");
  }
}

// =====================
// GPS
// =====================

function recenter() {
  // placeholder (selon ton code map)
  // tu peux garder ta logique existante si tu l’avais
}

async function startDriverGps() {
  if (!navigator.geolocation) {
    alert("GPS non supporté.");
    return;
  }
  if (watchId) return;

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const ts = Date.now();
      lastGpsTs = ts;
      setText(els.gpsState, "Actif");
      setText(els.lastUpdate, "à l'instant");

      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy || null;
      const speed = pos.coords.speed || null;

      // Ici, tu gardes ta logique existante: si tu envoies des points,
      // tu dois avoir un "session" courant. (Dans ton système, c’est piloté par le client.)
      // Donc on ne force rien ici.
    },
    (err) => {
      console.warn(err);
      setText(els.gpsState, "Erreur");
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function stopDriverGps() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  setText(els.gpsState, "Inactif");
}

// =====================
// Dashboard poll (pending count)
// =====================

async function pollDashboard() {
  try {
    const driver_token = getOrCreateDriverToken();
    const url = `${API_BASE}/driver/dashboard?driver_token=${encodeURIComponent(driver_token)}`;
    const data = await apiFetchJson(url);
    if (data?.ok) {
      setText(els.pendingCount, String(data.pending ?? 0));
    }
  } catch (e) {
    console.warn("dashboard poll failed", e);
  }
}

// =====================
// Boot
// =====================

function bootAfterGate() {
  registerSW();
  // Init OneSignal (ne demande pas la permission tout seul)
  onesignalInit();

  if (els.btnNotif) els.btnNotif.addEventListener("click", onesignalAskPermission);

  els.btnGps.addEventListener("click", startDriverGps);
  els.btnStop.addEventListener("click", stopDriverGps);
  els.btnRecenter.addEventListener("click", recenter);

  // poll
  pollDashboard();
  setInterval(pollDashboard, 5000);
  setInterval(() => {
    if (!lastGpsTs) return;
    setText(els.lastUpdate, fmtAgo(lastGpsTs));
  }, 1000);
}

(function main() {
  if (!gatePin()) {
    setText(els.statusLine, "Accès refusé");
    return;
  }
  setText(els.statusLine, "Prêt");
  bootAfterGate();
})();

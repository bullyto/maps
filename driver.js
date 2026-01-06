import { API_BASE, MAX_MINUTES, DRIVER_PIN } from "./config.js";
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

  pushState: document.getElementById("pushState"),
  btnPushEnable: document.getElementById("btnPushEnable"),

  btnGps: document.getElementById("btnGps"),
  btnGpsStop: document.getElementById("btnGpsStop"),
  btnRecenter: document.getElementById("btnRecenter"),

  pendingList: document.getElementById("pendingList"),
  activeList: document.getElementById("activeList"),
};

const LS = {
  pinOk: "adn_driver_pin_ok_v1",
  pushSubId: "adn_driver_push_sub_id_v1",
  pushRegisteredAt: "adn_driver_push_registered_at_v1",
};

const driverToken = getOrCreateDriverToken();

let map, markerDriver;
let watchId = null;
let lastDriverLatLng = null;
let didCenterOnce = false;

const markers = new Map(); // session -> marker
const sessionData = new Map(); // session -> row (pending/active)

const ICON_CLIENT = L.icon({
  iconUrl: "./icons/marker-client.svg",
  iconSize: [36, 36],
  iconAnchor: [18, 36],
});

const ICON_DRIVER = L.icon({
  iconUrl: "./icons/marker-driver.svg",
  iconSize: [40, 40],
  iconAnchor: [20, 40],
});

// =====================
// Gate PIN
// =====================

function showPinGate() {
  els.overlay.style.display = "flex";
  els.app.style.display = "none";
  els.pinInput.value = "";
  els.pinErr.style.display = "none";
  els.pinInput.focus();
}

function hidePinGate() {
  els.overlay.style.display = "none";
  els.app.style.display = "block";
}

function submitPin() {
  els.pinErr.style.display = "none";
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

async function registerSW() {
  // SW uniquement ici (livreur)
  try {
    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    }
  } catch (e) {
    console.warn("[sw] register failed", e);
  }
}

// =====================
// OneSignal Push (livreur)
// =====================

function setPushState(label) {
  if (els.pushState) setText(els.pushState, label);
}

function getStoredPushSubId() {
  return (localStorage.getItem(LS.pushSubId) || "").trim() || null;
}

function storePushSubId(id) {
  if (!id) return;
  localStorage.setItem(LS.pushSubId, id);
  localStorage.setItem(LS.pushRegisteredAt, String(Date.now()));
}

async function postPushRegister(subscriptionId) {
  // Enregistre le device push dans le Worker (D1)
  // Best-effort: si l'API répond mal, on garde l'app utilisable.
  try {
    const r = await apiFetchJson(`${API_BASE}/push/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driver_token: driverToken,
        subscription_id: subscriptionId,
        ua: navigator.userAgent || "",
      }),
    });
    if (r && r.ok) {
      storePushSubId(subscriptionId);
      setPushState("✅ Activées");
      return true;
    }
  } catch (e) {
    console.warn("[push] register failed", e);
  }
  setPushState("⚠️ Erreur d’enregistrement");
  return false;
}

async function refreshPushStateFromOneSignal() {
  // OneSignal SDK est chargé en defer => toujours passer par OneSignalDeferred
  if (!window.OneSignalDeferred) {
    setPushState("—");
    return;
  }

  window.OneSignalDeferred.push(async function(OneSignal) {
    try {
      const supported = await OneSignal.Notifications.isPushSupported();
      if (!supported) {
        setPushState("❌ Non supportées");
        if (els.btnPushEnable) els.btnPushEnable.disabled = true;
        return;
      }

      const perm = OneSignal.Notifications.permission; // 'default' | 'granted' | 'denied'
      const optedIn = OneSignal.User?.PushSubscription?.optedIn === true;
      const subId = OneSignal.User?.PushSubscription?.id || null;

      if (perm === "denied") {
        setPushState("⛔ Bloquées (réglages)");
        if (els.btnPushEnable) els.btnPushEnable.disabled = true;
        return;
      }

      if (optedIn && subId) {
        setPushState("✅ Activées");
        if (els.btnPushEnable) {
          els.btnPushEnable.disabled = true;
          els.btnPushEnable.textContent = "Notifications actives";
        }
        // Si on n'a pas encore enregistré le device dans notre Worker, on le fait.
        const stored = getStoredPushSubId();
        if (stored !== subId) {
          await postPushRegister(subId);
        }
      } else {
        setPushState(perm === "granted" ? "⚠️ À activer (opt-in)" : "🔔 À activer");
        if (els.btnPushEnable) {
          els.btnPushEnable.disabled = false;
          els.btnPushEnable.textContent = "Activer notifications";
        }
      }
    } catch (e) {
      console.warn("[push] state error", e);
      setPushState("—");
    }
  });
}

async function enablePushFlow() {
  if (!window.OneSignalDeferred) {
    alert("OneSignal n’est pas chargé. Vérifie la connexion internet puis recharge la page.");
    return;
  }

  // Débloque l'audio (si possible) via un geste utilisateur
  try {
    if (window.AudioContext) {
      const ctx = window.__adn_audio_ctx || (window.__adn_audio_ctx = new AudioContext());
      await ctx.resume();
      window.__adn_audio_ctx_unlocked = true;
    }
  } catch {}

  // Obligatoire: déclenché par un clic utilisateur (bon UX + navigateur)
  window.OneSignalDeferred.push(async function(OneSignal) {
    try {
      if (els.btnPushEnable) {
        els.btnPushEnable.disabled = true;
        els.btnPushEnable.textContent = "Autorisation…";
      }

      // optIn() tente aussi d'afficher le prompt si pas de token (doc v16)
      await OneSignal.User.PushSubscription.optIn();
      // Attendre une micro-pause puis rafraîchir l'état
      setTimeout(() => { refreshPushStateFromOneSignal(); }, 600);
    } catch (e) {
      console.warn("[push] optIn failed", e);
      if (els.btnPushEnable) {
        els.btnPushEnable.disabled = false;
        els.btnPushEnable.textContent = "Activer notifications";
      }
      setPushState("⚠️ Refusées / erreur");
    }
  });
}

function installPushListeners() {
  if (!window.OneSignalDeferred) return;

  window.OneSignalDeferred.push(async function(OneSignal) {
    try {
      // Quand la subscription change (nouvel id, token, optedIn)
      OneSignal.User.PushSubscription.addEventListener("change", async (event) => {
        const cur = event?.current || {};
        if (cur.optedIn && cur.id) {
          await postPushRegister(cur.id);
        }
        refreshPushStateFromOneSignal();
      });

      // Quand une notif arrive en foreground: vibre + bip (si audio déverrouillé)
      OneSignal.Notifications.addEventListener("foregroundWillDisplay", () => {
        try {
          if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
          if (window.__adn_audio_ctx_unlocked && window.AudioContext) {
            const ctx = window.__adn_audio_ctx || (window.__adn_audio_ctx = new AudioContext());
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = "sine";
            o.frequency.value = 880;
            g.gain.value = 0.08;
            o.connect(g); g.connect(ctx.destination);
            o.start();
            setTimeout(() => { try { o.stop(); o.disconnect(); g.disconnect(); } catch {} }, 180);
          }
        } catch {}
      });
    } catch (e) {
      console.warn("[push] listeners error", e);
    }
  });
}

// =====================
// GPS + Map
// =====================

function initMap() {
  map = L.map("map", { zoomControl: true });
  map.setView([42.697, 2.895], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap",
    maxZoom: 19,
  }).addTo(map);

  markerDriver = L.marker([42.697, 2.895], { icon: ICON_DRIVER }).addTo(map);
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

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy || null;
      const speed = pos.coords.speed || null;
      const heading = pos.coords.heading || null;
      const ts = pos.timestamp || Date.now();

      lastDriverLatLng = [lat, lng];
      markerDriver.setLatLng(lastDriverLatLng);

      if (!didCenterOnce) {
        didCenterOnce = true;
        map.setView(lastDriverLatLng, 15);
      }

      // post tracking
      try {
        await apiFetchJson(`${API_BASE}/driver/update`, {
          method: "POST",
          body: JSON.stringify({
            driver_token: driverToken,
            lat, lng, acc, speed, heading,
            battery: null,
            ts,
          }),
        });
        setText(els.lastUpdate, fmtAgo(Date.now()));
      } catch (e) {
        console.warn("[gps] post failed", e);
      }
    },
    (err) => {
      console.warn("[gps] error", err);
      alert("Erreur GPS: " + (err.message || err.code));
      stopDriverGps();
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function stopDriverGps() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  setText(els.gpsState, "Inactif");
  if (els.btnGps) { els.btnGps.disabled = false; els.btnGps.textContent = "Activer GPS"; }
  if (els.btnGpsStop) { els.btnGpsStop.disabled = true; }
}

function recenter() {
  if (lastDriverLatLng) {
    map.setView(lastDriverLatLng, 15);
  }
}

// =====================
// Dashboard / Sessions
// =====================

function sessionRowHtml(row) {
  const s = String(row.session || "");
  const name = row.client_name ? String(row.client_name) : "Client";
  const createdAgo = fmtAgo(Number(row.created_ts || 0));
  const status = String(row.status || "");

  const btns =
    status === "pending"
      ? `<div class="rowBtns">
          <button class="btn small primary" data-act="accept" data-session="${s}">Accepter</button>
          <button class="btn small danger" data-act="deny" data-session="${s}">Refuser</button>
        </div>`
      : status === "active"
      ? `<div class="rowBtns">
          <button class="btn small danger" data-act="end" data-session="${s}">Terminer</button>
        </div>`
      : "";

  return `
    <div class="row">
      <div class="rowMain">
        <div class="rowTitle">${name}</div>
        <div class="rowMeta">Session: ${s.slice(0, 8)} • ${createdAgo}</div>
      </div>
      ${btns}
    </div>
  `;
}

function renderSessions(pending, active) {
  const pendingHtml = (pending || []).map(sessionRowHtml).join("") || `<div class="empty">Aucune demande.</div>`;
  const activeHtml = (active || []).map(sessionRowHtml).join("") || `<div class="empty">Aucune session active.</div>`;

  els.pendingList.innerHTML = pendingHtml;
  els.activeList.innerHTML = activeHtml;

  setText(els.pendingCount, String((pending || []).length));
}

async function fetchDashboard() {
  const url = new URL(`${API_BASE}/driver/dashboard`);
  url.searchParams.set("driver_token", driverToken);
  return apiFetchJson(url.toString());
}

async function driverDecision(session, decision, minutes) {
  return apiFetchJson(`${API_BASE}/driver/decision`, {
    method: "POST",
    body: JSON.stringify({
      driver_token: driverToken,
      session,
      decision,
      minutes,
    }),
  });
}

async function startDashboardLoop() {
  const loop = async () => {
    try {
      const data = await fetchDashboard();
      const pending = data.pending || [];
      const active = data.active || [];
      renderSessions(pending, active);

      // Markers clients
      const nowSessions = new Set();

      for (const row of [...pending, ...active]) {
        const s = String(row.session || "");
        nowSessions.add(s);

        const lat = row.client_lat != null ? Number(row.client_lat) : null;
        const lng = row.client_lng != null ? Number(row.client_lng) : null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        if (!markers.has(s)) {
          const m = L.marker([lat, lng], { icon: ICON_CLIENT }).addTo(map);
          markers.set(s, m);
          sessionData.set(s, row);
        } else {
          markers.get(s).setLatLng([lat, lng]);
          sessionData.set(s, row);
        }
      }

      // cleanup old markers
      for (const [s, m] of markers.entries()) {
        if (!nowSessions.has(s)) {
          try { map.removeLayer(m); } catch {}
          markers.delete(s);
          sessionData.delete(s);
        }
      }

      setText(els.lastUpdate, fmtAgo(Date.now()));
    } catch (e) {
      console.warn("[dashboard] fetch failed", e);
    } finally {
      setTimeout(loop, 2500);
    }
  };

  loop();
}

function attachRowHandlers() {
  document.body.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    const session = btn.getAttribute("data-session");
    if (!act || !session) return;

    btn.disabled = true;

    try {
      if (act === "accept") {
        const minutes = prompt(`Durée de suivi (max ${MAX_MINUTES} min) ?`, "15");
        const m = Number(minutes);
        await driverDecision(session, "accept", Number.isFinite(m) ? m : 15);
      } else if (act === "deny") {
        await driverDecision(session, "deny", null);
      } else if (act === "end") {
        await driverDecision(session, "end", null);
      }
    } catch (err) {
      alert("Erreur: " + (err?.message || err));
    } finally {
      btn.disabled = false;
    }
  });
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

  attachRowHandlers();

  // Push
  installPushListeners();
  if (els.btnPushEnable) els.btnPushEnable.addEventListener("click", enablePushFlow);
  refreshPushStateFromOneSignal();

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

  els.pinBtn.addEventListener("click", submitPin);
  els.pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPin();
  });
}

boot();

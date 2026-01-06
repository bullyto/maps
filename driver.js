import { API_BASE, MAX_MINUTES, DRIVER_PIN } from "./config.js";
import { apiFetchJson, setText, fmtAgo, getOrCreateDriverToken } from "./shared.js";

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
  pushDebug: document.getElementById("pushDebug"),
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
};

const driverToken = getOrCreateDriverToken();

let map, markerDriver;
let watchId = null;
let lastDriverLatLng = null;
let didCenterOnce = false;

const markers = new Map();

const ICON_CLIENT = L.icon({ iconUrl: "./icons/marker-client.svg", iconSize: [36, 36], iconAnchor: [18, 36] });
const ICON_DRIVER = L.icon({ iconUrl: "./icons/marker-driver.svg", iconSize: [40, 40], iconAnchor: [20, 40] });

function dbg(t) {
  if (els.pushDebug) els.pushDebug.textContent = t || "";
}

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
  try {
    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    }
  } catch (e) {
    console.warn("[sw] register failed", e);
  }
}

/* ===================== PUSH OneSignal ===================== */

function setPushState(label) {
  if (els.pushState) setText(els.pushState, label);
}
function getStoredPushSubId() {
  return (localStorage.getItem(LS.pushSubId) || "").trim() || null;
}
function storePushSubId(id) {
  if (id) localStorage.setItem(LS.pushSubId, id);
}

async function postPushRegister(subscriptionId) {
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
      dbg(`OK: subscription_id enregistré (${subscriptionId})`);
      return true;
    }
  } catch (e) {
    console.warn("[push] register failed", e);
    dbg("Erreur /push/register: " + String(e?.message || e));
  }
  setPushState("⚠️ Erreur");
  return false;
}

async function refreshPushStateFromOneSignal() {
  if (!window.OneSignalDeferred) {
    setPushState("—");
    dbg("OneSignalDeferred absent (SDK pas chargé).");
    return;
  }

  window.OneSignalDeferred.push(async function(OneSignal) {
    try {
      if (window.__adn_onesignal_ready === false) {
        setPushState("⚠️ OneSignal KO");
        dbg("OneSignal init error: " + (window.__adn_onesignal_error || "unknown"));
        return;
      }

      const supported = await OneSignal.Notifications.isPushSupported();
      if (!supported) {
        setPushState("❌ Non supportées");
        dbg("Push non supportées sur ce navigateur.");
        els.btnPushEnable.disabled = true;
        return;
      }

      const perm = OneSignal.Notifications.permission; // default/granted/denied
      const optedIn = OneSignal.User?.PushSubscription?.optedIn === true;
      const subId = OneSignal.User?.PushSubscription?.id || null;

      dbg(`supported=${supported} perm=${perm} optedIn=${optedIn} subId=${subId || "null"}`);

      if (perm === "denied") {
        setPushState("⛔ Bloquées");
        els.btnPushEnable.disabled = true;
        els.btnPushEnable.textContent = "Notifications bloquées";
        return;
      }

      if (optedIn && subId) {
        setPushState("✅ Activées");
        els.btnPushEnable.disabled = true;
        els.btnPushEnable.textContent = "Notifications actives";

        const stored = getStoredPushSubId();
        if (stored !== subId) await postPushRegister(subId);
        return;
      }

      setPushState(perm === "granted" ? "⚠️ Opt-in" : "🔔 À activer");
      els.btnPushEnable.disabled = false;
      els.btnPushEnable.textContent = "Activer notifications";
    } catch (e) {
      console.warn("[push] state error", e);
      setPushState("—");
      dbg("Erreur refreshPushState: " + String(e?.message || e));
    }
  });
}

async function enablePushFlow() {
  if (!window.OneSignalDeferred) {
    alert("OneSignal n’est pas chargé. Recharge la page et vérifie ta connexion.");
    return;
  }

  els.btnPushEnable.disabled = true;
  els.btnPushEnable.textContent = "Autorisation…";
  dbg("Tentative d’autorisation… (si rien ne pop: vérifier Notifications=Bloqué)");

  window.OneSignalDeferred.push(async function(OneSignal) {
    try {
      const supported = await OneSignal.Notifications.isPushSupported();
      if (!supported) {
        setPushState("❌ Non supportées");
        dbg("Push non supportées.");
        return;
      }

      // IMPORTANT: forcer la demande de permission (la popup)
      // Si déjà granted, ça ne montre rien (normal)
      await OneSignal.Notifications.requestPermission();

      // Ensuite opt-in (crée la subscription)
      await OneSignal.User.PushSubscription.optIn();

      // Attendre un peu que l'id arrive
      setTimeout(async () => {
        await refreshPushStateFromOneSignal();
      }, 700);
    } catch (e) {
      console.warn("[push] enable failed", e);
      setPushState("⚠️ Refus/erreur");
      dbg("Erreur enablePushFlow: " + String(e?.message || e));
      els.btnPushEnable.disabled = false;
      els.btnPushEnable.textContent = "Activer notifications";
    }
  });
}

function installPushListeners() {
  if (!window.OneSignalDeferred) return;

  window.OneSignalDeferred.push(async function(OneSignal) {
    try {
      OneSignal.User.PushSubscription.addEventListener("change", async (event) => {
        const cur = event?.current || {};
        if (cur.optedIn && cur.id) await postPushRegister(cur.id);
        refreshPushStateFromOneSignal();
      });
    } catch (e) {
      console.warn("[push] listeners error", e);
    }
  });
}

/* ===================== MAP + GPS ===================== */

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
  if (!("geolocation" in navigator)) return alert("GPS indisponible.");
  if (watchId != null) return;

  setText(els.gpsState, "Actif");
  els.btnGps.disabled = true;
  els.btnGps.textContent = "GPS ON";
  els.btnGpsStop.disabled = false;

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
      if (!didCenterOnce) { didCenterOnce = true; map.setView(lastDriverLatLng, 15); }

      try {
        await apiFetchJson(`${API_BASE}/driver/update`, {
          method: "POST",
          body: JSON.stringify({ driver_token: driverToken, lat, lng, acc, speed, heading, battery: null, ts }),
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
  els.btnGps.disabled = false;
  els.btnGps.textContent = "Activer GPS";
  els.btnGpsStop.disabled = true;
}

function recenter() {
  if (lastDriverLatLng) map.setView(lastDriverLatLng, 15);
}

/* ===================== DASHBOARD ===================== */

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
  els.pendingList.innerHTML = (pending || []).map(sessionRowHtml).join("") || `<div class="empty">Aucune demande.</div>`;
  els.activeList.innerHTML = (active || []).map(sessionRowHtml).join("") || `<div class="empty">Aucune session active.</div>`;
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
    body: JSON.stringify({ driver_token: driverToken, session, decision, minutes }),
  });
}

async function startDashboardLoop() {
  const loop = async () => {
    try {
      const data = await fetchDashboard();
      const pending = data.pending || [];
      const active = data.active || [];
      renderSessions(pending, active);

      const nowSessions = new Set();
      for (const row of [...pending, ...active]) {
        const s = String(row.session || "");
        nowSessions.add(s);

        const lat = row.client_lat != null ? Number(row.client_lat) : null;
        const lng = row.client_lng != null ? Number(row.client_lng) : null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        if (!markers.has(s)) markers.set(s, L.marker([lat, lng], { icon: ICON_CLIENT }).addTo(map));
        else markers.get(s).setLatLng([lat, lng]);
      }

      for (const [s, m] of markers.entries()) {
        if (!nowSessions.has(s)) { try { map.removeLayer(m); } catch {} markers.delete(s); }
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
      } else if (act === "deny") await driverDecision(session, "deny", null);
      else if (act === "end") await driverDecision(session, "end", null);
    } catch (err) {
      alert("Erreur: " + (err?.message || err));
    } finally {
      btn.disabled = false;
    }
  });
}

/* ===================== BOOT ===================== */

function bootAfterGate() {
  initMap();
  registerSW();

  setText(els.gpsState, "Inactif");
  setText(els.lastUpdate, "—");

  els.btnGps.addEventListener("click", startDriverGps);
  els.btnGpsStop.addEventListener("click", stopDriverGps);
  els.btnRecenter.addEventListener("click", recenter);

  attachRowHandlers();

  // Push
  installPushListeners();
  els.btnPushEnable.addEventListener("click", enablePushFlow);
  refreshPushStateFromOneSignal();

  startDashboardLoop();
}

function boot() {
  if (localStorage.getItem(LS.pinOk) === "1") {
    hidePinGate();
    bootAfterGate();
  } else {
    showPinGate();
  }

  els.pinBtn.addEventListener("click", submitPin);
  els.pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitPin(); });
}

boot();

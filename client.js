import { CONFIG } from "./config.js";

// ------------------------------------------------------------
// Client web (Suivi)
// ------------------------------------------------------------
// Règles:
//  - Le client DOIT partager sa position pour voir le livreur.
//  - Le client ne voit jamais les autres clients.
//  - Pendant l'attente de décision, le bouton est bloqué.
//  - Si accepté: accès temporaire (défaut 30 minutes) + révocable.

const els = {
  name: document.getElementById("name"),
  btnRequest: document.getElementById("btnRequest"),
  btnReset: document.getElementById("btnReset"),
  badge: document.getElementById("statusBadge"),
  stateText: document.getElementById("stateText"),
  countdown: document.getElementById("countdown"),
  geoText: document.getElementById("geoText"),
  map: document.getElementById("map"),
  popup: document.querySelector(".clientPopup"),
};

const LS = {
  prefix: CONFIG.LS_PREFIX || "adn66_track_",
  name: (CONFIG.LS_PREFIX || "adn66_track_") + "name",
  requestId: (CONFIG.LS_PREFIX || "adn66_track_") + "requestId",
  clientId: (CONFIG.LS_PREFIX || "adn66_track_") + "clientId",
  lastRequestMs: (CONFIG.LS_PREFIX || "adn66_track_") + "lastRequestMs",
};

const STATE = {
  map: null,
  markerClient: null,
  markerDriver: null,
  clientPos: null, // {lat,lng,acc,ts}
  watchId: null,

  // session
  requestId: "",
  clientId: "",
  status: "idle", // idle|pending|accepted|refused|expired|error

  // timers
  tPollStatus: null,
  tPollDriver: null,
  tSendClientPos: null,
  tCountdown: null,
  accessRemainingMs: null,
};

// ----------------------------
// UI helpers
// ----------------------------
function setBadge(text) {
  if (els.badge) els.badge.textContent = text;
}

function setState(text) {
  if (els.stateText) els.stateText.textContent = text;
}

function setCountdown(text) {
  if (els.countdown) els.countdown.textContent = text;
  updatePopupVisibility();
}

function setGeo(text) {
  if (els.geoText) els.geoText.textContent = text;
}

function setPopupVisible(visible) {
  if (!els.popup) return;
  if (visible) {
    els.popup.classList.add("isVisible");
  } else {
    els.popup.classList.remove("isVisible");
  }
}

function updatePopupVisibility() {
  // RÈGLE UX:
  // - La popup DOIT disparaître dès que l'accès est "accepté" (chrono en cours)
  //   même si le backend n'a pas encore renvoyé remainingMs.
  // - Elle DOIT réapparaître quand le temps arrive à 0 (accès terminé).

  const isAccepted = STATE.status === "accepted";
  const remaining = STATE.accessRemainingMs;
  const hasActiveAccess = isAccepted && (remaining == null || remaining > 0);

  setPopupVisible(!hasActiveAccess);
}

function toast(msg) {
  alert(msg);
}

function fmtRemaining(ms) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function stopTimer(id) {
  if (id) clearInterval(id);
}

function stopTimeout(id) {
  if (id) clearTimeout(id);
}

function disableRequest(disabled) {
  if (els.btnRequest) els.btnRequest.disabled = !!disabled;
}

function showReset(show) {
  if (els.btnReset) els.btnReset.style.display = show ? "inline-block" : "none";
}

// ----------------------------
// LocalStorage helpers
// ----------------------------
function lsGet(k, def = "") {
  try {
    const v = localStorage.getItem(k);
    return v == null ? def : v;
  } catch {
    return def;
  }
}

function lsSet(k, v) {
  try {
    localStorage.setItem(k, String(v));
  } catch {}
}

function lsDel(k) {
  try {
    localStorage.removeItem(k);
  } catch {}
}

// ----------------------------
// API helpers
// ----------------------------
function buildUrl(path, params = {}) {
  const u = new URL(CONFIG.API_BASE + path);
  u.searchParams.set("key", CONFIG.CLIENT_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).length > 0) {
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function apiFetchJson(path, { method = "GET", params = {}, body = null } = {}) {
  const url = buildUrl(path, params);
  const init = {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  };
  if (body != null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(url, init);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  if (!resp.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  if (data && data.ok === false) {
    throw new Error(data.error || data.message || "api_error");
  }
  return data;
}

// ----------------------------
// MAP (Leaflet)
// ----------------------------
const ICON_CLIENT = L.icon({
  iconUrl: "./icons/marker-client.svg",
  iconSize: [44, 44],
  iconAnchor: [22, 44],
});
const ICON_DRIVER = L.icon({
  iconUrl: "./icons/marker-driver.svg",
  iconSize: [48, 48],
  iconAnchor: [24, 48],
});

function initMap() {
  const map = L.map("map", { zoomControl: true });
  map.setView([42.6887, 2.8948], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  const markerClient = L.marker([42.6887, 2.8948], { icon: ICON_CLIENT }).addTo(map);
  markerClient.bindPopup("Vous");

  const markerDriver = L.marker([42.6887, 2.8948], { icon: ICON_DRIVER }).addTo(map);
  markerDriver.bindPopup("Livreur");

  STATE.map = map;
  STATE.markerClient = markerClient;
  STATE.markerDriver = markerDriver;
}

function updateClientMarker(lat, lng) {
  if (!STATE.markerClient) return;
  STATE.markerClient.setLatLng([lat, lng]);
}

function updateDriverMarker(lat, lng) {
  if (!STATE.markerDriver) return;
  STATE.markerDriver.setLatLng([lat, lng]);
}

function fitIfBoth() {
  if (!STATE.map || !STATE.markerClient || !STATE.markerDriver) return;
  const a = STATE.markerClient.getLatLng();
  const b = STATE.markerDriver.getLatLng();
  const bounds = L.latLngBounds([a, b]);
  STATE.map.fitBounds(bounds.pad(0.25));
}

// ----------------------------
// GEOLOCATION
// ----------------------------
function ensureGeolocationAvailable() {
  return !!(navigator && navigator.geolocation);
}

function startGeolocation() {
  if (!ensureGeolocationAvailable()) {
    setGeo("⛔ Géolocalisation indisponible sur ce navigateur");
    disableRequest(true);
    return;
  }

  setGeo("📍 Demande d'accès à votre position…");

  const onOk = (pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy;
    const ts = pos.timestamp || Date.now();

    STATE.clientPos = { lat, lng, acc, ts };
    updateClientMarker(lat, lng);

    setGeo(`✅ Position partagée (±${Math.round(acc)}m)`);

    if (STATE.status === "idle" || STATE.status === "refused" || STATE.status === "expired" || STATE.status === "error") {
      disableRequest(false);
    }
  };

  const onErr = (err) => {
    console.log("[geo] error", err);
    setGeo("⛔ Position refusée : impossible d'afficher le livreur");
    disableRequest(true);
  };

  navigator.geolocation.getCurrentPosition(onOk, onErr, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0,
  });

  try {
    STATE.watchId = navigator.geolocation.watchPosition(onOk, onErr, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000,
    });
  } catch {}
}

// ----------------------------
// SESSION / STATE MACHINE
// ----------------------------
function loadSession() {
  const requestId = lsGet(LS.requestId, "");
  const clientId = lsGet(LS.clientId, "");
  const name = lsGet(LS.name, "");

  if (els.name && name) els.name.value = name;

  if (requestId && clientId) {
    STATE.requestId = requestId;
    STATE.clientId = clientId;
    STATE.status = "pending";
    return true;
  }
  return false;
}

function saveSession({ requestId, clientId, name }) {
  lsSet(LS.requestId, requestId);
  lsSet(LS.clientId, clientId);
  lsSet(LS.name, name);
}

function clearSession() {
  lsDel(LS.requestId);
  lsDel(LS.clientId);
  STATE.requestId = "";
  STATE.clientId = "";
}

function canRequestNow() {
  const last = Number(lsGet(LS.lastRequestMs, "0")) || 0;
  const cooldown = CONFIG.REQUEST_COOLDOWN_MS || 30000;
  const delta = Date.now() - last;
  return delta >= cooldown;
}

function setRequestedNow() {
  lsSet(LS.lastRequestMs, String(Date.now()));
}

function stopAllLoops() {
  stopTimer(STATE.tCountdown);
  stopTimer(STATE.tPollDriver);
  stopTimer(STATE.tSendClientPos);
  stopTimeout(STATE.tPollStatus);
  STATE.tCountdown = null;
  STATE.tPollDriver = null;
  STATE.tSendClientPos = null;
  STATE.tPollStatus = null;
}

function resetFlow({ keepName = true } = {}) {
  stopAllLoops();
  clearSession();
  STATE.status = "idle";
  STATE.accessRemainingMs = null;

  setBadge("Prêt : demande de suivi");
  setState("—");
  setCountdown("—");

  disableRequest(!STATE.clientPos);
  showReset(false);

  if (!keepName && els.name) {
    els.name.value = "";
    lsDel(LS.name);
  }
}

// ----------------------------
// API Calls
// ----------------------------
async function sendClientPositionUpdate() {
  if (!STATE.clientId || !STATE.clientPos) return;

  const name = (els.name?.value || lsGet(LS.name, "") || "").trim().slice(0, 40);

  try {
    await apiFetchJson("/client/position/update", {
      method: "POST",
      body: {
        clientId: STATE.clientId,
        name,
        lat: STATE.clientPos.lat,
        lng: STATE.clientPos.lng,
        ts: STATE.clientPos.ts || Date.now(),
      },
    });
  } catch (e) {
    console.log("[client_pos_update]", e?.message || e);
  }
}

async function pollDriverPosition() {
  if (!STATE.clientId) return;

  try {
    const data = await apiFetchJson("/client/driver-position", {
      method: "GET",
      params: { clientId: STATE.clientId },
    });

    if (data && data.driver && Number.isFinite(Number(data.driver.lat)) && Number.isFinite(Number(data.driver.lng))) {
      updateDriverMarker(Number(data.driver.lat), Number(data.driver.lng));
      fitIfBoth();
    }

    if (typeof data.remainingMs === "number") {
      STATE.accessRemainingMs = data.remainingMs;
    }
  } catch (e) {
    console.log("[driver_position]", e?.message || e);

    STATE.status = "expired";
    setBadge("Accès terminé");
    setState("Accès terminé");
    setCountdown("0:00");

    disableRequest(false);
    showReset(true);

    stopTimer(STATE.tPollDriver);
    stopTimer(STATE.tSendClientPos);
    STATE.tPollDriver = null;
    STATE.tSendClientPos = null;
  }
}

async function pollStatus() {
  if (!STATE.requestId) return;

  try {
    const data = await apiFetchJson("/client/status", {
      method: "GET",
      params: { requestId: STATE.requestId },
    });

    // ✅ Worker renvoie { request: {...}, access: {...} }
    const req = data?.request || null;
    const access = data?.access || null;

    const status = String(req?.status || "").toLowerCase();
    STATE.status = status || "pending";

    if (status === "pending") {
      setBadge("Demande envoyée • en attente");
      setState("En attente de décision");
      setCountdown("—");

      STATE.tPollStatus = setTimeout(pollStatus, CONFIG.POLL_STATUS_MS || 3000);
      return;
    }

    if (status === "refused") {
      setBadge("Refusé");
      setState("Refusé par le livreur");
      setCountdown("—");

      disableRequest(false);
      showReset(true);
      return;
    }

    if (status === "expired") {
      setBadge("Expiré");
      setState("Demande expirée");
      setCountdown("—");

      disableRequest(false);
      showReset(true);
      return;
    }

    if (status === "accepted") {
      setBadge("Autorisé ✅");
      setState("Suivi actif");

      if (typeof access?.remainingMs === "number") {
        STATE.accessRemainingMs = access.remainingMs;
      }

      stopTimeout(STATE.tPollStatus);
      STATE.tPollStatus = null;

      startAcceptedLoops();
      return;
    }

    setBadge("Statut inconnu");
    setState(status || "—");
    STATE.tPollStatus = setTimeout(pollStatus, CONFIG.POLL_STATUS_MS || 3000);
  } catch (e) {
    console.log("[status]", e?.message || e);
    setBadge("Erreur statut");
    setState("Erreur réseau");
    STATE.tPollStatus = setTimeout(pollStatus, CONFIG.POLL_STATUS_MS || 3000);
  }
}

function startAcceptedLoops() {
  stopTimer(STATE.tSendClientPos);
  STATE.tSendClientPos = setInterval(sendClientPositionUpdate, CONFIG.SEND_CLIENT_POS_MS || 8000);
  sendClientPositionUpdate();

  stopTimer(STATE.tPollDriver);
  STATE.tPollDriver = setInterval(pollDriverPosition, CONFIG.POLL_DRIVER_MS || 3000);
  pollDriverPosition();

  stopTimer(STATE.tCountdown);
  STATE.tCountdown = setInterval(() => {
    if (STATE.accessRemainingMs == null) {
      setCountdown("—");
      return;
    }
    STATE.accessRemainingMs = Math.max(0, STATE.accessRemainingMs - 1000);
    setCountdown(fmtRemaining(STATE.accessRemainingMs));
    if (STATE.accessRemainingMs <= 0) {
      // Fin d'accès -> la popup doit réapparaître
      STATE.status = "expired";

      setBadge("Accès terminé");
      setState("Accès terminé");
      setCountdown("0:00");

      // Stop des boucles "suivi actif"
      stopTimer(STATE.tSendClientPos);
      STATE.tSendClientPos = null;
      stopTimer(STATE.tPollDriver);
      STATE.tPollDriver = null;
      stopTimer(STATE.tCountdown);
      STATE.tCountdown = null;

      disableRequest(false);
      showReset(true);
    }
  }, 1000);
}

// ----------------------------
// Actions
// ----------------------------
async function handleRequestClick() {
  const name = (els.name?.value || "").trim().slice(0, 40);
  if (!name) {
    toast("Entre ton prénom.");
    return;
  }

  lsSet(LS.name, name);

  if (!STATE.clientPos) {
    toast("Tu dois accepter de partager ta position pour voir le livreur.");
    return;
  }

  if (!canRequestNow()) {
    const last = Number(lsGet(LS.lastRequestMs, "0")) || 0;
    const cooldown = CONFIG.REQUEST_COOLDOWN_MS || 30000;
    const remain = Math.ceil((cooldown - (Date.now() - last)) / 1000);
    toast(`Attends ${remain}s avant de redemander.`);
    return;
  }

  try {
    disableRequest(true);
    showReset(false);
    setBadge("Envoi de la demande…");
    setState("Envoi en cours");
    setCountdown("—");

    // ✅ Worker attend clientName (pas name)
    const data = await apiFetchJson("/client/request", {
      method: "POST",
      body: {
        clientName: name,
        lat: STATE.clientPos.lat,
        lng: STATE.clientPos.lng,
        ts: STATE.clientPos.ts || Date.now(),
      },
    });

    STATE.requestId = String(data.requestId || "");
    STATE.clientId = String(data.clientId || "");
    STATE.status = "pending";

    if (!STATE.requestId || !STATE.clientId) {
      throw new Error("missing_request_or_client_id");
    }

    saveSession({ requestId: STATE.requestId, clientId: STATE.clientId, name });
    setRequestedNow();

    setBadge("Demande envoyée • en attente");
    setState("En attente de décision");

    disableRequest(true);
    showReset(false);

    stopTimeout(STATE.tPollStatus);
    STATE.tPollStatus = setTimeout(pollStatus, 400);

    toast("✅ Demande envoyée. Le livreur a reçu une notification.");
  } catch (e) {
    console.error(e);
    setBadge("Erreur");
    setState("Impossible d'envoyer la demande");
    disableRequest(false);
    showReset(true);
    toast(`❌ Erreur: ${e?.message || e}`);
  }
}

function handleResetClick() {
  resetFlow({ keepName: true });
}

// ----------------------------
// Boot
// ----------------------------
function boot() {
  initMap();

  setBadge("Prêt : demande de suivi");
  setState("—");
  setCountdown("—");
  setGeo("—");

  if (els.btnRequest) els.btnRequest.addEventListener("click", handleRequestClick);
  if (els.btnReset) els.btnReset.addEventListener("click", handleResetClick);

  startGeolocation();

  const hasSession = loadSession();
  if (hasSession) {
    setBadge("Reprise du suivi…");
    setState("Reprise");
    disableRequest(true);
    showReset(false);

    stopTimeout(STATE.tPollStatus);
    STATE.tPollStatus = setTimeout(pollStatus, 600);
  } else {
    disableRequest(!STATE.clientPos);
    showReset(false);
  }
}

document.addEventListener("DOMContentLoaded", boot);

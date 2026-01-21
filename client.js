// PATH: maps/client.js
// /maps/client.js
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

  // ✅ fit throttle
  lastFitMs: 0,

  // ✅ driver smoothing engine (Waze-like)
  driver: {
    // buffer of server points: {lat,lng,tsServerMs, rxMs}
    buf: [],
    maxBuf: 12,

    // adaptive delay (ms)
    delayMs: 2000,
    delayMin: 2000,
    delayMax: 2600,

    // last server rx intervals (ms)
    rxIntervals: [],
    rxIntervalsMax: 8,
    lastRxMs: 0,

    // display state (lat/lng displayed now)
    disp: null, // {lat,lng}
    lastDispMs: 0,

    // prediction state
    vel: null, // {vLat,vLng} per ms (approx)
    lastVelFrom: null, // {lat,lng,tsMs}

    // animation loop
    raf: 0,

    // guard
    hasFirstFix: false,

    // max speed clamp (deg/ms converted later), we clamp in meters approx
    maxSpeedMps: 45, // 162 km/h (safe clamp)

    // ✅ NEW: cadence + glide (anti "pause" entre points)
    // On veut une glissade ~2.9s si le poll est 3s.
    pollMs: 3000, // valeur actuelle (CONFIG.POLL_DRIVER_MS)
    glideTargetMs: 2900, // demandé: 2.9s
    glideMarginMs: 80, // petite marge de sécurité
    lastPollApplyMs: 0,
  },
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

function setDriverMarkerImmediate(lat, lng) {
  if (!STATE.markerDriver) return;
  STATE.markerDriver.setLatLng([lat, lng]);
}

function fitIfBothThrottled(force = false) {
  if (!STATE.map || !STATE.markerClient || !STATE.markerDriver) return;

  const now = Date.now();
  const throttleMs = 12000; // ✅ pas tout le temps
  if (!force && now - STATE.lastFitMs < throttleMs) return;
  STATE.lastFitMs = now;

  const a = STATE.markerClient.getLatLng();
  const b = STATE.markerDriver.getLatLng();
  const bounds = L.latLngBounds([a, b]);
  STATE.map.fitBounds(bounds.pad(0.25));
}

// ----------------------------
// ✅ DRIVER SMOOTHING ENGINE (Waze-like)
// ----------------------------
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function ease(t) {
  // smoothstep
  return t * t * (3 - 2 * t);
}

// approx meters between two lat/lng (fast enough)
function approxMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

function driverApplyPollGlideDefaults() {
  const d = STATE.driver;

  // poll interval from config (fallback 3000)
  const poll = Number(CONFIG.POLL_DRIVER_MS || 3000);
  if (Number.isFinite(poll) && poll > 500) d.pollMs = poll;

  // requested: glide around 2.9s when poll=3s, and always close to poll
  // We'll keep a small margin so we never "overshoot".
  const desired = 2900;
  d.glideTargetMs = clamp(desired, 800, Math.max(800, d.pollMs - d.glideMarginMs));

  d.lastPollApplyMs = Date.now();
}

function driverAddPoint(lat, lng, tsServerMs) {
  const d = STATE.driver;
  const rxMs = Date.now();

  // compute rx interval
  if (d.lastRxMs) {
    const dt = rxMs - d.lastRxMs;
    if (dt > 0 && dt < 30000) {
      d.rxIntervals.push(dt);
      if (d.rxIntervals.length > d.rxIntervalsMax) d.rxIntervals.shift();
    }
  }
  d.lastRxMs = rxMs;

  // adaptive delay: based on avg rx interval
  if (d.rxIntervals.length >= 3) {
    const avg = d.rxIntervals.reduce((s, v) => s + v, 0) / d.rxIntervals.length;
    // base = 0.7 * avg, clamped to [2.0s, 2.6s]
    const target = clamp(Math.round(avg * 0.7), d.delayMin, d.delayMax);
    // smooth change (avoid jitter)
    d.delayMs = Math.round(d.delayMs * 0.8 + target * 0.2);
  }

  // de-dup / sanity
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const last = d.buf.length ? d.buf[d.buf.length - 1] : null;
  if (last) {
    const dist = approxMeters(last.lat, last.lng, lat, lng);
    // ignore absurd jumps unless time is huge
    const dt = Math.max(1, tsServerMs - last.tsServerMs);
    const speed = dist / (dt / 1000); // m/s
    if (speed > d.maxSpeedMps * 2) {
      // too crazy -> ignore this sample
      return;
    }
    // update velocity estimate (per ms)
    const vLat = (lat - last.lat) / dt;
    const vLng = (lng - last.lng) / dt;
    d.vel = { vLat, vLng };
    d.lastVelFrom = { lat, lng, tsMs: tsServerMs };
  }

  d.buf.push({ lat, lng, tsServerMs, rxMs });
  if (d.buf.length > d.maxBuf) d.buf.shift();

  // if first fix, set immediately and fit once
  if (!d.hasFirstFix) {
    d.hasFirstFix = true;
    d.disp = { lat, lng };
    d.lastDispMs = Date.now();
    setDriverMarkerImmediate(lat, lng);
    fitIfBothThrottled(true);
  }
}

function driverPruneBuffer(nowServerMs) {
  const d = STATE.driver;
  // Keep points around the render time window
  const keepAfter = nowServerMs - 20000; // keep last 20s
  while (d.buf.length && d.buf[0].tsServerMs < keepAfter) d.buf.shift();
}

function driverSampleAtTime(renderServerMs) {
  const d = STATE.driver;
  const buf = d.buf;

  if (buf.length === 0) return null;
  if (buf.length === 1) return { lat: buf[0].lat, lng: buf[0].lng, mode: "single" };

  // find segment [i, i+1] that contains render time
  let i = -1;
  for (let k = 0; k < buf.length - 1; k++) {
    if (buf[k].tsServerMs <= renderServerMs && renderServerMs <= buf[k + 1].tsServerMs) {
      i = k;
      break;
    }
  }

  if (i >= 0) {
    const a = buf[i];
    const b = buf[i + 1];
    const dt = b.tsServerMs - a.tsServerMs;
    const t = dt <= 0 ? 1 : (renderServerMs - a.tsServerMs) / dt;
    const tt = ease(clamp(t, 0, 1));
    return {
      lat: lerp(a.lat, b.lat, tt),
      lng: lerp(a.lng, b.lng, tt),
      mode: "interp",
    };
  }

  // render time is AFTER last point => predict softly
  const last = buf[buf.length - 1];
  const age = renderServerMs - last.tsServerMs;

  // If very old, just stick to last
  if (age > 12000) {
    return { lat: last.lat, lng: last.lng, mode: "stale" };
  }

  // prediction using last velocity
  if (d.vel) {
    const predLat = last.lat + d.vel.vLat * age;
    const predLng = last.lng + d.vel.vLng * age;

    // speed clamp
    const dist = approxMeters(last.lat, last.lng, predLat, predLng);
    const speed = dist / Math.max(0.001, age / 1000);
    if (speed > d.maxSpeedMps) {
      // clamp: reduce prediction
      const ratio = d.maxSpeedMps / speed;
      return {
        lat: last.lat + (predLat - last.lat) * ratio,
        lng: last.lng + (predLng - last.lng) * ratio,
        mode: "pred_clamped",
      };
    }

    return { lat: predLat, lng: predLng, mode: "pred" };
  }

  return { lat: last.lat, lng: last.lng, mode: "last" };
}

function driverStartLoop() {
  const d = STATE.driver;
  if (d.raf) return;

  const tick = () => {
    d.raf = requestAnimationFrame(tick);

    if (!STATE.markerDriver) return;
    if (!d.hasFirstFix) return;
    if (d.buf.length === 0) return;

    // estimate server time using last point (rxMs - tsServerMs offset)
    const last = d.buf[d.buf.length - 1];
    const offset = last.rxMs - last.tsServerMs; // approx network+clock offset
    const nowServerMs = Date.now() - offset;

    driverPruneBuffer(nowServerMs);

    // render at (now - delay)
    const renderServerMs = nowServerMs - d.delayMs;

    const sample = driverSampleAtTime(renderServerMs);
    if (!sample) return;

    const current = STATE.markerDriver.getLatLng();
    const targetLat = sample.lat;
    const targetLng = sample.lng;

    const now = Date.now();
    const dtMs = d.lastDispMs ? now - d.lastDispMs : 16;
    d.lastDispMs = now;

    // ✅ NEW: follow factor tuned to "glideTargetMs" (2.9s)
    // Goal: take ~2.9s to converge to a new target (instead of 0.5s then pause).
    // We model it as a first-order low-pass:
    //   alpha = dt / tau ; where tau ~= glideTargetMs/3 (gives ~95% in ~3*tau)
    // So if glideTargetMs=2900ms => tau ~ 966ms => smooth, continuous movement.
    const tau = Math.max(180, d.glideTargetMs / 3);
    const alphaRaw = dtMs / tau;
    const follow = clamp(alphaRaw, 0.03, 0.18); // clamp for stability

    const newLat = lerp(current.lat, targetLat, follow);
    const newLng = lerp(current.lng, targetLng, follow);

    setDriverMarkerImmediate(newLat, newLng);

    // fit rarely
    fitIfBothThrottled(false);
  };

  d.raf = requestAnimationFrame(tick);
}

function driverStopLoop() {
  const d = STATE.driver;
  if (d.raf) cancelAnimationFrame(d.raf);
  d.raf = 0;
  d.buf = [];
  d.rxIntervals = [];
  d.lastRxMs = 0;
  d.delayMs = d.delayMin;
  d.disp = null;
  d.hasFirstFix = false;
  d.vel = null;
  d.lastVelFrom = null;

  // keep glide settings
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
  driverStopLoop();
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
      const lat = Number(data.driver.lat);
      const lng = Number(data.driver.lng);

      // Use server timestamp if present, else now
      const tsServerMs =
        (data.driver.ts && Number.isFinite(Number(data.driver.ts)) ? Number(data.driver.ts) : Date.now());

      driverAddPoint(lat, lng, tsServerMs);
      driverStartLoop();
    }

    if (typeof data.remainingMs === "number") {
      STATE.accessRemainingMs = data.remainingMs;
    }
  } catch (e) {
    console.log("[driver_position]", e?.message || e);
    // Ne pas terminer l'accès sur une erreur de position.
  }
}

async function pollStatus() {
  if (!STATE.requestId) return;

  try {
    const data = await apiFetchJson("/client/status", {
      method: "GET",
      params: { requestId: STATE.requestId },
    });

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
  // ✅ apply cadence/glide once when accepted loops start
  driverApplyPollGlideDefaults();

  stopTimer(STATE.tSendClientPos);
  STATE.tSendClientPos = setInterval(sendClientPositionUpdate, CONFIG.SEND_CLIENT_POS_MS || 8000);
  sendClientPositionUpdate();

  stopTimer(STATE.tPollDriver);
  STATE.tPollDriver = setInterval(pollDriverPosition, CONFIG.POLL_DRIVER_MS || 3000);
  pollDriverPosition();

  // start smoothing loop now (even before first driver point)
  driverStartLoop();

  stopTimer(STATE.tCountdown);
  STATE.tCountdown = setInterval(() => {
    if (STATE.accessRemainingMs == null) {
      setCountdown("—");
      return;
    }
    STATE.accessRemainingMs = Math.max(0, STATE.accessRemainingMs - 1000);
    setCountdown(fmtRemaining(STATE.accessRemainingMs));
    if (STATE.accessRemainingMs <= 0) {
      STATE.status = "expired";

      setBadge("Accès terminé");
      setState("Accès terminé");
      setCountdown("0:00");

      stopTimer(STATE.tSendClientPos);
      STATE.tSendClientPos = null;
      stopTimer(STATE.tPollDriver);
      STATE.tPollDriver = null;
      stopTimer(STATE.tCountdown);
      STATE.tCountdown = null;

      driverStopLoop();

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

  // ✅ apply cadence/glide at boot too (safe)
  driverApplyPollGlideDefaults();

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

// client.js
// Version SAFE (ne casse rien) :
// - récupère bien le prénom (clientName)
// - demande la géoloc proprement (permissions + watchPosition)
// - envoie /client/request puis /client/position/update
// - affiche des statuts clairs au lieu de rester bloqué "en attente..."

// ============================
// CONFIG
// ============================
const CFG = (window.CONFIG || window.APP_CONFIG || {});
const WORKER_BASE_URL = String(
  CFG.WORKER_BASE_URL ||
  CFG.workerBaseUrl ||
  "https://and-suivi.apero-nuit-du-66.workers.dev"
).replace(/\/+$/, "");

const CLIENT_KEY = String(
  CFG.CLIENT_KEY ||
  CFG.clientKey ||
  "test123"
);

const DEFAULT_POLL_MS = Number(CFG.CLIENT_POLL_MS || 1500);
const GEO_TIMEOUT_MS = Number(CFG.GEO_TIMEOUT_MS || 12000);
const GEO_MAX_AGE_MS = Number(CFG.GEO_MAX_AGE_MS || 5000);

// ============================
// DOM HELPERS
// ============================
const $ = (sel) => document.querySelector(sel);

function setText(el, txt) {
  if (!el) return;
  el.textContent = txt;
}

function setHtml(el, html) {
  if (!el) return;
  el.innerHTML = html;
}

function now() { return Date.now(); }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// ============================
// ELEMENTS (tolérant)
// ============================
const elNameInput =
  $("#clientName") ||
  $("#client-name") ||
  $("input[name='clientName']") ||
  $("input[placeholder*='Lucas']") ||
  $("input");

const elBtn =
  $("#btnRequest") ||
  $("#btn-request") ||
  $("button[type='submit']") ||
  $("button");

const elGeo =
  $("#geoStatus") ||
  $("#geo-status") ||
  $("#geolocStatus") ||
  $("#geoloc-status") ||
  $("#geo") ||
  null;

const elState =
  $("#state") ||
  $("#status") ||
  $("#etat") ||
  $("#etatStatus") ||
  null;

const elRemaining =
  $("#remaining") ||
  $("#timeRemaining") ||
  $("#tempsRestant") ||
  null;

const elDebug =
  $("#debug") ||
  $("#log") ||
  null;

// ============================
// STORAGE KEYS
// ============================
const LS_CLIENT_ID = "adn66_client_id";
const LS_REQUEST_ID = "adn66_request_id";
const LS_CLIENT_NAME = "adn66_client_name";

// ============================
// API
// ============================
async function apiFetch(path, { method = "GET", query = {}, body = null } = {}) {
  const url = new URL(WORKER_BASE_URL + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && String(v).length) url.searchParams.set(k, String(v));
  }

  const opts = {
    method,
    headers: {
      "Accept": "application/json",
    },
  };

  if (body !== null) {
    opts.headers["Content-Type"] = "application/json; charset=utf-8";
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(url.toString(), opts);
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { ok: false, error: "invalid_json", raw: text }; }

  if (!resp.ok) {
    const msg = json?.error || `HTTP_${resp.status}`;
    throw new Error(msg);
  }
  if (json && json.ok === false) {
    throw new Error(json.error || "api_error");
  }
  return json;
}

// ============================
// GEOLOCATION
// ============================
let lastPos = null;
let watchId = null;

function geoSupported() {
  return !!(navigator.geolocation && typeof navigator.geolocation.watchPosition === "function");
}

function geoStatus(text) {
  setText(elGeo, text);
}

function stateStatus(text) {
  setText(elState, text);
}

function remainingStatus(text) {
  setText(elRemaining, text);
}

function debug(text) {
  if (!elDebug) return;
  setText(elDebug, text);
}

function startWatchGeo() {
  if (!geoSupported()) {
    geoStatus("❌ Géolocalisation indisponible (navigateur)");
    return;
  }

  geoStatus("📍 Géolocalisation : en attente… (autoriser la position)");

  const options = {
    enableHighAccuracy: true,
    timeout: GEO_TIMEOUT_MS,
    maximumAge: GEO_MAX_AGE_MS,
  };

  try {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords || {};
        lastPos = {
          lat: Number(c.latitude),
          lng: Number(c.longitude),
          acc: Number(c.accuracy || 0),
          ts: pos.timestamp ? Number(pos.timestamp) : now(),
        };

        const accTxt = lastPos.acc ? ` (±${Math.round(lastPos.acc)}m)` : "";
        geoStatus(`✅ Géolocalisation : position partagée${accTxt}`);
      },
      (err) => {
        // Codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
        let msg = "❌ Géolocalisation : erreur";
        if (err && err.code === 1) msg = "❌ Géolocalisation : refusée (autoriser la position)";
        else if (err && err.code === 2) msg = "❌ Géolocalisation : indisponible";
        else if (err && err.code === 3) msg = "⏳ Géolocalisation : délai dépassé (réessaye)";
        geoStatus(msg);
      },
      options
    );
  } catch (e) {
    geoStatus("❌ Géolocalisation : erreur");
  }
}

// ============================
// CLIENT FLOW
// ============================
function getOrCreateClientId() {
  let id = localStorage.getItem(LS_CLIENT_ID);
  if (!id) {
    id = "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(LS_CLIENT_ID, id);
  }
  return id;
}

function getSavedRequest() {
  return {
    requestId: localStorage.getItem(LS_REQUEST_ID) || "",
    clientName: localStorage.getItem(LS_CLIENT_NAME) || "",
  };
}

function saveRequest(requestId, clientName) {
  localStorage.setItem(LS_REQUEST_ID, requestId);
  localStorage.setItem(LS_CLIENT_NAME, clientName);
}

function clearRequest() {
  localStorage.removeItem(LS_REQUEST_ID);
  // on garde le clientName en mémoire si tu veux
}

async function sendClientRequest(clientName) {
  const clientId = getOrCreateClientId();

  stateStatus("Envoi de la demande…");
  remainingStatus("—");

  const res = await apiFetch("/client/request", {
    method: "POST",
    query: { key: CLIENT_KEY },
    body: { clientName, clientId },
  });

  // worker renvoie: { ok:true, requestId, clientId, status:"pending" }
  const requestId = String(res.requestId || "");
  if (!requestId) throw new Error("request_id_missing");

  saveRequest(requestId, clientName);
  stateStatus("Demande envoyée ✅ (en attente du livreur)");
  return requestId;
}

async function sendClientPositionIfAny() {
  const { requestId } = getSavedRequest();
  if (!requestId) return;

  if (!lastPos || !Number.isFinite(lastPos.lat) || !Number.isFinite(lastPos.lng)) return;

  const clientId = getOrCreateClientId();

  await apiFetch("/client/position/update", {
    method: "POST",
    query: { key: CLIENT_KEY },
    body: {
      clientId,
      lat: lastPos.lat,
      lng: lastPos.lng,
      ts: lastPos.ts || now(),
    },
  });
}

function formatMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

async function pollStatusLoop() {
  while (true) {
    const { requestId } = getSavedRequest();

    try {
      if (requestId) {
        // pousse la position client régulièrement
        await sendClientPositionIfAny();

        const clientId = getOrCreateClientId();

        const st = await apiFetch("/client/status", {
          method: "GET",
          query: { key: CLIENT_KEY, requestId },
        });

        // st: { ok:true, request:{status...}, access:{remainingMs?} }
        const status = st?.request?.status;

        if (status === "pending") {
          stateStatus("En attente de validation du livreur…");
          remainingStatus("—");
        } else if (status === "accepted") {
          stateStatus("✅ Suivi accepté");
          const remainingMs = Number(st?.access?.remainingMs || 0);
          remainingStatus(formatMs(remainingMs));

          // option : récup position livreur (si ton UI l’utilise ailleurs)
          // await apiFetch("/client/driver-position", { method:"GET", query:{ key: CLIENT_KEY, clientId } });
        } else if (status === "refused") {
          stateStatus("❌ Refusé par le livreur");
          remainingStatus("—");
          // on peut clearRequest si tu veux repartir propre
          // clearRequest();
        } else {
          stateStatus("—");
          remainingStatus("—");
        }
      } else {
        // pas de demande en cours
        stateStatus("—");
        remainingStatus("—");
      }

      debug(""); // vide
    } catch (e) {
      // En cas de perte réseau (4G faible), on affiche une erreur simple
      const msg = String(e?.message || e);
      debug(msg);

      // si c’est un "not_found", on reset la request
      if (msg === "not_found") clearRequest();
    }

    await sleep(DEFAULT_POLL_MS);
  }
}

// ============================
// UI BINDINGS
// ============================
function normalizeName(s) {
  return String(s || "").trim();
}

function lockButton(lock, text) {
  if (!elBtn) return;
  elBtn.disabled = !!lock;
  if (text) elBtn.textContent = text;
}

async function onClickRequest() {
  const name = normalizeName(elNameInput ? elNameInput.value : "");
  if (!name) {
    alert("Erreur: client_name_required");
    return;
  }

  lockButton(true, "Envoi…");

  try {
    await sendClientRequest(name);
  } catch (e) {
    const msg = String(e?.message || e);
    alert(`Erreur: ${msg}`);
  } finally {
    lockButton(false, "Suivre ma commande");
  }
}

// ============================
// INIT
// ============================
(function init() {
  // Remplit le champ prénom si déjà en LS
  const saved = getSavedRequest();
  if (elNameInput && saved.clientName && !elNameInput.value) {
    elNameInput.value = saved.clientName;
  }

  // géoloc
  startWatchGeo();

  // click
  if (elBtn) {
    elBtn.addEventListener("click", (e) => {
      e.preventDefault();
      onClickRequest();
    });
  }

  // Lance le polling
  pollStatusLoop();
})();

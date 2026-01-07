import { API_BASE } from "./config.js";
import { apiFetchJson, setText, getOrCreateClientId } from "./shared.js";

const els = {
  name: document.getElementById("name"),
  btnRequest: document.getElementById("btnRequest"),
  btnReset: document.getElementById("btnReset"),
  stateText: document.getElementById("stateText"),
  countdown: document.getElementById("countdown"),
  statusBadge: document.getElementById("statusBadge"),
};

const LS = {
  session: "adn_session_v1",
  name: "adn_client_name_v1",
  lastState: "adn_client_last_state_v1",
};

const clientId = getOrCreateClientId();

let map, markerClient, markerDriver;
let pollTimer = null;
let watchId = null;
let currentSession = localStorage.getItem(LS.session) || "";

const ICON_CLIENT = L.icon({ iconUrl: "./icons/marker-client.svg", iconSize: [44, 44], iconAnchor: [22, 44] });
const ICON_DRIVER  = L.icon({ iconUrl: "./icons/marker-driver.svg",  iconSize: [48, 48], iconAnchor: [24, 48] });

function initMap() {
  map = L.map("map", { zoomControl: true });
  // centre par défaut (Perpignan)
  map.setView([42.6887, 2.8948], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  markerClient = L.marker([42.6887, 2.8948], { icon: ICON_CLIENT }).addTo(map);
}

function setButtonState(mode) {
  // mode: idle | pending | active | expired
  if (mode === "idle") {
    els.btnRequest.disabled = false;
    els.btnRequest.textContent = "Suivre ma commande";
    els.btnReset.style.display = "none";
    return;
  }
  if (mode === "pending") {
    els.btnRequest.disabled = true;
    els.btnRequest.textContent = "Demande envoyée…";
    els.btnReset.style.display = "none";
    return;
  }
  if (mode === "active") {
    els.btnRequest.disabled = true;
    els.btnRequest.textContent = "Suivi actif";
    els.btnReset.style.display = "none";
    return;
  }
  // expired/denied
  els.btnRequest.disabled = true;
  els.btnRequest.textContent = "Accès terminé";
  els.btnReset.style.display = "block";
}

function fmtRemaining(expiresAt) {
  if (!expiresAt) return "—";
  const ms = Number(expiresAt) - Date.now();
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function stopAllTrackingUI() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }

  // retire le marqueur driver
  if (markerDriver) {
    map.removeLayer(markerDriver);
    markerDriver = null;
  }
  setText(els.countdown, "—");
}

async function startPolling() {
  if (!currentSession) return;

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const state = await apiFetchJson(`${API_BASE}/client/state?session=${encodeURIComponent(currentSession)}`);
    if (!state?.ok) return;

    const st = state.status || "expired";
    setText(els.stateText, st === "pending" ? "En attente" : st === "active" ? "Actif" : st === "denied" ? "Refusé" : "Terminé");
    setText(els.countdown, st === "active" ? fmtRemaining(state.expires_at) : "—");

    // IMPORTANT:
    // - pending: on continue de poll (sinon le client reste bloqué sur "En attente" même après accept)
    // - active: on affiche le livreur
    // - denied/expired: on stoppe tout
    if (st === "pending") {
      els.statusBadge.textContent = "En attente d’acceptation";
      setButtonState("pending");
      // On n'affiche jamais le livreur en pending
      if (markerDriver) { map.removeLayer(markerDriver); markerDriver = null; }
      return;
    }
    if (st !== "active") {
      els.statusBadge.textContent = st === "denied" ? "Refusé" : "Accès terminé";
      setButtonState("expired");
      stopAllTrackingUI();
      return;
    }

    // actif
    els.statusBadge.textContent = "Suivi en cours";
    setButtonState("active");

    if (state.driver && typeof state.driver.lat === "number" && typeof state.driver.lng === "number") {
      const ll = [state.driver.lat, state.driver.lng];
      if (!markerDriver) markerDriver = L.marker(ll, { icon: ICON_DRIVER }).addTo(map);
      else markerDriver.setLatLng(ll);
    } else {
      // pas de coords -> retire
      if (markerDriver) { map.removeLayer(markerDriver); markerDriver = null; }
    }
  }, 2000);
}

async function startWatchPosition() {
  if (!("geolocation" in navigator)) throw new Error("geolocation_unavailable");

  if (watchId != null) return;

  watchId = navigator.geolocation.watchPosition(async (pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy;

    markerClient.setLatLng([lat, lng]);

    if (!currentSession) return;
    // ping (best effort)
    try {
      await apiFetchJson(`${API_BASE}/client/ping`, {
        method: "POST",
        body: JSON.stringify({
          session: currentSession,
          client_id: clientId,
          client_name: (els.name.value || "").trim(),
          lat, lng, acc, ts: Date.now(),
        }),
      });
    } catch (_) {}
  }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

async function requestFlow() {
  const name = (els.name.value || "").trim();
  if (!name) {
    els.name.focus();
    alert("Entre ton nom (il sera affiché au livreur).");
    return;
  }
  localStorage.setItem(LS.name, name);

  // Demande de position obligatoire
  if (!("geolocation" in navigator)) {
    alert("GPS indisponible sur cet appareil.");
    return;
  }

  // 1) obtenir une position instantanée (obligatoire)
  const pos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }).catch(() => null);

  // GPS: idéalement on l’a, mais on ne bloque plus l’envoi si l’utilisateur refuse.
  let lat = null, lng = null, acc = null;
  if (!pos) {
    console.warn("[client] GPS indisponible/refusé: demande envoyée sans position.");
  } else {
    lat = pos.coords.latitude;
    lng = pos.coords.longitude;
    acc = pos.coords.accuracy;
  }

  markerClient.setLatLng([lat, lng]);
  map.setView([lat, lng], 15);

  // 2) créer/reprendre session (anti-spam côté worker)
  const res = await apiFetchJson(`${API_BASE}/client/request`, {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, client_name: name, lat, lng, acc, ts: Date.now() }),
  });

  if (!res?.ok || !res.session) {
    alert("Erreur: impossible d’envoyer la demande.");
    return;
  }

  currentSession = res.session;
  localStorage.setItem(LS.session, currentSession);

  // 3) UI en attente
  setButtonState(res.status === "active" ? "active" : "pending");
  setText(els.stateText, res.status === "active" ? "Actif" : "En attente");
  els.statusBadge.textContent = res.status === "active" ? "Suivi en cours" : "En attente d’acceptation";

  // 4) watch position + polling
  await startWatchPosition();
  await startPolling();
}

function resetSession() {
  localStorage.removeItem(LS.session);
  currentSession = "";
  stopAllTrackingUI();
  setText(els.stateText, "—");
  els.statusBadge.textContent = "Suivi sécurisé";
  setButtonState("idle");
}

function boot() {
  initMap();

  // restore name
  const savedName = localStorage.getItem(LS.name) || "";
  if (savedName) els.name.value = savedName;

  // restore session state
  if (currentSession) {
    setButtonState("pending");
    setText(els.stateText, "En attente");
    els.statusBadge.textContent = "Reprise…";
    startWatchPosition().catch(()=>{});
    startPolling().catch(()=>{});
  } else {
    setButtonState("idle");
  }

  els.btnRequest.addEventListener("click", () => requestFlow().catch(() => {
    alert("Autorise le GPS pour activer le suivi.");
  }));
  els.btnReset.addEventListener("click", resetSession);
}

boot();

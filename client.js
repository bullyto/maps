// client.js — FIX client_name_required
// Envoi STRICT du champ `clientName` attendu par le Worker Cloudflare

import { CONFIG } from "./config.js";

const STATE = {
  clientId: localStorage.getItem("client_id") || null,
  clientPos: null,
  requestId: null,
};

function $(id) {
  return document.getElementById(id);
}

async function apiFetchJson(path, options = {}) {
  const url = CONFIG.WORKER_BASE_URL.replace(/\/$/, "") + path;

  const opts = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  };

  const res = await fetch(url, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text || "invalid_json");
  }

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "api_error");
  }

  return data;
}

// Géolocalisation
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geolocation_not_supported"));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          ts: Date.now(),
        });
      },
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// ENVOI DEMANDE CLIENT
async function sendClientRequest() {
  const nameInput = $("client-name");
  const name = (nameInput?.value || "").trim();

  if (!name) {
    alert("Merci d’indiquer votre prénom.");
    return;
  }

  $("status-text").textContent = "Envoi de la demande…";

  try {
    // Position (optionnelle mais conservée)
    try {
      STATE.clientPos = await getPosition();
    } catch {
      STATE.clientPos = null;
    }

    const payload = {
      clientName: name, // ✅ OBLIGATOIRE POUR LE WORKER
    };

    if (STATE.clientId) {
      payload.clientId = STATE.clientId;
    }

    const data = await apiFetchJson("/client/request", {
      method: "POST",
      body: payload,
    });

    STATE.requestId = data.requestId;
    STATE.clientId = data.clientId;

    localStorage.setItem("client_id", STATE.clientId);

    $("status-text").textContent = "Demande envoyée ✔️";
  } catch (err) {
    console.error(err);
    alert("Erreur : " + err.message);
    $("status-text").textContent = "Erreur";
  }
}

// INIT
document.addEventListener("DOMContentLoaded", () => {
  const btn = $("send-request");
  if (btn) btn.addEventListener("click", sendClientRequest);
});

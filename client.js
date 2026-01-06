import { API_BASE } from "./config.js";
import { apiFetchJson, setText, qs, sleep } from "./shared.js";

const els = {
  token: document.getElementById("token"),
  name: document.getElementById("name"),
  city: document.getElementById("city"),
  btnRequest: document.getElementById("btnRequest"),
  btnCopy: document.getElementById("btnCopy"),
  hint: document.getElementById("hint"),
  status: document.getElementById("status"),
};

const state = {
  token: "",
  requesting: false
};

function getOrCreateToken() {
  let t = localStorage.getItem("and_suivi_token");
  if (!t) {
    t = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("and_suivi_token", t);
  }
  return t;
}

async function requestFlow() {
  // GPS obligatoire pour faire la demande (sinon on refuse, et on réactive le bouton dans le catch)
  const pos = await new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("no geo"));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    });
  });

  const client_name = (els.name.value || "").trim();
  const client_city = (els.city.value || "").trim();

  const body = {
    token: state.token,
    client_name,
    client_city,
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    ts: Date.now()
  };

  const r = await apiFetchJson(API_BASE + "/client/request", {
    method: "POST",
    body: JSON.stringify(body)
  });

  setText(els.status, "Demande envoyée ✅ En attente du livreur…");
  setText(els.hint, "");
  return r;
}

function boot() {
  state.token = getOrCreateToken();
  els.token.value = state.token;

  els.btnCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.token);
      setText(els.hint, "Token copié ✅");
      await sleep(800);
      setText(els.hint, "");
    } catch (_) {
      alert("Impossible de copier (presse-papiers bloqué).");
    }
  });

  const btnRequest = els.btnRequest;

  // ✅ Anti double-clic immédiat (c'est ton point)
  btnRequest.addEventListener("click", () => {
    if (state.requesting) return;
    state.requesting = true;
    btnRequest.disabled = true;
    btnRequest.textContent = "Demande envoyée…";

    requestFlow()
      .catch(() => {
        alert("Autorise le GPS pour activer le suivi.");
        // On ré-autorise le bouton uniquement si la demande n'a pas pu partir.
        state.requesting = false;
        btnRequest.disabled = false;
        btnRequest.textContent = "Suivre ma commande";
      });
  });
}

boot();

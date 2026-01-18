import { CONFIG } from "./config.js";

// Client web: envoie une demande de suivi au livreur (Telegram via Worker)
// -> Worker: /client/request-tracking?key=CLIENT_KEY&from=...

const STATE = {
  lastRequestMs: 0,
  cooldownMs: (CONFIG.REQUEST_COOLDOWN_MS ?? (CONFIG.REQUEST_COOLDOWN_SEC * 1000) ?? 30000)
};

function qs(id) { return document.getElementById(id); }

function setBadge(text) {
  const el = qs("statusBadge");
  if (el) el.textContent = text;
}

function toast(msg) {
  // simple, compatible mobile
  alert(msg);
}

function canRequest() {
  const delta = Date.now() - STATE.lastRequestMs;
  return delta >= STATE.cooldownMs;
}

function formatFrom() {
  // "from" sert juste à aider le livreur à identifier la demande.
  // Ici on met un identifiant simple: timestamp + userAgent light.
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  return `client_${hh}${mm}${ss}`;
}

async function requestTracking() {
  if (!canRequest()) {
    const remain = Math.ceil((STATE.cooldownMs - (Date.now() - STATE.lastRequestMs)) / 1000);
    toast(`Attends ${remain}s avant de redemander.`);
    return;
  }

  const btn = qs("btnRequest");
  const btn2 = qs("btnReset");

  try {
    if (btn) btn.disabled = true;
    setBadge("Envoi de la demande...");

    const url = new URL(CONFIG.API_BASE + "/client/request-tracking");
    url.searchParams.set("key", CONFIG.CLIENT_KEY);
    url.searchParams.set("from", formatFrom());

    const r = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });

    let data = null;
    try { data = await r.json(); } catch (_) {}

    if (!r.ok || (data && data.ok === false)) {
      const err = (data && (data.error || data.message)) || `HTTP ${r.status}`;
      throw new Error(err);
    }

    STATE.lastRequestMs = Date.now();
    setBadge("Demande envoyée au livreur ✅");

    if (btn2) btn2.style.display = "inline-block";
    toast("✅ Demande envoyée. Le livreur a reçu une notification.");
  } catch (e) {
    console.error(e);
    setBadge("Erreur : réessaie");
    toast(`❌ Impossible d'envoyer la demande: ${e.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function init() {
  const btn = qs("btnRequest");
  const btn2 = qs("btnReset");

  if (btn) btn.addEventListener("click", requestTracking);
  if (btn2) btn2.addEventListener("click", requestTracking);

  setBadge("Prêt : demande de suivi");
}

document.addEventListener("DOMContentLoaded", init);

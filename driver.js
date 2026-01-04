import { apiFetchJson, setText, shortToken, getOrCreateDriverToken, fmtAgo } from "./shared.js";
import { API_BASE, MAX_MINUTES } from "./config.js";

const els = {
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnRecenter: document.getElementById("btnRecenter"),
  requests: document.getElementById("requests"),
  dur: document.getElementById("dur"),
  durTxt: document.getElementById("durTxt"),
  hist: document.getElementById("hist"),
};

const driverToken = getOrCreateDriverToken();

let map, driverMarker, clientsLayer;
let lastDriver = null;
let watchId = null;
let pollTimer = null;

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([42.6887, 2.8948], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  driverMarker = L.circleMarker([42.6887, 2.8948], { radius: 10 }).addTo(map).bindPopup("Livreur");
  clientsLayer = L.layerGroup().addTo(map);
}

function center() { if (lastDriver) map.setView(lastDriver, Math.max(map.getZoom(), 16)); }
els.btnRecenter.addEventListener("click", center);

els.dur.addEventListener("input", () => { setText(els.durTxt, String(els.dur.value)); });

function pushLocalHistory(session, lat, lng) {
  const k = "adn_hist_" + session;
  const arr = JSON.parse(localStorage.getItem(k) || "[]");
  arr.unshift({ lat, lng, ts: Date.now() });
  while (arr.length > 5) arr.pop();
  localStorage.setItem(k, JSON.stringify(arr));
}

function renderHistory(sessions) {
  const parts = [];
  for (const s of sessions) {
    const k = "adn_hist_" + s.session;
    const arr = JSON.parse(localStorage.getItem(k) || "[]");
    if (!arr.length) continue;
    const pts = arr.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)} (${fmtAgo(p.ts)})`).join(" • ");
    parts.push(`<div><b>${shortToken(s.session)}</b><br>${pts}</div><div style="height:10px"></div>`);
  }
  els.hist.innerHTML = parts.length ? parts.join("") : "—";
}

async function startGps() {
  setText(els.status, "GPS…");
  if (!navigator.geolocation) return alert("GPS non disponible");
  if (watchId) return;

  watchId = navigator.geolocation.watchPosition((pos) => {
    lastDriver = [pos.coords.latitude, pos.coords.longitude];
    driverMarker.setLatLng(lastDriver);
    setText(els.meta, `Maj: ${new Date().toLocaleTimeString()} • ID: ${shortToken(driverToken)}`);

    fetch(API_BASE + "/driver/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driver_token: driverToken,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        acc: pos.coords.accuracy || null,
        speed: pos.coords.speed || null,
        heading: pos.coords.heading || null,
        ts: Date.now()
      })
    }).catch(() => {});

    setText(els.status, "Tracking actif");
  }, () => {
    setText(els.status, "GPS refusé");
    alert("GPS refusé");
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });

  startPolling();
}

function stopGps() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  setText(els.status, "Arrêté");
}

els.btnStart.addEventListener("click", () => startGps().catch(e => alert(e.message || e)));
els.btnStop.addEventListener("click", stopGps);

async function reverseGeocode(lat, lng) {
  try {
    const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
    const r = await fetch(u, { headers: { "Accept": "application/json" } });
    const j = await r.json();
    return j.display_name || null;
  } catch { return null; }
}

async function pollRequests() {
  const data = await apiFetchJson(API_BASE + "/driver/dashboard?driver_token=" + encodeURIComponent(driverToken));
  const sessions = (data.sessions && Array.isArray(data.sessions)) ? data.sessions : ([...(data.pending||[]), ...(data.active||[])]);

  clientsLayer.clearLayers();
  for (const s of sessions) {
    if (s.client_lat == null || s.client_lng == null) continue;
    const ll = [Number(s.client_lat), Number(s.client_lng)];
    const color = s.status === "active" ? "#35d07f" : (s.status === "pending" ? "#ffcc3a" : "#ff4d4d");
    const mk = L.circleMarker(ll, { radius: 8, color, weight: 2, fillOpacity: 0.25 }).addTo(clientsLayer);

    pushLocalHistory(s.session, ll[0], ll[1]);

    const title = s.status === "active" ? "Client (actif)" : (s.status === "pending" ? "Client (demande)" : "Client");
    mk.bindPopup(`<b>${title}</b><br>${shortToken(s.session)}<br>${s.address ? s.address : ""}`);
  }

  renderHistory(sessions);

  const pending = sessions.filter(s => s.status === "pending");
  if (!pending.length) {
    els.requests.innerHTML = "<div class='mini'>Aucune demande.</div>";
    return;
  }

  const cards = await Promise.all(pending.map(async (s) => {
    let addr = s.address;
    if (!addr && s.client_lat != null && s.client_lng != null) {
      addr = await reverseGeocode(s.client_lat, s.client_lng);
      if (addr) {
        fetch(API_BASE + "/driver/address", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driver_token: driverToken, session: s.session, address: addr })
        }).catch(() => {});
      }
    }

    return `
      <div class="req">
        <div class="reqTop">
          <div>
            <div class="label">Demande</div>
            <div class="value mono">${shortToken(s.session)}</div>
            <div class="mini">${addr ? addr : "Adresse…"} • Maj: ${fmtAgo(Number(s.client_ts||s.created_ts)||0)}</div>
          </div>
          <div class="tag"></div>
        </div>

        <div class="btnRow">
          <button class="btn primary" data-act="accept" data-s="${s.session}">Accepter</button>
          <button class="btn danger" data-act="deny" data-s="${s.session}">Refuser</button>
          <button class="btn" data-act="stop" data-s="${s.session}">Couper</button>
        </div>
      </div>
    `;
  }));

  els.requests.innerHTML = cards.join("");

  els.requests.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      const session = btn.getAttribute("data-s");
      const mins = Math.min(Number(els.dur.value) || MAX_MINUTES, MAX_MINUTES);

      if (act === "accept") {
        await apiFetchJson(API_BASE + "/driver/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driver_token: driverToken, session, decision: "accept", minutes: mins })
        });
      } else if (act === "deny") {
        await apiFetchJson(API_BASE + "/driver/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driver_token: driverToken, session, decision: "deny" })
        });
      } else if (act === "stop") {
        await apiFetchJson(API_BASE + "/driver/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driver_token: driverToken, session, decision: "stop" })
        });
      }
      pollRequests().catch(() => {});
    });
  });
}

function startPolling() {
  if (pollTimer) return;
  pollRequests().catch(() => {});
  pollTimer = setInterval(() => pollRequests().catch(() => {}), 2500);
}

initMap();
startPolling();

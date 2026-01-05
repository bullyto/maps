import { API_BASE, MAX_ACTIVE_MINUTES, DEFAULT_ACTIVE_MINUTES } from "./config.js";
import { api, qs, qsa, setStatusPill, fmtTime, clamp, sleep } from "./shared.js";

const LS_DRIVER_TOKEN = "and_driver_token";
const LS_HIST = "and_hist_v1";

let map, driverMarker;
let clientMarkers = new Map(); // session -> marker
let watchingId = null;

const driverIcon = L.icon({ iconUrl: "./icons/marker-driver.svg", iconSize:[44,44], iconAnchor:[22,38] });
const clientIcon = L.icon({ iconUrl: "./icons/marker-client.svg", iconSize:[44,44], iconAnchor:[22,38] });

function getToken(){
  let t = localStorage.getItem(LS_DRIVER_TOKEN);
  if(!t){
    t = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(16)+Math.random().toString(16).slice(2));
    localStorage.setItem(LS_DRIVER_TOKEN, t);
  }
  return t;
}

function loadHist(){
  try { return JSON.parse(localStorage.getItem(LS_HIST) || "{}"); } catch { return {}; }
}
function saveHist(h){ localStorage.setItem(LS_HIST, JSON.stringify(h)); }

function pushHist(clientKey, lat, lng){
  const h = loadHist();
  const arr = h[clientKey] || [];
  arr.unshift({lat, lng, ts:Date.now()});
  h[clientKey] = arr.slice(0,5);
  saveHist(h);
}

function renderHist(){
  const h = loadHist();
  const keys = Object.keys(h);
  if(!keys.length){ qs("#localHist").textContent = "—"; return; }
  const lines = [];
  for(const k of keys){
    const arr = h[k] || [];
    const pts = arr.map(p=>`${p.lat.toFixed(5)},${p.lng.toFixed(5)} (${Math.max(1, Math.round((Date.now()-p.ts)/1000))}s)`).join(" • ");
    lines.push(`<div style="margin:10px 0 0"><b>${k}</b><br>${pts}</div>`);
  }
  qs("#localHist").innerHTML = lines.join("");
}

function initMap(){
  map = L.map("map", { zoomControl:true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:19,
    attribution:'&copy; OpenStreetMap'
  }).addTo(map);

  driverMarker = L.marker([42.698,2.895], { icon: driverIcon }).addTo(map);
  map.setView([42.698,2.895], 12);

  qs("#btnCenter").addEventListener("click", ()=>{
    const ll = driverMarker.getLatLng();
    map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 15));
  });
}

async function startGps(){
  if(watchingId!=null) return;
  if(!navigator.geolocation){ alert("Géolocalisation non supportée."); return; }

  watchingId = navigator.geolocation.watchPosition(async (pos)=>{
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy;
    const speed = pos.coords.speed;
    const heading = pos.coords.heading;
    const battery = null;

    driverMarker.setLatLng([lat,lng]);

    try{
      await api("/driver/update", { method:"POST", body:{
        driver_token: getToken(),
        lat, lng, acc,
        speed, heading, battery,
        ts: Date.now()
      }});
    }catch(_){}
  }, (err)=>{
    console.log(err);
  }, { enableHighAccuracy:true, maximumAge:0, timeout:12000 });

  qs("#trkTitle").textContent = "Tracking actif";
  setStatusPill(qs("#trkPill"), "active");
}

function stopGps(){
  if(watchingId!=null){
    navigator.geolocation.clearWatch(watchingId);
    watchingId = null;
  }
  qs("#trkTitle").textContent = "Inactif";
  setStatusPill(qs("#trkPill"), "expired");
}

function durVal(){ return Number(qs("#dur").value || DEFAULT_ACTIVE_MINUTES); }

async function decision(session, decision, minutes=null){
  const body = { driver_token:getToken(), session, decision };
  if(minutes!=null) body.minutes = minutes;
  return api("/driver/decision", { method:"POST", body });
}

function markerKey(sess){ return sess.client_name || sess.client_id || (sess.session||"").slice(0,8); }

function setMarker(sessionObj, mode){
  const session = sessionObj.session;
  const lat = sessionObj.client_lat;
  const lng = sessionObj.client_lng;
  if(!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  let m = clientMarkers.get(session);
  if(!m){
    m = L.marker([lat,lng], { icon: clientIcon }).addTo(map);
    clientMarkers.set(session, m);
  }else{
    m.setLatLng([lat,lng]);
  }

  const label = sessionObj.client_name || (sessionObj.client_id ? sessionObj.client_id.slice(0,8) : "Client");
  const status = sessionObj.status;

  const menu = `
    <div style="min-width:240px">
      <div style="font-weight:900;margin-bottom:6px">${label} <span style="opacity:.75">(${status})</span></div>
      <div style="font-size:12px;opacity:.8;margin-bottom:10px">Session: ${session.slice(0,8)}… • Expire: ${sessionObj.expires_ts ? fmtTime(sessionObj.expires_ts) : "—"}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${status==="pending" ? `
          <button data-act="accept" style="padding:10px 12px;border-radius:12px;border:0;font-weight:800;cursor:pointer;background:#16a34a;color:#fff">Accepter</button>
          <button data-act="deny" style="padding:10px 12px;border-radius:12px;border:0;font-weight:800;cursor:pointer;background:#ef4444;color:#fff">Refuser</button>
        ` : `
          <button data-act="plus5" style="padding:10px 12px;border-radius:12px;border:0;font-weight:800;cursor:pointer;background:#3b82f6;color:#fff">+5 min</button>
          <button data-act="minus5" style="padding:10px 12px;border-radius:12px;border:0;font-weight:800;cursor:pointer;background:#f59e0b;color:#0b1c2d">-5 min</button>
          <button data-act="stop" style="padding:10px 12px;border-radius:12px;border:0;font-weight:800;cursor:pointer;background:#ef4444;color:#fff">Stop</button>
        `}
      </div>
    </div>
  `;

  m.bindPopup(menu);

  m.on("popupopen", (e)=>{
    const root = e.popup.getElement();
    if(!root) return;
    root.querySelectorAll("button[data-act]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const act = btn.getAttribute("data-act");
        btn.disabled = true;
        try{
          if(act==="accept"){
            await decision(session, "accept", durVal());
          }else if(act==="deny"){
            await decision(session, "deny");
          }else if(act==="stop"){
            await decision(session, "stop");
          }else if(act==="plus5"){
            const mins = clamp(durVal()+5, 5, MAX_ACTIVE_MINUTES);
            qs("#dur").value = String(mins);
            qs("#durVal").textContent = String(mins);
            await decision(session, "accept", mins);
          }else if(act==="minus5"){
            const mins = clamp(durVal()-5, 5, MAX_ACTIVE_MINUTES);
            qs("#dur").value = String(mins);
            qs("#durVal").textContent = String(mins);
            await decision(session, "accept", mins);
          }
        }catch(err){
          alert(err?.data?.error || err.message);
        }finally{
          m.closePopup();
        }
      });
    });
  });

  // historisation locale (pour debug)
  pushHist(label, lat, lng);
}

function cleanupMarkers(validSessions){
  const keep = new Set(validSessions.map(s=>s.session));
  for(const [sess, marker] of clientMarkers.entries()){
    if(!keep.has(sess)){
      map.removeLayer(marker);
      clientMarkers.delete(sess);
    }
  }
}

function renderRequests(pending, active){
  const box = qs("#reqList");

  if(!pending.length && !active.length){
    box.textContent = "Aucune demande.";
    return;
  }

  const lines = [];
  if(pending.length){
    lines.push("<b>En attente</b>");
    for(const s of pending){
      const name = s.client_name || (s.client_id ? s.client_id.slice(0,8) : "Client");
      lines.push(`• ${name} — expire: ${fmtTime(s.expires_ts)}`);
    }
    lines.push("<br>");
  }
  if(active.length){
    lines.push("<b>Actifs</b>");
    for(const s of active){
      const name = s.client_name || (s.client_id ? s.client_id.slice(0,8) : "Client");
      lines.push(`• ${name} — fin: ${fmtTime(s.expires_ts)}`);
    }
  }
  box.innerHTML = lines.join("<br>");
}

async function refresh(){
  const dash = await api("/driver/dashboard?driver_token=" + encodeURIComponent(getToken()));
  const now = dash.now || Date.now();
  qs("#mapInfo").textContent = "Maj: " + fmtTime(now) + " • ID: " + getToken().slice(0,8) + "…";

  const pending = (dash.pending || []).map(s=>({...s, status:"pending"}));
  const active = (dash.active || []).map(s=>({...s, status:"active"}));

  const all = [...pending, ...active];

  // markers
  all.forEach(s=>setMarker(s));
  cleanupMarkers(all);

  renderRequests(pending, active);
  renderHist();
}

function setup(){
  initMap();
  qs("#btnBack").addEventListener("click", ()=>history.back());
  qs("#btnStart").addEventListener("click", ()=>startGps());
  qs("#btnStop").addEventListener("click", ()=>stopGps());

  qs("#dur").addEventListener("input", (e)=>{
    qs("#durVal").textContent = String(e.target.value);
  });
  qs("#dur").value = String(DEFAULT_ACTIVE_MINUTES);
  qs("#durVal").textContent = String(DEFAULT_ACTIVE_MINUTES);

  // SW
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./worker.js").catch(()=>{});
  }

  (async ()=>{
    while(true){
      try{ await refresh(); }catch(e){ console.log(e); }
      await sleep(2000);
    }
  })();
}
setup();

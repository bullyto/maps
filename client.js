import { API_BASE, DEFAULT_ACTIVE_MINUTES } from "./config.js";
import { api, qs, setStatusPill, fmtTime, sleep } from "./shared.js";

let map, meMarker, driverMarker;
let lastCenter = null;

const LS_SESSION = "and_suivi_session";
const LS_CLIENT_ID = "and_suivi_client_id";
const LS_CLIENT_NAME = "and_suivi_client_name";

function getOrCreateId(){
  let id = localStorage.getItem(LS_CLIENT_ID);
  if(!id){
    id = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(16)+Math.random().toString(16).slice(2));
    localStorage.setItem(LS_CLIENT_ID, id);
  }
  return id;
}

function getName(){
  return (localStorage.getItem(LS_CLIENT_NAME) || "").trim();
}

function setName(v){
  localStorage.setItem(LS_CLIENT_NAME, (v||"").trim());
}

function setSession(s){
  if(s) localStorage.setItem(LS_SESSION, s);
  else localStorage.removeItem(LS_SESSION);
}
function getSession(){ return (localStorage.getItem(LS_SESSION) || "").trim(); }

function initMap(){
  map = L.map("map", { zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  const clientIcon = L.icon({ iconUrl: "./icons/marker-client.svg", iconSize:[44,44], iconAnchor:[22,38] });
  const driverIcon = L.icon({ iconUrl: "./icons/marker-driver.svg", iconSize:[44,44], iconAnchor:[22,38] });

  meMarker = L.marker([42.698, 2.895], { icon: clientIcon }).addTo(map);
  driverMarker = L.marker([42.698, 2.895], { icon: driverIcon, opacity:0 }).addTo(map);

  map.setView([42.698, 2.895], 12);

  qs("#btnCenter").addEventListener("click", ()=>{
    if(lastCenter) map.setView(lastCenter, Math.max(map.getZoom(), 15));
  });
}

async function askGeoloc(){
  return new Promise((resolve, reject)=>{
    if(!navigator.geolocation) return reject(new Error("geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      pos=>resolve(pos),
      err=>reject(err),
      { enableHighAccuracy:true, timeout:12000, maximumAge:0 }
    );
  });
}

async function sendRequest(){
  const btn = qs("#btnRequest");
  btn.disabled = true;

  const name = qs("#clientName").value.trim();
  if(name.length < 2){
    btn.disabled = false;
    alert("Entre un nom (2 caractères minimum).");
    return;
  }
  setName(name);

  // Si on a déjà une session en cours, on ne spam pas : on reprend la session.
  const existing = getSession();
  if(existing){
    await refreshState(); // met à jour l'UI
    return;
  }

  let pos;
  try{
    pos = await askGeoloc();
  }catch(e){
    btn.disabled = false;
    alert("Tu dois accepter la géolocalisation. Sinon, pas de suivi (sécurité + précision).");
    return;
  }

  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const acc = pos.coords.accuracy;

  const client_id = getOrCreateId();

  const r = await api("/client/request", {
    method:"POST",
    body:{ client_id, client_name:name, lat, lng, acc, ts: Date.now() }
  });

  if(r?.session){
    setSession(r.session);
  }

  await refreshState();
}

async function pingClient(){
  const session = getSession();
  if(!session) return;

  try{
    const pos = await askGeoloc();
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy;

    await api("/client/ping", { method:"POST", body:{
      session,
      client_id: getOrCreateId(),
      client_name: getName() || null,
      lat, lng, acc,
      ts: Date.now()
    }});
    meMarker.setLatLng([lat, lng]);
    lastCenter = [lat, lng];
  }catch(_){
    // pas bloquant (si user a coupé GPS)
  }
}

function uiSet(status){
  const title = qs("#statusTitle");
  const pill = qs("#statusPill");
  setStatusPill(pill, status);

  if(status==="pending"){
    title.textContent = "En attente d'acceptation…";
  }else if(status==="active"){
    title.textContent = "Suivi actif";
  }else if(status==="denied"){
    title.textContent = "Refusé";
  }else if(status==="expired"){
    title.textContent = "Accès terminé";
  }else{
    title.textContent = "Prêt";
  }
}

async function refreshState(){
  const btn = qs("#btnRequest");
  const session = getSession();
  const info = qs("#footerInfo");

  // Saisie nom persistée
  const savedName = getName();
  if(savedName && !qs("#clientName").value) qs("#clientName").value = savedName;

  if(!session){
    uiSet("expired");
    btn.disabled = false;
    btn.textContent = "Suivre ma commande";
    driverMarker.setOpacity(0);
    info.textContent = "—";
    return;
  }

  let s;
  try{
    s = await api("/client/state?session=" + encodeURIComponent(session));
  }catch(e){
    // session invalide -> reset
    setSession(null);
    uiSet("expired");
    btn.disabled = false;
    btn.textContent = "Suivre ma commande";
    return;
  }

  const status = s.status || "expired";
  uiSet(status);

  // Anti-spam: bouton bloqué si pending ou active
  if(status==="pending"){
    btn.disabled = true;
    btn.textContent = "Demande envoyée";
  }else if(status==="active"){
    btn.disabled = true;
    btn.textContent = "Suivi en cours";
  }else{
    // terminé/denied -> on libère + reset session
    btn.disabled = false;
    btn.textContent = "Suivre ma commande";
    setSession(null);
  }

  if(s.driver && status==="active"){
    driverMarker.setLatLng([s.driver.lat, s.driver.lng]).setOpacity(1);
    info.textContent = "Dernière position livreur : " + fmtTime(s.driver.ts);
  }else{
    driverMarker.setOpacity(0);
    info.textContent = status==="pending" ? "En attente de réponse du livreur." : "—";
  }
}

async function loop(){
  while(true){
    await refreshState();
    await pingClient(); // keep alive + maj position client côté livreur
    await sleep(2000);
  }
}

function setup(){
  initMap();
  qs("#btnBack").addEventListener("click", ()=>history.back());
  qs("#btnRequest").addEventListener("click", ()=>sendRequest());
  qs("#clientName").addEventListener("change", (e)=>setName(e.target.value));

  // PWA SW (optionnel)
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./worker.js").catch(()=>{});
  }

  loop();
}

setup();

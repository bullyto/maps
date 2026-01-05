import { API_BASE } from "./config.js";

export function qs(sel, root=document){ return root.querySelector(sel); }
export function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

export function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

export function fmtTime(ts){
  if(!ts) return "—";
  const d = new Date(Number(ts));
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"});
}

export function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

export async function api(path, {method="GET", body=null}={}){
  const init = { method, headers: {} };
  if(body){
    init.headers["Content-Type"]="application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + path, init);
  const txt = await res.text();
  let data = {};
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if(!res.ok){
    const err = new Error(data?.error || ("HTTP " + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function setStatusPill(el, status){
  el.dataset.status = status;
  el.textContent =
    status==="pending" ? "En attente" :
    status==="active"  ? "Actif" :
    status==="denied"  ? "Refusé" :
    status==="expired" ? "Terminé" : status;
}

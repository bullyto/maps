// Apéro de Nuit • Suivi — utils
export const VERSION = "2.0.0";

export function qs() {
  return new URLSearchParams(location.search);
}

export function fmtAgo(ts) {
  if(!ts) return "—";
  const ms = Date.now() - ts;
  if(ms < 2000) return "à l'instant";
  const s = Math.round(ms/1000);
  if(s < 60) return s + "s";
  const m = Math.round(s/60);
  if(m < 60) return m + "min";
  const h = Math.round(m/60);
  return h + "h";
}

export function safeJsonParse(txt) {
  try{ return JSON.parse(txt); }catch(e){ return null; }
}

export async function apiFetchJson(url, opts={}) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  const data = safeJsonParse(txt);
  if(!r.ok) {
    const msg = data?.error || txt || ("HTTP " + r.status);
    const err = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data ?? {};
}

export function setText(el, txt) {
  if(el) el.textContent = txt;
}

export function shortToken(t) {
  if(!t) return "—";
  if(t.length <= 12) return t;
  return t.slice(0,8) + "…" + t.slice(-4);
}

export function getOrCreateClientId() {
  const k = "adn_client_id_v1";
  let id = localStorage.getItem(k);
  if(!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
    localStorage.setItem(k, id);
  }
  return id;
}

export function getOrCreateDriverToken() {
  const k = "adn_driver_token_v1";
  let tok = localStorage.getItem(k);
  if(!tok) {
    tok = crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
    localStorage.setItem(k, tok);
  }
  return tok;
}

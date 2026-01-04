// Cloudflare Worker — Apéro de Nuit • Suivi (1 livreur, multi-clients)
// Bindings: D1 database name = DB
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") return new Response("", { status: 204, headers: corsHeaders(request) });
    if (!env.DB) return json({ ok:false, error:"Missing D1 binding DB (env.DB)" }, request, 500);

    await ensureSchema(env.DB);

    if (path === "/" && method === "GET") return json({ ok:true, service:"adn-suivi", ts: Date.now() }, request);
    if (path === "/ping" && method === "GET") return json({ ok:true, pong:true, ts: Date.now() }, request);

    if (path === "/driver/update" && method === "POST") {
      const body = await safeJson(request);
      const driver_token = str(body?.driver_token);
      const lat = num(body?.lat);
      const lng = num(body?.lng);
      const ts = num(body?.ts) || Date.now();
      if (!driver_token) return json({ ok:false, error:"Missing driver_token" }, request, 400);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ ok:false, error:"Invalid lat/lng" }, request, 400);

      await env.DB.prepare(`
        INSERT INTO driver_points (driver_token, lat, lng, acc, speed, heading, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(driver_token, lat, lng, numOrNull(body?.acc), numOrNull(body?.speed), numOrNull(body?.heading), ts).run();

      // arrival detection (<=500m) for active sessions
      const sessions = await env.DB.prepare(`
        SELECT session, home_lat, home_lng, arrival_sent
        FROM sessions
        WHERE driver_token = ?
          AND status = 'active'
          AND expires_at > ?
      `).bind(driver_token, Date.now()).all();

      for (const s of (sessions.results || [])) {
        if (s.arrival_sent) continue;
        const d = haversineMeters(lat, lng, Number(s.home_lat), Number(s.home_lng));
        if (d <= 500) {
          await env.DB.prepare(`UPDATE sessions SET arrival_sent = 1 WHERE session = ?`).bind(s.session).run();
        }
      }

      return json({ ok:true }, request);
    }

    if (path === "/driver/dashboard" && method === "GET") {
      const driver_token = url.searchParams.get("driver_token") || "";
      if (!driver_token) return json({ ok:false, error:"Missing driver_token" }, request, 400);

      const driver = await env.DB.prepare(`
        SELECT lat, lng, ts
        FROM driver_points
        WHERE driver_token = ?
        ORDER BY ts DESC
        LIMIT 1
      `).bind(driver_token).first();

      const now = Date.now();
      await env.DB.prepare(`UPDATE sessions SET status='expired' WHERE status='active' AND expires_at <= ?`).bind(now).run();

      const sess = await env.DB.prepare(`
        SELECT session, status, expires_at, client_lat, client_lng, client_ts, address, home_lat, home_lng
        FROM sessions
        WHERE driver_token = ?
        ORDER BY client_ts DESC
        LIMIT 60
      `).bind(driver_token).all();

      const sessions = (sess.results || []).map(r => {
        const out = { ...r };
        if (driver?.lat != null && driver?.lng != null && r.client_lat != null && r.client_lng != null) {
          out.distance_m = Math.round(haversineMeters(Number(driver.lat), Number(driver.lng), Number(r.client_lat), Number(r.client_lng)));
        } else out.distance_m = null;
        return out;
      });

      return json({ ok:true, driver: driver || null, sessions }, request);
    }

    if (path === "/driver/decision" && method === "POST") {
      const body = await safeJson(request);
      const driver_token = str(body?.driver_token);
      const session = str(body?.session);
      const decision = str(body?.decision);
      const minutes = clampInt(body?.minutes, 1, 25) || 25;

      if (!driver_token) return json({ ok:false, error:"Missing driver_token" }, request, 400);
      if (!session) return json({ ok:false, error:"Missing session" }, request, 400);
      if (!["accept","deny","stop"].includes(decision)) return json({ ok:false, error:"Invalid decision" }, request, 400);

      const s = await env.DB.prepare(`SELECT session FROM sessions WHERE session = ? AND driver_token = ?`).bind(session, driver_token).first();
      if (!s) return json({ ok:false, error:"Session not found for this driver" }, request, 404);

      if (decision === "accept") {
        const expires_at = Date.now() + minutes * 60_000;
        await env.DB.prepare(`UPDATE sessions SET status='active', expires_at=?, arrival_sent=0 WHERE session=?`).bind(expires_at, session).run();
        return json({ ok:true, status:"active", expires_at }, request);
      }
      if (decision === "deny") {
        await env.DB.prepare(`UPDATE sessions SET status='denied' WHERE session=?`).bind(session).run();
        return json({ ok:true, status:"denied" }, request);
      }
      if (decision === "stop") {
        await env.DB.prepare(`UPDATE sessions SET status='expired', expires_at=? WHERE session=?`).bind(Date.now(), session).run();
        return json({ ok:true, status:"expired" }, request);
      }
    }

    if (path === "/driver/address" && method === "POST") {
      const body = await safeJson(request);
      const driver_token = str(body?.driver_token);
      const session = str(body?.session);
      const address = str(body?.address);
      if (!driver_token || !session || !address) return json({ ok:false, error:"Missing fields" }, request, 400);
      await env.DB.prepare(`UPDATE sessions SET address=? WHERE session=? AND driver_token=?`).bind(address, session, driver_token).run();
      return json({ ok:true }, request);
    }

    if (path === "/client/request" && method === "POST") {
      const body = await safeJson(request);
      const client_id = str(body?.client_id);
      const lat = num(body?.lat);
      const lng = num(body?.lng);
      const home_lat = num(body?.home_lat);
      const home_lng = num(body?.home_lng);
      const ts = num(body?.ts) || Date.now();

      if (!client_id) return json({ ok:false, error:"Missing client_id" }, request, 400);
      if (![lat,lng,home_lat,home_lng].every(Number.isFinite)) return json({ ok:false, error:"Invalid lat/lng" }, request, 400);

      // Link sessions to the most recently seen driver_token (driver must have started tracking once)
      const lastDriver = await env.DB.prepare(`SELECT driver_token FROM driver_points ORDER BY ts DESC LIMIT 1`).first();
      const driver_token = lastDriver?.driver_token || "default_driver";

      const session = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO sessions (
          session, driver_token, client_id,
          status, expires_at,
          client_lat, client_lng, client_ts,
          home_lat, home_lng,
          address, arrival_sent
        ) VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, NULL, 0)
      `).bind(session, driver_token, client_id, lat, lng, ts, home_lat, home_lng).run();

      return json({ ok:true, session, status:"pending" }, request);
    }

    if (path === "/client/ping" && method === "POST") {
      const body = await safeJson(request);
      const session = str(body?.session);
      const client_id = str(body?.client_id);
      const lat = num(body?.lat);
      const lng = num(body?.lng);
      const ts = num(body?.ts) || Date.now();
      if (!session || !client_id) return json({ ok:false, error:"Missing session/client_id" }, request, 400);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ ok:false, error:"Invalid lat/lng" }, request, 400);

      await env.DB.prepare(`UPDATE sessions SET client_lat=?, client_lng=?, client_ts=? WHERE session=? AND client_id=?`)
        .bind(lat, lng, ts, session, client_id).run();

      return json({ ok:true }, request);
    }

    if (path === "/client/state" && method === "GET") {
      const session = url.searchParams.get("session") || "";
      if (!session) return json({ ok:false, error:"Missing session" }, request, 400);

      let s = await env.DB.prepare(`SELECT session, driver_token, status, expires_at, arrival_sent FROM sessions WHERE session=? LIMIT 1`)
        .bind(session).first();
      if (!s) return json({ ok:false, error:"Session not found" }, request, 404);

      if (s.status === "active" && Number(s.expires_at) && Number(s.expires_at) <= Date.now()) {
        await env.DB.prepare(`UPDATE sessions SET status='expired' WHERE session=?`).bind(session).run();
        s = { ...s, status: "expired" };
      }

      const driver = await env.DB.prepare(`SELECT lat, lng, ts FROM driver_points WHERE driver_token=? ORDER BY ts DESC LIMIT 1`)
        .bind(s.driver_token).first();

      return json({ ok:true, status: s.status, expires_at: s.expires_at ? Number(s.expires_at) : null, driver: driver || null, arrival: !!s.arrival_sent }, request);
    }

    return json({ ok:false, error:"Not found" }, request, 404);
  }
};

function corsHeaders(request) {
  const origin = request.headers?.get?.("Origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
function json(obj, request, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(request) }
  });
}
async function safeJson(request) { try { return await request.json(); } catch { return null; } }
function str(v){ return (v==null) ? "" : String(v).trim(); }
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : NaN; }
function numOrNull(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function clampInt(v,a,b){ const n=parseInt(v,10); if(!Number.isFinite(n)) return null; return Math.max(a, Math.min(b,n)); }

async function ensureSchema(DB){
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS driver_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_token TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      acc REAL,
      speed REAL,
      heading REAL,
      ts INTEGER NOT NULL
    )
  `).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_driver_points_token_ts ON driver_points(driver_token, ts)`).run();

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      session TEXT PRIMARY KEY,
      driver_token TEXT NOT NULL,
      client_id TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER,
      client_lat REAL,
      client_lng REAL,
      client_ts INTEGER,
      home_lat REAL,
      home_lng REAL,
      address TEXT,
      arrival_sent INTEGER DEFAULT 0
    )
  `).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_driver_status ON sessions(driver_token, status)`).run();
  await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_client_ts ON sessions(client_ts)`).run();
}

function haversineMeters(aLat,aLng,bLat,bLng){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(bLat-aLat), dLng=toRad(bLng-aLng);
  const s1=Math.sin(dLat/2), s2=Math.sin(dLng/2);
  const q=s1*s1 + Math.cos(toRad(aLat))*Math.cos(toRad(bLat))*s2*s2;
  return 2*R*Math.asin(Math.sqrt(q));
}

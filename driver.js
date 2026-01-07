/* AND-Suivi — Driver (Livreur)
   - GPS live + dashboard
   - Push notifications via OneSignal (Web SDK v16)
*/

(() => {
  'use strict';

  // ====== CONFIG ======
  // Ces variables viennent de config.js (si présent)
  const WORKER_BASE = (window.AND_SUIVI_WORKER_BASE || '').trim(); // ex: "https://and-suivi.apero-nuit-du-66.workers.dev"
  const DRIVER_TOKEN = (new URLSearchParams(location.search).get('driver_token') || '').trim();

  // OneSignal (si défini dans config.js)
  const ONESIGNAL_APP_ID = (window.ONESIGNAL_APP_ID || '').trim();
  const PUSH_REGISTER_ENDPOINT = (window.PUSH_REGISTER_ENDPOINT || '').trim(); // ex: `${WORKER_BASE}/push/register`

  // Service worker paths (scope /maps/)
  const OS_SW_PATH = '/maps/sw.js';
  const OS_SW_UPDATER_PATH = '/maps/OneSignalSDKUpdaterWorker.js';
  const OS_SW_SCOPE = '/maps/';

  // ====== UI ======
  const elGpsState = document.getElementById('gpsState');
  const elLastUpdate = document.getElementById('lastUpdate');
  const elRequestsCount = document.getElementById('requestsCount');
  const elPendingList = document.getElementById('pendingList');
  const elActiveList = document.getElementById('activeList');

  const btnGpsStart = document.getElementById('btnGpsStart');
  const btnGpsStop = document.getElementById('btnGpsStop');
  const btnCenter = document.getElementById('btnCenter');

  const elDriverOnlineText = document.getElementById('driverOnlineText');
  const elDriverOnlineBadge = document.getElementById('driverOnlineBadge');

  // Push UI
  const btnPushEnable = document.getElementById('btnPushEnable');
  const elPushState = document.getElementById('pushState');

  // ====== STATE ======
  let map, marker;
  let gpsWatchId = null;
  let lastPos = null;

  let pollTimer = null;
  let pushInitDone = false;

  // ====== HELPERS ======
  function fmtTime(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '—';
    }
  }

  function setOnlineBadge(isOnline) {
    if (!elDriverOnlineBadge) return;
    if (isOnline) {
      elDriverOnlineBadge.classList.add('online');
      elDriverOnlineText.textContent = 'Livreur en ligne';
    } else {
      elDriverOnlineBadge.classList.remove('online');
      elDriverOnlineText.textContent = 'Livreur hors ligne';
    }
  }

  function safeText(el, txt) {
    if (!el) return;
    el.textContent = txt;
  }

  async function api(path, opts = {}) {
    if (!WORKER_BASE) throw new Error('WORKER_BASE manquant (config.js)');
    const url = `${WORKER_BASE}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText} — ${t}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  // ====== MAP ======
  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([42.6976, 2.8954], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    marker = L.marker([42.6976, 2.8954]).addTo(map);
  }

  function centerOnLast() {
    if (!map || !lastPos) return;
    map.setView([lastPos.lat, lastPos.lng], Math.max(map.getZoom(), 15));
  }

  // ====== GPS ======
  function setGpsUI(active) {
    if (btnGpsStart) btnGpsStart.disabled = !!active;
    if (btnGpsStop) btnGpsStop.disabled = !active;
    safeText(elGpsState, active ? 'Actif' : 'Inactif');
    setOnlineBadge(active);
  }

  function startGps() {
    if (!navigator.geolocation) {
      alert("GPS non disponible sur cet appareil.");
      return;
    }

    if (gpsWatchId != null) return;

    setGpsUI(true);

    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        lastPos = { lat: latitude, lng: longitude, accuracy, ts: Date.now() };

        if (marker) marker.setLatLng([latitude, longitude]);
        if (map) map.panTo([latitude, longitude], { animate: true });

        safeText(elLastUpdate, fmtTime(lastPos.ts));

        // Envoi vers le worker (driver position)
        sendDriverPosition(lastPos).catch((e) => {
          console.warn('sendDriverPosition error', e);
        });
      },
      (err) => {
        console.warn('GPS error', err);
        setGpsUI(false);
        stopGps();
        alert("GPS refusé ou indisponible. Autorise la localisation et réessaie.");
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000,
      }
    );
  }

  function stopGps() {
    if (gpsWatchId != null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }
    setGpsUI(false);
  }

  async function sendDriverPosition(p) {
    if (!DRIVER_TOKEN) return; // si pas de token on n'envoie pas
    await api(`/driver/position?driver_token=${encodeURIComponent(DRIVER_TOKEN)}`, {
      method: 'POST',
      body: JSON.stringify({
        lat: p.lat,
        lng: p.lng,
        accuracy: p.accuracy,
        ts: p.ts,
      }),
    });
  }

  // ====== DASHBOARD POLL ======
  async function pollDashboard() {
    if (!DRIVER_TOKEN) return;

    const data = await api(`/driver/dashboard?driver_token=${encodeURIComponent(DRIVER_TOKEN)}`, {
      method: 'GET',
    });

    // Ex: { pending:[], active:[], counts:{pending:2,active:0}, driver:{gpsActive:true,...} }
    const pending = Array.isArray(data.pending) ? data.pending : [];
    const active = Array.isArray(data.active) ? data.active : [];

    safeText(elRequestsCount, String(pending.length));
    renderRequests(pending, active);
  }

  function renderRequests(pending, active) {
    if (elPendingList) elPendingList.innerHTML = '';
    if (elActiveList) elActiveList.innerHTML = '';

    const makeCard = (item, isPending) => {
      const div = document.createElement('div');
      div.className = 'reqCard';

      const title = document.createElement('div');
      title.className = 'reqTitle';
      title.textContent = item.name || 'Demande';

      const meta = document.createElement('div');
      meta.className = 'reqMeta';
      meta.textContent = isPending ? 'Demande • expire bientôt' : 'Suivi actif';

      const btns = document.createElement('div');
      btns.className = 'reqBtns';

      if (isPending) {
        const bAccept = document.createElement('button');
        bAccept.className = 'btnOk';
        bAccept.textContent = 'Accepter';
        bAccept.onclick = () => driverDecision(item.id, 'accept');

        const bRefuse = document.createElement('button');
        bRefuse.className = 'btnNo';
        bRefuse.textContent = 'Refuser';
        bRefuse.onclick = () => driverDecision(item.id, 'refuse');

        const bPlus = document.createElement('button');
        bPlus.className = 'btnSmall';
        bPlus.textContent = '+5';
        bPlus.onclick = () => driverDecision(item.id, 'plus5');

        const bMinus = document.createElement('button');
        bMinus.className = 'btnSmall';
        bMinus.textContent = '-5';
        bMinus.onclick = () => driverDecision(item.id, 'minus5');

        const bStop = document.createElement('button');
        bStop.className = 'btnStop';
        bStop.textContent = 'Stop';
        bStop.onclick = () => driverDecision(item.id, 'stop');

        btns.append(bAccept, bRefuse, bPlus, bMinus, bStop);
      } else {
        const bStop = document.createElement('button');
        bStop.className = 'btnStop';
        bStop.textContent = 'Stop';
        bStop.onclick = () => driverDecision(item.id, 'stop');
        btns.append(bStop);
      }

      div.append(title, meta, btns);
      return div;
    };

    if (pending.length === 0 && elPendingList) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Aucune demande en attente.';
      elPendingList.appendChild(empty);
    } else if (elPendingList) {
      pending.forEach((it) => elPendingList.appendChild(makeCard(it, true)));
    }

    if (active.length === 0 && elActiveList) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Aucun suivi actif.';
      elActiveList.appendChild(empty);
    } else if (elActiveList) {
      active.forEach((it) => elActiveList.appendChild(makeCard(it, false)));
    }
  }

  async function driverDecision(requestId, action) {
    if (!DRIVER_TOKEN) return;
    await api(`/driver/decision?driver_token=${encodeURIComponent(DRIVER_TOKEN)}`, {
      method: 'POST',
      body: JSON.stringify({ id: requestId, action }),
    });
    await pollDashboard();
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      pollDashboard().catch((e) => console.warn('pollDashboard error', e));
    }, 3000);

    pollDashboard().catch((e) => console.warn('pollDashboard error', e));
  }

  // ====== PUSH (OneSignal) ======
  function ensureOneSignalLoaded() {
    return new Promise((resolve, reject) => {
      if (!ONESIGNAL_APP_ID) {
        reject(new Error('ONESIGNAL_APP_ID manquant (config.js)'));
        return;
      }
      if (window.OneSignal) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Impossible de charger OneSignalSDK.page.js'));
      document.head.appendChild(s);
    });
  }

  async function initOneSignal() {
    if (pushInitDone) return;
    pushInitDone = true;

    await ensureOneSignalLoaded();

    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async function (OneSignal) {
      await OneSignal.init({
        appId: ONESIGNAL_APP_ID,
        allowLocalhostAsSecureOrigin: true,

        // Important: on utilise TON SW /maps/sw.js (qui importScripts OneSignal + gère cache)
        serviceWorkerParam: { scope: OS_SW_SCOPE },
        serviceWorkerPath: OS_SW_PATH,
        serviceWorkerUpdaterPath: OS_SW_UPDATER_PATH,
      });

      // Mise à jour UI état
      await refreshPushState();

      // Si déjà abonné, on envoie l'id au worker
      await tryRegisterPushWithWorker();
    });
  }

  async function refreshPushState() {
    try {
      if (!window.OneSignal) {
        safeText(elPushState, '—');
        return;
      }

      const perm = await window.OneSignal.Notifications.permission;
      const supported = await window.OneSignal.Notifications.isPushSupported();

      if (!supported) {
        safeText(elPushState, 'Non supporté');
        return;
      }

      if (perm === 'granted') {
        const sid = await window.OneSignal.User.PushSubscription.id;
        safeText(elPushState, sid ? 'Activées' : 'Activées (ID en cours)');
      } else if (perm === 'denied') {
        safeText(elPushState, 'Refusées');
      } else {
        safeText(elPushState, 'À activer');
      }
    } catch (e) {
      console.warn('refreshPushState error', e);
      safeText(elPushState, '—');
    }
  }

  async function requestPushPermission() {
    await initOneSignal();

    window.OneSignalDeferred.push(async function (OneSignal) {
      try {
        const supported = await OneSignal.Notifications.isPushSupported();
        if (!supported) {
          alert("Les notifications push ne sont pas supportées sur ce téléphone / navigateur.");
          await refreshPushState();
          return;
        }

        await OneSignal.Notifications.requestPermission();

        // Si OK, tenter l'opt-in
        try {
          await OneSignal.User.PushSubscription.optIn();
        } catch (_) {}

        await refreshPushState();
        await tryRegisterPushWithWorker();

        alert("✅ Notifications activées !");
      } catch (e) {
        console.warn('requestPushPermission error', e);
        await refreshPushState();
        alert("Impossible d'activer les notifications. Vérifie les autorisations et réessaie.");
      }
    });
  }

  async function tryRegisterPushWithWorker() {
    if (!PUSH_REGISTER_ENDPOINT) return;
    if (!window.OneSignal) return;

    try {
      const perm = await window.OneSignal.Notifications.permission;
      if (perm !== 'granted') return;

      const sid = await window.OneSignal.User.PushSubscription.id;
      if (!sid) return;

      // Enregistrer l'abonnement côté Worker (lié au driver_token)
      await fetch(PUSH_REGISTER_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          driver_token: DRIVER_TOKEN || null,
          subscription_id: sid,
          user_agent: navigator.userAgent,
          ts: Date.now(),
        }),
      });
    } catch (e) {
      console.warn('tryRegisterPushWithWorker error', e);
    }
  }

  function initPushUI() {
    if (btnPushEnable) {
      btnPushEnable.addEventListener('click', () => {
        requestPushPermission().catch((e) => console.warn(e));
      });
    }

    // Rafraîchir l'état push périodiquement
    setInterval(() => {
      refreshPushState().catch(() => {});
    }, 5000);
  }

  // ====== START ======
  function boot() {
    initMap();

    // UI init
    setGpsUI(false);
    safeText(elRequestsCount, '0');
    safeText(elLastUpdate, '—');
    setOnlineBadge(false);

    // Bind buttons
    if (btnGpsStart) btnGpsStart.addEventListener('click', startGps);
    if (btnGpsStop) btnGpsStop.addEventListener('click', stopGps);
    if (btnCenter) btnCenter.addEventListener('click', centerOnLast);

    // Poll dashboard
    startPolling();

    // Push
    initPushUI();
    initOneSignal().catch((e) => console.warn('OneSignal init error', e));
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

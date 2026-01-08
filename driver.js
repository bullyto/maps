// /maps/driver.js
(() => {
  const cfg = (window.DRIVER_CFG || {});
  const APP_ID = cfg.ONESIGNAL_APP_ID;
  const API_BASE = cfg.API_BASE || "";
  const SCOPE = cfg.SCOPE || "/maps/";

  const $ = (id) => document.getElementById(id);

  const swDot = $("swDot");
  const swInfo = $("swInfo");
  const notifState = $("notifState");
  const btnNotif = $("btnNotif");
  const btnTest = $("btnTest");
  const btnReset = $("btnReset");

  function setDot(state) {
    swDot.classList.remove("ok", "warn", "bad");
    if (state === "ok") swDot.classList.add("ok");
    else if (state === "warn") swDot.classList.add("warn");
    else swDot.classList.add("bad");
  }

  async function registerSW() {
    if (!("serviceWorker" in navigator)) {
      swInfo.textContent = "SW: non supporté";
      setDot("bad");
      return null;
    }

    try {
      const reg = await navigator.serviceWorker.register("/maps/sw.js", { scope: SCOPE });
      swInfo.textContent = "SW: OK (" + (reg.active ? "active" : "pending") + ")";
      setDot("ok");
      return reg;
    } catch (e) {
      swInfo.textContent = "SW: erreur (" + (e?.message || e) + ")";
      setDot("bad");
      return null;
    }
  }

  async function initOneSignal() {
    if (!APP_ID) {
      notifState.textContent = "Notif: APP_ID manquant (config.js)";
      return false;
    }

    // OneSignal v16: on utilise window.OneSignal en tableau
    window.OneSignal = window.OneSignal || [];
    OneSignal.push(async () => {
      try {
        await OneSignal.init({
          appId: APP_ID,
          // IMPORTANT: on force OneSignal à utiliser TON sw.js
          serviceWorkerPath: "/maps/sw.js",
          serviceWorkerUpdaterPath: "/maps/sw.js",
          serviceWorkerParam: { scope: SCOPE },
          allowLocalhostAsSecureOrigin: true,
          notifyButton: { enable: false }
        });
      } catch (e) {
        console.log("OneSignal init error:", e);
      }
    });

    return true;
  }

  async function refreshNotifState() {
    try {
      const perm = Notification.permission; // "default" | "granted" | "denied"

      let subId = null;
      let optedIn = null;

      if (window.OneSignal && typeof OneSignal.push === "function") {
        await new Promise((resolve) => {
          OneSignal.push(async () => {
            try {
              subId = await OneSignal.User.PushSubscription.id;
              optedIn = await OneSignal.User.PushSubscription.optedIn;
            } catch (e) {}
            resolve();
          });
        });
      }

      notifState.textContent =
        `Notif: perm=${perm}` +
        (optedIn !== null ? ` | optedIn=${optedIn}` : "") +
        (subId ? ` | id=${subId}` : "");

      if (perm === "granted") {
        btnNotif.textContent = subId ? "Notifications actives ✅" : "Notifications OK (ID…)";
        btnNotif.disabled = true;
        btnNotif.classList.remove("primary");
      } else if (perm === "denied") {
        btnNotif.textContent = "Notifications refusées ❌";
        btnNotif.disabled = true;
        btnNotif.classList.remove("primary");
      } else {
        btnNotif.textContent = "Activer notifications";
        btnNotif.disabled = false;
        btnNotif.classList.add("primary");
      }

      return { perm, optedIn, subId };
    } catch (e) {
      notifState.textContent = "Notif: erreur état";
      return { perm: null, optedIn: null, subId: null };
    }
  }

  async function requestNotifications() {
    btnNotif.disabled = true;
    btnNotif.textContent = "Demande en cours…";

    try {
      await new Promise((resolve) => {
        OneSignal.push(async () => {
          try {
            await OneSignal.Notifications.requestPermission();
          } catch (e) {}
          resolve();
        });
      });
    } finally {
      btnNotif.disabled = false;
    }

    const st = await refreshNotifState();

    // Si on a un ID, on l’envoie à ton Worker (si endpoint présent)
    if (st?.subId && API_BASE) {
      try {
        await fetch(API_BASE + "/push/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            subscription_id: st.subId,
            scope: SCOPE,
            ua: navigator.userAgent,
            ts: Date.now()
          })
        });
      } catch (e) {
        // pas bloquant
      }
    }
  }

  async function resetSW() {
    try {
      if (!("serviceWorker" in navigator)) return;
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        if ((r.scope || "").includes("/maps/")) await r.unregister();
      }
      const keys = await caches.keys();
      await Promise.all(keys.map(k => k.startsWith("maps-cache-") ? caches.delete(k) : Promise.resolve()));
      location.reload();
    } catch (e) {
      alert("Reset SW: " + (e?.message || e));
    }
  }

  // Map “safe” : carte basique OSM pour ne jamais casser l'UI
  function initMapSafe() {
    try {
      if (!window.L || !document.getElementById("map")) return;
      const map = L.map("map", { zoomControl: true }).setView([42.6887, 2.8948], 12); // Perpignan
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19
      }).addTo(map);

      if ("geolocation" in navigator) {
        let marker = null;
        navigator.geolocation.watchPosition((pos) => {
          const { latitude, longitude } = pos.coords;
          const latlng = [latitude, longitude];
          if (!marker) marker = L.marker(latlng).addTo(map);
          marker.setLatLng(latlng);
          map.setView(latlng, Math.max(map.getZoom(), 15));
        }, () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
      }
    } catch (e) {
      // jamais casser l'app à cause de la carte
    }
  }

  (async () => {
    await registerSW();
    await initOneSignal();
    initMapSafe();
    await refreshNotifState();

    btnNotif?.addEventListener("click", requestNotifications);
    btnTest?.addEventListener("click", refreshNotifState);
    btnReset?.addEventListener("click", resetSW);

    setInterval(refreshNotifState, 4000);
  })();
})();

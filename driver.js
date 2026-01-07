/* driver.js — version “propre UI + OneSignal”
   Objectif: UI clean + abonnement + test + état clair.
*/

(function () {
  "use strict";

  // ===== Helpers UI =====
  const $ = (id) => document.getElementById(id);

  function setPillOnline(isOnline) {
    const dot = $("dotOnline");
    const txt = $("txtOnline");
    if (!dot || !txt) return;
    dot.classList.remove("dot-ok", "dot-warn", "dot-off");
    dot.classList.add(isOnline ? "dot-ok" : "dot-off");
    txt.textContent = isOnline ? "Livreur en ligne" : "Livreur hors ligne";
  }

  function setNotifState(state, hint, level) {
    // level: "ok" | "warn" | "off"
    const dot = $("dotNotif");
    const txt = $("notifState");
    const hintEl = $("notifHint");
    if (dot) {
      dot.classList.remove("dot-ok", "dot-warn", "dot-off");
      dot.classList.add(level === "ok" ? "dot-ok" : level === "warn" ? "dot-warn" : "dot-off");
    }
    if (txt) txt.textContent = state || "—";
    if (hintEl) hintEl.textContent = hint || "";
  }

  function toast(msg) {
    // fallback simple (tu peux remplacer par ton toast system si tu en as un)
    alert(msg);
  }

  // ===== Config =====
  // On lit dans config.js si tu as déjà un objet CONFIG
  const CFG = window.CONFIG || {};

  // OneSignal App ID (tu l’as : DRIVER_MAPS)
  const ONESIGNAL_APP_ID = CFG.ONESIGNAL_APP_ID || "62253f55-1377-45fe-a47b-6676d43db125";

  // URL Worker (pour enregistrer le player_id / subscription_id)
  // Mets ça dans config.js si tu veux (recommandé)
  // Exemple: https://and-suivi.apero-nuit-du-66.workers.dev
  const WORKER_BASE = CFG.WORKER_BASE || "https://and-suivi.apero-nuit-du-66.workers.dev";

  // Endpoints attendus (côté worker)
  const PUSH_REGISTER_URL = (CFG.PUSH_REGISTER_URL || (WORKER_BASE + "/push/register"));
  const PUSH_TEST_URL = (CFG.PUSH_TEST_URL || (WORKER_BASE + "/push/test"));

  // ===== OneSignal =====
  async function initOneSignal() {
    if (!window.OneSignal) {
      setNotifState("SDK non chargé", "Le script OneSignal n’a pas chargé (réseau / cache).", "warn");
      return false;
    }

    try {
      await window.OneSignal.init({
        appId: ONESIGNAL_APP_ID,
        // Important: scope /maps/ pour GitHub Pages
        serviceWorkerParam: { scope: "/maps/" },
        serviceWorkerPath: "/maps/OneSignalSDKWorker.js",
        notifyButton: { enable: false }
      });

      return true;
    } catch (e) {
      console.error("[OneSignal.init] error:", e);
      setNotifState("Erreur init", "Impossible d'initialiser OneSignal.", "warn");
      return false;
    }
  }

  async function refreshNotifStatus() {
    if (!window.OneSignal) return;

    try {
      // Note: selon environnements, ces méthodes peuvent varier.
      // On tente plusieurs options.
      let permission = "default";
      if (window.Notification && typeof Notification.permission === "string") {
        permission = Notification.permission; // 'granted' / 'denied' / 'default'
      }

      // Essaye de lire l'id OneSignal (player_id / subscription_id)
      let subId = null;

      try {
        // v16
        if (OneSignal.User && OneSignal.User.PushSubscription) {
          subId = OneSignal.User.PushSubscription.id || null;
        }
      } catch (_) {}

      if (permission === "denied") {
        setNotifState("Bloquées", "Tu as refusé côté navigateur. Va dans les réglages du site/Chrome et autorise.", "warn");
        return;
      }

      if (permission === "default") {
        setNotifState("Non activées", "Clique sur “Activer notifications” puis autorise la popup.", "off");
        return;
      }

      // permission === granted
      if (subId) {
        setNotifState("Activées", "Abonnement OK. Tu dois recevoir une notif quand un client envoie une demande.", "ok");
      } else {
        setNotifState("Activées (en cours)", "Autorisation OK, finalisation en cours…", "warn");
      }
    } catch (e) {
      console.error("[refreshNotifStatus] error:", e);
      setNotifState("Statut inconnu", "Impossible de lire l’état des notifications.", "warn");
    }
  }

  async function enableNotifications() {
    const ok = await initOneSignal();
    if (!ok) return;

    try {
      // Demande d'autorisation + abonnement
      // v16:
      if (OneSignal.Notifications && OneSignal.Notifications.requestPermission) {
        await OneSignal.Notifications.requestPermission();
      } else if (window.Notification && Notification.requestPermission) {
        await Notification.requestPermission();
      }

      // v16 subscription
      if (OneSignal.User && OneSignal.User.PushSubscription && OneSignal.User.PushSubscription.optIn) {
        await OneSignal.User.PushSubscription.optIn();
      }

      // Attends un peu que OneSignal attribue un id
      await new Promise((r) => setTimeout(r, 800));

      let subId = null;
      try {
        if (OneSignal.User && OneSignal.User.PushSubscription) {
          subId = OneSignal.User.PushSubscription.id || null;
        }
      } catch (_) {}

      await refreshNotifStatus();

      if (!subId) {
        setNotifState("Activées (mais pas liées)", "Autorisation OK, mais pas d'ID OneSignal. Vérifie service worker / scope / cache.", "warn");
        return;
      }

      // Enregistre côté worker (pour que /client/requete puisse notifier)
      // On envoie aussi des infos utiles.
      const payload = {
        subscription_id: subId,
        ua: navigator.userAgent,
        ts: Date.now(),
        page: location.href
      };

      const res = await fetch(PUSH_REGISTER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.warn("register push failed", res.status, t);
        setNotifState("Activées (mais serveur KO)", "Abonné OK, mais enregistrement serveur a échoué. On doit regarder /push/register.", "warn");
        return;
      }

      setNotifState("Activées", "Abonnement OK + serveur OK. Teste avec “Tester”.", "ok");
      toast("✅ Notifications activées !");
    } catch (e) {
      console.error("[enableNotifications] error:", e);
      setNotifState("Erreur", "Activation impossible. Vérifie réglages navigateur + batterie.", "warn");
      toast("❌ Impossible d'activer les notifications.");
    }
  }

  async function testNotification() {
    // Test côté serveur (idéal) : le worker envoie un push via OneSignal à ceux enregistrés
    try {
      const res = await fetch(PUSH_TEST_URL, { method: "POST" });
      if (res.ok) {
        toast("✅ Test envoyé. Si ça n'arrive pas: batterie / autorisations / OneSignal config.");
      } else {
        const t = await res.text().catch(() => "");
        toast("⚠️ Test serveur a échoué: " + res.status + " " + t);
      }
    } catch (e) {
      console.error("[testNotification] error:", e);
      toast("❌ Impossible de lancer le test.");
    }
  }

  // ===== GPS / Map / Requests =====
  // Ici je ne réécris pas toute ta logique métier (tu l’as déjà),
  // mais je garde des hooks propres pour ne rien casser.
  function setGpsState(active) {
    $("gpsState").textContent = active ? "Actif" : "Inactif";
    $("btnStartGps").disabled = !!active;
    $("btnStopGps").disabled = !active;
  }

  function setLastUpdate(ts) {
    $("lastUpdate").textContent = ts ? new Date(ts).toLocaleTimeString("fr-FR") : "—";
  }

  function setRequestsCount(n) {
    $("requestsCount").textContent = (typeof n === "number") ? String(n) : "—";
  }

  // TODO: branche tes fonctions existantes ici
  function bindExistingAppLogic() {
    // Si tu as déjà une logique GPS existante, remplace ces stubs par tes fonctions.
    $("btnStartGps").addEventListener("click", () => {
      // Appelle ta fonction réelle startGPS()
      setGpsState(true);
      setPillOnline(true);
      setLastUpdate(Date.now());
    });

    $("btnStopGps").addEventListener("click", () => {
      // Appelle ta fonction réelle stopGPS()
      setGpsState(false);
      setPillOnline(false);
      setLastUpdate(Date.now());
    });

    $("btnRecenter").addEventListener("click", () => {
      // Appelle ta logique Leaflet recenter()
      toast("Recentrage… (à relier à ta map)");
    });

    // Exemple : affichage demandes (à relier à ta vraie source)
    setRequestsCount(0);
  }

  // ===== Boot =====
  window.addEventListener("load", async () => {
    // UI init
    setGpsState(false);
    setPillOnline(false);
    setNotifState("—", "Initialisation…", "off");

    // Bind boutons
    const bEnable = $("btnEnableNotif");
    const bTest = $("btnTestNotif");

    if (bEnable) bEnable.addEventListener("click", enableNotifications);
    if (bTest) bTest.addEventListener("click", testNotification);

    // Init OneSignal silencieux (juste pour lire état)
    await initOneSignal();
    await refreshNotifStatus();

    // Branche ton app existante
    bindExistingAppLogic();
  });
})();

<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Apéro de Nuit 66 • Suivi Livreur</title>
  <link rel="manifest" href="./manifest.webmanifest" />
  <meta name="theme-color" content="#0b1f2b" />
  <link rel="icon" href="./assets/icon-192.png" />
  <link rel="apple-touch-icon" href="./assets/icon-192.png" />
  <link rel="stylesheet" href="./style.css" />

  <!-- OneSignal Web Push (driver uniquement) -->
  <script src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js" defer></script>
  <script>
    // OneSignal v16 : init + SW custom (ne touche pas au SW PWA /maps/sw.js)
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    OneSignalDeferred.push(async function(OneSignal) {
      try {
        await OneSignal.init({
          appId: "%%ONESIGNAL_APP_ID%%",
          notifyButton: { enable: false },
          // Service Worker push isolé dans /maps/onesignal/ pour éviter conflit avec SW PWA
          serviceWorkerPath: "/maps/onesignal/OneSignalSDKWorker.js",
          serviceWorkerParam: { scope: "/maps/onesignal/" },
          // Option utile pour que la notif reste affichée (selon OS/navigateur)
          persistNotification: true
        });
        window.__onesignal_ready = true;
      } catch (e) {
        console.warn("OneSignal init failed:", e);
        window.__onesignal_ready = false;
      }
    });
  </script>
</head>

<body>
  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <img src="./assets/logo.png" alt="Apéro de Nuit 66" class="logo" />
        <div class="title">APERO<br><span>DE NUIT</span></div>
      </div>
      <div class="pill" id="onlinePill">
        <span class="dot"></span> Livreur en ligne
      </div>
    </div>

    <h1 class="h1">Espace Livreur</h1>

    <div class="kpiRow">
      <div class="kpi">
        <div class="t">GPS livreur</div>
        <div class="v" id="gpsState">Inactif</div>
      </div>
      <div class="kpi">
        <div class="t">Dernière mise à jour</div>
        <div class="v" id="lastPing">à l'instant</div>
      </div>
      <div class="kpi">
        <div class="t">Demandes</div>
        <div class="v" id="pendingCount">0</div>
      </div>

      <div class="kpi">
        <div class="t">Notifications</div>
        <div class="v" id="notifState">—</div>
      </div>
    </div>

    <button id="btnNotif" class="btn secondary" style="width:100%;margin-top:12px">Activer notifications</button>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
      <button class="btn" id="btnStart">Activer GPS</button>
      <button class="btn danger" id="btnStop" disabled>Arrêter GPS</button>
      <button class="btn ghost" id="btnCenter">Recentrer</button>
    </div>

    <div class="hint" id="hint"></div>

    <div class="mapBox">
      <div id="map"></div>
    </div>
  </div>

  <script type="module" src="./driver.js"></script>
</body>
</html>

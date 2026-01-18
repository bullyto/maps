import { ONESIGNAL_APP_ID } from "./config.js";

window.OneSignalDeferred = window.OneSignalDeferred || [];
OneSignalDeferred.push(async function (OneSignal) {
  await OneSignal.init({
    appId: ONESIGNAL_APP_ID,
    // IMPORTANT: sur /maps/, il existe deja un SW PWA (sw.js) qui controle le scope /maps/.
    // Un navigateur ne peut avoir qu'UN Service Worker par scope.
    // Donc OneSignal doit s'accrocher au SW existant.
    serviceWorkerPath: "/maps/sw.js",
    serviceWorkerUpdaterPath: "/maps/sw.js",
    serviceWorkerParam: { scope: "/maps/" }
  });
});

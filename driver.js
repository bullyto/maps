import { ONESIGNAL_APP_ID } from "./config.js";

window.OneSignalDeferred = window.OneSignalDeferred || [];
OneSignalDeferred.push(async function (OneSignal) {
  await OneSignal.init({
    appId: ONESIGNAL_APP_ID,
    serviceWorkerPath: "/maps/OneSignalSDKWorker.js",
    serviceWorkerUpdaterPath: "/maps/OneSignalSDKUpdaterWorker.js",
    serviceWorkerParam: { scope: "/maps/" }
  });
});

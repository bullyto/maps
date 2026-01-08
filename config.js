// /maps/config.js
// ✅ Remplis API_BASE si tu veux enregistrer l'ID OneSignal côté Worker Cloudflare.
window.DRIVER_CFG = {
  // ✅ OneSignal (DRIVER_MAPS)
  ONESIGNAL_APP_ID: "62253f55-1377-45fe-a47b-6676d43db125",

  // ✅ Ton Worker Cloudflare (mets ton domaine) - sinon laisse "".
  // Exemple: "https://ton-worker.example.workers.dev"
  API_BASE: "",

  // Scope PWA pour le suivi driver
  SCOPE: "/maps/"
};

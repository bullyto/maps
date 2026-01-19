// Apéro de Nuit 66 • Suivi (CLIENT)
// Ce dépôt = uniquement la page client (web HTML).
// Le côté livreur passe sur une app native (Capacitor) + envoi GPS vers le Worker.

export const CONFIG = {
  // URL de ton Worker Cloudflare
  API_BASE: "https://and-suivi.apero-nuit-du-66.workers.dev",

  // Clé partagée (doit correspondre au secret Cloudflare: CLIENT_KEY)
  // IMPORTANT: remplace par TA vraie clé (valeur de CLIENT_KEY dans Cloudflare)
  // Exemple si tu utilises la meme pour tout pendant les tests: "0000"
  CLIENT_KEY: "test123",

  // Polling / rafraichissement (ms)
  POLL_STATUS_MS: 3000,
  POLL_DRIVER_MS: 3000,
  SEND_CLIENT_POS_MS: 8000,

  // Anti-spam côté client (cooldown entre deux demandes)
  REQUEST_COOLDOWN_SEC: 30,
  REQUEST_COOLDOWN_MS: 30_000,

  // LocalStorage
  LS_PREFIX: "adn66_track_",
};

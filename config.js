// Apéro de Nuit 66 • Suivi (CLIENT)
// Ce dépôt = uniquement la page client (web HTML).
// Le côté livreur passe sur une app native (Capacitor) + envoi GPS vers le Worker.

export const CONFIG = {
  // URL de ton Worker Cloudflare
  API_BASE: "https://and-suivi.apero-nuit-du-66.workers.dev",

  // Clé partagée (doit correspondre au secret Cloudflare: CLIENT_KEY)
  // Pour les tests: "test123"
  CLIENT_KEY: "test123",

  // Anti-spam côté client (cooldown entre deux demandes)
  REQUEST_COOLDOWN_SEC: 30,
  REQUEST_COOLDOWN_MS: 30_000,
};

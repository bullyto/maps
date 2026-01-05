// Config AND SUIVI
// Mets ici l'URL de ton Worker Cloudflare (sans slash final)
export const API_BASE = "https://and-suivi.apero-nuit-du-66.workers.dev";

// Nom de l'app (pour affichage)
export const APP_NAME = "Suivi de commande";

// Durées
export const MAX_ACTIVE_MINUTES = 30; // demandé
export const DEFAULT_ACTIVE_MINUTES = 30;
export const REQUEST_EXPIRE_MINUTES = 8; // fenêtre pour accepter (côté worker)

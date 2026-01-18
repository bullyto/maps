// Apéro de Nuit 66 • Suivi — config
export const API_BASE = "https://and-suivi.apero-nuit-du-66.workers.dev";
export const MAX_MINUTES = 30;           // max autorisé par le livreur
export const ARRIVAL_RADIUS_M = 500;     // (optionnel futur)
export const DRIVER_PIN = "0000";        // code d'accès livreur (mode B)

// OneSignal (Web Push) — App ID (non secret)
// IMPORTANT: l'App ID doit correspondre à l'app OneSignal configurée pour le site /maps/
// (celle que tu viens de créer dans OneSignal).
export const ONESIGNAL_APP_ID = "ffeb3c0f-dcf2-4488-a7cc-1e6466833a80";

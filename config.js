// =====================================================
// Apéro de Nuit 66 • Suivi Livreur
// Fichier : config.js
// Rôle     : Configuration centrale de l'app driver
// =====================================================

// --- API Cloudflare Worker (backend suivi & push) ---
export const API_BASE = "https://and-suivi.apero-nuit-du-66.workers.dev";

// --- Paramètres livreur ---
export const MAX_MINUTES = 30;           // Temps max d'activité GPS (minutes)
export const ARRIVAL_RADIUS_M = 500;     // Rayon d'arrivée (mètres) – futur usage
export const DRIVER_PIN = "0000";        // Code d'accès livreur (mode B)

// --- OneSignal (notifications push livreur) ---
// App ID PUBLIC (OK côté front)
// La REST API KEY est stockée UNIQUEMENT dans Cloudflare (secret)
export const ONESIGNAL_APP_ID = "62253f55-13f7-45fe-a47b-6676d43db125";

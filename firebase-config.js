/**
 * firebase-config.js
 * -------------------
 * Shared configuration for Firebase and WebRTC
 */

// 1. Fixed variable name here (changed firebaseConfig to FIREBASE_CONFIG)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAaOp3LYoMGbByON7W7pGQYV_oXJlmU_Hw",
  authDomain: "starlight-28e40.firebaseapp.com",
  databaseURL: "https://starlight-28e40-default-rtdb.firebaseio.com",
  projectId: "starlight-28e40",
  storageBucket: "starlight-28e40.firebasestorage.app",
  messagingSenderId: "206859310211",
  appId: "1:206859310211:web:3450cfa9fae7f6360a77b6",
  measurementId: "G-G52TDH6GRY"
};

// Shared STUN server config for WebRTC screen sharing.
const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// Exposed for both classic <script> pages (window) and service worker (self) contexts.
if (typeof window !== "undefined") {
  window.FIREBASE_CONFIG = FIREBASE_CONFIG;
  window.RTC_CONFIG = RTC_CONFIG;
} else if (typeof self !== "undefined") {
  self.FIREBASE_CONFIG = FIREBASE_CONFIG;
  self.RTC_CONFIG = RTC_CONFIG;
}
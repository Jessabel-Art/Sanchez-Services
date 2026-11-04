// src/lib/php-backend/app.js — drop-in for `firebase/app` (no Firebase project is used).
const APP = { name: "[DEFAULT]", options: { projectId: "php-backend" }, automaticDataCollectionEnabled: false };

export function initializeApp() {
  return APP;
}
export function getApp() {
  return APP;
}
export function getApps() {
  return [APP];
}

// src/lib/adminAllowlist.js
// Centralized helper to compute the admin allowlist from env vars.
// Uses VITE_ADMIN_EMAIL (primary) and optional VITE_EXTRA_ADMINS
// (comma-separated). All addresses are normalized to lowercase.

export function buildAdminAllowlist() {
  const primary = (import.meta.env?.VITE_ADMIN_EMAIL || "").trim().toLowerCase();
  const extras = (import.meta.env?.VITE_EXTRA_ADMINS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return new Set([primary, ...extras].filter(Boolean));
}

export function isEmailAdmin(email) {
  if (!email) return false;
  return buildAdminAllowlist().has(String(email).toLowerCase());
}

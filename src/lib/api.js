// src/lib/api.js — the only way the frontend talks to the backend (PHP REST API under /api).
// Session auth uses an HttpOnly cookie; state-changing requests carry the CSRF token.

const BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(code, message, status, field) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.field = field || null;
  }
}

let csrfToken = null;
let pollIntervalMs = 30000;
let sessionPromise = null;
const writeListeners = new Set();
const sessionListeners = new Set();

export const getPollIntervalMs = () => pollIntervalMs;

/** Subscribe to "something changed" (after any successful write) — used to refresh lists. */
export function onApiWrite(fn) {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}
export function onSessionChange(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

let googleSignIn = false;
/** True when the server has Google sign-in configured (owner decision). */
export const isGoogleSignInEnabled = () => googleSignIn;

function absorb(payload) {
  if (payload && typeof payload.csrfToken === "string") csrfToken = payload.csrfToken;
  if (payload && Number(payload.pollIntervalSeconds) > 0) pollIntervalMs = Math.max(5000, payload.pollIntervalSeconds * 1000);
  if (payload && typeof payload.googleSignIn === "boolean") googleSignIn = payload.googleSignIn;
  if (payload && "user" in payload) sessionListeners.forEach((fn) => fn(payload.user));
}

async function request(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", "We couldn't reach the server. Check your connection and try again.", 0);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = json?.error || {};
    throw new ApiError(e.code || `http-${res.status}`, e.message || `Request failed (${res.status}).`, res.status, e.details?.field);
  }
  return json;
}

export async function loadSession(force = false) {
  if (!sessionPromise || force) {
    sessionPromise = request("GET", "/auth/session")
      .then((p) => {
        absorb(p);
        return p;
      })
      .catch((e) => {
        sessionPromise = null;
        throw e;
      });
  }
  return sessionPromise;
}

export async function apiGet(path) {
  return request("GET", path);
}

/** POST/PATCH/DELETE with CSRF; retries once after refreshing a stale token. */
const READ_ONLY_POSTS = new Set(["/quote"]);

export async function apiSend(method, path, body = {}) {
  if (!csrfToken) await loadSession();
  let out;
  try {
    out = await request(method, path, body);
  } catch (e) {
    if (e.status === 403 && /CSRF/i.test(e.message)) {
      await loadSession(true);
      out = await request(method, path, body);
    } else {
      throw e;
    }
  }
  absorb(out);
  // Read-only POSTs (price quotes) don't invalidate cached data.
  if (!READ_ONLY_POSTS.has(path)) writeListeners.forEach((fn) => fn(path));
  return out;
}

export const apiPost = (path, body) => apiSend("POST", path, body);
export const apiPatch = (path, body) => apiSend("PATCH", path, body);
export const apiDelete = (path) => apiSend("DELETE", path, {});

/** Builds a query string, skipping empty values. */
export function qs(params) {
  const p = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : "";
}

// src/lib/php-backend/client.js
//
// Transport for the PHP backend shim. Only bundled when the app is built with
// VITE_BACKEND=php (see vite.config.js aliases); production Firebase builds never include it.
//
// Wire encoding (mirrors backend/src/Store/Doc.php):
//   Timestamp / Date   -> {"__ts": "ISO-8601Z"}
//   serverTimestamp()  -> {"__op": "serverTimestamp"}
//   deleteField()      -> {"__op": "delete"}
//   increment(n)       -> {"__op": "increment", "n": n}

const API_BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

export class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds = Math.trunc(seconds);
    this.nanoseconds = Math.trunc(nanoseconds);
  }
  static fromDate(date) {
    return Timestamp.fromMillis(date.getTime());
  }
  static fromMillis(ms) {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.round((ms - seconds * 1000) * 1e6));
  }
  static now() {
    return Timestamp.fromMillis(Date.now());
  }
  toDate() {
    return new Date(this.toMillis());
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }
  isEqual(other) {
    return other instanceof Timestamp && other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
  valueOf() {
    // Same idea as Firestore: lexically sortable string so <, > comparisons work
    return String(this.seconds + 1e12).padStart(14, "0") + "." + String(this.nanoseconds).padStart(9, "0");
  }
  toJSON() {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds, type: "firestore/timestamp/1.0" };
  }
  toString() {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
}

export class FieldSentinel {
  constructor(op, extra = {}) {
    this.__op = op;
    Object.assign(this, extra);
  }
}

export function encodeValue(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Timestamp) return { __ts: v.toDate().toISOString() };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new Error("Invalid Date value");
    return { __ts: v.toISOString() };
  }
  if (v instanceof FieldSentinel) return { ...v };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encodeValue(x)));
  if (typeof v === "object") {
    // Firestore Timestamp-like {seconds, nanoseconds} objects from other code paths
    if (typeof v.toDate === "function" && typeof v.seconds === "number") {
      return { __ts: v.toDate().toISOString() };
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const enc = encodeValue(val);
      if (enc !== undefined) out[k] = enc;
    }
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}

export function decodeValue(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "__ts" && typeof v.__ts === "string") {
    return Timestamp.fromMillis(Date.parse(v.__ts));
  }
  const out = {};
  for (const k of keys) out[k] = decodeValue(v[k]);
  return out;
}

export class BackendError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = "FirebaseError"; // UI code only reads .code / .message
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------- session / CSRF

let csrfToken = null;
let sessionPromise = null;
let pollIntervalMs = 30000;
const sessionListeners = new Set();

export function getPollIntervalMs() {
  return pollIntervalMs;
}

export function getCsrfToken() {
  return csrfToken;
}

function applySession(payload) {
  if (payload && typeof payload.csrfToken === "string") csrfToken = payload.csrfToken;
  if (payload && Number(payload.pollIntervalSeconds) > 0) {
    pollIntervalMs = Math.max(5000, Number(payload.pollIntervalSeconds) * 1000);
  }
  if (payload && "user" in payload) {
    sessionListeners.forEach((fn) => {
      try {
        fn(payload.user);
      } catch (e) {
        console.error(e);
      }
    });
  }
}

export function onSessionUser(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

export async function loadSession(force = false) {
  if (!sessionPromise || force) {
    sessionPromise = rawFetch("GET", "/auth/session").then((p) => {
      applySession(p);
      return p;
    });
  }
  return sessionPromise;
}

async function rawFetch(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new BackendError("unavailable", "Network error. Please check your connection and try again.", 0);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const code = json?.error?.code || `http-${res.status}`;
    throw new BackendError(code, json?.error?.message || `Request failed (${res.status})`, res.status);
  }
  return json;
}

/** POST with CSRF (fetches the session first; retries once if the token went stale). */
export async function post(path, body = {}) {
  if (!csrfToken) await loadSession();
  try {
    const out = await rawFetch("POST", path, body);
    applySession(out);
    return out;
  } catch (e) {
    if (e.status === 403 && /CSRF/i.test(e.message || "")) {
      await loadSession(true);
      const out = await rawFetch("POST", path, body);
      applySession(out);
      return out;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- change notifications

const changeListeners = new Set();

/** Listeners (onSnapshot pollers) refresh after any local write. */
export function onLocalWrite(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

let notifyTimer = null;
export function notifyLocalWrite() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => changeListeners.forEach((fn) => fn()), 50);
}

// src/lib/php-backend/auth.js
//
// Drop-in subset of `firebase/auth` backed by PHP session auth (/api/auth/*).
// Sessions are HttpOnly cookies; no tokens are stored in the browser.

import { post, loadSession, onSessionUser, getCsrfToken, BackendError } from "./client";

const listeners = new Set();
const AUTH = {
  app: { name: "[DEFAULT]", options: { projectId: "php-backend" } },
  currentUser: null,
  _ready: false,
};

function makeUser(u) {
  if (!u) return null;
  return {
    uid: u.uid,
    email: u.email,
    emailVerified: !!u.emailVerified,
    displayName: u.displayName ?? null,
    phoneNumber: u.phoneNumber ?? null,
    photoURL: null,
    isAnonymous: false,
    providerId: "password",
    role: u.role,
    isAdmin: !!u.isAdmin,
    // Used by the maintenance sweep as a Bearer value; the server accepts the CSRF token there.
    getIdToken: async () => {
      if (!getCsrfToken()) await loadSession();
      return getCsrfToken();
    },
    reload: async () => {
      await loadSession(true);
    },
  };
}

function setUser(u) {
  const prevUid = AUTH.currentUser?.uid ?? null;
  const prevJson = JSON.stringify(AUTH.currentUser ? { ...AUTH.currentUser, getIdToken: 0, reload: 0 } : null);
  AUTH.currentUser = makeUser(u);
  const nextJson = JSON.stringify(AUTH.currentUser ? { ...AUTH.currentUser, getIdToken: 0, reload: 0 } : null);
  const changed = !AUTH._ready || prevUid !== (AUTH.currentUser?.uid ?? null) || prevJson !== nextJson;
  AUTH._ready = true;
  if (changed) listeners.forEach((cb) => cb(AUTH.currentUser));
}

onSessionUser(setUser);

export function getAuth() {
  return AUTH;
}

export function onAuthStateChanged(auth, cb) {
  listeners.add(cb);
  if (AUTH._ready) {
    queueMicrotask(() => cb(AUTH.currentUser));
  } else {
    loadSession().catch(() => setUser(null));
  }
  return () => listeners.delete(cb);
}

export async function signInWithEmailAndPassword(auth, email, password) {
  const out = await post("/auth/login", { email, password });
  return { user: AUTH.currentUser ?? makeUser(out.user), providerId: "password", operationType: "signIn" };
}

export async function createUserWithEmailAndPassword(auth, email, password) {
  const out = await post("/auth/register", { email, password });
  return { user: AUTH.currentUser ?? makeUser(out.user), providerId: "password", operationType: "signIn" };
}

export async function sendPasswordResetEmail(auth, email) {
  await post("/auth/password/forgot", { email });
}

export async function confirmPasswordReset(auth, token, newPassword) {
  await post("/auth/password/reset", { token, password: newPassword });
}

export async function signOut() {
  await post("/auth/logout", {});
  setUser(null);
}

export async function updateEmail(user, newEmail, password) {
  await post("/auth/email", { email: newEmail, ...(password ? { password } : {}) });
}

export async function updateProfile(user, { displayName } = {}) {
  await post("/auth/profile", { displayName: displayName ?? null });
}

export async function updatePassword() {
  throw new BackendError("auth/operation-not-allowed", "Use the password reset email to change your password.");
}

export class GoogleAuthProvider {
  constructor() {
    this.providerId = "google.com";
  }
}

export async function signInWithPopup() {
  throw new BackendError(
    "auth/operation-not-supported-in-this-environment",
    "Google sign-in is not available. Please sign in with your email and password."
  );
}

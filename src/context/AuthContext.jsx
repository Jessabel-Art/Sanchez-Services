// src/context/AuthContext.jsx — session state from the PHP API (HttpOnly cookie session).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiPost, loadSession, onSessionChange } from "@/lib/api";

const AuthCtx = createContext(null);

function toUser(u) {
  if (!u) return null;
  return {
    ...u,
    uid: String(u.id),
    displayName: u.name || "",
    phoneNumber: u.phone || "",
  };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const unsub = onSessionChange((u) => setUser(toUser(u)));
    loadSession()
      .catch(() => setUser(null))
      .finally(() => setAuthReady(true));
    return unsub;
  }, []);

  const refresh = useCallback(() => loadSession(true), []);

  const value = useMemo(
    () => ({
      user,
      authReady,
      isAdmin: !!user?.isAdmin,
      signIn: async (email, password) => ({ user: toUser((await apiPost("/auth/login", { email, password })).user) }),
      signUp: async (email, password, name) => ({ user: toUser((await apiPost("/auth/register", { email, password, name })).user) }),
      resetPassword: (email) => apiPost("/auth/password/forgot", { email }),
      confirmReset: (token, password) => apiPost("/auth/password/reset", { token, password }),
      verifyEmail: (token) => apiPost("/auth/verify", { token }),
      resendVerification: () => apiPost("/auth/verify/resend", {}),
      changeEmail: (email, password) => apiPost("/auth/email", { email, password }),
      changePassword: (currentPassword, newPassword) => apiPost("/auth/password/change", { currentPassword, newPassword }),
      signOut: () => apiPost("/auth/logout", {}),
      refresh,
    }),
    [user, authReady, refresh]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

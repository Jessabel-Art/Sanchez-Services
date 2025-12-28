// pages/admin/hooks/useAdminAuth.js
import { useEffect, useMemo, useRef, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { useAuth } from "@/context/AuthContext";
import { checkAdminAuth, buildAdminAllowlist, buildAdminUidAllowlist } from "@/lib/adminAllowlist";
import { db } from "@/lib/firebase";

// Unified admin check used by AdminRoute, header, and admin pages.
// Uses centralized checkAdminAuth() as single source of truth.
// Tracks local authReady state to ensure auth has settled before checking admin status.
// In DEV: allows allowlist fallback; always fetches Firestore signals for diagnostics.
// In PROD: requires admins/{uid}.active=true or profiles/{uid}.role=admin/owner.
export function useAdminAuth() {
  const { user: authUser, authReady: authContextReady } = useAuth();

  // Local authReady state: becomes true only after first Firebase auth state change
  const [localAuthReady, setLocalAuthReady] = useState(false);
  const authReadyRef = useRef(false);

  // Initialize local authReady on first render
  useEffect(() => {
    if (authContextReady && !authReadyRef.current) {
      authReadyRef.current = true;
      setLocalAuthReady(true);
    }
  }, [authContextReady]);

  // Main auth state
  const [authState, setAuthState] = useState(() => ({
    loading: true, // Always start in loading until auth is truly ready and admin check completes
    authResult: { allowed: false, reason: "not_admin", checks: {} },
    adminDocActive: false,
    profileRole: null,
    adminDocFetched: false,
    profileFetched: false,
    error: null,
    requestId: 0, // Track async request version to ignore stale results
  }));

  // Async request tracker to prevent stale results from overwriting newer requests
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    // If Firebase auth context isn't ready yet, stay in loading state
    if (!localAuthReady) {
      setAuthState((prev) => ({
        ...prev,
        loading: true,
        authResult: { allowed: false, reason: "not_admin", checks: {} },
      }));
      return () => {
        cancelled = true;
      };
    }

    const isDev = Boolean(import.meta.env?.DEV);
    const currentRequestId = ++requestIdRef.current;

    // If user logged out, mark admin check complete
    if (!authUser) {
      if (!cancelled) {
        setAuthState({
          loading: false,
          authResult: { allowed: false, reason: "not_admin", checks: {} },
          adminDocActive: false,
          profileRole: null,
          adminDocFetched: false,
          profileFetched: false,
          error: null,
          requestId: currentRequestId,
        });
      }
      return () => {
        cancelled = true;
      };
    }

    const emailLower = (authUser.email || "").toLowerCase();
    const uid = authUser.uid;

    // Check for DEV allowlist match (but still fetch Firestore for diagnostics)
    const allowlistEmailHit = isDev && emailLower && buildAdminAllowlist().has(emailLower);
    const allowlistUidHit = isDev && uid && buildAdminUidAllowlist().has(uid);

    // Always fetch Firestore signals for diagnostics and parity
    setAuthState((prev) => ({
      ...prev,
      loading: true,
      error: null,
      requestId: currentRequestId,
    }));

    (async () => {
      try {
        const [adminSnap, profileSnap] = await Promise.all([
          getDoc(doc(db, "admins", uid)),
          getDoc(doc(db, "profiles", uid)),
        ]);

        // Safely extract adminDocActive with defensive coercion
        let adminDocActive = false;
        if (adminSnap.exists() && adminSnap.data()?.active !== undefined) {
          const activeValue = adminSnap.data().active;
          // Warn if field is string instead of boolean
          if (typeof activeValue === "string") {
            console.warn(
              `%c[useAdminAuth] Firestore field type mismatch`,
              "color: #f59e0b; font-weight: bold",
              {
                path: `admins/${uid}.active`,
                expected: "boolean",
                actual: typeof activeValue,
                value: activeValue,
                coercedAs: activeValue === "true",
              }
            );
            adminDocActive = activeValue === "true";
          } else {
            adminDocActive = activeValue === true;
          }
        }

        const profileRole = profileSnap.exists() ? profileSnap.data()?.role || null : null;

        // Call checkAdminAuth with Firestore signals; in DEV still allow allowlist as fallback
        const authResult = checkAdminAuth({
          user: authUser,
          adminDocActive,
          profileRole,
          allowDevFallback: isDev,
        });

        // Only apply result if this request version is still current
        if (!cancelled && currentRequestId === requestIdRef.current) {
          setAuthState({
            loading: false,
            authResult,
            adminDocActive,
            profileRole,
            adminDocFetched: adminSnap.exists(),
            profileFetched: profileSnap.exists(),
            error: null,
            requestId: currentRequestId,
          });

          if (isDev) {
            console.log(
              "%c[useAdminAuth] Firestore check completed",
              "color: #3b82f6; font-weight: bold",
              {
                isAdmin: authResult.allowed,
                authReason: authResult.reason,
                uid,
                email: emailLower,
                allowlistMatch: allowlistEmailHit || allowlistUidHit,
                firestore: { adminDocActive, adminDocFetched: adminSnap.exists(), profileRole, profileFetched: profileSnap.exists() },
              }
            );
          }
        }
      } catch (err) {
        // Permission-denied errors are EXPECTED for non-admin users trying to read admin/profile docs.
        // Silently treat them as "not admin" without logging as errors.
        const isPermissionDenied = err?.code === "permission-denied";
        
        if (!isPermissionDenied) {
          // Only warn on unexpected errors (network, quota, etc.)
          console.warn(
            "%c[useAdminAuth] Firestore read error",
            "color: #ef4444; font-weight: bold",
            {
              code: err?.code || "unknown",
              message: err?.message || String(err),
              uid,
              email: emailLower,
            }
          );
        } else if (isDev) {
          // In DEV, silently log permission-denied for debugging
          console.debug(
            "%c[useAdminAuth] Permission denied (expected for non-admins)",
            "color: #6366f1",
            { uid, email: emailLower }
          );
        }

        // Firestore fetch failed; in DEV allow allowlist fallback, in PROD deny
        const authResult = checkAdminAuth({
          user: authUser,
          adminDocActive: false,
          profileRole: null,
          allowDevFallback: isDev,
        });

        if (!cancelled && currentRequestId === requestIdRef.current) {
          setAuthState({
            loading: false,
            authResult,
            adminDocActive: false,
            profileRole: null,
            adminDocFetched: false,
            profileFetched: false,
            error: isPermissionDenied ? null : err, // Don't store permission-denied as error
            requestId: currentRequestId,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [localAuthReady, authUser?.uid, authUser?.email]);

  const allowlistInfo = useMemo(() => {
    const emailAllowlist = buildAdminAllowlist();
    const uidAllowlist = buildAdminUidAllowlist();

    return {
      emailAllowlist: Array.from(emailAllowlist),
      uidAllowlist: Array.from(uidAllowlist),
      emailLower: authUser?.email ? authUser.email.toLowerCase() : null,
      uid: authUser?.uid || null,
      checks: authState.authResult.checks,
      adminDocFetched: authState.adminDocFetched,
      profileFetched: authState.profileFetched,
      checkedAt: new Date().toISOString(),
    };
  }, [authState.authResult.checks, authState.adminDocFetched, authState.profileFetched, authUser?.email, authUser?.uid]);

  // Final return: use checkAdminAuth result as single source of truth
  const result = {
    user: authUser,
    isAdmin: authState.authResult.allowed,
    loading: authState.loading,
    authReady: localAuthReady,
    error: authState.error,
    allowlistInfo,
    authReason: authState.authResult.reason,
  };

  // Log final values only when auth is settled (prevents misleading logs during initialization)
  if (import.meta.env?.DEV && localAuthReady && authUser && !authState.loading) {
    console.log(
      "%c[useAdminAuth] Final return (settled)",
      "color: #8b5cf6; font-weight: bold",
      {
        isAdmin: result.isAdmin,
        authReason: result.authReason,
        checks: result.allowlistInfo.checks,
      }
    );
  }

  return result;
}

// pages/admin/hooks/useAdminAuth.js
import { useMemo } from "react";
import { useAuth } from "@/context/AuthContext";
import { buildAdminAllowlist } from "@/lib/adminAllowlist";

// Thin wrapper around the shared AuthContext so admin checks use the same
// allowlist everywhere (AdminRoute, header, and admin pages).
export function useAdminAuth() {
  const { user, authReady } = useAuth();

  const isAdmin = useMemo(() => {
    if (!user?.email) return false;
    const allowlist = buildAdminAllowlist();
    return allowlist.has(user.email.toLowerCase());
  }, [user?.email]);

  return { user, isAdmin, loading: !authReady };
}

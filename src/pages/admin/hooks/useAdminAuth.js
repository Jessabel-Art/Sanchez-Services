// Admin access is decided by the server (role on the session); the API enforces it on every call.
import { useAuth } from "@/context/AuthContext";

export function useAdminAuth() {
  const { user, authReady } = useAuth();
  return { user, isAdmin: !!user?.isAdmin, loading: !authReady, authReady };
}

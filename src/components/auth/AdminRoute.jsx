// src/components/auth/AdminRoute.jsx
import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAdminAuth } from "@/pages/admin/hooks/useAdminAuth";

function FullPageLoader() {
  return (
    <div className="min-h-[60vh] bg-light-pink flex items-center justify-center">
      <div className="h-10 w-10 rounded-full border-4 border-plum/20 border-t-gold animate-spin" />
    </div>
  );
}

export default function AdminRoute({ children }) {
  const { user, isAdmin, loading } = useAdminAuth();
  const location = useLocation();
  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/auth" replace state={{ from: location.pathname + location.search }} />;
  if (!isAdmin) return <Navigate to="/portal" replace />;
  return <>{children}</>;
}

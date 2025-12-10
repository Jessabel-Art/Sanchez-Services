// src/routes/AdminRoute.jsx
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { buildAdminAllowlist } from '@/lib/adminAllowlist';

function FullPageLoader() {
  return (
    <div className="min-h-[60vh] bg-light-pink flex items-center justify-center">
      <div className="h-10 w-10 rounded-full border-4 border-plum/20 border-t-gold animate-spin" />
    </div>
  );
}

export default function AdminRoute({ children }) {
  const { user, authReady } = useAuth();
  const location = useLocation();

  if (!authReady) return <FullPageLoader />;

  const allowlist = buildAdminAllowlist();
  const isAdmin = !!user && !!user.email && allowlist.has(user.email.toLowerCase());

  if (!isAdmin) {
    return (
      <Navigate
        to="/auth"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  return <>{children}</>;
}

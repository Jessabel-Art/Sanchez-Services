// src/pages/admin/AdminDashboard.jsx
import React, { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAdminAuth } from "./hooks/useAdminAuth";

import AdminHeader from "./components/AdminHeader";
import AdminSidebar from "./components/AdminSidebar";

import DashboardHome from "./DashboardHome";
import BookingsView from "./BookingsView";
import CalendarView from "./CalendarView";
import ReviewsView from "./ReviewsView";
import ReportsView from "./ReportsView";
import MaintenanceView from "./MaintenanceView";
import ClientsView from "./ClientsView";
import AdminPaymentsPage from "./AdminPaymentsPage";

import AuthPage from "../AuthPage";
import { AdminUIProvider } from "./context/AdminUIContext";

const AdminDashboard = ({ initialView = "dashboard" }) => {
  const { user, isAdmin, loading } = useAdminAuth();
  const location = useLocation();

  // If we navigated here with: navigate("/admin", { state: { activeView: "clients" } })
  // Support both patterns: activeView (old) and initialView (new)
  const forcedView =
    location.state?.activeView || location.state?.initialView || null;

  const [activeView, setActiveView] = useState(
    forcedView || initialView || "dashboard"
  );

  // Sync state if navigation changes it (important for switching from Payments page)
  useEffect(() => {
    if (forcedView && forcedView !== activeView) {
      setActiveView(forcedView);
    }
  }, [forcedView, activeView]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FCEFF6]">
        <div className="text-[#431039] text-sm font-medium">
          Loading admin…
        </div>
      </div>
    );
  }

  if (!user || !isAdmin) {
    return <AuthPage />;
  }

  const renderView = () => {
    switch (activeView) {
      case "dashboard":
        // Pass setActiveView so dashboard cards can jump to other views
        return <DashboardHome onChangeView={setActiveView} />;
      case "bookings":
        return <BookingsView />;
      case "calendar":
        return <CalendarView />;
      case "clients":
        return <ClientsView />;
      case "reviews":
        return <ReviewsView />;
      case "reports":
        return <ReportsView />;
      case "maintenance":
        return <MaintenanceView />;
      case "payments":
        return (
          <AdminPaymentsPage
            embedded
            onChangeView={setActiveView}
          />
        );
      default:
        return <DashboardHome onChangeView={setActiveView} />;
    }
  };

  return (
    <AdminUIProvider>
      <div className="min-h-screen flex bg-[#FFF7FB]">
        <AdminSidebar activeView={activeView} onChangeView={setActiveView} />

        <div className="flex-1 flex flex-col min-w-0">
          <AdminHeader activeView={activeView} user={user} />

          <main className="flex-1 px-6 py-4 lg:px-10 lg:py-6 bg-[#FFF7FB]">
            {renderView()}
          </main>
        </div>
      </div>
    </AdminUIProvider>
  );
};

export default AdminDashboard;

// src/pages/admin/components/AdminHeader.jsx
import React from "react";
import { useAuth } from "@/context/AuthContext";
import { LogOut, Menu, X } from "lucide-react";
import { useContext } from "react";
import { AdminUIContext } from "../context/AdminUIContext";

// Import your mascot (adjust filename if needed)
import Mascot from "@/assets/mascot/mascot-standalone.png";

const VIEW_TITLES = {
  dashboard: "Dashboard",
  bookings: "Bookings",
  calendar: "Calendar",
  reviews: "Reviews",
  reports: "Reports",
  maintenance: "Maintenance",
};

const AdminHeader = ({ activeView, user }) => {
  const { signOut } = useAuth();
    const { mobileMenuOpen, setMobileMenuOpen } = useContext(AdminUIContext);
  // search removed from header

  const handleLogout = async () => {
    await signOut();
  };

  return (
    <header className="w-full bg-white border-b border-[#F1D8E8] px-3 py-2 sm:px-4 sm:py-3 lg:px-8 lg:py-4 flex items-center justify-between gap-2 sm:gap-3 lg:gap-4 sticky top-0 z-20">

      {/* LEFT SECTION — Mascot + Business name */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Mobile menu toggle */}
        <button
          type="button"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="lg:hidden inline-flex items-center justify-center p-1.5 rounded-lg text-[#431039] hover:bg-[#F5F1F4] transition-colors"
          title="Toggle menu"
        >
          {mobileMenuOpen ? (
            <X className="w-5 h-5" />
          ) : (
            <Menu className="w-5 h-5" />
          )}
        </button>
        <img
          src={Mascot}
          alt="Sanchez Services Mascot"
          className="w-6 h-6 sm:w-8 sm:h-8 lg:w-10 lg:h-10 object-contain drop-shadow-sm"
        />

        <div>
          <h1 className="text-base sm:text-lg lg:text-xl font-semibold text-[#431039]">
            {VIEW_TITLES[activeView] || "Dashboard"}
          </h1>
          <p className="hidden xs:block sm:block text-xs text-gray-500">
            Sanchez Services • Admin Panel
          </p>
        </div>
      </div>

      {/* RIGHT SECTION — Search, user, logout */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* search removed */}

        {/* USER INFO + LOGOUT */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <div className="hidden md:flex flex-col text-right">
            <span className="text-xs font-medium text-[#431039]">
              {user?.email}
            </span>
            <span className="text-[11px] text-gray-500">Admin</span>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center justify-center rounded-full bg-[#F3E0F0] text-[#431039] p-1.5 sm:p-2 hover:bg-[#EBD1E9] transition-colors"
            title="Sign out"
          >
            <LogOut className="w-4 h-4 sm:w-4 sm:h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};

export default AdminHeader;

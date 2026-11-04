// src/pages/admin/components/AdminSidebar.jsx
import React from "react";
import { Button } from "@/components/ui/button";
import { useContext } from "react";
import { AdminUIContext } from "../context/AdminUIContext";
import {
  LayoutDashboard,
  CalendarDays,
  ClipboardList,
  Users,
  MessageCircle,
  Wrench,
  CreditCard,
  BarChart3,
} from "lucide-react";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "bookings", label: "Bookings", icon: ClipboardList },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "clients", label: "Clients", icon: Users },
  { id: "payments", label: "Payments & Deposits", icon: CreditCard },
  { id: "reviews", label: "Reviews", icon: MessageCircle },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "maintenance", label: "System", icon: Wrench },
];

export default function AdminSidebar({ activeView, onChangeView }) {
  const { mobileMenuOpen, setMobileMenuOpen } = useContext(AdminUIContext);

  const handleNavClick = (viewId) => {
    onChangeView(viewId);
    setMobileMenuOpen(false); // Close menu after navigation on mobile
  };

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-60 bg-[#FCEFF6] border-r border-[#F3D6EA]">
        <div className="px-4 py-5 lg:py-6 border-b border-[#F3D6EA]">
          <div className="text-xs font-semibold tracking-[0.18em] text-[#C76AA7] uppercase">
            Admin Dashboard
          </div>
          <div className="text-sm text-[#431039] mt-1">Sanchez Services</div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <Button
                key={item.id}
                variant={isActive ? "default" : "ghost"}
                size="sm"
                className={`w-full justify-start gap-2 rounded-xl text-sm py-2 ${
                  isActive
                    ? "bg-[#F7C7E8] text-[#431039] hover:bg-[#F4B8E0]"
                    : "text-[#6B2563] hover:bg-[#FDF0F8]"
                }`}
                onClick={() => handleNavClick(item.id)}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Button>
            );
          })}
        </nav>
      </aside>

      {/* Mobile menu backdrop */}
      {mobileMenuOpen && (
        <button
          type="button"
          className="fixed inset-0 bg-black/30 z-30 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close admin navigation menu"
        />
      )}

      {/* Mobile drawer menu */}
      <aside
        className={`fixed left-0 top-14 bottom-0 w-64 bg-[#FCEFF6] border-r border-[#F3D6EA] flex flex-col z-40 lg:hidden transition-transform duration-300 ease-in-out ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-4 py-4 border-b border-[#F3D6EA] flex-shrink-0">
          <div className="text-xs font-semibold tracking-[0.18em] text-[#C76AA7] uppercase">
            Admin Dashboard
          </div>
          <div className="text-sm text-[#431039] mt-1">Sanchez Services</div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <Button
                key={item.id}
                variant={isActive ? "default" : "ghost"}
                size="sm"
                className={`w-full justify-start gap-2 rounded-xl text-sm py-2 ${
                  isActive
                    ? "bg-[#F7C7E8] text-[#431039] hover:bg-[#F4B8E0]"
                    : "text-[#6B2563] hover:bg-[#FDF0F8]"
                }`}
                onClick={() => handleNavClick(item.id)}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Button>
            );
          })}
        </nav>
      </aside>
    </>
  );
}

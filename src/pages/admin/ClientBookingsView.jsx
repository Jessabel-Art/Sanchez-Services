// src/pages/admin/ClientBookingsView.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiGet, qs } from "@/lib/api";
import { normalizeBooking as normalizeApiBooking } from "@/lib/model";
import { derivePaymentInfo } from "@/lib/payments";
import { useAdminAuth } from "./hooks/useAdminAuth";

import AdminHeader from "./components/AdminHeader";
import AdminSidebar from "./components/AdminSidebar";
import { AdminUIProvider } from "./context/AdminUIContext";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BookingDetailsModal } from "@/components/BookingDetailsModal";

import {
  ArrowLeft,
  Download,
  Filter,
  CalendarDays,
  DollarSign,
  Receipt,
} from "lucide-react";

const money = (n) =>
  Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

const STATUS_COLORS = {
  confirmed: "bg-emerald-100 text-emerald-800",
  completed: "bg-purple-100 text-purple-800",
  cancelled: "bg-rose-100 text-rose-800",
  pending_payment: "bg-amber-50 text-amber-700",
  expired: "bg-slate-100 text-slate-600",
  declined: "bg-orange-100 text-orange-800",
  pending: "bg-amber-100 text-amber-800",
};

function StatusPill({ status }) {
  if (!status) return null;
  const key = String(status).toLowerCase();
  const cls =
    STATUS_COLORS[key] || "bg-slate-100 text-slate-700 border border-slate-200";

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// Payment info is centralized in src/lib/payments.js

// --- small local normalization helpers ---
function toDateLike(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeBooking(b) {
  return { ...b, amount: Number(b.totalPrice || 0), paidAmount: b.amountPaid, remainingDue: b.balanceDue, refundedAmount: b.amountRefunded };
}

export default function ClientBookingsView() {
  // --- hooks (must be at top, no early returns before these) ---
  const { user, isAdmin, loading, authReason } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const search = new URLSearchParams(location.search);

  // Accept both ?email= and ?clientEmail= for compatibility
  const rawEmail =
    search.get("email") || search.get("clientEmail") || "" || "";
  const clientEmail = rawEmail; // already decoded by the browser in location.search
  const emailLower = clientEmail.toLowerCase().trim();

  // Optional name params; fall back to something from the email
  const rawName = search.get("name") || search.get("clientName") || "";
  const derivedNameFromEmail = clientEmail
    ? clientEmail.split("@")[0]
    : "client";

  const clientName = rawName || derivedNameFromEmail;

  const [bookings, setBookings] = useState([]);
  const [loadingBookings, setLoadingBookings] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortField, setSortField] = useState("startAt");
  const [sortDir, setSortDir] = useState("desc");
  const [error, setError] = useState(null);

  // Details modal state
  const [selectedBookingForDetails, setSelectedBookingForDetails] = useState(null);

  // simple date filter
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // --- load bookings for this client (auth-gated) ---
  useEffect(() => {
    const load = async () => {
      // Only load when auth is ready and user is confirmed admin
      if (loading || !isAdmin) {
        setLoadingBookings(false);
        return;
      }

      if (!emailLower) {
        setError("Missing client email.");
        setBookings([]);
        setLoadingBookings(false);
        return;
      }

      setLoadingBookings(true);
      setError(null);

      try {
        const clientId = search.get("clientId");
        const { bookings: rows } = await apiGet(`/admin/bookings${qs({ all: 1, ...(clientId ? { userId: clientId } : { email: emailLower }) })}`);
        setBookings(rows.map(normalizeApiBooking));
      } catch (e) {
        console.error("Error loading client bookings", e);
        setError(e?.message || String(e));
      } finally {
        setLoadingBookings(false);
      }
    };

    load();
  }, [emailLower, loading, isAdmin]);

  // --- metrics ---
  const metrics = useMemo(() => {
    if (!bookings.length) {
      return {
        total: 0,
        confirmed: 0,
        completed: 0,
        cancelled: 0,
        declined: 0,
        totalAmount: 0,
        avgAmount: 0,
      };
    }

    let totalAmount = 0;
    let confirmed = 0;
    let completed = 0;
    let cancelled = 0;
    let declined = 0;

    bookings.forEach((b) => {
      const status = String(b.status || "").toLowerCase();
      const amt = Number(b.totalPrice || 0);

      if (["confirmed", "completed"].includes(status)) {
        totalAmount += amt;
      }
      if (status === "confirmed") confirmed += 1;
      if (status === "completed") completed += 1;
      if (status === "cancelled" || status === "cancelled") cancelled += 1;
      if (status === "declined") declined += 1;
    });

    const total = bookings.length;
    const denom = confirmed + completed;
    const avgAmount = denom ? totalAmount / denom : 0;

    return {
      total,
      confirmed,
      completed,
      cancelled,
      declined,
      totalAmount,
      avgAmount,
    };
  }, [bookings]);

  // --- filtered + sorted bookings for table ---
  const filteredBookings = useMemo(() => {
    let rows = [...bookings];

    if (statusFilter !== "all") {
      rows = rows.filter(
        (b) => String(b.status || "").toLowerCase() === statusFilter
      );
    }

    if (fromDate) {
      const from = new Date(fromDate);
      rows = rows.filter((b) => {
        const d = b.startAt?.toDate?.() || b.scheduledAt?.toDate?.();
        return d && d >= from;
      });
    }

    if (toDate) {
      const to = new Date(toDate);
      to.setHours(23, 59, 59, 999);
      rows = rows.filter((b) => {
        const d = b.startAt?.toDate?.() || b.scheduledAt?.toDate?.();
        return d && d <= to;
      });
    }

    rows.sort((a, b) => {
      let A = a[sortField];
      let B = b[sortField];

      if (A?.toDate) A = A.toDate();
      if (B?.toDate) B = B.toDate();

      if (A instanceof Date && B instanceof Date) {
        return sortDir === "asc" ? A - B : B - A;
      }

      if (typeof A === "string") A = A.toLowerCase();
      if (typeof B === "string") B = B.toLowerCase();

      if (A < B) return sortDir === "asc" ? -1 : 1;
      if (A > B) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return rows;
  }, [bookings, statusFilter, sortField, sortDir, fromDate, toDate]);

  // --- timeline (oldest → newest) ---
  const timeline = useMemo(() => {
    const rows = [...bookings];
    rows.sort((a, b) => {
      const aD = a.startAt?.toMillis?.() || 0;
      const bD = b.startAt?.toMillis?.() || 0;
      return aD - bD;
    });
    return rows;
  }, [bookings]);

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const exportCsv = () => {
    if (!filteredBookings.length) return;

    const headers = [
      "Service",
      "Date",
      "Amount",
      "Status",
      "Payment Status",
      "Payment Method",
    ];
    const rows = filteredBookings.map((b) => {
      const start =
        b.startAt?.toDate?.() || b.scheduledAt?.toDate?.() || null;
      const dateStr = start ? start.toLocaleString() : "";
      const service = b.serviceName || b.service || "";
      const amt = Number(b.totalPrice || 0);
      const status = b.status || "";
      const payment = derivePaymentInfo(normalizeBooking(b));
      return [
        service,
        dateStr,
        amt,
        status,
        payment.paymentStatusLabel,
        payment.methodLabel,
      ];
    });

    const csvContent = [headers, ...rows]
      .map((row) =>
        row
          .map((cell) => {
            const val = String(cell ?? "");
            if (val.includes(",") || val.includes('"')) {
              return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
          })
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName =
      clientName.toLowerCase().replace(/[^a-z0-9]+/gi, "-") || "client";
    a.href = url;
    a.download = `${safeName}-bookings.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const backToClients = () => {
    navigate("/admin");
  };

  const headerCell = (field, label) => (
    <th
      className="py-2 px-3 text-left text-xs font-semibold text-plum/70 uppercase tracking-wide cursor-pointer select-none hover:text-plum"
      onClick={() => toggleSort(field)}
    >
      <div className="flex items-center gap-1">
        {label}
        {sortField === field && (
          <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>
        )}
      </div>
    </th>
  );

  // --- auth/loading guards AFTER all hooks ---
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
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FCEFF6]">
        <div className="text-[#431039] text-sm font-medium">
          Admin access required
          {import.meta.env.DEV && authReason ? (
            <span className="block text-xs text-plum/70">Reason: {authReason}</span>
          ) : null}
        </div>
      </div>
    );
  }

  // --- main render ---
  return (
    <AdminUIProvider>
      <div className="min-h-screen flex bg-[#FFF7FB]">
        <AdminSidebar
          activeView="clients"
          onChangeView={() => navigate("/admin")}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <AdminHeader activeView="clients" user={user} />

          <main className="flex-1 px-6 py-4 lg:px-10 lg:py-6 bg-[#FFF7FB]">
            {/* Back link */}
            <button
              type="button"
              onClick={() =>
                navigate("/admin", {
                  state: {
                    initialView: "clients",
                    activeView: "clients",
                  },
                })
              }
              className="inline-flex items-center gap-2 text-sm text-plum mb-4 hover:text-[#5a1750] transition-colors group"
            >
              <ArrowLeft
                size={16}
                className="translate-x-0 group-hover:-translate-x-0.5 transition-transform"
              />
              <span>Back to clients</span>
            </button>

            {/* Page title + client info */}
            <section className="mb-6">
              <h1 className="text-2xl font-semibold text-plum mb-2">
                All bookings for{" "}
                <span className="capitalize">
                  {clientName || "client"}
                </span>
              </h1>
              <p className="text-sm text-plum/80">
                Email:{" "}
                <span className="font-medium">{clientEmail || "—"}</span>
              </p>
            </section>

            {/* Top row: summary + timeline */}
            <div className="grid grid-cols-1 xl:grid-cols-[2fr,1.4fr] gap-5 mb-6">
              {/* Summary card */}
              <div className="bg-white rounded-xl border shadow-sm p-4">
                <div className="flex flex-wrap gap-3 items-center justify-between mb-4">
                  <div className="flex items-center gap-2 text-sm text-plum/80">
                    <Receipt size={18} className="text-plum" />
                    <span>
                      {metrics.total} total booking
                      {metrics.total === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="text-xs flex items-center gap-1 hover:bg-plum/5"
                      onClick={exportCsv}
                      disabled={!filteredBookings.length}
                    >
                      <Download size={14} />
                      Export CSV
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div className="bg-plum/5 rounded-lg px-3 py-2 flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs text-plum/70">
                      <DollarSign size={14} />
                      <span>Total value</span>
                    </div>
                    <div className="text-lg font-semibold text-plum">
                      {money(metrics.totalAmount)}
                    </div>
                    <p className="text-[11px] text-plum/70">
                      Confirmed + completed only
                    </p>
                  </div>

                  <div className="bg-emerald-50 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-emerald-800/80">
                      <CalendarDays size={14} />
                      <span>Completed</span>
                    </div>
                    <div className="text-lg font-semibold text-emerald-900">
                      {metrics.completed}
                    </div>
                    <p className="text-[11px] text-emerald-800/80">
                      {metrics.confirmed} currently confirmed
                    </p>
                  </div>

                  <div className="bg-rose-50 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-rose-800/80">
                      <Filter size={14} />
                      <span>Cancelled / declined</span>
                    </div>
                    <div className="text-lg font-semibold text-rose-900">
                      {metrics.cancelled + metrics.declined}
                    </div>
                    <p className="text-[11px] text-rose-800/80">
                      {metrics.cancelled} cancelled · {metrics.declined} declined
                    </p>
                  </div>
                </div>

                {metrics.avgAmount > 0 && (
                  <p className="mt-3 text-xs text-plum/70">
                    Average completed booking value:{" "}
                    <span className="font-semibold">
                      {money(metrics.avgAmount)}
                    </span>
                  </p>
                )}
              </div>

              {/* Timeline card */}
              <div className="bg-white rounded-xl border shadow-sm p-4">
                <h2 className="text-sm font-semibold text-plum mb-2">
                  Booking timeline
                </h2>
                {timeline.length === 0 ? (
                  <p className="text-xs text-plum/60">
                    This client has no booking history yet.
                  </p>
                ) : (
                  <ol className="relative border-l border-plum/10 ml-3 max-h-56 overflow-auto pr-2">
                    {timeline.map((b) => {
                      const start =
                        b.startAt?.toDate?.() || b.scheduledAt?.toDate?.();
                      const dateStr = start
                        ? start.toLocaleDateString()
                        : "—";
                      const timeStr = start
                        ? start.toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "";
                      const service = b.serviceName || b.service || "Service";
                      const status = String(b.status || "").toLowerCase();
                      const dotColor =
                        status === "completed"
                          ? "bg-purple-500"
                          : status === "confirmed"
                          ? "bg-emerald-500"
                          : status === "declined"
                          ? "bg-orange-500"
                          : status === "cancelled" || status === "cancelled"
                          ? "bg-rose-500"
                          : "bg-slate-400";

                      return (
                        <li key={b.id} className="mb-3 ml-4 relative">
                          <span
                            className={`absolute -left-[9px] mt-1 w-2 h-2 rounded-full ${dotColor}`}
                          />
                          <div className="text-xs text-plum/60">
                            {dateStr} · {timeStr}
                          </div>
                          <div className="text-sm font-medium text-plum">
                            {service}
                          </div>
                          <div className="flex items-center justify-between text-xs text-plum/70">
                            <StatusPill status={b.status} />
                            <span>{money(b.amount || 0)}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </div>

            {/* Filters row */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div className="flex flex-wrap gap-2 text-xs">
                {[
                  ["all", "All"],
                  ["confirmed", "Confirmed"],
                  ["completed", "Completed"],
                  ["cancelled", "Cancelled"],
                  ["declined", "Declined"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setStatusFilter(value)}
                    className={`px-3 py-1 rounded-full border text-xs font-medium transition-colors ${
                      statusFilter === value
                        ? "bg-[#431039] text-white border-[#431039] shadow-sm"
                        : "bg-white text-plum/75 border-plum/15 hover:bg-plum/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="text-plum/60">From</span>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="h-8 w-32 text-xs bg-white"
                />
                <span className="text-plum/60">to</span>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="h-8 w-32 text-xs bg-white"
                />
                {(fromDate || toDate) && (
                  <button
                    type="button"
                    onClick={() => {
                      setFromDate("");
                      setToDate("");
                    }}
                    className="text-plum/60 hover:text-plum text-xs underline-offset-2 hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Table card */}
            <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
              {loadingBookings ? (
                <div className="p-6 text-sm text-plum/60">
                  Loading bookings…
                </div>
              ) : error ? (
                <div className="p-6 text-sm text-rose-700 bg-rose-50">
                  {error}
                </div>
              ) : filteredBookings.length === 0 ? (
                <div className="p-6 text-sm text-plum/60">
                  No bookings match these filters for this client.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[840px]">
                    <thead className="sticky top-0 bg-white z-10 border-b">
                      <tr className="text-plum/70">
                        {headerCell("serviceName", "Service")}
                        {headerCell("startAt", "Date")}
                        {headerCell("amount", "Amount")}
                          <th className="py-2 px-3 text-left text-xs font-semibold text-plum/70 uppercase tracking-wide">
                            Status
                          </th>
                          <th className="py-2 px-3 text-left text-xs font-semibold text-plum/70 uppercase tracking-wide">
                            Payment
                          </th>
                          <th className="py-2 px-3 text-left text-xs font-semibold text-plum/70 uppercase tracking-wide">
                            Details
                          </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredBookings.map((b) => {
                        const start =
                          b.startAt?.toDate?.() || b.scheduledAt?.toDate?.();
                        const dateStr = start
                          ? start.toLocaleString()
                          : "—";
                        const status = b.status || "—";
                        const service =
                          b.serviceName || b.service || "Residential Cleaning";
                        const payment = derivePaymentInfo(normalizeBooking(b));

                        return (
                          <tr
                            key={b.id}
                            className="border-b last:border-b-0 hover:bg-plum/5 transition-colors"
                          >
                            <td className="py-3 px-3 text-plum">
                              {service}
                            </td>
                            <td className="py-3 px-3 text-plum/80">
                              {dateStr}
                            </td>
                            <td className="py-3 px-3 text-plum">
                              {money(b.amount || 0)}
                            </td>
                            <td className="py-3 px-3">
                              <StatusPill status={status} />
                            </td>
                            <td className="py-3 px-3 text-xs text-plum/80">
                              <div className="flex flex-col gap-0.5">
                                <span className="font-medium text-plum">
                                  {payment.paymentStatusLabel}
                                </span>
                                <span className="text-plum/70">
                                  Method: {payment.methodLabel}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-3">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs border-plum/40 text-plum hover:bg-plum/5"
                                onClick={() => setSelectedBookingForDetails(b)}
                              >
                                View
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </main>

              {/* Booking details modal */}
              <BookingDetailsModal
                open={!!selectedBookingForDetails}
                booking={selectedBookingForDetails}
                onClose={() => setSelectedBookingForDetails(null)}
              />
        </div>
      </div>
    </AdminUIProvider>
  );
}

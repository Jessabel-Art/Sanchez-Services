// src/pages/admin/BookingsView.jsx — all bookings with filters, CSV export, and the shared booking detail panel.
import React, { useContext, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Download, Filter, UserCircle2, MapPin, CalendarDays, ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";

import StatusPill from "./components/StatusPill";
import EmptyState from "./components/EmptyState";
import FabNewBooking from "./components/FabNewBooking";
import { BookingModal } from "./components/BookingModal";
import BookingDetailModal from "./components/BookingDetailModal";
import { AdminUIContext } from "./context/AdminUIContext";
import { csvDownload, useSortableRows } from "./utils";
import { apiGet, qs } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { normalizeBooking, fmtDate, fmtTime, formatMoney, paymentStatusLabel, statusLabel, toMillis } from "@/lib/model";

const STATUS_FILTERS = [
  { id: "all", label: "All statuses" },
  { id: "pending_payment", label: "Awaiting deposit" },
  { id: "pending", label: "Pending" },
  { id: "confirmed", label: "Confirmed" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "declined", label: "Declined" },
  { id: "expired", label: "Expired" },
];
const RANGE_OPTIONS = [
  { id: "upcoming", label: "Upcoming" },
  { id: "past", label: "Past" },
  { id: "all", label: "All dates" },
];
const PAGE_SIZE = 25;

const COLUMNS = [
  { key: "bookingDate", accessor: (b) => toMillis(b.startAt), defaultDirection: "asc" },
  { key: "status", accessor: (b) => b.status },
  { key: "customerName", accessor: (b) => b.clientName },
  { key: "serviceType", accessor: (b) => b.serviceName },
  { key: "estimateTotal", accessor: (b) => b.totalPrice, defaultDirection: "desc" },
  { key: "balance", accessor: (b) => b.balanceDue, defaultDirection: "desc" },
  { key: "createdDate", accessor: (b) => toMillis(b.createdAt), defaultDirection: "desc" },
];

export default function BookingsView() {
  const { searchTerm, setSearchTerm } = useContext(AdminUIContext);
  const [statusFilter, setStatusFilter] = useState("all");
  const [rangeFilter, setRangeFilter] = useState("upcoming");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [newOpen, setNewOpen] = useState(false);

  const q = useApiQuery(
    async () =>
      (await apiGet(`/admin/bookings${qs({ all: 1, status: statusFilter === "all" ? "" : statusFilter })}`)).bookings.map(normalizeBooking),
    [statusFilter]
  );

  const filtered = useMemo(() => {
    const now = Date.now();
    const term = (searchTerm || "").trim().toLowerCase();
    return (q.data || []).filter((b) => {
      const t = toMillis(b.startAt);
      if (rangeFilter === "upcoming" && t < now - 3 * 3600 * 1000) return false;
      if (rangeFilter === "past" && t >= now) return false;
      if (!term) return true;
      return [b.clientName, b.contact?.email, b.contact?.phone, b.addressText, b.serviceName, b.invoiceNumber, b.id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term));
    });
  }, [q.data, rangeFilter, searchTerm]);

  const { sortedRows, sortConfig, requestSort } = useSortableRows(filtered, COLUMNS, {
    key: "bookingDate",
    direction: rangeFilter === "past" ? "desc" : "asc",
  });
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = sortedRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const exportCsv = () => {
    const header = ["Invoice", "Date", "Time", "Status", "Client", "Email", "Phone", "Service", "Address", "Total", "Paid", "Balance", "Payment status"];
    csvDownload(
      `bookings-${new Date().toISOString().slice(0, 10)}.csv`,
      sortedRows.map((b) => ({
        Invoice: b.invoiceNumber,
        Date: fmtDate(b.startAt),
        Time: fmtTime(b.startAt),
        Status: statusLabel(b.status),
        Client: b.clientName,
        Email: b.contact?.email,
        Phone: b.contact?.phone,
        Service: b.serviceName,
        Address: b.addressText,
        Total: b.totalPrice.toFixed(2),
        Paid: b.amountPaid.toFixed(2),
        Balance: b.balanceDue.toFixed(2),
        "Payment status": paymentStatusLabel(b.paymentStatus),
      })),
      header
    );
  };

  const SortHeader = ({ sortKey, children, align }) => (
    <button
      type="button"
      onClick={() => requestSort(sortKey)}
      className={`inline-flex items-center gap-1 uppercase ${align === "right" ? "justify-end w-full" : ""}`}
      aria-label={`Sort by ${children}`}
    >
      {children}
      {sortConfig?.key === sortKey ? (sortConfig.direction === "asc" ? "▲" : "▼") : ""}
    </button>
  );

  return (
    <>
      <Card className="border-[#F1D8E8] rounded-2xl">
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="text-base text-[#431039]">Bookings</CardTitle>
            <p className="text-xs text-gray-500 mt-1">View, filter, and export all booking requests.</p>
          </div>
          <div className="flex flex-col md:flex-row md:items-center gap-3 w-full md:w-auto md:justify-end">
            <div className="w-full md:w-64">
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm && setSearchTerm(e.target.value)}
                placeholder="Search bookings, clients, addresses"
                className="h-9 bg-white text-xs text-[#431039] placeholder:text-[#B989AF] border border-[#F1D8E8] rounded-full px-3"
                aria-label="Search bookings by client, service, or address"
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="hidden sm:flex items-center text-[11px] text-gray-500">
                <Filter className="w-3 h-3 mr-1" aria-hidden="true" />
                Filters
              </div>
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
                <SelectTrigger className="h-8 w-[150px] text-xs bg-white" aria-label="Filter bookings by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-white border border-[#F1D8E8] shadow-lg">
                  {STATUS_FILTERS.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={rangeFilter} onValueChange={(v) => { setRangeFilter(v); setPage(0); }}>
                <SelectTrigger className="h-8 w-[130px] text-xs bg-white" aria-label="Filter bookings by date range">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-white border border-[#F1D8E8] shadow-lg">
                  {RANGE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" className="text-xs gap-1 bg-white" onClick={exportCsv} aria-label="Export bookings as CSV file">
                <Download className="w-3 h-3" aria-hidden="true" />
                Export CSV
              </Button>
              <Button size="sm" className="bg-[#E2A82B] text-[#431039] hover:bg-[#F0BA3E] text-xs" onClick={() => setNewOpen(true)}>
                + New booking
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="border-t border-[#F1D8E8]" />
          {q.error && <p className="px-4 py-3 text-xs text-rose-700" role="alert">{q.error.message}</p>}
          {q.loading && !q.data ? (
            <div className="py-10 text-center text-xs text-gray-500">Loading bookings…</div>
          ) : rows.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={CalendarDays}
                title="No bookings match your filters"
                description="Try changing the status or date range, or create a new booking manually."
                actionLabel="Create booking"
                onAction={() => setNewOpen(true)}
              />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="bg-[#431039] text-[11px] text-white uppercase tracking-wide">
                      <th className="px-4 py-2 text-left font-semibold"><SortHeader sortKey="bookingDate">Date</SortHeader></th>
                      <th className="px-4 py-2 text-left font-semibold"><SortHeader sortKey="status">Status</SortHeader></th>
                      <th className="px-4 py-2 text-left font-semibold"><SortHeader sortKey="customerName">Client</SortHeader></th>
                      <th className="px-4 py-2 text-left font-semibold"><SortHeader sortKey="serviceType">Service</SortHeader></th>
                      <th className="px-4 py-2 text-right font-semibold"><SortHeader sortKey="estimateTotal" align="right">Amount</SortHeader></th>
                      <th className="px-4 py-2 text-right font-semibold"><SortHeader sortKey="balance" align="right">Balance</SortHeader></th>
                      <th className="px-4 py-2 text-left font-semibold">Address</th>
                      <th className="px-4 py-2 text-left font-semibold"><SortHeader sortKey="createdDate">Created</SortHeader></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b, idx) => (
                      <tr
                        key={b.id}
                        tabIndex={0}
                        onClick={() => setOpenId(b.id)}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpenId(b.id)}
                        className={`cursor-pointer border-t border-[#F7E5F0] hover:bg-[#FFF1FA] focus:outline-none focus:bg-[#FFF1FA] ${idx % 2 === 1 ? "bg-white" : "bg-[#FFFCFE]"}`}
                        aria-label={`Open booking ${b.invoiceNumber} for ${b.clientName}`}
                      >
                        <td className="px-4 py-2 align-top whitespace-nowrap">
                          <span className="font-medium text-[#431039] block">{fmtDate(b.startAt)}</span>
                          <span className="text-[11px] text-gray-500">{fmtTime(b.startAt)} · #{b.invoiceNumber}</span>
                        </td>
                        <td className="px-4 py-2 align-top whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            {b.status === "pending_payment" ? (
                              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200">Awaiting deposit</span>
                            ) : b.status === "expired" ? (
                              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-50 text-slate-500 border border-slate-200">Expired</span>
                            ) : (
                              <StatusPill status={b.status} />
                            )}
                            {b.needsAttention && <AlertTriangle className="w-3.5 h-3.5 text-amber-600" aria-label="Needs attention" />}
                          </div>
                        </td>
                        <td className="px-4 py-2 align-top min-w-[140px]">
                          <div className="flex items-center gap-2">
                            <UserCircle2 className="w-4 h-4 text-[#B34A87]" aria-hidden="true" />
                            <span className="text-[#431039]">{b.clientName}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2 align-top min-w-[130px] text-[#6C3A63]">{b.serviceName}</td>
                        <td className="px-4 py-2 align-top text-right whitespace-nowrap text-[#431039]">{formatMoney(b.totalPrice)}</td>
                        <td className="px-4 py-2 align-top text-right whitespace-nowrap">
                          <span className={b.balanceDue > 0 ? "text-rose-700" : "text-emerald-700"}>{formatMoney(b.balanceDue)}</span>
                          <span className="block text-[10px] text-gray-500">{paymentStatusLabel(b.paymentStatus)}</span>
                        </td>
                        <td className="px-4 py-2 align-top min-w-[180px] text-[#6C3A63]">
                          <span className="flex items-start gap-1">
                            <MapPin className="w-3 h-3 mt-0.5 shrink-0 text-[#B34A87]" aria-hidden="true" />
                            {b.addressText}
                          </span>
                        </td>
                        <td className="px-4 py-2 align-top whitespace-nowrap text-gray-500">{fmtDate(b.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-4 py-3 text-xs text-gray-500 border-t border-[#F1D8E8]">
                <span>
                  {sortedRows.length} booking{sortedRows.length === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span>
                    Page {safePage + 1} of {pageCount}
                  </span>
                  <Button variant="ghost" size="sm" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)} aria-label="Next page">
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <FabNewBooking onClick={() => setNewOpen(true)} />
      <BookingModal open={newOpen} initial={null} onClose={() => setNewOpen(false)} onSave={(b) => b && setOpenId(b.id)} />
      <BookingDetailModal bookingId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

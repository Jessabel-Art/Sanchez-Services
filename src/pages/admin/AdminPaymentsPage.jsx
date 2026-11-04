// src/pages/admin/AdminPaymentsPage.jsx — payments ledger (every payment/refund) + outstanding balances.
// Totals come from the server ledger; refunds/voids/manual payments are done in the booking detail panel.
import React, { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { CreditCard, FileDown, DollarSign, AlertCircle, RefreshCw, Receipt } from "lucide-react";
import BookingDetailModal from "./components/BookingDetailModal";
import { csvDownload, rangePreset } from "./utils";
import { apiGet, qs } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { normalizeBooking, fmtDate, formatMoney, methodLabel, paymentStatusLabel, toMillis, METHOD_LABELS } from "@/lib/model";

const PRESETS = [
  { id: "30d", label: "Last 30 days" },
  { id: "7d", label: "Last 7 days" },
  { id: "qtr", label: "This quarter" },
  { id: "year", label: "This year" },
];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function Kpi({ label, value, icon: Icon, tone = "text-plum", note }) {
  return (
    <div className="bg-white border border-[#F1D8E8] rounded-2xl px-4 py-3 flex flex-col gap-1 shadow-sm">
      <div className="flex items-center justify-between text-[11px] text-plum/70">
        <span>{label}</span>
        <Icon className="w-4 h-4 text-gold" aria-hidden="true" />
      </div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      {note && <p className="text-[11px] text-plum/60">{note}</p>}
    </div>
  );
}

export default function AdminPaymentsPage() {
  const [preset, setPreset] = useState("30d");
  const [method, setMethod] = useState("all");
  const [tab, setTab] = useState("ledger");
  const [openId, setOpenId] = useState(null);
  const { from, to } = rangePreset(preset);
  const range = { from: ymd(from), to: ymd(to) };

  const ledgerQ = useApiQuery(() => apiGet(`/admin/payments${qs(range)}`), [range.from, range.to]);
  const openQ = useApiQuery(
    async () => (await apiGet(`/admin/bookings${qs({ all: 1 })}`)).bookings.map(normalizeBooking),
    [],
    { enabled: tab === "outstanding" }
  );

  const payments = useMemo(
    () => (ledgerQ.data?.payments || []).filter((p) => method === "all" || p.method === method),
    [ledgerQ.data, method]
  );
  const outstanding = useMemo(
    () =>
      (openQ.data || [])
        .filter((b) => ["pending_payment", "pending", "confirmed", "completed"].includes(b.status) && b.balanceDue > 0.004)
        .sort((a, b) => toMillis(a.startAt) - toMillis(b.startAt)),
    [openQ.data]
  );
  const totals = ledgerQ.data?.totals;

  const exportCsv = () => {
    const header = ["Date", "Type", "Method", "Purpose", "Amount", "Card fee", "Status", "Source", "Invoice", "Client", "Service", "Appointment", "Note"];
    csvDownload(
      `payments-${range.from}-to-${range.to}.csv`,
      payments.map((p) => ({
        Date: fmtDate(p.paidAt),
        Type: p.type,
        Method: methodLabel(p.method),
        Purpose: p.purpose,
        Amount: (p.type === "refund" ? -p.amount : p.amount).toFixed(2),
        "Card fee": p.fee.toFixed(2),
        Status: p.status,
        Source: p.source,
        Invoice: p.invoiceNumber,
        Client: p.clientName,
        Service: p.serviceName,
        Appointment: fmtDate(p.appointmentAt),
        Note: p.note || "",
      })),
      header
    );
  };

  return (
    <div className="flex-1">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-5">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-plum/60 font-semibold">Admin billing</p>
          <h1 className="text-2xl md:text-3xl font-bold text-plum">Payments &amp; Deposits</h1>
          <p className="text-xs md:text-sm text-plum/70 max-w-xl">Every card, cash and transfer payment and refund, from the payment ledger.</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={preset} onValueChange={setPreset}>
            <SelectTrigger className="h-8 w-[150px] text-xs bg-white rounded-full" aria-label="Date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-white border border-[#F1D8E8] shadow-lg">
              {PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="flex items-center gap-2 rounded-full" onClick={exportCsv} disabled={!payments.length}>
            <FileDown className="w-4 h-4" aria-hidden="true" />
            Export CSV
          </Button>
        </div>
      </div>

      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
        <Kpi label="Collected" icon={DollarSign} value={formatMoney(totals?.collected)} note={`${range.from} → ${range.to}`} />
        <Kpi label="Refunded" icon={RefreshCw} value={formatMoney(totals?.refunded)} note={`Net ${formatMoney(totals?.net)}`} />
        <Kpi label="Card fees passed to clients" icon={CreditCard} value={formatMoney(totals?.fees)} />
        <Kpi
          label="Outstanding balances (all dates)"
          icon={AlertCircle}
          tone="text-rose-700"
          value={formatMoney(ledgerQ.data?.outstanding?.amount)}
          note={`${ledgerQ.data?.outstanding?.bookings ?? 0} booking(s)`}
        />
      </section>

      {totals?.byMethod && Object.keys(totals.byMethod).length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 text-[11px]">
          {Object.entries(totals.byMethod).map(([m, v]) => (
            <span key={m} className="rounded-full bg-white border border-[#F1D8E8] px-3 py-1 text-plum">
              {methodLabel(m)}: <strong>{formatMoney(v)}</strong>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2 mb-3" role="tablist">
        {[
          ["ledger", "Ledger"],
          ["outstanding", "Outstanding balances"],
        ].map(([id, label]) => (
          <Button
            key={id}
            role="tab"
            aria-selected={tab === id}
            variant="ghost"
            onClick={() => setTab(id)}
            className={`rounded-full text-xs ${tab === id ? "bg-[#431039] text-white" : "text-plum"}`}
          >
            {label}
          </Button>
        ))}
        {tab === "ledger" && (
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger className="h-8 w-[140px] text-xs bg-white rounded-full ml-auto" aria-label="Filter by method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-white border border-[#F1D8E8] shadow-lg">
              <SelectItem value="all">All methods</SelectItem>
              {Object.entries(METHOD_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <Card className="bg-white border-[#F1D8E8] rounded-2xl shadow-sm overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-center gap-2 bg-[#431039] text-white border-b border-[#2b0a24]">
          <CardTitle className="flex items-center gap-2 text-white text-sm md:text-base">
            <Receipt className="w-5 h-5 text-gold" aria-hidden="true" />
            <span>{tab === "ledger" ? "Payment ledger" : "Bookings with a balance due"}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {(tab === "ledger" ? ledgerQ : openQ).error && (
            <p className="p-4 text-xs text-rose-700" role="alert">
              {(tab === "ledger" ? ledgerQ : openQ).error.message}
            </p>
          )}
          {tab === "ledger" ? (
            ledgerQ.loading && !ledgerQ.data ? (
              <p className="p-6 text-center text-xs text-plum/60">Loading…</p>
            ) : payments.length === 0 ? (
              <p className="p-6 text-center text-xs text-plum/60">No payments in this period.</p>
            ) : (
              <table className="min-w-full text-xs">
                <thead className="bg-[#FBE9F5] text-[11px] uppercase tracking-[0.08em] text-plum/60">
                  <tr>
                    <th className="px-4 py-2 text-left">Date</th>
                    <th className="px-4 py-2 text-left">Client</th>
                    <th className="px-4 py-2 text-left">Booking</th>
                    <th className="px-4 py-2 text-left">Method</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                    <th className="px-4 py-2 text-left">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr
                      key={p.id}
                      tabIndex={0}
                      onClick={() => setOpenId(p.bookingId)}
                      onKeyDown={(e) => e.key === "Enter" && setOpenId(p.bookingId)}
                      className={`border-t border-[#F7E5F0] hover:bg-[#FFF1FA] cursor-pointer ${p.status === "voided" ? "opacity-50 line-through" : ""}`}
                    >
                      <td className="px-4 py-2 whitespace-nowrap">{fmtDate(p.paidAt)}</td>
                      <td className="px-4 py-2">{p.clientName}</td>
                      <td className="px-4 py-2">
                        #{p.invoiceNumber} · {p.serviceName}
                        <span className="block text-[10px] text-plum/60">Appointment {fmtDate(p.appointmentAt)}</span>
                      </td>
                      <td className="px-4 py-2">
                        {p.type === "refund" ? "Refund" : `${methodLabel(p.method)} · ${p.purpose}`}
                      </td>
                      <td className={`px-4 py-2 text-right whitespace-nowrap ${p.type === "refund" ? "text-rose-700" : "text-emerald-700"}`}>
                        {p.type === "refund" ? "−" : ""}
                        {formatMoney(p.amount)}
                        {p.fee > 0 && <span className="block text-[10px] text-plum/50">+{formatMoney(p.fee)} fee</span>}
                      </td>
                      <td className="px-4 py-2 text-plum/70">{p.source}{p.note ? ` · ${p.note}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : openQ.loading && !openQ.data ? (
            <p className="p-6 text-center text-xs text-plum/60">Loading…</p>
          ) : outstanding.length === 0 ? (
            <p className="p-6 text-center text-xs text-plum/60">No outstanding balances.</p>
          ) : (
            <table className="min-w-full text-xs">
              <thead className="bg-[#FBE9F5] text-[11px] uppercase tracking-[0.08em] text-plum/60">
                <tr>
                  <th className="px-4 py-2 text-left">Appointment</th>
                  <th className="px-4 py-2 text-left">Client</th>
                  <th className="px-4 py-2 text-left">Service</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Paid</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="px-4 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {outstanding.map((b) => (
                  <tr key={b.id} tabIndex={0} onClick={() => setOpenId(b.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(b.id)} className="border-t border-[#F7E5F0] hover:bg-[#FFF1FA] cursor-pointer">
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDate(b.startAt)}</td>
                    <td className="px-4 py-2">{b.clientName}</td>
                    <td className="px-4 py-2">#{b.invoiceNumber} · {b.serviceName}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(b.totalPrice)}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(b.amountPaid)}</td>
                    <td className="px-4 py-2 text-right text-rose-700">{formatMoney(b.balanceDue)}</td>
                    <td className="px-4 py-2">{paymentStatusLabel(b.paymentStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <BookingDetailModal bookingId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

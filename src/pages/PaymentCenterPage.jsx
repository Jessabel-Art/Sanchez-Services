// src/pages/PaymentCenterPage.jsx — client payments: balances, card checkout, payment history, invoices.
// All amounts come from the server ledger; nothing is recalculated in the browser.
import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { CreditCard, FileText, Download, Receipt, Loader2, CalendarDays } from "lucide-react";
import PaymentInstructions from "@/components/portal/PaymentInstructions";
import { apiGet, apiPost } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { normalizeBooking, fmtDate, fmtTime, formatMoney, statusLabel, paymentStatusLabel, methodLabel, toMillis } from "@/lib/model";
import { buildInvoiceCsvRows, downloadCsv, openInvoiceWindow } from "@/lib/payments";
import { OFFLINE_PAYMENT } from "@/data/paymentMethods";
import logoPrimary from "@/assets/logo/logo-primary.png";

const pill = {
  paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  deposit_paid: "bg-amber-50 text-amber-700 border-amber-200",
  unpaid: "bg-rose-50 text-rose-700 border-rose-200",
  refunded: "bg-slate-100 text-slate-700 border-slate-200",
  not_required: "bg-slate-50 text-slate-600 border-slate-200",
};

export default function PaymentCenterPage() {
  const { toast } = useToast();
  const [paying, setPaying] = useState(null);
  const [openId, setOpenId] = useState(null);
  const bookingsQ = useApiQuery(async () => (await apiGet("/me/bookings")).bookings.map(normalizeBooking), []);
  const catalogQ = useApiQuery(() => apiGet("/catalog"), [], { poll: false });
  const detailQ = useApiQuery(
    async () => (openId ? normalizeBooking((await apiGet(`/bookings/${encodeURIComponent(openId)}`)).booking) : null),
    [openId],
    { enabled: !!openId }
  );

  const bookings = useMemo(() => bookingsQ.data || [], [bookingsQ.data]);
  const billable = useMemo(() => bookings.filter((b) => b.status !== "expired" && (b.totalPrice > 0 || b.amountPaid !== 0)), [bookings]);
  const due = billable
    .filter((b) => b.permissions?.canPayDeposit || b.permissions?.canPayBalance)
    .sort((a, b) => toMillis(a.startAt) - toMillis(b.startAt));
  const totals = useMemo(
    () => ({
      paid: billable.reduce((s, b) => s + b.amountPaid, 0),
      outstanding: billable.filter((b) => !["cancelled", "declined"].includes(b.status)).reduce((s, b) => s + b.balanceDue, 0),
    }),
    [billable]
  );

  const pay = async (b) => {
    const purpose = b.permissions?.canPayDeposit ? "deposit" : "balance";
    setPaying(b.id);
    try {
      const { checkoutUrl } = await apiPost(`/bookings/${encodeURIComponent(b.id)}/checkout`, { purpose });
      window.location.href = checkoutUrl;
    } catch (e) {
      toast({ title: "Could not start payment", description: e.message, variant: "destructive" });
      setPaying(null);
    }
  };

  const invoice = (b, format) => {
    const fetchInv = async () => (await apiGet(`/bookings/${encodeURIComponent(b.id)}/invoice`)).invoice;
    const onErr = (e) => toast({ title: "Could not open invoice", description: e.message, variant: "destructive" });
    if (format === "csv") {
      fetchInv().then((inv) => downloadCsv(buildInvoiceCsvRows(inv), `invoice-${inv.invoiceNumber}.csv`)).catch(onErr);
      return;
    }
    openInvoiceWindow(fetchInv, logoPrimary).catch(onErr);
  };

  if (bookingsQ.loading && !bookingsQ.data) {
    return (
      <div className="py-16 flex items-center justify-center text-plum/70" role="status">
        <Loader2 className="h-5 w-5 animate-spin mr-2 text-gold" aria-hidden="true" /> Loading payments…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {bookingsQ.error && <p className="text-sm text-rose-700" role="alert">{bookingsQ.error.message}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className="border-plum/10 bg-white">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wide text-plum/60">Total paid</p>
            <p className="text-2xl font-bold text-plum mt-1">{formatMoney(totals.paid)}</p>
          </CardContent>
        </Card>
        <Card className="border-plum/10 bg-white">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wide text-plum/60">Outstanding balance</p>
            <p className="text-2xl font-bold text-plum mt-1">{formatMoney(totals.outstanding)}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-plum/10 bg-white">
        <CardHeader>
          <CardTitle className="text-plum flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-gold" aria-hidden="true" /> Payments due
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {due.length === 0 ? (
            <p className="text-sm text-plum/70">You’re all caught up — nothing is due right now.</p>
          ) : (
            due.map((b) => (
              <div key={b.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-plum/10 p-4">
                <div>
                  <p className="font-semibold text-plum">{b.serviceName}</p>
                  <p className="text-sm text-plum/70">{fmtDate(b.startAt)} · {fmtTime(b.startAt)} · #{b.invoiceNumber}</p>
                  <p className="text-sm text-plum/80 mt-1">
                    {b.permissions.canPayDeposit ? `Deposit due: ${formatMoney(b.depositDue)}` : `Balance due: ${formatMoney(b.balanceDue)}`}
                  </p>
                </div>
                <Button onClick={() => pay(b)} disabled={paying === b.id} className="bg-gold hover:bg-gold/90 text-white rounded-full">
                  {paying === b.id ? "Opening checkout…" : b.permissions.canPayDeposit ? "Pay deposit" : "Pay balance"}
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-plum/10 bg-white">
        <CardHeader>
          <CardTitle className="text-plum flex items-center gap-2">
            <Receipt className="h-5 w-5 text-gold" aria-hidden="true" /> Billing history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {billable.length === 0 ? (
            <p className="text-sm text-plum/70">
              No bookings yet. <Link className="text-gold underline" to="/book">Book a cleaning</Link>
            </p>
          ) : (
            <div className="divide-y divide-plum/10">
              {billable.map((b) => (
                <div key={b.id} className="py-3">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                    <button type="button" className="text-left" onClick={() => setOpenId(openId === b.id ? null : b.id)} aria-expanded={openId === b.id}>
                      <p className="font-medium text-plum">
                        {b.serviceName} <span className="text-xs text-plum/60">#{b.invoiceNumber}</span>
                      </p>
                      <p className="text-xs text-plum/70 flex items-center gap-1">
                        <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                        {fmtDate(b.startAt)} · {statusLabel(b.status)}
                      </p>
                    </button>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-plum">{formatMoney(b.amountPaid)} / {formatMoney(b.totalPrice)}</span>
                      <span className={`text-xs border rounded-full px-2 py-0.5 ${pill[b.paymentStatus] || pill.unpaid}`}>{paymentStatusLabel(b.paymentStatus)}</span>
                      <Button size="sm" variant="outline" className="border-plum/30 text-plum" onClick={() => invoice(b, "pdf")}>
                        <FileText className="h-4 w-4 mr-1" aria-hidden="true" />
                        Invoice
                      </Button>
                      <Button size="sm" variant="ghost" className="text-plum/70" onClick={() => invoice(b, "csv")} aria-label={`Download CSV for ${b.invoiceNumber}`}>
                        <Download className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  {openId === b.id && (
                    <div className="mt-3 rounded-lg bg-plum/5 p-3 text-sm">
                      {detailQ.loading && !detailQ.data ? (
                        <p className="text-plum/60">Loading…</p>
                      ) : (detailQ.data?.payments || []).length === 0 ? (
                        <p className="text-plum/60">No payments recorded for this booking yet.</p>
                      ) : (
                        <ul className="space-y-1">
                          {detailQ.data.payments.map((p) => (
                            <li key={p.id} className={`flex justify-between ${p.status === "voided" ? "line-through text-plum/40" : ""}`}>
                              <span>
                                {fmtDate(p.paidAt)} · {p.type === "refund" ? "Refund" : `${methodLabel(p.method)} ${p.purpose === "deposit" ? "deposit" : "payment"}`}
                              </span>
                              <span>
                                {p.type === "refund" ? "−" : ""}
                                {formatMoney(p.amount)}
                                {p.fee > 0 ? ` (+${formatMoney(p.fee)} card fee)` : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <PaymentInstructions
        paymentInfo={{
          depositAmount: catalogQ.data?.rules?.depositAmount ?? 50,
          depositCardCharge: catalogQ.data?.rules?.depositCardCharge,
          cashApp: OFFLINE_PAYMENT.cashApp,
          zelle: OFFLINE_PAYMENT.zelle,
          cash: OFFLINE_PAYMENT.cash,
          stripeEnabled: false,
        }}
      />
    </div>
  );
}

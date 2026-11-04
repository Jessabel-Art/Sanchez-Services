// src/pages/admin/components/BookingDetailModal.jsx — one booking: details, status actions, payments ledger, history.
// Shared by Bookings, Calendar, Payments and the Dashboard so every screen uses the same server actions.
import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { AlertTriangle, FileText } from "lucide-react";
import StatusPill from "./StatusPill";
import { BookingModal } from "./BookingModal";
import { RescheduleModal } from "./RescheduleModal";
import { apiGet, apiPost } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { normalizeBooking, fmtDate, fmtDateTime, formatMoney, paymentStatusLabel, methodLabel, statusLabel, METHOD_LABELS } from "@/lib/model";
import { openInvoiceWindow } from "@/lib/payments";
import { formatPhoneForDisplay } from "@/lib/contactModel";
import logoPrimary from "@/assets/logo/logo-primary.png";

const STATUS_ACTIONS = {
  pending: [
    { to: "confirmed", label: "Confirm" },
    { to: "declined", label: "Decline", reason: true },
  ],
  pending_payment: [{ to: "confirmed", label: "Confirm without deposit" }],
  confirmed: [
    { to: "completed", label: "Mark completed" },
    { to: "pending", label: "Back to pending" },
  ],
  completed: [{ to: "confirmed", label: "Reopen" }],
};
const CANCELLABLE = ["pending_payment", "pending", "confirmed"];

const HISTORY_LABELS = {
  created: "Booking created",
  confirmed: "Confirmed",
  declined: "Declined",
  pending: "Moved to pending",
  status_changed: "Status changed",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
  completed: "Completed",
  expired: "Hold expired",
  payment: "Payment recorded",
  refund: "Refund recorded",
  payment_voided: "Payment voided",
  updated: "Details updated",
  notes_updated: "Client notes updated",
  needs_attention: "Flagged for attention",
  attention_cleared: "Attention cleared",
};

/** Props: bookingId (ref) | null, onClose. */
export default function BookingDetailModal({ bookingId, onClose }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [resOpen, setResOpen] = useState(false);
  const [payForm, setPayForm] = useState(null);
  const [refundFor, setRefundFor] = useState(null);
  const q = useApiQuery(
    async () => normalizeBooking((await apiGet(`/admin/bookings/${encodeURIComponent(bookingId)}`)).booking),
    [bookingId],
    { enabled: !!bookingId }
  );
  const b = q.data;

  const run = async (fn, okTitle) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: okTitle });
      await q.refresh();
      return true;
    } catch (e) {
      toast({ title: "Action failed", description: e.message, variant: "destructive" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const ref = bookingId ? encodeURIComponent(bookingId) : "";
  const setStatus = (to, needsReason) => {
    let reason;
    if (needsReason) {
      reason = window.prompt(`Reason (${to === "cancelled" ? "shared with the client" : "optional"}):`, "");
      if (reason === null) return;
    }
    const notifyClient = window.confirm("Email the client about this change?");
    run(() => apiPost(`/admin/bookings/${ref}/status`, { status: to, reason: reason || undefined, notifyClient }), `Booking ${statusLabel(to).toLowerCase()}`);
  };

  const recordPayment = async (e) => {
    e.preventDefault();
    const ok = await run(
      () =>
        apiPost(`/admin/bookings/${ref}/payments`, {
          amount: Number(payForm.amount),
          method: payForm.method,
          purpose: payForm.purpose,
          note: payForm.note || undefined,
          paidAt: payForm.paidAt ? new Date(`${payForm.paidAt}T12:00:00`).toISOString() : undefined,
        }),
      "Payment recorded"
    );
    if (ok) setPayForm(null);
  };

  const refund = async (e) => {
    e.preventDefault();
    const ok = await run(
      () => apiPost(`/admin/payments/${refundFor.id}/refund`, { amount: Number(refundFor.amount), reason: refundFor.reason || undefined }),
      refundFor.method === "card" ? "Refund issued through Stripe" : "Refund recorded"
    );
    if (ok) setRefundFor(null);
  };

  const voidPayment = (p) => {
    const reason = window.prompt("Void this payment entry? It will no longer count toward the balance. Reason:", "Entered by mistake");
    if (reason === null) return;
    run(() => apiPost(`/admin/payments/${p.id}/void`, { reason }), "Payment voided");
  };

  const invoice = () =>
    openInvoiceWindow(async () => (await apiGet(`/bookings/${ref}/invoice`)).invoice, logoPrimary).catch((e) =>
      toast({ title: "Could not open invoice", description: e.message, variant: "destructive" })
    );

  const refundedFor = (pid) => (b?.payments || []).filter((r) => r.type === "refund" && r.refundOfPaymentId === pid && r.status === "succeeded").reduce((s, r) => s + r.amount, 0);

  return (
    <>
      <Dialog open={!!bookingId && !editOpen && !resOpen} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-3xl bg-white text-plum max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              {b ? `${b.clientName || "Booking"} · #${b.invoiceNumber}` : "Booking"}
              {b && <StatusPill status={b.status} />}
            </DialogTitle>
            <DialogDescription>{b ? `${b.serviceName} · ${fmtDateTime(b.startAt)} · ${b.durationMinutes} min` : "Loading…"}</DialogDescription>
          </DialogHeader>

          {q.error && <p className="text-sm text-rose-700" role="alert">{q.error.message}</p>}
          {b && (
            <div className="space-y-5 text-sm">
              {b.needsAttention && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3" role="alert">
                  <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" aria-hidden="true" />
                  <div className="flex-1">
                    <p className="font-medium text-amber-900">Needs attention</p>
                    <p className="text-amber-900/80">{b.needsAttention}</p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => apiPost(`/admin/bookings/${ref}/clear-attention`, {}), "Marked as handled")}>
                    Mark handled
                  </Button>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="font-semibold">Client</p>
                  <p>{b.contact?.name}</p>
                  <p>{b.contact?.email}</p>
                  <p>{formatPhoneForDisplay(b.contact?.phone)}</p>
                  <p>{b.addressText}</p>
                  {b.accessNotes && <p className="text-plum/70">Access: {b.accessNotes}</p>}
                  {b.cleanerNotes && <p className="text-plum/70">Cleaner notes: {b.cleanerNotes}</p>}
                  {b.adminNotes && <p className="text-plum/70">Admin notes: {b.adminNotes}</p>}
                  {b.cancellationReason && <p className="text-plum/70">Cancellation reason: {b.cancellationReason}</p>}
                </div>
                <div className="space-y-1">
                  <p className="font-semibold">Money</p>
                  <p className="flex justify-between"><span>Total</span><span>{formatMoney(b.totalPrice)}</span></p>
                  <p className="flex justify-between"><span>Deposit required</span><span>{formatMoney(b.depositAmount)}</span></p>
                  <p className="flex justify-between"><span>Paid (net)</span><span>{formatMoney(b.amountPaid)}</span></p>
                  {b.amountRefunded > 0 && <p className="flex justify-between"><span>Refunded</span><span>{formatMoney(b.amountRefunded)}</span></p>}
                  <p className="flex justify-between font-semibold"><span>Balance due</span><span>{formatMoney(b.balanceDue)}</span></p>
                  <p className="text-xs text-plum/60">{paymentStatusLabel(b.paymentStatus)}{b.holdExpiresAt ? ` · hold expires ${fmtDateTime(b.holdExpiresAt)}` : ""}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {(STATUS_ACTIONS[b.status] || []).map((a) => (
                  <Button key={a.to} size="sm" disabled={busy} onClick={() => setStatus(a.to, a.reason)} className="bg-plum text-white hover:bg-plum/90">
                    {a.label}
                  </Button>
                ))}
                {CANCELLABLE.includes(b.status) && (
                  <Button size="sm" variant="outline" disabled={busy} className="border-rose-300 text-rose-700" onClick={() => setStatus("cancelled", true)}>
                    Cancel booking
                  </Button>
                )}
                {["pending_payment", "pending", "confirmed"].includes(b.status) && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setResOpen(true)}>
                    Reschedule
                  </Button>
                )}
                {!["expired"].includes(b.status) && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditOpen(true)}>
                    Edit details
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={invoice}>
                  <FileText className="h-4 w-4 mr-1" aria-hidden="true" /> Invoice
                </Button>
              </div>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold">Payments</p>
                  {!payForm && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setPayForm({ amount: String(b.balanceDue > 0 ? b.balanceDue : ""), method: "cash", purpose: b.depositPaid || !b.depositAmount ? "balance" : "deposit", note: "", paidAt: "" })
                      }
                    >
                      Record payment
                    </Button>
                  )}
                </div>
                {payForm && (
                  <form onSubmit={recordPayment} className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end mb-3 rounded-lg bg-plum/5 p-3">
                    <label className="text-xs">Amount<Input type="number" min="0.01" step="0.01" required value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} /></label>
                    <label className="text-xs">Method
                      <select className="w-full border border-plum/20 rounded-md px-2 py-2 bg-white" value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                        {Object.entries(METHOD_LABELS).filter(([k]) => k !== "card").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </label>
                    <label className="text-xs">For
                      <select className="w-full border border-plum/20 rounded-md px-2 py-2 bg-white" value={payForm.purpose} onChange={(e) => setPayForm({ ...payForm, purpose: e.target.value })}>
                        <option value="deposit">Deposit</option>
                        <option value="balance">Balance</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                    <label className="text-xs">Date<Input type="date" value={payForm.paidAt} onChange={(e) => setPayForm({ ...payForm, paidAt: e.target.value })} /></label>
                    <label className="text-xs col-span-2 sm:col-span-1">Note<Input value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} /></label>
                    <div className="col-span-2 sm:col-span-5 flex gap-2 justify-end">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setPayForm(null)}>Cancel</Button>
                      <Button type="submit" size="sm" disabled={busy} className="bg-[#E2A82B] text-[#431039]">Save payment</Button>
                    </div>
                  </form>
                )}
                {refundFor && (
                  <form onSubmit={refund} className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end mb-3 rounded-lg bg-rose-50 p-3">
                    <p className="col-span-2 sm:col-span-4 text-xs">
                      Refund {methodLabel(refundFor.method)} payment of {formatMoney(refundFor.original)}
                      {refundFor.method === "card" ? " — this sends a real refund through Stripe." : " — record money you returned to the client."}
                    </p>
                    <label className="text-xs">Amount<Input type="number" min="0.01" step="0.01" max={refundFor.max} required value={refundFor.amount} onChange={(e) => setRefundFor({ ...refundFor, amount: e.target.value })} /></label>
                    <label className="text-xs col-span-1 sm:col-span-2">Reason<Input value={refundFor.reason} onChange={(e) => setRefundFor({ ...refundFor, reason: e.target.value })} /></label>
                    <div className="flex gap-2 justify-end">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRefundFor(null)}>Cancel</Button>
                      <Button type="submit" size="sm" disabled={busy} className="bg-rose-600 text-white">Refund</Button>
                    </div>
                  </form>
                )}
                {b.payments.length === 0 ? (
                  <p className="text-plum/60">No payments yet.</p>
                ) : (
                  <ul className="divide-y divide-plum/10">
                    {b.payments.map((p) => {
                      const remaining = p.type === "payment" ? Math.round((p.amount - refundedFor(p.id)) * 100) / 100 : 0;
                      return (
                        <li key={p.id} className={`py-2 flex flex-wrap items-center justify-between gap-2 ${p.status === "voided" ? "opacity-50 line-through" : ""}`}>
                          <span>
                            {fmtDate(p.paidAt)} · {p.type === "refund" ? "Refund" : `${methodLabel(p.method)} ${p.purpose}`} · {p.source}
                            {p.note ? ` · ${p.note}` : ""}
                          </span>
                          <span className="flex items-center gap-2">
                            {p.type === "refund" ? "−" : ""}
                            {formatMoney(p.amount)}
                            {p.fee > 0 ? <span className="text-xs text-plum/60">(+{formatMoney(p.fee)} fee)</span> : null}
                            {p.status === "succeeded" && p.type === "payment" && remaining > 0 && (
                              <Button size="sm" variant="ghost" className="text-rose-700 h-7" onClick={() => setRefundFor({ id: p.id, method: p.method, original: p.amount, max: remaining, amount: String(remaining), reason: "" })}>
                                Refund
                              </Button>
                            )}
                            {p.status === "succeeded" && p.source === "admin" && (
                              <Button size="sm" variant="ghost" className="h-7" onClick={() => voidPayment(p)}>
                                Void
                              </Button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section>
                <p className="font-semibold mb-2">History</p>
                <ul className="space-y-1 text-xs text-plum/80">
                  {b.history.map((h, i) => (
                    <li key={i}>
                      {fmtDateTime(h.at)} · {HISTORY_LABELS[h.event] || h.event} · {h.actorName || h.actor}
                      {h.event === "rescheduled" && h.details?.to ? ` → ${fmtDateTime(h.details.to)}` : ""}
                      {h.details?.reason ? ` (${h.details.reason})` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <BookingModal open={editOpen} initial={b} onClose={() => setEditOpen(false)} onSave={() => q.refresh()} />
      <RescheduleModal open={resOpen} booking={b} onClose={() => setResOpen(false)} onSaved={() => q.refresh()} />
    </>
  );
}

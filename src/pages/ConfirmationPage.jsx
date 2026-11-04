// src/pages/ConfirmationPage.jsx
// Stripe return page for deposits (/confirm) and balances (/payment-confirmation, purpose="balance").
// The server confirms the payment directly with Stripe before we show the result.
import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, Calendar, Sparkles, Home, DollarSign, Info, Clock, MapPin, Loader2, AlertCircle } from "lucide-react";
import CalendarExportButtons from "@/components/calendar/CalendarExportButtons";
import { apiGet, apiPost } from "@/lib/api";
import { normalizeBooking, fmtDate, fmtTime, formatMoney, statusLabel, paymentStatusLabel } from "@/lib/model";
import { OFFLINE_PAYMENT } from "@/data/paymentMethods";
import { useAuth } from "@/context/AuthContext";

export default function ConfirmationPage({ purpose = "deposit" }) {
  const [search] = useSearchParams();
  const ref = search.get("booking") || search.get("bookingId");
  const sessionId = search.get("session_id");
  const cancelled = search.get("cancelled") === "1";
  const rescheduled = search.get("rescheduled") === "1";
  const { user, authReady } = useAuth();

  const [booking, setBooking] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (!authReady || ran.current) return;
    ran.current = true;
    if (!ref || !user) {
      setLoading(false);
      setError(!user ? "Please sign in to see your booking." : "We couldn’t find that booking.");
      return;
    }
    const path = `/bookings/${encodeURIComponent(ref)}`;
    const load = sessionId && !cancelled ? apiPost(`${path}/payment-sync`, { sessionId }) : apiGet(path);
    load
      .then(({ booking: b }) => setBooking(normalizeBooking(b)))
      .catch((e) => setError(e.status === 404 ? "We couldn’t find that booking." : e.message))
      .finally(() => setLoading(false));
  }, [authReady, user, ref, sessionId, cancelled]);

  const pay = async (p) => {
    setPaying(true);
    try {
      const { checkoutUrl } = await apiPost(`/bookings/${encodeURIComponent(booking.id)}/checkout`, { purpose: p });
      window.location.href = checkoutUrl;
    } catch (e) {
      setError(e.message);
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className="py-20 px-4 bg-white flex items-center justify-center min-h-[60vh]" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-gold mr-2" aria-hidden="true" />
        <p className="text-plum/70">{sessionId ? "Confirming your payment…" : "Loading your booking…"}</p>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="py-20 px-4 bg-white flex items-center justify-center min-h-[60vh]">
        <Card className="max-w-lg w-full text-center p-8">
          <CardTitle className="text-2xl text-plum mb-2">We couldn’t load that booking</CardTitle>
          <p className="text-plum/70 mb-6">{error || "The link may be invalid or expired."} Your bookings are always listed in your account.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button className="bg-gold text-white hover:bg-gold/90 rounded-full" asChild>
              <Link to={user ? "/portal" : "/auth"}>{user ? "Go to my account" : "Sign in"}</Link>
            </Button>
            <Button asChild variant="outline" className="border-gold text-gold hover:bg-gold/10 rounded-full">
              <Link to="/"><Home className="mr-2 h-4 w-4" />Back to Homepage</Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const b = booking;
  const lastPayment = b.payments.filter((p) => p.type === "payment" && p.status === "succeeded").slice(-1)[0];
  let headline;
  let tone = "success";
  let message;
  if (rescheduled) {
    headline = "Appointment rescheduled";
    message = "We emailed you the updated details.";
  } else if (b.status === "confirmed" || b.status === "completed") {
    headline = purpose === "balance" ? (b.balanceDue > 0 ? "Payment received" : "Paid in full — thank you!") : "You’re booked!";
    message = purpose === "balance" ? "Your payment was applied to this appointment." : "Your deposit was received and your appointment is confirmed. A confirmation email is on its way.";
  } else if (b.status === "pending_payment") {
    tone = "warning";
    headline = cancelled ? "Payment not completed" : "Finish your deposit";
    message = `Your time slot is held until ${fmtTime(b.holdExpiresAt)}. Complete the deposit to confirm it.`;
  } else if (b.status === "expired") {
    tone = "error";
    headline = "This hold has expired";
    message = "The deposit wasn’t completed in time, so the time slot was released. Please book again.";
  } else if (b.status === "pending") {
    tone = "warning";
    headline = "Request received";
    message = "We’ll confirm your appointment shortly.";
  } else {
    tone = "error";
    headline = `Booking ${statusLabel(b.status).toLowerCase()}`;
    message = "This booking is no longer active.";
  }
  const Icon = tone === "success" ? CheckCircle : AlertCircle;

  return (
    <div className="py-12 sm:py-16 md:py-20 px-3 sm:px-4 bg-white flex items-center justify-center min-h-[70vh]">
      <motion.div className="max-w-2xl w-full" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}>
        <Card className="text-center shadow-lg">
          <CardHeader className="pt-6 sm:pt-8">
            <Icon className={`mx-auto h-16 sm:h-20 w-16 sm:w-20 ${tone === "success" ? "text-green-500" : tone === "warning" ? "text-gold" : "text-rose-500"}`} aria-hidden="true" />
            <CardTitle className="text-2xl sm:text-3xl md:text-4xl font-bold text-plum mt-3 sm:mt-4">{headline}</CardTitle>
            <p className="text-sm md:text-lg text-plum/80 mt-2" role="status">{message}</p>
            {lastPayment && (b.status === "confirmed" || purpose === "balance") && !rescheduled && sessionId && (
              <div className="mt-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-900">
                <Info className="inline-block h-4 w-4 mr-1 align-text-top text-emerald-600" aria-hidden="true" />
                {formatMoney(lastPayment.amount)} applied to your booking
                {lastPayment.fee > 0 ? ` (card total ${formatMoney(lastPayment.gross)} including a ${formatMoney(lastPayment.fee)} processing fee)` : ""}.
              </div>
            )}
            {error && <p className="mt-3 text-sm text-rose-700" role="alert">{error}</p>}
          </CardHeader>

          <CardContent className="space-y-6 text-left p-8">
            <h3 className="text-xl font-semibold text-plum border-b border-gold/50 pb-2 mb-4">Your Booking Details</h3>
            <div className="space-y-3 text-plum/90">
              <Row icon={Sparkles} label="Service" value={b.serviceName} />
              <Row icon={Calendar} label="Date" value={fmtDate(b.startAt, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} />
              <Row icon={Clock} label="Time" value={`${fmtTime(b.startAt)} – ${fmtTime(b.endAt)}`} />
              <Row icon={MapPin} label="Address" value={b.addressText} />
              <Row icon={DollarSign} label="Total" value={formatMoney(b.totalPrice)} />
              <Row icon={DollarSign} label="Paid" value={formatMoney(b.amountPaid)} />
              <Row icon={DollarSign} label="Balance due" value={formatMoney(b.balanceDue)} />
              <div className="text-sm text-plum/70 mt-2">
                Booking #: <span className="font-medium">{b.invoiceNumber}</span> · {paymentStatusLabel(b.paymentStatus)}
              </div>
            </div>

            {(b.status === "confirmed" || b.status === "pending") && (
              <div className="pt-2">
                <CalendarExportButtons
                  title={`${b.serviceName} — Sanchez Services`}
                  start={b.startAt}
                  end={b.endAt}
                  details={`Booking #: ${b.invoiceNumber}`}
                  location={b.addressText}
                  uid={b.id}
                  fileName={`sanchez-${b.invoiceNumber}.ics`}
                />
              </div>
            )}

            {b.permissions?.canPayDeposit && (
              <Button onClick={() => pay("deposit")} disabled={paying} size="lg" className="w-full bg-gold hover:bg-gold/90 text-white rounded-full">
                {paying ? "Opening secure checkout…" : `Pay ${formatMoney(b.depositDue)} deposit`}
              </Button>
            )}
            {b.permissions?.canPayBalance && (
              <div className="rounded-lg bg-plum/5 p-4 text-sm text-plum/80 space-y-2">
                <p>
                  <Info className="inline-block w-4 h-4 mr-1 text-gold" aria-hidden="true" />
                  Remaining balance: <strong>{formatMoney(b.balanceDue)}</strong>. Pay online now, or at the time of service (cash
                  {OFFLINE_PAYMENT.cashApp ? `, Cash App ${OFFLINE_PAYMENT.cashApp}` : ""}{OFFLINE_PAYMENT.zelle ? `, Zelle ${OFFLINE_PAYMENT.zelle}` : ""}). {OFFLINE_PAYMENT.note}
                </p>
                <Button onClick={() => pay("balance")} disabled={paying} variant="outline" className="border-gold text-gold hover:bg-gold/10 rounded-full">
                  {paying ? "Opening secure checkout…" : "Pay balance by card"}
                </Button>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-4 pt-4">
              <Button asChild size="lg" className="w-full bg-gold hover:bg-gold/90 text-white rounded-full">
                <Link to={b.status === "expired" ? "/book" : "/portal"}>{b.status === "expired" ? "Book again" : "Go to my account"}</Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="w-full border-gold text-gold hover:bg-gold/10 hover:text-gold rounded-full">
                <Link to="/"><Home className="mr-2 h-4 w-4" />Back to Homepage</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

const Row = ({ icon: Icon, label, value }) => (
  <div className="flex justify-between items-start gap-4">
    <span className="font-medium flex items-center shrink-0">
      <Icon className="h-5 w-5 mr-2 text-gold" aria-hidden="true" />
      {label}:
    </span>
    <span className="font-semibold text-right">{value}</span>
  </div>
);

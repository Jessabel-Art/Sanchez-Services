// src/components/portal/ClientDashboardHome.jsx
import React, { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  CalendarDays,
  Star,
  Clock,
  ArrowRight,
  MapPin,
} from "lucide-react";
import AppointmentTimeline from "@/components/portal/AppointmentTimeline";
import dashboardBanner from "@/assets/images/dashboard-banner.png";

/** Local date helpers so we don't couple tightly to Firestore everywhere */
function toDate(tsLike) {
  if (!tsLike) return null;
  if (typeof tsLike.toDate === "function") return tsLike.toDate();
  return new Date(tsLike);
}

function formatDate(tsLike) {
  const d = toDate(tsLike);
  if (!d || Number.isNaN(d.getTime())) return "TBD";
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York", 
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatTime(tsLike) {
  const d = toDate(tsLike);
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { timeZone: "America/New_York",  hour: "2-digit", minute: "2-digit" });
}

const money = (n) =>
  Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

function formatAddressRow(a) {
  if (!a) return null;
  const parts = [a.street, a.city, a.state, a.zip].filter(Boolean);
  const joined = parts.join(", ");
  return joined || null;
}

/**
 * Try to pull a human-readable service address from the booking first,
 * otherwise fall back to the primaryAddress passed in as a prop.
 */
function formatServiceAddress(booking, primaryAddress) {
  if (!booking && !primaryAddress) return null;

  // Explicit single-line field, if present
  if (booking?.serviceAddressLine) return booking.serviceAddressLine;

  // What bookingsWithFriendly currently exposes
  if (booking?.addressLine) {
    if (booking.addressZip) {
      return `${booking.addressLine} ${booking.addressZip}`;
    }
    return booking.addressLine;
  }

  // Full address object if it exists
  if (booking?.address) {
    const row = formatAddressRow(booking.address);
    if (row) return row;
  }

  // Flat address fields on booking
  const parts = [
    booking?.street,
    booking?.city,
    booking?.state,
    booking?.zip,
  ].filter(Boolean);
  if (parts.length) return parts.join(", ");

  // Fallback: primaryAddress passed from parent
  const primaryRow = formatAddressRow(primaryAddress);
  return primaryRow || null;
}

/**
 * Props:
 * - upcomingBookings: array of booking objects (from upcomingBookings memo)
 * - completedBookings: array of booking objects (from completedBookings memo)
 * - allBookings: array of all bookingsWithFriendly
 * - onGoToAppointments: () => void
 * - onGoToBook: () => void
 * - onGoToContactDetails?: () => void
 * - onGoToAccountDetails?: () => void
 * - primaryAddress?: { street?: string; city?: string; state?: string; zip?: string }
 */
export default function ClientDashboardHome({
  upcomingBookings = [],
  completedBookings = [],
  allBookings = [],
  onGoToAppointments,
  onGoToBook,
  onGoToContactDetails, // kept for future use
  onGoToAccountDetails, // kept for future use
  primaryAddress,
}) {
  const {
    nextBooking,
    lastCompleted,
    totalBookings,
    yearBookings,
    totalSpend, // not surfaced but kept in case you want it later
    upcomingPreview,
    highestDepositAmount,
    hasPendingDeposit,
    hasReceivedDeposit,
    avgRating,
  } = useMemo(() => {
    const now = new Date();

    const nextBooking =
      upcomingBookings && upcomingBookings.length > 0
        ? upcomingBookings[0]
        : null;

    const completedSorted = [...(completedBookings || [])].sort((a, b) => {
      const aD = toDate(a.endAt || a.date) || new Date(0);
      const bD = toDate(b.endAt || b.date) || new Date(0);
      return bD - aD;
    });
    const lastCompleted = completedSorted[0] || null;

    // Count cleanings that actually happened (completed), not requests or upcoming visits.
    const done = (allBookings || []).filter((b) => (b.rawStatus || b.status) === "completed");
    const totalBookings = done.length;
    const rated = (allBookings || []).filter((b) => Number(b.reviewRating) > 0);
    const avgRating = rated.length ? (rated.reduce((s, b) => s + Number(b.reviewRating), 0) / rated.length).toFixed(1) : null;

    const thisYear = now.getFullYear();
    const yearBookings =
      done.filter((b) => {
        const d = toDate(b.date || b.endAt || b.createdAt);
        return d && d.getFullYear() === thisYear;
      }).length || 0;

    const totalSpend = (allBookings || []).reduce(
      (sum, b) => sum + Number(b.total || 0),
      0
    );

    const upcomingPreview = (upcomingBookings || []).slice(0, 3);

    // Deposit tracking aligned with AdminPayments / derivePaymentInfo:
    // - amount comes from depositAmount (preferred), then payment.depositAmount, then legacy depositDue
    // - paid flag comes from depositPaid (preferred), then payment.depositPaid, then legacy depositReceived
    let highestDepositAmount = 0;
    let hasPendingDeposit = false;
    let hasReceivedDeposit = false;

    (upcomingBookings || []).forEach((b) => {
      const payment = b.payment || {};
      const depositAmount = Number(
        b.depositAmount ??
          payment.depositAmount ??
          b.depositDue ??
          0
      );
      const depositPaid =
        b.depositPaid ??
        payment.depositPaid ??
        b.depositReceived ??
        false;

      if (depositAmount > 0) {
        if (depositAmount > highestDepositAmount) {
          highestDepositAmount = depositAmount;
        }
        if (depositPaid) {
          hasReceivedDeposit = true;
        } else {
          hasPendingDeposit = true;
        }
      }
    });

    return {
      nextBooking,
      lastCompleted,
      totalBookings,
      yearBookings,
      totalSpend,
      upcomingPreview,
      highestDepositAmount,
      hasPendingDeposit,
      hasReceivedDeposit,
      avgRating,
    };
  }, [upcomingBookings, completedBookings, allBookings]);

  const handleBook = () => {
    if (typeof onGoToBook === "function") onGoToBook();
  };
  const handleAppointments = () => {
    if (typeof onGoToAppointments === "function") onGoToAppointments();
  };

  const thisYear = new Date().getFullYear();
  const nextServiceAddress = formatServiceAddress(nextBooking, primaryAddress);
  const lastServiceAddress = formatServiceAddress(
    lastCompleted,
    primaryAddress
  );

  const isRepeatClient = (completedBookings || []).length > 0;
  const hasUpcoming = (upcomingBookings || []).length > 0;

  // Next-booking deposit info, derived the same way as admin
  const nextPayment = nextBooking?.payment || {};
  const nextDepositAmount = Number(
    nextBooking?.depositAmount ??
      nextPayment.depositAmount ??
      nextBooking?.depositDue ??
      0
  );
  const nextDepositPaid = Boolean(
    nextBooking?.depositPaid ??
      nextPayment.depositPaid ??
      nextBooking?.depositReceived ??
      false
  );

  return (
    <section className="space-y-6 sm:space-y-8">
      {/* Header + banner + stats */}
      <div className="space-y-3 sm:space-y-4">
        <div className="space-y-1 flex flex-col items-center text-center">
          <p className="text-xs font-medium tracking-[0.18em] uppercase text-plum/60">
            Client dashboard
          </p>
          <div className="flex flex-col gap-1 items-center px-3 sm:px-4">
            <h2 className="text-xl sm:text-2xl md:text-3xl font-semibold text-plum">
              Your cleaning dashboard
            </h2>
            <p className="text-xs sm:text-sm text-plum/75 max-w-xl">
              See what&apos;s coming up next, your cleaning history, and
              important details about your cleanings.
            </p>
          </div>
        </div>

        <DashboardHeroSummary
          yearBookings={yearBookings}
          totalBookings={totalBookings}
          avgRating={avgRating}
        />
      </div>

      {/* Bottom row: Next & Last cards */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)] gap-3 sm:gap-4">
        {/* Next booking / upcoming snapshot */}
        <div className="bg-white border border-plum/10 rounded-2xl p-3 sm:p-4 md:p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center">
                <CalendarDays className="w-4 h-4 text-emerald-600" />
              </div>
              <div>
                <h3 className="text-xs sm:text-sm font-semibold text-plum">
                  Next appointment
                </h3>
                <p className="text-xs text-plum/70">
                  Your upcoming confirmed cleaning.
                </p>
              </div>
            </div>
          </div>

          {nextBooking ? (
            <>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-plum">
                    {nextBooking.service}
                  </div>
                  <span className="px-2 py-1 rounded-full text-xs bg-emerald-50 text-emerald-700 border border-emerald-100">
                    {nextBooking.friendly}
                  </span>
                </div>
                <div className="text-plum/80">
                  {formatDate(nextBooking.date)}{" "}
                  {formatTime(nextBooking.date) && (
                    <>· {formatTime(nextBooking.date)}</>
                  )}
                </div>
                <div className="text-plum/80">
                  Total:{" "}
                  <span className="font-medium">
                    {money(nextBooking.total)}
                  </span>
                </div>

                {nextServiceAddress && (
                  <div className="mt-2 flex items-start gap-2 text-xs text-plum/80 bg-plum/5 border border-plum/10 rounded-lg px-3 py-2">
                    <MapPin className="w-3 h-3 mt-[2px] text-plum/70" />
                    <div>
                      <span className="font-semibold">Service address:</span>{" "}
                      <span>{nextServiceAddress}</span>
                    </div>
                  </div>
                )}

                {/* Deposit message for next booking – aligned with AdminPayments fields */}
                {nextDepositAmount > 0 && !isRepeatClient && (
                  nextDepositPaid ? (
                    <div className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 mt-2">
                      We&apos;ve received your deposit of{" "}
                      <span className="font-semibold">
                        {money(nextDepositAmount)}
                      </span>
                      . Your appointment is secured.
                    </div>
                  ) : (
                    <div className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mt-2">
                      A deposit of{" "}
                      <span className="font-semibold">
                        {money(nextDepositAmount)}
                      </span>{" "}
                      is required to secure this appointment.
                    </div>
                  )
                )}
              </div>

              {/* Mini upcoming list */}
              {upcomingPreview?.length > 1 && (
                <div className="mt-4 border-t border-plum/10 pt-3">
                  <p className="text-xs font-medium text-plum/70 mb-2">
                    Also coming up
                  </p>
                  <div className="space-y-2">
                    {upcomingPreview.slice(1).map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between text-xs rounded-lg border border-plum/10 bg-plum/5 px-3 py-2"
                      >
                        <div className="truncate">
                          <p className="font-medium text-plum truncate">
                            {b.service}
                          </p>
                          <p className="text-plum/70">
                            {formatDate(b.date)}{" "}
                            {formatTime(b.date) && (
                              <>· {formatTime(b.date)}</>
                            )}
                          </p>
                        </div>
                        <span className="text-plum/60 ml-3 whitespace-nowrap">
                          {money(b.total)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  className="border-plum text-plum hover:bg-plum/5 transition-all duration-200"
                  onClick={handleAppointments}
                >
                  Manage appointments
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </>
          ) : (
            <div className="text-sm text-plum/70">
              You don&apos;t have any upcoming appointments yet.
              <div className="mt-3">
                <Button
                  size="sm"
                  className="bg-gold text-white hover:bg-gold/90 rounded-full transition-all duration-200"
                  onClick={handleBook}
                >
                  Book your next cleaning
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Last completed + deposit summary + timeline */}
        <div className="space-y-4">
          <div className="bg-white border border-plum/10 rounded-2xl p-4 md:p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-plum/5 flex items-center justify-center">
                  <Clock className="w-4 h-4 text-plum" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-plum">
                    Most recent cleaning
                  </h3>
                  <p className="text-xs text-plum/70">
                    Quick access to your last service.
                  </p>
                </div>
              </div>
            </div>

            {lastCompleted ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-plum">
                    {lastCompleted.service}
                  </div>
                  <span className="px-2 py-1 rounded-full text-xs bg-purple-50 text-purple-700 border border-purple-100">
                    {lastCompleted.friendly}
                  </span>
                </div>
                <div className="text-plum/80">
                  {formatDate(lastCompleted.date)}
                </div>
                <div className="text-plum/80">
                  Total:{" "}
                  <span className="font-medium">
                    {money(lastCompleted.total)}
                  </span>
                </div>

                {lastServiceAddress && (
                  <div className="mt-2 flex items-start gap-2 text-xs text-plum/80 bg-plum/5 border border-plum/10 rounded-lg px-3 py-2">
                    <MapPin className="w-3 h-3 mt-[2px] text-plum/70" />
                    <div>
                      <span className="font-semibold">Service address:</span>{" "}
                      <span>{lastServiceAddress}</span>
                    </div>
                  </div>
                )}

                <p className="text-xs text-plum/70 mt-1">
                  Loved the service? Re-book the same type or leave a review
                  from the appointments tab.
                </p>

                <div className="pt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="bg-gold text-white hover:bg-gold/90 transition-all duration-200"
                    onClick={handleBook}
                  >
                    Book again
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-plum/70">
                Once you&apos;ve had your first cleaning, you&apos;ll see a
                quick summary here.
              </div>
            )}
          </div>

          {/* Timeline shown automatically when there is a lastCompleted booking */}
          {lastCompleted && (
            <AppointmentTimeline
              booking={lastCompleted}
              title="Timeline for your most recent cleaning"
            />
          )}

          {/* Deposit snapshot / repeat client message */}
          {hasUpcoming &&
            (isRepeatClient ? (
              <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 shadow-sm text-xs text-emerald-900">
                <p className="font-semibold mb-1">Great news!</p>
                <p>
                  Because you&apos;re a returning client, deposits are no longer
                  required for your appointments.
                </p>
              </div>
            ) : highestDepositAmount > 0 ? (
              hasPendingDeposit ? (
                <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 shadow-sm text-xs text-amber-900">
                  <p className="font-semibold mb-1">
                    Upcoming deposit reminder
                  </p>
                  <p className="mb-1">
                    At least one upcoming appointment has a deposit due of up to{" "}
                    <span className="font-bold">
                      {money(highestDepositAmount)}
                    </span>
                    .
                  </p>
                  <p className="text-amber-900/80">
                    Please follow your payment instructions to make sure your
                    booking is secured.
                  </p>
                </div>
              ) : hasReceivedDeposit ? (
                <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 shadow-sm text-xs text-emerald-900">
                  <p className="font-semibold mb-1">
                    Deposit received for your upcoming booking
                  </p>
                  <p className="text-emerald-900/80">
                    Your deposit has been received for your upcoming
                    appointment. You&apos;re all set—no further action is needed
                    for now.
                  </p>
                </div>
              ) : null
            ) : null)}
        </div>
      </div>
    </section>
  );
}

/* ------------ Hero metrics components ------------ */

function DashboardHeroSummary({ yearBookings, totalBookings, avgRating }) {
  return (
    <div className="flex flex-col items-center gap-4 mt-4">
      {/* Centered banner image */}
      <div className="w-full flex justify-center">
        <img
          src={dashboardBanner}
          alt="Two cleaning gloves forming a heart shape"
          className="max-h-40 w-auto object-contain drop-shadow-sm"
        />
      </div>

      {/* Stats card - plum background, white text */}
      <div className="bg-plum rounded-2xl px-4 py-3 shadow-sm max-w-xl w-full">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs sm:text-sm">
          <HeroMetric label="Cleanings this year" value={yearBookings} />
          <HeroMetric label="All-time cleanings" value={totalBookings} />
          <HeroMetric label="Your rating" value={avgRating ?? "—"} icon={Star} />
        </div>
      </div>
    </div>
  );
}

function HeroMetric({ label, value, icon: Icon }) {
  return (
    <div className="flex items-center gap-2 text-white">
      {Icon && <Icon className="w-3.5 h-3.5 text-gold" />}
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-white/70">
          {label}
        </span>
        <span className="text-sm font-semibold text-white">{value}</span>
      </div>
    </div>
  );
}

// src/components/portal/PastBookings.jsx
import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Star, Clock, FileDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import logoPrimary from "@/assets/logo/logo-primary.png";

function toDate(tsLike) {
  if (!tsLike) return null;
  if (typeof tsLike.toDate === "function") return tsLike.toDate();
  return new Date(tsLike);
}

function formatDate(tsLike) {
  try {
    const d = toDate(tsLike);
    if (!d || Number.isNaN(d.getTime())) return "TBD";
    return d.toLocaleDateString("en-US", { timeZone: "America/New_York", 
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "TBD";
  }
}

function formatTime(tsLike) {
  const d = toDate(tsLike);
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { timeZone: "America/New_York",  hour: "2-digit", minute: "2-digit" });
}

function formatMoney(n) {
  return Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function statusToken(label) {
  const map = {
    Pending: "bg-amber-100 text-amber-800 border-amber-200",
    Scheduled: "bg-sky-100 text-sky-800 border-sky-200",
    Confirmed: "bg-emerald-100 text-emerald-800 border-emerald-200",
    Completed: "bg-neutral-200 text-neutral-800 border-neutral-300",
    Declined: "bg-rose-100 text-rose-800 border-rose-200",
    cancelled: "bg-rose-100 text-rose-800 border-rose-200",
    Refunded: "bg-purple-100 text-purple-800 border-purple-200",
    Expired: "bg-neutral-100 text-neutral-700 border-neutral-200",
  };
  return map[label] || "bg-plum/10 text-plum border-plum/20";
}

// Simple static star renderer for saved review rating (1–5)
function RatingStars({ rating = 0 }) {
  const r = Math.max(0, Math.min(5, Number(rating) || 0));
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`w-3 h-3 ${
            i < r ? "text-gold fill-gold" : "text-plum/25"
          }`}
        />
      ))}
    </span>
  );
}

function getBookingField(booking, keys, fallback = "Not specified") {
  for (const key of keys) {
    const v = booking?.[key];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return fallback;
}

/**
 * PastBookings
 *
 * Props:
 * - bookings: array of normalized bookings
 * - loading: boolean
 * - onReview(booking)
 * - onAction({ type, booking }) // used here for download-pdf
 */
export default function PastBookings({
  bookings = [],
  loading = false,
  onReview,
  onAction,
}) {
  const now = new Date();
  const [activeBooking, setActiveBooking] = useState(null);

  const renderSkeletonRow = (key) => (
    <tr key={key} className="border-b last:border-0 animate-pulse">
      <td className="py-3 pr-4">
        <div className="h-4 w-24 bg-plum/10 rounded" />
      </td>
      <td className="py-3 pr-4">
        <div className="h-4 w-32 bg-plum/10 rounded" />
      </td>
      <td className="py-3 pr-4">
        <div className="h-5 w-20 bg-plum/10 rounded-full" />
      </td>
      <td className="py-3 pr-4">
        <div className="h-4 w-16 bg-plum/10 rounded" />
      </td>
      <td className="py-3 pr-4">
        <div className="h-4 w-24 bg-plum/10 rounded" />
      </td>
    </tr>
  );

  const completedCount = bookings.length;
  const ratings = bookings
    .map((b) => Number(b.reviewRating))
    .filter((n) => !Number.isNaN(n));
  const avgRating =
    ratings.length > 0
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) /
        10
      : null;

  const openDetails = (booking) => setActiveBooking(booking);
  const closeDetails = () => setActiveBooking(null);

  const handleDownloadPdf = () => {
    if (!activeBooking || typeof onAction !== "function") return;
    onAction({ type: "download-pdf", booking: activeBooking });
  };

  const renderDetailsModal = () => {
    if (!activeBooking) return null;

    const b = activeBooking;
    const orderCode = (b.invoiceNumber || b.id || "");

    const startDate = toDate(b.startAt || b.date);
    const endDate = toDate(b.endAt);

    let displayStatus = b.friendly || b.rawStatus || "Pending";
    if (
      endDate &&
      endDate < now &&
      (displayStatus === "Confirmed" || displayStatus === "Scheduled")
    ) {
      displayStatus = "Completed";
    }

    const total = formatMoney(b.total);
    const depositDue =
      b.depositDue != null ? formatMoney(b.depositDue) : null;

    const address =
      b.addressText ||
      b.fullAddress ||
      (b.street && `${b.street}${b.city ? `, ${b.city}` : ""}`) ||
      "On file";

    const frequency = getBookingField(
      b,
      ["frequency", "serviceFrequency"],
      "one-time"
    );

    const propertyType = getBookingField(b, ["propertyType", "homeType"]);
    const bedrooms = getBookingField(b, ["bedrooms", "numBedrooms"], "—");
    const bathrooms = getBookingField(b, ["bathrooms", "numBathrooms"], "—");
    const conditionLevel = getBookingField(
      b,
      ["conditionLevel", "condition"],
      "Standard"
    );
    const petsValue = getBookingField(
      b,
      ["petsOnSite", "hasPets"],
      "No"
    );
    const pets =
      typeof petsValue === "boolean"
        ? petsValue
          ? "Yes"
          : "No"
        : petsValue;

    const fragrancePreference = getBookingField(
      b,
      ["fragrancePreference", "scentPreference"],
      "No preference"
    );

    const addOnsRaw =
      b.addOns || b.addons || b.addonList || b.selectedAddOns || [];
    const addOnsArray = Array.isArray(addOnsRaw)
      ? addOnsRaw
      : typeof addOnsRaw === "string"
      ? addOnsRaw.split(",").map((x) => x.trim()).filter(Boolean)
      : [];
    const addOns =
      addOnsArray.length > 0 ? addOnsArray.join(", ") : "None added";

    const notes = b.notes ?? b.clientNotes ?? "";

    return (
      <Dialog open={!!activeBooking} onOpenChange={(open) => !open && closeDetails()}>
        <DialogContent
          className="
            max-w-xl sm:max-w-2xl
            max-h-[85vh] overflow-y-auto
            rounded-3xl p-5 sm:p-6
            bg-white shadow-xl border border-plum/10
          "
        >
          <DialogHeader className="mb-4 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <img
                  src={logoPrimary}
                  alt="Sanchez Services"
                  className="h-10 w-auto"
                />
                <div className="leading-tight text-xs text-plum/70">
                  <p className="font-semibold text-plum text-sm">
                    Sanchez Services
                  </p>
                  <p>Completed appointment summary</p>
                </div>
              </div>
              <div className="text-right text-xs text-plum/60 space-y-1">
                <p className="font-mono text-[11px]">
                  Order: <span className="font-semibold">{orderCode}</span>
                </p>
                {startDate && (
                  <p>
                    {formatDate(startDate)}{" "}
                    {formatTime(startDate) && <>· {formatTime(startDate)}</>}
                  </p>
                )}
              </div>
            </div>

            <DialogTitle className="text-lg sm:text-xl text-plum">
              Appointment details
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 text-sm text-plum">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="font-semibold">Service</p>
                <p>{b.service || "Residential Cleaning"}</p>
              </div>

              <div className="space-y-1">
                <p className="font-semibold">Status</p>
                <p>{displayStatus}</p>
              </div>

              <div className="space-y-1">
                <p className="font-semibold">Date / Time</p>
                {startDate ? (
                  <p>
                    {formatDate(startDate)}{" "}
                    {formatTime(startDate) && `· ${formatTime(startDate)}`}
                    {endDate && (
                      <>
                        {" – "}
                        {formatTime(endDate)}
                      </>
                    )}
                  </p>
                ) : (
                  <p>TBD</p>
                )}
              </div>

              <div className="space-y-1">
                <p className="font-semibold">Frequency</p>
                <p>{frequency}</p>
              </div>

              <div className="space-y-1">
                <p className="font-semibold">Total</p>
                <p>{total}</p>
              </div>

              {depositDue && (
                <div className="space-y-1">
                  <p className="font-semibold">Deposit due</p>
                  <p>{depositDue}</p>
                </div>
              )}

              <div className="space-y-1 sm:col-span-2">
                <p className="font-semibold">Service address</p>
                <p>{address}</p>
              </div>
            </div>

            <div className="mt-2 border-t border-plum/10 pt-3 space-y-2">
              <p className="font-semibold text-sm">Home &amp; cleaning details</p>
              <div className="grid gap-2 sm:grid-cols-2 text-sm">
                <div>
                  <span className="text-plum/60 text-xs block">
                    Property type
                  </span>
                  <span>{propertyType}</span>
                </div>
                <div>
                  <span className="text-plum/60 text-xs block">
                    Bedrooms / Bathrooms
                  </span>
                  <span>
                    {bedrooms} bed · {bathrooms} bath
                  </span>
                </div>
                <div>
                  <span className="text-plum/60 text-xs block">
                    Condition level
                  </span>
                  <span>{conditionLevel}</span>
                </div>
                <div>
                  <span className="text-plum/60 text-xs block">
                    Pets on site
                  </span>
                  <span>{pets}</span>
                </div>
                <div>
                  <span className="text-plum/60 text-xs block">
                    Fragrance preference
                  </span>
                  <span>{fragrancePreference}</span>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-plum/60 text-xs block">Add-ons</span>
                  <span>{addOns}</span>
                </div>
              </div>
            </div>

            <div className="mt-2 border-t border-plum/10 pt-3 space-y-1">
              <p className="text-xs font-semibold text-plum">
                Notes on this appointment
              </p>
              <div className="text-sm text-plum bg-plum/5 border border-plum/10 rounded-lg px-3 py-2 whitespace-pre-wrap">
                {notes && notes.trim().length > 0
                  ? notes
                  : "No additional notes were recorded for this appointment."}
              </div>
            </div>
          </div>

          <DialogFooter className="mt-6 flex flex-col sm:flex-row sm:justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              className="order-1 sm:order-none border-plum/40 text-plum hover:bg-plum/5"
              onClick={closeDetails}
            >
              Close
            </Button>

            <div className="flex flex-row gap-2 justify-end w-full sm:w-auto">
              <Button
                type="button"
                variant="outline"
                className="border-plum/40 text-plum hover:bg-plum/5 flex items-center gap-2"
                onClick={handleDownloadPdf}
              >
                <FileDown className="w-4 h-4" />
                PDF
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  };

  return (
    <>
      <Card className="shadow-sm border-plum/10">
        <CardHeader className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-plum/70" />
            <div>
              <CardTitle className="text-plum text-lg md:text-xl">
                Completed Appointments
              </CardTitle>
              <p className="text-xs text-plum/60 mt-0.5">
                View your past cleanings and leave feedback for Sterling.
              </p>
            </div>
          </div>

          {!loading && completedCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-plum/5 px-3 py-1 text-xs text-plum/75 border border-plum/10">
              {completedCount} completed&nbsp;
              {completedCount === 1 ? "appointment" : "appointments"}
            </span>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          {!loading && completedCount > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs text-plum/70">
              <span>
                You have{" "}
                <span className="font-semibold text-plum">
                  {completedCount}
                </span>{" "}
                completed {completedCount === 1 ? "appointment" : "appointments"}.
              </span>
              {avgRating != null && (
                <span className="flex items-center gap-1">
                  <Star className="w-3 h-3 text-gold fill-gold" />
                  <span>
                    Average rating:{" "}
                    <span className="font-semibold text-plum">
                      {avgRating}
                    </span>{" "}
                    / 5
                  </span>
                </span>
              )}
            </div>
          )}

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-left text-plum/70 border-b bg-plum/5/40">
                  <th className="py-2 pr-4">Order</th>
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Total</th>
                  <th className="py-2 pr-4">Feedback</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 4 }).map((_, i) => renderSkeletonRow(i))
                  : bookings.length
                  ? bookings.map((b, idx) => {
                      const end = toDate(b.endAt);
                      const canReview = typeof onReview === "function" && !!b.permissions?.canReview;

                      const displayStatus = b.friendly || b.rawStatus || "Pending";

                      const orderCode = b.invoiceNumber || b.id;
                      const hasRating =
                        b.reviewRating !== undefined &&
                        b.reviewRating !== null &&
                        b.reviewRating !== "";

                      return (
                        <tr
                          key={b.id}
                          className={`border-b last:border-0 transition-colors ${
                            idx % 2 === 0 ? "bg-white" : "bg-plum/5/40"
                          } hover:bg-plum/5`}
                        >
                          {/* Order: single-line, clickable pill */}
                          <td className="py-3 pr-4 align-top">
                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-plum/5 text-plum font-mono text-xs md:text-sm border border-plum/10 hover:bg-plum/10 hover:border-plum/30"
                              onClick={() => openDetails(b)}
                            >
                              {orderCode}
                            </button>
                          </td>

                          {/* Date */}
                          <td className="py-3 pr-4 text-plum/90 align-top">
                            {formatDate(b.date)}
                          </td>

                          {/* Status pill */}
                          <td className="py-3 pr-4 align-top">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-xs ${statusToken(
                                displayStatus
                              )}`}
                            >
                              {displayStatus}
                            </span>
                          </td>

                          {/* Total */}
                          <td className="py-3 pr-4 text-plum align-top">
                            <span className="font-medium">
                              {formatMoney(b.total)}
                            </span>
                          </td>

                          {/* Feedback */}
                          <td className="py-3 pr-4 align-top">
                            {hasRating ? (
                              <button
                                type="button"
                                className="inline-flex flex-col items-start gap-0.5 text-xs text-plum/80 hover:text-plum"
                                onClick={() => canReview && onReview(b)}
                              >
                                <span className="flex items-center gap-1">
                                  <RatingStars rating={b.reviewRating} />
                                  <span className="ml-1">
                                    {Number(b.reviewRating)}/5
                                  </span>
                                </span>
                                <span className="text-[10px] text-plum/50">
                                  Your feedback
                                  {b.review?.status === "pending" ? " (awaiting approval)" : ""}
                                </span>
                              </button>
                            ) : canReview ? (
                              <button
                                type="button"
                                className="text-gold inline-flex items-center gap-1 text-xs md:text-sm hover:underline"
                                onClick={() => onReview(b)}
                              >
                                <Star className="w-4 h-4" />
                                Leave review
                              </button>
                            ) : (
                              <span className="text-plum/50 text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  : (
                    <tr>
                      <td
                        colSpan={5}
                        className="py-6 text-center text-plum/70"
                      >
                        No completed appointments yet.
                      </td>
                    </tr>
                  )}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-plum/10 bg-plum/5 p-3 animate-pulse space-y-2"
                >
                  <div className="h-4 w-32 bg-plum/10 rounded" />
                  <div className="h-4 w-40 bg-plum/10 rounded" />
                  <div className="h-4 w-20 bg-plum/10 rounded" />
                </div>
              ))
            ) : bookings.length ? (
              bookings.map((b) => {
                const end = toDate(b.endAt);
                const canReview = typeof onReview === "function" && !!b.permissions?.canReview;

                const displayStatus = b.friendly || b.rawStatus || "Pending";

                const orderCode = b.invoiceNumber || b.id;
                const hasRating =
                  b.reviewRating !== undefined &&
                  b.reviewRating !== null &&
                  b.reviewRating !== "";

                return (
                  <div
                    key={b.id}
                    className="rounded-xl border border-plum/10 bg-white p-3 shadow-xs flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => openDetails(b)}
                      >
                        <p className="text-xs text-plum/60 uppercase tracking-wide font-mono">
                          {orderCode}
                        </p>
                        <p className="text-sm font-semibold text-plum">
                          {b.service || "Cleaning service"}
                        </p>
                      </button>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] ${statusToken(
                          displayStatus
                        )}`}
                      >
                        {displayStatus}
                      </span>
                    </div>

                    <p className="text-xs text-plum/70">
                      {formatDate(b.date)} ·{" "}
                      <span className="font-medium">
                        {formatMoney(b.total)}
                      </span>
                    </p>

                    <div className="flex items-center justify-between mt-1">
                      {hasRating ? (
                        <button
                          type="button"
                          className="inline-flex flex-col items-start gap-0.5 text-[11px] text-plum/80 hover:text-plum"
                          onClick={() => canReview && onReview(b)}
                        >
                          <span className="flex items-center gap-1">
                            <RatingStars rating={b.reviewRating} />
                            <span className="ml-1">
                              {Number(b.reviewRating)}/5
                            </span>
                          </span>
                          <span className="text-[10px] text-plum/50">
                            Your feedback
                            {b.review?.status === "pending" ? " (awaiting approval)" : ""}
                          </span>
                        </button>
                      ) : canReview ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="border-gold/60 text-gold hover:bg-gold/5 h-7 px-2 text-xs"
                          onClick={() => onReview(b)}
                        >
                          <Star className="w-3 h-3 mr-1" />
                          Review
                        </Button>
                      ) : (
                        <span className="text-[11px] text-plum/50">
                          Feedback not available
                        </span>
                      )}

                      <span className="text-[11px] text-plum/50">
                        {displayStatus === "Completed"
                          ? "Completed cleaning"
                          : `Status: ${displayStatus}`}
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="rounded-xl border border-dashed border-plum/20 bg-plum/5 p-4 text-center text-sm text-plum/70">
                Once you&apos;ve had your first cleaning, your history will
                appear here.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {renderDetailsModal()}
    </>
  );
}

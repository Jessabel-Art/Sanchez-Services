// src/components/portal/UpcomingBookings.jsx
import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CalendarDays,
  Info,
  FileDown,
  Calendar as CalendarIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Brand logo for invoice-style header
import logoPrimary from "@/assets/logo/logo-primary.png";

/** Local date helpers */
function toDate(tsLike) {
  if (!tsLike) return null;
  const d = tsLike instanceof Date ? tsLike : new Date(tsLike);
  return Number.isNaN(d.getTime()) ? null : d;
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

// Must match business.client_change_cutoff_hours on the server (Terms of Service: 24 hours).
const CANCELLATION_WINDOW_HOURS = 24;

// ICS helpers for calendar download
function formatIcsDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hour = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const sec = pad(d.getUTCSeconds());
  return `${year}${month}${day}T${hour}${min}${sec}Z`;
}

function buildIcsFromBooking(booking) {
  const start = toDate(booking.startAt || booking.date) || new Date();
  const end =
    toDate(booking.endAt) ||
    new Date(start.getTime() + 2 * 60 * 60 * 1000); // fallback 2 hrs

  const summary = booking.service || "Cleaning appointment";
  const address =
    booking.addressText ||
    booking.addressLine ||
    booking.fullAddress ||
    "Customer address on file";

  const notes = booking.notes || booking.clientNotes || "";

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sanchez Services//Appointments//EN",
    "BEGIN:VEVENT",
    `UID:${booking.id || `booking-${Date.now()}`}`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${notes.replace(/\n/g, "\\n")}`,
    `LOCATION:${address}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export default function UpcomingBookings({
  bookings = [],
  loading = false,
  onAction,
  onViewPayments,
  depositAmount = 50,
  isRepeatClient = false,
}) {
  const hasBookings = bookings && bookings.length > 0;
  const [confirmCancelId, setConfirmCancelId] = useState(null);

    // Does any upcoming booking still have a deposit due?
  const hasUnpaidDeposit =
    !isRepeatClient &&
    bookings.some((b) => {
      const depositDue = Number(
        b.depositDue != null
          ? b.depositDue
          : b.depositAmount && !b.depositPaid
          ? b.depositAmount
          : 0
      );
      return depositDue > 0;
    });

  // Local state for invoice-style details modal
  const [activeBooking, setActiveBooking] = useState(null);
  const [notesDraft, setNotesDraft] = useState("");

  const handleAction = (type, booking) => {
    if (typeof onAction === "function") {
      onAction({ type, booking });
    }
  };

  const openDetails = (booking) => {
    setActiveBooking(booking);
    const existingNotes = booking.notes ?? booking.clientNotes ?? "";
    setNotesDraft(existingNotes);
  };

  const closeDetails = () => {
    if (activeBooking) {
      const originalNotes = activeBooking.notes ?? activeBooking.clientNotes ?? "";
      // Only call update if notes actually changed
      if (notesDraft !== originalNotes && typeof onAction === "function") {
        handleAction("update-notes", {
          ...activeBooking,
          notes: notesDraft,
        });
      }
    }
    setActiveBooking(null);
    setNotesDraft("");
  };

  const handleDownloadPdf = () => {
    if (!activeBooking) return;
    // Delegate actual PDF creation to parent / backend
    if (typeof onAction === "function") {
      handleAction("download-pdf", activeBooking);
    }
  };

  const handleDownloadCalendar = () => {
    if (!activeBooking) return;
    const ics = buildIcsFromBooking(activeBooking);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const orderCode = (activeBooking.invoiceNumber || activeBooking.id || "");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${orderCode || "appointment"}-sanchez-services.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Convenience accessors for modal details
  const getBookingField = (booking, keys, fallback = "Not specified") => {
    for (const key of keys) {
      const v = booking?.[key];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return fallback;
  };

  const renderDetailsModal = () => {
    if (!activeBooking) return null;

    const b = activeBooking;

    const orderCode = (b.invoiceNumber || b.id || "");

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

    const startDate = toDate(b.startAt || b.date);
    const endDate = toDate(b.endAt);

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

    const depositDue = Number(
      b.depositDue != null ? b.depositDue : depositAmount
    );

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
            {/* Invoice-style header */}
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
                  <p>Appointment summary</p>
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

          {/* Body */}
          <div className="space-y-4 text-sm text-plum">
            {/* Core info */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="font-semibold">Service</p>
                <p>{b.service || "Residential Cleaning"}</p>
              </div>

              <div className="space-y-1">
                <p className="font-semibold">Status</p>
                <p>{b.friendly || b.status || "Pending"}</p>
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
                <p>{money(b.total)}</p>
              </div>

              {depositDue > 0 && (
                <div className="space-y-1">
                  <p className="font-semibold">Deposit due</p>
                  <p>{money(depositDue)}</p>
                </div>
              )}

              <div className="space-y-1 sm:col-span-2">
                <p className="font-semibold">Service address</p>
                <p>{address}</p>
              </div>
            </div>

            {/* Customization block */}
            <div className="mt-2 border-t border-plum/10 pt-3 space-y-2">
              <p className="font-semibold text-sm">Home & cleaning details</p>
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

            {/* Notes (editable) */}
            <div className="mt-2 border-t border-plum/10 pt-3 space-y-1">
              <Label
                htmlFor="appointment-notes"
                className="text-xs font-semibold text-plum"
              >
                Notes for your cleaner
              </Label>
              <Textarea
                id="appointment-notes"
                rows={3}
                className="resize-none text-sm"
                placeholder="Gate codes, parking notes, pet instructions, or any last-minute changes."
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
              />
              <p className="text-[11px] text-plum/50">
                Changes you make here will be saved to this appointment when you
                close.
              </p>
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
              <Button
                type="button"
                variant="outline"
                className="border-plum/40 text-plum hover:bg-plum/5 flex items-center gap-2"
                onClick={handleDownloadCalendar}
              >
                <CalendarIcon className="w-4 h-4" />
                Add to calendar
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
            <CalendarDays className="h-5 w-5 text-plum/70" />
            <div>
              <CardTitle className="text-plum text-lg md:text-xl">
                Upcoming Appointments
              </CardTitle>
              <p className="text-xs text-plum/60 mt-0.5">
                See what&apos;s scheduled next and manage your upcoming visits.
              </p>
            </div>
          </div>

          {hasBookings && (
            <span className="inline-flex items-center rounded-full bg-plum/5 px-3 py-1 text-xs text-plum/75 border border-plum/10">
              {bookings.length} upcoming&nbsp;
              {bookings.length === 1 ? "appointment" : "appointments"}
            </span>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Deposit / repeat-client info banner (KEEP THIS) */}
          {hasBookings &&
            (isRepeatClient ? (
              // Repeat clients: keep the “no deposit required” info banner
              <div className="flex items-start gap-2 rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2 text-xs text-emerald-900">
                <Info className="w-4 h-4 mt-0.5" />
                <p>
                  <span className="font-semibold">Great news!</span>{" "}
                  Because you&apos;re a returning client, deposits are no longer
                  required for your appointments.
                </p>
              </div>
            ) : depositAmount > 0 && hasUnpaidDeposit ? (
              // New client *and* at least one upcoming booking still has a deposit due
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-xs text-amber-900">
                <Info className="w-4 h-4 mt-0.5" />
                <p>
                  An{" "}
                  <span className="font-semibold">
                    ${Number(depositAmount).toFixed(0)} non-refundable deposit
                  </span>{" "}
                  is required to secure your first cleaning. Check your Payment
                  &amp; Deposit Info section for details.
                </p>
              </div>
            ) : null)}

          {loading ? (
            // Skeleton list
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-plum/10 bg-plum/5 p-3 animate-pulse space-y-2"
                >
                  <div className="h-4 w-40 bg-plum/10 rounded" />
                  <div className="h-4 w-32 bg-plum/10 rounded" />
                  <div className="h-4 w-24 bg-plum/10 rounded" />
                </div>
              ))}
            </div>
          ) : hasBookings ? (
            <div className="space-y-3">
              {bookings.map((b) => {
                const depositDue = Number(
                  b.depositDue != null ? b.depositDue : depositAmount
                );

                const startDate = toDate(b.startAt || b.date);
                let cancelMessage = null;

                if (
                  startDate &&
                  depositAmount > 0 &&
                  !isRepeatClient // only meaningful when deposits exist
                ) {
                  const freeCancelUntil = new Date(
                    startDate.getTime() -
                      CANCELLATION_WINDOW_HOURS * 60 * 60 * 1000
                  );
                  const now = new Date();

                  if (now <= freeCancelUntil) {
                    cancelMessage = `You can cancel or reschedule online until ${freeCancelUntil.toLocaleString(
                      "en-US",
                      {
                        timeZone: "America/New_York",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }
                    )}`;
                  } else {
                    cancelMessage =
                      "Within 24 hours of the appointment — please contact us to make changes. Late cancellations may forfeit the deposit.";
                  }
                }

                const showDepositRequired = depositDue > 0;

                const isConfirming = confirmCancelId === b.id;

                return (
                  <div
                    key={b.id}
                    className="rounded-xl border border-plum/10 bg-white hover:bg-plum/5 transition-colors"
                  >
                    <div className="p-3 md:p-4 space-y-2 text-sm">
                      {/* Top row: service + status */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-plum">
                          {b.service || "Cleaning appointment"}
                        </div>
                        {b.friendly && (
                          <span className="px-2 py-1 rounded-full text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-100">
                            {b.friendly}
                          </span>
                        )}
                      </div>

                      {/* Date / time */}
                      <div className="text-plum/80">
                        {formatDate(b.date)}{" "}
                        {formatTime(b.date) && <>· {formatTime(b.date)}</>}
                      </div>

                      {/* Total */}
                      <div className="text-plum/80">
                        Total:{" "}
                        <span className="font-medium">
                          {money(b.total)}
                        </span>
                      </div>

                      {/* Cancellation window badge (new clients only) */}
                      {cancelMessage && (
                        <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-900/90 bg-amber-50/70 border border-amber-100 rounded-md px-2 py-1">
                          <Info className="w-3 h-3" />
                          <span>{cancelMessage}</span>
                        </p>
                      )}

                      {/* Per-appointment deposit info (new clients only) */}
                      {showDepositRequired && (
                        <div className="mt-2 text-xs text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                          A deposit of{" "}
                          <span className="font-semibold">
                            {money(depositDue)}
                          </span>{" "}
                          is required to secure this appointment.
                        </div>
                      )}

                      {/* Actions */}
                      <div className="pt-3 flex flex-wrap gap-2 items-center">
                        {!isConfirming && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-plum text-plum hover:bg-plum/5"
                              onClick={() => openDetails(b)}
                            >
                              View details
                            </Button>
                            {(b.permissions?.canPayDeposit || b.permissions?.canPayBalance) && (
                              <Button size="sm" className="bg-gold text-white hover:bg-gold/90" onClick={() => handleAction("pay", b)}>
                                {b.permissions?.canPayDeposit ? "Pay deposit" : "Pay balance"}
                              </Button>
                            )}
                            {b.permissions?.canReschedule && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-plum/40 text-plum hover:bg-plum/5"
                                onClick={() => handleAction("reschedule", b)}
                              >
                                Reschedule
                              </Button>
                            )}
                            {b.permissions?.canCancel && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-red-200 text-red-600 hover:bg-red-50"
                                onClick={() => handleAction("cancel", b)}
                              >
                                Cancel
                              </Button>
                            )}
                            {b.permissions?.changeBlockedReason && (
                              <p className="w-full text-[11px] text-plum/70">{b.permissions.changeBlockedReason}</p>
                            )}
                            {onViewPayments && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-xs text-plum/70 hover:text-plum hover:bg-transparent underline-offset-2 hover:underline"
                                onClick={() => onViewPayments(b)}
                              >
                                View payments
                              </Button>
                            )}
                          </>
                        )}

                        {/* Inline confirmation "modal" */}
                        {isConfirming && (
                          <div className="w-full mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <span>
                              Are you sure you want to cancel this appointment?
                              This cannot be undone.
                            </span>
                            <div className="flex gap-2 justify-end">
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-red-300 text-red-700 hover:bg-red-100"
                                onClick={() => {
                                  handleAction("cancel", b);
                                  setConfirmCancelId(null);
                                }}
                              >
                                Yes, cancel
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-plum/80 hover:text-plum hover:bg-plum/10"
                                onClick={() => setConfirmCancelId(null)}
                              >
                                Keep appointment
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-plum/20 bg-plum/5 p-4 text-center text-sm text-plum/70">
              You don&apos;t have any upcoming appointments yet.
              <div className="mt-3">
                <Button
                  className="bg-gold text-white hover:bg-gold/90 rounded-full"
                  size="sm"
                  onClick={() => {
                    if (onAction) {
                      onAction({ type: "book-new" });
                    }
                  }}
                >
                  Book your next cleaning
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invoice-style details modal for upcoming bookings */}
      {renderDetailsModal()}
    </>
  );
}

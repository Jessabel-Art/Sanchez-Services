// src/components/BookingDetailsModal.jsx
// Reusable booking details modal for displaying appointment information
import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import logoPrimary from "@/assets/logo/logo-primary.png";
import { formatAddress } from "@/lib/utils";

function toDate(tsLike) {
  if (!tsLike) return null;
  if (typeof tsLike.toDate === "function") return tsLike.toDate();
  if (tsLike instanceof Date) return tsLike;
  const d = new Date(tsLike);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(d) {
  if (!d) return "TBD";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatTime(d) {
  if (!d) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function money(n) {
  return Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function getBookingField(b, keys, defaultVal = null) {
  const keyArray = Array.isArray(keys) ? keys : [keys];
  for (const k of keyArray) {
    const v = b[k];
    if (v != null) return v;
  }
  return defaultVal;
}

export function BookingDetailsModal({ open, booking, onClose }) {
  if (!booking) return null;

  const b = booking;
  const orderCode = (b.invoiceNumber || b.id || "");

  const propertyType = getBookingField(b, ["propertyType", "homeType"]);
  const bedrooms = getBookingField(b, ["bedrooms", "numBedrooms"], "—");
  const bathrooms = getBookingField(b, ["bathrooms", "numBathrooms"], "—");
  const conditionLevel = getBookingField(
    b,
    ["conditionLevel", "condition"],
    "Standard"
  );
  const petsValue = getBookingField(b, ["petsOnSite", "hasPets"], "No");
  const pets =
    typeof petsValue === "boolean" ? (petsValue ? "Yes" : "No") : petsValue;

  const fragrancePreference = getBookingField(
    b,
    ["fragrancePreference", "scentPreference"],
    "No preference"
  );

  const addOnsRaw = b.addOns || b.addons || b.addonList || b.selectedAddOns || [];
  const addOnsArray = Array.isArray(addOnsRaw)
    ? addOnsRaw
    : typeof addOnsRaw === "string"
    ? addOnsRaw.split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  const addOns = addOnsArray.length > 0 ? addOnsArray.join(", ") : "None added";

  const startDate = toDate(b.startAt || b.date);
  const endDate = toDate(b.endAt);

  const address = formatAddress(b) || "On file";

  const frequency = getBookingField(b, ["frequency", "serviceFrequency"], "one-time");
  const depositAmount = Number(b.depositAmount || 0);
  const depositDue = Number(b.depositDue != null ? b.depositDue : depositAmount);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
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

          {/* Notes (read-only) */}
          {b.notes && (
            <div className="mt-2 border-t border-plum/10 pt-3 space-y-1">
              <p className="text-xs font-semibold text-plum">
                Notes for cleaner
              </p>
              <p className="text-sm text-plum/80 whitespace-pre-wrap">
                {b.notes}
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// src/pages/PaymentCenterPage.jsx
import PaymentInstructions from "@/components/portal/PaymentInstructions";
import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CreditCard,
  DollarSign,
  FileDown,
  Loader2,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

import { db, auth, functions } from "@/lib/firebase";
import { collection, doc, getDoc, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";

import logoPrimary from "@/assets/logo/logo-primary.png";

/* -------------------------- date helper -------------------------- */
function toDate(tsLike) {
  if (!tsLike) return null;
  if (typeof tsLike.toDate === "function") return tsLike.toDate();
  if (tsLike instanceof Date) return tsLike;
  const d = new Date(tsLike);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits || null;
}

function dedupeById(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!r || !r.id) return;
    map.set(r.id, r);
  });
  return Array.from(map.values());
}

/* ------------------------ address formatter ---------------------- */

function formatAddressFromBooking(b) {
  if (!b) return "Service address not provided";

  const contact = b.contact || {};
  const addrObj = b.address || b.serviceAddressData || {};

  // Primary street line
  const line1 =
    addrObj.line1 || // BookingPage writes this
    addrObj.street ||
    b.addressLine1 ||
    b.street ||
    b.streetAddress ||
    b.serviceAddress ||
    contact.addressLine1 ||
    contact.streetAddress ||
    contact.street ||
    null;

  const city = addrObj.city || b.city || contact.city || null;

  const state =
    addrObj.state ||
    b.state ||
    b.stateCode ||
    contact.state ||
    contact.stateCode ||
    null;

  const zip =
    addrObj.zip ||
    addrObj.postalCode ||
    b.zip ||
    b.zipCode ||
    b.postalCode ||
    contact.zip ||
    contact.zipCode ||
    contact.postalCode ||
    null;

  const cityState = [city, state].filter(Boolean).join(", ") || null;

  // Line 2 = "Providence, RI 02909" (zip optional)
  const line2 = [cityState, zip].filter(Boolean).join(" ") || null;

  if (!line1 && !line2) return "Service address not provided";

  // Use newline so PDF + UI can render two lines with white-space:pre-line
  return [line1, line2].filter(Boolean).join("\n");
}

/* -------------------- payment / invoice helpers ------------------- */

function normalizeStatus(statusRaw) {
  const status = String(statusRaw || "").toLowerCase();
  if (status === "confirmed") return "Confirmed";
  if (status === "completed") return "Completed";
  if (status === "cancelled" || status === "cancelled") return "Cancelled";
  if (status === "pending") return "Pending";
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Pending";
}

function prettifyMethodLabel(methodRaw) {
  if (!methodRaw) return "Not recorded";
  const s = String(methodRaw).toLowerCase();
  if (s.includes("stripe") || s.includes("card")) return "Card (Stripe)";
  if (s.includes("cashapp") || s.includes("cash_app")) return "Cash App";
  if (s.includes("zelle")) return "Zelle";
  if (s.includes("cash")) return "Cash";
  return methodRaw
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Centralized money math for a booking.
 * Mirrors the admin view:
 * - total = full service total
 * - depositAmount / depositPaid from booking
 * - amountPaid = non-deposit payment portion
 * - effectivePaid = amountPaid + (depositPaid ? depositAmount : 0)
 * - remaining = max(total - effectivePaid, 0)
 */
function computeBookingMoney(b) {
  if (!b) {
    return {
      totalPrice: 0,
      depositAmount: 0,
      depositPaid: false,
      basePaid: 0,
      effectivePaid: 0,
      remaining: 0,
      refunded: false,
      refundedAmount: 0,
    };
  }

  const totalPrice =
    b.totalPrice != null
      ? Number(b.totalPrice)
      : b.cost != null
      ? Number(b.cost)
      : 0;

  const depositAmount = Number(b.depositAmount || 0);
  const depositPaid = !!b.depositPaid;

  // Non-deposit payment portion (what admin stores as amountPaid)
  const basePaid = Number(b.amountPaid ?? b.paid ?? 0);

  const refundedAmount = Number(b.refundedAmount || 0);
  const refunded = !!b.refunded || refundedAmount > 0;

  // How much actually counts toward clearing the total
  const effectivePaid = basePaid + (depositPaid ? depositAmount : 0);

  // Detect cancellation (both spellings)
  const status = String(b.status || "").toLowerCase();
  const isCancelled = status === "cancelled" 

  // Cancelled or refunded bookings have no remaining balance
  const remaining = (isCancelled || refunded) ? 0 : Math.max(totalPrice - effectivePaid, 0);

  return {
    totalPrice,
    depositAmount,
    depositPaid,
    basePaid,
    effectivePaid,
    remaining,
    refunded,
    refundedAmount,
  };
}

/**
 * derivePaymentInfo
 * Centralized calculation for amounts, labels, and flags.
 * NOW uses the same money math as the admin page.
 */
function derivePaymentInfo(b) {
  const start = toDate(b.startAt || b.scheduledAt);
  const end = toDate(b.endAt || b.endAtTime || b.endTime);

  const dateStr = start
    ? start.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "TBD";

  const startTimeStr = start
    ? start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  const endTimeStr = end
    ? end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  const dateTimeRange = start
    ? `${dateStr} · ${startTimeStr}${endTimeStr ? ` – ${endTimeStr}` : ""}`
    : "TBD";

  const {
    totalPrice,
    depositAmount,
    depositPaid,
    basePaid,
    effectivePaid,
    remaining,
    refunded,
    refundedAmount,
  } = computeBookingMoney(b);

  const anyPayment = depositPaid || basePaid > 0;

  // Detect cancellation for payment status label
  const status = String(b.status || "").toLowerCase();
  const isCancelled = status === "cancelled" 

  let paymentStatus = "Unpaid";
  if (refunded) {
    paymentStatus = "Refunded";
  } else if (isCancelled) {
    paymentStatus = "Cancelled";
  } else if (remaining <= 0 && anyPayment) {
    paymentStatus = "Paid in full";
  } else if (anyPayment) {
    // match admin wording
    paymentStatus = "Partial payment";
  }

  const statusLabel = refunded
    ? "Refunded"
    : normalizeStatus(
        b.status || (start && start < new Date() ? "completed" : "pending")
      );

  const depositLabel =
    depositAmount > 0 && depositPaid
      ? `Deposit paid ($${depositAmount.toFixed(2)})`
      : depositAmount > 0 && !depositPaid
      ? `Deposit due: $${depositAmount.toFixed(2)}`
      : "No deposit required";

  const paymentMethodRaw =
    b.balancePaymentMethod ||
    b.paymentMethod ||
    b.depositPaymentMethod ||
    (b.stripePaymentIntentId || b.stripeSessionId ? "Card (Stripe)" : null);

  const paymentMethodLabel = prettifyMethodLabel(paymentMethodRaw);

  return {
    start,
    end,
    dateStr,
    startTimeStr,
    endTimeStr,
    dateTimeRange,

    // money
    totalPrice,
    depositAmount,
    depositPaid,
    remainingBalance: remaining,
    amountPaid: basePaid,     // non-deposit payments
    totalPaid: effectivePaid, // deposit + other payments
    refunded,
    refundedAmount,

    // labels
    paymentStatus,
    statusLabel,
    depositLabel,
    paymentMethodLabel,
  };
}

/**
 * Amount actually charged "now" when user clicks Pay balance now.
 * Now based on the same remaining calculation as admin.
 */
function getAmountDueForBooking(b) {
  if (!b) return 0;
  const info = derivePaymentInfo(b);
  return Math.max(0, info.remainingBalance);
}

/* -------- Pricing breakdown helpers (mirror BookingPage.jsx) ----- */

const PRICING_ADDONS = [
  { id: "fridge", name: "Inside Fridge", price: 20 },
  { id: "oven", name: "Inside Oven", price: 20 },
  { id: "windows", name: "Interior Windows", price: 30 },
  { id: "baseboards", name: "Baseboards", price: 25 },
  { id: "laundry", name: "Laundry Fold", price: 15 },
  { id: "garage", name: "Garage Sweep", price: 20 },
  { id: "carpet", name: "Carpet Shampoo", price: 40 },
];

const PRICING_FREQUENCIES = [
  { id: "one-time", name: "One-time", discount: 0 },
  { id: "weekly", name: "Weekly", discount: 0.15 },
  { id: "biweekly", name: "Biweekly", discount: 0.1 },
  { id: "monthly", name: "Monthly", discount: 0.05 },
];

function inferServiceKeyFromBooking(b) {
  if (!b) return "residential-cleaning";
  if (b.service) return b.service;
  if (b.serviceId) return b.serviceId;

  const name = String(b.serviceName || "").toLowerCase();
  if (name.includes("move")) return "move-in-move-out";
  if (name.includes("deep")) return "deep-clean";
  if (name.includes("office")) return "office-cleaning";
  return "residential-cleaning";
}

function computePricingBreakdownFromBooking(b) {
  const service = inferServiceKeyFromBooking(b);

  const bedrooms = Number(b.bedrooms || 0);
  const bathrooms = Number(b.bathrooms || 0);
  const sqft = Number(b.sqft || b.squareFeet || 0);

  const conditionRaw = String(
    b.conditionLevel || b.condition || "standard"
  ).toLowerCase();
  let condition = "standard";
  if (conditionRaw.includes("light")) condition = "light";
  else if (conditionRaw.includes("heavy")) condition = "heavy";

  const pets = b.petsOnSite ? "yes" : "no";

  const frequency = b.frequency || "one-time";
  const promoCode = (b.promoCode || "").toUpperCase();
  const promoApplied = !!b.promoApplied || promoCode === "CLEAN10";

  let addonIds = [];
  if (Array.isArray(b.addOnsIds)) addonIds = b.addOnsIds;
  else if (Array.isArray(b.addOns)) addonIds = b.addOns;
  else if (Array.isArray(b.addons)) addonIds = b.addons;

  const normalizedAddonIds = addonIds
    .map((raw) => {
      if (!raw) return null;
      if (PRICING_ADDONS.some((a) => a.id === raw)) return raw;
      const lower = String(raw).toLowerCase();
      const byName = PRICING_ADDONS.find(
        (a) => a.name.toLowerCase() === lower
      );
      return byName ? byName.id : null;
    })
    .filter(Boolean);

  let base = 0,
    sizeCost = 0,
    conditionMultiplier = 1,
    petsCost = 0,
    addonsCost = 0,
    frequencyDiscount = 0,
    duration = 0;

  if (service === "office-cleaning") {
    base = 0;
    sizeCost = sqft * 0.12;
    duration = sqft / 500;
  } else {
    base = 80;
    sizeCost = bedrooms * 20 + bathrooms * 25;
    duration = bedrooms * 0.5 + bathrooms * 0.5 + 1;
  }

  if (service === "deep-clean") {
    base *= 1.5;
    duration *= 1.5;
  }
  if (service === "move-in-move-out") {
    base *= 1.8;
    duration *= 1.8;
  }

  if (condition === "light") conditionMultiplier = 0.9;
  if (condition === "heavy") {
    conditionMultiplier = 1.25;
    duration *= 1.2;
  }

  if (pets === "yes") {
    petsCost = 15;
    duration += 0.25;
  }

  const addonItems = [];
  normalizedAddonIds.forEach((addonId) => {
    const addon = PRICING_ADDONS.find((a) => a.id === addonId);
    if (addon) {
      addonsCost += addon.price;
      duration += 0.5;
      addonItems.push({
        id: addon.id,
        label: addon.name,
        price: addon.price,
      });
    }
  });

  const subtotalBeforeCondition = base + sizeCost + petsCost + addonsCost;
  const conditionAdjustedTotal = subtotalBeforeCondition * conditionMultiplier;
  const conditionCost = conditionAdjustedTotal - subtotalBeforeCondition;

  const freq = PRICING_FREQUENCIES.find((f) => f.id === frequency);
  if (freq && (service === "residential-cleaning" || service === "deep-clean")) {
    frequencyDiscount = conditionAdjustedTotal * freq.discount;
  }

  const afterFreq = conditionAdjustedTotal - frequencyDiscount;
  const promoDiscount =
    promoApplied && promoCode === "CLEAN10" ? afterFreq * 0.1 : 0;

  const total = Math.max(0, afterFreq - promoDiscount);

  return {
    service,
    bedrooms,
    bathrooms,
    sqft,
    condition,
    pets,
    frequency,
    promoCode,
    base,
    sizeCost,
    conditionCost,
    petsCost,
    addonsCost,
    addonItems,
    subtotalBeforeCondition,
    conditionAdjustedTotal,
    frequencyDiscount,
    promoDiscount,
    total,
    duration: Math.round(duration * 2) / 2,
  };
}

function formatMoney(value) {
  const n = Number(value || 0);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/**
 * Build full invoice line items from a booking using the same math
 * as BookingPage.jsx.
 */
function buildInvoiceLineItems(booking, info, addressOverride) {
  if (!booking || !info) {
    return { lineItems: [], subtotal: 0, discountsTotal: 0, pricing: null };
  }

  const pricing = computePricingBreakdownFromBooking(booking);
  if (!pricing) {
    return {
      lineItems: [],
      subtotal: info.totalPrice,
      discountsTotal: 0,
      pricing: null,
    };
  }

  const addr =
    addressOverride || formatAddressFromBooking(booking) || "Address on file";

  const lineItems = [];

  // 1) Base rate
  lineItems.push({
    key: "base",
    qty: 1,
    label: `${booking.serviceName || "Cleaning service"} – base rate`,
    unitPrice: pricing.base,
    amount: pricing.base,
  });

  // 2) Bedrooms – one row with qty = number of bedrooms
  if (pricing.bedrooms > 0) {
    const qty = pricing.bedrooms;
    const unitPrice = 20; // from BookingPage.jsx: bedrooms * 20
    lineItems.push({
      key: "bedrooms",
      qty,
      label: qty === 1 ? "Bedroom" : "Bedrooms",
      unitPrice,
      amount: qty * unitPrice,
    });
  }

  // 3) Bathrooms – one row with qty = number of bathrooms
  if (pricing.bathrooms > 0) {
    const qty = pricing.bathrooms;
    const unitPrice = 25; // from BookingPage.jsx: bathrooms * 25
    lineItems.push({
      key: "bathrooms",
      qty,
      label: qty === 1 ? "Bathroom" : "Bathrooms",
      unitPrice,
      amount: qty * unitPrice,
    });
  }

  // 4) Pets
  if (pricing.petsCost > 0) {
    lineItems.push({
      key: "pets",
      qty: 1,
      label: "Pets on site",
      detail: "Additional time and supplies for homes with pets",
      unitPrice: pricing.petsCost,
      amount: pricing.petsCost,
    });
  }

  // 5) Add-ons (one row per add-on, qty 1)
  pricing.addonItems.forEach((addon) => {
    lineItems.push({
      key: `addon-${addon.id}`,
      qty: 1,
      label: addon.label,
      unitPrice: addon.price,
      amount: addon.price,
    });
  });

  // Subtotal BEFORE discounts = condition-adjusted total
  let subtotal = pricing.conditionAdjustedTotal;
  let discountsTotal = 0;

  // 6) Condition adjustment (can be positive or negative)
  if (pricing.conditionCost !== 0) {
    lineItems.push({
      key: "condition",
      qty: 1,
      label:
        pricing.condition === "light"
          ? "Light condition adjustment"
          : "Heavy condition adjustment",
      detail:
        pricing.condition === "light"
          ? "Lightly soiled home discount"
          : "Heavier build-up adjustment",
      unitPrice: pricing.conditionCost,
      amount: pricing.conditionCost,
      isDiscount: pricing.conditionCost < 0,
    });
  }

  // 7) Frequency discount
  if (pricing.frequencyDiscount > 0) {
    const freqLabel =
      PRICING_FREQUENCIES.find((f) => f.id === pricing.frequency)?.name ||
      pricing.frequency;

    lineItems.push({
      key: "freq-discount",
      qty: 1,
      label: `Recurring service discount (${freqLabel})`,
      detail: "Discount for recurring cleanings",
      unitPrice: -pricing.frequencyDiscount,
      amount: -pricing.frequencyDiscount,
      isDiscount: true,
    });
    discountsTotal += pricing.frequencyDiscount;
  }

  // 8) Promo discount
  if (pricing.promoDiscount > 0) {
    lineItems.push({
      key: "promo-discount",
      qty: 1,
      label: `Promo code ${pricing.promoCode || ""}`.trim(),
      detail: "Limited-time promotional discount",
      unitPrice: -pricing.promoDiscount,
      amount: -pricing.promoDiscount,
      isDiscount: true,
    });
    discountsTotal += pricing.promoDiscount;
  }

  // Sanity: align with stored total if rounding drift occurs
  const calcTotal = Math.max(0, subtotal - discountsTotal);
  if (Math.abs(calcTotal - info.totalPrice) > 0.5) {
    subtotal = info.totalPrice + discountsTotal;
  }

  return { lineItems, subtotal, discountsTotal, pricing };
}

/* ========================== Component ============================= */

const PaymentCenterPage = () => {
  const navigate = useNavigate();
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [selectedBooking, setSelectedBooking] = useState(null);
  const [selectedContext, setSelectedContext] = useState(null); // "upcoming" | "history" | null

  // Stripe UI state
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null);

  // subscribe to this user's bookings (uid + email + phone fallbacks)
  useEffect(() => {
    let isActive = true;
    const unsubs = [];

    const sortRows = (rows) => {
      const sorted = [...rows];
      sorted.sort((a, b) => {
        const aDate = toDate(a.startAt || a.scheduledAt) || new Date(0);
        const bDate = toDate(b.startAt || b.scheduledAt) || new Date(0);
        return bDate.getTime() - aDate.getTime();
      });
      return sorted;
    };

    const sourceCountsRef = { current: { uid: 0, email: 0, phone: 0 } };

    const mergeBookingsFromSource = (rows, sourceKey) => {
      if (!isActive) return;
      setBookings((prev) => {
        const merged = dedupeById([...prev, ...rows]);
        const sorted = sortRows(merged);
        if (process.env.NODE_ENV !== "production") {
          if (sourceKey) {
            sourceCountsRef.current[sourceKey] = rows.length;
          }
          const counts = sourceCountsRef.current;
          console.log("[payment-center bookings] source counts", {
            uidDocs: counts.uid,
            emailDocs: counts.email,
            phoneDocs: counts.phone,
            mergedTotal: sorted.length,
          });
        }
        return sorted;
      });
      setLoading(false);
      setLoadError(null);
    };

    const attachEmailListeners = (emailLower) => {
      if (!emailLower) return;
      const qTop = query(
        collection(db, "bookings"),
        where("contactEmailLower", "==", emailLower)
      );
      const qLegacy = query(
        collection(db, "bookings"),
        where("contact.emailLower", "==", emailLower)
      );

      [qTop, qLegacy].forEach((qRef) => {
        const unsub = onSnapshot(
          qRef,
          (snap) => {
            const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            mergeBookingsFromSource(rows, "email");
          },
          (err) => {
            console.error("PaymentCenter email listener error", err);
            setLoadError(err?.message || String(err));
            setLoading(false);
          }
        );
        unsubs.push(unsub);
      });
    };

    const attachPhoneListeners = (normalizedPhone, rawPhone) => {
      if (!normalizedPhone) return;

      const qTop = query(
        collection(db, "bookings"),
        where("contactPhoneNormalized", "==", normalizedPhone)
      );
      const qLegacyNorm = query(
        collection(db, "bookings"),
        where("contact.phoneNormalized", "==", normalizedPhone)
      );
      const qLegacyDigits = query(
        collection(db, "bookings"),
        where("contact.phone", "==", normalizedPhone)
      );
      const qLegacyRaw = rawPhone
        ? query(
            collection(db, "bookings"),
            where("contact.phoneRaw", "==", rawPhone)
          )
        : null;

      [qTop, qLegacyNorm, qLegacyDigits, qLegacyRaw]
        .filter(Boolean)
        .forEach((qRef) => {
          const unsub = onSnapshot(
            qRef,
            (snap) => {
              const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
              mergeBookingsFromSource(rows, "phone");
            },
            (err) => {
              console.error("PaymentCenter phone listener error", err);
              setLoadError(err?.message || String(err));
              setLoading(false);
            }
          );
          unsubs.push(unsub);
        });
    };

    const run = async () => {
      const user = auth.currentUser;
      if (!user) {
        setLoading(false);
        setBookings([]);
        return;
      }

      let emailLower = (user.email || "").toLowerCase();
      let phoneRaw = user.phoneNumber || "";

      try {
        const profileSnap = await getDoc(doc(db, "users", user.uid));
        if (profileSnap.exists()) {
          const data = profileSnap.data() || {};
          emailLower = (data.email || user.email || "").toLowerCase();
          phoneRaw = data.phone || user.phoneNumber || "";
        }
      } catch (err) {
        console.warn("PaymentCenter profile read failed", err);
      }

      const normalizedPhone = normalizePhone(phoneRaw);

      const bookingsRef = collection(db, "bookings");
      const qUid = query(bookingsRef, where("userId", "==", user.uid));

      const unsubUid = onSnapshot(
        qUid,
        (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          mergeBookingsFromSource(rows, "uid");
        },
        (err) => {
          console.error("PaymentCenter bookings error", err);
          setLoadError(err?.message || String(err));
          setLoading(false);
        }
      );
      unsubs.push(unsubUid);

      attachEmailListeners(emailLower);
      attachPhoneListeners(normalizedPhone, phoneRaw);
    };

    run();

    return () => {
      isActive = false;
      unsubs.forEach((u) => {
        try {
          u();
        } catch {}
      });
    };
  }, []);

  const now = new Date();

  const upcomingPayments = useMemo(() => {
    return bookings.filter((b) => {
      const start = toDate(b.startAt || b.scheduledAt);
      // Upcoming = has a start time in the future, regardless of payment status
      if (!start) return false;
      return start >= now;
    });
  }, [bookings, now]);

  const billingHistory = useMemo(() => {
    return bookings.filter((b) => {
      const start = toDate(b.startAt || b.scheduledAt);
      if (!start || start >= now) return false;

      const status = String(b.status || "").toLowerCase();
      const depositPaid = !!b.depositPaid;
      const paid = Number(b.paid || 0);
      const refunded = !!b.refunded || Number(b.refundedAmount || 0) > 0;

      const anyPayment = depositPaid || paid > 0 || refunded;
      const doneStatus =
        status === "completed" ||
        status === "cancelled" ||
        status === "cancelled";

      return anyPayment || doneStatus;
    });
  }, [bookings, now]);

  // --- Summary: next appointment + amount due now (ONLY next booking) ---
  const summary = useMemo(() => {
    if (!upcomingPayments.length) {
      return { nextUpcoming: null, totalDueNow: 0 };
    }

    let nextUpcoming = upcomingPayments[0];
    let earliestDate =
      toDate(nextUpcoming.startAt || nextUpcoming.scheduledAt) ||
      new Date(8640000000000000);

    upcomingPayments.forEach((b) => {
      const start = toDate(b.startAt || b.scheduledAt);
      if (start && start < earliestDate) {
        earliestDate = start;
        nextUpcoming = b;
      }
    });

    const info = derivePaymentInfo(nextUpcoming);
    const totalDueNow = Math.max(0, info.remainingBalance);

    return { nextUpcoming, totalDueNow };
  }, [upcomingPayments]);

  // list row renderer – clickable with gold hover + View invoice
  const renderBookingRow = (b, { onClick } = {}) => {
    const {
      dateStr,
      startTimeStr,
      totalPrice,
      remainingBalance,
      statusLabel,
      refunded,
    } = derivePaymentInfo(b);

    const status = statusLabel.toLowerCase();

    return (
      <button
        type="button"
        key={b.id}
        onClick={onClick}
        className="
          group
          w-full text-left
          py-3 px-3 sm:px-4
          flex flex-col gap-2
          sm:grid sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_auto] sm:items-center
          rounded-lg
          border border-transparent
          bg-white/70
          transition-all
          hover:bg-gold/10
          active:bg-gold/20
          hover:border-gold/50
          focus-visible:outline-none
          focus-visible:ring-2 focus-visible:ring-gold/60
        "
      >
        {/* Appointment info */}
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-plum">
              {b.serviceName || "Cleaning service"}
            </div>
          </div>
          <div className="text-xs text-plum/70">
            {dateStr}
            {startTimeStr ? ` · ${startTimeStr}` : ""}
          </div>
          <div className="mt-1 text-xs font-medium text-gold group-hover:underline underline-offset-2">
            View invoice
          </div>
        </div>

        {/* Amounts */}
        <div className="sm:text-right">
          <div className="text-sm font-semibold text-plum">
            ${totalPrice.toFixed(2)}
          </div>
          {remainingBalance > 0 && (
            <div className="text-xs text-rose-700">
              Remaining: ${remainingBalance.toFixed(2)}
            </div>
          )}
          {refunded && (
            <div className="text-xs text-rose-600 mt-0.5 font-medium">
              Refunded
            </div>
          )}
        </div>

        {/* Status pill */}
        <div className="flex sm:justify-end">
          <span
            className={`
              inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium
              ${
                refunded
                  ? "bg-rose-50 text-rose-700"
                  : status.includes("completed")
                  ? "bg-emerald-50 text-emerald-700"
                  : status.includes("confirmed")
                  ? "bg-gold/10 text-gold-900"
                  : status.includes("cancelled") || status.includes("cancelled")
                  ? "bg-rose-50 text-rose-700"
                  : "bg-plum/5 text-plum/80"
              }
            `}
          >
            {statusLabel}
          </span>
        </div>
      </button>
    );
  };

  const user = auth.currentUser;

  const { nextUpcoming, totalDueNow } = summary;

  const nextStart = nextUpcoming
    ? toDate(nextUpcoming.startAt || nextUpcoming.scheduledAt)
    : null;
  const nextDateStr = nextStart
    ? nextStart.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const nextTimeStr = nextStart
    ? nextStart.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const openInvoiceModal = (booking, context) => {
    setSelectedBooking(booking);
    setSelectedContext(context);
  };

  const closeInvoiceModal = () => {
    setSelectedBooking(null);
    setSelectedContext(null);
  };

  /* ---------------- Stripe: Pay balance now (callable) ---------------- */

  const handlePayBalanceNow = async () => {
    setPayError(null);

    if (!nextUpcoming) {
      setPayError("No upcoming appointment to pay for.");
      return;
    }

    const amountDue = getAmountDueForBooking(nextUpcoming);

    if (!amountDue || amountDue <= 0) {
      setPayError(
        "There is no remaining balance due for your next appointment."
      );
      return;
    }

    const user = auth.currentUser;

    if (!user) {
      setPayError("You need to be signed in to pay your balance online.");
      return;
    }

    const info = derivePaymentInfo(nextUpcoming);

    const customerEmail =
      nextUpcoming.contact?.email || user.email || "".trim();
    const customerName =
      nextUpcoming.contact?.name || user.displayName || "";

    if (!customerEmail) {
      setPayError(
        "We’re missing an email address for your booking. Please contact Sterling to pay by card."
      );
      return;
    }

    try {
      setPaying(true);

      const createCheckoutSession = httpsCallable(
        functions,
        "createStripeCheckoutSession"
      );

      const result = await createCheckoutSession({
        bookingId: nextUpcoming.id,
        totalPrice: info.totalPrice,
        depositAmount: info.depositAmount,
        remainingBalance: info.remainingBalance,
        customerEmail,
        customerName,
        mode: "remaining_balance",
        purpose: "remaining_balance",
      });

      const data = result?.data || {};
      const url = data.url;

      if (!url) {
        throw new Error(
          "Card payments are not fully configured yet. You can still pay at the time of service."
        );
      }

      window.location.href = url;
    } catch (err) {
      console.error("Pay balance error", err);
      setPayError(
        err?.message ||
          "Something went wrong starting your payment session. You can also pay at the time of service."
      );
    } finally {
      setPaying(false);
    }
  };

  /* ---------------- Download invoice helpers ---------------- */

  const handleDownloadInvoice = (format, booking) => {
    if (!booking) return;
    const info = derivePaymentInfo(booking);
    const address = formatAddressFromBooking(booking);

    const homeDetails = {
      propertyType: booking.propertyType || "Not specified",
      condition: booking.conditionLevel || booking.condition || "Standard",
      bedrooms:
        booking.bedrooms != null && booking.bedrooms !== ""
          ? booking.bedrooms
          : "—",
      bathrooms:
        booking.bathrooms != null && booking.bathrooms !== ""
          ? booking.bathrooms
          : "—",
      pets:
        booking.petsOnSite != null
          ? booking.petsOnSite
            ? "Yes"
            : "No"
          : "No",
      fragrance: booking.fragrancePreference || "No preference",
      addOns:
        (Array.isArray(booking.addOns) && booking.addOns.length > 0
          ? booking.addOns.join(", ")
          : booking.addOnsText) || "None added",
    };

    if (format === "csv") {
      const rows = [
        ["Invoice ID", booking.id || ""],
        ["Service", booking.serviceName || "Cleaning service"],
        ["Status", info.statusLabel],
        ["Payment Status", info.paymentStatus],
        ["Payment Method", info.paymentMethodLabel],
        ["Date / Time", info.dateTimeRange],
        ["Frequency", booking.frequency || "one-time"],
        ["Total", `$${info.totalPrice.toFixed(2)}`],
        ["Deposit", `$${info.depositAmount.toFixed(2)}`],
        ["Deposit Paid", info.depositPaid ? "Yes" : "No"],
        ["Amount Paid", `$${info.amountPaid.toFixed(2)}`],
        ["Remaining Balance", `$${info.remainingBalance.toFixed(2)}`],
        ["Refunded", info.refunded ? "Yes" : "No"],
        [
          "Refunded Amount",
          info.refundedAmount > 0 ? `$${info.refundedAmount.toFixed(2)}` : "$0.00",
        ],
        ["Service Address", address],
        ["Property Type", homeDetails.propertyType],
        ["Condition Level", homeDetails.condition],
        ["Bedrooms", homeDetails.bedrooms],
        ["Bathrooms", homeDetails.bathrooms],
        ["Pets on Site", homeDetails.pets],
        ["Fragrance Preference", homeDetails.fragrance],
        ["Add-ons", homeDetails.addOns],
        ["Notes", booking.notes || ""],
      ];

      const csvLines = rows.map(([k, v]) => {
        const safeKey = String(k).replace(/"/g, '""');
        const safeVal = String(v ?? "").replace(/"/g, '""');
        return `"${safeKey}","${safeVal}"`;
      });

      const blob = new Blob([csvLines.join("\n")], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute(
        "download",
        `invoice-${booking.id || "booking"}.csv`
      );
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } else if (format === "pdf") {
  const win = window.open("", "_blank");
      if (!win) return;

      const orderCode = booking.orderCode || booking.id?.slice(0, 8) || "";

      const invoiceDate = new Date().toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      const dueDate = invoiceDate;

      const billName =
        booking.contact?.name ||
        booking.name ||
        booking.customerName ||
        "On file";

      const billAddress = address;

      const { lineItems, subtotal, discountsTotal } = buildInvoiceLineItems(
        booking,
        info,
        address
      );

      const rowsHtml = lineItems
        .map(
          (item) => `
            <tr>
              <td style="padding:10px 8px; border-bottom:1px solid #f1e3ff; font-size:12px;">${item.qty}</td>
              <td style="padding:10px 8px; border-bottom:1px solid #f1e3ff; font-size:12px;">
                <div>${item.label}</div>
                ${
                  item.detail
                    ? `<div style="margin-top:2px; font-size:11px; color:#9b74a6;">${item.detail}</div>`
                    : ""
                }
              </td>
              <td style="padding:10px 8px; border-bottom:1px solid #f1e3ff; font-size:12px; text-align:right;">
                ${formatMoney(item.unitPrice)}
              </td>
              <td style="padding:10px 8px; border-bottom:1px solid #f1e3ff; font-size:12px; text-align:right; ${
                item.isDiscount ? "color:#b4234b;" : ""
              }">
                ${formatMoney(item.amount)}
              </td>
            </tr>
          `
        )
        .join("");

      const html = `<!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>Invoice - ${orderCode}</title>
            <style>
              html,body{margin:0;padding:0;background:#f7f2fb;-webkit-print-color-adjust:exact;color-adjust:exact}
              .invoice-wrapper{max-width:840px;margin:32px auto;background:#ffffff;padding:32px 36px;box-sizing:border-box;}
              img{max-width:100%;height:auto}
              @page{size:auto;margin:10mm}
              @media print{
                body,html{background:#ffffff}
                .invoice-wrapper{box-shadow:none;margin:0;padding:6mm}
                *{ -webkit-print-color-adjust:exact; print-color-adjust:exact }
              }
            </style>
          </head>
          <body style="margin:0; background:#f7f2fb; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#2c0735;">
            <div style="max-width:840px; margin:32px auto; background:#ffffff; border-radius:8px; padding:32px 36px; box-sizing:border-box; box-shadow:0 18px 40px rgba(31, 4, 43, 0.09);">
              
              <!-- Brand / header row -->
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:28px;">
                <div style="display:flex; align-items:center; gap:12px;">
                  <div style="width:40px; height:40px; border-radius:999px; overflow:hidden; display:flex; align-items:center; justify-content:center; border:1px solid #f1d7ff;">
                    <img src="${logoPrimary}" alt="Sanchez Services" style="max-width:100%; max-height:100%; object-fit:contain;" />
                  </div>
                  <div>
                    <div style="font-size:14px; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:#7e4b8e;">Sanchez Services</div>
                    <div style="margin-top:4px; font-size:12px; color:#9b74a6;">
                      Residential & commercial cleaning<br/>
                      Rhode Island & Massachusetts
                    </div>
                  </div>
                </div>
                <div style="text-align:right; font-size:11px; color:#9b74a6;">
                  <div style="margin-bottom:4px;">Invoice # <span style="font-weight:600; letter-spacing:0.12em;">${orderCode}</span></div>
                  <div>Invoice date: <span style="font-weight:500;">${invoiceDate}</span></div>
                  <div>Due date: <span style="font-weight:500;">${dueDate}</span></div>
                </div>
              </div>

              <!-- Main title -->
              <h1 style="margin:0 0 28px; text-align:center; font-size:18px; letter-spacing:0.28em; text-transform:uppercase; color:#1a0430;">
                Cleaning services invoice
              </h1>

              <!-- Bill to / appointment meta -->
              <div style="display:flex; flex-wrap:wrap; gap:32px; margin-bottom:28px; font-size:13px;">
                <div style="flex:1 1 260px;">
                  <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">
                    Bill to
                  </div>
                  <div style="font-size:14px; font-weight:500; color:#2c0735;">${billName}</div>
                  <div style="margin-top:4px; white-space:pre-line; color:#5b4461;">
                    ${billAddress || "Address on file"}
                  </div>
                </div>
                <div style="flex:1 1 220px;">
                  <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">
                    Appointment
                  </div>
                  <div><strong>Service:</strong> ${booking.serviceName || "Cleaning service"}</div>
                  <div style="margin-top:4px;"><strong>Date / time:</strong> ${info.dateTimeRange}</div>
                  <div style="margin-top:4px;"><strong>Frequency:</strong> ${booking.frequency || "one-time"}</div>
                  <div style="margin-top:4px;"><strong>Status:</strong> ${info.statusLabel}</div>
                  <div style="margin-top:4px;"><strong>Service address:</strong> ${address}</div>
                </div>
              </div>

              <!-- Line items table (full breakdown) -->
              <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:20px;">
                <thead>
                  <tr>
                    <th style="text-align:left; padding:10px 8px; background:#5b0b73; border-bottom:1px solid #e5d1ff; font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:#ffffff;">Qty</th>
                    <th style="text-align:left; padding:10px 8px; background:#5b0b73; border-bottom:1px solid #e5d1ff; font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:#ffffff;">Description</th>
                    <th style="text-align:right; padding:10px 8px; background:#5b0b73; border-bottom:1px solid #e5d1ff; font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:#ffffff;">Unit price</th>
                    <th style="text-align:right; padding:10px 8px; background:#5b0b73; border-bottom:1px solid #e5d1ff; font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:#ffffff;">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml}
                </tbody>
              </table>

              <!-- Totals using same math -->
              <div style="display:flex; justify-content:flex-end; margin-bottom:24px; font-size:13px;">
                <div style="width:260px;">
                  <div style="display:flex; justify-content:space-between; padding:4px 0;">
                    <span>Subtotal</span>
                    <span>${formatMoney(subtotal)}</span>
                  </div>
                  ${
                    discountsTotal > 0
                      ? `<div style="display:flex; justify-content:space-between; padding:4px 0; color:#b4234b;">
                          <span>Discounts</span>
                          <span>${formatMoney(-discountsTotal)}</span>
                        </div>`
                      : ""
                  }
                  <div style="display:flex; justify-content:space-between; padding:4px 0;">
                    <span>Deposit ${info.depositPaid ? "(received)" : "(due)"}</span>
                    <span>${formatMoney(info.depositAmount)}</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; padding:6px 0; border-top:1px solid #edd8ff; margin-top:6px; font-weight:600;">
                    <span>Amount due</span>
                    <span>${formatMoney(info.remainingBalance)}</span>
                  </div>
                </div>
              </div>

              <!-- Payment info + notes -->
              <div style="display:flex; flex-wrap:wrap; gap:24px; font-size:12px; margin-bottom:16px;">
                <div style="flex:1 1 260px;">
                  <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">
                    Payment details
                  </div>
                  <div>Payment status: <strong>${info.paymentStatus}</strong></div>
                  <div>Amount paid: <strong>${formatMoney(info.amountPaid)}</strong></div>
                  <div>Payment method: <strong>${info.paymentMethodLabel}</strong></div>
                  ${
                    info.refunded
                      ? `<div style="margin-top:4px; color:#b4234b;">Refunded: ${formatMoney(info.refundedAmount)}</div>`
                      : ""
                  }
                </div>

                <div style="flex:1 1 260px;">
                  <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">
                    Notes for your cleaner
                  </div>
                  <div style="border:1px solid #edd8ff; border-radius:4px; padding:8px; min-height:70px;">
                    ${
                      booking.notes
                        ? booking.notes
                        : "<span style='color:#b39bbc;'>No notes added.</span>"
                    }
                  </div>
                </div>
              </div>

              <!-- Terms -->
              <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #e5d1ff; font-size:11px; color:#9b74a6;">
                <strong>Terms &amp; conditions</strong><br/>
                Payment is due at the time of your appointment unless otherwise arranged with Sterling. Deposits are non-refundable but may be transferred once to a new date with proper notice according to the cancellation policy.
              </div>
            </div>
          </body>
        </html>
      `;

      try {
        win.document.open();
        win.document.write(html + `<script>(function(){function p(){try{window.focus();setTimeout(function(){try{window.print()}catch(e){}},350)}catch(e){}}if(document.readyState==='complete'){p()}else{window.addEventListener('load',p);setTimeout(p,1200)}})()</`+`script>`);
        win.document.close();
      } catch (e) {
        try {
          win.document.write(html);
          win.document.close();
        } catch (err) {}
      }
    }
  };

  const selectedInfo = selectedBooking ? derivePaymentInfo(selectedBooking) : null;

  const selectedHomeDetails =
    selectedBooking && selectedInfo
      ? {
          propertyType: selectedBooking.propertyType || "Not specified",
          condition:
            selectedBooking.conditionLevel ||
            selectedBooking.condition ||
            "Standard",
          bedrooms:
            selectedBooking.bedrooms != null &&
            selectedBooking.bedrooms !== ""
              ? selectedBooking.bedrooms
              : "—",
          bathrooms:
            selectedBooking.bathrooms != null &&
            selectedBooking.bathrooms !== ""
              ? selectedBooking.bathrooms
              : "—",
          pets:
            selectedBooking.petsOnSite != null
              ? selectedBooking.petsOnSite
                ? "Yes"
                : "No"
              : "No",
          fragrance: selectedBooking.fragrancePreference || "No preference",
          addOns:
            (Array.isArray(selectedBooking.addOns) &&
            selectedBooking.addOns.length > 0
              ? selectedBooking.addOns.join(", ")
              : selectedBooking.addOnsText) || "None added",
          address: formatAddressFromBooking(selectedBooking),
        }
      : null;

  const {
    lineItems: invoiceLineItems,
    subtotal: invoiceSubtotal,
    discountsTotal: invoiceDiscountTotal,
  } =
    selectedBooking && selectedInfo && selectedHomeDetails
      ? buildInvoiceLineItems(
          selectedBooking,
          selectedInfo,
          selectedHomeDetails.address
        )
      : {
          lineItems: [],
          subtotal: 0,
          discountsTotal: 0,
        };

  return (
    <div className="py-12 sm:py-16 md:py-20 px-3 sm:px-4 bg-[#FFF7FB] min-h-[80vh]">
      <motion.div
        className="max-w-5xl mx-auto space-y-6 sm:space-y-7 md:space-y-8"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >

        {/* Header */}
        <header className="text-center space-y-2">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-plum">
            Payment Center
          </h1>
          <p className="text-xs sm:text-sm md:text-base text-plum/75 max-w-2xl mx-auto">
            See upcoming payments, download invoices, and review how deposits
            and payment methods work for your appointments.
          </p>
        </header>

        {/* Summary: next appointment + amount due now */}
        {user && (
          <Card className="bg-white border-plum/10 shadow-sm">
            <CardContent className="py-3 sm:py-4 md:py-5">
              <div className="grid gap-4 sm:gap-5 md:gap-6 md:grid-cols-2 items-center">
                {/* left: amount due now */}
                <div>
                  <p className="text-xs uppercase tracking-[0.12em] text-plum/60 font-semibold">
                    Amount due now
                  </p>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-xl sm:text-2xl md:text-3xl font-bold text-plum">
                      ${totalDueNow.toFixed(2)}
                    </span>
                    <span className="text-xs text-plum/60">
                      for your next scheduled appointment
                    </span>
                  </div>
                  <div className="mt-3">
                    <Button
                      size="sm"
                      className="rounded-full bg-gold text-white hover:bg-gold/90 disabled:opacity-60 flex items-center gap-2"
                      onClick={handlePayBalanceNow}
                      disabled={!nextUpcoming || totalDueNow <= 0 || paying}
                    >
                      {paying && (
                        <Loader2
                          className="w-4 h-4 animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      <span>
                        {paying ? "Connecting to Stripe..." : "Pay balance now"}
                      </span>
                    </Button>
                  </div>
                  {payError && (
                    <p className="mt-2 text-[11px] text-rose-700 max-w-sm">
                      {payError}
                    </p>
                  )}
                </div>

                {/* right: next appointment */}
                <div className="md:border-l md:border-plum/10 md:pl-6">
                  <p className="text-xs uppercase tracking-[0.12em] text-plum/60 font-semibold">
                    Next appointment
                  </p>
                  {nextUpcoming && nextStart ? (
                    <>
                      <p className="mt-1 text-sm font-semibold text-plum">
                        {nextUpcoming.serviceName || "Cleaning service"}
                      </p>
                      <p className="text-xs text-plum/70">
                        {nextDateStr}
                        {nextTimeStr ? ` • ${nextTimeStr}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-plum/70">
                        Tap the appointment in the list below to view your full
                        invoice and details.
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-plum/70">
                      You don&apos;t have any upcoming payments right now. New
                      bookings will appear here once scheduled.
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* If not signed in, show gate and stop */}
        {!user && (
          <Card className="bg-white border-plum/10 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-plum">
                <CreditCard className="w-5 h-5 text-gold" />
                Sign in to view payments
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-plum/80 space-y-3">
              <p>
                To see your deposits and billing history, log in to your
                Sanchez Services account.
              </p>
              <Button
                className="bg-gold text-white hover:bg-gold/90 rounded-full"
                onClick={() => navigate("/portal")}
              >
                Go to My Account
              </Button>
            </CardContent>
          </Card>
        )}

        {user && (
          <>
            {/* Top row: upcoming + billing side by side */}
            <div className="grid gap-4 md:grid-cols-2">
              {/* Upcoming payments */}
              <Card
                id="upcoming-payments-card"
                className="bg-white border-plum/10 shadow-sm"
              >
                <CardHeader className="flex flex-row items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-plum">
                    <DollarSign className="w-5 h-5 text-gold" />
                    Upcoming payments
                  </CardTitle>
                  {loading && (
                    <span className="text-xs text-plum/60">Loading…</span>
                  )}
                </CardHeader>
                <CardContent className="text-sm text-plum/80">
                  {loadError && (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                      We couldn&apos;t load your payment info. Try refreshing the
                      page. If this keeps happening, Sterling or your developer
                      may need to adjust Firestore indexes.
                    </div>
                  )}

                  {!loadError && !loading && upcomingPayments.length === 0 && (
                    <div className="rounded-xl border border-plum/15 bg-plum/5 p-4 text-xs text-plum/70 text-center">
                      You don&apos;t have any deposits or balances due right now.
                    </div>
                  )}

                  {!loadError && upcomingPayments.length > 0 && (
                    <>
                      <div className="hidden sm:grid sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_auto] px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-plum/55">
                        <span>Appointment</span>
                        <span className="text-right">Amount | Status</span>
                        <span className="sr-only">Status pill</span>
                      </div>
                      <div className="divide-y divide-plum/10">
                        {upcomingPayments.map((b) =>
                          renderBookingRow(b, {
                            onClick: () => openInvoiceModal(b, "upcoming"),
                          })
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Billing history */}
              <Card className="bg-white border-plum/10 shadow-sm">
                <CardHeader className="flex flex-row items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-plum">
                    <DollarSign className="w-5 h-5 text-gold" />
                    Billing history
                  </CardTitle>
                  {!loading && billingHistory.length > 0 && (
                    <span className="text-xs text-plum/60">
                      Showing your most recent appointments
                    </span>
                  )}
                </CardHeader>
                <CardContent className="text-sm text-plum/80">
                  {!loading && billingHistory.length === 0 && (
                    <div className="rounded-xl border border-plum/15 bg-plum/5 p-4 text-xs text-plum/70 text-center">
                      Once you complete appointments and pay deposits, your
                      history will appear here.
                    </div>
                  )}

                  {billingHistory.length > 0 && (
                    <>
                      <div className="hidden sm:grid sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_auto] px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-plum/55">
                        <span>Appointment</span>
                        <span className="text-right">Amount | Status</span>
                        <span className="sr-only">Status pill</span>
                      </div>
                      <div className="divide-y divide-plum/10">
                        {billingHistory.map((b) =>
                          renderBookingRow(b, {
                            onClick: () => openInvoiceModal(b, "history"),
                          })
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            <PaymentInstructions
              paymentInfo={{
                depositAmount: 50,
                cashApp: "$Sterlingsterls",
                zelle: "401-658-6708 (recipient: Sterling Sanchez)",
                cash: true,
                stripeEnabled: false, // flip to true once Stripe is fully live for clients
              }}
            />

            {/* Invoice / booking details modal */}
            <Dialog
              open={!!selectedBooking}
              onOpenChange={(open) => !open && closeInvoiceModal()}
            >
              <DialogContent className="max-w-3xl bg-transparent border-none shadow-none p-0">
                <DialogHeader className="hidden">
                  <DialogTitle>Appointment invoice</DialogTitle>
                </DialogHeader>

                {selectedBooking && selectedInfo && selectedHomeDetails && (
                  <div className="bg-white rounded-lg md:rounded-xl shadow-lg border border-plum/10 overflow-hidden">
                    {/* Brand / header */}
                    <div className="px-3 sm:px-4 md:px-5 pt-3 sm:pt-4 pb-2 sm:pb-3 flex items-start justify-between gap-2 sm:gap-3">
                      <div className="flex items-center gap-2 sm:gap-3">
                        <div className="w-8 sm:w-9 h-8 sm:h-9 rounded-full border border-plum/10 flex items-center justify-center overflow-hidden flex-shrink-0">
                          <img
                            src={logoPrimary}
                            alt="Sanchez Services"
                            className="max-w-full max-h-full object-contain"
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase text-plum/60">
                            Sanchez Services
                          </p>
                          <p className="text-[10px] sm:text-xs text-plum/70">
                            Residential &amp; commercial cleaning · RI &amp; MA
                          </p>
                        </div>
                      </div>
                      <div className="text-right text-[10px] sm:text-[11px] text-plum/60 flex-shrink-0">
                        <p>
                          Invoice #{" "}
                          <span className="font-semibold tracking-[0.14em] text-plum">
                            {selectedBooking.orderCode ||
                              selectedBooking.id?.slice(0, 8) ||
                              "—"}
                          </span>
                        </p>
                        <p className="mt-1">
                          Invoice date: {selectedInfo.dateStr}
                        </p>
                      </div>
                    </div>

                    {/* Title */}
                    <div className="px-3 sm:px-4 md:px-5 pb-3 sm:pb-4 border-t border-plum/10">
                      <h2 className="text-center text-xs sm:text-sm md:text-base font-semibold tracking-[0.25em] uppercase text-plum">
                        Cleaning services invoice
                      </h2>
                    </div>

                    {/* Bill to + appointment meta */}
                    <div className="px-3 sm:px-4 md:px-5 pb-3 sm:pb-4 border-t border-plum/10">
                      <div className="grid md:grid-cols-2 gap-4 sm:gap-5 md:gap-6 text-xs text-plum/80">
                        <div>
                          <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-[0.12em] text-plum/60 mb-1">
                            Bill to
                          </p>
                          <p className="text-xs sm:text-sm font-medium text-plum">
                            {selectedBooking.contact?.name ||
                              selectedBooking.customerName ||
                              "Sanchez Services client"}
                          </p>
                          <p className="mt-1 text-xs text-plum/70 whitespace-pre-line">
                            {selectedHomeDetails.address || "Address on file"}
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-plum/60 mb-1">
                            Appointment
                          </p>
                          <p className="text-sm font-medium text-plum">
                            {selectedBooking.serviceName || "Cleaning service"}
                          </p>
                          <p className="mt-1 text-xs text-plum/70">
                            {selectedInfo.dateTimeRange}
                          </p>
                          <p className="mt-1 text-xs text-plum/70">
                            Frequency: {selectedBooking.frequency || "one-time"}
                          </p>
                          <p className="mt-1 text-xs text-plum/70">
                            Status: {selectedInfo.statusLabel}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-plum/10" />

                    {/* Line items + totals */}
                    <div className="px-5 pb-4 pt-4">
                      <div className="rounded-lg border border-plum/10 overflow-hidden text-xs text-plum/80">
                        <div className="grid grid-cols-[0.5fr_2.5fr_1fr_1fr] bg-plum text-white px-3 py-2 font-semibold uppercase tracking-[0.12em] text-[10px]">
                          <span>Qty</span>
                          <span>Description</span>
                          <span className="text-right">Unit price</span>
                          <span className="text-right">Amount</span>
                        </div>

                        {invoiceLineItems.map((item) => (
                          <div
                            key={item.key}
                            className="grid grid-cols-[0.5fr_2.5fr_1fr_1fr] px-3 py-2 border-t border-plum/10 text-[12px]"
                          >
                            <span>{item.qty}</span>
                            <div>
                              <p>{item.label}</p>
                              {item.detail && (
                                <p className="mt-0.5 text-[11px] text-plum/60">
                                  {item.detail}
                                </p>
                              )}
                            </div>
                            <span className="text-right">
                              {formatMoney(item.unitPrice)}
                            </span>
                            <span
                              className={`text-right ${
                                item.isDiscount ? "text-rose-700" : ""
                              }`}
                            >
                              {formatMoney(item.amount)}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 flex justify-end">
                      <div className="w-full max-w-xs text-xs text-plum/80 space-y-1">
                        <div className="flex justify-between">
                          <span>Subtotal</span>
                          <span>{formatMoney(invoiceSubtotal)}</span>
                        </div>

                        {invoiceDiscountTotal > 0 && (
                          <div className="flex justify-between text-rose-700">
                            <span>Discounts</span>
                            <span>-{formatMoney(invoiceDiscountTotal)}</span>
                          </div>
                        )}

                        <div className="flex justify-between">
                          <span>Service total</span>
                          <span>{formatMoney(selectedInfo.totalPrice)}</span>
                        </div>

                        {selectedInfo.depositAmount > 0 && (
                          <div className="flex justify-between">
                            <span>Deposit</span>
                            <span>
                              {formatMoney(selectedInfo.depositAmount)}{" "}
                              {selectedInfo.depositPaid ? "(received)" : "(due)"}
                            </span>
                          </div>
                        )}

                        {selectedInfo.amountPaid > 0 && (
                          <div className="flex justify-between">
                            <span>Additional payments</span>
                            <span>{formatMoney(selectedInfo.amountPaid)}</span>
                          </div>
                        )}

                        <div className="flex justify-between pt-1 border-t border-plum/10">
                          <span>Total paid so far</span>
                          <span>{formatMoney(selectedInfo.totalPaid)}</span>
                        </div>

                        <div className="flex justify-between pt-1 border-t border-plum/10 font-semibold text-plum">
                          <span>Amount due</span>
                          <span>{formatMoney(selectedInfo.remainingBalance)}</span>
                        </div>
                      </div>
                      </div>
                    </div>

                    {/* Payment summary + notes */}
                    <div className="px-5 pb-4 border-t border-plum/10">
                      <div className="grid md:grid-cols-2 gap-6 text-xs text-plum/80">
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-plum/60">
                          Payment details
                        </p>

                        <p>
                          Payment status:{" "}
                          <span className="font-medium text-plum">
                            {selectedInfo.paymentStatus}
                          </span>
                        </p>

                        <p>Service total: {formatMoney(selectedInfo.totalPrice)}</p>

                        {selectedInfo.depositAmount > 0 && (
                          <p>
                            Deposit: {formatMoney(selectedInfo.depositAmount)}{" "}
                            {selectedInfo.depositPaid ? "(received)" : "(due)"}
                          </p>
                        )}

                        {selectedInfo.amountPaid > 0 && (
                          <p>
                            Additional payments (after deposit):{" "}
                            {formatMoney(selectedInfo.amountPaid)}
                          </p>
                        )}

                        <p>
                          Total paid so far: {formatMoney(selectedInfo.totalPaid)}
                        </p>

                        <p>
                          Remaining balance: {formatMoney(selectedInfo.remainingBalance)}
                        </p>

                        <p>Payment method: {selectedInfo.paymentMethodLabel}</p>

                        {selectedInfo.refunded && (
                          <p className="text-rose-700 font-semibold mt-1">
                            Refunded{" "}
                            {selectedInfo.refundedAmount > 0 &&
                              `(${formatMoney(selectedInfo.refundedAmount)})`}
                          </p>
                        )}
                      </div>

                        <div className="space-y-1">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-plum/60">
                            Notes for your cleaner
                          </p>
                          <div className="border border-plum/20 rounded-md min-h-[70px] px-3 py-2 bg-white text-[13px]">
                            {selectedBooking.notes ? (
                              <p className="whitespace-pre-wrap">
                                {selectedBooking.notes}
                              </p>
                            ) : (
                              <p className="text-plum/50">No notes added.</p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Footer actions */}
                    <div className="border-t border-plum/10 bg-plum/3 px-5 py-3">
                      <DialogFooter className="flex flex-col sm:flex-row gap-2 sm:justify-between">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="flex items-center gap-2"
                          onClick={() =>
                            handleDownloadInvoice("pdf", selectedBooking)
                          }
                        >
                          <FileDown className="w-4 h-4" />
                          Download PDF
                        </Button>
                        <div className="flex gap-2 sm:justify-end w-full sm:w-auto">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="flex items-center gap-2"
                            onClick={() =>
                              handleDownloadInvoice("csv", selectedBooking)
                            }
                          >
                            <FileDown className="w-4 h-4" />
                            Download Excel/CSV
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="bg-plum text-white hover:bg-plum/90"
                            onClick={closeInvoiceModal}
                          >
                            Close
                          </Button>
                        </div>
                      </DialogFooter>
                    </div>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </>
        )}
      </motion.div>
    </div>
  );
};

export default PaymentCenterPage;

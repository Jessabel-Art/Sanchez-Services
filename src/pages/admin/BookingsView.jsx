// src/pages/admin/BookingsView.jsx 
import React, { useContext, useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
} from "firebase/firestore";

import { db, auth } from "@/lib/firebase";
import { createBookingWithConflictCheck } from "@/lib/db";
import { derivePaymentInfo } from "@/lib/payments";
import { stripUndefinedDeep } from "@/lib/contactModel";
import { normalizeBookingForWrite } from "@/lib/bookings";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";

import StatusPill from "./components/StatusPill";
import EmptyState from "./components/EmptyState";
import FabNewBooking from "./components/FabNewBooking";
import { AdminUIContext } from "./context/AdminUIContext";
import { BookingModal } from "./components/BookingModal";
import { useAdminAuth } from "./hooks/useAdminAuth";

import {
  Download,
  Filter,
  UserCircle2,
  MapPin,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Pencil,
} from "lucide-react";

/* ----------------- helpers ----------------- */

/**
 * Enqueue a booking email to /mail collection for Firebase Trigger Email extension.
 * Only creates a new mail doc if clientEmail is available.
 */
async function enqueueBookingEmail({ type, booking, beforeStatus, afterStatus }) {
  const clientEmail = booking.contact?.email || booking.email || booking.contactEmail || "";
  if (!clientEmail) {
    console.warn(`[enqueueBookingEmail] No client email for booking ${booking.id}`);
    return;
  }

  const clientName = booking.contact?.name || booking.clientName || booking.client || "there";
  const serviceName = booking.serviceName || booking.service || "";
  const whenDate = formatDate(booking.startAt || booking.scheduledAt || booking.endAt);
  const whenTime = formatTime(booking.startAt || booking.scheduledAt || booking.endAt);
  const address = (booking.address?.line1 || booking.address || "");

  let subject = "";
  let text = "";

  if (type === "rescheduled") {
    subject = "Your Sanchez Services booking has been rescheduled";
    text = `Hi ${clientName},\n\nYour booking has been rescheduled!\n\nService: ${serviceName}\nNew Date: ${whenDate}\nTime: ${whenTime}\nAddress: ${address}\nBooking ID: ${booking.id}\n\nThank you for choosing Sanchez Services!`;
  } else if (type === "cancelled") {
    subject = "Your Sanchez Services booking has been cancelled";
    text = `Hi ${clientName},\n\nYour booking has been cancelled.\n\nService: ${serviceName}\nDate: ${whenDate}\nBooking ID: ${booking.id}\n\nIf you have any questions, please contact us.\n\nThank you!`;
  } else if (type === "confirmed") {
    subject = "Your Sanchez Services booking is confirmed";
    text = `Hi ${clientName},\n\nYour booking is confirmed!\n\nService: ${serviceName}\nDate: ${whenDate}\nTime: ${whenTime}\nAddress: ${address}\nBooking ID: ${booking.id}\n\nThank you for choosing Sanchez Services!`;
  }

  try {
    await addDoc(collection(db, "mail"), {
      to: [clientEmail],
      replyTo: "sanchezservices24@yahoo.com",
      message: {
        subject,
        text,
      },
      createdAt: serverTimestamp(),
      meta: {
        type,
        bookingId: booking.id,
        beforeStatus,
        afterStatus,
      },
    });
  } catch (err) {
    console.error(`[enqueueBookingEmail] Failed to write mail doc for ${type}:`, err);
  }
}

function toDate(val) {
  if (!val) return null;
  if (typeof val?.toDate === "function") return val.toDate(); // Firestore Timestamp
  if (val instanceof Date) return val;
  if (typeof val === "object" && typeof val.seconds === "number") {
    return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
  }
  const d = new Date(val); // ISO or ms
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(val) {
  const d = toDate(val);
  if (!d || Number.isNaN(d.getTime())) return "--";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatTime(val) {
  const d = toDate(val);
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCurrency(num) {
  if (num == null || Number.isNaN(Number(num))) return "$0";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(num));
}

// --- small local normalization helpers ---
function toDateLike(v) {
  if (!v) return null;
  if (typeof v?.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === "object" && typeof v.seconds === "number") {
    return new Date(v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6));
  }
  if (typeof v === "number") return new Date(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeBooking(b) {
  const raw = b.raw || b || {};
  const scheduled = toDateLike(
    b.startAt ?? b.scheduledAt ?? b.endAt ?? b.date ?? raw.startAt ?? raw.scheduledAt ?? raw.endAt ?? raw.date
  );
  return {
    ...b,
    scheduledAt: scheduled,
    startAt: b.startAt ?? raw.startAt,
    date: b.date ?? raw.date,
    amount: Number(b.amount ?? b.price ?? b.cost ?? raw.amount ?? raw.price ?? raw.cost ?? 0),
    depositAmount: Number(b.depositAmount ?? raw.depositAmount ?? 0),
    depositPaid: !!(b.depositPaid ?? raw.depositPaid),
    amountPaid: Number(b.amountPaid ?? raw.amountPaid ?? raw.paid ?? 0),
    remainingBalance: b.remainingBalance ?? raw.remainingBalance,
    refunded: !!(b.refunded ?? raw.refunded),
    refundedAmount: Number(b.refundedAmount ?? raw.refundedAmount ?? 0),
    balancePaymentMethod: b.balancePaymentMethod ?? raw.balancePaymentMethod,
    paymentMethod: b.paymentMethod ?? raw.paymentMethod,
    depositPaymentMethod: b.depositPaymentMethod ?? raw.depositPaymentMethod,
    stripePaymentIntentId: b.stripePaymentIntentId ?? raw.stripePaymentIntentId,
    stripeSessionId: b.stripeSessionId ?? raw.stripeSessionId,
  };
}

// For <input type="date" />
function toDateInputValue(val) {
  const d = toDate(val);
  if (!d || Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// For <input type="time" />
function toTimeInputValue(val) {
  const d = toDate(val);
  if (!d || Number.isNaN(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Date-range options:
 *  - pastX = look back X days from today
 *  - futureX = upcoming X days from today
 *  - all = no date filter
 */
const RANGE_OPTIONS = [
  { id: "past7", label: "Last 7 days", type: "past", days: 7 },
  { id: "past30", label: "Last 30 days", type: "past", days: 30 },
  { id: "past90", label: "Last 90 days", type: "past", days: 90 },
  { id: "future30", label: "Next 30 days", type: "future", days: 30 },
  { id: "future90", label: "Next 90 days", type: "future", days: 90 },
  { id: "all", label: "All time", type: "all" },
];

const STATUS_FILTERS = [
  { id: "all", label: "All statuses" },
  { id: "requested", label: "Requested" },
  { id: "pending", label: "Pending" },
  { id: "confirmed", label: "Confirmed" },
  { id: "completed", label: "Completed" },
  { id: "declined", label: "Declined" },
  { id: "cancelled", label: "Cancelled" },
];

const ADMIN_STATUS_OPTIONS = STATUS_FILTERS.filter((s) => s.id !== "all");

// no payment UI anymore, but still used for CSV export
const PAYMENT_METHOD_OPTIONS = [
  { id: "card_stripe", label: "Card (Stripe)" },
  { id: "cash", label: "Cash" },
  { id: "cash_app", label: "Cash App" },
  { id: "zelle", label: "Zelle" },
  { id: "other", label: "Other" },
];

/**
 * Fire-and-forget email via Formspree.
 * This will run after a booking is created/updated from the modal.
 */
async function sendBookingEmail(booking) {
  try {
    if (!FORMSPREE_ENDPOINT) return;

    const whenSource = booking.startAt || booking.scheduledAt || null;
    const whenDate = formatDate(whenSource);
    const whenTime = formatTime(whenSource);

    const name =
      booking.contact?.name ??
      booking.clientName ??
      booking.client ??
      "Unknown client";

    const email =
      booking.contact?.email ??
      booking.email ??
      booking.contactEmail ??
      "";

    const phone =
      booking.contact?.phone ??
      booking.phone ??
      booking.contactPhone ??
      "";

    const service =
      booking.serviceName ?? booking.service ?? booking.serviceType ?? "";

    const payload = {
      _subject: "New / updated booking",
      source: "Admin dashboard",
      bookingId: booking.id ?? "",
      status: booking.status ?? "",
      name,
      email,
      phone,
      service,
      date: whenDate,
      time: whenTime,
      notes: booking.notes ?? booking.note ?? "",
      addressLine1:
        booking.address?.line1 ??
        booking.addressLine1 ??
        booking.address ??
        "",
    };

    await fetch(FORMSPREE_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Formspree booking email failed", err);
  }
}

/* ----------------- component ----------------- */

export default function BookingsView() {
  const { toast } = useToast();
  const adminUi = useContext(AdminUIContext);
  const searchTerm = adminUi?.searchTerm ?? "";
  const setSearchTerm = adminUi?.setSearchTerm;
  const { isAdmin, authReady } = useAdminAuth();

  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState("all");
  // default to "all" so you see everything including future bookings
  const [rangeFilter, setRangeFilter] = useState("all");

  const [showModal, setShowModal] = useState(false);
  const [editingBooking, setEditingBooking] = useState(null);

  // pagination
  const [pageSize, setPageSize] = useState("10"); // "10" | "20" | "30" | "all"
  const [page, setPage] = useState(1);

  // inline notes editing
  const [editingNotesId, setEditingNotesId] = useState(null);
  const [notesDraft, setNotesDraft] = useState("");

  // inline reschedule
  const [rescheduleId, setRescheduleId] = useState(null);
  const [reschedDate, setReschedDate] = useState("");
  const [reschedTime, setReschedTime] = useState("");

  // ---- Firestore subscription (auth-gated) ----
  useEffect(() => {
    // Only subscribe when auth is ready and user is confirmed admin
    if (!authReady || !isAdmin) {
      setLoading(false);
      return;
    }

    const colRef = collection(db, "bookings");

    // Use startAt for ordering so older bookings that only have startAt
    // are still included. Firestore drops docs that lack the ordered field.
    const q = query(colRef, orderBy("startAt", "desc"));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((docSnap) => {
          const data = docSnap.data();

          // Normalize scheduledAt for display / filters
          const scheduledAt =
            data.startAt || data.scheduledAt || data.date || null;

          // Normalize address into a string so React doesn't choke on objects
          let addressText = "";
          if (typeof data.address === "string") {
            addressText = data.address;
          } else if (data.address && typeof data.address === "object") {
            const { line1, line2, city, state, zip } = data.address;
            const lineParts = [line1, line2].filter(Boolean);
            const cityStateZip =
              city || state || zip
                ? [city, state, zip].filter(Boolean).join(" ")
                : "";
            addressText = [lineParts.join(", "), cityStateZip]
              .filter(Boolean)
              .join(", ");
          } else if (typeof data.location === "string") {
            addressText = data.location;
          } else if (typeof data.contact?.address === "string") {
            addressText = data.contact.address;
          }

          return {
            id: docSnap.id,
            scheduledAt,
            status: data.status || "pending",
            clientName:
              data.clientName ||
              data.client ||
              data.contact?.name ||
              "Unknown client",
            serviceName: data.serviceName || data.service || "—",
            amount: data.amount ?? data.price ?? data.cost ?? 0,
            address: addressText,
            notes: data.notes || data.note || "",
            raw: data,
          };
        });

        setBookings(rows);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        toast({
          title: "Could not load bookings",
          description: err.message || "Check your Firestore permissions.",
          variant: "destructive",
        });
        setLoading(false);
      }
    );

    return () => unsub();
  }, [authReady, isAdmin, toast]);

  // ---- Filtering logic (status + range + search) ----
  const filteredBookings = useMemo(() => {
    let rows = [...bookings];

    const now = new Date();

    // Date range filter
    if (rangeFilter !== "all") {
      const opt = RANGE_OPTIONS.find((o) => o.id === rangeFilter);
      if (opt && opt.type !== "all") {
        if (opt.type === "past") {
          const earliest = new Date(now);
          earliest.setDate(now.getDate() - (opt.days || 7));

          rows = rows.filter((b) => {
            const d = toDate(b.scheduledAt);
            if (!d) return false;
            return d >= earliest && d <= now;
          });
        } else if (opt.type === "future") {
          const latest = new Date(now);
          latest.setDate(now.getDate() + (opt.days || 30));

          rows = rows.filter((b) => {
            const d = toDate(b.scheduledAt);
            if (!d) return false;
            return d >= now && d <= latest;
          });
        }
      }
    }

    // Status filter
    if (statusFilter !== "all") {
      rows = rows.filter(
        (b) =>
          String(b.status).toLowerCase() === statusFilter.toLowerCase()
      );
    }

    // Search term filter (client, service, address, notes)
    const s = searchTerm?.trim().toLowerCase();
    if (s) {
      rows = rows.filter((b) => {
        const haystack = `${b.clientName || ""} ${b.serviceName || ""} ${
          b.address || ""
        } ${b.notes || ""}`.toLowerCase();
        return haystack.includes(s);
      });
    }

    return rows;
  }, [bookings, statusFilter, rangeFilter, searchTerm]);

  const totalAmount = useMemo(
    () => filteredBookings.reduce((sum, b) => sum + Number(b.amount || 0), 0),
    [filteredBookings]
  );

  // ---- Pagination derived values ----
  const pageSizeNumber =
    pageSize === "all" ? filteredBookings.length || 1 : Number(pageSize) || 10;

  const totalPages =
    pageSize === "all" || filteredBookings.length === 0
      ? 1
      : Math.max(1, Math.ceil(filteredBookings.length / pageSizeNumber));

  // keep page in range when filters / pageSize change
  useEffect(() => {
    if (pageSize === "all") {
      setPage(1);
      return;
    }
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [pageSize, totalPages, page]);

  const paginatedBookings = useMemo(() => {
    if (pageSize === "all") return filteredBookings;
    const start = (page - 1) * pageSizeNumber;
    const end = start + pageSizeNumber;
    return filteredBookings.slice(start, end);
  }, [filteredBookings, page, pageSize, pageSizeNumber]);

  const hasData = filteredBookings.length > 0;

  const startIndex =
    filteredBookings.length === 0
      ? 0
      : pageSize === "all"
      ? 1
      : (page - 1) * pageSizeNumber + 1;

  const endIndex =
    filteredBookings.length === 0
      ? 0
      : pageSize === "all"
      ? filteredBookings.length
      : Math.min(filteredBookings.length, page * pageSizeNumber);

  // ---- CSV Export ----
  const handleExportCsv = () => {
    if (!filteredBookings.length) {
      toast({
        title: "No data to export",
        description: "Change your filters or add bookings first.",
      });
      return;
    }

    const header = [
      "Date",
      "Time",
      "Status",
      "Client",
      "Service",
      "Amount",
      "Payment Status",
      "Payment Method",
      "Address",
      "Notes",
      "ID",
    ];

    const rows = filteredBookings.map((b) => {
      const when = b.scheduledAt;
      const payment = derivePaymentInfo(normalizeBooking(b));

      return [
        formatDate(when),
        formatTime(when),
        b.status,
        b.clientName,
        b.serviceName,
        b.amount,
        payment.paymentStatus,
        payment.methodLabel,
        (b.address || "").replace(/\n/g, " "),
        (b.notes || "").replace(/\n/g, " "),
        b.id,
      ];
    });

    const csvLines = [header, ...rows]
      .map((cols) =>
        cols
          .map((val) => {
            const s = val == null ? "" : String(val);
            if (s.includes('"') || s.includes(",") || s.includes("\n")) {
              return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
          })
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csvLines], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `sanchez-bookings-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // ---- New / Edit booking ----
  const handleNewBooking = () => {
    setEditingBooking(null);
    setShowModal(true);
  };

  const handleRowClick = (booking) => {
    setEditingBooking(booking);
    setShowModal(true);
  };

  // ---- Status change handler (inline admin control) ----
  const handleStatusChange = async (bookingId, newStatus) => {
    try {
      // Find the booking to get full data before update
      const booking = bookings.find((b) => b.id === bookingId);
      if (!booking) return;

      const oldStatus = booking.status;
      const ref = doc(db, "bookings", bookingId);
      const statusUpdate = {
        status: newStatus,
        updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
      };
      const normalizedStatusUpdate = normalizeBookingForWrite(statusUpdate);
      await updateDoc(ref, normalizedStatusUpdate);

      // Enqueue confirmation/cancellation email
      if (newStatus === "confirmed" || newStatus === "cancelled") {
        await enqueueBookingEmail({
          type: newStatus === "confirmed" ? "confirmed" : "cancelled",
          booking: { ...booking.raw, id: bookingId, status: newStatus },
          beforeStatus: oldStatus,
          afterStatus: newStatus,
        });
      }

      toast({
        title: "Status updated",
        description: `Booking marked as ${newStatus}.`,
      });
    } catch (err) {
      console.error(err);
      toast({
        title: "Could not update status",
        description: err.message || String(err),
        variant: "destructive",
      });
    }
  };

  // ---- Inline notes editing ----
  const startEditNotes = (booking) => {
    setEditingNotesId(booking.id);
    setNotesDraft(booking.notes || "");
  };

  const cancelEditNotes = () => {
    setEditingNotesId(null);
    setNotesDraft("");
  };

  const handleSaveNotes = async (bookingId) => {
    try {
      const ref = doc(db, "bookings", bookingId);
      const notesUpdate = {
        notes: notesDraft.trim(),
        updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
      };
      const normalizedNotesUpdate = normalizeBookingForWrite(notesUpdate);
      await updateDoc(ref, normalizedNotesUpdate);

      toast({
        title: "Notes updated",
        description: "Client-facing notes have been saved.",
      });

      setEditingNotesId(null);
      setNotesDraft("");
    } catch (err) {
      console.error(err);
      toast({
        title: "Could not update notes",
        description: err.message || String(err),
        variant: "destructive",
      });
    }
  };

  // ---- Inline reschedule ----
  const startReschedule = (booking) => {
    setRescheduleId(booking.id);
    setReschedDate(toDateInputValue(booking.scheduledAt));
    const t = toTimeInputValue(booking.scheduledAt);
    setReschedTime(t || "09:00");
  };

  const cancelReschedule = () => {
    setRescheduleId(null);
    setReschedDate("");
    setReschedTime("");
  };

  const handleSaveReschedule = async (bookingId) => {
    try {
      if (!reschedDate || !reschedTime) {
        toast({
          title: "Missing date/time",
          description: "Select a new date and time before saving.",
          variant: "destructive",
        });
        return;
      }

      const booking = bookings.find((b) => b.id === bookingId);
      if (!booking) return;

      const [year, month, day] = reschedDate.split("-").map(Number);
      const [hour, minute] = reschedTime.split(":").map(Number);

      const newDate = new Date();
      newDate.setFullYear(year, month - 1, day);
      newDate.setHours(hour, minute || 0, 0, 0);

      const ref = doc(db, "bookings", bookingId);
      const rescheduleUpdate = {
        scheduledAt: newDate,
        startAt: newDate,
        dateKey: reschedDate,
        updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
      };
      const normalizedRescheduleUpdate = normalizeBookingForWrite(rescheduleUpdate);
      await updateDoc(ref, normalizedRescheduleUpdate);

      // Enqueue rescheduled email
      await enqueueBookingEmail({
        type: "rescheduled",
        booking: { ...booking.raw, id: bookingId, startAt: newDate, scheduledAt: newDate },
      });

      toast({
        title: "Booking rescheduled",
        description: `New time: ${newDate.toLocaleDateString()} ${newDate.toLocaleTimeString(
          [],
          { hour: "numeric", minute: "2-digit" }
        )}`,
      });

      cancelReschedule();
    } catch (err) {
      console.error(err);
      toast({
        title: "Could not reschedule booking",
        description: err.message || String(err),
        variant: "destructive",
      });
    }
  };

  // ---- Firestore write handler (create / update from modal) ----
  const handleSaveBooking = async (payload, existingId = null) => {
    if (process.env.NODE_ENV !== "production") {
      const logDateField = (val) => ({
        type: typeof val,
        ctor: val?.constructor?.name,
        hasToDate: typeof val?.toDate === "function",
        value: val,
      });
      console.log("[BookingsView] onSave received payload:", {
        startAt: logDateField(payload?.startAt),
        scheduledAt: logDateField(payload?.scheduledAt),
        endAt: logDateField(payload?.endAt),
      });
    }
    try {
      // Strip undefined values to prevent Firestore errors
      const cleanPayload = stripUndefinedDeep(payload);
      // Normalize timestamps before write to ensure proper Firestore types
      const normalizedPayload = normalizeBookingForWrite(cleanPayload);
      
      if (existingId) {
        // Update existing booking (no conflict check needed for updates)
        const ref = doc(db, "bookings", existingId);
        await updateDoc(ref, normalizedPayload);
      } else {
        // New booking: use server-side conflict checking
        // createBookingWithConflictCheck will throw if conflict detected
        const userId = auth.currentUser?.uid || normalizedPayload.userId || 'admin';
        await createBookingWithConflictCheck(userId, normalizedPayload);
      }
      // Note: BookingModal now handles email queueing via /mail collection.
    } catch (err) {
      // Re-throw with better error context
      if (err?.message?.includes('conflict') || err?.message?.includes('overlap')) {
        throw new Error(`Time conflict: ${err.message}`);
      }
      throw err;
    }
  };

  return (
    <>
      <Card className="border-[#F1D8E8] rounded-2xl">
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="text-base text-[#431039]">
              Bookings
            </CardTitle>
            <p className="text-xs text-gray-500 mt-1">
              View, filter, and export all booking requests.
            </p>
          </div>

          <div className="flex flex-col md:flex-row md:items-center gap-3 w-full md:w-auto md:justify-end">
            {/* Local search bar */}
            <div className="w-full md:w-64">
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm && setSearchTerm(e.target.value)}
                placeholder="Search bookings, clients, addresses"
                className="h-9 bg-white text-xs text-[#431039] placeholder:text-[#B989AF] border border-[#F1D8E8] rounded-full px-3"
              />
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden sm:flex items-center text-[11px] text-gray-500">
                <Filter className="w-3 h-3 mr-1" />
                Filters
              </div>

              {/* Status filter */}
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-8 w-[150px] text-xs bg-white">
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

              {/* Date range filter (past / upcoming / all) */}
              <Select value={rangeFilter} onValueChange={setRangeFilter}>
                <SelectTrigger className="h-8 w-[150px] text-xs bg-white">
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

              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1 bg-white"
                onClick={handleExportCsv}
              >
                <Download className="w-3 h-3" />
                Export CSV
              </Button>

              <Button
                size="sm"
                className="bg-[#E2A82B] text-[#431039] hover:bg-[#F0BA3E] text-xs"
                onClick={handleNewBooking}
              >
                + New booking
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="border-t border-[#F1D8E8]" />

          {loading ? (
            <div className="py-10 text-center text-xs text-gray-500">
              Loading bookings…
            </div>
          ) : !hasData ? (
            <div className="py-12">
              <EmptyState
                icon={CalendarDays}
                title="No bookings match your filters"
                description="Try changing the status or date range, or create a new booking manually."
                actionLabel="Create first booking"
                onAction={handleNewBooking}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-[#431039] text-[11px] text-white uppercase tracking-wide">
                    <th className="px-4 py-2 text-left font-semibold">
                      Date
                    </th>
                    <th className="px-4 py-2 text-left font-semibold">
                      Status
                    </th>
                    <th className="px-4 py-2 text-left font-semibold">
                      Client
                    </th>
                    <th className="px-4 py-2 text-left font-semibold">
                      Service
                    </th>
                    <th className="px-4 py-2 text-right font-semibold">
                      Amount
                    </th>
                    <th className="px-4 py-2 text-left font-semibold">
                      Address
                    </th>
                    <th className="px-4 py-2 text-left font-semibold">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedBookings.map((b, idx) => {
                    return (
                      <tr
                        key={b.id}
                        className={`border-t border-[#F7E5F0] cursor-pointer hover:bg-[#FFF1FA] ${
                          idx % 2 === 1 ? "bg-white" : "bg-[#FFFCFE]"
                        }`}
                        onClick={() => handleRowClick(b)}
                      >
                        {/* Date + inline reschedule */}
                        <td
                          className="px-4 py-2 align-top whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex flex-col gap-1">
                            <div className="flex flex-col">
                              <span className="font-medium text-[#431039]">
                                {formatDate(b.scheduledAt)}
                              </span>
                              <span className="text-[11px] text-gray-500">
                                {formatTime(b.scheduledAt)}
                              </span>
                            </div>

                            {rescheduleId === b.id ? (
                              <div className="mt-1 space-y-1">
                                <div className="flex gap-1">
                                  <input
                                    type="date"
                                    className="w-28 border border-[#F1D8E8] rounded-md px-1 py-0.5 text-[11px]"
                                    value={reschedDate}
                                    onChange={(e) =>
                                      setReschedDate(e.target.value)
                                    }
                                  />
                                  <input
                                    type="time"
                                    className="w-20 border border-[#F1D8E8] rounded-md px-1 py-0.5 text-[11px]"
                                    value={reschedTime}
                                    onChange={(e) =>
                                      setReschedTime(e.target.value)
                                    }
                                  />
                                </div>
                                <div className="flex justify-end gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-[11px]"
                                    onClick={cancelReschedule}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="h-6 text-[11px] bg-plum text-white"
                                    onClick={() =>
                                      handleSaveReschedule(b.id)
                                    }
                                  >
                                    Save
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="mt-1 self-start text-[11px] text-[#B34A87] underline-offset-2 hover:underline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startReschedule(b);
                                }}
                              >
                                Reschedule
                              </button>
                            )}
                          </div>
                        </td>

                        {/* Status cell with inline editable Select */}
                        <td
                          className="px-4 py-2 align-top whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center gap-2">
                            <StatusPill status={b.status} />
                            <Select
                              value={String(b.status || "").toLowerCase()}
                              onValueChange={(value) =>
                                handleStatusChange(b.id, value)
                              }
                            >
                              <SelectTrigger className="h-7 w-[26px] rounded-full border-none bg-transparent text-[11px] text-[#6C3A63] px-0">
                                <span className="sr-only">
                                  Change status
                                </span>
                                <span className="mx-auto">▼</span>
                              </SelectTrigger>
                              <SelectContent className="bg-white border border-[#F1D8E8] shadow-lg">
                                {ADMIN_STATUS_OPTIONS.map((opt) => (
                                  <SelectItem key={opt.id} value={opt.id}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </td>

                        <td className="px-4 py-2 align-top min-w-[140px]">
                          <div className="flex items-center gap-2">
                            <UserCircle2 className="w-4 h-4 text-[#B34A87]" />
                            <span className="text-[#431039]">
                              {b.clientName}
                            </span>
                          </div>
                        </td>

                        <td className="px-4 py-2 align-top min-w-[130px]">
                          <span className="text-[#6C3A63]">
                            {b.serviceName}
                          </span>
                        </td>

                        <td className="px-4 py-2 align-top text-right whitespace-nowrap min-w-[80px]">
                          <span className="font-semibold text-[#431039]">
                            {formatCurrency(b.amount)}
                          </span>
                        </td>

                        <td className="px-4 py-2 align-top min-w-[180px]">
                          <div className="flex gap-1 items-start">
                            <MapPin className="w-3 h-3 mt-[2px] text-[#B989AF]" />
                            <span className="text-[11px] text-gray-600">
                              {b.address || "—"}
                            </span>
                          </div>
                        </td>

                        {/* Notes + inline edit */}
                        <td
                          className="px-4 py-2 align-top max-w-xs"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {editingNotesId === b.id ? (
                            <div className="flex flex-col gap-1">
                              <textarea
                                className="w-full text-[11px] border border-[#F1D8E8] rounded-md px-2 py-1 text-gray-700 focus:outline-none focus:ring-1 focus:ring-[#B34A87]"
                                rows={2}
                                value={notesDraft}
                                onChange={(e) =>
                                  setNotesDraft(e.target.value)
                                }
                              />
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-[11px]"
                                  onClick={cancelEditNotes}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  className="h-6 text-[11px] bg-plum text-white"
                                  onClick={() => handleSaveNotes(b.id)}
                                >
                                  Save
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-[11px] text-gray-600 line-clamp-2">
                                {b.notes || "—"}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0 text-[#B34A87]"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startEditNotes(b);
                                }}
                              >
                                <Pencil className="w-3 h-3" />
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Footer summary + pagination */}
              <div className="border-t border-[#F1D8E8] px-4 py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between text-[11px] text-gray-500">
                <span>
                  {filteredBookings.length === 0 ? (
                    "No bookings to display"
                  ) : (
                    <>
                      Showing{" "}
                      <strong className="text-[#431039]">
                        {startIndex}-{endIndex}
                      </strong>{" "}
                      of{" "}
                      <strong className="text-[#431039]">
                        {filteredBookings.length}
                      </strong>{" "}
                      bookings · Total amount:{" "}
                      <strong className="text-[#431039]">
                        {formatCurrency(totalAmount)}
                      </strong>
                    </>
                  )}
                </span>

                <div className="flex items-center gap-3 justify-end">
                  <div className="flex items-center gap-1">
                    <span className="text-[11px]">Rows per page:</span>
                    <Select
                      value={pageSize}
                      onValueChange={(value) => {
                        setPageSize(value);
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-7 w-[80px] text-xs bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-white border border-[#F1D8E8] shadow-lg">
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="20">20</SelectItem>
                        <SelectItem value="30">30</SelectItem>
                        <SelectItem value="all">All</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-2">
                    <span>
                      Page{" "}
                      <strong className="text-[#431039]">
                        {filteredBookings.length === 0 ? 0 : page}
                      </strong>{" "}
                      of{" "}
                      <strong className="text-[#431039]">
                        {filteredBookings.length === 0 ? 0 : totalPages}
                      </strong>
                    </span>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 rounded-full"
                        onClick={() =>
                          setPage((prev) => Math.max(1, prev - 1))
                        }
                        disabled={
                          page <= 1 ||
                          pageSize === "all" ||
                          filteredBookings.length === 0
                        }
                      >
                        <ChevronLeft className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 rounded-full"
                        onClick={() =>
                          setPage((prev) =>
                            Math.min(totalPages, prev + 1)
                          )
                        }
                        disabled={
                          page >= totalPages ||
                          pageSize === "all" ||
                          filteredBookings.length === 0
                        }
                      >
                        <ChevronRight className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Floating +New button */}
      <FabNewBooking onClick={handleNewBooking} />

      {/* Booking create/edit modal */}
      <BookingModal
        open={showModal}
        initial={
          editingBooking
            ? {
                id: editingBooking.id,
                ...editingBooking.raw,
              }
            : null
        }
        onClose={() => {
          setShowModal(false);
          setEditingBooking(null);
        }}
        onSave={handleSaveBooking}
      />
    </>
  );
}

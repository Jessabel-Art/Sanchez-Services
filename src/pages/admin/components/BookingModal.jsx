// src/pages/admin/components/BookingModal.jsx
import React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { db } from "@/lib/firebase";
import { hasOverlap } from "@/lib/db";
import { normalizePhone, normalizeAddress } from '@/lib/contactModel';
import { normalizeBookingForWrite } from '@/lib/bookings';
import {
  Timestamp,
  addDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { money } from "../utils";

/* ---------------- helpers ---------------- */

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function buildInitialForm(initial) {
  const d =
    initial?.scheduledAt?.toDate?.() ?? initial?.startAt?.toDate?.() ?? null;
  const date = d ? d.toISOString().slice(0, 10) : "";
  const time = d ? d.toTimeString().slice(0, 5) : "";
  return {
    status: initial?.status ?? "confirmed",
    serviceName: initial?.serviceName ?? initial?.service ?? "",
    durationMinutes: initial?.durationMinutes ?? 120,
    amount: String(initial?.amount ?? initial?.cost ?? ""),
    name: initial?.contact?.name ?? initial?.name ?? "",
    email: initial?.contact?.email ?? "",
    phone: initial?.contact?.phone ?? "",
    address: initial?.address?.line1 ?? "",
    notes: initial?.notes ?? "",
    date,
    time,
  };
}

/* --------------- component ---------------- */

export function BookingModal({ open, initial, onClose, onSave }) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);

  // form state
  const [form, setForm] = React.useState(() => buildInitialForm(initial));

  // manual "send confirmation email" toggle
  const [sendEmail, setSendEmail] = React.useState(false);

  // whenever modal opens or initial changes, reset form + email toggle
  React.useEffect(() => {
    if (!open) return;
    const next = buildInitialForm(initial);
    setForm(next);
    setSendEmail(
      (next.status || "").toLowerCase() === "confirmed" && !!next.email
    );
  }, [open, initial]);

  const canSendEmail =
    (form.status || "").toLowerCase() === "confirmed" &&
    !!(form.email || "").trim();

  // ----- conflict check against existing bookings on the same day -----
  const checkConflicts = async (start, end) => {
    // query only the day range around `start`
    const dayStart = startOfDay(start);
    const dayEnd = endOfDay(start);

    const qRef = query(
      collection(db, "bookings"),
      where("startAt", ">=", Timestamp.fromDate(dayStart)),
      where("startAt", "<=", Timestamp.fromDate(dayEnd))
    );

    const snap = await getDocs(qRef);
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    for (const r of rows) {
      // ignore the record being edited
      if (initial?.id && r.id === initial.id) continue;

      const st = String(r.status || "").toLowerCase();
      // Treat cancelled, declined, and completed as non-blocking
      if (st === "cancelled" || st === "declined" || st === "completed") continue;

      const rs = r.startAt?.toDate?.() ?? r.scheduledAt?.toDate?.();
      let re = r.endAt?.toDate?.();
      if (rs && !re) {
        const mins = Number(
          r.durationMinutes ?? (r.durationHours ? r.durationHours * 60 : 120)
        );
        re = new Date(rs.getTime() + mins * 60000);
      }
      if (!rs || !re) continue;

      const overlap = hasOverlap(start, end, rs, re);

      if (process.env.NODE_ENV !== "production") {
        console.info("[conflict-check:admin]", {
          candidateStart: start?.toISOString?.() || start,
          candidateEnd: end?.toISOString?.() || end,
          existingStart: rs?.toISOString?.() || rs,
          existingEnd: re?.toISOString?.() || re,
          overlap,
          ignoreId: initial?.id || null,
          existingId: r.id,
        });
      }

      if (overlap) {
        return {
          conflict: true,
          with: {
            id: r.id,
            title: r.serviceName || r.service || "Booking",
            when: `${rs.toLocaleString()} – ${re.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}`,
          },
        };
      }
    }
    return { conflict: false };
  };

  const handleSave = async () => {
    const trimmedName = (form.name || "").trim();
    const trimmedService = (form.serviceName || "").trim();

    // simple UX validation with explicit feedback
    if (!trimmedName) {
      toast({ title: "Client name required", variant: "destructive" });
      return;
    }
    if (!trimmedService) {
      toast({ title: "Service required", variant: "destructive" });
      return;
    }
    if (!form.date || !form.time) {
      toast({ title: "Pick a date and time", variant: "destructive" });
      return;
    }

    // compose start/end timestamps using deterministic local date construction
    // This matches the client booking form logic but adapted for admin inputs
    function buildLocalDate(dateStr, timeStr) {
      // dateStr: "YYYY-MM-DD" from <input type="date">
      // timeStr: "HH:MM" from <input type="time"> (24-hour format)
      const [y, m, d] = String(dateStr).split("-").map(Number);
      const [hh, mm] = String(timeStr).split(":").map(Number);

      // Create local date (month is 0-indexed in JS)
      const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
      if (Number.isNaN(dt.getTime())) {
        throw new Error("invalid date: Could not construct date from inputs");
      }
      return dt;
    }

    const start = buildLocalDate(form.date, form.time);
    const durMin = Math.max(
      30,
      parseInt(String(form.durationMinutes || 120), 10)
    );
    const end = new Date(start.getTime() + durMin * 60000);
    const dateKey = start.toISOString().slice(0, 10);

    // basic validation before conflict guard
    if (Number.isNaN(start.getTime())) {
      toast({
        variant: "destructive",
        title: "Pick a valid date/time",
        description: "Please set both date and time before saving.",
      });
      return;
    }

    // conflict guard
    try {
      setSaving(true);
      const { conflict, with: info } = await checkConflicts(start, end);
      if (conflict) {
        setSaving(false);
        toast({
          title: "Time conflict",
          description: `Overlaps with "${info.title}" (${info.when}). Pick another time.`,
          variant: "destructive",
        });
        return;
      }
    } catch (err) {
      setSaving(false);
      toast({
        title: "Could not check for conflicts",
        description: String(err?.message || err),
        variant: "destructive",
      });
      return;
    }

    const priceValue = Number(form.amount || 0);
    
    // Build payload matching client booking form structure EXACTLY
    // This ensures admin-created bookings appear in client portal
    const payload = {
      // Status
      status: form.status || "confirmed",
      
      // Service info
      serviceName: trimmedService,
      
      // Scheduling - use same field names and Timestamp format as client
      startAt: Timestamp.fromDate(start),
      endAt: Timestamp.fromDate(end),
      scheduledAt: Timestamp.fromDate(start), // client form includes this
      durationMinutes: durMin,
      dateKey,
      
      // Cost + billing fields (matching client structure)
      cost: priceValue,
      totalPrice: priceValue,
      amount: priceValue, // legacy field
      depositAmount: 0, // admin bookings typically confirmed without deposit
      remainingBalance: priceValue,
      depositPaid: false,
      depositPaymentIntentId: null,
      
      // Timestamps (matching client)
      updatedAt: serverTimestamp(),
      
      // Notes
      notes: form.notes || "",
      
      // Contact - nested object matching client structure
      contact: {
        name: trimmedName,
        email: (form.email || "").trim(),
        emailLower: (form.email || "").trim().toLowerCase(),
        phone: normalizePhone(form.phone || ""),
        phoneRaw: form.phone || "",
      },
      
      // Address
      address: normalizeAddress({ line1: (form.address || "").trim() }),
      
      // Normalized lookup fields for client portal matching (top-level)
      contactEmailLower: (form.email || "").trim().toLowerCase() || null,
      contactPhoneNormalized: (() => {
        const n = normalizePhone(form.phone || "");
        if (n.length === 11 && n.startsWith("1")) return n.slice(1);
        return n || null;
      })(),
      
      // Admin-specific metadata
      createdVia: initial ? "owner_update" : "owner_manual",
    };

    // Development logging to compare with client payload structure
    if (process.env.NODE_ENV !== "production") {
      const logDateField = (val) => ({
        type: typeof val,
        ctor: val?.constructor?.name,
        hasToDate: typeof val?.toDate === "function",
        value: val,
      });
      console.log("[BookingModal] Admin payload (pre-onSave):", {
        formDate: form.date,
        formTime: form.time,
        startString: start.toISOString(),
        endString: end.toISOString(),
        startTimestamp: start.getTime(),
        endTimestamp: end.getTime(),
        dateKey,
        startAt: logDateField(payload.startAt),
        endAt: logDateField(payload.endAt),
        scheduledAt: logDateField(payload.scheduledAt),
      });
    }

    try {
      // Normalize timestamps before save to ensure proper Firestore types
      const normalizedPayload = normalizeBookingForWrite(payload);
      // Save via parent callback (this ensures ownerKeys/user linkage etc.)
      await onSave?.(normalizedPayload, initial?.id || null);

      let description = "Booking saved.";

      // Optional: send confirmation email via Firestore /mail collection
      if (sendEmail && canSendEmail) {
        try {
          await addDoc(collection(db, "mail"), {
            to: [payload.contact.email],
            message: {
              subject: "Your Sanchez Services booking is confirmed",
              text: `Hi ${payload.contact.name},

Your booking has been confirmed!

Service: ${payload.serviceName}
Date: ${form.date}
Time: ${form.time}
Duration: ${payload.durationMinutes} minutes
Address: ${payload.address.line1}
Amount: $${priceValue.toFixed(2)}
Status: ${payload.status}

${payload.notes ? `Notes: ${payload.notes}` : ''}

Thank you for choosing Sanchez Services!`,
            },
            createdAt: Timestamp.fromDate(new Date()),
          });

          description = "Booking saved and confirmation email sent.";
        } catch (err) {
          // don't fail the booking if email fails
          // eslint-disable-next-line no-console
          console.error("Mail collection email error", err);
          description =
            "Booking saved, but the confirmation email could not be sent.";
        }
      }

      toast({
        title: initial ? "Booking updated" : "Booking created",
        description,
      });

      onClose?.();
    } catch (e) {
      // Log full error to console for debugging
      console.error("[BookingModal] Save failed:", e);
      console.error("[BookingModal] Error stack:", e?.stack);
      
      const msg = String(e?.message || e);
      toast({
        title: "Could not save booking",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  // NOTE: pointer-events + z-index fix so the action row stays clickable
  return (
    <div className="fixed inset-0 z-[120] pointer-events-none">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 pointer-events-auto select-none"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog container */}
      <div className="absolute inset-0 flex items-center justify-center p-2 sm:p-4 pointer-events-auto">
        <div className="relative z-[10] w-full max-w-3xl rounded-xl sm:rounded-2xl border border-plum/15 bg-white shadow-2xl max-h-[95vh] overflow-y-auto">
          <button
            type="button"
            className="absolute right-2 top-2 sm:right-3 sm:top-3 text-plum/70 hover:text-plum text-2xl sm:text-3xl w-8 h-8 flex items-center justify-center"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>

          <div className="p-4 sm:p-5 md:p-6">
            <h3 className="text-lg sm:text-xl font-semibold text-plum mb-1 pr-8">
              {initial ? "Edit / Reschedule Booking" : "New Booking"}
            </h3>
            <p className="text-xs sm:text-sm text-plum/70 mb-3 sm:mb-4">
              Fill in the details below, then save.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr,280px] gap-4 sm:gap-5 lg:gap-6">
              {/* Left column: form */}
              <div className="space-y-3 sm:space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
                  <div>
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Client name
                    </label>
                    <Input
                      autoFocus
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                      className="bg-white mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Phone
                    </label>
                    <Input
                      value={form.phone}
                      onChange={(e) =>
                        setForm({ ...form, phone: e.target.value })
                      }
                      className="bg-white mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Email
                    </label>
                    <Input
                      type="email"
                      value={form.email}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                      className="bg-white mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-plum font-medium">
                      Status
                    </label>
                    <select
                      value={form.status}
                      onChange={(e) =>
                        setForm({ ...form, status: e.target.value })
                      }
                      className="mt-1 w-full border border-plum/20 rounded-xl px-3 py-2 bg-white"
                    >
                      <option value="confirmed">Confirmed</option>
                      <option value="pending">Pending</option>
                      <option value="declined">Declined</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
                  {/* Service (dropdown) */}
                  <div className="sm:col-span-2">
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Service
                    </label>
                    <select
                      name="service"
                      value={form.serviceName}
                      onChange={(e) =>
                        setForm({ ...form, serviceName: e.target.value })
                      }
                      className="mt-1 w-full border border-plum/20 rounded-xl px-3 py-2 bg-white text-sm"
                    >
                      {/* Preserve nonstandard existing values so edits don't wipe them */}
                      {form.serviceName &&
                        ![
                          "Residential Cleaning",
                          "Deep Clean",
                          "Move-In/Move-Out",
                          "Office Cleaning",
                        ].includes(form.serviceName) && (
                          <option value={form.serviceName}>
                            {form.serviceName}
                          </option>
                        )}

                      <option value="">Select a service…</option>
                      <option value="Residential Cleaning">
                        Residential Cleaning
                      </option>
                      <option value="Deep Clean">Deep Clean</option>
                      <option value="Move-In/Move-Out">Move-In/Move-Out</option>
                      <option value="Office Cleaning">Office Cleaning</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Amount
                    </label>
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      value={form.amount}
                      onChange={(e) =>
                        setForm({ ...form, amount: e.target.value })
                      }
                      className="bg-white mt-1 text-sm"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
                  <div className="sm:col-span-2">
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Address
                    </label>
                    <Input
                      value={form.address}
                      onChange={(e) =>
                        setForm({ ...form, address: e.target.value })
                      }
                      className="bg-white mt-1 text-sm"
                      placeholder="123 Main St"
                    />
                  </div>
                  <div>
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Duration (minutes)
                    </label>
                    <Input
                      type="number"
                      min={30}
                      step={15}
                      value={form.durationMinutes}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          durationMinutes: e.target.value,
                        })
                      }
                      className="bg-white mt-1 text-sm"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
                  <div>
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Date
                    </label>
                    <Input
                      type="date"
                      value={form.date}
                      onChange={(e) =>
                        setForm({ ...form, date: e.target.value })
                      }
                      className="bg-white mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Time
                    </label>
                    <Input
                      type="time"
                      value={form.time}
                      onChange={(e) =>
                        setForm({ ...form, time: e.target.value })
                      }
                      className="bg-white mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs sm:text-sm text-plum font-medium">
                      Preview
                    </label>
                    <div className="mt-1 h-10 flex items-center text-xs sm:text-sm text-plum/80">
                      {form.amount ? money(form.amount) : "$0"} •{" "}
                      {form.durationMinutes} min
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs sm:text-sm text-plum font-medium">
                    Notes
                  </label>
                  <Textarea
                    rows={3}
                    value={form.notes}
                    onChange={(e) =>
                      setForm({ ...form, notes: e.target.value })
                    }
                    className="bg-white mt-1 text-sm"
                  />
                </div>

                {/* ACTIONS + email toggle */}
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <Button
                      type="button"
                      onClick={handleSave}
                      disabled={saving}
                      className="rounded-full bg-plum text-white w-full sm:w-auto"
                    >
                      {saving
                        ? "Saving…"
                        : initial
                        ? "Save changes"
                        : "Create booking"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onClose}
                      className="rounded-full w-full sm:w-auto"
                    >
                      Cancel
                    </Button>
                  </div>

                  <label className="flex items-start sm:items-center gap-2 text-xs text-plum/80">
                    <input
                      type="checkbox"
                      checked={sendEmail && canSendEmail}
                      onChange={(e) => setSendEmail(e.target.checked)}
                      disabled={!canSendEmail}
                    />
                    <span>Send confirmation email to client</span>
                    {!canSendEmail && (
                      <span className="text-[11px] text-plum/50">
                        (requires client email and status set to Confirmed)
                      </span>
                    )}
                  </label>
                </div>
              </div>

              {/* Right column: summary */}
              <div className="rounded-xl sm:rounded-2xl border border-plum/15 bg-white p-3 sm:p-4">
                <div className="text-xs sm:text-sm text-plum/60 mb-2">Summary</div>
                <ul className="text-xs sm:text-sm space-y-1 text-plum/80">
                  <li>
                    <b>Status:</b> {form.status}
                  </li>
                  <li>
                    <b>Service:</b> {form.serviceName || "—"}
                  </li>
                  <li>
                    <b>Amount:</b> {form.amount ? money(form.amount) : "—"}
                  </li>
                  <li>
                    <b>Duration:</b> {form.durationMinutes} min
                  </li>
                  <li>
                    <b>Date/Time:</b> {form.date || "—"} {form.time || ""}
                  </li>
                  <li>
                    <b>Name:</b> {form.name || "—"}
                  </li>
                  <li>
                    <b>Email:</b> {form.email || "—"}
                  </li>
                  <li>
                    <b>Phone:</b> {form.phone || "—"}
                  </li>
                  <li>
                    <b>Address:</b> {form.address || "—"}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

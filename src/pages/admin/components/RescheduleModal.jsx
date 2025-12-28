// src/pages/admin/components/RescheduleModal.jsx
import React, { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { db } from "@/lib/firebase";
import {
  Timestamp,
  updateDoc,
  doc,
  addDoc,
  collection,
  serverTimestamp,
} from "firebase/firestore";
import { normalizeBookingForWrite } from "@/lib/bookings";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// Admin email for notifications (update with your actual email or env var)
const ADMIN_NOTIFY_EMAIL = import.meta.env.VITE_ADMIN_EMAIL || "sanchezservices24@yahoo.com";

/* ---------- date/time helpers ---------- */
function toDate(tsLike) {
  if (!tsLike) return null;
  if (typeof tsLike.toDate === "function") return tsLike.toDate();
  return new Date(tsLike);
}

function toDateInputValue(d) {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toTimeInputValue(d) {
  if (!d) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
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

function formatDateKey(d) {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* ---------- component ---------- */
export function RescheduleModal({ open, booking, onClose }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  // Form state
  const [newDate, setNewDate] = useState("");
  const [newTime, setNewTime] = useState("");

  // Reset form when modal opens or booking changes
  useEffect(() => {
    if (!open || !booking) {
      setNewDate("");
      setNewTime("");
      return;
    }

    // Pre-populate new date/time with current booking time as starting point
    const current = toDate(booking.startAt || booking.scheduledAt);
    if (current) {
      setNewDate(toDateInputValue(current));
      setNewTime(toTimeInputValue(current));
    }
  }, [open, booking]);

  if (!booking) return null;

  // Read-only display values
  const clientName = booking.contact?.name || booking.clientName || booking.name || "Client";
  const clientEmail = booking.contact?.email || booking.email || "";
  const clientPhone = booking.contact?.phone || booking.phone || "";
  const serviceName = booking.serviceName || booking.service || "Service";
  const address = booking.address?.line1 || booking.address || "";
  const durationMinutes = booking.durationMinutes || 120;

  // Current booking time
  const currentStart = toDate(booking.startAt || booking.scheduledAt);
  const currentEnd = new Date(currentStart.getTime() + durationMinutes * 60 * 1000);

  // New booking time (computed from form inputs)
  let newStart = null;
  let newEnd = null;
  if (newDate && newTime) {
    const [hours, mins] = newTime.split(":").map(Number);
    newStart = new Date(newDate);
    newStart.setHours(hours || 0, mins || 0, 0, 0);
    newEnd = new Date(newStart.getTime() + durationMinutes * 60 * 1000);
  }

  const handleSaveReschedule = async () => {
    if (!newStart || !newEnd) {
      toast({
        title: "Invalid date/time",
        description: "Please select a valid date and time.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      // Update the booking doc
      const bookingRef = doc(db, "bookings", booking.id);
      const rescheduleUpdate = {
        startAt: Timestamp.fromDate(newStart),
        scheduledAt: Timestamp.fromDate(newStart), // keep compatibility
        endAt: Timestamp.fromDate(newEnd),
        dateKey: formatDateKey(newStart),
        updatedAt: serverTimestamp(),
        updatedBy: "admin",
        rescheduledAt: serverTimestamp(),
        rescheduleMeta: {
          previousStartAt: booking.startAt,
          previousEndAt: booking.endAt,
        },
      };
      const normalizedRescheduleUpdate = normalizeBookingForWrite(rescheduleUpdate);
      await updateDoc(bookingRef, normalizedRescheduleUpdate);

      // Queue email to client
      if (clientEmail) {
        try {
          await addDoc(collection(db, "mail"), {
            to: [clientEmail],
            replyTo: ADMIN_NOTIFY_EMAIL,
            message: {
              subject: "Your Sanchez Services booking has been rescheduled",
              text: `Hi ${clientName},\n\nYour booking has been rescheduled!\n\nService: ${serviceName}\nNew Date: ${formatDate(newStart)}\nNew Time: ${formatTime(newStart)} – ${formatTime(newEnd)}\nAddress: ${address}\nBooking ID: ${booking.id}\n\nThank you for choosing Sanchez Services!`,
            },
            createdAt: serverTimestamp(),
            meta: {
              type: "rescheduled",
              bookingId: booking.id,
              oldStartAt: booking.startAt,
              newStartAt: newStart,
            },
          });
        } catch (emailErr) {
          console.error("[RescheduleModal] Failed to queue client email:", emailErr);
          // Don't fail the reschedule if email fails
        }
      }

      // Queue email to admin (if email is different from client)
      if (ADMIN_NOTIFY_EMAIL && ADMIN_NOTIFY_EMAIL !== clientEmail) {
        try {
          await addDoc(collection(db, "mail"), {
            to: [ADMIN_NOTIFY_EMAIL],
            message: {
              subject: `Booking rescheduled: ${clientName}`,
              text: `Admin notification:\n\nBooking rescheduled\n\nClient: ${clientName}\nService: ${serviceName}\nOld Date: ${formatDate(currentStart)} ${formatTime(currentStart)}\nNew Date: ${formatDate(newStart)} ${formatTime(newStart)}\nAddress: ${address}\nBooking ID: ${booking.id}`,
            },
            createdAt: serverTimestamp(),
            meta: {
              type: "rescheduled",
              bookingId: booking.id,
              adminNotification: true,
            },
          });
        } catch (emailErr) {
          console.error("[RescheduleModal] Failed to queue admin email:", emailErr);
        }
      }

      toast({
        title: "Booking rescheduled",
        description: `Successfully rescheduled to ${formatDate(newStart)} at ${formatTime(newStart)}.`,
      });

      onClose();
    } catch (err) {
      console.error("[RescheduleModal] Update failed:", err);
      toast({
        title: "Could not reschedule",
        description: err.message || "Check Firestore permissions.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-md rounded-lg bg-white">
        <DialogHeader>
          <DialogTitle>Reschedule Booking</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Read-only client info */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-gray-500 font-semibold uppercase">Client</p>
              <p className="text-plum font-medium">{clientName}</p>
            </div>
            {clientEmail && (
              <div>
                <p className="text-xs text-gray-500 font-semibold uppercase">Email</p>
                <p className="text-sm text-plum">{clientEmail}</p>
              </div>
            )}
            {clientPhone && (
              <div>
                <p className="text-xs text-gray-500 font-semibold uppercase">Phone</p>
                <p className="text-sm text-plum">{clientPhone}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-500 font-semibold uppercase">Service</p>
              <p className="text-sm text-plum">{serviceName}</p>
            </div>
          </div>

          {/* Address */}
          {address && (
            <div className="border-t pt-3">
              <p className="text-xs text-gray-500 font-semibold uppercase">Address</p>
              <p className="text-sm text-plum">{address}</p>
            </div>
          )}

          {/* Current date/time (read-only) */}
          <div className="border-t pt-3">
            <p className="text-xs text-gray-500 font-semibold uppercase mb-2">Current Date/Time</p>
            <div className="text-sm bg-gray-50 p-2 rounded border">
              <p className="text-plum">
                {formatDate(currentStart)} at {formatTime(currentStart)} – {formatTime(currentEnd)}
              </p>
              <p className="text-xs text-gray-500">{durationMinutes} min duration</p>
            </div>
          </div>

          {/* New date/time inputs */}
          <div className="border-t pt-3">
            <p className="text-xs text-gray-500 font-semibold uppercase mb-2">New Date/Time</p>
            <div className="flex gap-2">
              <div className="flex-1">
                <Input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  className="text-sm"
                  disabled={saving}
                />
              </div>
              <div className="flex-shrink-0 w-20">
                <Input
                  type="time"
                  value={newTime}
                  onChange={(e) => setNewTime(e.target.value)}
                  className="text-sm"
                  disabled={saving}
                />
              </div>
            </div>
          </div>

          {/* Preview of new time */}
          {newStart && (
            <div className="bg-blue-50 border border-blue-200 rounded p-2 text-sm">
              <p className="text-blue-900 font-medium">
                {formatDate(newStart)} at {formatTime(newStart)} – {formatTime(newEnd)}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={saving}
            className="mr-2"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveReschedule}
            disabled={saving || !newStart}
            className="bg-plum text-white hover:bg-plum/90"
          >
            {saving ? "Saving..." : "Save Reschedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

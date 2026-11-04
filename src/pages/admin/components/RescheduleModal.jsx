// src/pages/admin/components/RescheduleModal.jsx — admin reschedule; the server re-runs the conflict check.
import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { apiGet, apiPost } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { dateKey, timeKey, fmtDateTime } from "@/lib/model";

/** Props: open, booking (normalized), initialDate/initialTime (optional, e.g. from drag-drop), onClose, onSaved(booking). */
export function RescheduleModal({ open, booking, initialDate, initialTime, onClose, onSaved }) {
  const { toast } = useToast();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open && booking) {
      setDate(initialDate || dateKey(booking.startAt));
      setTime(initialTime || timeKey(booking.startAt));
      setDuration(String(booking.durationMinutes || 120));
      setNotify(true);
      setError("");
    }
  }, [open, booking, initialDate, initialTime]);

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const availQ = useApiQuery(
    () => apiGet(`/availability?date=${date}&durationMinutes=${Number(duration) || 120}&booking=${encodeURIComponent(booking.id)}`),
    [date, duration, booking?.id],
    { enabled: !!(open && booking && valid), poll: false }
  );

  if (!booking) return null;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await apiPost(`/admin/bookings/${encodeURIComponent(booking.id)}/reschedule`, {
        date,
        time,
        durationMinutes: Number(duration) || undefined,
        notifyClient: notify,
      });
      toast({ title: "Booking rescheduled", description: fmtDateTime(res.booking.startAt) });
      onSaved?.(res.booking);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md bg-white text-plum">
        <DialogHeader>
          <DialogTitle>Reschedule booking</DialogTitle>
          <DialogDescription>
            {booking.clientName} · {booking.serviceName} · currently {fmtDateTime(booking.startAt)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs font-medium col-span-3 sm:col-span-1">
              Date
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" />
            </label>
            <label className="text-xs font-medium">
              Start
              <Input type="time" step="900" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1" />
            </label>
            <label className="text-xs font-medium">
              Minutes
              <Input type="number" min="30" step="15" value={duration} onChange={(e) => setDuration(e.target.value)} className="mt-1" />
            </label>
          </div>
          {valid && (
            <div className="text-xs">
              {availQ.loading && !availQ.data ? (
                <span className="text-plum/60">Checking availability…</span>
              ) : availQ.data?.reason ? (
                <span className="text-rose-700">Day unavailable: {availQ.data.reason}</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {(availQ.data?.slots || []).map((s) => (
                    <button
                      key={s.time}
                      type="button"
                      disabled={!s.available}
                      onClick={() => setTime(s.time)}
                      className={`px-2 py-0.5 rounded-full border ${
                        time === s.time ? "bg-plum text-white border-plum" : s.available ? "border-emerald-300 text-emerald-800" : "border-slate-200 text-slate-400 line-through"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the client about the change
          </label>
          {error && (
            <p className="text-sm text-rose-700" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !valid || !time} className="bg-[#E2A82B] text-[#431039] hover:bg-[#F0BA3E]">
            {busy ? "Saving…" : "Reschedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RescheduleModal;

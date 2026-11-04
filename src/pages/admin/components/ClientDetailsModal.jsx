// src/pages/admin/components/ClientDetailsModal.jsx — admin view of one client (server data).
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { User, Mail, Phone, MapPin, Calendar, Sparkles, ArrowRight } from "lucide-react";
import { formatPhoneForDisplay } from "@/lib/contactModel";
import { apiGet, apiPatch } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { normalizeBooking, fmtDate, fmtTime, formatMoney, statusLabel, formatAddress, isUpcoming, toMillis } from "@/lib/model";

function getInitials(name, email) {
  const parts = String(name || email || "?").trim().split(/\s+/);
  return (parts.length === 1 ? parts[0].charAt(0) : parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export default function ClientDetailsModal({ client, onClose }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "" });
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const q = useApiQuery(
    async () => {
      const r = await apiGet(`/admin/clients/${client.id}`);
      return { ...r, bookings: r.bookings.map(normalizeBooking) };
    },
    [client?.id],
    { enabled: !!client?.id, poll: false }
  );

  useEffect(() => {
    if (q.data) {
      setForm({ name: q.data.client.name || "", phone: q.data.client.phone || "" });
      setNotes(q.data.client.internalNotes || "");
    }
  }, [q.data]);

  if (!client) return null;
  const c = q.data?.client || client;
  const bookings = q.data?.bookings || [];
  const addresses = q.data?.addresses || [];
  const paid = bookings.reduce((s, b) => s + b.amountPaid, 0);
  const next = bookings.filter(isUpcoming).sort((a, b) => toMillis(a.startAt) - toMillis(b.startAt))[0];
  const completed = bookings.filter((b) => b.status === "completed").length;

  const save = async (body, done) => {
    setSaving(true);
    try {
      await apiPatch(`/admin/clients/${client.id}`, body);
      await q.refresh();
      toast({ title: "Client updated" });
      done?.();
    } catch (e) {
      toast({ title: "Could not save", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!client} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <div className="bg-gradient-to-r from-plum/10 to-gold/10 px-6 pt-6 pb-4">
          <DialogHeader>
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 rounded-full bg-plum text-white flex items-center justify-center font-semibold" aria-hidden="true">
                {getInitials(c.name, c.email)}
              </div>
              <div>
                <DialogTitle className="text-lg font-semibold text-plum flex items-center gap-2">
                  <User size={18} aria-hidden="true" /> {c.name || "Unnamed client"}
                </DialogTitle>
                <p className="text-xs text-plum/70 mt-1">
                  Member since {fmtDate(c.memberSince || c.createdAt)} · {c.emailVerified ? "Email verified" : "Email not verified"}
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="px-6 pb-6 pt-4 space-y-6 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2 text-sm">
              {!edit ? (
                <>
                  <p className="flex items-center gap-2"><Mail size={16} className="text-plum/60 shrink-0" aria-hidden="true" />{c.email}</p>
                  <p className="flex items-center gap-2"><Phone size={16} className="text-plum/60 shrink-0" aria-hidden="true" />{formatPhoneForDisplay(c.phone) || "—"}</p>
                  {addresses.length === 0 ? (
                    <p className="flex items-center gap-2"><MapPin size={16} className="text-plum/60 shrink-0" aria-hidden="true" />No saved address</p>
                  ) : (
                    addresses.map((a) => (
                      <p key={a.id} className="flex items-center gap-2">
                        <MapPin size={16} className="text-plum/60 shrink-0" aria-hidden="true" />
                        {a.label ? `${a.label}: ` : ""}
                        {formatAddress(a)}
                        {a.isDefault ? " (default)" : ""}
                      </p>
                    ))
                  )}
                  <p className="text-xs text-plum/70">
                    Preferred contact: <span className="capitalize">{c.preferredContactMethod || "Not specified"}</span>
                  </p>
                </>
              ) : (
                <div className="space-y-3">
                  <Input aria-label="Full name" placeholder="Full name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                  <Input aria-label="Phone" placeholder="Phone" value={form.phone || ""} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
                </div>
              )}
            </div>
            <div className="space-y-3 text-sm">
              <div className="bg-plum/5 border border-plum/10 rounded-lg px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-plum/60">Lifetime paid</p>
                <p className="text-xl font-semibold text-plum">{formatMoney(paid)}</p>
                <p className="text-xs text-plum/60">{completed} completed visit{completed === 1 ? "" : "s"}</p>
              </div>
              <div className="bg-gold/10 border border-gold/20 rounded-lg px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-plum/60 flex items-center gap-1"><Calendar size={12} aria-hidden="true" /> Next booking</p>
                <p className="text-sm text-plum">{next ? `${next.serviceName} · ${fmtDate(next.startAt)} ${fmtTime(next.startAt)}` : "None scheduled"}</p>
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="client-notes" className="text-sm font-medium text-plum flex items-center gap-1">
              <Sparkles size={14} aria-hidden="true" /> Internal notes (admins only)
            </label>
            <Textarea id="client-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="mt-1" />
            <Button size="sm" variant="outline" className="mt-2" disabled={saving} onClick={() => save({ internalNotes: notes })}>Save notes</Button>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-plum mb-2">Bookings ({bookings.length})</h3>
            {q.loading && !q.data ? (
              <p className="text-sm text-plum/60">Loading…</p>
            ) : bookings.length === 0 ? (
              <p className="text-sm text-plum/60">No bookings yet.</p>
            ) : (
              <ul className="divide-y divide-plum/10 text-sm">
                {bookings.slice(0, 10).map((b) => (
                  <li key={b.id} className="py-2 flex justify-between gap-2">
                    <span>{fmtDate(b.startAt)} · {b.serviceName} · {statusLabel(b.status)}</span>
                    <span className="text-plum/80">{formatMoney(b.amountPaid)} / {formatMoney(b.totalPrice)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter className="px-6 pb-6 flex flex-wrap gap-2">
          {!edit ? (
            <Button variant="outline" onClick={() => setEdit(true)}>Edit contact</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setEdit(false)}>Cancel</Button>
              <Button className="bg-plum text-white" disabled={saving} onClick={() => save({ name: form.name, phone: form.phone || null }, () => setEdit(false))}>Save</Button>
            </>
          )}
          <Button
            className="bg-gold text-white"
            onClick={() => navigate(`/admin/client-bookings?clientId=${client.id}&email=${encodeURIComponent(c.email || "")}&name=${encodeURIComponent(c.name || "")}`)}
          >
            All bookings <ArrowRight size={14} className="ml-1" aria-hidden="true" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

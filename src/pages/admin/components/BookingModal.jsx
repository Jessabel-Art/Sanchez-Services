// src/pages/admin/components/BookingModal.jsx — admin create / edit booking.
// Pricing, availability and conflict checks all run on the server; the form only collects input.
import React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { apiGet, apiPost, apiPatch } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { dateKey, formatMoney, toDate, timeKey } from "@/lib/model";

function buildInitialForm(initial, defaults) {
  const d = toDate(initial?.startAt);
  return {
    status: initial?.status ?? "confirmed",
    serviceSlug: initial?.serviceSlug ?? "standard-cleaning",
    bedrooms: String(initial?.bedrooms ?? 2),
    bathrooms: String(initial?.bathrooms ?? 1),
    sqft: String(initial?.sqft ?? ""),
    condition: initial?.condition ?? "standard",
    pets: !!initial?.pets,
    addons: initial?.addons ?? [],
    frequency: initial?.frequency ?? "one-time",
    durationMinutes: initial?.durationMinutes ? String(initial.durationMinutes) : "",
    totalPrice: initial ? String(initial.totalPrice ?? "") : "",
    depositAmount: initial ? String(initial.depositAmount ?? "") : "",
    name: initial?.contact?.name ?? defaults?.name ?? "",
    email: initial?.contact?.email ?? defaults?.email ?? "",
    phone: initial?.contact?.phone ?? defaults?.phone ?? "",
    line1: initial?.address?.line1 ?? defaults?.address?.line1 ?? "",
    line2: initial?.address?.line2 ?? defaults?.address?.line2 ?? "",
    city: initial?.address?.city ?? defaults?.address?.city ?? "",
    state: initial?.address?.state ?? defaults?.address?.state ?? "RI",
    zip: initial?.address?.zip ?? defaults?.address?.zip ?? "",
    accessNotes: initial?.accessNotes ?? "",
    cleanerNotes: initial?.cleanerNotes ?? "",
    adminNotes: initial?.adminNotes ?? "",
    date: d ? dateKey(d) : defaults?.date ?? "",
    time: d ? timeKey(d) : defaults?.time ?? "09:00",
    notifyClient: true,
  };
}

const num = (v) => (v === "" || v == null ? undefined : Number(v));

function pricingBody(f) {
  return {
    serviceSlug: f.serviceSlug,
    bedrooms: num(f.bedrooms) ?? 0,
    bathrooms: num(f.bathrooms) ?? 0,
    sqft: num(f.sqft) ?? 0,
    condition: f.condition,
    pets: f.pets,
    addons: f.addons,
    frequency: f.frequency,
  };
}

const Field = ({ id, label, children }) => (
  <div>
    <label htmlFor={id} className="text-xs sm:text-sm text-plum font-medium">
      {label}
    </label>
    {children}
  </div>
);
const selectCls = "mt-1 w-full border border-plum/20 rounded-xl px-3 py-2 bg-white text-sm";

/** Props: open, initial (normalized booking to edit, or null for new), defaults (prefill for new), onClose, onSave(booking). */
export function BookingModal({ open, initial, defaults, onClose, onSave }) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState(() => buildInitialForm(initial, defaults));
  const [error, setError] = React.useState("");
  const isEdit = !!initial;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  React.useEffect(() => {
    if (open) {
      setForm(buildInitialForm(initial, defaults));
      setError("");
    }
  }, [open, initial, defaults]);

  const catalogQ = useApiQuery(() => apiGet("/catalog"), [], { enabled: open, poll: false });
  const catalog = catalogQ.data;
  const quoteKey = JSON.stringify(pricingBody(form));
  const quoteQ = useApiQuery(() => apiPost("/quote", JSON.parse(quoteKey)), [quoteKey], { enabled: open, poll: false });
  const quote = quoteQ.data;
  const duration = num(form.durationMinutes) || quote?.durationMinutes || 120;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(form.date);
  const availQ = useApiQuery(
    () => apiGet(`/availability?date=${form.date}&durationMinutes=${duration}${isEdit ? `&booking=${encodeURIComponent(initial.id)}` : ""}`),
    [form.date, duration, isEdit && initial.id],
    { enabled: open && validDate, poll: false }
  );

  if (!open) return null;

  const service = catalog?.services?.find((s) => s.slug === form.serviceSlug);
  const toggleAddon = (id) => set({ addons: form.addons.includes(id) ? form.addons.filter((a) => a !== id) : [...form.addons, id] });

  const submit = async () => {
    setError("");
    setSaving(true);
    try {
      const contact = { name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() };
      const address = { line1: form.line1.trim(), line2: form.line2.trim() || null, city: form.city.trim(), state: form.state.trim(), zip: form.zip.trim() };
      const notes = { accessNotes: form.accessNotes || null, cleanerNotes: form.cleanerNotes || null, adminNotes: form.adminNotes || null };
      let res;
      if (!isEdit) {
        res = await apiPost("/admin/bookings", {
          ...pricingBody(form),
          contact,
          address,
          ...notes,
          date: form.date,
          time: form.time,
          status: form.status,
          durationMinutes: num(form.durationMinutes),
          totalPrice: num(form.totalPrice),
          depositAmount: num(form.depositAmount),
          userId: defaults?.userId,
          notifyClient: form.notifyClient,
        });
      } else {
        // Details first; a date/time change then goes through the reschedule endpoint (same conflict check as clients).
        const body = { contact, address, ...notes };
        const pricingChanged = JSON.stringify(pricingBody(buildInitialForm(initial))) !== quoteKey;
        if (pricingChanged) Object.assign(body, pricingBody(form));
        if (pricingChanged || num(form.totalPrice) !== initial.totalPrice) {
          if (num(form.totalPrice) !== undefined) body.totalPrice = num(form.totalPrice);
        }
        if (num(form.depositAmount) !== undefined && num(form.depositAmount) !== initial.depositAmount) body.depositAmount = num(form.depositAmount);
        if (num(form.durationMinutes) && num(form.durationMinutes) !== initial.durationMinutes) body.durationMinutes = num(form.durationMinutes);
        res = await apiPatch(`/admin/bookings/${encodeURIComponent(initial.id)}`, body);
        const d = toDate(initial.startAt);
        if (form.date !== dateKey(d) || form.time !== timeKey(d)) {
          res = await apiPost(`/admin/bookings/${encodeURIComponent(initial.id)}/reschedule`, {
            date: form.date,
            time: form.time,
            notifyClient: form.notifyClient,
          });
        }
      }
      toast({ title: isEdit ? "Booking updated" : "Booking created" });
      onSave?.(res.booking);
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const slots = availQ.data?.slots || [];

  return (
    <div className="fixed inset-0 z-[120] pointer-events-none">
      <div className="absolute inset-0 bg-black/50 pointer-events-auto select-none" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-0 flex items-center justify-center p-2 sm:p-4 pointer-events-auto">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="booking-modal-title"
          className="relative z-[10] w-full max-w-3xl rounded-xl sm:rounded-2xl border border-plum/15 bg-white shadow-2xl max-h-[95vh] overflow-y-auto"
        >
          <button
            type="button"
            className="absolute right-2 top-2 sm:right-3 sm:top-3 text-plum/70 hover:text-plum text-2xl sm:text-3xl w-8 h-8 flex items-center justify-center"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
          <div className="p-4 sm:p-5 md:p-6">
            <h3 id="booking-modal-title" className="text-lg sm:text-xl font-semibold text-plum mb-1 pr-8">
              {isEdit ? `Edit booking #${initial.invoiceNumber}` : "New Booking"}
            </h3>
            <p className="text-xs sm:text-sm text-plum/70 mb-3 sm:mb-4">Prices and availability are checked by the server when you save.</p>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr,260px] gap-4 sm:gap-5 lg:gap-6">
              <div className="space-y-3 sm:space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
                  <Field id="bm-name" label="Client name">
                    <Input id="bm-name" autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <Field id="bm-phone" label="Phone">
                    <Input id="bm-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <Field id="bm-email" label="Email">
                    <Input id="bm-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  {!isEdit && (
                    <Field id="bm-status" label="Status">
                      <select id="bm-status" value={form.status} onChange={(e) => set({ status: e.target.value })} className={selectCls}>
                        <option value="confirmed">Confirmed</option>
                        <option value="pending">Pending</option>
                      </select>
                    </Field>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
                  <Field id="bm-line1" label="Street address">
                    <Input id="bm-line1" value={form.line1} onChange={(e) => set({ line1: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <Field id="bm-line2" label="Apt / unit">
                    <Input id="bm-line2" value={form.line2} onChange={(e) => set({ line2: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <Field id="bm-city" label="City">
                    <Input id="bm-city" value={form.city} onChange={(e) => set({ city: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field id="bm-state" label="State">
                      <Input id="bm-state" maxLength={2} value={form.state} onChange={(e) => set({ state: e.target.value.toUpperCase() })} className="bg-white mt-1 text-sm" />
                    </Field>
                    <Field id="bm-zip" label="ZIP">
                      <Input id="bm-zip" inputMode="numeric" value={form.zip} onChange={(e) => set({ zip: e.target.value })} className="bg-white mt-1 text-sm" />
                    </Field>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
                  <div className="sm:col-span-2">
                    <Field id="bm-service" label="Service">
                      <select id="bm-service" value={form.serviceSlug} onChange={(e) => set({ serviceSlug: e.target.value })} className={selectCls}>
                        {(catalog?.services || []).map((s) => (
                          <option key={s.slug} value={s.slug}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field id="bm-frequency" label="Frequency">
                    <select id="bm-frequency" value={form.frequency} onChange={(e) => set({ frequency: e.target.value })} className={selectCls}>
                      {(catalog?.frequencies || []).map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {service?.pricedBySqft ? (
                    <Field id="bm-sqft" label="Square feet">
                      <Input id="bm-sqft" inputMode="numeric" value={form.sqft} onChange={(e) => set({ sqft: e.target.value })} className="bg-white mt-1 text-sm" />
                    </Field>
                  ) : (
                    <>
                      <Field id="bm-bed" label="Bedrooms">
                        <Input id="bm-bed" type="number" min="0" value={form.bedrooms} onChange={(e) => set({ bedrooms: e.target.value })} className="bg-white mt-1 text-sm" />
                      </Field>
                      <Field id="bm-bath" label="Bathrooms">
                        <Input id="bm-bath" type="number" min="0" step="0.5" value={form.bathrooms} onChange={(e) => set({ bathrooms: e.target.value })} className="bg-white mt-1 text-sm" />
                      </Field>
                    </>
                  )}
                  <Field id="bm-condition" label="Condition">
                    <select id="bm-condition" value={form.condition} onChange={(e) => set({ condition: e.target.value })} className={selectCls}>
                      <option value="light">Light</option>
                      <option value="standard">Standard</option>
                      <option value="heavy">Heavy</option>
                    </select>
                  </Field>
                </div>

                <fieldset>
                  <legend className="text-xs sm:text-sm text-plum font-medium">Add-ons</legend>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {(catalog?.addons || []).map((a) => (
                      <label key={a.id} className="text-xs flex items-center gap-1 border border-plum/15 rounded-full px-2 py-1 cursor-pointer">
                        <input type="checkbox" checked={form.addons.includes(a.id)} onChange={() => toggleAddon(a.id)} />
                        {a.label} (+{formatMoney(a.price)})
                      </label>
                    ))}
                    <label className="text-xs flex items-center gap-1 border border-plum/15 rounded-full px-2 py-1 cursor-pointer">
                      <input type="checkbox" checked={form.pets} onChange={(e) => set({ pets: e.target.checked })} />
                      Pets in home
                    </label>
                  </div>
                </fieldset>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
                  <Field id="bm-date" label="Date">
                    <Input id="bm-date" type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <Field id="bm-time" label="Start time">
                    <Input id="bm-time" type="time" step="900" value={form.time} onChange={(e) => set({ time: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <Field id="bm-duration" label="Duration (min)">
                    <Input
                      id="bm-duration"
                      type="number"
                      min="30"
                      step="15"
                      placeholder={String(quote?.durationMinutes ?? "")}
                      value={form.durationMinutes}
                      onChange={(e) => set({ durationMinutes: e.target.value })}
                      className="bg-white mt-1 text-sm"
                    />
                  </Field>
                </div>
                {validDate && (
                  <div className="text-xs text-plum/70">
                    {availQ.loading && !availQ.data ? (
                      "Checking availability…"
                    ) : availQ.data?.reason ? (
                      <span className="text-rose-700">Day unavailable: {availQ.data.reason}</span>
                    ) : (
                      <span className="flex flex-wrap gap-1 items-center">
                        Standard slots:
                        {slots.map((s) => (
                          <button
                            type="button"
                            key={s.time}
                            disabled={!s.available}
                            onClick={() => set({ time: s.time })}
                            className={`px-2 py-0.5 rounded-full border ${s.available ? "border-emerald-300 text-emerald-800 hover:bg-emerald-50" : "border-slate-200 text-slate-400 line-through"}`}
                          >
                            {s.label}
                          </button>
                        ))}
                        <span className="ml-1">(admins may choose any time within business hours)</span>
                      </span>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
                  <Field id="bm-access" label="Access notes">
                    <Textarea id="bm-access" rows={2} value={form.accessNotes} onChange={(e) => set({ accessNotes: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <Field id="bm-cleaner" label="Cleaner notes">
                    <Textarea id="bm-cleaner" rows={2} value={form.cleanerNotes} onChange={(e) => set({ cleanerNotes: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                  <Field id="bm-admin" label="Admin notes (private)">
                    <Textarea id="bm-admin" rows={2} value={form.adminNotes} onChange={(e) => set({ adminNotes: e.target.value })} className="bg-white mt-1 text-sm" />
                  </Field>
                </div>
              </div>

              <aside className="rounded-xl border border-plum/10 bg-[#FFF7FB] p-3 sm:p-4 space-y-3 text-sm h-fit">
                <p className="font-semibold text-plum">Price</p>
                {quoteQ.error ? (
                  <p className="text-rose-700 text-xs">{quoteQ.error.message}</p>
                ) : quote ? (
                  <>
                    <ul className="space-y-1 text-xs text-plum/80">
                      {quote.lineItems.map((li, i) => (
                        <li key={i} className="flex justify-between gap-2">
                          <span>{li.label}</span>
                          <span>{formatMoney(li.amount)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="flex justify-between font-semibold text-plum border-t border-plum/10 pt-2">
                      <span>Calculated total</span>
                      <span>{formatMoney(quote.totalPrice)}</span>
                    </p>
                    <p className="text-xs text-plum/60">Estimated {quote.durationHours} h</p>
                  </>
                ) : (
                  <p className="text-xs text-plum/60">Calculating…</p>
                )}
                <Field id="bm-total" label="Override total (optional)">
                  <Input id="bm-total" type="number" min="0" step="0.01" value={form.totalPrice} onChange={(e) => set({ totalPrice: e.target.value })} className="bg-white mt-1 text-sm" />
                </Field>
                <Field id="bm-deposit" label="Deposit required">
                  <Input
                    id="bm-deposit"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder={String(quote?.depositAmount ?? "")}
                    value={form.depositAmount}
                    onChange={(e) => set({ depositAmount: e.target.value })}
                    className="bg-white mt-1 text-sm"
                  />
                </Field>
                <label className="flex items-center gap-2 text-xs text-plum">
                  <input type="checkbox" checked={form.notifyClient} onChange={(e) => set({ notifyClient: e.target.checked })} />
                  Email the client
                </label>
              </aside>
            </div>

            {error && (
              <p className="mt-3 text-sm text-rose-700" role="alert">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} className="border-plum/30 text-plum">
                Cancel
              </Button>
              <Button onClick={submit} disabled={saving} className="bg-[#E2A82B] text-[#431039] hover:bg-[#F0BA3E]">
                {saving ? "Saving…" : isEdit ? "Save changes" : "Create booking"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BookingModal;

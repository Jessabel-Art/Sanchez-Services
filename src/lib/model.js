// src/lib/model.js — shared helpers for API records (dates, labels, money).

/** Accepts Date | ISO string | number | {toDate} and returns a valid Date or null. */
export function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v?.toDate === "function") return toDate(v.toDate());
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const toMillis = (v) => toDate(v)?.getTime() ?? 0;

const DATE_FIELDS = ["startAt", "endAt", "createdAt", "updatedAt", "confirmedAt", "cancelledAt", "completedAt", "holdExpiresAt"];

/** Converts a booking from the API into the shape the UI uses (Date objects + convenience fields). */
export function normalizeBooking(b) {
  if (!b) return b;
  const out = { ...b };
  DATE_FIELDS.forEach((k) => {
    out[k] = toDate(b[k]);
  });
  out.payments = (b.payments || []).map((p) => ({ ...p, paidAt: toDate(p.paidAt) }));
  out.history = (b.history || []).map((h) => ({ ...h, at: toDate(h.at) }));
  out.clientName = b.contact?.name || "";
  out.addressText = formatAddress(b.address);
  return out;
}

export function formatAddress(a) {
  if (!a) return "";
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.line1, a.line2, cityLine].filter(Boolean).join(", ");
}

export const STATUS_LABELS = {
  pending_payment: "Awaiting deposit",
  pending: "Pending",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  declined: "Declined",
  expired: "Expired",
};
export const statusLabel = (s) => STATUS_LABELS[s] || (s ? s[0].toUpperCase() + s.slice(1) : "—");

export const PAYMENT_STATUS_LABELS = {
  not_required: "No charge",
  unpaid: "Unpaid",
  deposit_paid: "Deposit paid",
  paid: "Paid in full",
  refunded: "Refunded",
};
export const paymentStatusLabel = (s) => PAYMENT_STATUS_LABELS[s] || "—";

export const METHOD_LABELS = { card: "Card", cash: "Cash", zelle: "Zelle", venmo: "Venmo", cash_app: "Cash App", check: "Check", other: "Other" };
export const methodLabel = (m) => METHOD_LABELS[m] || m || "—";

export function formatMoney(v) {
  const n = Number(v || 0);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Business timezone formatting (America/New_York). */
const TZ = "America/New_York";
export const fmtDate = (v, opts = { month: "short", day: "numeric", year: "numeric" }) => {
  const d = toDate(v);
  return d ? d.toLocaleDateString("en-US", { timeZone: TZ, ...opts }) : "—";
};
export const fmtTime = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "";
};
export const fmtDateTime = (v) => (toDate(v) ? `${fmtDate(v)} · ${fmtTime(v)}` : "—");

/** YYYY-MM-DD of a Date in the business timezone. */
export function dateKey(v) {
  const d = toDate(v);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts;
}

export const ACTIVE_STATUSES = ["pending_payment", "pending", "confirmed"];
export const isUpcoming = (b) => ACTIVE_STATUSES.includes(b.status) && toMillis(b.startAt) >= Date.now() - 3 * 3600 * 1000;

// src/pages/admin/AdminPaymentsPage.jsx
import React, {
  useMemo,
  useEffect,
  useState,
  useCallback,
} from "react";
import { useNavigate } from "react-router-dom";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CreditCard,
  FileDown,
  Filter,
  DollarSign,
  AlertCircle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

import { db } from "@/lib/firebase";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import {
  derivePaymentInfo,
  buildInvoiceLineItems,
  formatMoney,
  isNonBillable,
  isCancelled,
  computeRemainingDue,
} from "@/lib/payments";
import { normalizeBookingForWrite } from "@/lib/bookings";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import logoPrimary from "@/assets/logo/logo-primary.png";
import { formatAddress } from "@/lib/utils";

import { useAdminAuth } from "./hooks/useAdminAuth";
import AdminHeader from "./components/AdminHeader";
import AdminSidebar from "./components/AdminSidebar";
import { AdminUIProvider } from "./context/AdminUIContext";
import AuthPage from "../AuthPage";

const PAYMENT_METHOD_OPTIONS = [
  { id: "card_stripe", label: "Card (Stripe)" },
  { id: "cash_app", label: "Cash App" },
  { id: "zelle", label: "Zelle" },
  { id: "cash", label: "Cash" },
  { id: "other", label: "Other" },
];

const PAYMENT_STATUS_OPTIONS = [
  "Paid in full",
  "Partial payment",
  "Unpaid",
  "Refunded",
  "Cancelled",
];

const DEPOSIT_STATUS_OPTIONS = [
  { id: "none", label: "Not required" },
  { id: "pending", label: "Pending" },
  { id: "paid", label: "Paid" },
];

const SELECT_TRIGGER_BASE =
  "h-8 text-xs bg-white border border-plum/20 shadow-sm px-3 flex items-center gap-1 rounded-md";
const SELECT_CONTENT_BASE =
  "bg-white border border-plum/10 shadow-lg rounded-md";

// small helper to coerce firebase timestamps
function toDate(tsLike) {
  if (!tsLike) return null;
  if (typeof tsLike?.toDate === "function") return tsLike.toDate();
  if (tsLike instanceof Date) return tsLike;
  if (typeof tsLike === "object" && typeof tsLike.seconds === "number") {
    return new Date(tsLike.seconds * 1000 + Math.floor((tsLike.nanoseconds || 0) / 1e6));
  }
  const d = new Date(tsLike);
  return Number.isNaN(d.getTime()) ? null : d;
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
    b.startAt ??
      b.scheduledAt ??
      b.endAt ??
      b.date ??
      raw.startAt ??
      raw.scheduledAt ??
      raw.endAt ??
      raw.date
  );
  return {
    ...b,
    scheduledAt: scheduled,
    startAt: b.startAt ?? raw.startAt,
    date: b.date ?? raw.date,
    amount: Number(
      b.amount ?? b.price ?? b.cost ?? raw.amount ?? raw.price ?? raw.cost ?? 0
    ),
    depositAmount: Number(b.depositAmount ?? raw.depositAmount ?? 0),
    depositPaid: !!(b.depositPaid ?? raw.depositPaid),
    amountPaid: Number(b.amountPaid ?? raw.amountPaid ?? raw.paid ?? 0),
    remainingBalance: b.remainingBalance ?? raw.remainingBalance,
    refunded: !!(b.refunded ?? raw.refunded),
    refundedAmount: Number(b.refundedAmount ?? raw.refundedAmount ?? 0),
    balancePaymentMethod: b.balancePaymentMethod ?? raw.balancePaymentMethod,
    paymentMethod: b.paymentMethod ?? raw.paymentMethod,
    depositPaymentMethod: b.depositPaymentMethod ?? raw.depositPaymentMethod,
    stripePaymentIntentId:
      b.stripePaymentIntentId ?? raw.stripePaymentIntentId,
    stripeSessionId: b.stripeSessionId ?? raw.stripeSessionId,
  };
}

/**
 * Single source of truth for the money math.
 *
 * - total: full service total
 * - depositAmt: deposit required
 * - depositPaid: whether deposit has been paid
 * - basePaid: non-deposit payments
 * - effectivePaid: basePaid + (depositPaid ? depositAmt : 0)
 * - remaining: max(total - effectivePaid, 0) OR 0 if non-billable
 *
 * Non-billable bookings (cancelled, declined) always have remaining = 0
 * and depositPaid = true (so they don't show deposit due).
 */
function computeRowMoney(row) {
  const p = row.payment || {};

  // Non-billable bookings are immediately closed out with zero balance
  if (isNonBillable(row)) {
    return {
      total: Number(p.totalAmount ?? p.total ?? row.amount ?? 0),
      depositAmt: 0, // never show deposit due for cancelled/declined
      depositPaid: true, // treat as paid so no "deposit pending" badge shows
      basePaid: 0,
      effectivePaid: 0,
      remaining: 0, // cancelled/declined: no balance due
    };
  }

  const total = Number(
    p.totalAmount ??
      p.total ??
      row.amount ??
      0
  );

  const depositAmt = Number(
    p.depositAmount ??
      row.depositAmount ??
      0
  );
  const depositPaid = Boolean(
    p.depositPaid ??
      row.depositPaid
  );

  const basePaid = Number(
    p.amountPaid ??
      row.amountPaid ??
      0
  );

  const effectivePaid = basePaid + (depositPaid ? depositAmt : 0);
  const remaining = Math.max(total - effectivePaid, 0);

  return {
    total,
    depositAmt,
    depositPaid,
    basePaid,
    effectivePaid,
    remaining,
  };
}

const AdminPaymentsPage = ({ embedded = false, onChangeView }) => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, isAdmin, loading } = useAdminAuth();

  // Bookings loaded from Firestore
  const [bookings, setBookings] = useState([]);
  const [loadingBookings, setLoadingBookings] = useState(true);

  // Main status filter
  const [filter, setFilter] = useState("all");

  // Advanced search
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [monthFilter, setMonthFilter] = useState("all"); // "all" or "1".."12"
  const [yearFilter, setYearFilter] = useState("all"); // "all" or year string

  // Sorting
  const [sortField, setSortField] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  // Invoice generation state
  // Invoice generation state (removed cloud-function path; client-side generator used)

  // Modal editing state
  const [editingRow, setEditingRow] = useState(null);
  const [editDepositAmount, setEditDepositAmount] = useState("");
  const [editDepositStatus, setEditDepositStatus] = useState("none");
  const [editDepositMethod, setEditDepositMethod] = useState("cash_app");
  const [editPaymentAmount, setEditPaymentAmount] = useState("");
  const [editPaymentStatus, setEditPaymentStatus] = useState("Unpaid");
  const [editPaymentMethod, setEditPaymentMethod] = useState("cash_app");

  const now = new Date();
  const currentYear = now.getFullYear();

  // ---------- Firestore subscription (auth-gated) ----------
  useEffect(() => {
    // Only subscribe when auth is ready and user is confirmed admin
    if (!loading && !isAdmin) {
      setLoadingBookings(false);
      return;
    }

    let cancelled = false;
    try {
      const col = collection(db, "bookings");
      const q = query(col, orderBy("startAt", "desc"));
      const unsub = onSnapshot(
        q,
        (snap) => {
          if (cancelled) return;
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          setBookings(rows);
          setLoadingBookings(false);
        },
        (err) => {
          console.error("AdminPayments: failed to load bookings", err);
          toast({
            variant: "destructive",
            title: "Could not load bookings",
            description: String(err?.message || err),
          });
          setLoadingBookings(false);
        }
      );
      return () => {
        cancelled = true;
        unsub();
      };
    } catch (e) {
      console.warn("AdminPayments: subscription failed", e);
      setLoadingBookings(false);
    }
  }, [loading, isAdmin, toast]);

  const allRows = useMemo(
    () =>
      bookings.map((b) => {
        const normalized = normalizeBooking(b);
        const paymentBase = derivePaymentInfo(normalized);

        // Ensure depositAmount / depositPaid from Firestore are reflected in payment object
        const payment = {
          ...paymentBase,
          depositAmount:
            normalized.depositAmount ??
            paymentBase.depositAmount ??
            0,
          depositPaid:
            normalized.depositPaid ??
            paymentBase.depositPaid ??
            false,
        };

        // Allow a manual/overridden payment status from Firestore
        const manualStatus =
          normalized.paymentStatus ||
          normalized.status ||
          b.paymentStatus ||
          b.status;

        if (manualStatus) {
          payment.paymentStatus = manualStatus;
        }

        return {
          id: b.id,
          ...normalized,
          payment,
        };
      }),
    [bookings]
  );

  // Available years based on data + current and next year
  const availableYears = useMemo(() => {
    const yearsSet = new Set();
    allRows.forEach((r) => {
      const d = toDate(r.startAt || r.scheduledAt || r.endAt);
      if (!d) return;
      yearsSet.add(d.getFullYear());
    });
    yearsSet.add(currentYear);
    yearsSet.add(currentYear + 1);
    return Array.from(yearsSet).sort((a, b) => a - b);
  }, [allRows, currentYear]);

  // ---------- Month/year filter ----------
  const dateFilteredRows = useMemo(() => {
    return allRows.filter((r) => {
      const d = toDate(r.startAt || r.scheduledAt || r.endAt);
      if (!d) return false;

      if (yearFilter !== "all") {
        const y = Number(yearFilter);
        if (d.getFullYear() !== y) return false;
      }

      if (monthFilter !== "all") {
        const m = Number(monthFilter); // 1-12
        if (d.getMonth() + 1 !== m) return false;
      }

      return true;
    });
  }, [allRows, monthFilter, yearFilter]);

  // ---------- KPIs (based on month/year only) ----------
  const kpis = useMemo(() => {
    let totalCollected = 0;
    let outstandingBalances = 0;
    let depositsNotReceivedCount = 0;
    let refundsInPeriod = 0;

    dateFilteredRows.forEach((r) => {
      const p = r.payment || {};
      const money = computeRowMoney(r);

      // Non-billable bookings don't contribute to KPIs
      if (isNonBillable(r)) {
        return;
      }

      totalCollected += money.effectivePaid;
      outstandingBalances += money.remaining;

      if (money.depositAmt > 0 && !money.depositPaid) {
        depositsNotReceivedCount += 1;
      }

      const refundedAmt = Number(p.refundedAmount || 0);
      if (p.refunded && refundedAmt > 0) {
        refundsInPeriod += refundedAmt;
      }
    });

    return {
      totalCollected,
      outstandingBalances,
      depositsNotReceivedCount,
      refundsInPeriod,
    };
  }, [dateFilteredRows]);

  // ---------- Search filter ----------
  const searchFilteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return dateFilteredRows;

    return dateFilteredRows.filter((r) => {
      const p = r.payment || {};
      const d = toDate(r.startAt || r.scheduledAt || r.endAt);
      const dateStr = d ? d.toLocaleDateString().toLowerCase() : "";
      const invoiceNumber =
        r.invoiceNumber ||
        r.invoiceNo ||
        r.invoiceId ||
        r.invoice ||
        r.orderId ||
        r.orderCode ||
        r.id;

      const fields = [
        r.clientName,
        r.client?.name,
        r.clientFullName,
        r.name,
        r.serviceName,
        invoiceNumber,
        r.phone,
        r.contact?.phone,
        r.email,
        r.contact?.email,
        dateStr,
        String(p.totalAmount || p.total || r.amount || ""),
        String(p.amountPaid || ""),
        formatMoney(p.totalAmount || p.total || 0),
        formatMoney(p.amountPaid || 0),
      ];

      return fields.some(
        (val) => val && String(val).toLowerCase().includes(term)
      );
    });
  }, [dateFilteredRows, searchTerm]);

  // ---------- Status filter ----------
  const statusFilteredRows = useMemo(() => {
    if (filter === "all") return searchFilteredRows;

    if (filter === "deposit_not_received")
      return searchFilteredRows.filter(
        (r) =>
          (r.payment?.depositAmount || 0) > 0 && !r.payment?.depositPaid
      );

    if (filter === "balance_overdue")
      return searchFilteredRows.filter((r) => {
        const money = computeRowMoney(r);
        const when = r.startAt || r.scheduledAt || r.endAt;
        return money.remaining > 0 && when && toDate(when) < new Date();
      });

    if (filter === "cancelled_with_deposit")
      return searchFilteredRows.filter((r) => {
        const money = computeRowMoney(r);
        return (
          (r.status === "cancelled") &&
          money.depositAmt > 0 &&
          !money.depositPaid
        );
      });

    return searchFilteredRows;
  }, [searchFilteredRows, filter]);

  // ---------- Sorted rows ----------
  const rows = useMemo(() => {
    const arr = [...statusFilteredRows];
    arr.sort((a, b) => {
      const pa = a.payment || {};
      const pb = b.payment || {};
      let av;
      let bv;

      switch (sortField) {
        case "client": {
          const ca =
            a.clientName ||
            a.client?.name ||
            a.clientFullName ||
            a.name ||
            "";
          const cb =
            b.clientName ||
            b.client?.name ||
            b.clientFullName ||
            b.name ||
            "";
          av = ca.toLowerCase();
          bv = cb.toLowerCase();
          break;
        }
        case "service":
          av = (a.serviceName || "").toLowerCase();
          bv = (b.serviceName || "").toLowerCase();
          break;
        case "total": {
          const ma = computeRowMoney(a);
          const mb = computeRowMoney(b);
          av = ma.total;
          bv = mb.total;
          break;
        }
        case "deposit": {
          const ma = computeRowMoney(a);
          const mb = computeRowMoney(b);
          av = ma.depositAmt;
          bv = mb.depositAmt;
          break;
        }
        case "remaining": {
          const ma = computeRowMoney(a);
          const mb = computeRowMoney(b);
          av = ma.remaining;
          bv = mb.remaining;
          break;
        }
        case "status":
          av = (a.status || pa.paymentStatus || "").toLowerCase();
          bv = (b.status || pb.paymentStatus || "").toLowerCase();
          break;
        case "date":
        default: {
          const da = toDate(a.startAt || a.scheduledAt || a.endAt) || new Date(0);
          const db = toDate(b.startAt || b.scheduledAt || b.endAt) || new Date(0);
          av = da.getTime();
          bv = db.getTime();
          break;
        }
      }

      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [statusFilteredRows, sortField, sortDir]);

  // ---------- Filter summary (for visible rows) ----------
  const filterSummary = useMemo(() => {
    let outstanding = 0;
    let missingDeposits = 0;
    let totalDeposits = 0;
    let totalPaid = 0;

    rows.forEach((r) => {
      // Non-billable bookings don't contribute to filter summary
      if (isNonBillable(r)) {
        return;
      }

      const money = computeRowMoney(r);

      totalDeposits += money.depositAmt;
      totalPaid += money.effectivePaid;

      if (money.remaining > 0) outstanding += money.remaining;
      if (money.depositAmt > 0 && !money.depositPaid) {
        missingDeposits += 1;
      }
    });

    return {
      count: rows.length,
      outstanding,
      missingDeposits,
      totalDeposits,
      totalPaid,
    };
  }, [rows]);

  // ---------- helpers ----------
  function getStatusBadgeClass(statusLike) {
    const s = String(statusLike || "").toLowerCase();
    if (s.includes("refunded")) return "bg-slate-100 text-slate-700";
    if (s.includes("paid in full")) return "bg-emerald-100 text-emerald-800";
    if (s.includes("partial")) return "bg-amber-100 text-amber-800";
    if (s.includes("deposit")) return "bg-orange-100 text-orange-800";
    if (s.includes("unpaid")) return "bg-rose-100 text-rose-800";
    if (s.includes("cancel")) return "bg-rose-50 text-rose-700";
    return "bg-plum/5 text-plum/80";
  }

  function getClientName(row) {
    return (
      row?.clientName ||
      row?.client?.name ||
      row?.clientFullName ||
      row?.name ||
      row?.contact?.name ||
      "Client"
    );
  }

  function handleSort(field) {
    setSortField((prevField) => {
      if (prevField === field) {
        setSortDir((prevDir) => (prevDir === "asc" ? "desc" : "asc"));
        return prevField;
      }
      setSortDir(field === "date" ? "desc" : "asc");
      return field;
    });
  }

  function sortIndicator(field) {
    if (sortField !== field) return null;
    return sortDir === "asc" ? "▲" : "▼";
  }

  const headerCell =
    "cursor-pointer select-none flex items-center gap-1";

  const isEditOpen = !!editingRow;

  // ---------- Modal helpers ----------
  function openEditModal(row) {
    const payment = row.payment || {};

    // Deposit defaults
    const depositAmount = Number(
      row.depositAmount ?? payment.depositAmount ?? 0
    );
    const depositPaid =
      row.depositPaid || payment.depositPaid || false;
    const depositMethod =
      row.depositPaymentMethod ||
      payment.depositPaymentMethod ||
      "cash_app";

    let depositStatus = "none";
    if (depositAmount > 0) {
      depositStatus = depositPaid ? "paid" : "pending";
    }

    // Payment defaults (non-deposit portion)
    const paidAmount = Number(payment.amountPaid || 0);
    const paymentStatus = payment.paymentStatus || "Unpaid";
    const paymentMethod =
      row.balancePaymentMethod ||
      payment.balancePaymentMethod ||
      row.paymentMethod ||
      payment.paymentMethod ||
      payment.methodRaw ||
      "cash_app";

    setEditDepositAmount(
      depositAmount > 0 ? depositAmount.toFixed(2) : ""
    );
    setEditDepositStatus(depositStatus);
    setEditDepositMethod(depositMethod);

    setEditPaymentAmount(
      paidAmount > 0 ? paidAmount.toFixed(2) : ""
    );
    setEditPaymentStatus(paymentStatus);
    setEditPaymentMethod(paymentMethod);

    setEditingRow(row);
  }

  async function handleSaveEdits() {
    if (!editingRow) return;

    try {
      const payment = editingRow.payment || {};
      const totalAmount = Number(
        payment.totalAmount || payment.total || editingRow.amount || 0
      );

      // Deposit
      const depositAmountNum = Number(editDepositAmount || 0);
      const depositStatus = editDepositStatus;

      // Payment (non-deposit portion)
      const paymentAmountNum = Number(editPaymentAmount || 0);
      const paymentStatus = editPaymentStatus;

      // Effective deposit counted toward total
      const effectiveDepositPaid =
        depositStatus === "paid" ? depositAmountNum : 0;

      // Remaining = total - (depositPaid + other payments)
      const remaining = Math.max(
        totalAmount - paymentAmountNum - effectiveDepositPaid,
        0
      );

      const ref = doc(db, "bookings", editingRow.id);
      const patch = {
        updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
      };

      // Deposit patch
      if (depositStatus === "none") {
        patch.depositAmount = 0;
        patch.depositPaid = false;
        patch.depositPaymentMethod = null;
      } else {
        patch.depositAmount = depositAmountNum;
        patch.depositPaid = depositStatus === "paid";
        patch.depositPaymentMethod = editDepositMethod;
        if (depositStatus === "paid" && !editingRow.depositPaid) {
          patch.depositPaidAt = serverTimestamp
            ? serverTimestamp()
            : new Date();
        }
      }

      // Payment patch (we keep amountPaid as the non-deposit portion)
      patch.amountPaid = paymentAmountNum;
      patch.paid = paymentAmountNum;
      patch.paymentStatus = paymentStatus;
      // If the admin sets payment status to Cancelled, reflect booking status and zero balances
      if (paymentStatus === "Cancelled") {
        patch.status = "cancelled"; // normalized exact status
        patch.remainingBalance = 0;
      } else {
        patch.remainingBalance = remaining;
      }
      patch.balancePaymentMethod = editPaymentMethod;
      patch.paymentMethod = editPaymentMethod;

      if (paymentStatus === "Refunded") {
        patch.refunded = true;
        patch.refundedAmount = paymentAmountNum || totalAmount;
      } else {
        patch.refunded = false;
        patch.refundedAmount = 0;
      }

      // Normalize timestamps before write to ensure proper Firestore types
      const normalizedPatch = normalizeBookingForWrite(patch);
      await updateDoc(ref, normalizedPatch);
      setEditingRow(null);
      toast({
        title: "Payment details updated",
        description:
          "Deposit and payment information have been saved.",
      });
    } catch (err) {
      console.error("Could not save edits", err);
      toast({
        title: "Could not save edits",
        description: String(err?.message || err),
        variant: "destructive",
      });
    }
  }

  // ---------- Invoice (client-side HTML / CSV) ----------
  function buildInvoiceHtml(booking, info, lineItems, subtotal, discountsTotal) {
    const invoiceNumber =
      booking.invoiceNumber ||
      booking.invoiceNo ||
      booking.invoiceId ||
      booking.invoice ||
      booking.orderId ||
      booking.orderCode ||
      booking.id ||
      "booking";
    const invoiceDate = new Date().toLocaleDateString();
    const addr = formatAddress(booking);
    const rowsHtml = lineItems
      .map(
        (li) =>
          `<tr><td style="padding:6px 8px">${li.label}</td><td style="padding:6px 8px;text-align:right">${formatMoney(
            li.amount
          )}</td></tr>`
      )
      .join("");

      return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${invoiceNumber}</title></head><body><div style="font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:20px auto;color:#111"><img src="${logoPrimary}" alt="logo" style="height:48px;margin-bottom:12px"/><h2>Invoice</h2><div>Invoice #: <strong>${invoiceNumber}</strong></div><div>Date: ${invoiceDate}</div><div style="margin-top:12px"><strong>Bill to:</strong><div style="white-space:pre-line">${addr}</div></div><table style="width:100%;border-collapse:collapse;margin-top:12px">${rowsHtml}<tr><td style="padding:6px 8px"><strong>Total</strong></td><td style="padding:6px 8px;text-align:right"><strong>${formatMoney(
      subtotal
    )}</strong></td></tr></table></div></body></html>`;
  }

  function handleDownloadInvoiceClient(format, booking) {
    const nb = normalizeBooking(booking);
    const info = derivePaymentInfo(nb);
    const { lineItems, subtotal, discountsTotal, pricing } = buildInvoiceLineItems(
      nb,
      info,
      nb.address
    );

    if (format === "csv") {
      const cols = ["Label", "Qty", "UnitPrice", "Amount"];
      const lines = [cols.join(",")];
      lineItems.forEach((li) => {
        lines.push(
          [
            `"${li.label.replace(/"/g, '""')}"`,
            li.qty || 1,
            li.unitPrice || "",
            li.amount || "",
          ].join(",")
        );
      });
      const blob = new Blob([lines.join("\n")], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${booking.id || "booking"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return;
    }

    // PDF (client-side HTML invoice like PaymentCenterPage)
    // Build address string from booking fields (mirror PaymentCenterPage logic)
    const address = formatAddress(nb);

    const orderCode = nb.orderCode || nb.id?.slice(0, 8) || "";
    const invoiceDate = new Date().toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const dueDate = invoiceDate;

    const billName =
      nb.contact?.name || nb.name || nb.customerName || "On file";

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
              <td style="padding:10px 8px; border-bottom:1px solid #f1e3ff; font-size:12px; text-align:right;">${formatMoney(
                item.unitPrice
              )}</td>
              <td style="padding:10px 8px; border-bottom:1px solid #f1e3ff; font-size:12px; text-align:right; ${
                item.isDiscount ? "color:#b4234b;" : ""
              }">${formatMoney(item.amount)}</td>
            </tr>
          `
      )
      .join("");

    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Invoice - ${orderCode}</title>
          <meta name="viewport" content="width=device-width,initial-scale=1" />
        </head>
        <body style="margin:0; background:#f7f2fb; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#2c0735;">
          <div style="max-width:840px; margin:32px auto; background:#ffffff; border-radius:8px; padding:32px 36px; box-sizing:border-box; box-shadow:0 18px 40px rgba(31, 4, 43, 0.09);">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:28px;">
              <div style="display:flex; align-items:center; gap:12px;">
                <div style="width:40px; height:40px; border-radius:999px; overflow:hidden; display:flex; align-items:center; justify-content:center; border:1px solid #f1d7ff;">
                  <img src="${logoPrimary}" alt="Sanchez Services" style="max-width:100%; max-height:100%; object-fit:contain;" />
                </div>
                <div>
                  <div style="font-size:14px; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:#7e4b8e;">Sanchez Services</div>
                  <div style="margin-top:4px; font-size:12px; color:#9b74a6;">Residential & commercial cleaning<br/>Rhode Island & Massachusetts</div>
                </div>
              </div>
              <div style="text-align:right; font-size:11px; color:#9b74a6;">
                <div style="margin-bottom:4px;">Invoice # <span style="font-weight:600; letter-spacing:0.12em;">${orderCode}</span></div>
                <div>Invoice date: <span style="font-weight:500;">${invoiceDate}</span></div>
                <div>Due date: <span style="font-weight:500;">${dueDate}</span></div>
              </div>
            </div>

            <h1 style="margin:0 0 28px; text-align:center; font-size:18px; letter-spacing:0.28em; text-transform:uppercase; color:#1a0430;">Cleaning services invoice</h1>

            <div style="display:flex; flex-wrap:wrap; gap:32px; margin-bottom:28px; font-size:13px;">
              <div style="flex:1 1 260px;">
                <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">Bill to</div>
                <div style="font-size:14px; font-weight:500; color:#2c0735;">${billName}</div>
                <div style="margin-top:4px; white-space:pre-line; color:#5b4461;">${address || "Address on file"}</div>
              </div>
              <div style="flex:1 1 220px;">
                <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">Appointment</div>
                <div><strong>Service:</strong> ${nb.serviceName || "Cleaning service"}</div>
                <div style="margin-top:4px;"><strong>Date / time:</strong> ${info.dateTimeRange}</div>
                <div style="margin-top:4px;"><strong>Frequency:</strong> ${nb.frequency || "one-time"}</div>
                <div style="margin-top:4px;"><strong>Status:</strong> ${info.statusLabel}</div>
                <div style="margin-top:4px;"><strong>Service address:</strong> ${address}</div>
              </div>
            </div>

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

            <div style="display:flex; justify-content:flex-end; margin-bottom:24px; font-size:13px;">
              <div style="width:260px;">
                <div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Subtotal</span><span>${formatMoney(subtotal)}</span></div>
                ${
                  discountsTotal > 0
                    ? `<div style="display:flex; justify-content:space-between; padding:4px 0; color:#b4234b;"><span>Discounts</span><span>${formatMoney(-discountsTotal)}</span></div>`
                    : ""
                }
                <div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Service total</span><span>${formatMoney(info.totalPrice)}</span></div>
                <div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Deposit ${info.depositPaid ? "(received)" : "(due)"}</span><span>${formatMoney(info.depositAmount)}</span></div>
                <div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Additional payments</span><span>${formatMoney(info.amountPaid)}</span></div>
                <div style="display:flex; justify-content:space-between; padding:4px 0; border-top:1px solid #edd8ff; margin-top:6px;"><span>Total paid so far</span><span>${formatMoney(info.totalPaid)}</span></div>
                <div style="display:flex; justify-content:space-between; padding:6px 0; border-top:1px solid #edd8ff; margin-top:6px; font-weight:600;"><span>Amount due</span><span>${formatMoney(info.remainingBalance)}</span></div>
              </div>
            </div>

            <div style="display:flex; flex-wrap:wrap; gap:24px; font-size:12px; margin-bottom:16px;">
              <div style="flex:1 1 260px;">
                <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">Payment details</div>
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
                <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">Notes for your cleaner</div>
                <div style="border:1px solid #edd8ff; border-radius:4px; padding:8px; min-height:70px;">${nb.notes ? nb.notes : "<span style='color:#b39bbc;'>No notes added.</span>"}</div>
              </div>
            </div>

            <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #e5d1ff; font-size:11px; color:#9b74a6;"><strong>Terms &amp; conditions</strong><br/>Payment is due at the time of your appointment unless otherwise arranged with Sterling. Deposits are non-refundable but may be transferred once to a new date with proper notice according to the cancellation policy.</div>
          </div>
        </body>
      </html>
    `;

    const w = window.open("", "_blank");
    if (!w)
      return toast({
        title: "Popup blocked",
        description: "Allow popups to view PDF invoices.",
        variant: "destructive",
      });
    try {
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      // Give the new window a short moment to render, then trigger print
      setTimeout(() => {
        try {
          w.print();
        } catch (e) {
          // ignore print errors
        }
      }, 350);
    } catch (e) {
      // fallback: still attempt to write/close
      try {
        w.document.write(html);
        w.document.close();
      } catch (err) {}
    }
  }

  // Invoice generation is done client-side using the HTML writer (see handleDownloadInvoiceClient)

  // ---------- CSV export (current filtered rows only) ----------
  const handleExportCsv = useCallback(() => {
    if (!rows.length) return;

    const cols = [
      "Date",
      "InvoiceNumber",
      "Client",
      "Service",
      "Total",
      "Deposit",
      "Remaining",
      "Methods",
      "Status",
    ];
    const lines = [cols.join(",")];
    rows.forEach((r) => {
      const dateStr =
        toDate(r.startAt || r.scheduledAt || r.endAt)?.toISOString() || "";
      const payment = r.payment || {};
      const invoiceNumber =
        r.invoiceNumber ||
        r.invoiceNo ||
        r.invoiceId ||
        r.invoice ||
        r.orderId ||
        r.orderCode ||
        r.id ||
        "";
      const clientName = getClientName(r);
      const money = computeRowMoney(r);
      const row = [
        dateStr,
        `"${String(invoiceNumber || "").replace(/"/g, '""')}"`,
        `"${String(clientName || "").replace(/"/g, '""')}"`,
        `"${String(r.serviceName || "").replace(/"/g, '""')}"`,
        money.total.toFixed(2),
        money.depositAmt.toFixed(2),
        money.remaining.toFixed(2),
        `"${String(payment.methodLabel || "").replace(/"/g, '""')}"`,
        r.status || payment.paymentStatus || "",
      ];
      lines.push(row.join(","));
    });
    const csv = lines.join("\n");
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `admin-payments-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [rows]);

  const handleViewChange = useCallback(
    (viewId) => {
      if (viewId === "payments") return;

      if (onChangeView) {
        onChangeView(viewId);
        return;
      }

      navigate("/admin", {
        state: { initialView: viewId || "dashboard" },
      });
    },
    [navigate, onChangeView]
  );

  // ---------- auth/layout guards ----------
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FCEFF6]">
        <div className="text-[#431039] text-sm font-medium">
          Loading admin…
        </div>
      </div>
    );
  }

  if (!user || !isAdmin) {
    return <AuthPage />;
  }

  const content = (
    <>
      <main className="flex-1 px-6 py-4 lg:px-10 lg:py-6 bg-[#FFF7FB]">
        {/* Page header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-5">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-plum/60 font-semibold">
              Admin billing
            </p>
            <h1 className="text-2xl md:text-3xl font-bold text-plum">
              Payments &amp; Deposits
            </h1>
            <p className="text-xs md:text-sm text-plum/70 max-w-xl">
              Review deposits, balances, and payment methods across all
              bookings.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-2 rounded-full"
              onClick={handleExportCsv}
              disabled={!rows.length}
            >
              <FileDown className="w-4 h-4" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* KPI strip */}
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
          <div className="bg-white border border-[#F1D8E8] rounded-2xl px-4 py-3 flex flex-col gap-1 shadow-sm">
            <div className="flex items-center justify-between text-[11px] text-plum/70">
              <span>Collected (selected period)</span>
              <DollarSign className="w-4 h-4 text-gold" />
            </div>
            <div className="text-lg font-semibold text-plum">
              {formatMoney(kpis.totalCollected || 0)}
            </div>
            <p className="text-[11px] text-plum/60">
              Based on bookings in the chosen month/year (or all dates).
            </p>
          </div>

          <div className="bg-white border border-[#F1D8E8] rounded-2xl px-4 py-3 flex flex-col gap-1 shadow-sm">
            <div className="flex items-center justify-between text-[11px] text-plum/70">
              <span>Outstanding balances</span>
              <AlertCircle className="w-4 h-4 text-rose-500" />
            </div>
            <div className="text-lg font-semibold text-rose-700">
              {formatMoney(kpis.outstandingBalances || 0)}
            </div>
            <p className="text-[11px] text-plum/60">
              Remaining balance across unpaid or partial bookings in the
              selected period.
            </p>
          </div>

          <div className="bg-white border border-[#F1D8E8] rounded-2xl px-4 py-3 flex flex-col gap-1 shadow-sm">
            <div className="flex items-center justify-between text-[11px] text-plum/70">
              <span>Deposits not received</span>
              <CreditCard className="w-4 h-4 text-plum" />
            </div>
            <div className="text-lg font-semibold text-plum">
              {kpis.depositsNotReceivedCount || 0}
            </div>
            <p className="text-[11px] text-plum/60">
              Bookings where a deposit is required but not yet paid in the
              selected period.
            </p>
          </div>

          <div className="bg-white border border-[#F1D8E8] rounded-2xl px-4 py-3 flex flex-col gap-1 shadow-sm">
            <div className="flex items-center justify-between text-[11px] text-plum/70">
              <span>Refunds in period</span>
              <RefreshCw className="w-4 h-4 text-plum" />
            </div>
            <div className="text-lg font-semibold text-plum">
              {formatMoney(kpis.refundsInPeriod || 0)}
            </div>
            <p className="text-[11px] text-plum/60">
              Total refunded for bookings in the selected month/year.
            </p>
          </div>
        </section>

        {/* Filters row */}
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-3 items-center text-[11px]">
            <span className="text-plum/70 font-medium mr-1">Filter:</span>

            {/* Status filter */}
            <Select value={filter} onValueChange={(v) => setFilter(v)}>
              <SelectTrigger
                className={`${SELECT_TRIGGER_BASE} w-56 rounded-full`}
              >
                <Filter className="w-3 h-3 text-plum/70 shrink-0" />
                <SelectValue
                  placeholder="All payments"
                  className="text-xs truncate"
                />
              </SelectTrigger>
              <SelectContent className={SELECT_CONTENT_BASE}>
                <SelectItem value="all">All payments</SelectItem>
                <SelectItem value="deposit_not_received">
                  Deposit not received
                </SelectItem>
                <SelectItem value="balance_overdue">
                  Balance overdue
                </SelectItem>
                <SelectItem value="cancelled_with_deposit">
                  Cancelled with deposit
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Advanced search toggle */}
            <button
              type="button"
              onClick={() =>
                setShowAdvancedSearch((prev) => !prev)
              }
              className="text-[11px] font-medium text-plum/80 inline-flex items-center gap-1 hover:text-plum"
            >
              Advanced search{" "}
              {showAdvancedSearch ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          </div>

          {showAdvancedSearch && (
            <div className="rounded-xl border border-[#F1D8E8] bg-white px-4 py-3 flex flex-col gap-3 text-[11px] text-plum/80 shadow-sm">
              <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
                <div className="flex-1 flex flex-col gap-1">
                  <span className="text-[11px] font-medium">
                    Search
                  </span>
                  <Input
                    placeholder="Search by client, service, invoice number, phone, email, date, or amount…"
                    value={searchTerm}
                    onChange={(e) =>
                      setSearchTerm(e.target.value)
                    }
                    className="h-8 text-xs bg-white border border-plum/20"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium">
                    Month
                  </span>
                  <Select
                    value={monthFilter}
                    onValueChange={(v) => setMonthFilter(v)}
                  >
                    <SelectTrigger
                      className={`${SELECT_TRIGGER_BASE} w-40`}
                    >
                      <SelectValue placeholder="All months" />
                    </SelectTrigger>
                    <SelectContent className={SELECT_CONTENT_BASE}>
                      <SelectItem value="all">
                        All months
                      </SelectItem>
                      <SelectItem value="1">January</SelectItem>
                      <SelectItem value="2">February</SelectItem>
                      <SelectItem value="3">March</SelectItem>
                      <SelectItem value="4">April</SelectItem>
                      <SelectItem value="5">May</SelectItem>
                      <SelectItem value="6">June</SelectItem>
                      <SelectItem value="7">July</SelectItem>
                      <SelectItem value="8">August</SelectItem>
                      <SelectItem value="9">September</SelectItem>
                      <SelectItem value="10">October</SelectItem>
                      <SelectItem value="11">November</SelectItem>
                      <SelectItem value="12">December</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium">
                    Year
                  </span>
                  <Select
                    value={yearFilter}
                    onValueChange={(v) => setYearFilter(v)}
                  >
                    <SelectTrigger
                      className={`${SELECT_TRIGGER_BASE} w-32`}
                    >
                      <SelectValue placeholder="All years" />
                    </SelectTrigger>
                    <SelectContent className={SELECT_CONTENT_BASE}>
                      <SelectItem value="all">
                        All years
                      </SelectItem>
                      {availableYears.map((y) => (
                        <SelectItem
                          key={y}
                          value={String(y)}
                        >
                          {y}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          <div className="text-[11px] text-plum/65">
            {filterSummary.count === 0 ? (
              <>No bookings match this filter right now.</>
            ) : (
              <>
                Showing{" "}
                <span className="font-semibold text-plum">
                  {filterSummary.count}
                </span>{" "}
                bookings · Outstanding{" "}
                <span className="font-semibold text-plum">
                  {formatMoney(filterSummary.outstanding)}
                </span>{" "}
                · Missing deposits:{" "}
                <span className="font-semibold text-plum">
                  {filterSummary.missingDeposits}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Main table card */}
        <Card className="bg-white border-[#F1D8E8] rounded-2xl shadow-sm mt-3 overflow-hidden">
          {/* Title row: dark plum, centered */}
          <CardHeader className="flex flex-row items-center justify-center gap-2 bg-[#431039] text-white border-b border-[#2b0a24]">
            <CardTitle className="flex items-center gap-2 text-white text-sm md:text-base">
              <CreditCard className="w-5 h-5 text-gold" />
              <span>Payments &amp; deposits overview</span>
            </CardTitle>
          </CardHeader>

          <CardContent className="p-0">
            {/* Table header */}
            <div className="hidden md:grid grid-cols-[1fr_1.1fr_1.9fr_0.8fr_1fr_0.8fr_0.9fr_0.9fr_0.9fr] px-4 py-2 text-[11px] uppercase tracking-[0.08em] text-plum/60 bg-[#FBE9F5] border-b border-[#F1D8E8]">
              <span
                className={headerCell}
                onClick={() => handleSort("date")}
              >
                DATE {sortIndicator("date")}
              </span>
              <span
                className={headerCell}
                onClick={() => handleSort("client")}
              >
                CLIENT {sortIndicator("client")}
              </span>
              <span
                className={headerCell}
                onClick={() => handleSort("service")}
              >
                SERVICE {sortIndicator("service")}
              </span>
              <span
                className={`${headerCell} justify-end`}
                onClick={() => handleSort("total")}
              >
                TOTAL {sortIndicator("total")}
              </span>
              <span className="text-right">PAYMENT</span>
              <span
                className={`${headerCell} justify-end`}
                onClick={() => handleSort("deposit")}
              >
                DEPOSIT {sortIndicator("deposit")}
              </span>
              <span
                className={`${headerCell} justify-end`}
                onClick={() => handleSort("remaining")}
              >
                REMAINING {sortIndicator("remaining")}
              </span>
              <span
                className={`${headerCell} justify-end`}
                onClick={() => handleSort("status")}
              >
                STATUS {sortIndicator("status")}
              </span>
              <span className="text-right">ACTIONS</span>
            </div>

            <div className="divide-y divide-plum/10">
              {loadingBookings && (
                <div className="px-4 py-6 text-xs text-plum/65 text-center">
                  Loading payments…
                </div>
              )}

              {!loadingBookings && rows.length === 0 && (
                <div className="px-4 py-6 text-xs text-plum/65 text-center">
                  No bookings to show yet. Once bookings come in,
                  you&apos;ll see payment status here.
                </div>
              )}

              {rows.map((row) => {
                const payment = row.payment || {};
                const money = computeRowMoney(row);
                const remaining = money.remaining;

                // Dev-only sanity check: non-billable must never show remaining due
                if (process.env.NODE_ENV !== "production") {
                  if (isNonBillable(row) && remaining > 0) {
                    console.warn("AdminPayments: non-billable row shows remaining > 0", {
                      id: row.id,
                      status: row.status,
                      remaining,
                    });
                  }
                }

                const bookingStatus =
                  row.status ||
                  payment.paymentStatus ||
                  "Pending";

                const depositAmount = money.depositAmt;
                const depositPaid = money.depositPaid;

                const depositStatusLabel =
                  depositAmount === 0
                    ? "Not required"
                    : depositPaid
                    ? "Paid"
                    : "Pending";

                const clientName = getClientName(row);

                return (
                  <div
                    key={row.id}
                    className="px-4 py-3 flex flex-col gap-3 md:grid md:grid-cols-[1fr_1.1fr_1.9fr_0.8fr_1fr_0.8fr_0.9fr_0.9fr_0.9fr] md:items-center text-[13px] bg-white"
                  >
                    {/* Date */}
                    <div className="text-xs text-plum/70">
                      <span>
                        {(
                          toDate(row.startAt || row.scheduledAt || row.endAt) ||
                          new Date()
                        ).toLocaleDateString()}
                      </span>
                    </div>

                    {/* Client */}
                    <div className="text-xs text-plum font-medium">
                      {clientName}
                    </div>

                    {/* Service */}
                    <div>
                      <p className="text-xs text-plum font-medium">
                        {row.serviceName}
                      </p>
                    </div>

                    {/* Total */}
                    <div className="text-right text-xs text-plum font-semibold">
                      {formatMoney(money.total)}
                    </div>

                    {/* Payment summary (display only, non-deposit portion) */}
                    <div className="text-right text-xs text-plum">
                      <div className="font-medium text-plum">
                        {payment.paymentStatus || "Unpaid"}
                      </div>
                      <div className="text-[11px] text-plum/70">
                        Paid:{" "}
                        {formatMoney(money.basePaid)}
                      </div>
                      <div className="text-[10px] text-plum/60">
                        Method:{" "}
                        {payment.methodLabel || "Not recorded"}
                      </div>
                    </div>

                    {/* Deposit (display only) */}
                    <div className="text-right text-xs text-plum/80">
                      <div className="font-medium">
                        {formatMoney(depositAmount)}
                      </div>
                      <div className="text-[10px] text-plum/60">
                        {depositStatusLabel}
                      </div>
                    </div>

                    {/* Remaining */}
                    <div className="text-right text-xs">
                      {remaining > 0 ? (
                        <span className="inline-flex px-2 py-0.5 rounded-full bg-rose-50 text-[11px] text-rose-700 border border-rose-100">
                          {formatMoney(remaining)} due
                        </span>
                      ) : (
                        <span className="inline-flex px-2 py-0.5 rounded-full bg-emerald-50 text-[11px] text-emerald-700 border border-emerald-100">
                          {formatMoney(0)}
                        </span>
                      )}
                    </div>

                    {/* Status badge (booking status) */}
                    <div className="flex justify-end">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${getStatusBadgeClass(
                          bookingStatus
                        )}`}
                      >
                        {bookingStatus}
                      </span>
                    </div>

                    {/* Actions: Edit modal + invoice icon */}
                    <div className="flex justify-end items-center gap-2">
                      {/* Plain hyperlink-style Edit */}
                      <button
                        type="button"
                        onClick={() => openEditModal(row)}
                        className="text-[11px] text-plum hover:underline font-medium"
                      >
                        Edit
                      </button>

                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() =>
                          handleDownloadInvoiceClient("pdf", row)
                        }
                      >
                        <FileDown className="w-4 h-4 text-plum" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer summary bar */}
            {!loadingBookings && rows.length > 0 && (
              <div className="border-t border-[#F1D8E8] px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-plum/70 bg-[#FFF9FD]">
                <span>
                  Showing{" "}
                  <span className="font-semibold text-plum">
                    {filterSummary.count}
                  </span>{" "}
                  bookings
                </span>
                <div className="flex flex-wrap gap-3">
                  <span>
                    Deposits:{" "}
                    <span className="font-semibold text-plum">
                      {formatMoney(filterSummary.totalDeposits)}
                    </span>
                  </span>
                  <span>
                    Outstanding:{" "}
                    <span className="font-semibold text-plum">
                      {formatMoney(filterSummary.outstanding)}
                    </span>
                  </span>
                  <span>
                    Paid (incl. deposits):{" "}
                    <span className="font-semibold text-plum">
                      {formatMoney(filterSummary.totalPaid)}
                    </span>
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Edit modal */}
      <Dialog
        open={isEditOpen}
        onOpenChange={(open) => {
          if (!open) setEditingRow(null);
        }}
      >
        <DialogContent className="max-w-md bg-white">
          <DialogHeader>
            <DialogTitle className="text-plum text-sm">
              Edit payment &amp; deposit
            </DialogTitle>
          </DialogHeader>
          {editingRow && (
            <div className="space-y-4 text-[12px] text-plum/80">
              <div className="text-[11px] text-plum/70">
                <div className="font-semibold text-plum text-xs">
                  {getClientName(editingRow)}
                </div>
                <div>{editingRow.serviceName}</div>
              </div>

              <div className="border border-plum/10 rounded-lg p-3 space-y-2">
                <div className="text-[11px] font-semibold text-plum">
                  Deposit
                </div>
                <div className="flex gap-2">
                  <div className="flex-1 space-y-1">
                    <span className="text-[11px]">Amount</span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editDepositAmount}
                      onChange={(e) =>
                        setEditDepositAmount(e.target.value)
                      }
                      className="h-8 text-xs bg-white border border-plum/20"
                      placeholder="0.00"
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <span className="text-[11px]">Status</span>
                    <Select
                      value={editDepositStatus}
                      onValueChange={(v) =>
                        setEditDepositStatus(v)
                      }
                    >
                      <SelectTrigger
                        className={`${SELECT_TRIGGER_BASE} w-full`}
                      >
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent
                        className={SELECT_CONTENT_BASE}
                      >
                        {DEPOSIT_STATUS_OPTIONS.map((opt) => (
                          <SelectItem
                            key={opt.id}
                            value={opt.id}
                          >
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px]">Method</span>
                  <Select
                    value={editDepositMethod}
                    onValueChange={(v) =>
                      setEditDepositMethod(v)
                    }
                  >
                    <SelectTrigger
                      className={`${SELECT_TRIGGER_BASE} w-full`}
                    >
                      <SelectValue placeholder="Method" />
                    </SelectTrigger>
                    <SelectContent
                      className={SELECT_CONTENT_BASE}
                    >
                      {PAYMENT_METHOD_OPTIONS.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="border border-plum/10 rounded-lg p-3 space-y-2">
                <div className="text-[11px] font-semibold text-plum">
                  Payment
                </div>
                <div className="flex gap-2">
                  <div className="flex-1 space-y-1">
                    <span className="text-[11px]">Amount paid</span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editPaymentAmount}
                      onChange={(e) =>
                        setEditPaymentAmount(e.target.value)
                      }
                      className="h-8 text-xs bg-white border border-plum/20"
                      placeholder="0.00"
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <span className="text-[11px]">Status</span>
                    <Select
                      value={editPaymentStatus}
                      onValueChange={(v) =>
                        setEditPaymentStatus(v)
                      }
                    >
                      <SelectTrigger
                        className={`${SELECT_TRIGGER_BASE} w-full`}
                      >
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent
                        className={SELECT_CONTENT_BASE}
                      >
                        {PAYMENT_STATUS_OPTIONS.map((label) => (
                          <SelectItem
                            key={label}
                            value={label}
                          >
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px]">Method</span>
                  <Select
                    value={editPaymentMethod}
                    onValueChange={(v) =>
                      setEditPaymentMethod(v)
                    }
                  >
                    <SelectTrigger
                      className={`${SELECT_TRIGGER_BASE} w-full`}
                    >
                      <SelectValue placeholder="Method" />
                    </SelectTrigger>
                    <SelectContent
                      className={SELECT_CONTENT_BASE}
                    >
                      {PAYMENT_METHOD_OPTIONS.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditingRow(null)}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveEdits}>
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) {
    return content;
  }

  // ---------- main admin shell ----------
  return (
    <AdminUIProvider>
      <div className="min-h-screen flex bg-[#FFF7FB]">
        <AdminSidebar
          activeView="payments"
          onChangeView={handleViewChange}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <AdminHeader activeView="payments" user={user} />

          {content}
        </div>
      </div>
    </AdminUIProvider>
  );
};

export default AdminPaymentsPage;

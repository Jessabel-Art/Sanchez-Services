// src/pages/ClientPortalPage.jsx
import React, {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  CalendarDays,
  UserRound,
  Pencil,
  XCircle,
  CheckCircle2,
  Ban,
  Star,
  Check,
  LogOut,
  CreditCard,
} from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useAuth } from "@/context/AuthContext";
import { apiGet, apiPost, apiPatch, apiDelete, onApiWrite, getPollIntervalMs } from "@/lib/api";
import { normalizeBooking, statusLabel, isUpcoming, toMillis, toDate } from "@/lib/model";
import { OFFLINE_PAYMENT } from "@/data/paymentMethods";
import { buildInvoiceHtml } from "@/lib/payments";
// Portal components
import ClientDashboardHome from "@/components/portal/ClientDashboardHome";
import AppointmentsView from "@/components/portal/AppointmentsView";
import ProfileSettingsPanel from "@/components/portal/ProfileSettingsPanel";
import PaymentCenterPage from "@/pages/PaymentCenterPage";

/* -------------------- Config -------------------- */
const PAYMENT_INFO = { depositAmount: 50, cash: OFFLINE_PAYMENT.cash, cashApp: OFFLINE_PAYMENT.cashApp, zelle: OFFLINE_PAYMENT.zelle, notes: OFFLINE_PAYMENT.note };

const US_STATES = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
];

const selectTriggerClass =
  "bg-white text-plum border border-plum/30 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 focus:border-gold/60";
const selectContentClass = "bg-white border border-plum/20 text-plum shadow-xl";
const selectItemClass = "focus:bg-gold/10 focus:text-plum cursor-pointer";

const QUERY_LIMIT = 1000;

/* -------------------- Helpers -------------------- */
function toFriendlyStatus(raw, endAt) {
  const base = String(raw || "").toLowerCase();
  if (["cancelled"].includes(base)) return "cancelled";
  if (base === "refunded") return "Refunded";
  if (base === "expired") return "Expired";
  if (base === "completed") return "Completed";
  if (base === "pending") return "Pending";
  if (base === "declined") return "Declined";
  if (base === "confirmed") return "Confirmed";
  const ended = endAt
    ? endAt?.toDate
      ? endAt.toDate()
      : new Date(endAt)
    : null;
  if (ended && ended < new Date()) return "Confirmed";
  return "Scheduled";
}

function formatDate(tsLike) {
  try {
    if (!tsLike) return "TBD";
    const d = tsLike?.toDate ? tsLike.toDate() : new Date(tsLike);
    return d.toLocaleDateString("en-US", { timeZone: "America/New_York", 
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "TBD";
  }
}

function formatDateTime(tsLike) {
  try {
    if (!tsLike) return "TBD";
    const d = tsLike?.toDate ? tsLike.toDate() : new Date(tsLike);
    return d.toLocaleString("en-US", { timeZone: "America/New_York" });
  } catch {
    return "TBD";
  }
}

function dedupeById(rows) {
  const m = new Map();
  rows.forEach((r) => m.set(r.id, r));
  const arr = Array.from(m.values());
  const toMillis = (tsLike) => {
    try {
      if (!tsLike) return 0;
      if (typeof tsLike?.toDate === "function") return tsLike.toDate().getTime();
      if (typeof tsLike === "object" && typeof tsLike.seconds === "number") {
        return tsLike.seconds * 1000 + Math.floor((tsLike.nanoseconds || 0) / 1e6);
      }
      const d = new Date(tsLike);
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    } catch {
      return 0;
    }
  };
  arr.sort((a, b) => {
    const aTime = toMillis(a.startAt || a.scheduledAt || a.endAt || a.createdAt);
    const bTime = toMillis(b.startAt || b.scheduledAt || b.endAt || b.createdAt);
    return bTime - aTime;
  });
  return arr;
}

/* -------------------- Lightweight Dialog -------------------- */
const Modal = ({ open, onClose, title, children, footer }) => {
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const titleId = useId();
  const bodyId = useId();
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return undefined;
    }

    wasOpenRef.current = true;
    const previouslyFocused = document.activeElement;
    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const focusInitial = () => {
      closeButtonRef.current?.focus();
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll(focusableSelector) || []
      );

      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const frame = window.requestAnimationFrame(focusInitial);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={bodyId}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute inset-0 flex items-start md:items-center justify-center p-3 sm:p-4">
        <div
          ref={dialogRef}
          className="w-full max-w-lg bg-white rounded-xl md:rounded-2xl shadow-xl border border-plum/10 relative"
        >
          <button
            ref={closeButtonRef}
            type="button"
            className="absolute right-3 sm:right-4 top-3 text-plum/70 hover:text-plum"
            aria-label="Close modal"
            onClick={onClose}
          >
            ×
          </button>
          {title && (
            <div
              id={titleId}
              className="px-4 sm:px-5 pt-4 sm:pt-5 text-base sm:text-lg font-semibold text-plum"
            >
              {title}
            </div>
          )}
          <div id={bodyId} className="px-4 sm:px-5 py-3 sm:py-4">{children}</div>
          {footer && <div className="px-4 sm:px-5 pb-4 sm:pb-5">{footer}</div>}
        </div>
      </div>
    </div>
  );
};

/* ============================================================= */

export default function ClientPortalPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const {
    user,
    authReady,
    signIn,
    signUp,
    signOut,
    resetPassword,
    changeEmail,
  } = useAuth();

  /* --------------- Auth UI state --------------- */
  const [authTab, setAuthTab] = useState("login");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");

  /* --------------- Portal state --------------- */
  const [bookings, setBookings] = useState([]);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [section, setSection] = useState("dashboard"); // dashboard | appointments | profile | logout

  // contact profile (for ProfileSettingsPanel)
  const [contactProfile, setContactProfile] = useState({
    name: "",
    phone: "",
  });
  const [savingContact, setSavingContact] = useState(false);

  // preferences / contact method
  const [preferences, setPreferences] = useState(null);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [preferredContactMethod, setPreferredContactMethod] = useState(null);
  const [
    savingPreferredContactMethod,
    setSavingPreferredContactMethod,
  ] = useState(false);

  // account (email / password)
  const [emailEdit, setEmailEdit] = useState("");

  // addresses (subcollection)
  const [addresses, setAddresses] = useState([]);
  const [addrModalOpen, setAddrModalOpen] = useState(false);
  const [addrEditingId, setAddrEditingId] = useState(null);
  const [addrForm, setAddrForm] = useState({
    type: "home",
    street: "",
    city: "",
    state: "",
    zip: "",
  });

  // details / review / cancel
  const [activeBooking, setActiveBooking] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [reviewText, setReviewText] = useState("");
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewDisplayMode, setReviewDisplayMode] = useState("initials");

  /* --------------- Data (API) --------------- */
  const loadAll = React.useCallback(async () => {
    if (!user) return;
    try {
      const [{ bookings: rows }, { profile }, { addresses: addrs }] = await Promise.all([
        apiGet("/me/bookings"),
        apiGet("/me/profile"),
        apiGet("/me/addresses"),
      ]);
      setBookings(rows.map(normalizeBooking));
      setContactProfile({ name: profile.name || "", phone: profile.phone || "" });
      setPreferences(profile.preferences || null);
      setPreferredContactMethod(profile.preferredContactMethod || null);
      setEmailEdit(profile.email || user.email || "");
      setAddresses(addrs.map((a) => ({ ...a, type: a.label || "home", street: a.line1, nickname: a.label })));
      setErrorMsg("");
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setLoadingBookings(false);
      setLoadingInitial(false);
    }
  }, [user]);

  useEffect(() => {
    if (!authReady) return undefined;
    if (!user) {
      setLoadingInitial(false);
      return undefined;
    }
    setLoadingBookings(true);
    loadAll();
    const unsub = onApiWrite(() => loadAll());
    const timer = setInterval(() => document.visibilityState !== "hidden" && loadAll(), getPollIntervalMs());
    const onVisible = () => document.visibilityState === "visible" && loadAll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsub();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authReady, user, loadAll]);

  /* --------------- Derived bookings (server is the source of truth) --------------- */
  const bookingsWithFriendly = useMemo(
    () =>
      bookings.map((b) => ({
        ...b,
        id: b.id,
        date: b.startAt,
        endAt: b.endAt,
        total: b.totalPrice,
        paid: b.amountPaid,
        rawStatus: b.status,
        friendly: statusLabel(b.status),
        service: b.serviceName,
        addressLine: b.addressText || "",
        addressZip: "",
        notes: b.cleanerNotes || "",
        frequency: b.frequency || "one-time",
        addons: b.addons || [],
        depositAmount: b.depositAmount,
        depositPaid: b.depositPaid,
        depositDue: b.depositDue,
        depositReceived: b.depositPaid,
        reviewRating: b.review?.rating ?? null,
        payment: { totalPrice: b.totalPrice, paidAmount: b.amountPaid, depositAmount: b.depositAmount, depositPaid: b.depositPaid },
      })),
    [bookings]
  );

  const upcomingBookings = useMemo(() => bookingsWithFriendly.filter(isUpcoming).sort((a, b) => toMillis(a.startAt) - toMillis(b.startAt)), [bookingsWithFriendly]);
  const completedBookings = useMemo(() => bookingsWithFriendly.filter((b) => !isUpcoming(b)), [bookingsWithFriendly]);
  const isRepeatClient = completedBookings.some((b) => b.status === "completed");
  const displayName = contactProfile.name || user?.displayName || user?.email || "client";
  const [cancelReason, setCancelReason] = useState("");
  const [cutoffHours, setCutoffHours] = useState(24);
  useEffect(() => {
    apiGet("/catalog").then((c) => setCutoffHours(c.rules?.changeCutoffHours ?? 24)).catch(() => {});
  }, []);

  /* --------------- Actions --------------- */
  const { toast: showToast } = useToast();
  const fail = (title) => (err) =>
    showToast({ title, description: String(err?.message || err), variant: "destructive" });

  const handleLogin = async (e) => {
    e?.preventDefault?.();
    try {
      await signIn(loginEmail.trim(), loginPassword);
      setSection("dashboard");
    } catch (err) {
      fail("Login failed")(err);
    }
  };

  const handleSignUp = async (e) => {
    e?.preventDefault?.();
    try {
      await signUp(signupEmail.trim(), signupPassword, signupName.trim());
      setSection("dashboard");
    } catch (err) {
      fail("Sign up failed")(err);
    }
  };

  const handleLogout = async () => {
    await signOut();
    showToast({ title: "Logged out" });
    navigate("/");
  };

  const saveEmail = async () => {
    const newEmail = (emailEdit || "").trim();
    if (!newEmail || newEmail.toLowerCase() === (user?.email || "").toLowerCase()) return;
    try {
      await changeEmail(newEmail);
      showToast({ title: "Email updated", description: `We sent a confirmation link to ${newEmail}.` });
    } catch (err) {
      if (err.code === "auth/requires-recent-login") {
        const password = window.prompt("For your security, please enter your current password to change your email:");
        if (!password) return;
        try {
          await changeEmail(newEmail, password);
          showToast({ title: "Email updated", description: `We sent a confirmation link to ${newEmail}.` });
          return;
        } catch (e2) {
          fail("Could not update email")(e2);
          return;
        }
      }
      fail("Could not update email")(err);
    }
  };

  const handleSaveContact = async (payload) => {
    setSavingContact(true);
    try {
      const name = (payload.name || payload.fullName || "").trim();
      const phone = (payload.phone || payload.phoneNumber || "").trim();
      await apiPatch("/me/profile", { name, ...(phone ? { phone } : {}) });
      showToast({ title: "Contact details saved" });
    } catch (err) {
      fail("Could not save contact")(err);
      throw err;
    } finally {
      setSavingContact(false);
    }
  };

  const sendReset = async () => {
    try {
      await resetPassword(user.email);
      showToast({ title: "Password reset sent", description: `Check ${user.email} for the reset link.` });
    } catch (err) {
      fail("Could not send reset")(err);
    }
  };

  const handleUpcomingAction = ({ type, booking }) => {
    const b = bookingsWithFriendly.find((x) => x.id === booking?.id) || booking;
    switch (type) {
      case "view":
        setActiveBooking(b);
        setShowDetails(true);
        break;
      case "reschedule":
        if (!b.permissions?.canReschedule) {
          showToast({ title: "Please contact us", description: b.permissions?.changeBlockedReason || "This booking can't be rescheduled online." });
          return;
        }
        navigate(`/book?bookingId=${b.id}`);
        break;
      case "cancel":
        if (!b.permissions?.canCancel) {
          showToast({ title: "Please contact us", description: b.permissions?.changeBlockedReason || "This booking can't be cancelled online." });
          return;
        }
        setActiveBooking(b);
        setCancelReason("");
        setShowCancel(true);
        break;
      case "pay":
        payFor(b);
        break;
      case "book-new":
        navigate("/book");
        break;
      case "update-notes":
        apiPatch(`/bookings/${encodeURIComponent(b.id)}/notes`, { cleanerNotes: booking.notes ?? "" })
          .then(() => showToast({ title: "Notes saved" }), fail("Could not save notes"));
        break;
      case "download-pdf":
        openInvoice(b.id);
        break;
      default:
        break;
    }
  };

  const openInvoice = async (ref) => {
    const w = window.open("", "_blank");
    try {
      const { invoice } = await apiGet(`/bookings/${encodeURIComponent(ref)}/invoice`);
      const html = buildInvoiceHtml(invoice, { autoPrint: true });
      if (w) {
        w.document.open();
        w.document.write(html);
        w.document.close();
      }
    } catch (e) {
      w?.close();
      fail("Could not open invoice")(e);
    }
  };

  const payFor = async (b) => {
    const purpose = b.permissions?.canPayDeposit ? "deposit" : b.permissions?.canPayBalance ? "balance" : null;
    if (!purpose) return;
    try {
      const { checkoutUrl } = await apiPost(`/bookings/${encodeURIComponent(b.id)}/checkout`, { purpose });
      window.location.href = checkoutUrl;
    } catch (err) {
      fail("Could not start payment")(err);
    }
  };

  const confirmCancel = async () => {
    try {
      await apiPost(`/bookings/${encodeURIComponent(activeBooking.id)}/cancel`, { reason: cancelReason || undefined });
      toast({ title: "Booking cancelled", description: "We emailed you a confirmation." });
      setShowCancel(false);
    } catch (e) {
      fail("Could not cancel")(e);
    }
  };

  const submitReview = async () => {
    if (!reviewText || reviewText.trim().length < 5) {
      toast({ title: "Please enter a longer review", variant: "destructive" });
      return;
    }
    try {
      await apiPost(`/bookings/${encodeURIComponent(activeBooking.id)}/review`, {
        rating: Number(reviewRating) || 5,
        comment: reviewText.trim(),
        displayMode: reviewDisplayMode,
      });
      toast({ title: "Thanks for your feedback", description: "Your review is pending approval." });
      setShowReview(false);
      setReviewText("");
      setReviewRating(5);
    } catch (e) {
      fail("Could not submit review")(e);
    }
  };

  // Address helpers
  const resetAddrForm = () => setAddrForm({ type: "home", street: "", city: "", state: "", zip: "" });
  const openAddAddress = () => {
    setAddrEditingId(null);
    resetAddrForm();
    setAddrModalOpen(true);
  };
  const openEditAddress = (row) => {
    setAddrEditingId(row.id);
    setAddrForm({ type: row.label || "home", street: row.line1 || "", city: row.city || "", state: row.state || "", zip: row.zip || "" });
    setAddrModalOpen(true);
  };
  const saveAddress = async () => {
    const body = {
      label: addrForm.type ? addrForm.type[0].toUpperCase() + addrForm.type.slice(1) : "Home",
      line1: (addrForm.street || "").trim(),
      city: (addrForm.city || "").trim(),
      state: (addrForm.state || "").trim(),
      zip: (addrForm.zip || "").trim(),
    };
    if (!body.line1 || !body.city || !body.state || !body.zip) {
      showToast({ title: "Missing fields", description: "Please complete all address fields.", variant: "destructive" });
      return;
    }
    try {
      if (addrEditingId) await apiPatch(`/me/addresses/${addrEditingId}`, body);
      else await apiPost("/me/addresses", body);
      showToast({ title: addrEditingId ? "Address updated" : "Address added" });
      setAddrModalOpen(false);
      setAddrEditingId(null);
      resetAddrForm();
    } catch (e) {
      fail("Could not save address")(e);
    }
  };
  const deleteAddress = (row) => apiDelete(`/me/addresses/${row.id}`).then(() => showToast({ title: "Address removed" }), fail("Could not remove address"));
  const setDefaultAddress = (row) => apiPatch(`/me/addresses/${row.id}`, { isDefault: true }).then(() => showToast({ title: "Default address set" }), fail("Could not set default"));
  const moveAddress = async (row, delta) => {
    const idx = addresses.findIndex((a) => a.id === row.id);
    const j = idx + delta;
    if (idx < 0 || j < 0 || j >= addresses.length) return;
    const order = [...addresses];
    [order[idx], order[j]] = [order[j], order[idx]];
    try {
      await Promise.all(order.map((a, i) => (a.sortOrder === i ? null : apiPatch(`/me/addresses/${a.id}`, { sortOrder: i }))).filter(Boolean));
    } catch (e) {
      fail("Could not reorder")(e);
    }
  };
  const moveAddressUp = (row) => moveAddress(row, -1);
  const moveAddressDown = (row) => moveAddress(row, 1);

  const handleSavePreferences = async (prefs) => {
    setSavingPreferences(true);
    try {
      await apiPatch("/me/profile", { preferences: prefs || {} });
      toast({ title: "Preferences saved" });
    } catch (err) {
      fail("Could not save preferences")(err);
    } finally {
      setSavingPreferences(false);
    }
  };

  const handleSavePreferredContactMethod = async (method) => {
    setSavingPreferredContactMethod(true);
    try {
      await apiPatch("/me/profile", { preferredContactMethod: method || null });
      toast({ title: "Contact method saved" });
    } catch (err) {
      fail("Could not save contact method")(err);
    } finally {
      setSavingPreferredContactMethod(false);
    }
  };

  if (!user) return null; // ClientRoute redirects signed-out visitors to /auth

  /* -------------------- Logged-in -------------------- */
  return (
    <div className="py-12 sm:py-16 md:py-20 px-3 sm:px-4 bg-[#FFF7FB]">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <motion.div
          className="mb-6 text-center"
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-plum">
            My Account
          </h1>
          <p className="text-xs sm:text-sm md:text-base text-plum/80 mt-2">Welcome {displayName}.</p>
        </motion.div>

        {/* Status legend + top action */}
        <div className="mt-2 mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 sm:gap-0">
          <div className="text-xs sm:text-sm text-plum/70 flex flex-wrap gap-2 sm:gap-3 items-center">
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 rounded-full bg-emerald-300 inline-block" />{" "}
              Confirmed
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 rounded-full bg-amber-300 inline-block" />{" "}
              Pending
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 rounded-full bg-rose-300 inline-block" />{" "}
              cancelled/Declined
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              className="bg-gold hover:bg-gold/90 text-white rounded-full"
              onClick={() => navigate("/book")}
            >
              Book a Service
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[220px,1fr] gap-4 sm:gap-5 md:gap-6">
          {/* Sidebar */}
          <aside className="md:sticky md:top-20 -mx-3 sm:-mx-4 md:mx-0 px-3 sm:px-4 md:px-0">
            <nav className="rounded-lg md:rounded-2xl border border-plum/15 bg-white overflow-hidden">
              {[
                { key: "dashboard", label: "Dashboard", icon: CalendarDays },
                {
                  key: "appointments",
                  label: "Appointments",
                  icon: CalendarDays,
                },
                { key: "payments", label: "Payments & Deposits", icon: CreditCard },               
                {
                  key: "profile",
                  label: "Profile Settings",
                  icon: UserRound,
                },
                { key: "logout", label: "Log Out", icon: LogOut },
              ].map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    if (item.key === "logout") {
                      setSection("logout");
                    } else {
                      setSection(item.key);
                    }
                  }}
                  className={[
                    "w-full text-left px-3 sm:px-4 py-2 sm:py-3 border-b border-plum/10 flex items-center gap-2 text-sm md:text-base",
                    section === item.key
                      ? "bg-plum/5 font-medium text-plum"
                      : "hover:bg-plum/5 text-plum/80",
                  ].join(" ")}
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </button>
              ))}
            </nav>
          </aside>

          {/* Main content */}
          <section className="min-h-[420px] space-y-6">
            {/* DASHBOARD */}
            {section === "dashboard" && (
              <ClientDashboardHome
                upcomingBookings={upcomingBookings}
                completedBookings={completedBookings}
                allBookings={bookingsWithFriendly}
                onGoToAppointments={() => setSection("appointments")}
                onGoToBook={() => navigate("/book")}
                onGoToContactDetails={() => setSection("profile")}
                onGoToAccountDetails={() => setSection("profile")}
              />
            )}

            {/* APPOINTMENTS */}
            {section === "appointments" && (
              <div className="rounded-lg md:rounded-2xl border border-plum/15 bg-white p-3 sm:p-4 md:p-6">
            <AppointmentsView
              upcomingBookings={upcomingBookings}
              completedBookings={completedBookings}
              loadingUpcoming={loadingBookings}
              loadingCompleted={loadingBookings}
              isRepeatClient={isRepeatClient}
              onUpcomingAction={handleUpcomingAction}
              onReviewBooking={(b) => {
                setActiveBooking(b);
                setShowReview(true);
              }}
              depositAmount={50}
              cancellationWindowHours={cutoffHours}
            />
              </div>
            )}

              {/* PAYMENTS & DEPOSITS */}
              {section === "payments" && (
                <div className="rounded-lg md:rounded-2xl border border-plum/15 bg-white p-3 sm:p-4 md:p-6">
                  <PaymentCenterPage />
                </div>
              )}

            {/* PROFILE SETTINGS */}
            {section === "profile" && (
              <ProfileSettingsPanel
                profile={contactProfile}
                addresses={addresses}
                onSaveContact={handleSaveContact}
                savingContact={savingContact}
                onOpenAddAddress={openAddAddress}
                onOpenEditAddress={openEditAddress}
                onDeleteAddress={deleteAddress}
                onSetDefaultAddress={setDefaultAddress}
                onMoveAddressUp={moveAddressUp}
                onMoveAddressDown={moveAddressDown}
                preferences={preferences}
                onSavePreferences={handleSavePreferences}
                savingPreferences={savingPreferences}
                preferredContactMethod={preferredContactMethod}
                onSavePreferredContactMethod={
                  handleSavePreferredContactMethod
                }
                savingPreferredContactMethod={
                  savingPreferredContactMethod
                }
                email={emailEdit}
                onEmailChange={setEmailEdit}
                onSaveEmail={saveEmail}
                onSendReset={sendReset}
                paymentInfo={PAYMENT_INFO}
                onOpenPaymentCenter={() => setSection("payments")}
              />
            )}

            {/* LOGOUT CONFIRMATION */}
            {section === "logout" && (
              <div className="rounded-lg md:rounded-2xl border border-plum/15 bg-white p-3 sm:p-4 md:p-6">
                <h3 className="text-base sm:text-lg font-semibold text-plum mb-2">
                  Log Out
                </h3>
                <p className="text-xs sm:text-sm text-plum/80 mb-4">
                  You’ll be signed out of your account on this device.
                </p>
                <Button
                  variant="outline"
                  className="text-plum border-plum mr-3"
                  onClick={() => setSection("dashboard")}
                >
                  Cancel
                </Button>
                <Button
                  className="bg-rose-600 text-white"
                  onClick={handleLogout}
                >
                  <LogOut className="w-4 h-4 mr-1" /> Log Out
                </Button>
              </div>
            )}
          </section>
        </div>

        {/* Appointment Details modal */}
        <Modal
          open={showDetails}
          onClose={() => setShowDetails(false)}
          title="Appointment details"
          footer={
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowDetails(false)}
              >
                Close
              </Button>
              {activeBooking && (
                <>
                  {(activeBooking.permissions?.canPayDeposit || activeBooking.permissions?.canPayBalance) && (
                    <Button className="bg-gold text-white" onClick={() => payFor(activeBooking)}>
                      <CreditCard className="w-4 h-4 mr-1" /> {activeBooking.permissions?.canPayDeposit ? "Pay deposit" : "Pay balance"}
                    </Button>
                  )}
                  {activeBooking.permissions?.canReschedule && (
                    <Button variant="outline" onClick={() => navigate(`/book?bookingId=${activeBooking.id}`)}>
                      <Pencil className="w-4 h-4 mr-1" /> Reschedule
                    </Button>
                  )}
                  {activeBooking.permissions?.canCancel && (
                    <Button
                      variant="outline"
                      className="text-rose-600 border-rose-200"
                      onClick={() => {
                        setShowDetails(false);
                        setCancelReason("");
                        setShowCancel(true);
                      }}
                    >
                      <XCircle className="w-4 h-4 mr-1" /> Cancel
                    </Button>
                  )}
                </>
              )}
            </div>
          }
        >
          {activeBooking ? (
            <div className="space-y-2 text-sm">
              <div>
                <b>Order:</b>{" "}
                {activeBooking.invoiceNumber}
              </div>
              <div>
                <b>Service:</b> {activeBooking.service}
              </div>
              <div>
                <b>Date/Time:</b>{" "}
                {formatDateTime(activeBooking.date)} —{" "}
                {formatDateTime(activeBooking.endAt)}
              </div>
              <div>
                <b>Status:</b> {activeBooking.friendly}
              </div>
              <div>
                <b>Total:</b> ${activeBooking.total.toFixed(2)}
              </div>
              <div>
                <b>Paid:</b> ${Number(activeBooking.amountPaid || 0).toFixed(2)} · <b>Balance:</b> ${Number(activeBooking.balanceDue || 0).toFixed(2)}
              </div>
              {activeBooking.depositDue > 0 && (
                <div>
                  <b>Deposit Due:</b>{" "}
                  ${activeBooking.depositDue.toFixed(2)}
                </div>
              )}
              {activeBooking.permissions?.changeBlockedReason && (
                <div className="text-xs text-plum/70 bg-plum/5 rounded p-2">{activeBooking.permissions.changeBlockedReason}</div>
              )}
              <div>
                <b>Frequency:</b> {activeBooking.frequency}
              </div>
              <div>
                <b>Address:</b>{" "}
                {activeBooking.addressLine || "—"}{" "}
                {activeBooking.addressZip &&
                  `(${activeBooking.addressZip})`}
              </div>
              {activeBooking.addons?.length > 0 && (
                <div>
                  <b>Add-ons:</b> {activeBooking.addons.join(", ")}
                </div>
              )}
              {activeBooking.notes && (
                <div className="pt-2">
                  <b>Notes</b>
                  <pre className="mt-1 whitespace-pre-wrap bg-plum/5 p-2 rounded">
                    {activeBooking.notes}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="text-plum/70">No booking selected.</div>
          )}
        </Modal>

        {/* Cancel modal */}
        <Modal
          open={showCancel}
          onClose={() => setShowCancel(false)}
          title="Cancel appointment?"
          footer={
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowCancel(false)}
              >
                Keep
              </Button>
              <Button
                className="bg-rose-600 text-white"
                onClick={confirmCancel}
              >
                <Ban className="w-4 h-4 mr-1" /> Confirm Cancel
              </Button>
            </div>
          }
        >
          <p className="text-sm text-plum/80">
            This cancels your appointment. Deposits are non-refundable per our policy. Are you sure?
          </p>
          <Label htmlFor="cancel-reason" className="mt-3 block text-sm">Reason (optional)</Label>
          <Input id="cancel-reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={500} className="bg-white mt-1" />
        </Modal>

        {/* Review modal */}
        <Modal
          open={showReview}
          onClose={() => setShowReview(false)}
          title="Leave a review"
          footer={
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowReview(false)}
              >
                Cancel
              </Button>
              <Button
                className="bg-gold text-white"
                onClick={submitReview}
              >
                <CheckCircle2 className="w-4 h-4 mr-1" /> Submit
              </Button>
            </div>
          }
        >
          {activeBooking && (
            <div className="space-y-3">
              <div className="text-sm text-plum/80">
                <b>Service:</b> {activeBooking.service} &middot;{" "}
                <b>Date:</b> {formatDate(activeBooking.date)}
              </div>
              <div>
                <Label>Rating</Label>
                <div className="flex items-center gap-2 mt-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setReviewRating(n)}
                      className={`p-2 rounded ${
                        reviewRating >= n
                          ? "text-gold"
                          : "text-plum/30"
                      }`}
                      aria-label={`${n} star${n > 1 ? "s" : ""}`}
                    >
                      <Star className="w-5 h-5 fill-current" />
                    </button>
                  ))}
                </div>
              </div>
              
              <div>
                <Label htmlFor="display-mode">How should we display your name?</Label>
                <div className="mt-2 space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="displayMode"
                      value="anonymous"
                      checked={reviewDisplayMode === "anonymous"}
                      onChange={(e) => setReviewDisplayMode(e.target.value)}
                      className="w-4 h-4 text-gold focus:ring-gold"
                    />
                    <span className="text-sm text-plum">Post as Anonymous</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="displayMode"
                      value="initials"
                      checked={reviewDisplayMode === "initials"}
                      onChange={(e) => setReviewDisplayMode(e.target.value)}
                      className="w-4 h-4 text-gold focus:ring-gold"
                    />
                    <span className="text-sm text-plum">Show my initials only (e.g., J.S.)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="displayMode"
                      value="firstInitialLastName"
                      checked={reviewDisplayMode === "firstInitialLastName"}
                      onChange={(e) => setReviewDisplayMode(e.target.value)}
                      className="w-4 h-4 text-gold focus:ring-gold"
                    />
                    <span className="text-sm text-plum">Show first initial + last name (e.g., J. Santos)</span>
                  </label>
                </div>
                <p className="text-xs text-plum/60 mt-2 italic">
                  Your full name will never be displayed publicly for privacy.
                </p>
              </div>
              
              <div>
                <Label htmlFor="review-text">Your review</Label>
                <textarea
                  id="review-text"
                  rows={5}
                  className="w-full p-3 border rounded mt-1"
                  value={reviewText}
                  onChange={(e) => setReviewText(e.target.value)}
                  placeholder="How did it go?"
                />
                <div className="text-xs text-plum/60 mt-1">
                  {reviewText.length} / 1000
                </div>
              </div>
            </div>
          )}
        </Modal>

        {/* Error modal */}
        <Modal
          open={!!errorMsg}
          onClose={() => setErrorMsg("")}
          title="Error"
          footer={
            <Button
              variant="outline"
              className="border-plum text-plum"
              onClick={() => setErrorMsg("")}
            >
              Close
            </Button>
          }
        >
          <div className="text-plum">{errorMsg}</div>
        </Modal>

        {/* Address Add/Edit modal */}
        <Modal
          open={addrModalOpen}
          onClose={() => {
            setAddrModalOpen(false);
            setAddrEditingId(null);
          }}
          title={addrEditingId ? "Edit Address" : "Add Address"}
          footer={
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  setAddrModalOpen(false);
                  setAddrEditingId(null);
                }}
              >
                Cancel
              </Button>
              <Button className="bg-gold text-white" onClick={saveAddress}>
                <Check className="w-4 h-4 mr-1" /> Save
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <div>
              <Label htmlFor="address-type">Address Type</Label>
              <Select
                value={addrForm.type}
                onValueChange={(v) =>
                  setAddrForm((p) => ({ ...p, type: v }))
                }
              >
                <SelectTrigger id="address-type" className={selectTriggerClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={selectContentClass}>
                  {["home", "business", "other"].map((t) => (
                    <SelectItem key={t} value={t} className={selectItemClass}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="address-street">Street Address</Label>
              <Input
                id="address-street"
                value={addrForm.street}
                onChange={(e) =>
                  setAddrForm((p) => ({ ...p, street: e.target.value }))
                }
                className="bg-white"
                placeholder="123 Main St, Unit 2"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label htmlFor="address-city">City</Label>
                <Input
                  id="address-city"
                  value={addrForm.city}
                  onChange={(e) =>
                    setAddrForm((p) => ({
                      ...p,
                      city: e.target.value,
                    }))
                  }
                  className="bg-white"
                  placeholder="Springfield"
                />
              </div>
              <div>
                <Label htmlFor="address-state">State</Label>
                <Select
                  value={addrForm.state}
                  onValueChange={(v) =>
                    setAddrForm((p) => ({ ...p, state: v }))
                  }
                >
                  <SelectTrigger id="address-state" className={selectTriggerClass}>
                    <SelectValue placeholder="State" />
                  </SelectTrigger>
                  <SelectContent className={selectContentClass}>
                    {US_STATES.map((s) => (
                      <SelectItem
                        key={s}
                        value={s}
                        className={selectItemClass}
                      >
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="address-zip">ZIP</Label>
                <Input
                  id="address-zip"
                  value={addrForm.zip}
                  onChange={(e) =>
                    setAddrForm((p) => ({
                      ...p,
                      zip: e.target.value.replace(/\D/g, ""),
                    }))
                  }
                  className="bg-white"
                  placeholder="12345"
                />
              </div>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}

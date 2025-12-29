// src/pages/ClientPortalPage.jsx
import React, {
  useEffect,
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

// Firebase
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  sendPasswordResetEmail,
  updateEmail,
} from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { normalizeAddress, normalizePhone } from '@/lib/contactModel';
import {
  collection,
  onSnapshot,
  query,
  where,
  addDoc,
  serverTimestamp,
  updateDoc,
  doc,
  orderBy,
  deleteDoc,
  getDocs,
  getDoc,
  limit,
  setDoc,
} from "firebase/firestore";

// Firestore helpers
import { ensureProfile, getAddress } from "@/lib/db";
import { updateProfileContact, updateProfileAddress, upsertProfile } from "@/lib/profileModel";
import { normalizeBookingForRead, normalizeBookingForWrite } from "@/lib/bookings";
import {
  buildUserBookingQueries,
  claimGuestBookings,
  dedupeById,
  DEFAULT_BOOKING_QUERY_LIMIT,
} from "@/lib/bookingsQuery";

// Portal components
import ClientDashboardHome from "@/components/portal/ClientDashboardHome";
import AppointmentsView from "@/components/portal/AppointmentsView";
import ProfileSettingsPanel from "@/components/portal/ProfileSettingsPanel";
import PaymentCenterPage from "@/pages/PaymentCenterPage";

/* -------------------- Config -------------------- */
const PAYMENT_INFO = {
  depositAmount: 50,
  cash: true,
  cashApp: "Sterlingsterls",
  zelle: "401-658-6708, use my name Sterling Sanchez in Zelle",
  notes: "Please include your full name in the payment note.",
};

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

const QUERY_LIMIT = DEFAULT_BOOKING_QUERY_LIMIT;

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
    return d.toLocaleDateString(undefined, {
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
    return d.toLocaleString();
  } catch {
    return "TBD";
  }
}

/* -------------------- Lightweight Dialog -------------------- */
const Modal = ({ open, onClose, title, children, footer }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute inset-0 flex items-start md:items-center justify-center p-3 sm:p-4">
        <div className="w-full max-w-lg bg-white rounded-xl md:rounded-2xl shadow-xl border border-plum/10 relative">
          <button
            className="absolute right-3 sm:right-4 top-3 text-plum/70 hover:text-plum"
            aria-label="Close modal"
            onClick={onClose}
          >
            ×
          </button>
          {title && (
            <div className="px-4 sm:px-5 pt-4 sm:pt-5 text-base sm:text-lg font-semibold text-plum">
              {title}
            </div>
          )}
          <div className="px-4 sm:px-5 py-3 sm:py-4">{children}</div>
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

  /* --------------- Auth UI state --------------- */
  const [authTab, setAuthTab] = useState("login");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");

  /* --------------- Portal state --------------- */
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [bookings, setBookings] = useState([]);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [section, setSection] = useState("dashboard"); // dashboard | appointments | profile | logout
  const [firestoreErrors, setFirestoreErrors] = useState([]); // DEV: track permission/precondition errors

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

  // live listener cleanup
  const unsubsRef = useRef([]);

  /* --------------- Auth listener + data subscriptions --------------- */
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      // cleanup previous listeners
      unsubsRef.current.forEach((u) => {
        try {
          u();
        } catch {}
      });
      unsubsRef.current = [];

      if (!user) {
        setIsLoggedIn(false);
        setBookings([]);
        setAddresses([]);
        setContactProfile({ name: "", phone: "" });
        setEmailEdit("");
        setAuthTab("login");
        setLoadingInitial(false);
        setSection("dashboard");
        return;
      }

      setIsLoggedIn(true);
      setLoadingBookings(true);
      setLoadingInitial(false);

      try {
        // ensure profile exists / merge basics (canonical field: `name`)
        await ensureProfile(user.uid, {
          email: user.email || "",
          phone: user.phoneNumber || "",
          name: user.displayName || signupName || "",
        });

        // read profile
        let profileData = {};
        try {
          const profileSnap = await getDoc(doc(db, "users", user.uid));
          if (profileSnap.exists()) {
            profileData = profileSnap.data() || {};
          }
        } catch (e) {
          console.error("Could not load profile", e);
        }

        const nameFromProfile =
          profileData.name || user.displayName || signupName || "";
        const phoneFromProfile = profileData.phone || user.phoneNumber || "";

        setContactProfile({
          name: nameFromProfile,
          phone: phoneFromProfile,
        });

        setPreferences(profileData.preferences || null);
        setPreferredContactMethod(
          profileData.preferredContactMethod || null
        );

        setEmailEdit(profileData.email || user.email || "");

        // migrate legacy single address -> subcollection
        try {
          const legacy = await getAddress(user.uid);
          if (legacy) {
            const sub = collection(db, "users", user.uid, "addresses");
            const existing = await getDocs(query(sub, limit(1)));
            if (existing.empty) {
              await addDoc(sub, {
                type: "home",
                street: legacy.street || legacy.line1 || "",
                city: legacy.city || "",
                state: legacy.state || "",
                zip: legacy.zip || "",
                isDefault: true,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }
          }
        } catch {}

        const userId = user.uid;
        const emailLower = (user.email || "").toLowerCase();

        const phoneNormalized = normalizePhone(phoneFromProfile);
        const phoneRaw = phoneFromProfile || "";

        await claimGuestBookings(db, {
          uid: userId,
          emailLower,
          phoneNormalized,
          phoneRaw,
          limit: QUERY_LIMIT,
        });

        const sourceCountsRef = { current: {} };

        const mergeBookingsFromSource = (rows, sourceKey) => {
          setBookings((prev) => {
            const merged = dedupeById([...prev, ...rows]);
            if (process.env.NODE_ENV !== "production") {
              if (sourceKey) {
                sourceCountsRef.current[sourceKey] = rows.length;
              }
              const counts = sourceCountsRef.current;
              console.log("[client-portal bookings] source counts", {
                uidDocs: counts.uid || 0,
                emailDocs: counts.email || 0,
                phoneDocs: counts.phone || 0,
                ownerKeyDocs: counts.ownerKey || 0,
                mergedTotal: merged.length,
              });
            }
            return merged;
          });
          setLoadingBookings(false);
        };

        const queries = buildUserBookingQueries(db, {
          uid: userId,
          emailLower,
          phoneNormalized,
          phoneRaw,
          includeOwnerKeys: true,
          clientMode: true, // Client users can only query by userId and ownerKeys
          limit: QUERY_LIMIT,
        });

        if (!queries.length) {
          setLoadingBookings(false);
        }

        queries.forEach(({ source, ref }) => {
          const unsub = onSnapshot(
            ref,
            (snap) => {
              const rows = snap.docs.map((d) => normalizeBookingForRead({ id: d.id, ...d.data() }));
              mergeBookingsFromSource(rows, source);
            },
            (err) => {
              const isPermissionDenied = err?.code === "permission-denied";
              
              if (isPermissionDenied) {
                // Permission-denied should NOT occur with clientMode=true.
                // If it does, log a warning but don't hard-fail the page.
                console.warn(
                  `[client-portal] Permission denied on ${source} query (should not happen with clientMode)`,
                  { queryType: source, code: err?.code, message: err?.message }
                );
              } else {
                // Log other unexpected errors
                console.error(`[client-portal] ${source} query error`, {
                  code: err?.code,
                  message: err?.message,
                  queryType: source,
                });
              }
              
              setLoadingBookings(false);
              
              if (process.env.NODE_ENV !== "production") {
                const errorCode = err?.code || "";
                if (errorCode === "permission-denied" || errorCode === "failed-precondition") {
                  setFirestoreErrors((prev) => [
                    ...prev,
                    { queryType: source, code: errorCode, message: err?.message || String(err) },
                  ]);
                }
              }
            }
          );
          unsubsRef.current.push(unsub);
        });

        // addresses listener
        const uAddr = onSnapshot(
          query(
            collection(db, "users", user.uid, "addresses"),
            orderBy("createdAt", "desc")
          ),
          (snap) => {
            setAddresses(
              snap.docs.map((d) => ({ id: d.id, ...d.data() }))
            );
          },
          (err) => {
            console.error("[client-portal] addresses query error", {
              code: err?.code,
              message: err?.message,
              queryType: "addresses",
            });
          }
        );
        unsubsRef.current.push(uAddr);
      } catch (err) {
        console.error(err);
        setLoadingBookings(false);
        setErrorMsg(err?.message || String(err));
      }
    });

    return () => {
      unsubsRef.current.forEach((u) => {
        try {
          u();
        } catch {}
      });
      unsubsRef.current = [];
      unsubAuth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------- Derived bookings --------------- */
const bookingsWithFriendly = useMemo(() => {
  const mapped = bookings.map((r) => {
    // Normalize core dates
    const date =
      r.startAt ?? r.date ?? r.scheduledAt ?? null;
    const endAt = r.endAt ?? null;
    const createdAt = r.createdAt ?? null;

    // Normalize totals
    const total = Number(
      r.totalAmount ??
        r.payment?.totalAmount ??
        r.total ??
        r.cost ??
        0
    );

    const paid = Number(
      r.amountPaid ??
        r.payment?.amountPaid ??
        r.paid ??
        0
    );

    // Normalize deposit fields (from admin edits OR legacy)
    const depositAmount = Number(
      r.depositAmount ??
        r.payment?.depositAmount ??
        r.depositDue ??
        0
    );

    const depositPaid = Boolean(
      r.depositPaid ??
        r.payment?.depositPaid ??
        r.depositReceived ??
        false
    );

    return {
      id: r.id,
      date,
      endAt,
      total,
      paid,
      rawStatus: r.status || "pending",
      friendly: toFriendlyStatus(r.status, endAt),
      service: r.serviceName || r.serviceSlug || "Residential Cleaning",
      addressLine: r.address?.line1 || r.address?.street || "",
      addressZip: r.address?.zip || "",
      notes: r.notes || "",
      frequency: r.frequency || "one-time",
      addons: Array.isArray(r.addons) ? r.addons : [],
      createdAt,

      // NEW: deposit-aware fields
      depositAmount,
      depositPaid,

      // Keep legacy-style fields so existing UI keeps working:
      // - if deposit is paid, depositDue becomes 0 so "Deposit due" text disappears
      depositDue: depositAmount && !depositPaid ? depositAmount : 0,
      depositReceived: depositPaid,

      // Optional but useful: attach a payment object mirroring AdminPayments
      payment: {
        ...(r.payment || {}),
        totalAmount: total,
        amountPaid: paid,
        depositAmount,
        depositPaid,
      },
    };
  });

  return mapped.sort((a, b) => {
    const aTime =
      a.date?.toMillis?.() ??
      (a.date ? new Date(a.date).getTime() : -Infinity);
    const bTime =
      b.date?.toMillis?.() ??
      (b.date ? new Date(b.date).getTime() : -Infinity);
    const aCreated =
      a.createdAt?.toMillis?.() ??
      (a.createdAt ? new Date(a.createdAt).getTime() : -Infinity);
    const bCreated =
      b.createdAt?.toMillis?.() ??
      (b.createdAt ? new Date(b.createdAt).getTime() : -Infinity);
    const aScore = Number.isFinite(aTime) ? aTime : aCreated;
    const bScore = Number.isFinite(bTime) ? bTime : bCreated;
    return bScore - aScore;
  });
}, [bookings]);

  const now = new Date();

  const upcomingBookings = useMemo(() => {
    return bookingsWithFriendly.filter((b) => {
      const end = b.endAt?.toDate
        ? b.endAt.toDate()
        : b.endAt
        ? new Date(b.endAt)
        : null;
      const start = b.date?.toDate
        ? b.date.toDate()
        : b.date
        ? new Date(b.date)
        : null;
      const status = (b.rawStatus || "").toLowerCase();

      const isInactive = [
        "cancelled",
        "declined",
        "refunded",
        "expired",
        "completed",
      ].includes(status);
      if (end && end >= now && !isInactive) return true;
      if (start && start >= now && !isInactive) return true;
      if (
        !start &&
        !end &&
        ["pending", "confirmed", "scheduled"].includes(status)
      )
        return true;
      return false;
    });
  }, [bookingsWithFriendly]);

  const completedBookings = useMemo(() => {
    return bookingsWithFriendly.filter((b) => {
      const end = b.endAt?.toDate
        ? b.endAt.toDate()
        : b.endAt
        ? new Date(b.endAt)
        : null;
      const status = (b.rawStatus || "").toLowerCase();
      if (end && end < now) return true;
      if (
        [
          "completed",
          "cancelled",
          "declined",
          "refunded",
          "expired",
        ].includes(status)
      )
        return true;
      return false;
    });
  }, [bookingsWithFriendly]);

  const isRepeatClient =
    completedBookings && completedBookings.length > 0;

  const displayName =
    auth.currentUser?.displayName ||
    auth.currentUser?.email ||
    auth.currentUser?.phoneNumber ||
    "client";

  /* --------------- Actions --------------- */
  const { toast: showToast } = useToast();

  const handleLogin = async (e) => {
    e?.preventDefault?.();
    try {
      await signInWithEmailAndPassword(
        auth,
        loginEmail.trim(),
        loginPassword
      );
      showToast({ title: "Signed in" });
      setSection("dashboard");
    } catch (err) {
      showToast({
        title: "Login failed",
        description: err?.message || String(err),
        variant: "destructive",
      });
    }
  };

  const handleSignUp = async (e) => {
    e?.preventDefault?.();
    try {
      const cred = await createUserWithEmailAndPassword(
        auth,
        signupEmail.trim(),
        signupPassword
      );
      if (signupName.trim()) {
        try {
          await updateProfile(cred.user, {
            displayName: signupName.trim(),
          });
        } catch {}
      }
      await ensureProfile(cred.user.uid, {
        email: cred.user.email || signupEmail.trim(),
        phone: cred.user.phoneNumber || "",
        name: signupName.trim(),
      });
      showToast({
        title: "Account created",
        description: "You are now signed in.",
      });
      setSection("dashboard");
    } catch (err) {
      showToast({
        title: "Sign up failed",
        description: err?.message || String(err),
        variant: "destructive",
      });
    }
  };

  const handleLogout = async () => {
    unsubsRef.current.forEach((u) => {
      try {
        u();
      } catch {}
    });
    unsubsRef.current = [];
    await signOut(auth);
    showToast({ title: "Logged out" });
    setAuthTab("login");
    setSection("dashboard");
  };

  const saveEmail = async () => {
    const u = auth.currentUser;
    if (!u) return;
    try {
      const newEmail = (emailEdit || "").trim();
      await updateEmail(u, newEmail);
      await ensureProfile(u.uid, { email: newEmail });
      showToast({ title: "Email updated" });
    } catch (err) {
      showToast({
        title: "Could not update email",
        description: String(err?.message || err),
        variant: "destructive",
      });
    }
  };

  const handleSaveContact = async (payload) => {
    const u = auth.currentUser;
    if (!u) return;

    console.log("[handleSaveContact] called with payload:", payload);

    setSavingContact(true);
    try {
      const trimmedName = (payload.name || payload.fullName || payload.fullname || payload.fullname || "" ).trim();
      const trimmedPhone = (payload.phone || payload.phoneNumber || payload.primaryPhone || "").trim();

      if (trimmedName && trimmedName !== (u.displayName || "")) {
        await updateProfile(u, { displayName: trimmedName });
      }

      // Upsert canonical profile contact fields
      await updateProfileContact(u.uid, { name: trimmedName, phone: trimmedPhone, email: u.email });

      // If the caller passed an address (ProfileSettingsPanel auto-sync), persist it too
      if (payload.address || payload.addressSummary) {
        const addr = payload.address || { line1: payload.addressSummary || "" };
        await updateProfileAddress(u.uid, addr);
      }

      setContactProfile({
        name: trimmedName,
        phone: trimmedPhone,
      });

      showToast({ title: "Contact details saved" });
    } catch (err) {
      showToast({
        title: "Could not save contact",
        description: String(err?.message || err),
        variant: "destructive",
      });
      throw err;
    } finally {
      setSavingContact(false);
    }
  };

  const sendReset = async () => {
    const target = (emailEdit || auth.currentUser?.email || "").trim();
    if (!target) {
      showToast({
        title: "Missing email",
        description: "Please enter a valid email first.",
        variant: "destructive",
      });
      return;
    }
    try {
      await sendPasswordResetEmail(auth, target);
      showToast({
        title: "Password reset sent",
        description: `Check ${target} for the reset link.`,
      });
    } catch (err) {
      showToast({
        title: "Could not send reset",
        description: String(err?.message || err),
        variant: "destructive",
      });
    }
  };

  // central handler for UpcomingBookings actions (via AppointmentsView)
  const handleUpcomingAction = ({ type, booking }) => {
    switch (type) {
      case "view":
        setActiveBooking(booking);
        setShowDetails(true);
        break;
      case "reschedule":
        navigate(`/book?bookingId=${booking.id}`);
        break;
      case "cancel":
        setActiveBooking(booking);
        setShowCancel(true);
        break;
      case "book-new":
        navigate("/book");
        break;
      default:
        break;
    }
  };

  // Address helpers
  const resetAddrForm = () =>
    setAddrForm({ type: "home", street: "", city: "", state: "", zip: "" });

  const openAddAddress = () => {
    setAddrEditingId(null);
    resetAddrForm();
    setAddrModalOpen(true);
  };

  const openEditAddress = (row) => {
    setAddrEditingId(row.id);
    setAddrForm({
      type: row.type || "other",
      street: row.street || "",
      city: row.city || "",
      state: row.state || "",
      zip: row.zip || "",
    });
    setAddrModalOpen(true);
  };

  const saveAddress = async () => {
    const u = auth.currentUser;
    if (!u) return;
    const raw = {
      type: addrForm.type || "other",
      line1: (addrForm.street || "").trim(),
      city: (addrForm.city || "").trim(),
      state: (addrForm.state || "").trim(),
      zip: (addrForm.zip || "").trim(),
    };
    const norm = normalizeAddress(raw);
    const clean = { ...norm, updatedAt: serverTimestamp() };
    if (!clean.line1 || !clean.city || !clean.state || !clean.zip) {
      showToast({
        title: "Missing fields",
        description: "Please complete all address fields.",
        variant: "destructive",
      });
      return;
    }
    const sub = collection(db, "users", u.uid, "addresses");
    try {
      if (addrEditingId) {
        await updateDoc(doc(sub, addrEditingId), clean);
        showToast({ title: "Address updated" });
      } else {
        await addDoc(sub, {
          ...clean,
          isDefault: addresses.length === 0,
          createdAt: serverTimestamp(),
        });
        showToast({ title: "Address added" });
      }
      setAddrModalOpen(false);
      setAddrEditingId(null);
      resetAddrForm();
    } catch (e) {
      showToast({
        title: "Could not save address",
        description: String(e?.message || e),
        variant: "destructive",
      });
    }
  };

  const deleteAddress = async (row) => {
    const u = auth.currentUser;
    if (!u) return;
    try {
      await deleteDoc(doc(db, "users", u.uid, "addresses", row.id));
      showToast({ title: "Address removed" });
    } catch (e) {
      showToast({
        title: "Could not remove address",
        description: String(e?.message || e),
        variant: "destructive",
      });
    }
  };

  const setDefaultAddress = async (row) => {
    const u = auth.currentUser;
    if (!u) return;
    const sub = collection(db, "users", u.uid, "addresses");
    try {
      const snapshot = await getDocs(sub);
      const batchUpdates = snapshot.docs
        .map((d) =>
          updateDoc(doc(sub, d.id), { isDefault: d.id === row.id })
        );
      await Promise.all(batchUpdates);
      showToast({ title: "Default address set" });
    } catch (e) {
      showToast({
        title: "Could not set default",
        description: String(e?.message || e),
        variant: "destructive",
      });
    }
  };

  const moveAddressUp = async (row) => {
    const u = auth.currentUser;
    if (!u) return;
    const idx = addresses.findIndex((a) => a.id === row.id);
    if (idx <= 0) return;

    const newOrder = [...addresses];
    [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];

    try {
      const sub = collection(db, "users", u.uid, "addresses");
      const updates = newOrder
        .map((a, i) => {
          const desired = i;
          if ((a.sortOrder ?? null) === desired) return null;
          return updateDoc(doc(sub, a.id), {
            sortOrder: desired,
            updatedAt: serverTimestamp(),
          });
        })
        .filter(Boolean);
      await Promise.all(updates);
      toast({ title: "Address order updated" });
    } catch (err) {
      toast({
        title: "Could not reorder",
        description: String(err?.message || err),
        variant: "destructive",
      });
    }
  };

  const moveAddressDown = async (row) => {
    const u = auth.currentUser;
    if (!u) return;
    const idx = addresses.findIndex((a) => a.id === row.id);
    if (idx === -1 || idx >= addresses.length - 1) return;

    const newOrder = [...addresses];
    [newOrder[idx], newOrder[idx + 1]] = [
      newOrder[idx + 1],
      newOrder[idx],
    ];

    try {
      const sub = collection(db, "users", u.uid, "addresses");
      const updates = newOrder
        .map((a, i) => {
          const desired = i;
          if ((a.sortOrder ?? null) === desired) return null;
          return updateDoc(doc(sub, a.id), {
            sortOrder: desired,
            updatedAt: serverTimestamp(),
          });
        })
        .filter(Boolean);
      await Promise.all(updates);
      toast({ title: "Address order updated" });
    } catch (err) {
      toast({
        title: "Could not reorder",
        description: String(err?.message || err),
        variant: "destructive",
      });
    }
  };

  /* ---------------- Preferences persistence ---------------- */
  const handleSavePreferences = async (prefs) => {
    const u = auth.currentUser;
    if (!u) return;
    setSavingPreferences(true);

    try {
      const userRef = doc(db, "users", u.uid);

      await setDoc(
        userRef,
        {
          preferences: prefs || null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setPreferences(prefs || null);
      toast({ title: "Preferences saved" });
    } catch (err) {
      toast({
        title: "Could not save preferences",
        description: String(err?.message || err),
        variant: "destructive",
      });
    } finally {
      setSavingPreferences(false);
    }
  };

  const handleSavePreferredContactMethod = async (method) => {
    const u = auth.currentUser;
    if (!u) return;
    setSavingPreferredContactMethod(true);

    try {
      const userRef = doc(db, "users", u.uid);

      await setDoc(
        userRef,
        {
          preferredContactMethod: method || null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // Also save to profiles collection so admins can see it
      await upsertProfile(u.uid, {
        preferredContactMethod: method || null,
      });

      setPreferredContactMethod(method || null);
      toast({ title: "Contact method saved" });
    } catch (err) {
      toast({
        title: "Could not save contact method",
        description: String(err?.message || err),
        variant: "destructive",
      });
    } finally {
      setSavingPreferredContactMethod(false);
    }
  };

  /* -------------------- Render (Auth) -------------------- */
  // While auth is initializing, show a loader (not the login form yet)
  if (loadingInitial) {
    return (
      <div className="relative min-h-[90vh] flex items-center justify-center px-3 sm:px-4 py-12 sm:py-16 md:py-20 bg-[#FADADD]">
        <div className="w-full max-w-md">
          <motion.div
            className="relative z-10 w-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
          >
            <div className="text-center">
              <div className="inline-block mb-4">
                <div className="w-12 h-12 border-4 border-plum/20 border-t-plum rounded-full animate-spin" />
              </div>
              <p className="text-plum/70 text-sm">Loading your account...</p>
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="relative min-h-[90vh] flex items-center justify-center px-3 sm:px-4 py-12 sm:py-16 md:py-20 bg-[#FADADD]">
        <div className="w-full max-w-md">
          <motion.div
            className="relative z-10 w-full"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="text-center mb-6">
              <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-plum">
                Log in or Create your account
              </h1>
              <p className="text-plum/80 mt-1">
                <span className="font-medium">Returning customers:</span> Sign
                in.&nbsp;
                <span className="font-medium">New customers:</span> Create your
                account to book.
              </p>
            </div>

            <Tabs
              value={authTab}
              onValueChange={setAuthTab}
              className="w-full"
            >
              <TabsList className="grid w-full grid-cols-2 rounded-full bg-white p-1">
                <TabsTrigger
                  value="login"
                  className="rounded-full data-[state=active]:bg-white data-[state=active]:shadow"
                >
                  Sign In
                </TabsTrigger>
                <TabsTrigger
                  value="signup"
                  className="rounded-full data-[state=active]:bg-white data-[state=active]:shadow"
                >
                  Create Account
                </TabsTrigger>
              </TabsList>

              <TabsContent value="login">
                <div className="shadow-md border-plum/10 bg-white rounded-xl">
                  <form onSubmit={handleLogin} className="p-6 space-y-4">
                    <div>
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        required
                        className="bg-white"
                        autoComplete="email"
                      />
                    </div>
                    <div>
                      <Label htmlFor="password">Password</Label>
                      <Input
                        id="password"
                        type="password"
                        placeholder="••••••••"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        required
                        className="bg-white"
                        autoComplete="current-password"
                      />
                    </div>
                    <Button
                      type="submit"
                      className="w-full bg-gold hover:bg-gold/90 text-white rounded-full"
                    >
                      Sign In
                    </Button>
                  </form>
                </div>
              </TabsContent>

              <TabsContent value="signup">
                <div className="shadow-md border-plum/10 bg-white rounded-xl p-6 space-y-4">
                  <form onSubmit={handleSignUp} className="space-y-4">
                    <div>
                      <Label htmlFor="signup-name">Full Name</Label>
                      <Input
                        id="signup-name"
                        placeholder="John Doe"
                        value={signupName}
                        onChange={(e) => setSignupName(e.target.value)}
                        required
                        className="bg-white"
                        autoComplete="name"
                      />
                    </div>
                    <div>
                      <Label htmlFor="signup-email">Email</Label>
                      <Input
                        id="signup-email"
                        type="email"
                        placeholder="you@example.com"
                        value={signupEmail}
                        onChange={(e) => setSignupEmail(e.target.value)}
                        required
                        className="bg-white"
                        autoComplete="email"
                      />
                    </div>
                    <div>
                      <Label htmlFor="signup-password">Password</Label>
                      <Input
                        id="signup-password"
                        type="password"
                        placeholder="Create a password"
                        value={signupPassword}
                        onChange={(e) => setSignupPassword(e.target.value)}
                        required
                        className="bg-white"
                        autoComplete="new-password"
                      />
                    </div>
                    <Button
                      type="submit"
                      className="w-full bg-gold hover:bg-gold/90 text-white rounded-full"
                    >
                      Create Account
                    </Button>
                  </form>
                </div>
              </TabsContent>
            </Tabs>
          </motion.div>
        </div>
      </div>
    );
  }

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

        {/* DEV: Firestore error banner */}
        {process.env.NODE_ENV !== "production" && firestoreErrors.length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded-lg text-sm text-amber-900">
            <div className="font-semibold mb-1">⚠️ Firestore Query Errors (DEV only)</div>
            {firestoreErrors.map((e, i) => (
              <div key={i} className="ml-4 text-xs">
                • <strong>{e.queryType}</strong>: {e.code} - {e.message}
              </div>
            ))}
          </div>
        )}

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
              cancellationWindowHours={48}
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
                  <Button
                    variant="outline"
                    onClick={() =>
                      navigate(`/book?bookingId=${activeBooking.id}`)
                    }
                  >
                    <Pencil className="w-4 h-4 mr-1" /> Reschedule
                  </Button>
                  <Button
                    variant="outline"
                    className="text-rose-600 border-rose-200"
                    onClick={() => {
                      setShowDetails(false);
                      setShowCancel(true);
                    }}
                  >
                    <XCircle className="w-4 h-4 mr-1" /> Cancel
                  </Button>
                </>
              )}
            </div>
          }
        >
          {activeBooking ? (
            <div className="space-y-2 text-sm">
              <div>
                <b>Order:</b>{" "}
                {`CI-${activeBooking.id.slice(0, 5).toUpperCase()}`}
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
              {activeBooking.depositDue > 0 && (
                <div>
                  <b>Deposit Due:</b>{" "}
                  ${activeBooking.depositDue.toFixed(2)}
                </div>
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
                onClick={async () => {
                  try {
                    await updateDoc(
                      doc(db, "bookings", activeBooking.id),
                      {
                        status: "cancelled",
                        updatedAt: serverTimestamp(),
                      }
                    );
                    toast({ title: "Booking cancelled" });
                  } catch (e) {
                    toast({
                      title: "Could not cancel",
                      description: String(e?.message || e),
                      variant: "destructive",
                    });
                  } finally {
                    setShowCancel(false);
                  }
                }}
              >
                <Ban className="w-4 h-4 mr-1" /> Confirm Cancel
              </Button>
            </div>
          }
        >
          <p className="text-sm text-plum/80">
            This will mark the booking as cancelled. Deposit policy may
            apply. Are you sure?
          </p>
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
                onClick={async () => {
                  const u = auth.currentUser;
                  const email = u?.email || null;

                  if (!reviewText || reviewText.trim().length < 5) {
                    toast({
                      title: "Please enter a longer review",
                      variant: "destructive",
                    });
                    return;
                  }

                  if (!activeBooking?.id) {
                    toast({
                      title: "No booking selected",
                      variant: "destructive",
                    });
                    return;
                  }

                  const ratingValue = Number(reviewRating) || 5;

                  // Compute safe reviewDisplayName based on displayMode
                  let reviewDisplayName = "Anonymous";
                  const rawName = contactProfile?.name || u?.reviewDisplayName || "";
                  
                  if (reviewDisplayMode === "anonymous") {
                    reviewDisplayName = "Anonymous";
                  } else if (reviewDisplayMode === "initials") {
                    // Extract initials from name
                    const parts = rawName.trim().split(/\s+/);
                    if (parts.length >= 2) {
                      reviewDisplayName = `${parts[0].charAt(0).toUpperCase()}.${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
                    } else if (parts.length === 1 && parts[0]) {
                      reviewDisplayName = `${parts[0].charAt(0).toUpperCase()}.`;
                    } else {
                      reviewDisplayName = "Anonymous";
                    }
                  } else if (reviewDisplayMode === "firstInitialLastName") {
                    // First initial + last name
                    const parts = rawName.trim().split(/\s+/);
                    if (parts.length >= 2) {
                      reviewDisplayName = `${parts[0].charAt(0).toUpperCase()}. ${parts[parts.length - 1]}`;
                    } else if (parts.length === 1 && parts[0]) {
                      reviewDisplayName = parts[0];
                    } else {
                      displayName = "Anonymous";
                    }
                  }

                  try {
                    // 1) Create review document with new schema
                    const reviewRef = await addDoc(collection(db, "reviews"), {
                      clientId: u?.uid || null,
                      bookingId: activeBooking.id,
                      serviceName: activeBooking.service || null,
                      displayMode: reviewDisplayMode,
                      displayName,
                      rating: ratingValue,
                      comment: reviewText.trim(),
                      body: reviewText.trim(), // keep for backward compat
                      source: "client-portal",
                      status: "pending",
                      createdAt: serverTimestamp(),
                    });

                    // 2) Update the booking with review metadata so PastBookings can see it
                    const reviewUpdate = {
                      reviewRating: ratingValue,
                      reviewId: reviewRef.id,
                      reviewLeftAt: serverTimestamp(),
                    };
                    const normalizedReviewUpdate = normalizeBookingForWrite(reviewUpdate);
                    await updateDoc(doc(db, "bookings", activeBooking.id), normalizedReviewUpdate);

                    // 3) Optimistically update local state so UI reflects it immediately
                    setBookings((prev) =>
                      prev.map((b) =>
                        b.id === activeBooking.id ? { ...b, reviewRating: ratingValue } : b
                      )
                    );

                    toast({
                      title: "Thanks for your feedback",
                      description: "Your review is pending approval.",
                    });

                    setShowReview(false);
                    setReviewText("");
                    setReviewRating(5);
                    setReviewDisplayMode("initials");
                  } catch (err) {
                    toast({
                      title: "Could not submit review",
                      description: String(err?.message || err),
                      variant: "destructive",
                    });
                  }
                }}
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
              <Label>Address Type</Label>
              <Select
                value={addrForm.type}
                onValueChange={(v) =>
                  setAddrForm((p) => ({ ...p, type: v }))
                }
              >
                <SelectTrigger className={selectTriggerClass}>
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
              <Label>Street Address</Label>
              <Input
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
                <Label>City</Label>
                <Input
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
                <Label>State</Label>
                <Select
                  value={addrForm.state}
                  onValueChange={(v) =>
                    setAddrForm((p) => ({ ...p, state: v }))
                  }
                >
                  <SelectTrigger className={selectTriggerClass}>
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
                <Label>ZIP</Label>
                <Input
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

// src/pages/BookingPage.jsx
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Calendar } from '@/components/ui/calendar';
import { useToast } from '@/components/ui/use-toast';
import { Home, Sparkles, Truck, Building, Clock, ChevronRight, Tag, Info, AlertCircle, Loader2 } from 'lucide-react';
import { format, isSunday } from 'date-fns';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// 🔥 Firestore
import { db, auth } from '@/lib/firebase';
import { updateProfileAddressFromServiceAddress } from '@/lib/profileModel';
import { normalizePhone, stripUndefinedDeep } from '@/lib/contactModel';
import { normalizeBookingForWrite } from '@/lib/bookings';
import { buildAdminAllowlist } from '@/lib/adminAllowlist';
import { getProfile, getAddress } from '@/lib/db';
import {
  // addDoc,
  collection,
  serverTimestamp,
  Timestamp,
  query,
  where,
  onSnapshot,
  getDocs,
  doc,
  getDoc,
  updateDoc,
} from 'firebase/firestore';
import { createBookingWithConflictCheck, hasOverlap, checkConflictsTransactional, getDayAvailability } from '@/lib/db';

// ----- Env capacity knobs -----
const SLOT_CAPACITY = Number(import.meta.env.VITE_SLOT_CAPACITY || 1);
const DAILY_CAPACITY = Number(import.meta.env.VITE_DAILY_CAPACITY || 6);

// ----- Constants -----
const services = [
  { id: 'residential-cleaning', name: 'Residential Cleaning', icon: Home },
  { id: 'deep-clean', name: 'Deep Clean', icon: Sparkles },
  { id: 'move-in-move-out', name: 'Move-In/Move-Out', icon: Truck },
  { id: 'office-cleaning', name: 'Office Cleaning', icon: Building },
];

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
];

const addons = [
  { id: 'fridge', name: 'Inside Fridge', price: 20 },
  { id: 'oven', name: 'Inside Oven', price: 20 },
  { id: 'windows', name: 'Interior Windows', price: 30 },
  { id: 'baseboards', name: 'Baseboards', price: 25 },
  { id: 'laundry', name: 'Laundry Fold', price: 15 },
  { id: 'garage', name: 'Garage Sweep', price: 20 },
  { id: 'carpet', name: 'Carpet Shampoo', price: 40 },
];

const frequencies = [
  { id: 'one-time', name: 'One-time', discount: 0 },
  { id: 'weekly', name: 'Weekly', discount: 0.15 },
  { id: 'biweekly', name: 'Biweekly', discount: 0.1 },
  { id: 'monthly', name: 'Monthly', discount: 0.05 },
];

// Fixed start-time options (12h display)
const TIME_OPTIONS = ['09:00 AM', '11:00 AM', '01:00 PM', '03:00 PM'];

// Operating hours (Sun closed; shorter Sat)
const OPERATING_RULES = {
  SUN_CLOSED: true,
  SAT_LATEST: '01:00 PM',
};

// ===== Solid, readable Select styles =====
const selectTriggerClass =
  'bg-white text-plum border border-plum/30 rounded-md ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 focus:border-gold/60';
const selectContentClass = 'bg-white border border-plum/20 text-plum shadow-xl';
const selectItemClass = 'focus:bg-gold/10 focus:text-plum cursor-pointer';

// ----- Utils -----
// Shared helper: 24h Date -> "hh:mm AM/PM"
function timeOptionFromDate(dateObj) {
  if (!dateObj) return '';
  const h24 = dateObj.getHours();
  const m = dateObj.getMinutes();
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;
  const hh = String(h12).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm} ${ampm}`;
}

function parseTime12hToHoursMinutes(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return { h, min };
}
function combineDateAndTime(dateObj, timeStr) {
  if (!dateObj || !timeStr) return null;
  const t = parseTime12hToHoursMinutes(timeStr);
  if (!t) return null;
  const d = new Date(dateObj);
  d.setHours(t.h, t.min, 0, 0);
  return d;
}
function getTimeOptionsForDate(date) {
  if (!date) return TIME_OPTIONS;
  if (OPERATING_RULES.SUN_CLOSED && isSunday(date)) return [];
  const dow = date.getDay(); // 0 Sun, 6 Sat
  if (dow === 6 && OPERATING_RULES.SAT_LATEST) {
    return TIME_OPTIONS.filter((t) => {
      const cutoff = parseTime12hToHoursMinutes(OPERATING_RULES.SAT_LATEST);
      const curr = parseTime12hToHoursMinutes(t);
      if (!cutoff || !curr) return true;
      if (curr.h < cutoff.h) return true;
      if (curr.h === cutoff.h) return curr.min <= cutoff.min;
      return false;
    });
  }
  return TIME_OPTIONS;
}

// --- conflict helpers (same-day preflight) ---
const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
async function checkIsRepeatClient(dbRef, { uid, emailLower }) {
  // Only query if we have a UID (authenticated user)
  // Firestore rules restrict reads by email to the authenticated user's email,
  // so we cannot safely query by form email without authentication
  if (!uid) {
    console.debug('[checkIsRepeatClient] No UID provided, treating as new client');
    return false;
  }

  const colRef = collection(dbRef, 'bookings');
  const q = query(
    colRef,
    where('userId', '==', uid),
    where('status', 'in', ['completed', 'confirmed'])
  );

  try {
    const snap = await getDocs(q);
    const now = new Date();
    let priorCount = 0;

    snap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const endAt = data.endAt?.toDate
        ? data.endAt.toDate()
        : data.endAt
        ? new Date(data.endAt)
        : null;

      if (endAt && endAt <= now) {
        priorCount += 1;
      }
    });

    return priorCount > 0;
  } catch (e) {
    console.warn('[checkIsRepeatClient] Query failed, treating as new client:', e);
    return false;
  }
}

const STORAGE_KEY = 'booking_form_v1';

const BookingPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const bookingId = searchParams.get('bookingId');
  const [isEditing, setIsEditing] = useState(Boolean(bookingId));
  const [loadedBooking, setLoadedBooking] = useState(null);

  // Saved addresses for dropdown
  const [addressOptions, setAddressOptions] = useState([]);
  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [loadingAddresses, setLoadingAddresses] = useState(false);

  // Profile/address prefill
  const [profileData, setProfileData] = useState(null);
  const [addressData, setAddressData] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);

  const [form, setForm] = useState(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    const base = saved ? JSON.parse(saved) : {};
    return {
      service: base.service || 'residential-cleaning',
      propertyType: base.propertyType || 'house',
      sqft: base.sqft ?? 1500,
      bedrooms: base.bedrooms ?? 2,
      bathrooms: base.bathrooms ?? 1,
      sizeMode: base.sizeMode || 'bed-bath',
      condition: base.condition || 'standard',
      pets: base.pets || 'no',
      addons: base.addons || [],
      frequency: base.frequency || 'one-time',
      date: base.date ? new Date(base.date) : null,
      time: base.time || '',
      firstName: base.firstName || '',
      lastName: base.lastName || '',
      email: base.email || '',
      phone: base.phone || '',
      street: base.street || base.address || '',
      city: base.city || '',
      state: base.state || '',
      zip: base.zip || '',
      // Separate notes:
      accessNotes: base.accessNotes || base.notes || '',
      cleanerNotes: base.cleanerNotes || '',
      // Recurrence
      recurrence: base.recurrence || 'none',
      promoCode: base.promoCode || '',
      agreePolicy: base.agreePolicy || false,
    };
  });

  const [estimate, setEstimate] = useState({
    base: 0,
    sizeCost: 0,
    conditionCost: 0,
    petsCost: 0,
    addonsCost: 0,
    subtotal: 0,
    discount: 0,
    promoDiscount: 0,
    total: 0,
    duration: 0,
  });

  const [promoApplied, setPromoApplied] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Server-side day availability (no booking details, only aggregated counts/blockedSlots)
  const [dayAvailability, setDayAvailability] = useState({
    dateKey: null,
    fullyBooked: false,
    blockedSlots: [],
    slotCounts: {},
    dayCountBlocking: 0,
  });
  const [loadingDay, setLoadingDay] = useState(false);

  // Validation state
  const [errors, setErrors] = useState({});
  const estimateLiveRef = useRef(null);

  // Current user from Firebase Auth
  const currentUser = auth.currentUser;

  // Load booking for reschedule/edit
  useEffect(() => {
    let didCancel = false;
    async function load() {
      if (!bookingId) return;
      try {
        const snap = await getDoc(doc(db, 'bookings', bookingId));
        if (!snap.exists()) {
          toast({ variant: 'destructive', title: 'Booking not found' });
          setIsEditing(false);
          return;
        }
        const data = snap.data();
        setLoadedBooking({ id: snap.id, ...data });

        // Basic ownership check for UX (security is enforced by rules)
        const u = auth.currentUser;
        const uEmail = (u?.email || '').toLowerCase();
        const owns =
          (u && data.userId === u.uid) ||
          (uEmail && data?.contact?.emailLower === uEmail) ||
          (Array.isArray(data?.ownerKeys) && data.ownerKeys.includes(`uid:${u?.uid}`));

        if (!owns) {
          toast({
            variant: 'destructive',
            title: 'You do not have access to edit this booking.',
          });
          setIsEditing(false);
          return;
        }

        // Prefill form from booking
        const sAt = data.startAt?.toDate ? data.startAt.toDate() : null;
        const timeStr = sAt ? timeOptionFromDate(sAt) : '';

        const prefill = {
          service: data.serviceSlug || 'residential-cleaning',
          propertyType: data.propertyType || 'house',
          sqft: data.sqft ?? 1500,
          bedrooms: data.bedrooms ?? 2,
          bathrooms: data.bathrooms ?? 1,
          condition: data.condition || 'standard',
          pets: data.pets ? 'yes' : 'no',
          addons: Array.isArray(data.addons) ? data.addons : [],
          frequency: data.frequency || 'one-time',
          date: sAt ? new Date(sAt) : null,
          time: timeStr,
          firstName: data?.contact?.firstName || '',
          lastName: data?.contact?.lastName || '',
          email: data?.contact?.email || '',
          phone: data?.contact?.phone || '',
          street: data?.address?.line1 || '',
          city: data?.address?.city || '',
          state: data?.address?.state || '',
          zip: data?.address?.zip || '',
          accessNotes: data?.accessNotes || data?.notes || '',
          cleanerNotes: data?.cleanerNotes || '',
          recurrence: data?.recurrence || 'none',
          promoCode: data?.promoCode || '',
          agreePolicy: true, // already agreed once; keep true so edits don't block
        };
        if (!didCancel) setForm(prefill);
      } catch (e) {
        console.error(e);
        toast({
          variant: 'destructive',
          title: 'Could not load booking',
          description: String(e?.message || e),
        });
        setIsEditing(false);
      }
    }
    load();
    return () => {
      didCancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  // Load saved addresses for dropdown (new bookings only)
  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    if (isEditing) return; // don't override address when editing an existing booking

    async function loadAddresses() {
      try {
        setLoadingAddresses(true);
        const addrCol = collection(db, 'users', u.uid, 'addresses');
        const snap = await getDocs(addrCol);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!rows.length) {
          setAddressOptions([]);
          return;
        }
        // sort by sortOrder if present
        rows.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        setAddressOptions(rows);

        let def = rows.find((a) => a.isDefault);
        if (!def) def = rows[0];

        if (def) {
          setSelectedAddressId(def.id);
          setForm((prev) => ({
            ...prev,
            street: def.street || '',
            city: def.city || '',
            state: def.state || '',
            zip: def.zip || '',
          }));
        }
      } catch (err) {
        console.warn('Failed to load saved addresses', err);
      } finally {
        setLoadingAddresses(false);
      }
    }

    loadAddresses();
  }, [isEditing]);

  // PREFILL from profile + address documents (keep initial defaults on first render)
  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    if (isEditing) return; // don't override when editing an existing booking

    let cancelled = false;
    async function loadProfileAndAddress() {
      try {
        setLoadingProfile(true);
        const p = await getProfile(u.uid);
        const a = await getAddress(u.uid);
        if (cancelled) return;
        setProfileData(p || null);
        setAddressData(a || null);

        // Build name parts safely
  // Prefer canonical `name`; legacy `fullName` removed after migration.
  const nameSource = (p && (p.name || p.firstName || '')) || '';
        const parts = String(nameSource || '').trim().split(/\s+/).filter(Boolean);
        const firstName = parts.length ? parts.shift() : '';
        const lastName = parts.length ? parts.join(' ') : '';

        // Only fill fields that are currently empty (preserve any user-typed values)
        setForm((prev) => {
          const pick = (prevVal, newVal) => {
            if (prevVal !== undefined && prevVal !== null && String(prevVal).trim() !== '') return prevVal;
            return newVal || '';
          };

          return {
            ...prev,
            firstName: pick(prev.firstName, firstName),
            lastName: pick(prev.lastName, lastName),
            email: pick(prev.email, (p && (p.email || p.emailLower || p.contact?.email))),
            phone: pick(prev.phone, (p && (p.phone || p.phoneNumber || p.primaryPhone || p.contact?.phone))),
            street: pick(prev.street, (a && (a.street || a.line1))),
            city: pick(prev.city, (a && a.city)),
            state: pick(prev.state, (a && a.state)),
            zip: pick(prev.zip, (a && (a.zip || a.postal))),
          };
        });
      } catch (err) {
        console.warn('Failed to load profile/address for prefill', err);
      } finally {
        if (!cancelled) setLoadingProfile(false);
      }
    }

    loadProfileAndAddress();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const handleFormChange = (field, value) => {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...next,
          date: next.date ? next.date.toISOString() : null,
        })
      );
      return next;
    });
  };

  const handleAddonToggle = (addonId) => {
    const newAddons = form.addons.includes(addonId)
      ? form.addons.filter((id) => id !== addonId)
      : [...form.addons, addonId];
    handleFormChange('addons', newAddons);
  };

  // Pricing/estimate calculation
  const calculateEstimate = useCallback(() => {
    let base = 0,
      sizeCost = 0,
      conditionMultiplier = 1,
      petsCost = 0,
      addonsCost = 0,
      frequencyDiscount = 0,
      duration = 0;

    if (form.service === 'office-cleaning') {
      base = 0;
      sizeCost = form.sqft * 0.12;
      duration = form.sqft / 500;
    } else {
      base = 80;
      sizeCost = form.bedrooms * 20 + form.bathrooms * 25;
      duration = form.bedrooms * 0.5 + form.bathrooms * 0.5 + 1;
    }

    if (form.service === 'deep-clean') {
      base *= 1.5;
      duration *= 1.5;
    }
    if (form.service === 'move-in-move-out') {
      base *= 1.8;
      duration *= 1.8;
    }

    if (form.condition === 'light') conditionMultiplier = 0.9;
    if (form.condition === 'heavy') {
      conditionMultiplier = 1.25;
      duration *= 1.2;
    }

    if (form.pets === 'yes') {
      petsCost = 15;
      duration += 0.25;
    }

    form.addons.forEach((addonId) => {
      const addon = addons.find((a) => a.id === addonId);
      if (addon) {
        addonsCost += addon.price;
        duration += 0.5;
      }
    });

    const subtotalBeforeCondition = base + sizeCost + petsCost + addonsCost;
    const conditionAdjustedTotal = subtotalBeforeCondition * conditionMultiplier;

    const freq = frequencies.find((f) => f.id === form.frequency);
    if (freq && (form.service === 'residential-cleaning' || form.service === 'deep-clean')) {
      frequencyDiscount = conditionAdjustedTotal * freq.discount;
    }

    // Apply promo AFTER frequency discount
    const afterFreq = conditionAdjustedTotal - frequencyDiscount;
    const promoDiscount =
      promoApplied && form.promoCode?.toUpperCase() === 'CLEAN10' ? afterFreq * 0.1 : 0;

    const total = Math.max(0, afterFreq - promoDiscount);

    setEstimate({
      base,
      sizeCost,
      conditionCost: conditionAdjustedTotal - subtotalBeforeCondition,
      petsCost,
      addonsCost,
      subtotal: conditionAdjustedTotal,
      discount: frequencyDiscount,
      promoDiscount,
      total,
      duration: Math.round(duration * 2) / 2,
    });
  }, [form, promoApplied]);

  useEffect(() => {
    calculateEstimate();
  }, [calculateEstimate]);

  // Promo
  const handleApplyPromoCode = () => {
    const code = (form.promoCode || '').trim().toUpperCase();
    if (!code) {
      toast({ title: 'Enter a code to apply' });
      return;
    }
    if (promoApplied) {
      toast({
        title: 'Promo already applied',
        description: 'Remove or change code to re-apply.',
      });
      return;
    }
    if (code === 'CLEAN10') {
      setPromoApplied(true);
      toast({
        title: 'Promo Code Applied!',
        description: '10% off your estimate has been applied.',
      });
    } else {
      setPromoApplied(false);
      toast({ title: 'Invalid Promo Code', variant: 'destructive' });
    }
  };

  // Watch date → load day availability from server
  useEffect(() => {
    handleFormChange('time', '');

    if (!form.date) {
      setDayAvailability({
        dateKey: null,
        fullyBooked: false,
        blockedSlots: [],
        slotCounts: {},
        dayCountBlocking: 0,
      });
      return;
    }
    if (OPERATING_RULES.SUN_CLOSED && isSunday(form.date)) {
      setDayAvailability({
        dateKey: null,
        fullyBooked: false,
        blockedSlots: [],
        slotCounts: {},
        dayCountBlocking: 0,
      });
      return;
    }

    if (!currentUser) {
      setDayAvailability({
        dateKey: null,
        fullyBooked: false,
        blockedSlots: [],
        slotCounts: {},
        dayCountBlocking: 0,
      });
      return;
    }

    setLoadingDay(true);
    const dateKey = format(form.date, 'yyyy-MM-dd');
    const durationHours = Number.isFinite(estimate.duration) && estimate.duration > 0 ? estimate.duration : 2;
    const durationMinutes = Math.round(durationHours * 60);

    getDayAvailability(
      dateKey,
      getTimeOptionsForDate(form.date),
      SLOT_CAPACITY,
      DAILY_CAPACITY,
      durationMinutes,
      isEditing ? bookingId : null
    )
      .then((result) => {
        setDayAvailability(result);
        setLoadingDay(false);
      })
      .catch((err) => {
        console.error('Failed to fetch day availability:', err);
        setLoadingDay(false);
        // Fallback to empty availability on error
        setDayAvailability({
          dateKey,
          fullyBooked: false,
          blockedSlots: [],
          slotCounts: {},
          dayCountBlocking: 0,
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.date, estimate.duration, isEditing, bookingId, currentUser]);

  // Disabled times from capacity + operating rules
  const disabledTimes = useMemo(() => {
    if (!form.date) return new Set();
    if (OPERATING_RULES.SUN_CLOSED && isSunday(form.date)) {
      return new Set(getTimeOptionsForDate(form.date));
    }
    // Use server-provided blocked slots
    if (dayAvailability.fullyBooked) {
      return new Set(getTimeOptionsForDate(form.date));
    }
    // Return blocked slots from server (no client-side overlap calculation)
    return new Set(dayAvailability.blockedSlots);
  }, [form.date, dayAvailability]);

    // Only show times that are actually available (capacity + operating rules)
  const timeOptionsForUi = useMemo(() => {
    if (!form.date) return [];
    const base = getTimeOptionsForDate(form.date); // already respects Sunday / Sat rules
    return base.filter((t) => !disabledTimes.has(t));
  }, [form.date, disabledTimes]);

  // Validation
  const validateForm = useCallback(() => {
    const next = {};
    const required = [
      'firstName',
      'lastName',
      'email',
      'phone',
      'street',
      'city',
      'state',
      'zip',
      'date',
      'time',
    ];
    required.forEach((k) => {
      if (!form[k] || (typeof form[k] === 'string' && !form[k].trim())) {
        next[k] = 'Required';
      }
    });

    if (!form.agreePolicy) {
      next.agreePolicy = 'You must agree to the estimate and deposit policy.';
    }

    if (form.date && OPERATING_RULES.SUN_CLOSED && isSunday(form.date)) {
      next.date = 'We are closed on Sundays.';
    }

    if (form.date && form.time) {
      const allowed = getTimeOptionsForDate(form.date).filter(
        (t) => !disabledTimes.has(t)
      );
      if (!allowed.includes(form.time)) {
        next.time = 'This time is not available on the selected day.';
      }
    }


    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      next.email = 'Enter a valid email.';
    }
    if (form.phone && !/^[0-9\-+() ]{7,}$/.test(form.phone)) {
      next.phone = 'Enter a valid phone.';
    }
    if (form.zip && !/^\d{5}(-\d{4})?$/.test(form.zip)) {
      next.zip = 'Enter a valid ZIP.';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }, [form, disabledTimes]);

  // Submit
  const handleProceedToCheckout = async () => {
    console.log("handleProceedToCheckout start", { isSubmitting, isEditing, bookingId });
    if (isSubmitting) return;

    // 🔒 Require login
    const currentUser = auth.currentUser;
    if (!currentUser) {
      toast({
        variant: "destructive",
        title: "Please sign in to book",
        description: "Log in or create an account, then try again.",
      });
      navigate(`/auth?redirect=${encodeURIComponent("/book")}`);
      return;
    }

    const ok = validateForm();
    if (!ok) {
      toast({
        variant: "destructive",
        title: "Please fix the highlighted fields",
        description: "We need a few details to lock in your booking.",
      });
      return;
    }

    const normalized = normalizePhone(form.phone);
    if (!normalized || normalized.replace(/\D/g, "").length < 10) {
      // Mirror your validateForm UX: show an error and stop submission
      setErrors((prev) => ({ ...prev, phone: "Enter a valid phone number." }));
      toast({
        variant: "destructive",
        title: "Invalid phone number",
        description: "Please enter a valid phone number (at least 10 digits).",
      });
      return;
    }

    const uid = currentUser.uid || null;
    const emailLower = (form.email || "").trim().toLowerCase();

    // Booking ownership keys (client/user)
    const ownerKeys = [];
    if (uid) ownerKeys.push(`uid:${uid}`);
    if (emailLower) ownerKeys.push(`email:${emailLower}`);

    // Business admin keys (do NOT mirror owner keys)
    const allowlist = buildAdminAllowlist();
    const fallbackAdminEmails = [
      "sanchezservices24@yahoo.com",
      "jessabel.santos@gmail.com",
    ];
    const adminEmailKeys = Array.from(new Set([...allowlist, ...fallbackAdminEmails]
      .filter(Boolean)
      .map((e) => `email:${String(e).toLowerCase()}`)));

    const fallbackAdminUids = [
      "1Ku2G5K7EnMBOT5tHCleuL0tDPz1",
      "tcNfLl71F4egLReiutPzYvQaNvl2",
    ];
    const envAdminUids = (import.meta.env.VITE_ADMIN_UIDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const adminUidKeys = Array.from(new Set([...fallbackAdminUids, ...envAdminUids].map((u) => `uid:${u}`)));

    const adminKeys = Array.from(new Set([...adminUidKeys, ...adminEmailKeys]));

    // Check if day is fully booked using server availability data
    if (dayAvailability.fullyBooked) {
      toast({
        variant: "destructive",
        title: "Day fully booked",
        description: "Please pick another date. This one has reached capacity.",
      });
      return;
    }

    if (disabledTimes.has(form.time)) {
      toast({
        variant: "destructive",
        title: "Time no longer available",
        description: "Please choose another time slot.",
      });
      return;
    }

    const serviceMeta = services.find((s) => s.id === form.service);
    const startDate = combineDateAndTime(form.date, form.time);
    if (!startDate) {
      toast({
        variant: "destructive",
        title: "Pick a valid date and time",
        description: "Please select both date and time.",
      });
      return;
    }

    const durationHours =
      Number.isFinite(estimate.duration) && estimate.duration > 0 ? estimate.duration : 2;
    const endDate = new Date(startDate.getTime() + durationHours * 60 * 60 * 1000);
    const dateKey = format(startDate, "yyyy-MM-dd");

    const fullName = `${(form.firstName || "").trim()} ${(form.lastName || "").trim()}`.trim();

    const recurrenceValue =
      form.recurrence && form.recurrence !== "none" ? form.recurrence : null;

    setIsSubmitting(true);
    try {
      // 🔍 MANDATORY conflict check via Cloud Function (server-side with admin privileges)
      const conflictCheck = await checkConflictsTransactional(
        startDate,
        endDate,
        isEditing ? bookingId : null
      );

      if (conflictCheck.conflict) {
        toast({
          variant: "destructive",
          title: "Time conflict",
          description: `That slot overlaps an existing booking: ${conflictCheck.with}. Please choose another time.`,
        });
        setIsSubmitting(false);
        return; // ABORT: do not proceed with any Firestore write
      }

      // 🔁 New vs repeat client check (this uses userId/email, so rules allow it)
      const isRepeatClient = await checkIsRepeatClient(db, { uid, emailLower });

      const totalPrice = Number(estimate.total) || 0;
      const depositAmount = isRepeatClient ? 0 : 50;
      const remainingBalance = Math.max(0, totalPrice - depositAmount);

      const payloadBase = {
        userId: currentUser.uid || null,
        serviceSlug: form.service,
        serviceName: serviceMeta?.name || "Residential Cleaning",
        frequency: form.frequency,
        propertyType: form.propertyType,
        sqft: form.sqft,
        bedrooms: form.bedrooms,
        bathrooms: form.bathrooms,
        condition: form.condition,
        pets: form.pets === "yes",
        addons: form.addons,
        contact: {
          name: fullName,
          firstName: (form.firstName || "").trim(),
          lastName: (form.lastName || "").trim(),
          email: form.email,
          phone: normalizePhone(form.phone),
          phoneRaw: form.phone || "",
          emailLower,
        },
        address: {
          line1: form.street,
          city: form.city,
          state: form.state,
          zip: form.zip,
        },
        // Notes – keep legacy notes for admin views, but store split fields too
        notes: form.cleanerNotes || form.accessNotes || "",
        accessNotes: form.accessNotes || "",
        cleanerNotes: form.cleanerNotes || "",
        // Recurring metadata (single booking for now)
        recurrence: recurrenceValue,
        seriesId: recurrenceValue ? loadedBooking?.seriesId || null : null,
        estimate: {
          base: estimate.base,
          sizeCost: estimate.sizeCost,
          conditionCost: estimate.conditionCost,
          petsCost: estimate.petsCost,
          addonsCost: estimate.addonsCost,
          discount: estimate.discount,
          promoDiscount: estimate.promoDiscount,
          total: estimate.total,
          durationHours,
        },
        // Cost + billing fields
        cost: totalPrice,
        totalPrice,
        depositAmount,
        remainingBalance,
        depositPaid: false,
        depositPaymentIntentId: null,
        stripeCustomerId: null,
        invoiceId: null,
        invoiceStatus: null,
        // scheduling
        startAt: Timestamp.fromDate(startDate),
        endAt: Timestamp.fromDate(endDate),
        scheduledAt: Timestamp.fromDate(startDate),
        durationMinutes: Math.round(durationHours * 60),
        dateKey,
        updatedAt: serverTimestamp(),
        promoCode: promoApplied ? form.promoCode || null : null,
        agreePolicy: form.agreePolicy,
        ownerKeys,
        adminKeys,
        // Normalized lookup fields for client portal matching
        contactEmailLower: emailLower || null,
        contactPhoneNormalized: (() => {
          const pn = normalizePhone(form.phone);
          if (pn.length === 11 && pn.startsWith("1")) return pn.slice(1);
          return pn || null;
        })(),
      };

      if (isEditing && bookingId) {
        // Reschedule/update existing booking (no Stripe flow for edits)
        // Only update fields that clients are permitted to change per Firestore rules
        const updatePayload = {
          scheduledAt: Timestamp.fromDate(startDate),
          startAt: Timestamp.fromDate(startDate),
          endAt: Timestamp.fromDate(endDate),
          dateKey,
          timeLabel: form.time,
          updatedAt: serverTimestamp(),
          accessNotes: form.accessNotes || "",
          cleanerNotes: form.cleanerNotes || "",
          notes: form.cleanerNotes || form.accessNotes || "",
        };
        const normalizedPayload = normalizeBookingForWrite(updatePayload);
        await updateDoc(doc(db, "bookings", bookingId), normalizedPayload);
        navigate(`/confirm?bookingId=${bookingId}`);
        return;
      }

      // New booking – use server-side transactional conflict validation
      const cleanPayload = stripUndefinedDeep(payloadBase);
      const ref = await createBookingWithConflictCheck(currentUser?.uid || null, {
        ...cleanPayload,
        paid: 0,
        depositDue: depositAmount,
        status: isRepeatClient ? "confirmed" : "pending", // repeat clients auto-confirm
        createdAt: serverTimestamp(),
        createdVia: "client_booking",
      });

      const newBookingId = ref.id;

      // If the user is logged in, sync this booking address to their profile
      try {
        const u = auth.currentUser;
        if (u && u.uid) {
          // Use the profileModel helper which will normalize the address
          await updateProfileAddressFromServiceAddress(u.uid, {
            line1: form.street || form.address || '',
            line2: '',
            city: form.city || '',
            state: form.state || '',
            zip: form.zip || '',
          });
        }
      } catch (syncErr) {
        console.warn('Could not sync booking address to profile', syncErr);
      }

      // ✅ Repeat clients skip Stripe entirely – go straight to confirmation page
      if (isRepeatClient) {
        navigate(`/confirm?bookingId=${newBookingId}`);
        return;
      }

      // 🧾 New clients → Stripe deposit checkout
      const sessionPayload = {
        bookingId: newBookingId,
        totalPrice,
        depositAmount,
        remainingBalance,
        customerEmail: form.email,
        customerName: fullName,
      };

      try {
        const funcs = await import("firebase/functions");
        const { getFunctions, httpsCallable } = funcs;
        const functionsClient = getFunctions(auth?.app || undefined);
        const createSession = httpsCallable(functionsClient, "createStripeCheckoutSession");

        const resp = await createSession(sessionPayload);
        const session = resp?.data || null;
        if (session && session.url) {
          window.location.href = session.url;
          return;
        } else {
          console.error("Invalid session response", resp);
          toast({
            variant: "destructive",
            title: "Payment setup failed",
            description:
              "Could not create payment session. Your booking was saved but payment must be completed separately.",
          });
          // Note: booking is already saved, so we redirect anyway
          navigate(`/confirm?bookingId=${newBookingId}`);
          return;
        }
      } catch (fnErr) {
        console.error("Failed to create Stripe session", fnErr);
        toast({
          variant: "destructive",
          title: "Payment setup error",
          description:
            "Could not initiate payment. Your booking was saved and you can pay later.",
        });
        // Booking already exists, redirect to confirmation
        navigate(`/confirm?bookingId=${newBookingId}`);
        return;
      }
    } catch (err) {
      console.error("Booking failed:", err);
      toast({
        variant: "destructive",
        title: err?.message?.includes("conflict") || err?.message?.includes("overlap") 
          ? "Time conflict" 
          : "Could not submit booking",
        description: String(err?.message || err),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // a11y live region
  useEffect(() => {
    if (estimateLiveRef.current) {
      estimateLiveRef.current.textContent = `Estimated total ${estimate.total.toFixed(
        2
      )} dollars, duration approximately ${estimate.duration} hours.`;
    }
  }, [estimate.total, estimate.duration]);

  return (
    <TooltipProvider>
      <div className="py-12 sm:py-16 md:py-20 px-3 sm:px-4 bg-[#FADADD]">
        <div className="max-w-6xl mx-auto">
          <motion.div className="text-center mb-8 sm:mb-10 md:mb-12">
            <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-plum mb-3 sm:mb-4">
              {isEditing ? 'Reschedule Your Cleaning' : 'Book Your Cleaning Service'}
            </h1>
            <p className="text-sm sm:text-base md:text-lg text-plum/80">
              {isEditing
                ? 'Pick a new date and time. Details can be adjusted if needed.'
                : 'Get an instant estimate and schedule your appointment in minutes.'}
            </p>
          </motion.div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-7 md:gap-8 items-start">
            <div className="lg:col-span-2 space-y-6 sm:space-y-7 md:space-y-8">
              {/* Step 1 */}
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle className="text-lg sm:text-xl">Step 1: Select Your Service</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
                    {services.map((service) => {
                      const selected = form.service === service.id;
                      return (
                        <button
                          key={service.id}
                          type="button"
                          onClick={() => handleFormChange('service', service.id)}
                          className={[
                            'p-4 border-2 rounded-lg flex flex-col items-center justify-center gap-2 transition-all',
                            'bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50',
                            selected
                              ? 'border-gold bg-gold/10'
                              : 'border-plum/20 hover:border-gold/50',
                          ].join(' ')}
                          aria-pressed={selected}
                          aria-label={service.name}
                        >
                          <service.icon className="w-8 h-8 text-plum" />
                          <span className="text-sm font-medium text-center text-plum">
                            {service.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Step 2 (Contact & Access) */}
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle className="text-lg sm:text-xl">Step 2: Contact & Access Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 sm:space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
                    <div className={errors.firstName ? 'relative' : ''}>
                      <Label htmlFor="firstName">First Name</Label>
                      <Input
                        id="firstName"
                        value={form.firstName}
                        onChange={(e) => handleFormChange('firstName', e.target.value)}
                        aria-invalid={!!errors.firstName}
                        required
                        autoComplete="given-name"
                        className="bg-white"
                      />
                      {errors.firstName && (
                        <p className="text-xs text-red-600 mt-1">{errors.firstName}</p>
                      )}
                    </div>
                    <div className={errors.lastName ? 'relative' : ''}>
                      <Label htmlFor="lastName">Last Name</Label>
                      <Input
                        id="lastName"
                        value={form.lastName}
                        onChange={(e) => handleFormChange('lastName', e.target.value)}
                        aria-invalid={!!errors.lastName}
                        required
                        autoComplete="family-name"
                        className="bg-white"
                      />
                      {errors.lastName && (
                        <p className="text-xs text-red-600 mt-1">{errors.lastName}</p>
                      )}
                    </div>
                    <div className={errors.email ? 'relative' : ''}>
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={form.email}
                        onChange={(e) => handleFormChange('email', e.target.value)}
                        aria-invalid={!!errors.email}
                        required
                        autoComplete="email"
                        className="bg-white"
                      />
                      {errors.email && (
                        <p className="text-xs text-red-600 mt-1">{errors.email}</p>
                      )}
                    </div>
                  </div>

                  {/* Saved address dropdown */}
                  {addressOptions.length > 0 && (
                    <div className="space-y-1">
                      <Label htmlFor="saved-address">Service address</Label>
                      <Select
                        value={selectedAddressId || ''}
                        onValueChange={(v) => {
                          setSelectedAddressId(v);
                          const addr = addressOptions.find((a) => a.id === v);
                          if (addr) {
                            handleFormChange('street', addr.street || '');
                            handleFormChange('city', addr.city || '');
                            handleFormChange('state', addr.state || '');
                            handleFormChange('zip', addr.zip || '');
                          }
                        }}
                      >
                        <SelectTrigger
                          id="saved-address"
                          className={selectTriggerClass}
                          disabled={loadingAddresses}
                        >
                          <SelectValue placeholder="Choose a saved address" />
                        </SelectTrigger>
                        <SelectContent className={selectContentClass}>
                          {addressOptions.map((a) => {
                            const nickname = a.nickname || a.type || 'Home';
                            const short = [a.street, a.city].filter(Boolean).join(', ');
                            return (
                              <SelectItem
                                key={a.id}
                                value={a.id}
                                className={selectItemClass}
                              >
                                {nickname} — {short}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-plum/70">
                        We&apos;ll pre-fill the address fields below. You can still tweak them
                        for this visit.
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className={errors.street ? 'relative' : ''}>
                      <Label htmlFor="street">Street Address</Label>
                      <Input
                        id="street"
                        value={form.street}
                        onChange={(e) => handleFormChange('street', e.target.value)}
                        aria-invalid={!!errors.street}
                        required
                        autoComplete="street-address"
                        className="bg-white"
                      />
                      {errors.street && (
                        <p className="text-xs text-red-600 mt-1">{errors.street}</p>
                      )}
                    </div>

                    <div className={errors.city ? 'relative' : ''}>
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        value={form.city}
                        onChange={(e) => handleFormChange('city', e.target.value)}
                        aria-invalid={!!errors.city}
                        required
                        autoComplete="address-level2"
                        className="bg-white"
                      />
                      {errors.city && (
                        <p className="text-xs text-red-600 mt-1">{errors.city}</p>
                      )}
                    </div>

                    <div className={errors.state ? 'relative' : ''}>
                      <Label htmlFor="state">State</Label>
                      <Select
                        value={form.state || ''}
                        onValueChange={(v) => handleFormChange('state', v)}
                      >
                        <SelectTrigger id="state" className={selectTriggerClass}>
                          <SelectValue placeholder="Select a state" />
                        </SelectTrigger>
                        <SelectContent className={`${selectContentClass} max-h-48 overflow-auto`}>
                          {US_STATES.map((s) => (
                            <SelectItem key={s} value={s} className={selectItemClass}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {errors.state && (
                        <p className="text-xs text-red-600 mt-1">{errors.state}</p>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={errors.phone ? 'relative' : ''}>
                      <Label htmlFor="phone">Phone</Label>
                      <Input
                        id="phone"
                        type="tel"
                        inputMode="tel"
                        placeholder="e.g., (555) 123-4567"
                        value={form.phone}
                        onChange={(e) => handleFormChange('phone', e.target.value)}
                        aria-invalid={!!errors.phone}
                        required
                        autoComplete="tel"
                        className="bg-white"
                      />
                      {errors.phone && (
                        <p className="text-xs text-red-600 mt-1">{errors.phone}</p>
                      )}
                    </div>
                    <div className={errors.zip ? 'relative' : ''}>
                      <Label htmlFor="zip">ZIP Code</Label>
                      <Input
                        id="zip"
                        inputMode="numeric"
                        pattern="\\d{5}(-\\d{4})?"
                        value={form.zip}
                        onChange={(e) => handleFormChange('zip', e.target.value)}
                        aria-invalid={!!errors.zip}
                        required
                        autoComplete="postal-code"
                        className="bg-white"
                      />
                      {errors.zip && (
                        <p className="text-xs text-red-600 mt-1">{errors.zip}</p>
                      )}
                    </div>
                  </div>
                  <div>
                    <Label>Service Frequency</Label>
                    <Select
                      value={form.frequency}
                      onValueChange={(v) => handleFormChange('frequency', v)}
                    >
                      <SelectTrigger className={selectTriggerClass}>
                        <SelectValue placeholder="Select frequency" />
                      </SelectTrigger>
                      <SelectContent className={selectContentClass}>
                        {frequencies.map((freq) => (
                          <SelectItem
                            key={freq.id}
                            value={freq.id}
                            className={selectItemClass}
                          >
                            {freq.name}{' '}
                            {freq.discount > 0 &&
                              `(${Math.round(freq.discount * 100)}% off)`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Access notes */}
                  <div>
                    <Label htmlFor="accessNotes">Access Notes (gate codes, parking, etc.)</Label>
                    <Textarea
                      id="accessNotes"
                      value={form.accessNotes}
                      onChange={(e) =>
                        handleFormChange('accessNotes', e.target.value)
                      }
                      className="bg-white"
                    />
                  </div>

                  {/* Special notes for cleaner */}
                  <div>
                    <Label htmlFor="cleanerNotes">Special notes for your cleaner</Label>
                    <Textarea
                      id="cleanerNotes"
                      value={form.cleanerNotes}
                      onChange={(e) =>
                        handleFormChange('cleanerNotes', e.target.value)
                      }
                      className="bg-white"
                      placeholder="Example: Focus on bathrooms and kitchen, avoid strong scents in bedrooms, etc."
                    />
                    <p className="text-xs text-plum/70 mt-1">
                      These notes apply to this visit. Your cleaner will also see any
                      standing preferences saved in your profile.
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Step 3 (Customize) */}
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle>Step 3: Customize Your Cleaning</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {form.service !== 'office-cleaning' ? (
                    <>
                      <div>
                        <Label>Property Type</Label>
                        <RadioGroup
                          value={form.propertyType}
                          onValueChange={(v) => handleFormChange('propertyType', v)}
                          className="flex gap-4 mt-2"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="house" id="house" />
                            <Label htmlFor="house">House</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="apartment" id="apartment" />
                            <Label htmlFor="apartment">Apartment</Label>
                          </div>
                        </RadioGroup>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className={errors.bedrooms ? 'relative' : ''}>
                          <Label htmlFor="bedrooms">Bedrooms</Label>
                          <Select
                            value={String(form.bedrooms)}
                            onValueChange={(v) =>
                              handleFormChange('bedrooms', Number(v))
                            }
                          >
                            <SelectTrigger
                              className={selectTriggerClass}
                              aria-invalid={!!errors.bedrooms}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className={selectContentClass}>
                              {[...Array(9).keys()].map((i) => (
                                <SelectItem
                                  key={i}
                                  value={String(i)}
                                  className={selectItemClass}
                                >
                                  {i}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className={errors.bathrooms ? 'relative' : ''}>
                          <Label htmlFor="bathrooms">Bathrooms</Label>
                          <Select
                            value={String(form.bathrooms)}
                            onValueChange={(v) =>
                              handleFormChange('bathrooms', Number(v))
                            }
                          >
                            <SelectTrigger
                              className={selectTriggerClass}
                              aria-invalid={!!errors.bathrooms}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className={selectContentClass}>
                              {[...Array(7).keys()].map((i) => (
                                <SelectItem
                                  key={i}
                                  value={String(i)}
                                  className={selectItemClass}
                                >
                                  {i}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div>
                      <Label htmlFor="sqft">Square Feet</Label>
                      <Input
                        id="sqft"
                        type="number"
                        min={200}
                        step={50}
                        value={form.sqft}
                        onChange={(e) =>
                          handleFormChange('sqft', Number(e.target.value))
                        }
                        className="bg-white"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <Label>Condition Level</Label>
                      <RadioGroup
                        value={form.condition}
                        onValueChange={(v) => handleFormChange('condition', v)}
                        className="flex gap-4 mt-2"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="light" id="light" />
                          <Label htmlFor="light">Light</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="standard" id="standard" />
                          <Label htmlFor="standard">Standard</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="heavy" id="heavy" />
                          <Label htmlFor="heavy">Heavy</Label>
                        </div>
                      </RadioGroup>
                    </div>
                    <div>
                      <Label>Pets on Site?</Label>
                      <RadioGroup
                        value={form.pets}
                        onValueChange={(v) => handleFormChange('pets', v)}
                        className="flex gap-4 mt-2"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="no" id="pet-no" />
                          <Label htmlFor="pet-no">No</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="yes" id="pet-yes" />
                          <Label htmlFor="pet-yes">Yes</Label>
                        </div>
                      </RadioGroup>
                    </div>
                  </div>

                  <div>
                    <Label>Add-ons</Label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 mt-2">
                      {addons.map((addon) => (
                        <div key={addon.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={addon.id}
                            checked={form.addons.includes(addon.id)}
                            onCheckedChange={() => handleAddonToggle(addon.id)}
                          />
                          <Label htmlFor={addon.id} className="cursor-pointer">
                            {addon.name}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Step 4 (Schedule) */}
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle>Step 4: Schedule Date &amp; Time</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className={errors.date ? 'relative' : ''}>
                    <Calendar
                      mode="single"
                      selected={form.date}
                      onSelect={(d) => handleFormChange('date', d)}
                      disabled={(date) => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        const isPast = date < today;
                        const isClosedSun =
                          OPERATING_RULES.SUN_CLOSED && isSunday(date);
                        return isPast || isClosedSun;
                      }}
                      className="rounded-md border bg-white"
                      classNames={{
                        day_selected:
                          'bg-gold text-white hover:bg-gold hover:text-white focus:bg-gold focus:text-white',
                        day_today: 'border border-gold/50',
                        nav_button: 'hover:bg-gold/10',
                      }}
                    />
                    {errors.date && (
                      <p className="text-xs text-red-600 mt-2">{errors.date}</p>
                    )}
                    {loadingDay && (
                      <p className="text-xs text-plum/60 mt-2">
                        Checking availability…
                      </p>
                    )}
                  </div>

                  <div>
                    <Tooltip>
                      <TooltipTrigger className="w-full text-left">
                        <Label>Available Times</Label>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Select a time that works best for you.</p>
                      </TooltipContent>
                    </Tooltip>
                    <p className="text-sm text-plum/70 mb-2">
                      On {form.date ? format(form.date, 'PPP') : 'your selected date'}
                    </p>
                    <RadioGroup
                      value={form.time}
                      onValueChange={(v) => handleFormChange('time', v)}
                      className="grid grid-cols-2 gap-2"
                    >
                      {(!form.date || timeOptionsForUi.length === 0) && (
                        <div className="col-span-2 text-sm text-plum/70">
                          {form.date
                            ? 'No time slots are available on this day. Please choose another date.'
                            : 'Pick a date to see available times.'}
                        </div>
                      )}

                      {timeOptionsForUi.map((time) => {
                        const timeId = `time-${time.replace(/[^a-zA-Z0-9]/g, '')}`;
                        const selected = form.time === time;
                        return (
                          <div key={time}>
                            <RadioGroupItem
                              value={time}
                              id={timeId}
                              className="peer sr-only"
                            />
                            <Label
                              htmlFor={timeId}
                              className={[
                                'block p-3 border-2 rounded-lg text-center transition bg-white cursor-pointer',
                                selected
                                  ? 'border-gold bg-gold/10 ring-2 ring-gold/30'
                                  : 'border-plum/20 hover:border-gold/50',
                              ].join(' ')}
                              aria-pressed={selected}
                              aria-current={selected ? 'true' : undefined}
                            >
                              {time}
                            </Label>
                          </div>
                        );
                      })}
                    </RadioGroup>
                    {errors.time && (
                      <p className="text-xs text-red-600 mt-2">{errors.time}</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Sidebar */}
            <div className="lg:col-span-1 sticky top-24">
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle className="text-plum">Your Estimate</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {Object.entries(estimate).map(([key, value]) => {
                    const labels = {
                      base: 'Base Service',
                      sizeCost: 'Size',
                      petsCost: 'Pet Fee',
                      addonsCost: 'Add-ons',
                      conditionCost: 'Condition',
                    };
                    if (value > 0 && labels[key]) {
                      return (
                        <div key={key} className="flex justify-between text-sm">
                          <span className="text-plum/80">{labels[key]}</span>
                          <span>${value.toFixed(2)}</span>
                        </div>
                      );
                    }
                    return null;
                  })}
                  <div className="border-t border-gold/30 my-2 pt-2 space-y-2">
                    {estimate.discount > 0 && (
                      <div className="flex justify-between text-sm font-semibold text-green-700">
                        <span className="flex items-center">
                          <Tag className="h-4 w-4 mr-1" />
                          Frequency Discount
                        </span>
                        <span>−${estimate.discount.toFixed(2)}</span>
                      </div>
                    )}
                    {estimate.promoDiscount > 0 && (
                      <div className="flex justify-between text-sm font-semibold text-green-700">
                        <span className="flex items-center">
                          <Tag className="h-4 w-4 mr-1" />
                          Promo (CLEAN10)
                        </span>
                        <span>−${estimate.promoDiscount.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-bold text-plum mt-1">
                      <span className="flex items-center text-lg">
                        <Clock className="h-5 w-5 mr-2 text-gold" />
                        Est. Duration
                      </span>
                      <span>~{estimate.duration} hours</span>
                    </div>
                    <div className="flex justify-between text-2xl font-bold text-plum">
                      <span>Total</span>
                      <span>${estimate.total.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="text-xs text-plum/70 pt-2 flex items-start gap-1">
                    <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span>Final price may adjust on site after walkthrough.</span>
                  </div>
                  <div className="sr-only" aria-live="polite" ref={estimateLiveRef} />
                </CardContent>
                <CardFooter className="flex flex-col gap-4">
                  <div className="flex w-full max-w-sm items-center space-x-2">
                    <Input
                      type="text"
                      name="promoCode"
                      placeholder="Promo Code"
                      value={form.promoCode}
                      onChange={(e) => {
                        handleFormChange('promoCode', e.target.value);
                        if (promoApplied) setPromoApplied(false);
                      }}
                      autoComplete="off"
                      className="bg-white"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleApplyPromoCode}
                      className="border-gold text-gold hover:bg-gold/10 hover:text-gold"
                      disabled={!form.promoCode?.trim() || promoApplied}
                    >
                      {promoApplied ? 'Applied' : 'Apply'}
                    </Button>
                  </div>

                  {/* ⚖️ Disclaimer before the button */}
                  <div className="rounded-xl border border-gold/30 bg-rose-50 p-4 -mt-1">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-gold mt-0.5" />
                      <div className="text-sm text-plum/80">
                        <p className="font-semibold text-plum">
                          Important: estimates are not final quotes.
                        </p>
                        <ul className="list-disc pl-5 mt-2 space-y-1">
                          <li>
                            The online total is an estimate. Final pricing is confirmed
                            after we physically see the property and walk through the
                            scope.
                          </li>
                          <li>
                            A <span className="font-semibold">$50 non-refundable deposit</span> is required to hold your appointment. It is
                            applied to your final balance at service.
                          </li>
                          <li>
                            <span className="font-semibold">Timing:</span> once we confirm
                            your date and time, the deposit is due within 24 hours or the
                            slot may be released.
                          </li>
                          <li>
                            <span className="font-semibold">Rescheduling:</span> one
                            reschedule is allowed with at least 48 hours notice. The
                            deposit transfers to the new date.
                          </li>
                          <li>
                            <span className="font-semibold">
                              Cancellations and no-shows:
                            </span>{' '}
                            canceling within 48 hours of the appointment or not being
                            present at the scheduled time forfeits the deposit.
                          </li>
                          <li>
                            If the size or condition differs from what was submitted, the
                            price and duration will be adjusted on site before work
                            begins.
                          </li>
                        </ul>
                        <label className="mt-3 flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={form.agreePolicy}
                            onChange={(e) =>
                              handleFormChange('agreePolicy', e.target.checked)
                            }
                            className="h-4 w-4 rounded border-plum/30 accent-[--gold-500]"
                          />
                          <span>
                            I understand and agree to the estimate and deposit policy.
                          </span>
                        </label>
                        {errors.agreePolicy && (
                          <p className="text-xs text-red-600 mt-1">
                            {errors.agreePolicy}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={() => {
                      console.log("ProceedToBook clicked");
                      handleProceedToCheckout();
                    }}
                    size="lg"
                    className="w-full bg-gold hover:bg-gold/90 text-white rounded-full disabled:opacity-60 flex items-center justify-center gap-2"
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        <span>{isEditing ? "Saving…" : "Connecting to Stripe…"}</span>
                      </>
                    ) : (
                      <>
                        <span>{isEditing ? "Save New Date/Time" : "Proceed to Book"}</span>
                        <ChevronRight className="h-5 w-5" />
                      </>
                    )}
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};

export default BookingPage;

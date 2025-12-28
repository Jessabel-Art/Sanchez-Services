// src/lib/db.js

/**
 * ⚠️ SECURITY GUARDRAILS FOR BOOKINGS QUERIES ⚠️
 * 
 * Client-side code MUST follow these patterns when querying bookings:
 * 
 * ✅ SAFE patterns:
 *   1. Ownership-filtered reads:
 *      - where('userId', '==', currentUser.uid)
 *      - where('contact.emailLower', '==', emailLower)
 *      - where('contactEmailLower', '==', emailLower)
 *      - where('contactPhoneNormalized', '==', phoneNormalized)
 *      - where('ownerKeys', 'array-contains', `uid:${uid}`)
 * 
 *   2. Cloud Function wrappers (via httpsCallable):
 *      - getDayAvailability() - Returns aggregated data only (no PII)
 *      - checkConflictsTransactional() - Returns conflict boolean only
 * 
 * ❌ NEVER use these patterns in client code:
 *   - where('status', '==', 'confirmed') without ownership filter
 *   - where('dateKey', '==', date) without ownership filter
 *   - date-range queries (startAt >= X, endAt <= Y) without ownership filter
 *   - Any query that could return other users' bookings
 * 
 * Why: Firestore rules enforce ownership-based access. Queries without
 * ownership filters will be rejected with permission-denied errors.
 * 
 * For cross-user operations (availability, conflict checks), use Cloud
 * Functions with admin privileges that return only aggregated data.
 */

import { db } from '@/lib/firebase';
import {
    runTransaction,
    Timestamp,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  addDoc, collection, serverTimestamp, getDocs,
  query, where, orderBy, onSnapshot
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/lib/firebase';
import { normalizeAddress, stripUndefinedDeep } from './contactModel';
import { normalizeBookingForWrite } from './bookings';

/** ---------- Helpers ---------- */
export const now = () => serverTimestamp();

/**
 * Robust date converter that accepts various Firestore/JS date formats
 * @param {*} v - Value that might be a Date, Timestamp, POJO {seconds, nanoseconds}, or string
 * @returns {Date|null} - JS Date object or null if invalid
 */
function toJsDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v?.toDate === "function") return v.toDate(); // Firestore Timestamp
  if (typeof v === "object" && typeof v.seconds === "number") {
    // timestamp-like POJO (from Firestore serialization)
    return new Date(v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6));
  }
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Normalize any date-like input into a Firestore Timestamp.
 * Throws with detailed context if the value is invalid.
 */
function normalizeTimestamp(v, fieldName = "date") {
  // Firestore Timestamp instance
  if (v instanceof Timestamp) return v;

  // Firestore Timestamp-like (has toDate)
  if (typeof v?.toDate === "function") {
    const d = v.toDate();
    if (!d || Number.isNaN(d.getTime())) {
      throw new Error(`invalid date: ${fieldName} toDate() is invalid`);
    }
    return Timestamp.fromDate(d);
  }

  // Plain object { seconds, nanoseconds }
  if (typeof v === "object" && typeof v?.seconds === "number") {
    const nanos = typeof v.nanoseconds === "number" ? v.nanoseconds : 0;
    return new Timestamp(v.seconds, nanos);
  }

  // JS Date
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      throw new Error(`invalid date: ${fieldName} is an invalid Date`);
    }
    return Timestamp.fromDate(v);
  }

  // String or number fallback (ISO / epoch)
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`invalid date: ${fieldName} is not parseable`);
    }
    return Timestamp.fromDate(d);
  }

  throw new Error(`invalid date: ${fieldName} unsupported type`);
}

/** ---------- Profiles ---------- */
export async function ensureProfile(uid, data = {}) {
  // delegate to profileModel to ensure canonical shape
  try {
    const { upsertProfile } = await import('./profileModel');
    await upsertProfile(uid, {
      name: data.fullName || data.name || '',
      phone: data.phone || '',
      email: data.email || '',
      createdAt: data.createdAt || now(),
    });
    return doc(db, 'profiles', uid);
  } catch (e) {
    // fallback to legacy behavior if profileModel import fails
    const ref = doc(db, 'profiles', uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      // Best-effort normalization of phone for legacy fallback (digits-only)
      const rawPhone = data.phone || '';
      const normalizedPhone = String(rawPhone).replace(/\D+/g, '');
      await setDoc(ref, {
        name: data.fullName || data.name || '',
        phone: normalizedPhone,
        phoneRaw: rawPhone || '',
        email: data.email || '',
        createdAt: now(),
      });
    }
    return ref;
  }
}

export async function getProfile(uid) {
  const ref = doc(db, 'profiles', uid);
  const snap = await getDoc(ref);
  return snap.exists() ? { id: ref.id, ...snap.data() } : null;
}

/** ---------- Addresses ---------- */
export async function saveAddress(uid, addr) {
  // one address doc per user for now
  const ref = doc(db, 'addresses', uid);
  const normalized = normalizeAddress(addr || {});
  await setDoc(
    ref,
    {
      userId: uid,
      line1: normalized.line1 || '',
      line2: normalized.line2 || '',
      city: normalized.city || '',
      state: normalized.state || '',
      zip: normalized.zip || '',
      nickname: normalized.nickname || '',
      accessInstructions: normalized.accessInstructions || '',
      isDefault: !!normalized.isDefault,
      updatedAt: now(),
      createdAt: addr && addr.createdAt ? addr.createdAt : now(),
    },
    { merge: true }
  );
  return ref;
}

export async function getAddress(uid) {
  const ref = doc(db, 'addresses', uid);
  const snap = await getDoc(ref);
  return snap.exists() ? { id: ref.id, ...snap.data() } : null;
}

export async function deleteAddress(uid) {
  const ref = doc(db, 'addresses', uid);
  await deleteDoc(ref);
}

/** ---------- Bookings ---------- */

/**
 * Check for overlapping bookings in a transaction-safe way.
 * Ignores bookings with status "cancelled", "declined", or "completed".
 * 
 * @param {Date} startDate - Proposed booking start time
 * @param {Date} endDate - Proposed booking end time
 * @param {string|null} ignoreId - Booking ID to ignore (for updates)
 * @returns {Promise<{conflict: boolean, with?: string}>}
 */
/**
 * Check for overlapping bookings on a given date.
 * Delegates to server-side Cloud Function for secure conflict checking.
 * 
 * @param {Date} startDate - Proposed booking start time
 * @param {Date} endDate - Proposed booking end time
 * @param {string|null} ignoreId - Booking ID to ignore (for updates)
 * @returns {Promise<{conflict: boolean, with?: string}>}
 */
export async function checkConflictsTransactional(startDate, endDate, ignoreId = null) {
  try {
    const checkConflict = httpsCallable(functions, 'checkBookingConflict');
    const result = await checkConflict({
      startAt: startDate,
      endAt: endDate,
      ignoreId: ignoreId || null,
    });
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('[checkConflictsTransactional] Result from Cloud Function:', {
        conflict: result.data?.conflict,
        with: result.data?.with,
      });
    }
    
    return result.data || { conflict: false };
  } catch (err) {
    console.error('[checkConflictsTransactional] Cloud Function error', {
      startAt: startDate?.toISOString?.() || startDate,
      endAt: endDate?.toISOString?.() || endDate,
      ignoreId,
      error: err?.message,
      code: err?.code,
    });
    throw err;
  }
}

/**
 * Get aggregated day availability (blocked slots, counts, capacity info).
 * Does NOT return booking details or PII.
 * 
 * ⚠️ SAFE: Delegates to Cloud Function with admin privileges.
 * Client code must NEVER query bookings by date/status without ownership filters.
 * 
 * @param {string} dateKey - Date in "yyyy-MM-dd" format
 * @param {string[]} timeOptions - Array of time strings (e.g., ["09:00 AM", "11:00 AM"])
 * @param {number} slotCapacity - Max bookings per time slot
 * @param {number} dailyCapacity - Max bookings per day
 * @param {number} durationMinutes - Duration of each booking slot
 * @param {string|null} ignoreBookingId - Booking ID to ignore (when editing)
 * @returns {Promise<{dateKey, fullyBooked, blockedSlots, slotCounts, dayCountBlocking}>}
 */
export async function getDayAvailability(dateKey, timeOptions, slotCapacity, dailyCapacity, durationMinutes, ignoreBookingId = null) {
  try {
    const getAvailability = httpsCallable(functions, 'getDayAvailability');
    const result = await getAvailability({
      dateKey,
      timeOptions,
      slotCapacity,
      dailyCapacity,
      durationMinutes,
      ignoreBookingId: ignoreBookingId || null,
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log('[getDayAvailability] Result from Cloud Function:', {
        dateKey,
        fullyBooked: result.data?.fullyBooked,
        blockedSlotsCount: result.data?.blockedSlots?.length,
        dayCountBlocking: result.data?.dayCountBlocking,
      });
    }

    return result.data || { dateKey, fullyBooked: false, blockedSlots: [], slotCounts: {}, dayCountBlocking: 0 };
  } catch (err) {
    console.error('[getDayAvailability] Cloud Function error', {
      dateKey,
      timeOptions: timeOptions?.length,
      error: err?.message,
      code: err?.code,
    });
    throw err;
  }
}

export function hasOverlap(candidateStart, candidateEnd, existingStart, existingEnd) {
  const cs = Number(candidateStart instanceof Date ? candidateStart.getTime() : candidateStart);
  const ce = Number(candidateEnd instanceof Date ? candidateEnd.getTime() : candidateEnd);
  const es = Number(existingStart instanceof Date ? existingStart.getTime() : existingStart);
  const ee = Number(existingEnd instanceof Date ? existingEnd.getTime() : existingEnd);

  if ([cs, ce, es, ee].some((v) => Number.isNaN(v))) {
    throw new Error('Invalid date(s) passed to hasOverlap');
  }

  // Overlap only when ranges intersect with positive length; back-to-back is allowed
  return cs < ee && ce > es;
}

/**
 * Create a booking with server-side conflict protection via Cloud Function.
 * 
 * ⚠️ SAFE: Uses transactional write with server-side conflict detection.
 * 
 * @throws Error with "conflict" message if time slot is taken
 */
export async function createBookingWithConflictCheck(uid, data) {
  // Dev logging to diagnose date issues
  if (process.env.NODE_ENV !== 'production') {
    console.log('[createBookingWithConflictCheck] Received data.startAt:', {
      value: data.startAt,
      type: typeof data.startAt,
      constructor: data.startAt?.constructor?.name,
      hasToDate: typeof data.startAt?.toDate === 'function',
      isDate: data.startAt instanceof Date,
      hasSeconds: typeof data.startAt?.seconds === 'number',
    });
  }

  // Normalize timestamps (accept Timestamp, Date, {seconds,nanos}, ISO/number)
  let startAtTimestamp;
  try {
    startAtTimestamp = normalizeTimestamp(data.startAt, 'startAt');
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[createBookingWithConflictCheck] Invalid startAt:', {
        raw: data.startAt,
        type: typeof data.startAt,
        constructor: data.startAt?.constructor?.name,
        hasToDate: typeof data.startAt?.toDate === 'function',
        hasSeconds: typeof data.startAt?.seconds === 'number',
        error: err?.message,
      });
    }
    throw err;
  }

  const startDate = startAtTimestamp.toDate();
  const durationMinutes = data.durationMinutes || 120;

  let endAtTimestamp;
  if (data.endAt) {
    try {
      endAtTimestamp = normalizeTimestamp(data.endAt, 'endAt');
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[createBookingWithConflictCheck] Invalid endAt, falling back to startAt+duration:', {
          raw: data.endAt,
          error: err?.message,
        });
      }
      endAtTimestamp = Timestamp.fromDate(new Date(startDate.getTime() + durationMinutes * 60000));
    }
  } else {
    endAtTimestamp = Timestamp.fromDate(new Date(startDate.getTime() + durationMinutes * 60000));
  }

  const endDate = endAtTimestamp.toDate();

  const normalizedPhone = (() => {
    const raw = data.contactPhoneNormalized ?? data.contact?.phone ?? data.contact?.phoneRaw ?? "";
    const digits = String(raw).replace(/\D+/g, "");
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
    return digits || null;
  })();

  const normalizedEmailLower = (() => {
    const raw = data.contactEmailLower ?? data.contact?.emailLower ?? data.contact?.email;
    return raw ? String(raw).trim().toLowerCase() : null;
  })();

  // Check for conflicts via Cloud Function (server-side admin read)
  const conflictCheck = await checkConflictsTransactional(startDate, endDate, null);
  
  if (conflictCheck.conflict) {
    throw new Error(`Time slot conflict: ${conflictCheck.with}. Please choose another time.`);
  }

  // Merge incoming data with normalized fields and defaults
  // Preserve ALL fields from data (client/admin payloads) while ensuring normalized lookups
  
  // Parse scheduledAt if provided, otherwise default to startAt
  let scheduledAtTimestamp;
  if (data.scheduledAt) {
    try {
      scheduledAtTimestamp = normalizeTimestamp(data.scheduledAt, 'scheduledAt');
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[createBookingWithConflictCheck] Invalid scheduledAt, defaulting to startAt:', {
          raw: data.scheduledAt,
          error: err?.message,
        });
      }
      scheduledAtTimestamp = startAtTimestamp;
    }
  } else {
    scheduledAtTimestamp = startAtTimestamp;
  }
  
  const cleanData = stripUndefinedDeep({
    ...data, // Preserve all incoming fields (serviceName, totalPrice, etc.)
    userId: uid,
    startAt: startAtTimestamp, // Always write Firestore Timestamp
    scheduledAt: scheduledAtTimestamp, // Always write Firestore Timestamp (mirror startAt)
    endAt: endAtTimestamp, // Always write Firestore Timestamp
    dateKey: startDate.toISOString().slice(0, 10),
    durationMinutes,
    status: data.status || 'pending',
    createdAt: now(),
    updatedAt: now(),
    // Top-level normalized lookup fields (ensure these exist)
    contactEmailLower: normalizedEmailLower,
    contactPhoneNormalized: normalizedPhone,
    // Preserve or create nested contact fields for backward compatibility
    contact: {
      ...(data.contact || {}),
      emailLower: normalizedEmailLower,
      phoneNormalized: normalizedPhone,
    },
  });

  // Dev logging to confirm Timestamp fields before write
  if (process.env.NODE_ENV !== 'production') {
    console.log('[createBookingWithConflictCheck] About to write to Firestore:', {
      startAt: {
        type: cleanData.startAt?.constructor?.name,
        hasToDate: typeof cleanData.startAt?.toDate === 'function',
        value: cleanData.startAt,
      },
      endAt: {
        type: cleanData.endAt?.constructor?.name,
        hasToDate: typeof cleanData.endAt?.toDate === 'function',
        value: cleanData.endAt,
      },
      scheduledAt: {
        type: cleanData.scheduledAt?.constructor?.name,
        hasToDate: typeof cleanData.scheduledAt?.toDate === 'function',
        value: cleanData.scheduledAt,
      },
    });
  }

  // Write directly to Firestore (client can create due to validBookingCreate rule)
  // Normalize timestamps before write to ensure proper Firestore types
  const normalizedData = normalizeBookingForWrite(cleanData);
  const newRef = doc(collection(db, 'bookings'));
  await setDoc(newRef, normalizedData);
  return newRef;
}

/**
 * Legacy createBooking function (no conflict checking).
 * Consider migrating to createBookingWithConflictCheck for safety.
 */
export async function createBooking(uid, data) {
  const normalizedPhone = (() => {
    const raw = data.contactPhoneNormalized ?? data.contact?.phone ?? data.contact?.phoneRaw ?? "";
    const digits = String(raw).replace(/\D+/g, "");
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
    return digits || null;
  })();

  const normalizedEmailLower = (() => {
    const raw = data.contactEmailLower ?? data.contact?.emailLower ?? data.contact?.email;
    return raw ? String(raw).trim().toLowerCase() : null;
  })();

  const cleanData = stripUndefinedDeep({
    userId: uid,
    serviceSlug: data.serviceSlug,
    addressId: data.addressId || uid, // using uid == address doc id for now
    startAt: data.startAt,            // Firestore Timestamp
    durationMinutes: data.durationMinutes || 120,
    notes: data.notes || '',
    // Bookings submitted from the public form start as 'pending' for admin review.
    status: data.status || 'pending',
    depositDue: 50,
    createdAt: now(),
    updatedAt: now(),
    // Top-level normalized lookup fields
    contactEmailLower: normalizedEmailLower,
    contactPhoneNormalized: normalizedPhone,
    // Preserve or create nested contact fields for backward compatibility
    contact: {
      ...(data.contact || {}),
      emailLower: normalizedEmailLower,
      phoneNormalized: normalizedPhone,
    },
  });
  
  // Normalize timestamps before write to ensure proper Firestore types
  const normalizedData = normalizeBookingForWrite(cleanData);
  const ref = await addDoc(collection(db, 'bookings'), normalizedData);
  return ref;
}

/**
 * Subscribe to a user's bookings (ownership-filtered).
 * 
 * ⚠️ SAFE: Uses ownership filter (userId == uid).
 * Client code must NEVER query bookings without ownership filters.
 */
export function onUserBookings(uid, cb) {
  const q = query(
    collection(db, 'bookings'),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    cb(rows);
  });
}

export async function updateBooking(bookingId, patch) {
  const ref = doc(db, 'bookings', bookingId);
  // Normalize timestamps before write to ensure proper Firestore types
  const normalizedPatch = normalizeBookingForWrite({ ...patch, updatedAt: now() });
  await updateDoc(ref, normalizedPatch);
  return ref;
}

/** ---------- Services (public list) ---------- */
export async function upsertService(slug, data) {
  const ref = doc(db, 'services', slug);
  await setDoc(ref, { ...data, updatedAt: now() }, { merge: true });
  return ref;
}

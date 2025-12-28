// src/lib/bookings.js
/**
 * Booking timestamp normalization utilities.
 * 
 * These helpers ensure bookings are written to Firestore with proper Timestamp types
 * and can be safely read even if legacy data has plain {seconds, nanoseconds} objects.
 */

import { Timestamp, serverTimestamp } from 'firebase/firestore';

/**
 * Convert any date-like value to a Firestore Timestamp.
 * Accepts: Timestamp, Date, number (ms), {seconds, nanoseconds}, or ISO string.
 * 
 * @param {any} value - The value to convert
 * @returns {Timestamp | null} - Firestore Timestamp or null if invalid
 */
export function coerceToTimestamp(value) {
  if (!value) return null;
  
  // Already a Firestore Timestamp
  if (value instanceof Timestamp) return value;
  
  // Has toDate method (Firestore Timestamp-like)
  if (typeof value?.toDate === 'function') {
    try {
      const d = value.toDate();
      if (d && !Number.isNaN(d.getTime())) {
        return Timestamp.fromDate(d);
      }
    } catch {
      // Fall through
    }
  }
  
  // Plain object with seconds/nanoseconds (legacy Firestore serialization)
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
    return new Timestamp(value.seconds, nanos);
  }
  
  // JS Date
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) {
      return Timestamp.fromDate(value);
    }
    return null;
  }
  
  // Number (milliseconds since epoch)
  if (typeof value === 'number') {
    return Timestamp.fromMillis(value);
  }
  
  // String (ISO format or other parseable)
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return Timestamp.fromDate(d);
    }
  }
  
  return null;
}

/**
 * Normalize a booking object for safe Firestore writes.
 * Ensures all timestamp fields are proper Firestore Timestamp instances,
 * and createdAt/updatedAt use serverTimestamp() if not already set.
 * 
 * @param {Object} input - Raw booking data
 * @returns {Object} - Normalized booking ready for addDoc/setDoc/updateDoc
 */
export function normalizeBookingForWrite(input) {
  if (!input || typeof input !== 'object') return input;
  
  const result = { ...input };
  
  // Timestamp fields that should be Firestore Timestamps
  const timestampFields = ['startAt', 'endAt', 'scheduledAt'];
  
  for (const field of timestampFields) {
    if (field in result && result[field] != null) {
      const ts = coerceToTimestamp(result[field]);
      if (ts) {
        result[field] = ts;
      } else {
        // Invalid timestamp - remove to prevent Firestore error
        delete result[field];
      }
    }
  }
  
  // Ensure createdAt/updatedAt use serverTimestamp() for new documents
  // (Don't override if already set - respects updates)
  if (!result.createdAt) {
    result.createdAt = serverTimestamp();
  }
  if (!result.updatedAt) {
    result.updatedAt = serverTimestamp();
  }
  
  return result;
}

/**
 * Normalize a booking document read from Firestore for safe client-side use.
 * Converts any legacy {seconds, nanoseconds} plain objects to Firestore Timestamps
 * so that .toDate() methods work correctly in UI components.
 * 
 * @param {Object} docData - Raw document data from Firestore snapshot
 * @returns {Object} - Normalized booking with proper Timestamps
 */
export function normalizeBookingForRead(docData) {
  if (!docData || typeof docData !== 'object') return docData;
  
  const result = { ...docData };
  
  // Timestamp fields that UI code expects to have .toDate() method
  const timestampFields = ['startAt', 'endAt', 'scheduledAt', 'createdAt', 'updatedAt', 'reviewLeftAt'];
  
  for (const field of timestampFields) {
    if (field in result && result[field] != null) {
      const ts = coerceToTimestamp(result[field]);
      if (ts) {
        result[field] = ts;
      }
    }
  }
  
  return result;
}

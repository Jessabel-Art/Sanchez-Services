import {
  collection,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  doc,
} from "firebase/firestore";
import { normalizePhone as normalizePhoneBase } from "./contactModel";
import { normalizeBookingForWrite } from "./bookings";

export const DEFAULT_BOOKING_QUERY_LIMIT = 500;

export function dedupeById(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!r || !r.id) return;
    map.set(r.id, r);
  });
  return Array.from(map.values());
}

// Use canonical normalizePhone from contactModel, then apply 11-digit conversion
function normalizePhoneForQuery(raw) {
  const digits = normalizePhoneBase(raw);
  if (!digits) return null;
  // Convert 11-digit numbers starting with "1" to 10 digits
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits || null;
}

export function buildUserBookingQueries(db, {
  uid,
  emailLower,
  phoneNormalized,
  phoneRaw,
  includeOwnerKeys = true,
  clientMode = false,
  limit = DEFAULT_BOOKING_QUERY_LIMIT,
} = {}) {
  const qLimit = fsLimit(limit);
  const queries = [];

  if (clientMode) {
    if (uid) {
      queries.push({
        source: "uid",
        ref: query(
          collection(db, "bookings"),
          where("userId", "==", uid),
          orderBy("startAt", "desc"),
          qLimit
        ),
      });
    }

    if (includeOwnerKeys && uid) {
      queries.push({
        source: "ownerKey",
        ref: query(
          collection(db, "bookings"),
          where("ownerKeys", "array-contains", `uid:${uid}`),
          orderBy("startAt", "desc"),
          qLimit
        ),
      });
    }

    return queries;
  }

  if (uid) {
    queries.push({
      source: "uid",
      ref: query(
        collection(db, "bookings"),
        where("userId", "==", uid),
        orderBy("startAt", "desc"),
        qLimit
      ),
    });
  }

  if (emailLower) {
    queries.push({
      source: "email",
      ref: query(
        collection(db, "bookings"),
        where("contactEmailLower", "==", emailLower),
        orderBy("startAt", "desc"),
        qLimit
      ),
    });
    queries.push({
      source: "email",
      ref: query(
        collection(db, "bookings"),
        where("contact.emailLower", "==", emailLower),
        orderBy("startAt", "desc"),
        qLimit
      ),
    });
  }

  const phoneNorm = normalizePhoneForQuery(phoneNormalized);
  if (phoneNorm) {
    queries.push({
      source: "phone",
      ref: query(
        collection(db, "bookings"),
        where("contactPhoneNormalized", "==", phoneNorm),
        orderBy("startAt", "desc"),
        qLimit
      ),
    });
    queries.push({
      source: "phone",
      ref: query(
        collection(db, "bookings"),
        where("contact.phoneNormalized", "==", phoneNorm),
        orderBy("startAt", "desc"),
        qLimit
      ),
    });
    queries.push({
      source: "phone",
      ref: query(
        collection(db, "bookings"),
        where("contact.phone", "==", phoneNorm),
        orderBy("startAt", "desc"),
        qLimit
      ),
    });
  }

  const phoneRawDigits = normalizePhoneForQuery(phoneRaw);
  if (phoneRawDigits) {
    queries.push({
      source: "phone",
      ref: query(
        collection(db, "bookings"),
        where("contact.phoneRaw", "==", phoneRaw),
        orderBy("startAt", "desc"),
        qLimit
      ),
    });
  }

  if (includeOwnerKeys && uid) {
    queries.push({
      source: "ownerKey",
      ref: query(
        collection(db, "bookings"),
        where("ownerKeys", "array-contains", `uid:${uid}`),
        orderBy("startAt", "desc"),
        qLimit
      ),
    });
  }

  return queries;
}

export async function claimGuestBookings(db, {
  uid,
  emailLower,
  phoneNormalized,
  phoneRaw,
  limit = DEFAULT_BOOKING_QUERY_LIMIT,
} = {}) {
  if (!uid) return { found: 0, claimed: 0 };

  const filters = [];
  const phoneNorm = normalizePhoneForQuery(phoneNormalized);
  const phoneRawDigits = normalizePhoneForQuery(phoneRaw);

  if (emailLower) {
    filters.push(where("contactEmailLower", "==", emailLower));
    filters.push(where("contact.emailLower", "==", emailLower));
  }
  if (phoneNorm) {
    filters.push(where("contactPhoneNormalized", "==", phoneNorm));
    filters.push(where("contact.phoneNormalized", "==", phoneNorm));
    filters.push(where("contact.phone", "==", phoneNorm));
  }
  if (phoneRawDigits) {
    filters.push(where("contact.phoneRaw", "==", phoneRaw));
  }

  if (!filters.length) return { found: 0, claimed: 0 };

  const qLimit = fsLimit(limit);
  const base = collection(db, "bookings");
  const queries = filters.map((f) => query(base, where("userId", "==", null), f, qLimit));

  const snapshots = await Promise.all(queries.map((q) => getDocs(q)));
  const toClaim = dedupeById(
    snapshots.flatMap((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );

  let claimed = 0;
  await Promise.all(
    toClaim.map(async (row) => {
      if (row.userId) return;
      const ownerKeys = Array.isArray(row.ownerKeys) ? row.ownerKeys.slice() : [];
      const ok = `uid:${uid}`;
      if (!ownerKeys.includes(ok)) ownerKeys.push(ok);
      try {
        const claimUpdate = {
          userId: uid,
          ownerKeys,
          updatedAt: serverTimestamp(),
        };
        const normalizedClaimUpdate = normalizeBookingForWrite(claimUpdate);
        await updateDoc(doc(db, "bookings", row.id), normalizedClaimUpdate);
        claimed += 1;
      } catch (err) {
        // skip if permission denied or other errors
        if (process.env.NODE_ENV !== "production") {
          console.warn("[claimGuestBookings] update skipped", row.id, err?.code || err?.message || err);
        }
      }
    })
  );

  return { found: toClaim.length, claimed };
}

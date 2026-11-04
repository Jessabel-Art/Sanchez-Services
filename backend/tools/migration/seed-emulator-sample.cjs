// Seeds the LOCAL Firestore emulator (never production) with production-shaped documents.
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
const admin = require(require('path').resolve(__dirname, '../../../functions/node_modules/firebase-admin'));
admin.initializeApp({ projectId: 'demo-sanchez' });
const db = admin.firestore();
const T = (iso) => admin.firestore.Timestamp.fromDate(new Date(iso));
(async () => {
  const b = db.batch();
  b.set(db.doc('profiles/UIDclient000000000000000001'), { uid: 'UIDclient000000000000000001', name: 'Ana Client', email: 'ana@example.test', emailLower: 'ana@example.test', phone: '4015550101', preferences: { fragrancePreference: 'unscented' }, createdAt: T('2025-12-01T15:00:00Z'), updatedAt: T('2026-06-01T15:00:00Z') });
  b.set(db.doc('profiles/UIDclient000000000000000001/addresses/addr1'), { street: '5 Oak St', city: 'Cranston', state: 'RI', zip: '02920', isDefault: true, sortOrder: 0, createdAt: T('2025-12-01T15:05:00Z') });
  b.set(db.doc('profiles/UIDowner0000000000000000001'), { name: 'Owner', email: 'owner@example.test', role: 'owner', createdAt: T('2025-11-01T12:00:00Z') });
  b.set(db.doc('admins/UIDowner0000000000000000001'), { active: true });
  b.set(db.doc('bookings/UIDclient000000000000000001_req1'), {
    userId: 'UIDclient000000000000000001', ownerKeys: ['uid:UIDclient000000000000000001', 'email:ana@example.test'],
    contact: { name: 'Ana Client', email: 'ana@example.test', emailLower: 'ana@example.test', phone: '4015550101' }, contactEmailLower: 'ana@example.test',
    address: { line1: '5 Oak St', city: 'Cranston', state: 'RI', zip: '02920' }, serviceSlug: 'deep-clean', serviceName: 'Deep Clean',
    startAt: T('2026-12-10T14:00:00Z'), scheduledAt: T('2026-12-10T14:00:00Z'), endAt: T('2026-12-10T17:00:00Z'), dateKey: '2026-12-10', timeLabel: '09:00 AM',
    durationMinutes: 180, totalPrice: 210.5, totalAmount: 210.5, depositAmount: 50, depositPaid: true, paidAmount: 50, amountPaid: 50, remainingDue: 160.5, balanceDue: 160.5,
    depositPaymentIntentId: 'pi_seed_1', depositStripeNetAmount: 50, depositStripeFeeAmount: 1.8, depositStripeGrossAmount: 51.8,
    status: 'confirmed', bookingStatus: 'confirmed', paymentStatus: 'partial', estimate: { total: 210.5, durationHours: 3 },
    createdAt: T('2026-06-01T15:00:00Z'), updatedAt: T('2026-06-01T15:10:00Z'),
  });
  // legacy-shaped admin booking: no userId, UTC-derived dateKey (evening ET => next UTC day), alias fields
  b.set(db.doc('bookings/legacyAutoId0001'), {
    contact: { name: 'Walk In', email: 'Walkin@Example.test' }, clientName: 'Walk In', service: 'Residential Cleaning',
    startAt: T('2026-12-11T23:30:00Z'), dateKey: '2026-12-12', amount: 120, status: 'completed', notes: 'paid cash', paymentMethod: 'cash', createdAt: T('2026-01-10T10:00:00Z'),
  });
  b.set(db.doc('reviews/rev1'), { clientId: 'UIDclient000000000000000001', bookingId: 'UIDclient000000000000000001_req1', rating: 5, comment: 'Wonderful!', body: 'Wonderful!', status: 'approved', displayMode: 'initials', reviewDisplayName: 'A.C.', source: 'client-portal', createdAt: T('2026-06-02T12:00:00Z'), publishedAt: T('2026-06-03T12:00:00Z') });
  b.set(db.doc('blackouts/bo1'), { allDay: true, startDateKey: '2026-12-24', endDateKey: '2026-12-26', dateKey: '2026-12-24', startAt: T('2026-12-24T05:00:00Z'), endAt: T('2026-12-26T05:00:00Z'), reason: 'Holiday' });
  b.set(db.doc('availability/2026-12-10'), { dayCount: 1, takenSlotsByTime: { '09:00 AM': 1 } });
  b.set(db.doc('mail/m1'), { to: ['ana@example.test'], message: { subject: 'x', text: 'y' } });
  await b.commit();
  console.log('seeded emulator');
})();

// Generates golden fixtures from the CURRENT JavaScript implementation so the PHP ports can be
// verified for identical behavior. Run from repo root:
//   TZ=America/New_York node backend/tools/generate-parity-fixtures.cjs
// (TZ matters for the blackout/date-key helpers, which use the process-local timezone in JS.)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const root = path.resolve(__dirname, '../..');
const fnDir = path.join(root, 'functions');

// --- load functions/index.js with Firebase modules stubbed, exposing internal helpers ---
const stubFunctions = new Proxy({}, { get: () => stubFunctions, apply: () => stubFunctions });
const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() });
const fakeFunctions = {
  config: () => ({ stripe: {} }),
  https: { onCall: (f) => f, onRequest: (f) => f, HttpsError: class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } } },
  firestore: { document: () => ({ onWrite: (f) => f, onCreate: (f) => f, onUpdate: (f) => f, onDelete: (f) => f }) },
  pubsub: { schedule: () => ({ onRun: (f) => f }) },
};
const fakeAdmin = {
  initializeApp() {},
  firestore: Object.assign(() => chain(), {
    Timestamp: { fromDate: (d) => ({ __ts: d.toISOString() }) },
    FieldValue: { serverTimestamp: () => ({ __op: 'serverTimestamp' }), delete: () => ({ __op: 'delete' }), increment: (n) => ({ __op: 'increment', n }) },
  }),
};
const src = fs.readFileSync(path.join(fnDir, 'index.js'), 'utf8') + `
module.exports.__internals = { calculateAuthoritativePricing, getBookingPaymentAmounts, normalizeBookingPaymentStatus, buildPaymentPatch, getBookingEmail, nearestSlotLabel, getReminderPaymentNote, formatBookingAddress };`;
const mod = { exports: {} };
const localRequire = (id) => {
  if (id === 'firebase-functions/v1') return fakeFunctions;
  if (id === 'firebase-admin') return fakeAdmin;
  if (id === 'stripe') return () => ({});
  return require(path.join(fnDir, id));
};
vm.runInThisContext(Module.wrap(src))(mod.exports, localRequire, mod, path.join(fnDir, 'index.js'), fnDir);
const I = mod.exports.__internals;
const fee = require(path.join(fnDir, 'stripeFeeMath.js'));
const bk = require(path.join(fnDir, 'blackoutDateKeys.js'));

// --- deterministic case generation ---
const services = ['residential-cleaning', 'deep-clean', 'move-in-move-out', 'office-cleaning', 'deep-cleaning', 'moving-cleaning', 'commercial-cleaning', 'unknown', undefined];
const conditions = ['light', 'standard', 'heavy', 'HEAVY', 'weird', undefined];
const freqs = ['one-time', 'weekly', 'biweekly', 'monthly', 'daily', undefined];
const addonSets = [[], ['fridge'], ['oven', 'windows', 'carpet'], ['laundry', 'garage', 'baseboards', 'bogus']];
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const pricing = [];
for (let i = 0; i < 400; i++) {
  const input = {
    serviceSlug: pick(services),
    bedrooms: pick([0, 1, 2, 3, 4, 5, '3', 2.5]),
    bathrooms: pick([0, 1, 1.5, 2, 3, '2']),
    sqft: pick([0, 500, 1234, 1500, 3200, '2000', undefined]),
    condition: pick(conditions),
    frequency: pick(freqs),
    addons: pick(addonSets),
    pets: pick([true, false, 'yes', 'no', undefined]),
    promoCode: pick(['', 'clean10', 'CLEAN10', ' CLEAN10 ', 'SAVE5', undefined]),
  };
  Object.keys(input).forEach((k) => input[k] === undefined && delete input[k]);
  pricing.push({ input, deposit: pick([50, 0, 25, 500]), output: null });
}
// deposit is a module constant in JS (REQUIRED_DEPOSIT_AMOUNT=50); only use 50 for parity
pricing.forEach((c) => { c.deposit = 50; c.output = JSON.parse(JSON.stringify(I.calculateAuthoritativePricing(c.input))); });

const feeCases = [0, -5, 0.01, 0.5, 1, 9.99, 25, 49.99, 50, 50.01, 80, 99.5, 123.45, 144, 250.37, 999.99, 1234.56, '75', 'abc'].map((net) => ({ net, output: fee.calculateGrossFromNet(net) }));

const bookingsForAmounts = [
  {}, { totalPrice: 200 }, { totalPrice: 200, paidAmount: 50 }, { totalAmount: '180', amountPaid: '30' },
  { total: 100, balanceDue: 40 }, { amount: 120, remainingDue: 0 }, { cost: 90, depositPaid: true, depositAmount: 50 },
  { estimate: { total: 150 }, remainingBalance: 150 }, { totalPrice: 100, paidAmount: 150 }, { totalPrice: 0 },
  { totalPrice: 200, refunded: true }, { totalPrice: 200, refundedAmount: 10 }, { totalPrice: 200, status: 'cancelled' },
  { totalPrice: 200, status: 'declined' }, { totalPrice: 200, depositPaid: true }, { totalPrice: 200, paidAmount: null, balanceDue: 120 },
  { totalPrice: null, totalAmount: 75, paid: 25 }, { totalPrice: 300, depositAmount: '50', paidAmount: 0 },
];
const amounts = bookingsForAmounts.map((b) => {
  const a = I.getBookingPaymentAmounts(b);
  return { booking: b, amounts: a, status: I.normalizeBookingPaymentStatus(a, b), email: null };
});

const emails = [
  {}, { email: 'A@B.com ' }, { customerEmail: 'c@d.com', email: 'x@y.com' }, { contactEmailLower: 'top@x.com', contact: { email: 'Nested@X.com' } },
  { contact: { emailLower: 'n@x.com', email: 'N2@x.com' } }, { contact: { email: '' }, contactEmailLower: 'fallback@x.com' },
].map((b) => ({ booking: b, email: I.getBookingEmail(b) }));

const patchCases = [];
const pBookings = [
  { totalPrice: 200, depositAmount: 50, status: 'pending_payment' },
  { totalPrice: 200, depositAmount: 50, depositPaid: true, paidAmount: 50, status: 'confirmed' },
  { totalPrice: 40, depositAmount: 40, status: 'pending_payment' },
  { totalPrice: 200, depositAmount: 50, status: 'cancelled' },
  { totalPrice: 200, depositAmount: 50, depositPaid: true, paidAmount: 50, status: 'confirmed', balancePaymentIntentId: 'pi_same' },
  { totalPrice: 200, depositAmount: 50, depositPaymentIntentId: 'pi_x', status: 'pending_payment' },
];
for (const b of pBookings) {
  for (const mode of ['deposit', 'remaining_due']) {
    const a = I.getBookingPaymentAmounts(b);
    const expected = mode === 'deposit' ? Math.min(a.depositAmount, a.remainingDue) : a.remainingDue;
    for (const net of [expected, expected + 5]) {
      const md = { intended_net_amount: net.toFixed(2), estimated_stripe_fee: '1.75', gross_charge_amount: (net + 1.75).toFixed(2) };
      let output; let error = null;
      try { output = I.buildPaymentPatch(b, mode, { id: 'pi_same' }, md); } catch (e) { error = e.message; }
      patchCases.push({ booking: b, mode, metadata: md, output: output === undefined ? null : output, error });
    }
  }
}

const slotCases = ['2026-06-17T13:00:00Z', '2026-06-17T14:20:00Z', '2026-06-17T16:59:00Z', '2026-06-17T19:00:00Z', '2026-12-01T20:10:00Z', '2026-12-01T12:00:00Z']
  .map((iso) => ({ iso, explicit: null, label: I.nearestSlotLabel(new Date(iso), null) }))
  .concat([{ iso: '2026-06-17T13:00:00Z', explicit: '03:00 PM', label: I.nearestSlotLabel(new Date('2026-06-17T13:00:00Z'), '03:00 PM') }]);

const blackouts = [
  { allDay: true, startDateKey: '2026-07-04', endDateKey: '2026-07-05' },
  { allDay: true, startDateKey: '2026-07-04', endDateKey: '2026-07-04' },
  { allDay: true, dateKey: '2026-07-04' },
  { allDay: true, startDateKey: '2026-12-24', endDateKey: '2026-12-27' },
  { allDay: true, startDateKey: '2026-03-07', endDateKey: '2026-03-09' },
  { allDay: false, startDateKey: '2026-07-04', endDateKey: '2026-07-05' },
];
const dateKeys = ['2026-07-03', '2026-07-04', '2026-07-05', '2026-12-23', '2026-12-24', '2026-12-26', '2026-12-27', '2026-03-07', '2026-03-08', '2026-03-09'];
const blocked = [];
for (const b of blackouts) for (const k of dateKeys) blocked.push({ blackout: b, dateKey: k, blocked: bk.isFullDayBlackoutDateBlocked(b, k) });
const ranges = [
  ['2026-07-03T19:00:00Z', '2026-07-03T22:00:00Z'], ['2026-07-03T22:00:00Z', '2026-07-04T04:00:00Z'], ['2026-07-03T22:00:00Z', '2026-07-04T05:00:00Z'],
  ['2026-07-04T13:00:00Z', '2026-07-04T15:00:00Z'], ['2026-07-05T04:00:00Z', '2026-07-05T06:00:00Z'], ['2026-12-26T15:00:00Z', '2026-12-26T17:00:00Z'],
  ['2026-03-08T13:00:00Z', '2026-03-08T15:00:00Z'], ['2026-03-09T13:00:00Z', '2026-03-09T15:00:00Z'],
];
const overlaps = [];
for (const b of blackouts) for (const [s, e] of ranges) overlaps.push({ blackout: b, start: s, end: e, overlaps: bk.fullDayBlackoutOverlapsRange(b, new Date(s), new Date(e)) });
const addDays = [['2026-02-28', 1], ['2026-12-31', 1], ['2026-03-08', 1], ['2026-11-01', 1], ['2024-02-28', 1], ['2026-01-31', 30], ['2026-03-01', -1]]
  .map(([k, n]) => ({ key: k, n, out: bk.addLocalDays(k, n) }));

const reminderNotes = bookingsForAmounts.map((b) => ({ booking: b, note: I.getReminderPaymentNote(b) }));
const addresses = [{}, { address: '1 Main St' }, { address: { line1: '1 Main', city: 'Providence', state: 'RI', zip: '02903' } }, { address: { street: 'S', line2: 'Apt 2', postalCode: '02860' } }, { addressLine1: 'Legacy 5' }]
  .map((b) => ({ booking: b, out: I.formatBookingAddress(b) }));

const out = { generatedWith: { tz: process.env.TZ || null }, pricing, feeCases, amounts, emails, patchCases, slotCases, blocked, overlaps, addDays, reminderNotes, addresses };
fs.writeFileSync(path.join(__dirname, '../tests/fixtures/js-parity.json'), JSON.stringify(out, null, 1));
console.log('fixtures written:', Object.fromEntries(Object.entries(out).filter(([k]) => Array.isArray(out[k])).map(([k, v]) => [k, v.length])));

# Sanchez Services — Firebase/Google Cloud → PHP (Hostinger) Migration Audit

- **Audit date:** 2026-11-04
- **Scope:** Read-only audit and migration plan. No backend migration started, no production resources touched, nothing committed, pushed or deployed.
- **Implementation status:** see `docs/MIGRATION_IMPLEMENTATION.md` (PHP backend built and tested on branch `claude/dreamy-goldberg-vo1q9w`; not deployed).
- **Notation:** **[CODE]** marks a finding read directly from the repository. **[REC]** marks a recommendation. **[VERIFY]** marks an assumption that has to be checked in a console or on the host before implementation.

---

## A. Repository comparison and local sync result

### A.1 What was audited

| Item | Value |
|---|---|
| Environment | Fresh cloud clone at `/home/user/Sanchez-Services`. **This environment cannot reach your personal computer.** No local folder on your machine was compared or updated. |
| GitHub remote | `origin` → `https://github.com/Jessabel-Art/Sanchez-Services` |
| Checked-out branch | `claude/dreamy-goldberg-vo1q9w` (session working branch) |
| Audited commit | `c4e06eadecdc26f9f27640c8694c6c6036e57146`, "Add appointment reminder emails", 2026-06-17 |
| `origin/main` | `c4e06ea`, the same commit. 0 ahead / 0 behind. |
| Working tree | Clean: no uncommitted changes, no stashes, no local-only commits. |
| Fetch performed | `git fetch origin` (read-only). It discovered two remote branches that were missing from the initial clone (see below). |
| Number of candidate projects | One repository in the workspace. No second project folder exists in this environment. |

**Result:** the clone in this environment matches `origin/main` exactly. No fast-forward was needed and none was done. If you also keep a copy on your computer, run the commands in A.4 there before migration work starts.

### A.2 Remote branches

| Branch | Head | Status vs `main` | Notes |
|---|---|---|---|
| `main` | `c4e06ea` | — | The source of truth that was audited. |
| `deploy` | `a0b5540` | Generated output | Built by `.github/workflows/deploy.yml` (JamesIves deploy action) from `main@990be76`. Contains only `dist/` (SPA + `.htaccess`). The latest `main` commit, `c4e06ea`, changed only `functions/index.js`. Its workflow run (#129) succeeded but produced no new frontend output, so `deploy` lagging by one commit is expected and is **not** drift. |
| `codex/audit-dev-vs-production-behavior-discrepancies` | `6e075cb` (2025-12-28) | **Diverged and stale.** It branched from `325425e` (Dec 2025). It carries about 13 commits that are not on `main`, including "Limit client booking queries to uid/ownerKey" and "Improve auth gating and booking normalization". `main` has moved on substantially since then (28 files differ; roughly +970/−1438). | **Conflict — your decision.** Some of its ideas, such as dropping phone-based ownership queries, address findings in this report. However, it predates the June 2026 payment and blackout rewrites. Merging it would conflict with and likely regress current code. I did not merge it. |

There are no open pull requests.

### A.3 Local-only / environment configuration (names only; no contents read or printed)

| File / setting | Present in repo? | Notes |
|---|---|---|
| `.env`, `.env.local` | Not committed (`.gitignore`) | Frontend `VITE_*` values. In CI, they come from **GitHub Actions Variables**, not Secrets. |
| `functions/.env*` / Functions runtime config | Not in repo | `functions.config().stripe.*` and `process.env.*` are set on Firebase. |
| `.firebaserc` | Committed | Project id `sanchez-services-11fd0`. |
| `dist/.htaccess`, `dist/index.html` | Committed, even though `dist` is gitignored | `.htaccess` sends header `X-Powered-By: Hostinger Horizons` and SPA rewrites. This confirms the frontend is already served by Hostinger (Apache/LiteSpeed with `mod_rewrite`). The committed `dist/index.html` is stale (from `5604956`); CI rebuilds it. |

### A.4 Recommended safe sync on any other copy (for example, your computer)

Run these from the project folder. None of them discard work.

```bash
git status
```

```bash
git stash list
```

```bash
git fetch origin
```

```bash
git log --oneline HEAD..origin/main
```

```bash
git log --oneline origin/main..HEAD
```

If the working tree is clean and the second log command (local commits not on GitHub) is empty:

```bash
git merge --ff-only origin/main
```

If there are local changes or local commits, **stop**. Commit them to a new branch (`git switch -c local-backup-YYYYMMDD` then `git add -A && git commit`), push that branch, and then reconcile. Never use `git reset --hard` or a force-push.

### A.5 Checks run in this environment (local only, no production calls)

| Check | Result |
|---|---|
| `npm ci` then `npx vitest --run` | **22/22 tests passed** (5 files) |
| `npm --prefix functions ci` then `npm --prefix functions test` (mocha) | **5/5 passed** |
| `node --check functions/index.js` | OK |
| `npm run build` | Succeeded. The main bundle is 2.2 MB, and several images are over 2 MB (performance note). The build rewrote the tracked `dist/index.html`; I restored it, so the tree is clean again. |
| `functions/integration/run-integration-test.js` | **Not run.** It needs the Firestore emulator and writes bookings. |

---

## B. Current architecture and confirmed dependencies

### B.1 Topology [CODE]

```
Browser (React 18 + Vite SPA, react-router)
 ├─ Hosted on Hostinger (built by GitHub Actions → `deploy` branch → Hostinger)   [VERIFY how Hostinger pulls `deploy`]
 ├─ Firebase JS SDK v12 (src/lib/firebase.js)
 │   ├─ Firebase Auth (email/password; Google provider wired but unused in UI)
 │   ├─ Cloud Firestore (direct reads/writes + 20+ real-time onSnapshot listeners)
 │   └─ Cloud Functions callables (httpsCallable) + 1 HTTP fetch (sweep)
 ├─ Stripe Checkout (redirect to URL returned by a Cloud Function; @stripe/stripe-js is installed but not imported)
 ├─ Formspree (public contact form)
 └─ Google Analytics 4 (gtag G-1789P199VG, index.html)

Firebase project sanchez-services-11fd0 (Firestore nam5, Functions gen-1, Node 20, us-central1 default)
 ├─ functions/index.js: 20 exports (callables, HTTP, Firestore triggers, Pub/Sub schedules)
 ├─ Firestore: rules (firestore.rules) + 11 composite indexes (firestore.indexes.json)
 ├─ Cloud Storage default bucket (used only by unused generateInvoicePdf)
 ├─ `mail` collection → assumed Firebase "Trigger Email" extension → SMTP     [VERIFY — not in repo]
 └─ Cloud Scheduler / Pub/Sub (created automatically by functions.pubsub.schedule)
Stripe → stripeWebhook (HTTPS Cloud Function), payment_intent.succeeded only
```

### B.2 Dependency classification

| Dependency | Status | Must replace to leave Firebase? | Notes |
|---|---|---|---|
| Firebase Auth | **Active** | **Yes** | `src/context/AuthContext.jsx`. Sign-in, sign-up and password reset use Firebase-hosted reset emails. `updateEmail` and `updateProfile` are in `ClientPortalPage.jsx`. |
| Cloud Firestore | **Active** | **Yes** | All business data. |
| Cloud Functions | **Active** | **Yes** | Booking creation, availability, Stripe, emails, schedules. |
| Firestore Security Rules | **Active** | **Yes** (re-implemented as PHP authorization) | `firestore.rules`. |
| Cloud Scheduler / Pub/Sub | **Active** (implicit) | **Yes** | 3 scheduled functions. |
| Trigger Email extension (`mail` collection) | **Assumed active** [VERIFY] | **Yes** | The code only writes `mail` documents. Delivery depends on an extension that is not in the repo. |
| Cloud Storage | **Effectively unused** | No | Only `generateInvoicePdf` uses it, and no frontend code calls that function. The app has no file uploads. |
| Google Analytics 4 | Active | **No** (independent) | Keep as is. |
| Formspree | Active (contact form) | **No** (independent) | `src/components/sections/ContactSection.jsx:25`. A copy in `BookingsView.jsx` (`sendBookingEmail`) is dead code: it is never called and references an undefined constant. |
| Stripe | Active | Keep Stripe; **move the server side** to PHP | Secret key, webhook and session creation move into PHP. |
| `VITE_RECAPTCHA_SITE_KEY` | Set in CI; **no code references it** | No | Dead configuration. [VERIFY that reCAPTCHA/App Check is not enforced on the Firebase side.] |
| Hostinger Horizons visual-editor plugins (`plugins/visual-editor`, `vite.config.js`) | Dev only | No | Loaded only when `NODE_ENV !== 'production'`. |
| Google Fonts / other Google APIs | None found | — | No Maps, Calendar API or Places. Calendar export is a client-side `.ics` file. |

### B.3 Environment variables and secrets (names only)

**Frontend (GitHub Actions Variables → Vite build) [CODE]:**
`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_RECAPTCHA_SITE_KEY` (unused), `VITE_OWNER_UID` (unused in code), `VITE_SLOT_CAPACITY`, `VITE_DAILY_CAPACITY`, `VITE_ADMIN_EMAIL`, `VITE_BRAND_NAME`.

The code also reads these, but CI does not set them: `VITE_EXTRA_ADMINS`, `VITE_ADMIN_UIDS`, `VITE_SWEEP_URL`, `VITE_SWEEP_REQUIRE_AUTH`, `VITE_USE_FIRESTORE_EMULATOR`, `VITE_FIRESTORE_EMULATOR_HOST`, `VITE_FIRESTORE_EMULATOR_PORT`.

**Cloud Functions [CODE]:**
- `functions.config()`: `stripe.secret_key`, `stripe.frontend_url`, `stripe.signing_secret`.
- `process.env`: `SLOT_CAPACITY`, `DAILY_CAPACITY`, `ADMIN_EMAILS`, `ADMIN_UIDS`, `ADMIN_NOTIFICATION_EMAILS`, `PENDING_PAYMENT_TTL_MINUTES`, `PENDING_PAYMENT_SWEEP_BATCH`, `WEBHOOK_RECOVERY_MIN_AGE_MINUTES`, `WEBHOOK_RECOVERY_BATCH`, `REQUIRED_DEPOSIT_AMOUNT`.
- [VERIFY] `TZ` (see H.1, a high-impact item).
- [VERIFY] Trigger Email extension parameters: SMTP connection URI, default FROM, and the name of the mail collection.

### B.4 Firestore data model (as used by code) [CODE]

| Collection | Doc ID | Writers | Readers | Key fields |
|---|---|---|---|---|
| `bookings` | `${uid}_${requestId}` (client checkout) or auto-ID (admin) | Functions: create, payments, reminders, triggers. Admin browser: `updateDoc` for status, notes, reschedule, payments. Client browser: review fields only. | Admin listeners; client listeners by uid/email/phone; functions | `userId`, `ownerKeys[]` (`uid:…`, `email:…`), `contact{name,firstName,lastName,email,emailLower,phone,phoneRaw}`, `contactEmailLower`, `contactPhoneNormalized`, `address{line1,line2,city,state,zip}`, `serviceSlug`, `serviceName`, `addons[]`, `frequency`, `bedrooms`, `bathrooms`, `sqft`, `condition`, `pets`, `promoCode`, `notes`, `accessNotes`, `cleanerNotes`, `notesForCleaner`, `startAt`, `scheduledAt`, `endAt` (Timestamps), `dateKey` (YYYY-MM-DD), `timeLabel`, `durationMinutes`, `estimate{…}`, `totalPrice`/`totalAmount`, `depositAmount`, `paidAmount`/`amountPaid`, `remainingDue`/`balanceDue`, `depositPaid`, `depositPaymentIntentId`, `balancePaymentIntentId`, `stripePaymentIntentId`, `stripeSessionId`, `stripeCustomerId`, `amountNet/Fee/Gross`, `deposit*/balance*Stripe{Net,Fee,Gross}Amount`, `paymentStatus`, `paymentMethod`, `depositPaymentMethod`, `balancePaymentMethod`, `paymentSource`, `refunded`, `refundedAmount`, `paidAt`, `paidBy`, `status`/`bookingStatus`, `checkoutRequestId`, `createdVia`, `createdBy`, `reminder48SentAt`, `reminder24SentAt`, `emailQueuedAt`, `mailLastKind`, `adminNewNotifiedAt`, `adminRescheduleNotifiedAt`, `adminCancelNotifiedAt`, `reviewId`, `reviewRating`, `reviewLeftAt`, `expiredAt`, `cancelledAt`, `webhookRecoveredAt`, `rescheduledAt`, `rescheduleMeta`, `createdAt`, `updatedAt`. There are many legacy aliases (`service`, `total`, `amount`, `cost`, `clientName`, `email`, `durationHours`, …). |
| `profiles/{uid}` | Firebase UID | Client (safe-field rules), admin, maintenance | Client (own), admin | `uid`, `name`, `email`, `emailLower`, `phone`, `phoneRaw`, `phoneNormalized`, `address{}`, `addressSummary`, `preferences{fragrancePreference,focusPreference,petPreference}`, `preferredContactMethod`, `role` (admin/owner, admin-only), `ltv`, `lastBookingAt`, `createdAt`, `updatedAt` |
| `profiles/{uid}/addresses/{id}` | auto | Client, admin | Client, admin | `type`, `nickname`, `street`/`line1`, `line2`, `city`, `state`, `zip`, `accessInstructions`, `isDefault`, `sortOrder`, `createdAt`, `updatedAt` |
| `addresses/{uid}` (legacy, top-level) | uid | none | `getAddress()` in `src/lib/db.js` | **The catch-all rule denies reads**, so the "legacy → subcollection" migration in `ClientPortalPage.jsx` (around line 456) silently fails. Treat as dead. [VERIFY whether any documents exist.] |
| `admins/{uid}` | uid | admin | admin/self | `active: true` |
| `reviews` | auto | Client (validated create), admin (approve/decline) | Public (approved), owner, admin | `clientId`, `bookingId`, `serviceName`, `displayMode`, `reviewDisplayName`, `rating`, `comment`, `body`, `source`, `status` (pending/approved/declined), `createdAt`, `publishedAt`, `updatedAt`, `emailLower` |
| `blackouts` | auto | Admin (create/delete/archive) | Admin + functions | `startAt`, `endAt`, `dateKey`, `startDateKey`, `endDateKey` (**exclusive**), `allDay`, `reason`, `archived`, `archivedAt`, `status`, `createdBy`, `createdAt` |
| `availability/{dateKey}` | date | Triggers `onBookingCreate/Update/Delete` and `rebuildAvailabilityForDay` | **No reader in the frontend** | `takenSlotsByTime{}`, `dayCount`, `_capacity` — a derived cache with no consumer. |
| `bookingReservations/{dateKey}` | date | Transactions only | None | `version` (a per-day lock document for serialization) |
| `mail` | auto | Functions and admin browser | Extension | `to[]`, `replyTo`, `message{subject,html,text}`, `meta{}`, `createdAt` |
| `payments` | — | **Nothing writes it** | Rules allow read | Empty or legacy. [VERIFY] |
| `reports` | — | **No code** | — | Rules only. [VERIFY] |
| `services` | — | **No code** (service catalog is static in `src/data/services.js`) | — | Rules only. [VERIFY] |

The frontend `Testimonials` section reads static `src/content/reviews.json`, not Firestore.

### B.5 Cloud Functions inventory [CODE] (`functions/index.js`)

| Export | Type | Caller | Active? |
|---|---|---|---|
| `createBookingAndStripeCheckout` | callable | `BookingPage.jsx` (around line 886) | **Active** |
| `createStripeCheckoutSession` | callable | `PaymentCenterPage.jsx:811` (`mode: remaining_due`) | **Active** |
| `stripeWebhook` | HTTPS | Stripe | **Active** |
| `recoverWebhookMissedPayments` | schedule, every 15 min | — | **Active** |
| `expireStalePendingPaymentBookings` | schedule, every 10 min | — | **Active** |
| `sendAppointmentReminders` | schedule, every 60 min | — | **Active** (added in the latest commit). [VERIFY that it is deployed.] |
| `enqueueBookingEmail` | Firestore `onWrite` `bookings/*` | — | **Active** |
| `onBookingCreate` / `onBookingUpdate` / `onBookingDelete` | Firestore triggers | — | Active, but they only maintain the unused `availability` collection. |
| `checkBookingConflict` | callable | `src/lib/db.js:113` (BookingPage) | **Active** (no auth check) |
| `getDayAvailability` | callable | `src/lib/db.js:157` (BookingPage) | **Active** (no auth check) |
| `rescheduleBooking` | callable | `BookingPage.jsx:840` (client edit mode `/book?bookingId=`) | **Active** |
| `cancelBooking` | callable | `ClientPortalPage.jsx:1673` | **Active** |
| `createAdminBooking` | callable | `BookingsView.jsx:846` | **Active** |
| `sweepCompleteBookings` | HTTPS POST (Bearer ID token) | `MaintenanceView.jsx:382` | **Active** (admin tool; **deletes** bookings whose notes contain "test") |
| `generateInvoicePdf` | callable | **none** | Unused. Invoices are built client-side in `src/lib/payments.js` (`buildInvoiceHtml` and print). |
| `rebuildAvailabilityForDay` | callable | **none** | Unused |
| `approveReview` / `declineReview` | callable | **none** | Unused (`ReviewsView.jsx` writes directly) |
| `onReviewCreate` / `onReviewUpdate` | Firestore triggers | — | Active (adds default fields and `publishedAt`) |

---

## C. Complete feature / function migration inventory

**Not implemented in code [CODE]:**
- **Guest bookings:** `BookingPage.jsx:688-696` requires sign-in, and the callable rejects requests without auth.
- **Guest-to-account booking claims:** there is no claim flow. Access by email works implicitly through `ownerKeys` / `contactEmailLower`.
- **Recurring series:** `frequency` only applies a price discount. `recurrence`/`seriesId` are sent from the form but **dropped by the server**, and no series is generated.
- **Refunds through Stripe:** "refunded" is a manual admin flag only.
- **File uploads:** none.
- **Server-side invoice numbering:** none.

These do not need migrating. They are listed so no one assumes they exist.

| # | Feature | Source files | Current backend behavior | Firebase/Google dependencies | Required PHP/DB replacement | Shared-dependency group |
|---|---|---|---|---|---|---|
| 1 | Sign-up / sign-in / sign-out | `src/context/AuthContext.jsx`, `src/pages/AuthPage.jsx`, `src/components/auth/ClientRoute.jsx` | Firebase Auth email/password; `onAuthStateChanged` drives `authReady` | Firebase Auth | `POST /api/auth/register`, `/login`, `/logout`, `GET /api/auth/me`; `users` table; PHP session cookie | **G1 Auth** |
| 2 | Password reset | `AuthContext.resetPassword`, `AuthPage.jsx:136` | Firebase-hosted reset email/page | Firebase Auth email templates | `POST /api/auth/password/forgot`, `/password/reset` (hashed single-use token, 60-min TTL); reset page in the SPA; SMTP email | G1, **G5 Email** |
| 3 | Change email / display name | `ClientPortalPage.jsx:918` (`updateEmail`), `:946` (`updateProfile`) | Firebase Auth `updateEmail` (likely fails with `requires-recent-login`) | Firebase Auth | `PATCH /api/me/email` (requires current password, re-verifies); `PATCH /api/me/profile` | G1 |
| 4 | Admin role check | `src/pages/admin/hooks/useAdminAuth.js`, `src/lib/adminAllowlist.js`, `src/components/auth/AdminRoute.jsx`, `AdminDiagnostics.jsx`; rules `isAdmin()`; `isAdminByUidAndEmail()` | Admin if `admins/{uid}.active` or `profiles.role ∈ {admin,owner}`. Server also accepts env allowlists. The UI also accepts `VITE_ADMIN_EMAIL`/`VITE_ADMIN_UIDS`, but the rules do not, so the UI can open and then fail. | Firestore + Auth | `users.role` enum (`client`,`admin`,`owner`) enforced in PHP middleware. `/api/auth/me` returns the role. Remove client-side allowlists. | G1 |
| 5 | Client profile and contact preferences | `src/lib/profileModel.js`, `ProfileSettingsPanel.jsx`, `ClientPortalPage.jsx:420-452, 940-1210` | Direct `setDoc(merge)` to `profiles/{uid}`; rules block `role`, `ltv`, `lastBookingAt`. Phone is mirrored to `localStorage`. | Firestore | `GET/PATCH /api/me/profile` with whitelisted fields; `client_profiles` table | **G2 Profile** |
| 6 | Saved addresses (CRUD, default, sort) | `ClientPortalPage.jsx:1060-1180`, `BookingPage.jsx:320-360`, `src/lib/contactModel.js` | Direct CRUD on `profiles/{uid}/addresses`; real-time listener (`ClientPortalPage.jsx:652`) | Firestore + listener | `GET/POST/PATCH/DELETE /api/me/addresses`, `POST /api/me/addresses/{id}/default`, `PATCH …/reorder`; `addresses` table; refetch after mutation | G2 |
| 7 | Booking profile/address sync | `BookingPage.jsx:855`, `profileModel.updateProfileAddressFromServiceAddress` | Client writes the profile address before checkout | Firestore | Done server-side inside `POST /api/bookings/checkout` (optional flag) | G2, **G3 Booking** |
| 8 | Pricing / estimate | `src/data/services.js`, `src/lib/payments.js` (pricing helpers), `PaymentCenterPage.jsx:269-380` (duplicate), `functions/index.js calculateAuthoritativePricing` (authoritative) | The client shows an estimate; the server recomputes the authoritative price (promo `CLEAN10`, deposit `REQUIRED_DEPOSIT_AMOUNT`) | Functions | `App\Domain\Pricing` PHP port of `calculateAuthoritativePricing` with **golden tests** comparing outputs to the JS implementation. Optional `GET /api/pricing/quote`. | G3, **G4 Payments** |
| 9 | Day availability (slots, capacity, blackouts) | `BookingPage.jsx:567`, `src/lib/db.js getDayAvailability` → `getDayAvailability` | Counts overlapping bookings in `pending, pending_payment, confirmed, scheduled`. Slot capacity `SLOT_CAPACITY`, daily `DAILY_CAPACITY`. Full-day blackouts are evaluated by date key. Slots are 09:00, 11:00, 13:00, 15:00; Sunday closed and Saturday ≤ 1 PM are client-side rules only. | Functions + Firestore | `GET /api/availability?date=YYYY-MM-DD&duration=N` (public, rate-limited, no PII). **Ignore client-sent capacities** — today the client sends them. Enforce operating-hours rules server-side. | G3 |
| 10 | Conflict pre-check | `src/lib/db.js checkConflictsTransactional` → `checkBookingConflict` | Returns `{conflict, with}`; no auth | Functions | `POST /api/availability/check` (public, rate-limited) | G3 |
| 11 | Create booking + deposit checkout | `BookingPage.jsx:683-930` → `createBookingAndStripeCheckout` → `createBookingWithAtomicReservation`, `createSecureStripeSession` | Requires auth; auth email must equal booking email. Idempotent doc id `${uid}_${requestId}`. Transaction locks `bookingReservations/{dateKey}` and re-counts the day. Creates `pending_payment`, creates a Stripe Customer and Checkout Session (net + estimated fee line items, metadata), and returns the URL. | Functions, Firestore transaction, Stripe | `POST /api/bookings/checkout` — DB transaction with `SELECT … FOR UPDATE` on a `booking_day_locks` row plus a unique index `(user_id, checkout_request_id)`. Stripe call through PHP SDK or cURL. | G3, G4 |
| 12 | Post-checkout confirmation | `src/pages/ConfirmationPage.jsx`, `PaymentConfirmationPage.jsx` | Single `getDoc` of the booking; repeat-client query | Firestore | `GET /api/bookings/{id}` (owner/admin). Optionally poll until `payment_status` updates (replaces the timing luck of today). | G3, G4 |
| 13 | Stripe webhook | `stripeWebhook`, `applySuccessfulPayment`, `buildPaymentPatch` | Signature verified with `constructEvent(rawBody)`. Handles only `payment_intent.succeeded`. Idempotent through `depositPaid`/`depositPaymentIntentId`/`balancePaymentIntentId`. Rejects amount mismatches with a 500, which Stripe retries. **No event-id store.** | Functions, Stripe | `POST /api/stripe/webhook` (raw body, `Stripe-Signature` verification, ±300 s tolerance). `stripe_events` table with a unique `event_id`. The payment apply runs in a DB transaction with `SELECT … FOR UPDATE` on the booking. Insert a `payments` row with a unique `stripe_payment_intent_id`. | G4 |
| 14 | Missed-webhook recovery | `recoverWebhookMissedPayments` (every 15 min) | Retrieves Checkout Sessions for `pending_payment` bookings older than 10 minutes. Applies payment if paid; expires if the session expired. | Scheduler, Stripe | Cron `jobs/recover-payments.php` every 15 min (or the fallback in D.7) | G4, **G6 Jobs** |
| 15 | Expire abandoned checkouts | `expireStalePendingPaymentBookings` (every 10 min) | `pending_payment` older than 30 min with no payment intent → `expired` | Scheduler | Cron job | G3, G6 |
| 16 | Pay remaining balance | `PaymentCenterPage.jsx:780-840` → `createStripeCheckoutSession` | Owner check + strict email match; mode `remaining_due`; the webhook marks `completed` when fully paid | Functions, Stripe | `POST /api/bookings/{id}/checkout` with `{mode}` | G4 |
| 17 | Client booking list (real time) | `ClientPortalPage.jsx:480-650`, `PaymentCenterPage.jsx:557`, `UpcomingBookings.jsx`, `PastBookings.jsx`, `AppointmentTimeline.jsx`, `AppointmentsView.jsx` | Up to 7 `onSnapshot` queries (userId, ownerKeys, contactEmailLower, contact.emailLower, 4 phone variants), merged client-side. **Phone queries cannot pass rules** (no phone clause in `isBookingOwner`), and `contactEmailLower + startAt` has no composite index. Both fail and are only logged. | Firestore listeners, rules, indexes | `GET /api/me/bookings` — server-side ownership by `user_id` OR verified-email match. **No phone matching** (unverified, so unsafe). Refresh on focus/visibility plus 60 s polling, or ETag (`If-None-Match`). | G3 |
| 18 | Client cancel | `ClientPortalPage.jsx:1673` → `cancelBooking` | Owner check; sets `cancelled`. **No status guard** (can cancel completed or paid bookings), no time window, no refund. | Functions | `POST /api/bookings/{id}/cancel`. Keep the behavior; recommend adding a guard on terminal statuses (behavior change; see D.10). | G3, G5 |
| 19 | Client reschedule | `BookingPage.jsx` edit mode (`?bookingId=`) → `rescheduleBooking` | Owner check; blocking statuses only; blackout check; atomic day lock; keeps `durationMinutes` | Functions | `POST /api/bookings/{id}/reschedule` | G3, G5 |
| 20 | Client review submission | `ClientPortalPage.jsx:1700-1800`; rules `validClientReviewCreate`, `safeClientBookingUpdate`; `onReviewCreate` | Two non-atomic client writes (review + booking `reviewId`/`reviewRating`/`reviewLeftAt`) | Firestore + trigger | `POST /api/bookings/{id}/review` — one transaction, unique `(booking_id)` | **G7 Reviews** |
| 21 | Booking notes (client) | rules allow `notes`/`cleanerNotes`/`accessNotes` | Allowed by rules; also passed through reschedule | Firestore | `PATCH /api/bookings/{id}/notes` (owner) | G3 |
| 22 | Admin booking list, filters, sort, CSV | `src/pages/admin/BookingsView.jsx` (listener `:366`), `src/pages/admin/utils.js` | `onSnapshot(orderBy startAt desc)` over **all** bookings | Firestore listener | `GET /api/admin/bookings?from&to&status&q&sort&page` (server pagination) + polling | **G8 Admin** |
| 23 | Admin status change + email | `BookingsView.jsx:686` | `updateDoc` status, then browser writes a `mail` doc. The `enqueueBookingEmail` trigger **also** sends a confirm/updated email, so clients probably get **duplicate emails**. | Firestore, trigger, mail | `PATCH /api/admin/bookings/{id}/status` — one server-side email decision (dedupe through `email_outbox` unique `(booking_id, kind, event_key)`) | G8, G5 |
| 24 | Admin inline reschedule | `BookingsView.jsx:765` | Updates `startAt`/`scheduledAt`/`dateKey` only. **`endAt` is not moved**, and there is **no conflict/blackout check**. | Firestore | `POST /api/admin/bookings/{id}/reschedule` (same engine as #19, with admin override flag `force=true` logged) | G8, G3 |
| 25 | Admin reschedule modal | `src/pages/admin/components/RescheduleModal.jsx:131` | Updates start/end/dateKey + `rescheduleMeta`; writes 2 mail docs; the trigger sends another | Firestore, mail | Same endpoint as #24 | G8, G5 |
| 26 | Admin create/edit booking | `BookingModal.jsx` (client-side conflict query `:87`, mail `:303`), `BookingsView.handleSaveBooking` → `createAdminBooking` (create) / `updateDoc` (edit, **no conflict lock**) | Create: server with atomic lock. Edit: direct write. | Functions + Firestore | `POST /api/admin/bookings`, `PATCH /api/admin/bookings/{id}` (both through the reservation engine) | G8, G3 |
| 27 | Admin calendar (drag-drop, blackouts, notes, ICS/HTML export) | `src/pages/admin/CalendarView.jsx` (listeners `:368`, `:407`; `persistWhen` `:638`; blackout `addDoc` `:1125`, `deleteDoc` `:1259`; notes `:1283`) | Drag-drop writes `startAt`/`endAt` and `dateKey` from **`toISOString()` (UTC)**. It does **not** update `scheduledAt`/`timeLabel`, so emails/triggers that prefer `scheduledAt` see the old time. | Firestore listeners | `GET /api/admin/calendar?from&to` (bookings + blackouts), reschedule endpoint, `POST/DELETE /api/admin/blackouts` | G8, G3 |
| 28 | Blackout dates | `CalendarView.jsx:1090-1140`, `functions/blackoutDateKeys.js`, `MaintenanceView.jsx:530` (archive) | All-day: `startDateKey` inclusive, `endDateKey` **exclusive**; timed: `startAt`/`endAt` overlap | Firestore | `blackouts` table with `start_date`/`end_date_exclusive` (DATE) for all-day and `start_at`/`end_at` (DATETIME, business TZ) for timed; port `blackoutDateKeys.js` with its tests | G3 |
| 29 | Admin payments page (manual payments, deposit, refunds flag, invoice, CSV, summaries) | `src/pages/admin/AdminPaymentsPage.jsx` (listener `:286`, edit `:700-790`) | Direct `updateDoc` of amount and status fields; `paymentSource: admin_manual` | Firestore | `GET /api/admin/payments`, `POST /api/admin/bookings/{id}/payments` (manual ledger entry), `POST …/refund-flag`; amounts recomputed server-side from the ledger | G8, G4 |
| 30 | Invoices (client and admin) | `src/lib/payments.js buildInvoiceData/buildInvoiceHtml/buildInvoiceCsvRows/buildInvoiceLineItems` | Client-side HTML + `window.print()`; CSV | None (pure JS) | **No backend change needed.** The page reads from `GET /api/bookings/{id}`. Optional later: server-assigned `invoice_number`. | G4 |
| 31 | Admin dashboard home | `src/pages/admin/DashboardHome.jsx:88` | Listener over all bookings; KPIs computed client-side | Firestore listener | `GET /api/admin/bookings?from&to` (or `/api/admin/dashboard` aggregates) | G8 |
| 32 | Reports | `src/pages/admin/ReportsView.jsx:101` (recharts) | Listener over bookings | Firestore listener | `GET /api/admin/reports?from&to` (SQL aggregates) | G8 |
| 33 | Clients list / details | `src/pages/admin/ClientsView.jsx:96`, `components/ClientDetailsModal.jsx:107`, `ClientBookingsView.jsx:176` | `getDocs` profiles and bookings by email | Firestore | `GET /api/admin/clients`, `GET /api/admin/clients/{id}` (with bookings) | G8, G2 |
| 34 | Reviews moderation | `src/pages/admin/ReviewsView.jsx` (listeners `:73`, `:92`; `updateDoc` `:126`, `:151`) | Direct approve/decline; `onReviewUpdate` sets `publishedAt` | Firestore + trigger | `GET /api/admin/reviews?status=`, `POST /api/admin/reviews/{id}/approve|decline` | G7 |
| 35 | Maintenance tools | `src/pages/admin/MaintenanceView.jsx` (scans `:232-313`; expire `:504`; archive blackouts `:543`; normalize contacts `:608`; sweep `:382`), `src/lib/repairBookings.ts`, `src/lib/sweep.ts` (unused duplicate) | Client batch writes + HTTP sweep. The sweep **hard-deletes** bookings whose notes contain "test" (default `removeTestBookings=true`). | Firestore batch, Functions HTTP, ID token | `GET /api/admin/maintenance/issues`, `POST /api/admin/maintenance/{expire-pending|archive-blackouts|normalize-contacts|repair-dates|sweep}` with `dryRun` default **true**; soft-delete instead of hard delete (recommended behavior change) | G8, G6 |
| 36 | Booking emails (client: received/confirmed/declined/updated; admin: new/rescheduled/cancelled) | `enqueueBookingEmail` + browser `mail` writes in `BookingsView`/`BookingModal`/`RescheduleModal` | Firestore `mail` → extension → SMTP; 10-minute dedupe per kind | Trigger + extension | Synchronous domain events → `email_outbox` table → sender (PHPMailer SMTP) run inline after commit + cron retry | G5 |
| 37 | Appointment reminders (48 h and 24 h) | `sendAppointmentReminders`, `buildAppointmentReminderMail` | Hourly; confirmed bookings in the 23–49 h window; `reminder48SentAt`/`reminder24SentAt` flags; flags reset on reschedule | Scheduler | Hourly cron; same flags; reset inside the reschedule transaction | G5, G6 |
| 38 | Auto-complete past bookings | `sweepCompleteBookings` step 3 (manual only) | Manual | Functions HTTP | Part of the maintenance sweep (manual), or optionally a nightly cron (behavior change; owner decides) | G8 |
| 39 | Availability cache maintenance | `onBookingCreate/Update/Delete`, `rebuildAvailabilityForDay` | Maintains the unread `availability` collection | Triggers | **Drop.** Availability is computed from bookings in SQL. | — |
| 40 | Server PDF invoice | `generateInvoicePdf` (pdf-lib + Storage signed URL) | Unused | Storage | **Drop** (or port later if wanted) | — |
| 41 | Contact form | `ContactSection.jsx` → Formspree | Third-party | None | **Keep as is** | — |
| 42 | ICS calendar export | `src/utils/calendar.js`, `UpcomingBookings.jsx:167`, `CalendarView.jsx:222` | Client-side | None | Keep | — |
| 43 | Dev seed page | `src/pages/DevSeedPage.jsx` | **Not routed** in `App.jsx` | — | Drop or leave | — |

**Shared-dependency groups (migrate each group together):** G1 Auth, G2 Profile/Addresses, G3 Booking engine (pricing, availability, conflicts, blackouts, create/reschedule/cancel, expiry), G4 Payments (Stripe checkout, webhook, recovery, ledger, invoices), G5 Email (transactional, reminders, password reset), G6 Scheduled jobs, G7 Reviews, G8 Admin.

**Hard dependencies between groups:**
- G3 and G4 share the booking row and the transactional lock, so they must move in one cutover.
- G5 depends on G3/G4 domain events.
- Every other group depends on G1.
- Because the browser reads Firestore directly almost everywhere, **a partial migration (some features on PHP, some on Firestore) would require two-way data sync.** [REC] Do one data cutover for all groups behind a single release; build and test them incrementally on staging.

---

## D. Proposed PHP backend and database design [REC]

### D.1 Hosting-agnostic constraints

Nothing about the Hostinger plan has been verified (see F). The design therefore assumes the **lowest common denominator**:
- PHP 8.1+ with `pdo_mysql`, `curl`, `openssl`, `json`, `mbstring`.
- MySQL/MariaDB.
- Apache/LiteSpeed with `.htaccess`.
- No SSH, no Composer on the server, no persistent workers.
- Possibly cron through hPanel.

Upgrades apply if the plan supports more:
- **Composer:** dependencies are vendored at build time in GitHub Actions and uploaded with the release, so the server never needs Composer.
- **SSH:** used only for running migrations. A protected web-triggered migration runner is the fallback.
- **Cron:** preferred for jobs; see D.7 for the fallback.

### D.2 Backend structure

```
/ (document root, e.g. public_html)
 ├─ index.html, assets/…           (Vite SPA build — unchanged deployment pattern)
 ├─ .htaccess                       (SPA rewrite; exclude /api; security headers)
 └─ api/
     ├─ index.php                   (front controller; only PHP file web-reachable)
     └─ .htaccess                   (route all /api/* to index.php)
/ (outside document root if the plan allows, e.g. ~/app)   [VERIFY]
 ├─ config/config.php               (reads secrets; see D.9)
 ├─ src/
 │   ├─ Http/ (Router, Request, Response, Middleware: Session, Csrf, Auth, Admin, RateLimit, Json)
 │   ├─ Controllers/ (Auth, Me, Addresses, Availability, Bookings, Checkout, StripeWebhook, Reviews, Admin/*)
 │   ├─ Domain/ (Pricing, Availability, BlackoutDates, Reservation, PaymentMath (port of stripeFeeMath.js),
 │   │           PaymentApplier (port of buildPaymentPatch), BookingStatus, EmailTemplates)
 │   ├─ Infra/ (Db (PDO), StripeClient, Mailer (PHPMailer), Clock (business TZ), Logger)
 │   └─ Jobs/ (ExpirePending, RecoverPayments, SendReminders, SendOutbox, PurgeRateLimits)
 ├─ migrations/ (numbered .sql files) + bin/migrate.php
 ├─ bin/ (cron entry points, import tools)
 ├─ vendor/ (stripe/stripe-php, phpmailer/phpmailer — vendored in CI)
 ├─ storage/logs/, storage/import/
 └─ tests/ (PHPUnit; run in CI, not on Hostinger)
```

If code cannot live outside the document root, put it in `public_html/_app/` with `Require all denied` in its `.htaccess`, and verify that it is blocked.

A framework is optional. [REC] Use plain PHP with a small router (for example `nikic/fast-route`, vendored) to keep shared-hosting compatibility and a small surface. Slim 4 is also fine if Composer vendoring works.

### D.3 API endpoints (JSON, prefix `/api`)

| Area | Endpoints |
|---|---|
| Auth | `GET /csrf`, `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/password/change`, `POST /auth/email/change`, `POST /auth/email/verify` |
| Me | `GET/PATCH /me/profile`, `GET/POST /me/addresses`, `PATCH/DELETE /me/addresses/{id}`, `POST /me/addresses/{id}/default`, `GET /me/bookings` |
| Public | `GET /availability?date&duration`, `POST /availability/check`, `GET /pricing/quote` (optional), `GET /reviews/approved` (optional) |
| Bookings (owner) | `POST /bookings/checkout`, `GET /bookings/{id}`, `POST /bookings/{id}/checkout` (`mode=deposit|remaining_due`), `POST /bookings/{id}/reschedule`, `POST /bookings/{id}/cancel`, `PATCH /bookings/{id}/notes`, `POST /bookings/{id}/review` |
| Stripe | `POST /stripe/webhook` (no session, no CSRF, signature only) |
| Admin | `GET/POST /admin/bookings`, `GET/PATCH /admin/bookings/{id}`, `PATCH /admin/bookings/{id}/status`, `POST /admin/bookings/{id}/reschedule`, `POST /admin/bookings/{id}/payments`, `GET /admin/calendar`, `GET/POST /admin/blackouts`, `DELETE /admin/blackouts/{id}`, `GET /admin/payments`, `GET /admin/clients`, `GET /admin/clients/{id}`, `GET /admin/reviews`, `POST /admin/reviews/{id}/approve`, `POST /admin/reviews/{id}/decline`, `GET /admin/reports`, `GET /admin/maintenance/issues`, `POST /admin/maintenance/{action}`, `GET /admin/email-outbox` (diagnostics) |
| Ops | `GET /health` (DB ping, no secrets), `POST /jobs/run?job=…` (web-cron fallback; HMAC-token protected) |

Responses return booking JSON in **the same field names the UI already reads** (`startAt` ISO-8601 with offset, `totalPrice`, `paymentStatus`, `contact{…}`, `address{…}`, …). This keeps component changes small.

### D.4 Frontend changes

1. Replace `src/lib/firebase.js` with `src/lib/api.js` (a `fetch` wrapper with `credentials: 'include'` that adds the `X-CSRF-Token` header and maps errors to the current `{code, message}` shape).
2. Re-implement `AuthContext` against `/api/auth/*`, keeping the same `user`, `authReady`, `signIn`, `signUp`, `resetPassword`, `signOut` interface. `user` becomes `{id, email, name, role}`. Uses of `user.uid` become `user.id`, and a `uid` alias can be provided temporarily.
3. Swap each Firestore call site in table C for API calls. The main files are `BookingPage`, `ClientPortalPage`, `PaymentCenterPage`, `ConfirmationPage`, `PaymentConfirmationPage`, all `src/pages/admin/*`, `src/lib/db.js` and `src/lib/profileModel.js`.
4. Replace `onSnapshot` with a small `usePolledQuery(key, fetcher, {intervalMs: 30-60s, refetchOnFocus: true})` hook, plus refetch after every mutation.
5. Add a reset-password page (`/auth/reset?token=`) and optionally an email-verification page.
6. Remove the `firebase` package, the `VITE_FIREBASE_*` variables, the client-side admin allowlists and the unused `VITE_RECAPTCHA_SITE_KEY`. Keep `VITE_SLOT_CAPACITY`/`VITE_DAILY_CAPACITY` only for display, or remove them and read the values from `/api/availability`.
7. Update `.htaccess` so `/api/*` is not rewritten to `index.html`.

### D.5 Relational schema (MySQL 8 / MariaDB 10.6+, InnoDB, utf8mb4) [REC]

Conventions:
- Business timezone `America/New_York` [VERIFY].
- Instants are stored as `DATETIME(3)` in **UTC**, plus a stored `business_date DATE` where date-only semantics matter.
- Money is `DECIMAL(10,2)` (or integer cents; pick one and use it consistently).
- Every migrated row keeps `legacy_firestore_id` / `legacy_firebase_uid`.

```sql
users(
  id BIGINT PK AUTO_INCREMENT,
  public_id CHAR(26) UNIQUE,                 -- ULID used in URLs
  legacy_firebase_uid VARCHAR(128) UNIQUE NULL,
  email VARCHAR(254) NOT NULL, email_lower VARCHAR(254) NOT NULL UNIQUE,
  email_verified_at DATETIME(3) NULL,
  password_hash VARCHAR(255) NULL,           -- password_hash() argon2id/bcrypt
  legacy_password_hash TEXT NULL, legacy_password_salt VARCHAR(255) NULL, -- Firebase scrypt (optional, see E.3)
  password_migrated_at DATETIME(3) NULL,
  role ENUM('client','admin','owner') NOT NULL DEFAULT 'client',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failed_logins INT NOT NULL DEFAULT 0, locked_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL, created_at, updated_at)

client_profiles(
  user_id BIGINT PK FK→users,
  name VARCHAR(200), phone VARCHAR(40), phone_raw VARCHAR(60), phone_normalized VARCHAR(20) INDEX,
  address_summary VARCHAR(300), address_json JSON NULL,       -- denormalized copy, as today
  preferences_json JSON NULL, preferred_contact_method VARCHAR(20) NULL,
  ltv DECIMAL(10,2) NULL, last_booking_at DATETIME(3) NULL,
  legacy_json JSON NULL,                     -- unknown fields preserved verbatim
  created_at, updated_at)

addresses(
  id BIGINT PK, user_id FK→users INDEX, legacy_firestore_id VARCHAR(128),
  type VARCHAR(30), nickname VARCHAR(100), line1 VARCHAR(200), line2 VARCHAR(200),
  city VARCHAR(100), state CHAR(2), zip VARCHAR(10), access_instructions TEXT,
  is_default TINYINT(1), sort_order INT, created_at, updated_at,
  INDEX(user_id, sort_order, created_at))

bookings(
  id BIGINT PK,
  public_id VARCHAR(160) NOT NULL UNIQUE,    -- = Firestore doc id (keeps Stripe metadata.bookingId valid)
  user_id BIGINT NULL FK→users,
  contact_email_lower VARCHAR(254) INDEX, contact_phone_normalized VARCHAR(20) INDEX,
  contact_name, contact_first_name, contact_last_name, contact_email, contact_phone, contact_phone_raw,
  address_line1, address_line2, address_city, address_state, address_zip,
  service_slug VARCHAR(50), service_name VARCHAR(100), addons_json JSON, frequency VARCHAR(20),
  property_type VARCHAR(30), bedrooms SMALLINT, bathrooms DECIMAL(3,1), sqft INT,
  `condition` VARCHAR(10), pets TINYINT(1), promo_code VARCHAR(30),
  notes TEXT, access_notes TEXT, cleaner_notes TEXT,
  start_at DATETIME(3) NOT NULL, end_at DATETIME(3) NOT NULL,   -- UTC
  business_date DATE NOT NULL,               -- local date of start (replaces dateKey)
  time_label VARCHAR(10), duration_minutes INT,
  estimate_json JSON,
  total_price DECIMAL(10,2), deposit_amount DECIMAL(10,2),
  paid_amount DECIMAL(10,2), remaining_due DECIMAL(10,2),     -- derived, maintained in-transaction
  deposit_paid TINYINT(1), payment_status VARCHAR(20), payment_method VARCHAR(30),
  deposit_payment_method VARCHAR(30), balance_payment_method VARCHAR(30), payment_source VARCHAR(20),
  refunded TINYINT(1), refunded_amount DECIMAL(10,2),
  stripe_customer_id VARCHAR(64), stripe_session_id VARCHAR(128) INDEX,
  status VARCHAR(20) NOT NULL INDEX,          -- single source; bookingStatus dropped (alias in API)
  checkout_request_id VARCHAR(96), created_via VARCHAR(40), created_by_user_id BIGINT NULL,
  reminder48_sent_at, reminder24_sent_at, expired_at, cancelled_at, paid_at, rescheduled_at,
  admin_new_notified_at, admin_reschedule_notified_at, admin_cancel_notified_at,
  review_id BIGINT NULL, review_rating TINYINT NULL, review_left_at DATETIME(3) NULL,
  legacy_json JSON,                           -- full original Firestore doc for audit
  created_at, updated_at,
  UNIQUE(user_id, checkout_request_id),
  INDEX(business_date, status), INDEX(start_at), INDEX(status, start_at), INDEX(status, created_at),
  INDEX(user_id, start_at))

booking_day_locks(business_date DATE PK, version INT)   -- replaces bookingReservations

payments(                                     -- new ledger (today amounts live only on bookings)
  id BIGINT PK, booking_id FK, kind ENUM('deposit','balance','manual','refund_flag'),
  method VARCHAR(30), source ENUM('stripe','admin_manual','migrated'),
  amount_net DECIMAL(10,2), amount_fee DECIMAL(10,2), amount_gross DECIMAL(10,2),
  stripe_payment_intent_id VARCHAR(64) UNIQUE NULL, stripe_session_id VARCHAR(128) NULL,
  recorded_by_user_id BIGINT NULL, note VARCHAR(500), occurred_at DATETIME(3), created_at)

stripe_events(event_id VARCHAR(64) PK, type VARCHAR(80), received_at, processed_at NULL,
  status ENUM('received','processed','ignored','failed'), error TEXT NULL, payload_json JSON)

blackouts(id BIGINT PK, legacy_firestore_id, all_day TINYINT(1),
  start_date DATE NULL, end_date_exclusive DATE NULL,   -- all-day
  start_at DATETIME(3) NULL, end_at DATETIME(3) NULL,    -- timed (UTC)
  reason VARCHAR(300), archived TINYINT(1), archived_at, created_by_user_id, created_at, updated_at,
  INDEX(start_date, end_date_exclusive), INDEX(start_at, end_at))

reviews(id BIGINT PK, legacy_firestore_id, user_id FK NULL, booking_id FK NULL UNIQUE,
  service_name, display_mode VARCHAR(30), display_name VARCHAR(100), rating TINYINT, comment TEXT,
  source VARCHAR(30), status ENUM('pending','approved','declined'), email_lower VARCHAR(254),
  created_at, published_at NULL, updated_at, INDEX(status, created_at), INDEX(status, published_at))

email_outbox(id BIGINT PK, booking_id BIGINT NULL, kind VARCHAR(50), event_key VARCHAR(100),
  to_json JSON, reply_to VARCHAR(254), subject VARCHAR(300), html MEDIUMTEXT, text MEDIUMTEXT,
  status ENUM('queued','sent','failed'), attempts INT, last_error TEXT, send_after DATETIME(3),
  sent_at NULL, created_at, UNIQUE(booking_id, kind, event_key), INDEX(status, send_after))

password_resets(id, user_id FK, token_hash CHAR(64) UNIQUE, expires_at, used_at NULL, created_at)
email_verifications(id, user_id FK, token_hash CHAR(64) UNIQUE, new_email NULL, expires_at, used_at)
sessions (only if DB-backed sessions are chosen; otherwise PHP file sessions)
rate_limits(bucket VARCHAR(190) PK, count INT, window_start DATETIME)
audit_log(id, actor_user_id NULL, action VARCHAR(60), entity VARCHAR(30), entity_id BIGINT,
  before_json JSON, after_json JSON, ip VARBINARY(16), created_at, INDEX(entity, entity_id))
job_runs(job VARCHAR(50) PK, last_started_at, last_finished_at, last_status, lock_token)
settings(key VARCHAR(100) PK, value_json JSON)  -- slot/day capacity, deposit, TTLs (replaces env knobs)
```

`availability`, `bookingReservations`, `mail`, `reports`, `services` and `payments` (Firestore) are **not** carried over as tables. The legacy `payments`/`reports`/`services` documents are archived as JSON only if any exist.

### D.6 Replacements for Firestore mechanisms

| Firestore mechanism | PHP / SQL replacement |
|---|---|
| `runTransaction` + `bookingReservations/{dateKey}` (`createBookingWithAtomicReservation`, `rescheduleBookingWithAtomicReservation`) | `BEGIN; INSERT IGNORE booking_day_locks(date); SELECT … FROM booking_day_locks WHERE business_date=? FOR UPDATE;` then count blocking bookings on that date (`status IN (…)`), compute overlaps, check blackouts **inside the same transaction**, insert/update, `COMMIT`. A reschedule across days locks both dates in sorted order to avoid deadlocks. This serializes simultaneous requests per day, the same guarantee as today. |
| Idempotent booking ID `${uid}_${requestId}` | `UNIQUE(user_id, checkout_request_id)`; on duplicate, return the existing booking and reuse its Stripe session (same as current logic) |
| `applySuccessfulPayment` transaction | `SELECT … FOR UPDATE` on the booking row + `INSERT payments` (unique PI id) + recompute amounts and status |
| Batch writes (`writeBatch` in Maintenance, scheduled jobs) | One SQL transaction per action |
| Security rules | Controller-level authorization: `requireUser`, `requireAdmin`, `BookingPolicy::canView/canEdit` (owner = `user_id` match, OR verified `users.email_lower = bookings.contact_email_lower`), field whitelists that mirror `safeProfileUpdate`/`safeClientBookingUpdate`/`validClientReviewCreate` |
| `onSnapshot` listeners | Polling + refetch on focus/mutation (see D.4). Optional ETag/`updated_since` cursor. Server-sent events are **not** recommended on shared hosting (they hold PHP workers open). |
| `enqueueBookingEmail` trigger | Explicit domain-event calls inside controllers (`BookingEvents::created/confirmed/declined/rescheduled/cancelled`) write to `email_outbox` in the same transaction; sending happens after commit |
| `onReviewCreate`/`onReviewUpdate` | Default fields set in the create endpoint; `published_at` set in the approve endpoint |
| `onBooking*` availability triggers | Removed (availability is computed live in SQL) |
| `serverTimestamp()` | `UTC_TIMESTAMP(3)` in SQL |
| Composite indexes | SQL indexes listed in D.5 |

### D.7 Scheduled jobs

| Job | Cadence | Fallback if no cron |
|---|---|---|
| `ExpirePending` (TTL 30 min) | 10 min | Opportunistic: also expire stale `pending_payment` for that date inside every availability/checkout request (correctness never depends on the job) |
| `RecoverPayments` (Stripe session check) | 15 min | External pinger (for example a free uptime monitor or GitHub Actions `schedule`) calling `POST /api/jobs/run` with an HMAC token. Also run recovery on demand when a client opens the confirmation page. |
| `SendReminders` (48 h/24 h) | 60 min | External pinger. Windows tolerate ±1 h, which matches current logic. |
| `SendOutbox` retries | 5 min | Inline send after commit + pinger |
| Purge expired rate-limit/reset tokens | daily | Pinger |

Each job takes a `job_runs` lock (`UPDATE … SET lock_token=? WHERE lock_token IS NULL OR last_started_at < NOW()-INTERVAL 30 MINUTE`) so overlapping invocations are harmless.

### D.8 Email

- PHPMailer over SMTP: Hostinger mailbox SMTP, or a transactional provider if Hostinger's sending limits are too low [VERIFY limits].
- Port the templates verbatim from `enqueueBookingEmail`, `buildAppointmentReminderMail` and the admin-browser templates, then consolidate. [REC] Each event sends **one** client email (removes the current duplicates in #23/#25).
- Configure SPF, DKIM and DMARC for the sending domain.
- `replyTo` is currently hard-coded as `sanchezservices24@yahoo.com` in `BookingsView.jsx`. Move it to `settings`.
- Escape HTML for all user-provided values. Today the templates interpolate names and addresses unescaped.

### D.9 Security, configuration and operations

- **Secrets:** stored in a `config.php` (or `.env` read by `vlucas/phpdotenv`) that lives **outside the document root**, has permissions `0600`, and is never committed. It is uploaded once through hPanel File Manager/SFTP, or written from GitHub Actions **Secrets** during deploy. [VERIFY whether hPanel supports environment variables for PHP.] Secret names are in F.3.
- **Sessions:** PHP native sessions. Cookie `__Host-ss_sess`, `Secure`, `HttpOnly`, `SameSite=Lax`. `session_regenerate_id(true)` on login and role change. 2-week idle limit for clients and 12 h for admins. A logout endpoint destroys the session server-side.
- **CSRF:** synchronizer token from `GET /api/csrf` sent in the `X-CSRF-Token` header for all state-changing requests. Check the `Origin` header against the allowlist. The Stripe webhook is exempt and uses its signature instead.
- **CORS:** not needed when the SPA and API share the same origin (`sanchezproservices.com`). Deny cross-origin by default. If staging uses a different host, allowlist exactly that origin with credentials.
- **Password hashing:** `password_hash(PASSWORD_ARGON2ID)` if available, else `PASSWORD_BCRYPT`; `password_needs_rehash` on login.
- **Rate limiting** (DB- or APCu-backed, by IP and by account): login 5/15 min, forgot-password 3/hour, register 5/hour per IP, availability 60/min, checkout 10/hour per user. Optionally add Cloudflare Turnstile or hCaptcha on register/forgot.
- **Validation:** strict typed input DTOs. Reject unknown fields. Dates must be ISO-8601. Enums must be whitelisted. Notes are capped at 2000 characters (same as today).
- **Output:** JSON only. Headers: `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy` (allow `js.stripe.com`, `checkout.stripe.com`, `googletagmanager.com`, `formspree.io`), and `Strict-Transport-Security` after HTTPS is confirmed.
- **Logging:** structured JSON lines in `storage/logs/app-YYYY-MM-DD.log` (outside webroot) with request id, user id, route, status and latency. **Never log** secrets, card data or full webhook payloads in plain logs; `stripe_events.payload_json` is kept in the DB only. `audit_log` records every admin mutation.
- **Errors:** `display_errors=Off` in production; generic error JSON to clients.

### D.10 Behavior to preserve vs. unavoidable or recommended changes

**Preserved:**
- Pricing formula and the `CLEAN10` promo.
- Deposit of `REQUIRED_DEPOSIT_AMOUNT`, with the fee passed to the customer (`calculateGrossFromNet`).
- Time slots 09:00, 11:00, 13:00, 15:00.
- Slot capacity 1 and daily capacity 6.
- Blocking statuses `pending, pending_payment, confirmed, scheduled`.
- Blackout semantics (exclusive end date).
- 30-minute pending TTL.
- 48 h/24 h reminders.
- Booking ID format for existing records.
- Stripe Checkout redirect URLs `/confirm` and `/payment-confirmation`.
- All UI screens.

**Unavoidable:**
1. **All users get new sessions** and must sign in again at cutover.
2. **Passwords:** see E.3. Some or all users may have to reset their password.
3. Real-time updates become near-real-time (polling, up to about 30–60 s latency).
4. Firebase-hosted password-reset emails/pages are replaced by site-hosted ones.
5. Google sign-in, if any existing accounts use it [VERIFY in the Auth console], needs either a PHP OAuth implementation or conversion of those accounts to password plus reset.

**Recommended fixes** (each is a behavior change; owner to approve):
1. Remove phone-number-based booking ownership. It is already non-functional because of the rules, and it is unsafe.
2. Admin edit/reschedule/drag-drop go through the conflict engine. An explicit "override" is logged.
3. Recompute `end_at` on every reschedule.
4. A single email per event (no duplicates).
5. The sweep soft-deletes instead of hard-deleting "test" bookings and defaults to dry-run.
6. Cancellation guard for completed, expired or refunded bookings.
7. Enforce Sunday-closed and Saturday-≤1 PM rules server-side.
8. Ignore client-supplied capacities in the availability request.

---

## E. Existing-data and authentication migration plan [REC]

### E.1 Data export (read-only on Firebase)

1. **Snapshot backup first:** use a managed Firestore export (`gcloud firestore export gs://<bucket>/pre-migration-YYYYMMDD`) for disaster recovery. It needs the Owner/Datastore Import-Export Admin role and Blaze billing [VERIFY].
2. **Migration extract:** a Node script (`tools/migration/export-firestore.js`, to be written) using `firebase-admin` with a **read-only** service account. It dumps each collection (`bookings`, `profiles`, `profiles/*/addresses` via collection group, `admins`, `reviews`, `blackouts`, plus `payments`, `reports`, `services`, `addresses`, `mail` if non-empty) to NDJSON. It converts Timestamps to ISO-8601 UTC, keeps document paths and IDs, and records per-collection counts in `manifest.json` together with a SHA-256 of each file.
3. **Auth export:** `firebase auth:export users.json --format=json --project sanchez-services-11fd0`. This includes `localId`, email, `emailVerified`, `passwordHash`, `salt`, `providerUserInfo`, `createdAt` and `lastSignedInAt`. Also record the project's **password hash parameters** (Console → Authentication → Users → ⋮ → Password hash parameters: `base64_signer_key`, `base64_salt_separator`, `rounds`, `mem_cost`). These are secrets; store them only in the secure config.
4. **Stripe reconciliation export:** list Checkout Sessions and PaymentIntents (with `metadata.bookingId`) for the full history through the Stripe API or a Dashboard CSV export. This builds the `payments` ledger and cross-checks booking amounts.

Export files contain PII and password hashes. Keep them on an encrypted local disk or private storage, **never** in the git repository, and delete them after a retention period you choose.

### E.2 Transform and import (idempotent, repeatable)

`bin/import.php --dir=export/ --dry-run|--apply`:
- Upserts by `legacy_firestore_id`/`legacy_firebase_uid`, so it can be re-run safely.
- Wraps each collection in a transaction.
- Field mapping resolves the legacy aliases in the same order as `getBookingPaymentAmounts`, `getBookingEmail` and `canonicalTs` (`scheduledAt` → `startAt` for time; `totalPrice` → `totalAmount` → `total` → `amount` → `cost` → `estimate.total`; and so on).
- `status` comes from `status`, falling back to `bookingStatus`.
- `business_date` is recomputed from `start_at` in the business TZ, and conflicts with the stored `dateKey` are reported (the UTC `dateKey` bugs in #27).
- If `endAt` is missing, use `start + durationMinutes`, or 120 min as today.
- The **original document is kept in `legacy_json`.**
- Bookings link to users by `userId` → `legacy_firebase_uid`. Unlinked bookings stay `user_id NULL` and become visible to whichever verified user owns `contact_email_lower` (preserves today's email-based access).
- The `payments` ledger is seeded from booking fields: one `deposit` row if `depositPaymentIntentId` is set, one `balance` row if `balancePaymentIntentId` is set, and `manual` rows for `paymentSource=admin_manual`. Each is cross-checked against the Stripe export.
- Admins: `admins/{uid}.active` or `profiles.role ∈ {admin,owner}` → `users.role`.

### E.3 Authentication transfer options

| Option | User impact | Effort | Google dependency after cutover |
|---|---|---|---|
| **A. Import Firebase scrypt hashes and verify in PHP** (Firebase's modified scrypt: scrypt(password, salt+separator) → AES-256-CTR of the signer key; compare) | **No reset needed** for password users | Medium-high. Needs a scrypt implementation (PECL `scrypt` or a pure-PHP version; the latter is slow but workable for login-only use) plus `openssl`. Validate against known test accounts first. | None |
| **B. Lazy migration through the Firebase Auth REST API** (`identitytoolkit … accounts:signInWithPassword` with the Web API key during a transition window; on success, store a fresh `password_hash`) | No reset for users who log in during the window; the rest must reset | Low-medium | Temporary, until the window ends |
| **C. Force a reset for everyone** (email each user a reset link at cutover) | Everyone resets | Low | None |

[REC] **Option A with Option C as the fallback.** On first successful scrypt login, re-hash with Argon2id/bcrypt and clear the legacy hash. Accounts without a password hash (Google-only) and any scrypt verification failure go through the reset flow. If A cannot be validated on the host's PHP, use B for 60–90 days, then C. **Password resets are required for at least Google-provider accounts** (if any) and for users who never sign in during a B window.

Preserve `emailVerified` from the export. Imported users keep their UID in `legacy_firebase_uid`; public IDs are new.

### E.4 Validation (must pass before cutover)

- **Counts:** per collection, the export manifest count equals the SQL row count (bookings, profiles, addresses, reviews, blackouts, admins → users.role, auth users).
- **Relationships:** 0 bookings with a `userId` that does not resolve (or listed exceptions); every address has a user; every review has a booking or an explicit null; every `payments` row has a booking.
- **Money:** the sums of `total_price`, `paid_amount` and `remaining_due` match Firestore to the cent. For each booking, `paid_amount` equals the sum of its ledger rows; mismatches are listed. Stripe succeeded PaymentIntents with `metadata.bookingId` match ledger rows 1:1.
- **Time:** for each booking, `start_at` (UTC) equals the Firestore `startAt`. A list of bookings whose stored `dateKey` ≠ the recomputed `business_date` goes to manual review.
- **Spot checks:** 20 random bookings and 10 clients compared field by field in the admin UI, old vs. new.
- **Golden tests:** PHP pricing, fee math and blackout functions produce identical outputs to the JS versions on a shared fixture set (reuse `tests/*.test.js` and `functions/test/*.mocha.cjs` cases).

### E.5 Files and historical records

- **Uploaded files:** none exist in the code. [VERIFY] whether the Storage bucket contains `invoices/*.pdf` from `generateInvoicePdf`; download them only if they exist.
- **Historical `mail` documents:** optional archive to JSON; not imported.
- **`availability` and `bookingReservations`:** not imported (derived data).

---

## F. Hostinger information and access checklist

**How to share:** send non-secret facts in chat. **Do not paste any password, key, token or credential into chat.** Secrets are entered directly into the server configuration (hPanel file manager/SFTP into the out-of-webroot config file) or into GitHub Actions Secrets.

### F.1 Hostinger

| # | Item | Why it is needed | Where to find it | When |
|---|---|---|---|---|
| 1 | Plan name and type (shared Web Hosting / Cloud / VPS) | Determines SSH, cron, workers, PHP limits and the architecture options | hPanel → Hosting → Plan details | **Now** |
| 2 | How the site is deployed today (Git auto-deploy from the `deploy` branch? Horizons? manual upload?) and the repository/branch/path configured | Must keep the current frontend pipeline working and add `/api` | hPanel → Websites → *site* → Advanced → GIT (or Horizons dashboard) | **Now** |
| 3 | Domain(s), document root path (for example `public_html` or `domains/sanchezproservices.com/public_html`), and whether a directory **outside** the document root is writable | Where the SPA, `/api` and private config/code live | hPanel → File Manager; Websites → Dashboard | **Now** |
| 4 | Available PHP versions and the selected version (need ≥ 8.1, prefer 8.2/8.3) | Language features, security support | hPanel → Advanced → PHP Configuration | **Now** |
| 5 | Enabled PHP extensions: `pdo_mysql`, `mysqli`, `curl`, `openssl`, `mbstring`, `json`, `intl`, `sodium`, `fileinfo`, `zip`; and whether PECL `scrypt` or `apcu` is available | Stripe SDK, mailer, password migration option A, rate limiting | PHP Configuration → Extensions | **Now** |
| 6 | PHP limits: `memory_limit`, `max_execution_time`, `upload_max_filesize`, `post_max_size` | Import scripts and jobs | PHP Configuration → Options | Now |
| 7 | Database engine and version (MySQL vs. MariaDB, version), number of DBs allowed, size limit, whether remote MySQL access is allowed | Schema features (JSON, `DATETIME(3)`, CTEs) and import method | hPanel → Databases → MySQL Databases / Remote MySQL | **Now** |
| 8 | Create **two** databases: `staging` and `production` (names and DB user names only; you keep the passwords) | Isolated testing | hPanel → Databases → Create | Later (build phase) |
| 9 | phpMyAdmin access (you) | Manual verification and backups | hPanel → Databases → phpMyAdmin | Later |
| 10 | SSH availability, and SFTP/FTP availability | Deployment method and running migrations/imports | hPanel → Advanced → SSH Access / FTP Accounts | **Now** |
| 11 | Composer availability (CLI over SSH) | Otherwise vendor dependencies in CI | SSH: `composer --version` | Now (if SSH exists) |
| 12 | Cron jobs: supported? minimum interval (1 min vs. 5/15 min)? PHP binary path? | Scheduled jobs (D.7) | hPanel → Advanced → Cron Jobs | **Now** |
| 13 | Outbound HTTPS from PHP allowed (to `api.stripe.com`, SMTP hosts, `identitytoolkit.googleapis.com` if option B) | Stripe calls and email | Test script on staging, or Hostinger support | Now |
| 14 | Email: are Hostinger mailboxes available on this plan, the SMTP host/port, and the **daily sending limit**; DNS access for SPF/DKIM/DMARC | Transactional email volume (bookings, reminders, resets) | hPanel → Emails; Domains → DNS Zone | **Now** |
| 15 | Where the domain DNS is managed (Hostinger or elsewhere) | SSL, email authentication, staging subdomain | hPanel → Domains | Now |
| 16 | HTTPS/SSL status and certificate type; whether HTTP→HTTPS redirect is forced | Secure cookies and Stripe | hPanel → Security → SSL | Now |
| 17 | Staging: is "Staging" (WordPress-only on some plans) or a subdomain (for example `staging.sanchezproservices.com`) available, and can it be password-protected? | Pre-production testing with Stripe test mode | hPanel → Domains → Subdomains | Later |
| 18 | Backups: automatic schedule, retention, on-demand backup and restore of files and DB | Rollback plan | hPanel → Files → Backups | **Now** (and before cutover) |
| 19 | Logs: access/error logs, PHP error log location | Debugging and monitoring | hPanel → Advanced → Logs / File Manager | Later |
| 20 | Environment variable support for PHP (hPanel or `.htaccess SetEnv`), or confirmation that an out-of-webroot config file is acceptable | Secure configuration | Hostinger docs/support | Later |
| 21 | Disk/inode quota and PHP worker/entry-process limits | Logs, polling load | Plan details | Later |
| 22 | Whether a CDN/cache is active (Hostinger CDN / LiteSpeed cache) and whether `/api/*` can be excluded | Prevents caching private JSON. The current `.htaccess` sets `Cache-Control: public, s-maxage=604800` globally, which **must not** apply to `/api`. | hPanel → Performance → CDN / Cache | **Now** |
| 23 | Deployment credentials for CI (SFTP user or SSH key), if you want GitHub Actions to deploy the API | Repeatable deploys | Create in hPanel; store in GitHub **Secrets** | Later |

### F.2 Firebase / Google Cloud

| # | Item | Why | Where | When |
|---|---|---|---|---|
| 1 | Confirm the project `sanchez-services-11fd0` and your role (Owner/Editor) | Export permissions | Firebase Console → Project settings → Users and permissions | **Now** |
| 2 | Billing plan (Spark/Blaze) | Managed exports and Functions require Blaze | Console → Usage and billing | Now |
| 3 | List of **deployed** functions and their last deploy time (does it include `sendAppointmentReminders`?) | Confirms what is live vs. the repo | Console → Functions | **Now** |
| 4 | Functions runtime environment variables, **names only**, especially whether `TZ` is set | Time-zone correctness (H.1) and config parity | Google Cloud Console → Cloud Functions → *function* → Variables | **Now** |
| 5 | Installed Extensions (Trigger Email?) and their non-secret parameters (collection name, default FROM, SMTP host name — not the password) | Email replacement parity | Console → Extensions | **Now** |
| 6 | Authentication: enabled sign-in providers, user count, count of Google-provider users, email template customizations | Auth migration choice (E.3) | Console → Authentication → Sign-in method / Users / Templates | **Now** |
| 7 | Password hash parameters (enter into secure config later; **do not paste**) | Option A | Authentication → Users → ⋮ → Password hash parameters | Later |
| 8 | Firestore document counts per collection (approximate), and whether `payments`, `reports`, `services`, top-level `addresses` contain documents | Import scope | Console → Firestore → Data | **Now** |
| 9 | Composite indexes actually deployed (compare with `firestore.indexes.json`; note `contactEmailLower+startAt` is missing) | Explains current client-portal errors | Firestore → Indexes | Now |
| 10 | Storage bucket contents (any `invoices/`) | File migration | Console → Storage | Now |
| 11 | A read-only **service account** for export (roles: Cloud Datastore Viewer + Firebase Authentication Viewer, or a temporary Firebase Admin), with the key file kept on your machine | Running the export script | Google Cloud Console → IAM → Service accounts | Later (export phase) |
| 12 | Cloud Scheduler jobs list | Confirm schedules to disable at cutover | Google Cloud Console → Cloud Scheduler | Later |
| 13 | App Check / reCAPTCHA enforcement status | Dead `VITE_RECAPTCHA_SITE_KEY` | Console → App Check | Now |

### F.3 Stripe

| # | Item | Why | Where | When |
|---|---|---|---|---|
| 1 | Account access (Developer role or higher) with test mode | Build and test | dashboard.stripe.com → Settings → Team | **Now** |
| 2 | Current webhook endpoints (URL and subscribed events) | Redirect plan | Developers → Webhooks | **Now** |
| 3 | API version pinned on the account/webhook | PHP SDK compatibility | Developers → API version | Now |
| 4 | Restricted or secret key for **test mode** (enter into staging config; do not paste) | Staging | Developers → API keys | Later |
| 5 | New webhook endpoint for staging (`…/api/stripe/webhook`) and its signing secret (into config) | Staging tests | Developers → Webhooks → Add endpoint | Later |
| 6 | Production webhook endpoint for the PHP URL, its signing secret, and the plan to disable the Firebase endpoint | Cutover | Same | Cutover |
| 7 | Payments export (CSV or API) covering all history | Ledger reconciliation (E.1-4) | Payments → Export | Export phase |

### F.4 Secret names for the PHP config (values never in chat or git)

`APP_ENV`, `APP_URL`, `APP_KEY` (random 32+ bytes, for HMAC/CSRF), `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_ENCRYPTION`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO`, `ADMIN_NOTIFICATION_EMAILS`, `JOB_RUNNER_TOKEN`, `BUSINESS_TIMEZONE`, optional `FIREBASE_WEB_API_KEY` (option B only), optional `FIREBASE_SCRYPT_SIGNER_KEY`, `FIREBASE_SCRYPT_SALT_SEPARATOR`, `FIREBASE_SCRYPT_ROUNDS`, `FIREBASE_SCRYPT_MEM_COST` (option A only), and optional `CAPTCHA_SECRET`.

Business settings (capacities, deposit, TTLs) go in the `settings` table, not in secrets.

**How to configure securely:**
- Create `config/.env.php` outside `public_html` with permissions `0600`, using File Manager or SFTP, separately for staging and production.
- If CI deploys, store the values as GitHub **Secrets** (not Variables) and write the file during the deploy step without echoing it.
- Rotate the Stripe and SMTP credentials after cutover if they were ever shared informally.

---

## G. Migration phases, dependencies and acceptance tests [REC]

| Phase | Work | Depends on | Exit / acceptance criteria |
|---|---|---|---|
| 0. Decisions and facts | Answer the F.1–F.3 "Now" items and the H questions. Decide password option A/B/C, the time-zone fix, and the D.10 behavior changes. | — | Written answers; architecture confirmed for the actual plan |
| 1. Skeleton | Repo folder `backend/` + CI job (PHPUnit, php-lint, vendor bundle); deploy to staging subdomain; `/api/health`; `.htaccess` excludes `/api` from SPA rewrite and CDN cache | 0 | Health OK on staging over HTTPS; secrets loaded from out-of-webroot config; cache headers on `/api` are `no-store` |
| 2. Schema + domain ports | Migrations; port Pricing, PaymentMath, BlackoutDates and PaymentApplier with golden tests | 1 | 100% parity on fixtures (including all existing JS test cases) |
| 3. Auth (G1) | Register/login/logout/me, reset, email change, roles, CSRF, rate limits, sessions | 2 | Tests: login success/failure, lockout, reset token single-use/expired, CSRF rejection, admin route 403 for clients, session regenerated on login |
| 4. Profiles and addresses (G2) | Endpoints + frontend swap behind `VITE_BACKEND=php` | 3 | Owner-only access tests; protected fields (`role`, `ltv`) rejected |
| 5. Booking engine + payments (G3+G4) | Availability, check, checkout (Stripe **test mode**), webhook, recovery, expiry, reschedule, cancel, balance payment | 2–4 | See G.1 |
| 6. Email and jobs (G5+G6) | Outbox, templates, reminders, cron or pinger | 5 | Reminder windows (47–49 h, 23–25 h) fire once; reschedule resets flags; each event yields exactly one client email (staging uses a sandbox SMTP/mail catcher) |
| 7. Admin (G8) + reviews (G7) | All admin screens on API; polling | 5–6 | Admin parity checklist: every screen in table C loads the same records as production for a copied dataset |
| 8. Data rehearsal | Export production → import into **staging** DB; run E.4 validation; UAT by owner | 7 | All E.4 checks green; owner sign-off |
| 9. Cutover | See G.2 | 8 | See G.2 |
| 10. Decommission | After 30–60 days stable: disable Firebase functions and schedules, then (optionally) delete; keep the Firestore export archived | 9 | No traffic to Firebase endpoints (check Functions logs); Stripe has no events to the old endpoint |

### G.1 Booking/payment acceptance tests (staging, Stripe test mode only)

1. Two concurrent checkouts for the same slot (parallel `curl`): exactly one succeeds and the other gets "already-exists". Seven concurrent checkouts on one day with capacity 6: at most 6 are created.
2. The same `requestId` submitted twice returns the same booking and the same session (idempotent).
3. Blackouts:
   - An all-day single date blocks only that date.
   - A multi-day range uses an exclusive end date.
   - A timed blackout blocks only the overlapping slots.
   - Boundary: a 15:00 booking ending at 17:30 on the day before an all-day blackout is allowed.
4. Time zone: a 09:00 ET slot is stored as 13:00/14:00 UTC (DST-aware), shown as 9:00 AM in the UI and emails, and `business_date` is correct across the DST change dates (2026-03-08 and 2026-11-01).
5. Webhook:
   - Valid signature → booking `confirmed`, deposit paid, one ledger row.
   - Replay of the same event → no change (`stripe_events` dedupe).
   - Different event id with the same PI → no double-count (unique PI).
   - Invalid signature → 400.
   - Amount mismatch → 500, logged, booking unchanged.
   - Out-of-order delivery after expiry → payment still applied, status rules identical to `buildPaymentPatch`.
   - Event types other than `payment_intent.succeeded` → 200, ignored.
6. Recovery job: a completed session with a dropped webhook is recovered within one run; an expired session marks the booking `expired`.
7. Remaining-balance payment marks the booking `completed` with `remaining_due = 0`.
8. Ownership: user B cannot read, cancel, reschedule, pay or review user A's booking (403). An unverified email cannot claim email-matched bookings.
9. Invoices: client and admin invoices show identical totals (the `payments.js` output is unchanged for the same booking JSON).

### G.2 Cutover runbook (low-traffic window, announced)

1. Take a Hostinger full backup (files + DB) and a Firestore managed export, and save the Auth export.
2. Put the booking UI in **maintenance mode for writes**: a banner, with checkout and reschedule disabled through a feature flag in the current Firebase build. The public site stays up.
3. Wait for in-flight Checkout Sessions: TTL of 30 min, or until `pending_payment` = 0.
4. Final export, import into the production DB, and the E.4 validation (automated, report saved).
5. In Stripe, add the production PHP webhook endpoint with the same event types. Keep the Firebase endpoint **enabled but paused**: disable it right after verifying the new one receives a test event. The PHP webhook resolves bookings by `public_id` = the old Firestore id, so old sessions remain valid.
6. Deploy the PHP API and the new frontend build (`deploy` branch, via the existing mechanism).
7. Enable cron/pinger jobs. In Google Cloud Console, **pause** the Cloud Scheduler jobs for the 3 scheduled functions so emails and expiries do not run twice. Do **not** delete anything.
8. Smoke tests in production with an owner test account: login, view bookings, availability, one **real low-value** booking only if the owner approves (otherwise Stripe test mode on staging is the final proof), admin views.
9. Send password-reset emails if option C or the fallback is used.
10. Monitor logs, the outbox and Stripe webhook deliveries for 48 hours.

### G.3 Rollback

- **Within the first hours** (no new data on PHP): switch the `deploy` branch back to the previous build commit, re-enable the Firebase Stripe webhook and the Scheduler jobs, and disable the PHP webhook. Firestore is untouched, so this is lossless.
- **After new bookings exist on PHP:** run the reverse sync script (`bin/export-delta.php` → Node `import-to-firestore.js`, to be written and rehearsed in phase 8) for rows with `created_at`/`updated_at` greater than the cutover time, then the same switch-back. Rehearse the rollback once on staging.
- Keep Firebase fully intact (only paused) until phase 10.

---

## H. Blockers, unresolved questions and items not verified

### H.1 High-impact findings in current code (fix in the PHP design; confirm current production impact)

1. **Time zone (VERIFY urgently).** Cloud Functions run in UTC unless `TZ` is set. `functions/index.js` computes day bounds (`setHours(0,0,0,0)`), `toDateKey` and, in `getDayAvailability`, slot times (`new Date(year, month, day, hour)`) using server-local time. Email times use `toLocaleDateString`/`toLocaleTimeString` with no time zone. If `TZ` is unset, slot "09:00 AM" is evaluated as 09:00 UTC (05:00 ET), so per-slot conflict counts are misaligned with real bookings, and emails show UTC times. Check by reading a recent "received"/reminder email, or the functions' env vars.
2. **Client portal booking queries:** the phone-based listeners cannot satisfy the rules, and `contactEmailLower + startAt` has no composite index in `firestore.indexes.json`. Both fail silently in the console. Users whose bookings are not linked by `userId`/`ownerKeys` may not see them.
3. **Admin writes bypass the reservation lock:** inline reschedule, modal edit and calendar drag-drop. The inline reschedule does not move `endAt`; drag-drop does not update `scheduledAt`/`timeLabel` and computes `dateKey` in UTC.
4. **Duplicate client emails** when an admin changes status or reschedules (browser `mail` doc + `enqueueBookingEmail`).
5. **Webhook idempotency** relies on booking fields only. There is no event store; fixed in the PHP design.
6. The `sweepCompleteBookings` default **hard-deletes** any booking whose notes contain "test" (case-insensitive substring, which also matches words such as "latest" or "contest").
7. `cancelBooking` has no status guard.
8. The legacy `addresses/{uid}` read is always denied (dead migration path).
9. HTML email templates interpolate user data without escaping.

### H.2 Questions for you

1. Do you also have a local copy on your computer with unsynced work? If yes, run A.4 there and tell me the output of the two `git log` commands. Do not send file contents.
2. Branch `codex/audit-dev-vs-production-behavior-discrepancies`: keep for reference, cherry-pick specific ideas, or archive? I recommend not merging it (it is stale and diverged).
3. Business time zone: confirm `America/New_York` (RI/MA).
4. Password migration preference: A (no resets), B (temporary Google dependency) or C (everyone resets)?
5. Do any customers sign in with Google? (Check Firebase Auth → Users → Providers.)
6. Approve or decline each recommended behavior change in D.10.
7. Is "real-time" required anywhere (for example, the admin calendar updating within seconds), or is 30–60 s polling acceptable?
8. Which email address should send transactional mail, and which should receive admin notifications? (Names only; mailbox credentials go into config.)
9. Should guest booking or booking-claim features be added? They do not exist today and are out of scope for a like-for-like migration.

### H.3 Could not verify from this environment

- Your local computer's copy (not reachable).
- Hostinger plan, PHP/DB versions, SSH/cron/Composer, email limits, backups, and how Hostinger pulls the `deploy` branch.
- Which Cloud Functions are actually deployed and their environment variables (including `TZ`); whether `sendAppointmentReminders` is live.
- The Trigger Email extension's existence and configuration (the code assumes something consumes `mail`).
- Firestore document counts; whether `payments`, `reports`, `services` and top-level `addresses` contain data; deployed indexes vs. the repo file.
- Firebase Auth providers, user count and password hash parameters.
- Stripe webhook endpoints, API version and event history.
- App Check/reCAPTCHA enforcement.
- Production behavior. No production endpoint was called, and no booking, payment, email or data write was made.

### H.4 Minor repository observations

- `README.md` and `functions/README.md` are outdated (the latter describes only the sweep).
- `src/lib/CONTACT_MODEL.md` references `scripts/migrate-fullname-to-name.js` and a `migrateProfiles_fullNameToName` function, neither of which exists.
- `@stripe/stripe-js` is installed but unused.
- `src/lib/sweep.ts` duplicates the `MaintenanceView` sweep call and is unused.
- `DevSeedPage.jsx` is unrouted.
- The main JS bundle is 2.2 MB and several images exceed 2 MB (optimize during the frontend swap).
- The global `.htaccess` `Cache-Control: public, s-maxage=604800` would cache API responses on a CDN if left unchanged.

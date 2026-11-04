# PHP Migration — Implementation Status

- **Baseline:** `origin/main` @ `c4e06ea` ("Add appointment reminder emails"). Codex branch left untouched.
- **Work branch:** `claude/dreamy-goldberg-vo1q9w` (not merged; nothing deployed; Firebase/Google services untouched).
- **Companion docs:** `MIGRATION_AUDIT.md` (audit + design), `backend/README.md` (developer/ops guide).

## 1. What is implemented

| Area | Files | Notes |
|---|---|---|
| Schema + migration runner | `backend/migrations/001_initial.sql`, `backend/bin/migrate.php` | MySQL 8 / MariaDB 10.6+. Collection tables keep the canonical document (`doc_json`, Firestore field names) plus indexed projections; users, payments ledger, Stripe events, email outbox, sessions, rate limits, audit log and day locks are relational. |
| Authorization | `backend/src/Store/Rules.php` | Port of `firestore.rules` (admin, booking ownership, safe profile/booking updates, review validation). Server functions additionally honor `admin_emails` / `admin_uids` exactly like `isAdminServer`. |
| Firestore-compatible gateway | `backend/src/Controllers/GatewayController.php`, `Store/QueryEngine.php`, `Store/DocumentStore.php` | Same query semantics as Firestore (missing vs null, `orderBy` exclusion, type ordering, `array-contains`, `in`, `!=`, limits). Admin writes are audit-logged. |
| Booking engine | `backend/src/Domain/Bookings.php`, `Pricing.php`, `BlackoutDates.php`, `Slots.php` | Atomic per-day reservation lock, slot and daily capacity, blackouts (exclusive end date), availability and conflict checks. |
| Payments | `Domain/Payments.php`, `Domain/PaymentAmounts.php`, `Domain/PaymentMath.php`, `Infra/StripeClient.php`, `Controllers/StripeWebhookController.php` | Deposit + remaining-balance checkout, fee pass-through, webhook signature check, event-id dedupe, row-locked idempotent payment application, payment ledger. |
| Emails | `Domain/BookingEvents.php`, `Domain/Outbox.php`, `Infra/Mailer.php` | Same client/admin templates and dedupe as `enqueueBookingEmail`, reminders, and password reset. Sent after the response, with cron retries. |
| Scheduled jobs | `Jobs/Jobs.php`, `bin/job.php`, `/api/jobs/run` | Expire pending (10 min), recover missed webhooks (15 min), reminders (60 min), outbox retries, housekeeping. Cron or token-protected web trigger. |
| Callables + sweep | `Controllers/FunctionsController.php`, `Controllers/OpsController.php` | All functions the frontend calls; same inputs, outputs and error codes. |
| Auth | `Auth/*`, `Security/*`, `Controllers/AuthController.php` | Register, login, logout, password reset (single-use, 60 min), change email (recent login), lockout, rate limits, DB sessions (HttpOnly, SameSite=Lax, Secure), CSRF, origin check. |
| Frontend integration | `src/lib/php-backend/*`, `vite.config.js`, `src/pages/ResetPasswordPage.jsx`, `src/App.jsx` | Opt-in `VITE_BACKEND=php` swaps the Firebase SDK for a shim with the same API, so components are unchanged. Default builds are still pure Firebase. |
| Data migration | `backend/tools/migration/export-firestore.cjs`, `bin/import-firestore.php`, `bin/validate-import.php`, `src/Migration/*` | Read-only export, checksummed manifest, idempotent import with dry run, validation (counts, per-document equality, timestamps, money, relationships). |
| Password-hash compatibility tool | `src/Migration/FirebaseScrypt.php`, `bin/check-firebase-password-hash.php` | **Not wired into login** (decision D1). |
| Packaging | `backend/deploy/build-release.sh`, `deploy/hostinger/root.htaccess`, `deploy/hostinger/host-check.php` | Builds a release locally; deploys nothing. |
| CI | `.github/workflows/backend-tests.yml` | Tests only; never deploys; no secrets. |

## 2. What was tested (all local; no production calls)

| Test | Result |
|---|---|
| PHPUnit (`backend/vendor/bin/phpunit`) | **34 tests, 19,144 assertions, all passing** |
| JS parity: 400 pricing cases, fee math, payment amounts and status, payment patch, slot labels, blackout date keys (including DST dates), reminder notes, addresses | Identical to the current JavaScript. A float-rounding difference (`toFixed`) was found and fixed. |
| Concurrency: 5 users booking the same slot simultaneously | Exactly 1 booking created; 4 rejected with `already-exists` |
| Webhook: bad signature, stale timestamp, replay, second event for the same PaymentIntent, amount mismatch, unrelated event type | 400 / 400 / deduped / no double count / 500 with booking unchanged / ignored |
| Jobs: expire, recover (paid and expired sessions), 48 h reminder once, outbox delivery, web-cron token | Pass |
| Rules: profile protected fields, other users' data, admin-only blackouts and mail, review validation, client booking-field whitelist | Pass |
| Migration rehearsal on the **Firestore emulator** (real export script), then import dry run, apply, re-run and validate | Pass; tampered exports are rejected |
| Imported customer: reset password, sign in, see migrated booking, preferences and address; imported owner keeps admin access | Pass |
| Browser E2E (Chromium) of the PHP-mode site against the PHP API: signup, booking form, Stripe redirect, webhook, confirmation, portal, all 8 admin screens | Pass |
| Same E2E against **Apache + mod_php using the release layout and `.htaccess` files** | Pass. Caught and fixed a `.htaccess` rule that would have blocked every API call. |
| Existing repo checks: `npx vitest --run`, `npm --prefix functions test`, both Vite builds | Pass |

**Not tested yet:** the Hostinger server itself, real SMTP delivery, real Stripe test mode, a real Firestore export, a real Firebase password hash from your project, and LiteSpeed-specific `.htaccess` behavior (Apache-compatible, but unverified).

## 3. Necessary migration changes (implemented)

These are unavoidable, or required to run without Firebase.

1. **Sessions replace Firebase tokens.** Everyone signs in again at cutover.
2. **Passwords.** Imported accounts have no usable password until reset. Login returns `auth/password-reset-required` with a clear message. See D1.
3. **Password-reset page** at `/auth/reset` (Firebase hosted this page before). Reset emails come from your SMTP.
4. **Near-real-time instead of real-time.** Lists refresh every 30 s (configurable), immediately after your own changes, and when the tab regains focus.
5. **Google sign-in** is not available in PHP mode. The UI never offered it, but check for existing Google accounts (D2).
6. **Explicit business timezone** (`America/New_York`) for day boundaries, slot times and email times. This is the intended behavior; Cloud Functions depended on the process `TZ`.
7. **Hardening with no visible change for normal input:** HTML-escaping in email templates, CSRF/origin checks, rate limits, login lockout, webhook event dedupe, audit log of admin writes, `no-store` on API responses.
8. **Not migrated because unused:** `generateInvoicePdf` (invoices are generated in the browser), the `availability` cache collection (computed live instead), Cloud Storage.

## 4. Preserved quirks and optional behavior changes (NOT implemented — your choice)

The PHP backend deliberately reproduces current behavior, including these. Each can be changed later on request.

| # | Current behavior (kept) | Optional change |
|---|---|---|
| O1 | Within 10 minutes of a reschedule email, a cancellation sends no admin email (trigger dedupe returns early) | Always notify the admin |
| O2 | Admin status change / reschedule sends the client two emails (browser mail + trigger) | One email per event |
| O3 | Admin edits, inline reschedule and calendar drag-drop skip the conflict/blackout lock; drag-drop doesn't update `scheduledAt`/`timeLabel` and uses a UTC `dateKey`; inline reschedule doesn't move `endAt` | Route through the reservation engine |
| O4 | Admin Bookings table "Amount" column shows $0 for online bookings (reads `amount`/`price`/`cost`, not `totalPrice`) | Show `totalPrice` |
| O5 | Client cancel has no status/time guard | Block cancelling completed/expired/refunded bookings |
| O6 | Maintenance sweep hard-deletes bookings whose notes contain "test" | Soft-delete / dry-run default |
| O7 | Availability uses client-sent capacities; Sunday/Saturday rules exist only in the browser | Enforce server-side |
| O8 | Email-matched booking access does not require a verified email (same as Firebase rules) | Config flag `auth.require_verified_email_for_email_match` (built, off) |
| O9 | Client portal phone-number queries return nothing (Firebase rules reject them today) | Leave as is (recommended) |
| O10 | Legacy `addresses/{uid}` read returns permission-denied and is logged in the console | Remove the dead code path |

## 5. Decisions needed from you (blocking the related work)

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Existing passwords | (a) Everyone resets (built, default). (b) Import Firebase hashes and verify on first login. Verifier built and matches Firebase's published example; still needs your project's hash parameters, one real test account, and a timing check on Hostinger (~2.5 s per check in the sandbox). (c) Temporary Firebase REST login bridge (keeps a Google dependency). | Run the compatibility check first. If it passes on Hostinger, use (b) with (a) as fallback; otherwise (a). I have **not** wired (b) into login. |
| **D2** | Google-sign-in accounts (count shown by the import report) | Reset to email/password, or build Google OAuth in PHP | Reset, unless there are many |
| **D3** | Legacy bookings with `contact.email` but no `emailLower`/`ownerKeys` (not visible to the customer today) | Keep, or backfill lowercase email fields so customers see them | Decide after seeing counts from a real export dry run |
| **D4** | Bookings whose stored `dateKey` differs from the business date (UTC artifact; listed by the import report) | Keep as stored, or correct | Correct (display uses `startAt`) — after review |
| **D5** | Collections with no code (`payments`, `reports`, `services`, `availability`, `mail`) | Archive in export only, or import | Archive only |
| **D6** | Session length | 14 days (default) or other | 14 days |
| **D7** | Cutover window and customer notice (and whether to bulk-email reset links) | — | Low-traffic evening; email reset links if D1 = (a) |
| **D8** | Which optional changes (O1–O10) to adopt, and when | — | After cutover, one at a time |

## 6. Hostinger information needed (configuration only — no passwords or keys)

Please send these as plain facts. Running `backend/deploy/hostinger/host-check.php` over SSH answers most of them at once (it is read-only and prints no secrets). **Don't send any password**; use SSH-key login.

### A. Blocks finalizing the architecture

| # | Item | Why | Where to find it |
|---|---|---|---|
| A1 | Hosting plan name/type (Premium/Business shared, Cloud, VPS) | Cron frequency, PHP worker/memory limits, whether D1(b) is affordable | hPanel → Hosting → Plan details |
| A2 | Database engine and version (MySQL 8.x or MariaDB 10.x/11.x) | Schema/locking features; tested on MariaDB 10.11 | hPanel → Databases → MySQL Databases, or `mysql --version` over SSH |
| A3 | Home directory and the domain's document root path; confirm a folder **outside** it is writable | Code and config must sit outside the web root | `host-check.php` (`home_dir`, `candidate_document_roots`), or hPanel → File Manager |
| A4 | How the site is deployed today (Hostinger Git auto-deploy? which repo/branch/folder? Horizons?) | Decides how releases reach the server without breaking today's pipeline | hPanel → Websites → *site* → Advanced → GIT (or Horizons dashboard) |
| A5 | Web PHP settings: version, enabled extensions (`pdo_mysql`, `curl`, `openssl`, `mbstring`, `sodium`), `memory_limit`, `max_execution_time` | Web PHP can differ from SSH PHP | hPanel → Advanced → PHP Configuration (or `host-check.php` opened once in the browser, then deleted) |
| A6 | Cron jobs available? Minimum interval? | Jobs every 5–15 min; otherwise use the external web-cron fallback | hPanel → Advanced → Cron Jobs |
| A7 | Outbound HTTPS from PHP to `api.stripe.com` and your SMTP host | Checkout, webhook recovery, email | `host-check.php` output |
| A8 | Email: Hostinger mailbox available? SMTP host/port and **daily sending limit**; which address should send | Booking emails, reminders, resets | hPanel → Emails → *mailbox* → Configuration |

### B. Needed only for deployment and cutover

| # | Item | Why | Where |
|---|---|---|---|
| B1 | Create two databases (staging, production): send **names, user names and host only** | Isolated testing | hPanel → Databases → MySQL Databases |
| B2 | A staging subdomain (e.g. `staging.sanchezproservices.com`), ideally password-protected | Test with Stripe test mode before cutover | hPanel → Domains → Subdomains; Advanced → Password Protect Directories |
| B3 | SSL status for the domain and staging subdomain | Secure cookies, Stripe | hPanel → Security → SSL |
| B4 | CDN/cache on or off, and whether `/api/*` can be excluded | API responses must never be cached | hPanel → Performance → CDN |
| B5 | Backup schedule/retention and how to restore | Rollback | hPanel → Files → Backups |
| B6 | Where PHP error logs are | Troubleshooting | hPanel → Advanced → Logs / File Manager |
| B7 | DNS host and ability to add SPF/DKIM/DMARC records | Deliverability | hPanel → Domains → DNS Zone (or your registrar) |
| B8 | SSH **key** access for deployment (add a public key; never share the private key or password) | Repeatable deploys | hPanel → Advanced → SSH Access → SSH keys |

### C. Firebase / Google Cloud and Stripe (later, export phase)

| Item | Why | Where |
|---|---|---|
| Deployed functions list and env-var **names**; is `TZ` set? | Confirms production behavior (timezone) | Google Cloud Console → Cloud Functions |
| Trigger Email extension parameters (collection name, FROM address — not the SMTP password) | Email parity | Firebase Console → Extensions |
| Auth: providers, user count, Google-provider count | D1/D2 | Firebase Console → Authentication |
| A read-only service account (Cloud Datastore Viewer); keep the key file on your machine | Export script | Google Cloud Console → IAM → Service accounts |
| Password hash parameters (into a local file; **don't paste**) + one test account you control | D1 compatibility check | Authentication → Users → ⋮ → Password hash parameters |
| Stripe test-mode secret key and a staging webhook endpoint + signing secret (entered on the server only) | Staging tests | Stripe Dashboard → Developers |
| Stripe account API version and current webhook endpoints | Cutover redirect | Stripe Dashboard → Developers → Webhooks |

**Secret names** the server config needs (values entered only on the server, in `ss-app/config/config.php` with permissions 600): `app.key`, `db.password`, `stripe.secret_key`, `stripe.webhook_secret`, `mail.password`, `jobs.runner_token`.

## 7. Remaining work

| Blocked on | Work |
|---|---|
| A1–A8 | Finalize folder layout, cron vs web-cron, email transport; adjust `build-release.sh` paths |
| B1–B8 + Stripe test keys | Deploy to staging, run Stripe test-mode checkout end to end, real SMTP test, UAT |
| D1 (+ Firebase hash params) | Either wire the verified hash path into login or finalize the reset-everyone flow and email |
| D2–D5 | Import options and backfills |
| Real export | Rehearsal import into staging with `validate-import.php` passing |
| Cutover | Follow `MIGRATION_AUDIT.md` section G.2 (backups, write freeze, final export/import/validate, Stripe webhook switch, pause Cloud Scheduler — no deletions). Rollback per G.3. |

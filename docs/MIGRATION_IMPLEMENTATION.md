# Hostinger PHP migration — implementation status

- **Baseline:** `origin/main` @ `c4e06ea`. **Work branch:** `claude/dreamy-goldberg-vo1q9w` (not merged, nothing deployed).
- Production still runs on Firebase. No Google resource, live data or Stripe live-mode object was touched.
- Companion docs: `MIGRATION_AUDIT.md` (original audit), `backend/README.md` (developer/ops guide),
  `docs/CUTOVER_RUNBOOK.md` (deployment, data migration and rollback steps).

This is a **rework**, not a compatibility port: the earlier Firestore-emulating shim was removed. The React app keeps
its look and screens but talks to a typed REST API, and every business rule is enforced on the server.

## 1. Architecture

```
Browser (React SPA, unchanged design) ──fetch──> /api/*  (public_html/api/index.php → ss-app outside web root)
                                                   │
             Http/Kernel (routes, CSRF, origin check, rate limits, sessions)
                                                   │
   Domain: BookingService · Schedule · Pricing · Ledger · Checkout · Notifier · Outbox     Jobs (cron)
                                                   │
                                MySQL/MariaDB (relational schema, InnoDB)
Stripe Checkout ⇄ /api/stripe/webhook + success-page sync + reconcile job          SMTP (PHPMailer)
```

| Concern | Design |
|---|---|
| Data | Relational tables: `users`, `client_profiles`, `addresses`, `bookings`, `booking_history`, `payments` (ledger), `checkout_sessions`, `stripe_events`, `blackouts`, `reviews`, `email_outbox`, `auth_tokens`, `sessions`, `rate_limits`, `audit_log`, `job_runs`. |
| Time | Stored in UTC; every business rule (slots, day boundaries, cut-offs, invoices, emails, UI) uses America/New_York. |
| Booking conflicts | One code path (`Schedule::assertAvailable`) for client create, admin create, client/admin reschedule, duration edits and calendar drag-drop, under a per-day row lock (`booking_day_locks … FOR UPDATE`). Unpaid online bookings hold their slot for 30 minutes. |
| Money | The `payments` ledger is the only source of truth; `amount_paid` and `payment_status` are recomputed from it after every change. Card fees are tracked separately from the amount credited. |
| Stripe | Checkout Sessions created server-side with server-computed amounts; payments are applied only after verifying amount, currency and booking reference with Stripe (webhook **or** success-page sync **or** reconcile job — idempotent on the PaymentIntent). Card refunds go through the Stripe Refund API. |
| Email | Transactional outbox with a dedupe key per event (exactly-once), sent after the response and retried by cron. |
| Auth | DB sessions (HttpOnly cookie), CSRF header, origin check, lockout and rate limits, email verification, password reset. Imported accounts set a new password via reset (or keep their Firebase password if decision D1 is approved). |
| Authorization | Clients only see and change their own bookings (others get 404); admins/owners use `/api/admin/*`. |

## 2. Defects fixed (found in the old site or during this work)

| Defect | Fix |
|---|---|
| Booking `dateKey` computed in UTC (evening appointments filed under the next day) | Business date always derived from the appointment time in America/New_York; importer recomputes and reports mismatches. |
| Different conflict logic per path; admin edits and reschedules could double-book | Single locked availability check for every path. |
| Prices and totals trusted from the browser | Server quote is the only price; admin overrides recorded as an explicit "Price adjustment" line. |
| Paid amounts scattered across ~20 legacy fields; admin "Amount" column showing $0 | Payments ledger; consistent API fields everywhere. |
| Cancellation window shown as 48 h in places vs 24 h in the Terms | One config value (24 h) used by server, portal and booking page. |
| Client portal showed times in the viewer's timezone | All formatting in America/New_York. |
| Stale Stripe sessions still payable after an offline payment (double payment) | Sessions whose amount no longer matches what is due are expired after every ledger/price change; reconcile retries. |
| Browser wrote emails to the `mail` collection | Server outbox only; templates escaped. |
| Booking details crashed on object addresses; notes saved to the wrong field; fixed 5.0 rating; upcoming visits counted as cleanings | Fixed in the portal components. |
| Deadlock 500 when many people book the same new day at once | Lock rows only inserted when missing; transactions retry deadlocks with jitter. |
| Void of a refunded payment produced a negative balance | Blocked. |
| Spreadsheet formula injection in CSV exports | Values starting with `= + - @` are quoted. |

## 3. Testing done

| Test | Environment | Result |
|---|---|---|
| PHPUnit: 27 tests / 18.5k assertions (booking workflow, ledger, Stripe webhook + sync + reconcile, emails exactly once, auth/accounts, import, JS pricing parity on 400 cases) | PHP 8.3, MariaDB 10.11, fake Stripe API | Pass |
| Vitest (frontend model/API helpers) | Node 22 | 18 pass |
| Release build (`backend/deploy/build-release.sh`) served by **Apache 2.4 + mod_php** with the production `.htaccess` files and config outside the web root | Local | Pass; security headers, 403 on internal files, SPA deep links, API 404/401, CSRF and foreign-origin rejection verified |
| Browser E2E (Chromium): sign-up → verification email → booking form → **real Stripe test-mode Checkout page** (amount, fee line, invoice number, customer email verified) | Apache + real Stripe test mode + real SMTP delivery | Pass |
| Forged/early return to the success page does not confirm an unpaid booking | same | Pass |
| Admin UI: record Zelle deposit → booking confirmed → confirmation email delivered | same | Pass |
| **Real Stripe test charge** (PaymentIntent, test card) recorded on the booking; **refund issued from the admin UI through the Stripe Refund API** (`re_…` verified at Stripe) | Stripe test mode | Pass |
| All real Stripe events for that charge/refund replayed into the webhook (signed with the local secret), plus a duplicate and a bad signature | same | 200 / deduplicated / 400; no double refund |
| Client portal: dashboard, payments page, balance checkout (amount + fee), invoice, reschedule (+ email), notes, cancel (+ client and admin emails) | same | Pass (after the portal fixes above) |
| Admin screens: dashboard, bookings, calendar, clients, payments ledger, reviews, reports, system status | same | Render real data, no client-side errors |
| Concurrency on Apache (multi-process PHP): 20 clients booking the same slot at once; 20 mixed overlapping requests; duplicate double-submit | MariaDB | Exactly one booking per slot every run; overlaps rejected; double-submit idempotent |
| Import of the sample export produced by the real export script from the Firestore emulator; dry run, apply, validate, tamper detection | MariaDB | Pass |

### Not tested against the real services (and why)

- **Completing a card payment on the hosted Stripe Checkout page.** This sandbox's network proxy substitutes the account's
  secret key on every request to api.stripe.com — including the browser's — so Stripe rejects the page's card submission;
  hCaptcha is also blocked. Everything server-side was exercised against real Stripe test mode (sessions, retrieval,
  expiry, PaymentIntents, refunds, events). The webhook → confirmation path is covered with the fake Stripe API in PHPUnit.
  **To do on staging:** one real test-card payment through Checkout with the real webhook endpoint.
- **Stripe delivering webhooks to the server** (needs a public URL): do on staging with a test-mode endpoint.
- **Hostinger SMTP** (TLS/SSL, authentication, deliverability/SPF/DKIM): emails were delivered over plain SMTP to a local
  capture server. **To do on staging.**
- **Hostinger itself** (LiteSpeed `.htaccess` handling, PHP-FPM settings, cron, MySQL version): Apache-compatible and tested
  on Apache only.
- **A real Firestore export and real Firebase password hashes**: the importer was tested with the emulator export and
  synthetic data; it must be rehearsed with the real export before cutover.

## 4. Open decisions

Listed in `docs/CUTOVER_RUNBOOK.md` §0. Current defaults live in `backend/src/Config.php`.

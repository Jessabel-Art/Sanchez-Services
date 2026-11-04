# Sanchez Services — PHP backend

Replaces Firebase Auth, Cloud Firestore and Cloud Functions with PHP 8.2 + MySQL/MariaDB for Hostinger.
**Status:** built and tested locally; **not deployed**. Production still runs on Firebase.
See [`../docs/MIGRATION_IMPLEMENTATION.md`](../docs/MIGRATION_IMPLEMENTATION.md) for status, decisions and the cutover plan.

## How it fits together

```
Browser (same React app)
  └─ built with VITE_BACKEND=php → src/lib/php-backend/* replaces the Firebase SDK
       ├─ firebase/firestore  → POST /api/db/get | /api/db/query | /api/db/commit
       ├─ firebase/auth       → /api/auth/*   (HttpOnly session cookie + CSRF token)
       └─ firebase/functions  → POST /api/fn/{callableName}
Stripe → POST /api/stripe/webhook
Cron   → php bin/job.php due   (or POST /api/jobs/run with a token)
```

| Firebase piece | PHP replacement |
|---|---|
| `firestore.rules` | `src/Store/Rules.php` (line-by-line port; queries return only authorized documents) |
| Firestore collections | Tables with `doc_json` + indexed projections (`migrations/001_initial.sql`) |
| Transactions + `bookingReservations` | `SELECT … FOR UPDATE` on `booking_day_locks` (`src/Domain/Bookings.php`) |
| `enqueueBookingEmail` trigger | `src/Domain/BookingEvents.php`, run synchronously on every booking write |
| `mail` collection + Trigger Email extension | `email_outbox` table + `src/Domain/Outbox.php` (SMTP via PHPMailer) |
| Callables (`createBookingAndStripeCheckout`, …) | `src/Controllers/FunctionsController.php` |
| `stripeWebhook` | `src/Controllers/StripeWebhookController.php` (+ event-id dedupe) |
| Scheduled functions | `src/Jobs/Jobs.php` (`expire-pending`, `recover-payments`, `send-reminders`) |
| `sweepCompleteBookings` | `POST /api/sweepCompleteBookings` (same request/response) |
| Firebase Auth | `src/Auth/*` (sessions in DB, lockout, rate limits, password reset email) |
| `onSnapshot` listeners | Polling (default 30 s) + immediate refresh after local writes and on tab focus |

## Local development

Requirements: PHP ≥ 8.2 (`pdo_mysql`, `curl`, `openssl`, `mbstring`), Composer, MySQL 8 / MariaDB 10.6+, Node 20.

```bash
cd backend && composer install
```

```bash
cp config/config.example.php config/config.php   # then edit; never commit it
```

```bash
php bin/migrate.php
```

```bash
php -S 127.0.0.1:8000 tests/support/api-router.php
```

In another terminal, from the repo root, run the frontend in PHP mode with an `/api` proxy:

```bash
VITE_BACKEND=php VITE_API_PROXY=http://127.0.0.1:8000 npm run dev
```

Make yourself an admin after registering through the site:

```bash
php bin/set-role.php you@example.com owner
```

## Tests

```bash
cd backend && vendor/bin/phpunit
```

- `tests/Unit/JsParityTest.php` compares the PHP ports with outputs recorded from the **current JavaScript**
  (`tools/generate-parity-fixtures.cjs`; regenerate with `TZ=America/New_York node backend/tools/generate-parity-fixtures.cjs`).
- `tests/Integration/*` boot the real API with `php -S`, a fake Stripe API and a database whose name must
  contain `test` (default `ss_test` over the local socket; override with `SS_TEST_DB_DSN/USER/PASSWORD`).
  Every integration class **drops all tables** in that database.
- CI: `.github/workflows/backend-tests.yml` (tests only, never deploys).

## Data migration tools

| Step | Command (run on a trusted machine, never commit outputs) |
|---|---|
| Export Firestore (read-only) | `GOOGLE_APPLICATION_CREDENTIALS=… node backend/tools/migration/export-firestore.cjs --project sanchez-services-11fd0 --out ./export` |
| Export Auth users (read-only) | `firebase auth:export ./export/auth-users.json --format=json --project sanchez-services-11fd0` |
| Import (dry run, rolls back) | `php bin/import-firestore.php --dir=./export` |
| Import (commit, idempotent) | `php bin/import-firestore.php --dir=./export --apply` |
| Validate | `php bin/validate-import.php --dir=./export` (exit 1 on any failure) |
| Password-hash compatibility check | `php bin/check-firebase-password-hash.php --self-test` and the real-account mode (see the file header) |

Rehearse with the emulator: `firebase emulators:start --only firestore`, then
`node backend/tools/migration/seed-emulator-sample.cjs`, then export with `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`.

## Deployment (not done yet)

`deploy/build-release.sh <absolute-app-root-on-server> [out]` builds:
- `out/public_html/` — the PHP-mode SPA, `deploy/hostinger/root.htaccess`, `api/index.php` and `api/.htaccess`
- `out/ss-app/` — code + production `vendor/`, kept **outside** the web root

Configuration lives in `ss-app/config/config.php` (permissions 600), created on the server from
`config/config.example.php`. Secrets never go in git, chat, or the web root.

Cron (one entry): `*/5 * * * * php /path/to/ss-app/bin/job.php due >/dev/null 2>&1`

`deploy/hostinger/host-check.php` is a read-only script to run over SSH; it reports PHP version and extensions,
limits, paths, tools and outbound HTTPS, and prints no secrets.

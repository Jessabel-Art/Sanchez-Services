# Cutover runbook — Firebase → Hostinger PHP

Nothing here has been executed. Production cutover, and any deletion of Firebase data or Google resources,
need the owner's explicit approval. Firebase stays fully intact until §5 is complete and signed off.

## 0. Decisions needed from the owner

| # | Decision | Default (unchanged until you decide) | Where it is set |
|---|---|---|---|
| D1 | Keep customers' existing Firebase passwords **or** everyone sets a new one via "Forgot password" | Reset required | `auth.firebase_scrypt` (+ import flag `--with-legacy-password-hashes`) |
| D2 | Online change/cancel cut-off | 24 h (Terms of Service) | `business.client_change_cutoff_hours` |
| D3 | Minimum notice for new online bookings | 12 h | `business.min_notice_hours` |
| D4 | Deposit for returning clients (old site said none; old server always charged $50) | $50 for everyone | `business.returning_client_deposit_amount` (null = same, 0 = none) |
| D5 | Deposit refundable if cancelled before the cut-off? (wording only — refunds are always a manual admin action) | "non-refundable" | `business.deposit_refund_policy` = `non_refundable` / `refundable_before_cutoff` |
| D6 | Legacy "completed" bookings with no recorded payment | Left as shown in Firestore (balance due) and listed in the import report | import flag `--assume-completed-paid` (off) |
| D7 | Card refunds return the credited amount; the card fee the client paid is not refunded | Fee not refunded | admin chooses the refund amount per payment |
| D8 | Google sign-in on the new site | Off (accounts can still reset a password) | `auth.google.client_id` / `client_secret` (Google Cloud OAuth client) |
| D9 | Sending mailbox and who receives admin alerts | Admins/owners in the database | `mail.*`, `business.admin_notification_emails` |

The Terms of Service page text is not changed automatically by any of these settings.

## 1. Hostinger information needed (no secrets in chat — enter them directly on the server)

1. Hosting plan and whether the site is served by LiteSpeed or Apache; PHP 8.2 enabled for the domain and for CLI (`php -v` over SSH).
2. MySQL/MariaDB database + user created in hPanel (name only; the password goes into the server config file).
3. Absolute home path over SSH (e.g. `/home/u964192992`) and the domain's document root.
4. How the current site is deployed: Git auto-deploy of the `deploy` branch, or manual upload?
5. Cron access in hPanel (one entry, every 5 minutes).
6. Email: a mailbox on the domain for sending, and SPF/DKIM enabled in hPanel.
7. SSL active on the domain (then enable the HTTPS redirect and HSTS lines in `.htaccess`).
8. An SSH key added in hPanel for deployments (no password sharing).

Run `php backend/deploy/hostinger/host-check.php` over SSH: it prints PHP version, extensions and limits, and no secrets.

## 2. Staging rehearsal (before touching the live site)

Follow the step-by-step version in `docs/STAGING_GUIDE.md`. Summary:

1. Create a staging subdomain (e.g. `staging.sanchezproservices.com`) and a separate staging database.
2. `backend/deploy/build-release.sh /home/<user>/ss-app-staging release-staging` locally; upload
   `release-staging/ss-app/` outside the web root and `release-staging/public_html/` to the staging document root.
3. Create `ss-app-staging/config/config.php` from `config/config.example.php` (`app.env = 'staging'`, Stripe **test** keys,
   SMTP mailbox), `chmod 640`. Then `php bin/migrate.php`.
4. Stripe (test mode) → Developers → Webhooks → endpoint `https://staging…/api/stripe/webhook` with events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `charge.refunded`.
   Put its signing secret in the staging config.
5. Cron: `*/5 * * * * php /home/<user>/ss-app-staging/bin/job.php due >/dev/null 2>&1`
6. Export Firebase **read-only** (see `backend/README.md`), copy the export to the server over SSH (never into git or the web root),
   then: `php bin/import-firestore.php --dir=<export>` (dry run, read the report) → `--apply` → `php bin/validate-import.php --dir=<export>`.
7. Test on staging: real test-card payment through Checkout and the webhook, emails arriving in real inboxes (spam check),
   password reset for an imported account, owner login and admin screens, a reschedule and a cancellation,
   a refund, and the double-booking checks. Review "Needs attention" and the validator's notices with the owner.

## 3. Cutover (with approval; low-traffic window, ~1 hour)

1. Announce a short pause in online booking. Note the time T0.
2. Take backups: Firestore export (managed export to a bucket, plus the read-only NDJSON export), Firebase Auth export,
   current `public_html` (tar), and the current `deploy` branch commit hash.
3. Freeze the old site's writes: put the Firebase site into maintenance (e.g. temporarily deploy a static "Booking paused —
   call (401) 658-6708" page, or disable the booking route). Do not delete or disable Google services.
4. Fresh read-only export at T0 → import into the **production** database (dry run, apply, validate).
5. Deploy `ss-app/` (production config: `app.env = 'production'`, Stripe **live** keys, production webhook endpoint
   `https://sanchezproservices.com/api/stripe/webhook` with the same four events), run migrations, add the cron entry.
6. Set GitHub repository variables `SS_APP_ROOT=/home/<user>/ss-app` and `PHP_BACKEND_READY=true`, merge the branch;
   `deploy.yml` publishes the new web root (SPA + `/api` front controller + `.htaccess`) to the `deploy` branch.
   (Or upload `release/public_html/` manually if Hostinger isn't pulling the branch.)
7. Smoke test: `/api/health`, owner login, today's/tomorrow's bookings visible, one live booking with a real card and an immediate refund.
8. Re-open booking. Keep Firebase untouched (read-only) for at least 30 days.

## 4. Rollback

Any time before Firebase is retired:
1. Restore the previous `public_html` (tar from step 3.2) or force the `deploy` branch back to the saved commit; set
   `PHP_BACKEND_READY=false` so a later push cannot republish.
2. The old site works again immediately (Firebase data was never modified).
3. Bookings and payments made on the new system during the window are in MySQL: list them with
   `SELECT ref, contact_email, start_at, status, amount_paid FROM bookings WHERE created_via <> 'import'` and re-enter them in the old admin.
4. Point the Stripe live webhook back to the Firebase function URL if it was changed.

## 5. Retiring Firebase (separate approval, after ≥ 30 days)

Only after the owner confirms: final backups archived, Stripe webhook to Firebase removed, Cloud Functions/schedulers disabled,
then (optionally) project deletion. None of this is automated by this repository.

# Staging rehearsal on Hostinger — step by step

Goal: run the new site on `staging.sanchezproservices.com` with a **copy** of the real Firebase data, real Hostinger email,
Stripe **test mode** and a cron job, without touching the live site, Firebase data, or emailing real customers.

Rules for every step:
- Never paste passwords, keys or secrets into chat. Type them only into hPanel, Stripe, Google or the server config file.
- The scripts print reports without secrets or customer details; paste those reports back.
- Staging email is restricted by `mail.recipient_allowlist`; anything addressed to imported customers is held (status
  `suppressed`), never sent.

| # | Step | Where |
|---|---|---|
| 1 | Enable SSH and add your SSH key; confirm you can connect | hPanel → Websites → *sanchezproservices.com* → Dashboard → Advanced → **SSH Access** |
| 2 | Download the release package; upload it; run `host-check.php` (detects LiteSpeed/Apache, PHP, paths, cron, outbound access) | GitHub → Actions → "Build release package" → artifact; your terminal |
| 3 | Create the `staging` subdomain | hPanel → Domains → **Subdomains** |
| 4 | Create the staging database and user | hPanel → Databases → **Management** |
| 5 | Create the sending mailbox (if not existing) | hPanel → Emails → **Email Accounts** |
| 6 | Install the release on staging (`install.sh --domain staging…`) and fill in `config.php` | SSH |
| 7 | Stripe test mode: API key + webhook endpoint `https://staging…/api/stripe/webhook` | Stripe Dashboard (Test mode) → Developers |
| 8 | Cron job every 5 minutes | hPanel → Advanced → **Cron Jobs** |
| 9 | Read-only Firebase export (Firestore + Auth users) and copy it to the server | Google Cloud Shell |
| 10 | Import: dry run → review → apply → validate | SSH |
| 11 | Account access: owner password reset + admin sign-in; one imported client (allowlisted) reset + sign-in | Browser |
| 12 | Hosted Stripe Checkout with a test card; verify Stripe delivered the webhook | Browser + Stripe |
| 13 | Email delivery test + scheduled jobs + `staging-check.php` (all PASS) | SSH |

### Commands used on the server

```bash
php host-check.php
```

```bash
bash install.sh --domain staging.sanchezproservices.com --replace-docroot
```

```bash
php ~/ss-app-staging/bin/import-firestore.php --dir=$HOME/ss-import/export
```

```bash
php ~/ss-app-staging/bin/import-firestore.php --dir=$HOME/ss-import/export --apply
```

```bash
php ~/ss-app-staging/bin/validate-import.php --dir=$HOME/ss-import/export
```

```bash
php ~/ss-app-staging/bin/staging-check.php --send-email=YOUR-ALLOWLISTED-ADDRESS
```

### Staging config essentials (`~/ss-app-staging/config/config.php`)

- `app.env = 'staging'`, `app.url = 'https://staging.sanchezproservices.com'`, `app.key` = random (command in the file)
- `db.*` = the staging database from step 4
- `stripe.secret_key` = **test** key (`sk_test_…` or a restricted `rk_test_…`), `stripe.webhook_secret` = the staging endpoint's `whsec_…`
- `mail.*` = Hostinger SMTP mailbox from step 5
- `mail.recipient_allowlist` = only your own addresses, e.g. `['owner@…', '@sanchezproservices.com']`
- Business rules stay at their defaults until you decide (`docs/CUTOVER_RUNBOOK.md` §0).

### What staging must show before production is discussed

`staging-check.php` reports PASS for: HTTPS, Stripe test key, webhook endpoint registered, a webhook delivered by Stripe,
a hosted Checkout payment recorded, SMTP delivery, no email to imported customers, every cron job recent, an admin and an
imported client signed in. Plus `validate-import.php` exits 0 and its notices are reviewed with the owner.
Anything not PASS is listed in the final report before a cutover request.

Notes:
- Imported card payments reference **live-mode** Stripe payments; on staging (test key) refunding them fails safely.
  Test refunds only on payments made on staging.
- The import keeps the original Firestore document for every booking (`legacy_json`); no payment status is guessed.
  `--assume-completed-paid` is only used if the owner decides so (decision D6).

<?php
// Copy to ss-app/config/config.php on the server (outside public_html), chmod 640, and fill in values there.
// NEVER commit the real file. Values marked [SECRET] must only exist on the server.
// Anything omitted falls back to the defaults in src/Config.php (business rules included).
return [
    'app' => [
        'env' => 'production',                        // production | staging (staging accepts Stripe test-mode events)
        'url' => 'https://sanchezproservices.com',    // public site origin, no trailing slash
        'key' => '',                                  // [SECRET] php -r "echo base64_encode(random_bytes(32));"
        'allowed_origins' => [],                      // extra origins allowed to POST (e.g. 'https://www.sanchezproservices.com')
        'debug' => false,
    ],
    'business' => [
        'email' => 'sanchezservices24@yahoo.com',     // reply-to on customer emails
        'phone' => '(401) 658-6708',
        'admin_notification_emails' => [],            // who gets new-booking / cancellation / attention alerts; empty = all admins
        // Business rules (defaults shown; change only with the owner):
        // 'min_notice_hours' => 12, 'client_change_cutoff_hours' => 24, 'required_deposit_amount' => 50,
        // 'hold_minutes' => 30, 'pass_card_fee_to_customer' => true, 'promo_codes' => ['CLEAN10' => 0.10],
        // 'slots' => [1 => ['09:00','11:00','13:00','15:00'], ..., 6 => ['09:00','11:00','13:00'], 7 => []],
    ],
    'db' => [
        'dsn' => 'mysql:host=localhost;dbname=DB_NAME;charset=utf8mb4',
        'user' => 'DB_USER',
        'password' => '',                             // [SECRET]
    ],
    'session' => [
        'secure' => true,                             // HTTPS only
    ],
    'stripe' => [
        'secret_key' => '',                           // [SECRET] sk_test_… on staging, sk_live_… (or a restricted key) in production
        'webhook_secret' => '',                       // [SECRET] whsec_… of the endpoint https://<domain>/api/stripe/webhook
    ],
    'mail' => [
        'transport' => 'smtp',                        // smtp | log (staging) | null
        'host' => 'smtp.hostinger.com',
        'port' => 465,
        'encryption' => 'ssl',                        // ssl (465) or tls (587)
        'username' => '',                             // mailbox, e.g. bookings@sanchezproservices.com
        'password' => '',                             // [SECRET]
        'from_address' => '',                         // same mailbox as username
        'from_name' => 'Sanchez Services',
        'log_path' => '',                             // required when transport = log
    ],
    'jobs' => [
        'runner_token' => '',                         // [SECRET] >= 32 chars; only for the web-cron fallback (/api/jobs/run)
    ],
    'auth' => [
        // Optional (migration decision D1): keep imported Firebase passwords working. Only fill this in if the owner
        // approves; the values come from Firebase console → Authentication → Users → ⋮ → Password hash parameters.
        // 'firebase_scrypt' => ['signer_key' => '', 'salt_separator' => '', 'rounds' => 8, 'mem_cost' => 14],  // [SECRET]
    ],
    'logging' => [
        'path' => '',                                 // e.g. /home/u964192992/ss-app/storage/logs
    ],
];

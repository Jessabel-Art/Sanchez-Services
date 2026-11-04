<?php
// Copy to a location OUTSIDE the web root (e.g. /home/<user>/ss-config/config.php), chmod 600,
// and fill in values there. Never commit the real file. Secret values are marked [SECRET].
return [
    'app' => [
        'env' => 'production',                       // production | staging
        'url' => 'https://sanchezproservices.com',    // public site origin, no trailing slash
        'key' => '',                                  // [SECRET] random: php -r "echo base64_encode(random_bytes(32));"
        'allowed_origins' => [],                      // extra origins (e.g. staging) allowed to POST
        'debug' => false,
    ],
    'business' => [
        'timezone' => 'America/New_York',
        'slot_capacity' => 1,
        'daily_capacity' => 6,
        'required_deposit_amount' => 50,
        'pending_payment_ttl_minutes' => 30,
        'admin_notification_emails' => [],            // e.g. ['owner@example.com']
        'admin_emails' => [],
        'admin_uids' => [],
    ],
    'db' => [
        'dsn' => 'mysql:host=localhost;dbname=DB_NAME;charset=utf8mb4',
        'user' => 'DB_USER',
        'password' => '',                             // [SECRET]
    ],
    'session' => [
        'cookie_name' => 'ss_session',
        'secure' => true,
    ],
    'stripe' => [
        'secret_key' => '',                           // [SECRET] sk_test_... on staging, sk_live_... on production
        'webhook_secret' => '',                       // [SECRET] whsec_... for THIS endpoint
        'api_version' => '',                          // optional, e.g. the account's pinned version
        'frontend_url' => '',                         // defaults to app.url
    ],
    'mail' => [
        'transport' => 'smtp',                        // smtp | log (staging) | null
        'host' => '',
        'port' => 587,
        'username' => '',
        'password' => '',                             // [SECRET]
        'encryption' => 'tls',
        'from_address' => '',
        'from_name' => 'Sanchez Services',
        'log_path' => '',                             // required when transport = log
    ],
    'jobs' => [
        'runner_token' => '',                         // [SECRET] >= 32 chars, only for the web-cron fallback
    ],
    'logging' => [
        'path' => '',                                 // e.g. /home/<user>/ss-app/storage/logs
    ],
];

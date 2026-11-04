<?php
declare(strict_types=1);

// Staging (or production) readiness report. Read-only except for `--send-email=<address>`.
//   php bin/staging-check.php
//   php bin/staging-check.php --send-email=owner@example.com
// Prints PASS / FAIL / PENDING / INFO lines and never prints secrets, customer names or customer emails.
// Exit code 0 only when nothing FAILs.
require dirname(__DIR__) . '/bootstrap.php';

use SanchezServices\Clock;

$opts = getopt('', ['send-email:']);
$rows = [];
$fail = 0;
$line = static function (string $status, string $check, string $detail = '') use (&$rows, &$fail): void {
    $rows[] = [$status, $check, $detail];
    if ($status === 'FAIL') {
        $fail++;
    }
};

try {
    $config = SanchezServices\Config::load();
    $app = new SanchezServices\App($config);
} catch (Throwable $e) {
    echo "FAIL  config/database: " . $e->getMessage() . "\n";
    exit(1);
}
$env = $config->string('app.env');
$prod = $env === 'production';
$db = $app->db;
$now = $app->clock->now();

// ---------------------------------------------------------------- configuration
$line('INFO', 'environment', $env);
$url = $config->string('app.url');
$line(str_starts_with($url, 'https://') ? 'PASS' : 'FAIL', 'app.url uses https', $url);
$line(strlen((string) base64_decode($config->string('app.key'), true)) >= 32 ? 'PASS' : 'FAIL', 'app.key is set (32+ random bytes)');
$line($config->bool('session.secure', true) ? 'PASS' : 'FAIL', 'session cookie is Secure');
$sk = $config->string('stripe.secret_key');
$mode = preg_match('/^(sk|rk)_live_/', $sk) ? 'live' : (preg_match('/^(sk|rk)_test_/', $sk) ? 'test' : 'missing');
$line($mode === ($prod ? 'live' : 'test') ? 'PASS' : 'FAIL', 'Stripe key mode', $mode . ($prod ? ' (production needs live)' : ' (staging needs test)'));
$line(str_starts_with($config->string('stripe.webhook_secret'), 'whsec_') ? 'PASS' : 'FAIL', 'Stripe webhook signing secret is set');
$line($config->string('mail.transport') === 'smtp' && $config->string('mail.host') !== '' && $config->string('mail.from_address') !== '' ? 'PASS' : 'FAIL', 'SMTP configured', $config->string('mail.host') . ':' . $config->int('mail.port'));
$allow = $config->get('mail.recipient_allowlist');
if ($prod) {
    $line('INFO', 'mail allowlist', is_array($allow) && $allow ? 'ACTIVE in production (' . count($allow) . ' entries) — remove before go-live' : 'off (normal for production)');
} else {
    $line(is_array($allow) && $allow ? 'PASS' : 'FAIL', 'staging mail allowlist (imported customers are never emailed)', is_array($allow) ? count($allow) . ' entr' . (count($allow) === 1 ? 'y' : 'ies') : 'not set — all mail is held');
}
$line('INFO', 'D1 Firebase password compatibility', $config->string('auth.firebase_scrypt.signer_key') !== '' ? 'enabled' : 'off (imported users reset their password)');
$line('INFO', 'D8 Google sign-in', $app->google->enabled() ? 'enabled' : 'off');
foreach ([
    'D2 change/cancel cut-off (h)' => $config->int('business.client_change_cutoff_hours'),
    'D3 minimum notice (h)' => $config->int('business.min_notice_hours'),
    'D4 deposit / returning-client deposit' => $config->float('business.required_deposit_amount') . ' / ' . ($config->get('business.returning_client_deposit_amount') ?? 'same'),
    'D5 deposit wording' => $config->string('business.deposit_refund_policy'),
] as $k => $v) {
    $line('INFO', $k, (string) $v);
}

// ---------------------------------------------------------------- database
$line('PASS', 'database connection', (string) $db->scalar('SELECT VERSION()'));
$applied = array_column($db->all('SELECT version FROM schema_migrations'), 'version');
$files = array_map(static fn ($f) => basename($f, '.sql'), glob(dirname(__DIR__) . '/migrations/*.sql') ?: []);
$missing = array_diff($files, $applied);
$line($missing ? 'FAIL' : 'PASS', 'migrations applied', $missing ? 'pending: ' . implode(', ', $missing) : count($applied) . ' applied');

// ---------------------------------------------------------------- imported data + accounts
$imported = (int) $db->scalar("SELECT COUNT(*) FROM bookings WHERE created_via = 'import'");
$line($imported > 0 ? 'PASS' : 'PENDING', 'Firebase export imported', "{$imported} bookings, " . (int) $db->scalar('SELECT COUNT(*) FROM users WHERE imported_at IS NOT NULL') . ' accounts');
$line('INFO', 'imported bookings needing attention', (string) (int) $db->scalar("SELECT COUNT(*) FROM bookings WHERE created_via = 'import' AND needs_attention IS NOT NULL"));
$line('INFO', 'imported accounts that used Google sign-in only', (string) (int) $db->scalar("SELECT COUNT(*) FROM users WHERE legacy_providers LIKE '%google.com%' AND legacy_providers NOT LIKE '%password%'"));
$owners = $db->all("SELECT id, password_hash IS NOT NULL AS has_pw, google_sub IS NOT NULL AS has_google, last_login_at, imported_at FROM users WHERE role IN ('owner','admin') AND is_active = 1");
$line($owners ? 'PASS' : 'FAIL', 'admin/owner accounts exist', count($owners) . ' active');
$signedIn = array_filter($owners, static fn ($o) => ($o['has_pw'] || $o['has_google']) && $o['last_login_at'] !== null && (!$o['imported_at'] || $o['last_login_at'] > $o['imported_at']));
$line($signedIn ? 'PASS' : 'PENDING', 'an admin has signed in on this server', $signedIn ? 'yes' : 'reset the owner password and sign in');
$clientLogins = (int) $db->scalar("SELECT COUNT(*) FROM users WHERE role = 'client' AND imported_at IS NOT NULL AND last_login_at > imported_at");
$line($clientLogins > 0 ? 'PASS' : 'PENDING', 'an imported client account signed in (after reset)', (string) $clientLogins);

// ---------------------------------------------------------------- Stripe
try {
    $eps = $app->stripe->listWebhookEndpoints()['data'] ?? [];
    $want = rtrim($url, '/') . '/api/stripe/webhook';
    $ep = array_values(array_filter($eps, static fn ($e) => ($e['url'] ?? '') === $want))[0] ?? null;
    $need = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'charge.refunded'];
    if (!$ep) {
        $line('FAIL', 'Stripe webhook endpoint registered', "no endpoint for {$want}");
    } else {
        $events = (array) ($ep['enabled_events'] ?? []);
        $lack = in_array('*', $events, true) ? [] : array_diff($need, $events);
        $line($lack || ($ep['status'] ?? '') !== 'enabled' ? 'FAIL' : 'PASS', 'Stripe webhook endpoint registered', ($ep['status'] ?? '?') . ($lack ? ' — missing events: ' . implode(', ', $lack) : ' — all required events'));
    }
} catch (Throwable $e) {
    $line('FAIL', 'Stripe API reachable with the configured key', $e->getMessage());
}
$ev = $db->one("SELECT type, received_at FROM stripe_events WHERE status = 'processed' ORDER BY received_at DESC LIMIT 1");
$line($ev ? 'PASS' : 'PENDING', 'webhook delivered by Stripe and verified', $ev ? "{$ev['type']} at {$ev['received_at']} UTC" : 'none yet');
$bad = (int) $db->scalar("SELECT COUNT(*) FROM stripe_events WHERE status = 'failed'");
$line($bad ? 'FAIL' : 'PASS', 'no failed webhook events', (string) $bad);
$paid = $db->one("SELECT COUNT(*) n, MAX(paid_at) last FROM payments WHERE source = 'stripe' AND checkout_session_id IS NOT NULL AND type = 'payment' AND status = 'succeeded'");
$line((int) $paid['n'] > 0 ? 'PASS' : 'PENDING', 'hosted Stripe Checkout payment completed and recorded', (int) $paid['n'] . ' payment(s)' . ($paid['last'] ? ", last {$paid['last']} UTC" : ''));
$viaWebhook = (int) $db->scalar("SELECT COUNT(*) FROM booking_history WHERE event = 'confirmed' AND details_json LIKE '%deposit%'");
$line('INFO', 'bookings confirmed by a deposit payment', (string) $viaWebhook);

// ---------------------------------------------------------------- email
if (isset($opts['send-email'])) {
    $to = (string) $opts['send-email'];
    if (!$app->outbox->allowed($to)) {
        $line('FAIL', 'test email', 'that address is not on mail.recipient_allowlist');
    } else {
        $key = 'smtp_test|' . bin2hex(random_bytes(6));
        $app->outbox->queue($key, 'smtp_test', $to, 'Sanchez Services email test (' . $env . ')', '<p>Test message from the ' . htmlspecialchars($env) . ' server.</p>', 'Test message from the ' . $env . ' server.');
        $app->outbox->sendDue(5);
        $r = $db->one('SELECT status, last_error FROM email_outbox WHERE dedupe_key = ?', [$key]);
        $line($r['status'] === 'sent' ? 'PASS' : 'FAIL', 'test email accepted by SMTP', $r['status'] . ($r['last_error'] ? ' — ' . $r['last_error'] : '') . ' (check the inbox and spam folder)');
    }
}
$mail = $db->one("SELECT SUM(status='sent') sent, SUM(status='failed') failed, SUM(status='suppressed') held, SUM(status IN ('queued','sending')) queued, MAX(sent_at) last FROM email_outbox");
$line((int) $mail['sent'] > 0 ? 'PASS' : 'PENDING', 'emails delivered via SMTP', (int) $mail['sent'] . ' sent' . ($mail['last'] ? ", last {$mail['last']} UTC" : ''));
$line((int) $mail['failed'] > 0 ? 'FAIL' : 'PASS', 'no failed emails', (string) (int) $mail['failed']);
$line('INFO', 'emails held by the allowlist', (string) (int) $mail['held']);
if (!$prod) {
    $leak = 0;
    foreach ($db->all("SELECT DISTINCT o.to_email FROM email_outbox o JOIN users u ON u.email_lower = LOWER(o.to_email) WHERE o.status = 'sent' AND u.imported_at IS NOT NULL AND u.role = 'client'") as $x) {
        $leak++;
    }
    $line($leak ? 'FAIL' : 'PASS', 'no email sent to an imported client on staging', $leak ? "{$leak} recipient(s) — check the allowlist" : 'none');
}

// ---------------------------------------------------------------- scheduled jobs
foreach (SanchezServices\Jobs\Jobs::SCHEDULE as $job => $minutes) {
    $j = $db->one('SELECT last_finished_at, last_status FROM job_runs WHERE job = ?', [$job]);
    if (!$j || !$j['last_finished_at']) {
        $line('PENDING', "cron job {$job}", 'never ran');
        continue;
    }
    $age = ($now->getTimestamp() - Clock::fromSql($j['last_finished_at'])->getTimestamp()) / 60;
    $ok = $j['last_status'] === 'ok' && $age <= max(15, 2 * $minutes + 5);
    $line($ok ? 'PASS' : 'FAIL', "cron job {$job}", sprintf('%s, %d min ago (every %d min)', $j['last_status'], $age, $minutes));
}

// ---------------------------------------------------------------- output
foreach ($rows as [$s, $c, $d]) {
    printf("%-8s %-58s %s\n", $s, $c, $d);
}
$counts = array_count_values(array_column($rows, 0));
printf("\n%d PASS, %d FAIL, %d PENDING\n", $counts['PASS'] ?? 0, $counts['FAIL'] ?? 0, $counts['PENDING'] ?? 0);
exit($fail ? 1 : 0);

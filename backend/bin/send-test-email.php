<?php
declare(strict_types=1);

// Sends one test email through the real outbox + SMTP path (the staging allowlist still applies).
//   php bin/send-test-email.php you@example.com
require dirname(__DIR__) . '/bootstrap.php';

$to = trim($argv[1] ?? '');
if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
    fwrite(STDERR, "Usage: php bin/send-test-email.php <address>\n");
    exit(2);
}
$app = new SanchezServices\App(SanchezServices\Config::load());
$key = 'smtp_test|' . bin2hex(random_bytes(6));
$when = $app->clock->toBusiness($app->clock->now())->format('M j, Y g:i A T');
$app->outbox->queue($key, 'smtp_test', $to, 'Sanchez Services email test', "<p>This is a test message sent {$when} from the " . htmlspecialchars($app->config->string('app.env')) . ' environment.</p>', "This is a test message sent {$when}.");
$app->outbox->sendDue(5);
$row = $app->db->one('SELECT status, last_error FROM email_outbox WHERE dedupe_key = ?', [$key]);
echo 'Result: ', $row['status'], $row['last_error'] ? ' — ' . $row['last_error'] : '', "\n";
exit($row['status'] === 'sent' ? 0 : 1);

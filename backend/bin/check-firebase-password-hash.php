<?php
declare(strict_types=1);

// COMPATIBILITY CHECK (decision D1). Verifies ONE known test account's password against its
// Firebase scrypt hash, using your project's hash parameters. Nothing is stored or logged.
//
// 1. In Firebase Console → Authentication → Users → ⋮ → "Password hash parameters", copy the values
//    into a local JSON file (keep it private, never commit it):
//      {"base64_signer_key":"...","base64_salt_separator":"...","rounds":8,"mem_cost":14}
// 2. Export users:  firebase auth:export auth-users.json --format=json --project sanchez-services-11fd0
// 3. Run (you will be prompted for the test account's password; input is hidden):
//      php bin/check-firebase-password-hash.php --users=auth-users.json --params=hash-params.json --email=test@example.com
require dirname(__DIR__) . '/bootstrap.php';

use SanchezServices\Migration\FirebaseScrypt;

$o = getopt('', ['users:', 'params:', 'email:', 'self-test']);
if (isset($o['self-test'])) {
    $f = json_decode((string) file_get_contents(dirname(__DIR__) . '/tests/fixtures/scrypt-reference.json'), true);
    $c = $f['firebase'];
    $t = microtime(true);
    $ok = FirebaseScrypt::verify($c['pw'], $c['hash'], $c['salt'], $c['signer'], $c['sep'], $c['rounds'], $c['mem']);
    printf("Self-test against Firebase's published example: %s (%.2fs, peak %.0f MB)\n", $ok ? 'PASS' : 'FAIL', microtime(true) - $t, memory_get_peak_usage(true) / 1048576);
    exit($ok ? 0 : 1);
}
if (empty($o['users']) || empty($o['params']) || empty($o['email'])) {
    fwrite(STDERR, "Usage: php bin/check-firebase-password-hash.php --users=auth-users.json --params=hash-params.json --email=<test account>\n       php bin/check-firebase-password-hash.php --self-test\n");
    exit(2);
}
$params = json_decode((string) file_get_contents($o['params']), true);
$users = json_decode((string) file_get_contents($o['users']), true)['users'] ?? [];
$email = strtolower(trim($o['email']));
$user = null;
foreach ($users as $u) {
    if (strtolower((string) ($u['email'] ?? '')) === $email) {
        $user = $u;
    }
}
if (!$user || empty($user['passwordHash']) || empty($user['salt'])) {
    fwrite(STDERR, "No password hash found for that email in the export (Google-only account?).\n");
    exit(1);
}
fwrite(STDOUT, 'Password for the test account (hidden): ');
if (DIRECTORY_SEPARATOR === '/') {
    shell_exec('stty -echo');
}
$password = rtrim((string) fgets(STDIN), "\r\n");
if (DIRECTORY_SEPARATOR === '/') {
    shell_exec('stty echo');
}
fwrite(STDOUT, "\n");
$t = microtime(true);
$ok = FirebaseScrypt::verify($password, $user['passwordHash'], $user['salt'], (string) $params['base64_signer_key'], (string) $params['base64_salt_separator'], (int) $params['rounds'], (int) $params['mem_cost']);
printf("%s — %.2f seconds, peak memory %.0f MB\n", $ok ? 'MATCH: Firebase hashes can be verified by PHP on this machine' : 'NO MATCH: do not rely on hash import', microtime(true) - $t, memory_get_peak_usage(true) / 1048576);
exit($ok ? 0 : 1);

<?php
// READ-ONLY host capability check for the Sanchez Services PHP migration.
// It changes nothing, writes nothing, and prints NO secrets (no env vars, no config values).
//
// Run over SSH from your home directory:
//   php host-check.php            (CLI view)
// Optionally also upload it temporarily into public_html and open it once in a browser to see the
// WEB PHP settings (they can differ from CLI), then DELETE it immediately.
declare(strict_types=1);

$cli = PHP_SAPI === 'cli';
if (!$cli) {
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
}
$out = [];
$add = static function (string $k, mixed $v) use (&$out): void { $out[$k] = $v; };

$add('sapi', PHP_SAPI);
$add('php_version', PHP_VERSION);
$add('os', PHP_OS_FAMILY . ' ' . php_uname('r'));
$add('date.timezone (ini)', ini_get('date.timezone') ?: '(unset)');
$add('default_timezone', date_default_timezone_get());
foreach (['memory_limit', 'max_execution_time', 'post_max_size', 'upload_max_filesize', 'disable_functions', 'open_basedir', 'opcache.enable'] as $k) {
    $v = ini_get($k);
    $add("ini.$k", $k === 'disable_functions' ? ($v === '' ? '(none)' : $v) : ($v === false || $v === '' ? '(unset)' : $v));
}
$need = ['pdo', 'pdo_mysql', 'curl', 'openssl', 'mbstring', 'json', 'sodium', 'fileinfo', 'intl', 'zip', 'apcu', 'scrypt'];
$ext = [];
foreach ($need as $e) {
    $ext[$e] = extension_loaded($e) ? 'yes' : 'no';
}
$add('extensions', $ext);
$add('password_argon2id', defined('PASSWORD_ARGON2ID') ? 'yes' : 'no (bcrypt will be used)');
$add('aes-256-ctr', in_array('aes-256-ctr', openssl_get_cipher_methods(), true) ? 'yes' : 'no');
$add('fastcgi_finish_request', function_exists('fastcgi_finish_request') ? 'yes' : (function_exists('litespeed_finish_request') ? 'litespeed_finish_request' : 'no'));
$add('proc/exec available', function_exists('exec') && !in_array('exec', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true) ? 'yes' : 'no');

// Paths (no file contents)
$home = getenv('HOME') ?: (function_exists('posix_getpwuid') ? (posix_getpwuid(posix_geteuid())['dir'] ?? '') : '');
$add('home_dir', $home ?: '(unknown)');
$add('cwd', getcwd());
if (!$cli) {
    $add('document_root', $_SERVER['DOCUMENT_ROOT'] ?? '');
    $add('https_seen_by_php', (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'yes' : 'no');
    $add('server_software', $_SERVER['SERVER_SOFTWARE'] ?? '');
}
if ($home && is_dir($home)) {
    $dirs = [];
    foreach ((array) glob($home . '/domains/*/public_html', GLOB_ONLYDIR) as $d) {
        $dirs[] = $d;
    }
    if (is_dir($home . '/public_html')) {
        $dirs[] = $home . '/public_html';
    }
    $add('candidate_document_roots', $dirs ?: '(none found)');
    // What each hosted domain answers with (detects LiteSpeed/Apache/CDN without uploading anything)
    foreach ((array) glob($home . '/domains/*', GLOB_ONLYDIR) as $d) {
        $domain = basename($d);
        if (!function_exists('curl_init') || !preg_match('/^[a-z0-9.-]+$/i', $domain)) {
            continue;
        }
        $ch = curl_init("https://{$domain}/");
        $hdr = [];
        curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_TIMEOUT => 8, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADERFUNCTION => static function ($c, $l) use (&$hdr) { $p = explode(':', $l, 2); if (count($p) === 2) { $hdr[strtolower(trim($p[0]))] = trim($p[1]); } return strlen($l); }]);
        curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $add("site.$domain", $code ? "HTTP $code server=" . ($hdr['server'] ?? '?') . (isset($hdr['platform']) ? ' platform=' . $hdr['platform'] : '') . (isset($hdr['x-powered-by']) ? ' powered-by=' . $hdr['x-powered-by'] : '') : 'no HTTPS answer');
    }
    $add('webserver_hint', is_dir('/usr/local/lsws') ? 'LiteSpeed (/usr/local/lsws present)' : (is_dir('/etc/apache2') || is_dir('/etc/httpd') ? 'Apache config present' : 'unknown'));
    $add('home_writable', is_writable($home) ? 'yes' : 'no');
    $free = @disk_free_space($home);
    $add('disk_free_mb', $free !== false ? (int) ($free / 1048576) : '(unknown)');
}

// Tools
$which = static function (string $bin): string {
    if (!function_exists('shell_exec')) {
        return '(shell_exec disabled)';
    }
    $p = trim((string) @shell_exec('command -v ' . escapeshellarg($bin) . ' 2>/dev/null'));
    return $p !== '' ? $p : 'not found';
};
$phpBins = array_values(array_filter(array_merge((array) glob('/opt/alt/php8*/usr/bin/php'), (array) glob('/usr/bin/php8*'), (array) glob('/usr/local/bin/php*')), 'is_executable'));
$add('php_binaries', $phpBins ?: '(only the default php)');
$add('php_cli_binary', PHP_BINARY);
foreach (['composer', 'git', 'mysql', 'mysqldump', 'crontab', 'node', 'tar', 'unzip'] as $b) {
    $add("bin.$b", $which($b));
}
if (function_exists('shell_exec')) {
    $v = trim((string) @shell_exec('mysql --version 2>/dev/null'));
    $add('mysql_client_version', $v !== '' ? $v : '(n/a)');
}

// Outbound HTTPS (HEAD requests only; no credentials)
foreach (['https://api.stripe.com/healthcheck', 'https://oauth2.googleapis.com', 'https://github.com'] as $url) {
    if (!function_exists('curl_init')) {
        $add("outbound $url", 'curl missing');
        continue;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_TIMEOUT => 8, CURLOPT_RETURNTRANSFER => true]);
    curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    $add("outbound $url", $code ? "HTTP $code" : "FAILED $err");
}

// Outbound SMTP (TCP connect only)
foreach (['smtp.hostinger.com:465', 'smtp.hostinger.com:587'] as $hp) {
    [$h, $p] = explode(':', $hp);
    $fp = @fsockopen($h, (int) $p, $errno, $errstr, 6);
    $add("outbound $hp", $fp ? 'reachable' : "FAILED $errstr");
    if ($fp) {
        fclose($fp);
    }
}
if (function_exists('shell_exec')) {
    $cron = trim((string) @shell_exec('command -v crontab >/dev/null 2>&1 && crontab -l 2>&1 || echo __NOCRONTAB__'));
    $add('crontab_access', $cron === '__NOCRONTAB__' ? 'crontab command missing (use hPanel → Advanced → Cron Jobs)' : (str_contains($cron, 'no crontab') ? 'ok (0 entries)' : (str_contains($cron, 'not allowed') ? 'not allowed (use hPanel Cron Jobs)' : 'ok (' . count(array_filter(explode("\n", (string) $cron), static fn ($l) => trim($l) !== '' && $l[0] !== '#')) . ' entries)')));
}

// Optional quick perf probe (scrypt-like CPU work) to estimate the cost of Firebase hash verification
$t = microtime(true);
$x = 0;
for ($i = 0; $i < 3_000_000; $i++) {
    $x = (($x + $i) & 0xffffffff) ^ (($x << 7) & 0xffffffff);
}
$add('cpu_probe_seconds', round(microtime(true) - $t, 3) . ' (dev sandbox: 0.04s; Firebase hash check there: ~2.5s)');

echo "Sanchez Services host check (read-only)\n";
echo str_repeat('=', 40), "\n";
foreach ($out as $k => $v) {
    echo str_pad($k, 44), is_array($v) ? json_encode($v, JSON_UNESCAPED_SLASHES) : (string) $v, "\n";
}

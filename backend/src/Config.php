<?php
declare(strict_types=1);

namespace SanchezServices;

/**
 * Configuration loader.
 *
 * Secrets live in a PHP file OUTSIDE the web root (see config/config.example.php).
 * Location resolution order:
 *   1. SS_CONFIG environment variable (absolute path)
 *   2. <backend root>/config/config.php
 *   3. <web root>/../ss-config/config.php (Hostinger: home dir next to public_html)
 */
final class Config
{
    /** @param array<string,mixed> $values */
    public function __construct(private array $values)
    {
    }

    public static function load(?string $path = null): self
    {
        $candidates = array_filter([
            $path,
            getenv('SS_CONFIG') ?: null,
            dirname(__DIR__) . '/config/config.php',
            isset($_SERVER['DOCUMENT_ROOT']) && $_SERVER['DOCUMENT_ROOT'] !== ''
                ? dirname((string) $_SERVER['DOCUMENT_ROOT']) . '/ss-config/config.php'
                : null,
        ]);
        foreach ($candidates as $candidate) {
            if (is_file($candidate)) {
                $values = require $candidate;
                if (!is_array($values)) {
                    throw new \RuntimeException('Config file must return an array.');
                }
                return new self(array_replace_recursive(self::defaults(), $values));
            }
        }
        throw new \RuntimeException('Configuration file not found.');
    }

    /** @param array<string,mixed> $values */
    public static function fromArray(array $values): self
    {
        return new self(array_replace_recursive(self::defaults(), $values));
    }

    /** @return array<string,mixed> */
    public static function defaults(): array
    {
        return [
            'app' => [
                'env' => 'production',
                'url' => '',                       // e.g. https://sanchezproservices.com (no trailing slash)
                'key' => '',                       // random 32+ bytes, base64; used for HMAC tokens
                'allowed_origins' => [],           // extra origins allowed for state-changing requests
                'debug' => false,
            ],
            'business' => [
                'timezone' => 'America/New_York',
                'slot_capacity' => 1,
                'daily_capacity' => 6,
                'required_deposit_amount' => 50,
                'pending_payment_ttl_minutes' => 30,
                'pending_payment_sweep_batch' => 200,
                'webhook_recovery_min_age_minutes' => 10,
                'webhook_recovery_batch' => 50,
                'admin_notification_emails' => [],
                'admin_emails' => [],              // server-side allowlist (mirrors ADMIN_EMAILS)
                'admin_uids' => [],                // server-side allowlist (mirrors ADMIN_UIDS)
            ],
            'db' => [
                'dsn' => '',
                'user' => '',
                'password' => '',
            ],
            'session' => [
                'cookie_name' => 'ss_session',
                'secure' => true,
                'lifetime_seconds' => 1209600,     // 14 days
                'samesite' => 'Lax',
            ],
            'stripe' => [
                'secret_key' => '',
                'webhook_secret' => '',
                'api_base' => 'https://api.stripe.com',
                'api_version' => '',               // optional Stripe-Version header
                'frontend_url' => '',              // success/cancel redirect base; defaults to app.url
                'webhook_tolerance_seconds' => 300,
            ],
            'mail' => [
                'transport' => 'smtp',             // smtp | log | null
                'host' => '',
                'port' => 587,
                'username' => '',
                'password' => '',
                'encryption' => 'tls',             // tls | ssl | ''
                'from_address' => '',
                'from_name' => 'Sanchez Services',
                'log_path' => '',
            ],
            'jobs' => [
                'runner_token' => '',              // shared secret for /api/jobs/run (web-cron fallback)
            ],
            'auth' => [
                'login_max_attempts' => 5,
                'login_window_seconds' => 900,
                'lockout_seconds' => 900,
                'reset_token_ttl_minutes' => 60,
                'min_password_length' => 6,        // Firebase Auth minimum is 6
                // Preserves current behavior (Firebase rules match on token email, verified or not).
                // OPTIONAL CHANGE: set true to require a verified email for email-matched booking access.
                'require_verified_email_for_email_match' => false,
            ],
            'logging' => [
                'path' => '',                      // directory for app-YYYY-MM-DD.log
            ],
            'security' => [
                'rate_limit_multiplier' => 1.0,    // tests/staging may raise limits; keep 1.0 in production
            ],
            'polling' => [
                'interval_seconds' => 30,
            ],
        ];
    }

    public function get(string $key, mixed $default = null): mixed
    {
        $node = $this->values;
        foreach (explode('.', $key) as $part) {
            if (!is_array($node) || !array_key_exists($part, $node)) {
                return $default;
            }
            $node = $node[$part];
        }
        return $node;
    }

    public function string(string $key, string $default = ''): string
    {
        $v = $this->get($key, $default);
        return is_scalar($v) ? (string) $v : $default;
    }

    public function int(string $key, int $default = 0): int
    {
        $v = $this->get($key, $default);
        return is_numeric($v) ? (int) $v : $default;
    }

    public function float(string $key, float $default = 0.0): float
    {
        $v = $this->get($key, $default);
        return is_numeric($v) ? (float) $v : $default;
    }

    public function bool(string $key, bool $default = false): bool
    {
        $v = $this->get($key, $default);
        return is_bool($v) ? $v : filter_var($v, FILTER_VALIDATE_BOOLEAN);
    }

    /** @return list<string> */
    public function list(string $key): array
    {
        $v = $this->get($key, []);
        if (is_string($v)) {
            $v = explode(',', $v);
        }
        if (!is_array($v)) {
            return [];
        }
        return array_values(array_filter(array_map(static fn ($x) => trim((string) $x), $v), static fn ($x) => $x !== ''));
    }
}

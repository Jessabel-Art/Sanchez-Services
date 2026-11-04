<?php
declare(strict_types=1);

namespace SanchezServices\Security;

use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Http\Request;

/**
 * Database-backed session. The cookie holds a random 256-bit token; the DB stores only its SHA-256.
 */
final class SessionStore
{
    private ?string $token = null;
    /** @var array<string,mixed> */
    private array $data = [];
    private bool $dirty = false;
    private bool $destroyed = false;
    private bool $issueCookie = false;

    public function __construct(private Db $db, private Config $config)
    {
    }

    public function cookieName(): string
    {
        return $this->config->string('session.cookie_name', 'ss_session');
    }

    public function start(Request $request): void
    {
        $cookies = self::parseCookies($request->header('cookie') ?? '');
        $token = $cookies[$this->cookieName()] ?? null;
        if (is_string($token) && preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            $row = $this->db->one('SELECT data, last_activity FROM sessions WHERE id = ?', [hash('sha256', $token)]);
            $lifetime = $this->config->int('session.lifetime_seconds', 1209600);
            if ($row && ((int) $row['last_activity'] + $lifetime) >= time()) {
                $this->token = $token;
                $this->data = json_decode((string) $row['data'], true) ?: [];
                // Touch at most every 5 minutes to limit writes.
                if (time() - (int) $row['last_activity'] > 300) {
                    $this->dirty = true;
                }
                return;
            }
        }
        $this->token = null;
        $this->data = [];
    }

    public function get(string $key, mixed $default = null): mixed
    {
        return $this->data[$key] ?? $default;
    }

    public function set(string $key, mixed $value): void
    {
        $this->ensureToken();
        $this->data[$key] = $value;
        $this->dirty = true;
    }

    public function remove(string $key): void
    {
        if (array_key_exists($key, $this->data)) {
            unset($this->data[$key]);
            $this->dirty = true;
        }
    }

    /** New token, same data (call on login / privilege change). */
    public function regenerate(): void
    {
        if ($this->token !== null) {
            $this->db->run('DELETE FROM sessions WHERE id = ?', [hash('sha256', $this->token)]);
        }
        $this->token = self::newToken();
        $this->issueCookie = true;
        $this->dirty = true;
    }

    public function destroy(): void
    {
        if ($this->token !== null) {
            $this->db->run('DELETE FROM sessions WHERE id = ?', [hash('sha256', $this->token)]);
        }
        $this->token = null;
        $this->data = [];
        $this->destroyed = true;
        $this->dirty = false;
    }

    public function hasToken(): bool
    {
        return $this->token !== null;
    }

    /** Persists the session and returns Set-Cookie header value (or null). */
    public function commit(): ?string
    {
        if ($this->destroyed) {
            return $this->cookieHeader('', time() - 3600);
        }
        if ($this->token === null) {
            return null;
        }
        if ($this->dirty) {
            $id = hash('sha256', $this->token);
            $this->db->run(
                'INSERT INTO sessions (id, data, last_activity) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), last_activity = VALUES(last_activity)',
                [$id, json_encode($this->data, JSON_THROW_ON_ERROR), time()]
            );
            $this->issueCookie = true;
        }
        if ($this->issueCookie) {
            return $this->cookieHeader($this->token, time() + $this->config->int('session.lifetime_seconds', 1209600));
        }
        return null;
    }

    public function purgeExpired(): int
    {
        return $this->db->run('DELETE FROM sessions WHERE last_activity < ?', [time() - $this->config->int('session.lifetime_seconds', 1209600)])->rowCount();
    }

    private function ensureToken(): void
    {
        if ($this->token === null) {
            $this->token = self::newToken();
            $this->issueCookie = true;
            $this->destroyed = false;
        }
    }

    private function cookieHeader(string $value, int $expires): string
    {
        $parts = [
            $this->cookieName() . '=' . $value,
            'Path=/',
            'Expires=' . gmdate('D, d M Y H:i:s \G\M\T', $expires),
            'Max-Age=' . max(0, $expires - time()),
            'HttpOnly',
            'SameSite=' . $this->config->string('session.samesite', 'Lax'),
        ];
        if ($this->config->bool('session.secure', true)) {
            $parts[] = 'Secure';
        }
        return implode('; ', $parts);
    }

    private static function newToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    /** @return array<string,string> */
    public static function parseCookies(string $header): array
    {
        $out = [];
        foreach (explode(';', $header) as $pair) {
            $pair = trim($pair);
            if ($pair === '' || !str_contains($pair, '=')) {
                continue;
            }
            [$k, $v] = explode('=', $pair, 2);
            $out[trim($k)] = trim($v);
        }
        return $out;
    }
}

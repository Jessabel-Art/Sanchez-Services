<?php
declare(strict_types=1);

namespace SanchezServices\Auth;

use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;
use SanchezServices\Security\SessionStore;

/**
 * Optional "Sign in with Google" (OpenID Connect, authorization-code flow, server side).
 * Disabled unless auth.google.client_id and auth.google.client_secret are configured — enabling it is an owner decision.
 *
 * The ID token is obtained directly from Google's token endpoint over TLS, so per OIDC Core §3.1.3.7 the TLS channel
 * authenticates the issuer; we still check iss, aud, exp, nonce and email_verified.
 * Account matching: stored google_sub → else an existing account with the same (Google-verified) email is linked →
 * else a new client account is created without a password.
 */
final class GoogleSignIn
{
    public function __construct(private Db $db, private Clock $clock, private Config $config, private UserRepository $users, private SessionStore $session)
    {
    }

    public function enabled(): bool
    {
        return $this->config->string('auth.google.client_id') !== '' && $this->config->string('auth.google.client_secret') !== '';
    }

    private function redirectUri(): string
    {
        return rtrim($this->config->string('app.url'), '/') . '/api/auth/google/callback';
    }

    /** Returns the Google authorization URL and remembers state/nonce in the session. */
    public function start(string $next): string
    {
        if (!$this->enabled()) {
            throw new HttpError('not-found', 'Google sign-in is not enabled.');
        }
        $state = bin2hex(random_bytes(16));
        $nonce = bin2hex(random_bytes(16));
        $this->session->set('google_oauth', ['state' => $state, 'nonce' => $nonce, 'next' => self::safeNext($next), 'at' => time()]);
        return $this->config->string('auth.google.auth_url', 'https://accounts.google.com/o/oauth2/v2/auth') . '?' . http_build_query([
            'client_id' => $this->config->string('auth.google.client_id'),
            'redirect_uri' => $this->redirectUri(),
            'response_type' => 'code',
            'scope' => 'openid email profile',
            'state' => $state,
            'nonce' => $nonce,
            'prompt' => 'select_account',
        ]);
    }

    /**
     * Completes the flow. Returns [user row, next path].
     * @return array{0:array<string,mixed>,1:string}
     */
    public function finish(string $code, string $state): array
    {
        $saved = $this->session->get('google_oauth');
        $this->session->remove('google_oauth');
        if (!is_array($saved) || !hash_equals((string) $saved['state'], $state) || time() - (int) $saved['at'] > 600) {
            throw new HttpError('permission-denied', 'Google sign-in expired. Please try again.');
        }
        $tokens = $this->post($this->config->string('auth.google.token_url', 'https://oauth2.googleapis.com/token'), [
            'code' => $code, 'client_id' => $this->config->string('auth.google.client_id'),
            'client_secret' => $this->config->string('auth.google.client_secret'),
            'redirect_uri' => $this->redirectUri(), 'grant_type' => 'authorization_code',
        ]);
        $claims = self::decodeJwtPayload((string) ($tokens['id_token'] ?? ''));
        $iss = (string) ($claims['iss'] ?? '');
        if (!in_array($iss, ['https://accounts.google.com', 'accounts.google.com'], true)
            || ($claims['aud'] ?? null) !== $this->config->string('auth.google.client_id')
            || (int) ($claims['exp'] ?? 0) < time()
            || !hash_equals((string) $saved['nonce'], (string) ($claims['nonce'] ?? ''))
            || empty($claims['sub'])) {
            throw new HttpError('permission-denied', 'Google sign-in could not be verified.');
        }
        $email = strtolower(trim((string) ($claims['email'] ?? '')));
        if ($email === '' || ($claims['email_verified'] ?? false) !== true) {
            throw new HttpError('permission-denied', 'Your Google account email is not verified.');
        }
        $sub = (string) $claims['sub'];
        $now = (string) Clock::toSql($this->clock->now());
        $row = $this->db->one('SELECT * FROM users WHERE google_sub = ?', [$sub]) ?? $this->users->rowByEmail($email);
        if ($row) {
            if ($row['google_sub'] !== null && $row['google_sub'] !== $sub) {
                throw new HttpError('permission-denied', 'This email is linked to a different Google account.');
            }
            $set = ['google_sub' => $sub];
            if ($row['email_verified_at'] === null) {
                $set['email_verified_at'] = $now; // Google verified the mailbox
            }
            $this->users->update((int) $row['id'], $set);
        } else {
            $u = $this->users->create($email, null, isset($claims['name']) ? mb_substr((string) $claims['name'], 0, 200) : null);
            $this->users->update($u->id, ['google_sub' => $sub, 'email_verified_at' => $now]);
        }
        $row = (array) ($this->db->one('SELECT * FROM users WHERE google_sub = ?', [$sub]));
        if ((int) $row['is_active'] !== 1) {
            throw new HttpError('permission-denied', 'This account is disabled.');
        }
        return [$row, (string) $saved['next']];
    }

    public static function safeNext(string $next): string
    {
        return preg_match('#^/(?!/)[A-Za-z0-9/_\-?=&.%]*$#', $next) ? $next : '/portal';
    }

    /** @return array<string,mixed> */
    public static function decodeJwtPayload(string $jwt): array
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) {
            return [];
        }
        $json = base64_decode(strtr($parts[1], '-_', '+/') . str_repeat('=', (4 - strlen($parts[1]) % 4) % 4), true);
        $data = $json !== false ? json_decode($json, true) : null;
        return is_array($data) ? $data : [];
    }

    /** @return array<string,mixed> */
    private function post(string $url, array $form): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query($form), CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 20, CURLOPT_HTTPHEADER => ['Accept: application/json'],
        ]);
        $out = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $data = is_string($out) ? json_decode($out, true) : null;
        if ($status !== 200 || !is_array($data)) {
            throw new HttpError('unavailable', 'Google sign-in failed. Please try again or use your email and password.');
        }
        return $data;
    }
}

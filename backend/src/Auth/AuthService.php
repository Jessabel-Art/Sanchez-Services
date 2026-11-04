<?php
declare(strict_types=1);

namespace SanchezServices\Auth;

use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Domain\Notifier;
use SanchezServices\Http\HttpError;
use SanchezServices\Security\RateLimiter;
use SanchezServices\Security\SessionStore;

/**
 * Replaces Firebase Auth (email/password). Error codes mirror Firebase's `auth/*` codes.
 *
 * Imported Firebase accounts have no native password until they use "Forgot password"
 * (verifying Firebase scrypt hashes on login is a pending owner decision).
 */
final class AuthService
{
    private ?AuthUser $current = null;
    private bool $resolved = false;

    public function __construct(
        private Db $db,
        private Clock $clock,
        private Config $config,
        private UserRepository $users,
        private SessionStore $session,
        private RateLimiter $limiter,
        private Notifier $notifier,
    ) {
    }

    public function currentUser(): ?AuthUser
    {
        if (!$this->resolved) {
            $this->resolved = true;
            $id = $this->session->get('user_id');
            if (is_int($id)) {
                $u = $this->users->findById($id);
                $sessionVersion = $this->session->get('auth_version');
                $row = $u ? $this->users->rowById($id) : null;
                // Password changes/resets invalidate older sessions.
                if ($u && $row && (string) $sessionVersion === self::authVersion($row)) {
                    $this->current = $u;
                } else {
                    $this->session->remove('user_id');
                }
            }
        }
        return $this->current;
    }

    public function requireUser(): AuthUser
    {
        return $this->currentUser() ?? throw HttpError::unauthenticated();
    }

    private static function authVersion(array $row): string
    {
        return substr(hash('sha256', (string) ($row['password_hash'] ?? '') . '|' . $row['email_lower'] . '|' . $row['role'] . '|' . $row['is_active']), 0, 16);
    }

    private function signIn(array $row): AuthUser
    {
        $this->session->regenerate();
        $this->session->set('user_id', (int) $row['id']);
        $this->session->set('auth_version', self::authVersion($row));
        $this->session->set('auth_time', time());
        $this->session->set('csrf', bin2hex(random_bytes(32)));
        $this->users->update((int) $row['id'], [
            'last_login_at' => Clock::toSql($this->clock->now()),
            'failed_logins' => 0,
            'locked_until' => null,
        ]);
        $this->current = AuthUser::fromRow($row);
        $this->resolved = true;
        return $this->current;
    }

    public function csrfToken(): string
    {
        $t = $this->session->get('csrf');
        if (!is_string($t) || strlen($t) !== 64) {
            $t = bin2hex(random_bytes(32));
            $this->session->set('csrf', $t);
        }
        return $t;
    }

    private static function validEmail(string $email): bool
    {
        return strlen($email) <= 254 && filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
    }

    public function register(string $email, string $password, ?string $name, string $ip): AuthUser
    {
        $email = trim($email);
        $this->limiter->hit('register:ip:' . $ip, 10, 3600);
        if (!self::validEmail($email)) {
            throw new HttpError('auth/invalid-email', 'The email address is badly formatted.');
        }
        if (mb_strlen($password) < $this->config->int('auth.min_password_length', 6)) {
            throw new HttpError('auth/weak-password', 'Password should be at least 6 characters.');
        }
        if (strlen($password) > 1024) {
            throw new HttpError('auth/weak-password', 'Password is too long.');
        }
        $u = $this->db->transaction(function () use ($email, $password, $name) {
            if ($this->users->rowByEmail($email)) {
                throw new HttpError('auth/email-already-in-use', 'An account with this email already exists. Sign in or reset your password.');
            }
            $u = $this->users->create($email, Passwords::hash($password), $name !== null ? mb_substr(trim($name), 0, 200) : null);
            $this->sendVerification($u);
            return $this->signIn((array) $this->users->rowById($u->id));
        });
        return $u;
    }

    public function login(string $email, string $password, string $ip): AuthUser
    {
        $email = strtolower(trim($email));
        $max = $this->config->int('auth.login_max_attempts', 5);
        $window = $this->config->int('auth.login_window_seconds', 900);
        $this->limiter->hit('login:ip:' . $ip, $max * 4, $window);
        if (!$this->limiter->attempt('login:email:' . $email, $max * 2, $window)) {
            throw new HttpError('auth/too-many-requests', 'Access to this account has been temporarily disabled due to many failed login attempts. You can reset your password or try again later.');
        }
        $row = $this->users->rowByEmail($email);
        if ($row && $row['locked_until'] !== null && (string) $row['locked_until'] > (string) Clock::toSql($this->clock->now())) {
            throw new HttpError('auth/too-many-requests', 'Access to this account has been temporarily disabled due to many failed login attempts. You can reset your password or try again later.');
        }
        $ok = Passwords::verify($password, $row['password_hash'] ?? null);
        if (!$ok && $row && ($row['password_hash'] ?? null) === null && $this->verifyLegacyFirebase($password, $row)) {
            // Imported Firebase password: upgrade to a native hash on first successful sign-in.
            $this->users->update((int) $row['id'], ['password_hash' => Passwords::hash($password), 'legacy_password_hash' => null, 'legacy_password_salt' => null]);
            $row = (array) $this->users->rowById((int) $row['id']);
            $ok = true;
        }
        if (!$row || !$ok || (int) $row['is_active'] !== 1) {
            if ($row) {
                $fails = (int) $row['failed_logins'] + 1;
                $set = ['failed_logins' => $fails];
                if ($fails >= $max) {
                    $set['locked_until'] = Clock::toSql($this->clock->now()->modify('+' . $this->config->int('auth.lockout_seconds', 900) . ' seconds'));
                    $set['failed_logins'] = 0;
                }
                $this->users->update((int) $row['id'], $set);
            }
            $legacyUsable = $row && !empty($row['legacy_password_hash']) && !empty($this->config->get('auth.firebase_scrypt.signer_key'));
            if ($row && ($row['password_hash'] ?? null) === null && !$legacyUsable && (int) $row['is_active'] === 1) {
                // Imported account without a native password yet.
                throw new HttpError('auth/password-reset-required', 'Please use "Forgot password" to set a new password for your account.');
            }
            throw new HttpError('auth/invalid-credential', 'Incorrect email or password.');
        }
        if (Passwords::needsRehash((string) $row['password_hash'])) {
            $this->users->update((int) $row['id'], ['password_hash' => Passwords::hash($password)]);
            $row = (array) $this->users->rowById((int) $row['id']);
        }
        return $this->signIn($row);
    }

    /**
     * Optional compatibility path (migration decision D1): only active when the Firebase project's
     * password-hash parameters are configured (auth.firebase_scrypt.signer_key, salt_separator, rounds, mem_cost)
     * and the importer stored the user's legacy hash (--with-legacy-password-hashes).
     */
    private function verifyLegacyFirebase(string $password, array $row): bool
    {
        $p = (array) $this->config->get('auth.firebase_scrypt', []);
        if (empty($p['signer_key']) || empty($row['legacy_password_hash']) || empty($row['legacy_password_salt']) || strlen($password) > 1024) {
            return false;
        }
        try {
            return \SanchezServices\Migration\FirebaseScrypt::verify(
                $password,
                (string) $row['legacy_password_hash'],
                (string) $row['legacy_password_salt'],
                (string) $p['signer_key'],
                (string) ($p['salt_separator'] ?? 'Bw=='),
                (int) ($p['rounds'] ?? 8),
                (int) ($p['mem_cost'] ?? 14)
            );
        } catch (\Throwable) {
            return false;
        }
    }

    public function logout(): void
    {
        $this->session->destroy();
        $this->current = null;
        $this->resolved = true;
    }

    /** Always succeeds outwardly (no account enumeration). */
    public function forgotPassword(string $email, string $ip): void
    {
        $email = strtolower(trim($email));
        if (!self::validEmail($email)) {
            throw new HttpError('auth/invalid-email', 'The email address is badly formatted.');
        }
        $this->limiter->hit('forgot:ip:' . $ip, 10, 3600);
        if (!$this->limiter->attempt('forgot:email:' . $email, 3, 3600)) {
            return;
        }
        $row = $this->users->rowByEmail($email);
        if (!$row || (int) $row['is_active'] !== 1) {
            return;
        }
        $minutes = $this->config->int('auth.reset_token_ttl_minutes', 60);
        $token = $this->issueToken((int) $row['id'], 'password_reset', $minutes, null);
        $this->notifier->passwordReset((string) $row['email'], rtrim($this->config->string('app.url'), '/') . '/auth/reset?token=' . rawurlencode($token), $minutes);
    }

    public function resetPassword(string $token, string $password, string $ip): AuthUser
    {
        $this->limiter->hit('reset:ip:' . $ip, 20, 3600);
        if (mb_strlen($password) < $this->config->int('auth.min_password_length', 6) || strlen($password) > 1024) {
            throw new HttpError('auth/weak-password', 'Password should be at least 6 characters.');
        }
        return $this->db->transaction(function () use ($token, $password) {
            $row = $this->consumeToken($token, 'password_reset');
            $nowSql = (string) Clock::toSql($this->clock->now());
            $this->users->update((int) $row['user_id'], [
                'password_hash' => Passwords::hash($password),
                'legacy_password_hash' => null,
                'legacy_password_salt' => null,
                // Completing a reset proves control of the mailbox.
                'email_verified_at' => $nowSql,
                'failed_logins' => 0,
                'locked_until' => null,
            ]);
            return $this->signIn((array) $this->users->rowById((int) $row['user_id']));
        });
    }

    /** updateEmail(): Firebase requires a recent sign-in; we require one within 5 minutes or the password. */
    public function changeEmail(string $newEmail, ?string $password): AuthUser
    {
        $u = $this->requireUser();
        $newEmail = trim($newEmail);
        if (!self::validEmail($newEmail)) {
            throw new HttpError('auth/invalid-email', 'The email address is badly formatted.');
        }
        $row = (array) $this->users->rowById($u->id);
        $recent = (time() - (int) $this->session->get('auth_time', 0)) <= 300;
        if (!$recent && !($password !== null && Passwords::verify($password, $row['password_hash'] ?? null))) {
            throw new HttpError('auth/requires-recent-login', 'This operation is sensitive and requires recent authentication. Log in again before retrying this request.');
        }
        return $this->db->transaction(function () use ($u, $newEmail) {
            $existing = $this->users->rowByEmail($newEmail);
            if ($existing && (int) $existing['id'] !== $u->id) {
                throw new HttpError('auth/email-already-in-use', 'The email address is already in use by another account.');
            }
            $this->users->update($u->id, ['email' => $newEmail, 'email_lower' => strtolower($newEmail), 'email_verified_at' => null]);
            $row = (array) $this->users->rowById($u->id);
            $this->session->set('auth_version', self::authVersion($row));
            $this->current = AuthUser::fromRow($row);
            $this->sendVerification($this->current);
            return $this->current;
        });
    }

    public function changePassword(string $current, string $new): void
    {
        $u = $this->requireUser();
        $row = (array) $this->users->rowById($u->id);
        if (!Passwords::verify($current, $row['password_hash'] ?? null)) {
            throw new HttpError('auth/wrong-password', 'The current password is incorrect.');
        }
        if (mb_strlen($new) < $this->config->int('auth.min_password_length', 6) || strlen($new) > 1024) {
            throw new HttpError('auth/weak-password', 'Password should be at least 6 characters.');
        }
        $this->users->update($u->id, ['password_hash' => Passwords::hash($new)]);
        $this->signIn((array) $this->users->rowById($u->id));
    }

    public function refresh(): ?AuthUser
    {
        if ($this->current) {
            $this->current = $this->users->findById($this->current->id);
        }
        return $this->current;
    }

    public function sendVerification(AuthUser $u): void
    {
        $token = $this->issueToken($u->id, 'email_verify', $this->config->int('auth.verify_token_ttl_hours', 72) * 60, $u->emailLower);
        $this->notifier->verifyEmail($u->email, rtrim($this->config->string('app.url'), '/') . '/auth/verify?token=' . rawurlencode($token));
    }

    public function resendVerification(string $ip): void
    {
        $u = $this->requireUser();
        if ($u->emailVerified) {
            return;
        }
        $this->limiter->hit('verify:user:' . $u->id, 5, 3600);
        $this->sendVerification($u);
    }

    /** Marks the email verified (token must match the email it was issued for). */
    public function verifyEmail(string $token): AuthUser
    {
        return $this->db->transaction(function () use ($token) {
            $row = $this->consumeToken($token, 'email_verify');
            $user = (array) $this->users->rowById((int) $row['user_id']);
            if (($row['email'] ?? null) !== $user['email_lower']) {
                throw new HttpError('auth/invalid-action-code', 'This link was issued for a different email address.');
            }
            $this->users->update((int) $user['id'], ['email_verified_at' => Clock::toSql($this->clock->now())]);
            $fresh = (array) $this->users->rowById((int) $user['id']);
            if ($this->current && $this->current->id === (int) $user['id']) {
                $this->current = AuthUser::fromRow($fresh);
            }
            return AuthUser::fromRow($fresh);
        });
    }

    private function issueToken(int $userId, string $purpose, int $ttlMinutes, ?string $email): string
    {
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $now = $this->clock->now();
        $this->db->insert('auth_tokens', [
            'user_id' => $userId, 'purpose' => $purpose, 'token_hash' => hash('sha256', $token), 'email' => $email,
            'expires_at' => Clock::toSql($now->modify("+{$ttlMinutes} minutes")), 'created_at' => Clock::toSql($now),
        ]);
        return $token;
    }

    private function consumeToken(string $token, string $purpose): array
    {
        $row = $this->db->one('SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? FOR UPDATE', [hash('sha256', $token), $purpose]);
        $nowSql = (string) Clock::toSql($this->clock->now());
        if (!$row || $row['used_at'] !== null || (string) $row['expires_at'] < $nowSql) {
            throw new HttpError('auth/invalid-action-code', $purpose === 'password_reset' ? 'This password reset link is invalid or has expired.' : 'This confirmation link is invalid or has expired.');
        }
        $this->db->run('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [$nowSql, (int) $row['user_id'], $purpose]);
        return $row;
    }

    public function updateContact(?string $name, ?string $phone): AuthUser
    {
        $u = $this->requireUser();
        $this->users->update($u->id, ['name' => $name, 'phone' => $phone]);
        $this->current = AuthUser::fromRow((array) $this->users->rowById($u->id));
        return $this->current;
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Auth\AuthUser;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Input;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;

final class AuthController
{
    public function __construct(private App $app)
    {
    }

    private function payload(?AuthUser $u): Response
    {
        return Response::json([
            'user' => $u?->toApi(),
            'csrfToken' => $this->app->auth->csrfToken(),
            'pollIntervalSeconds' => $this->app->config->int('polling.interval_seconds', 30),
            'googleSignIn' => $this->app->google->enabled(),
        ]);
    }

    /** GET /api/auth/google/start?next=/portal — redirects to Google (only when enabled in config). */
    public function googleStart(Request $r): Response
    {
        $this->app->limiter->hit('google:ip:' . $r->ip, 30, 600);
        return new Response(302, '', ['Location' => $this->app->google->start((string) ($r->query['next'] ?? '/portal')), 'Cache-Control' => 'no-store']);
    }

    /** GET /api/auth/google/callback — Google redirects here; on success the user is signed in and sent back to the site. */
    public function googleCallback(Request $r): Response
    {
        $base = rtrim($this->app->config->string('app.url'), '/');
        try {
            if (isset($r->query['error'])) {
                throw new HttpError('permission-denied', 'Google sign-in was cancelled.');
            }
            [$row, $next] = $this->app->google->finish((string) ($r->query['code'] ?? ''), (string) ($r->query['state'] ?? ''));
            $this->claim($this->app->auth->signIn($row));
            return new Response(302, '', ['Location' => $base . $next, 'Cache-Control' => 'no-store']);
        } catch (HttpError $e) {
            return new Response(302, '', ['Location' => $base . '/auth?error=' . rawurlencode($e->getMessage()), 'Cache-Control' => 'no-store']);
        }
    }

    /** Verified accounts pick up bookings an admin created for their email. */
    private function claim(?AuthUser $u): ?AuthUser
    {
        if ($u) {
            $this->app->bookings->claimForUser($u);
        }
        return $u;
    }

    public function session(Request $r): Response
    {
        return $this->payload($this->app->auth->currentUser());
    }

    public function register(Request $r): Response
    {
        $in = Input::from($r);
        $u = $this->app->auth->register((string) $in->str('email', true, 254), (string) $in->str('password', true, 1024), $in->str('name', false, 200), $r->ip);
        return $this->payload($u);
    }

    public function login(Request $r): Response
    {
        $in = Input::from($r);
        return $this->payload($this->claim($this->app->auth->login((string) $in->str('email', true, 254), (string) $in->str('password', true, 1024), $r->ip)));
    }

    public function logout(Request $r): Response
    {
        $this->app->auth->logout();
        return $this->payload(null);
    }

    public function forgot(Request $r): Response
    {
        $this->app->auth->forgotPassword((string) Input::from($r)->str('email', true, 254), $r->ip);
        return Response::json(['ok' => true]);
    }

    public function reset(Request $r): Response
    {
        $in = Input::from($r);
        return $this->payload($this->claim($this->app->auth->resetPassword((string) $in->str('token', true, 200), (string) $in->str('password', true, 1024), $r->ip)));
    }

    public function verify(Request $r): Response
    {
        $u = $this->app->auth->verifyEmail((string) Input::from($r)->str('token', true, 200));
        $this->claim($u);
        return $this->payload($this->app->auth->currentUser());
    }

    public function resendVerification(Request $r): Response
    {
        $this->app->auth->resendVerification($r->ip);
        return Response::json(['ok' => true]);
    }

    public function changePassword(Request $r): Response
    {
        $in = Input::from($r);
        $this->app->auth->changePassword((string) $in->str('currentPassword', true, 1024), (string) $in->str('newPassword', true, 1024));
        return $this->payload($this->app->auth->currentUser());
    }

    public function changeEmail(Request $r): Response
    {
        $in = Input::from($r);
        return $this->payload($this->app->auth->changeEmail((string) $in->email('email'), $in->str('password', false, 1024)));
    }
}

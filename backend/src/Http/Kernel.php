<?php
declare(strict_types=1);

namespace SanchezServices\Http;

use SanchezServices\App;
use SanchezServices\Controllers\OpsController;
use SanchezServices\Controllers\StripeWebhookController;

final class Kernel
{
    private Router $router;

    public function __construct(private App $app)
    {
        $this->router = $r = new Router();
        $pub = new \SanchezServices\Controllers\PublicController($app);
        $auth = new \SanchezServices\Controllers\AuthController($app);
        $me = new \SanchezServices\Controllers\MeController($app);
        $bk = new \SanchezServices\Controllers\BookingController($app);
        $ad = new \SanchezServices\Controllers\AdminController($app);
        $ops = new OpsController($app);
        $hook = new StripeWebhookController($app);

        $r->add('GET', '/api/health', [$ops, 'health'], ['session' => false]);
        $r->add('GET', '/api/catalog', [$pub, 'catalog'], ['session' => false]);
        $r->add('POST', '/api/quote', [$pub, 'quote'], ['session' => false, 'csrf' => false]);
        $r->add('GET', '/api/availability', [$pub, 'day']);
        $r->add('GET', '/api/availability/month', [$pub, 'month'], ['session' => false]);
        $r->add('GET', '/api/reviews', [$pub, 'reviews'], ['session' => false]);

        $r->add('GET', '/api/auth/session', [$auth, 'session']);
        $r->add('POST', '/api/auth/register', [$auth, 'register']);
        $r->add('GET', '/api/auth/google/start', [$auth, 'googleStart']);
        $r->add('GET', '/api/auth/google/callback', [$auth, 'googleCallback']);
        $r->add('POST', '/api/auth/login', [$auth, 'login']);
        $r->add('POST', '/api/auth/logout', [$auth, 'logout']);
        $r->add('POST', '/api/auth/password/forgot', [$auth, 'forgot']);
        $r->add('POST', '/api/auth/password/reset', [$auth, 'reset']);
        $r->add('POST', '/api/auth/password/change', [$auth, 'changePassword']);
        $r->add('POST', '/api/auth/email', [$auth, 'changeEmail']);
        $r->add('POST', '/api/auth/verify', [$auth, 'verify']);
        $r->add('POST', '/api/auth/verify/resend', [$auth, 'resendVerification']);

        $r->add('GET', '/api/me/profile', [$me, 'profile']);
        $r->add('PATCH', '/api/me/profile', [$me, 'updateProfile']);
        $r->add('GET', '/api/me/addresses', [$me, 'addresses']);
        $r->add('POST', '/api/me/addresses', [$me, 'addAddress']);
        $r->add('PATCH', '/api/me/addresses/{id}', [$me, 'updateAddress']);
        $r->add('DELETE', '/api/me/addresses/{id}', [$me, 'deleteAddress']);
        $r->add('GET', '/api/me/bookings', [$me, 'bookings']);

        $r->add('POST', '/api/bookings', [$bk, 'create']);
        $r->add('GET', '/api/bookings/{ref}', [$bk, 'show']);
        $r->add('POST', '/api/bookings/{ref}/checkout', [$bk, 'checkout']);
        $r->add('POST', '/api/bookings/{ref}/payment-sync', [$bk, 'sync']);
        $r->add('POST', '/api/bookings/{ref}/reschedule', [$bk, 'reschedule']);
        $r->add('POST', '/api/bookings/{ref}/cancel', [$bk, 'cancel']);
        $r->add('PATCH', '/api/bookings/{ref}/notes', [$bk, 'notes']);
        $r->add('POST', '/api/bookings/{ref}/review', [$bk, 'review']);
        $r->add('GET', '/api/bookings/{ref}/invoice', [$bk, 'invoice']);

        $r->add('GET', '/api/admin/bookings', [$ad, 'bookings']);
        $r->add('POST', '/api/admin/bookings', [$ad, 'createBooking']);
        $r->add('GET', '/api/admin/bookings/{ref}', [$ad, 'booking']);
        $r->add('PATCH', '/api/admin/bookings/{ref}', [$ad, 'updateBooking']);
        $r->add('POST', '/api/admin/bookings/{ref}/status', [$ad, 'setStatus']);
        $r->add('POST', '/api/admin/bookings/{ref}/reschedule', [$ad, 'reschedule']);
        $r->add('POST', '/api/admin/bookings/{ref}/payments', [$ad, 'recordPayment']);
        $r->add('POST', '/api/admin/bookings/{ref}/clear-attention', [$ad, 'clearAttention']);
        $r->add('POST', '/api/admin/payments/{id}/refund', [$ad, 'refund']);
        $r->add('POST', '/api/admin/payments/{id}/void', [$ad, 'voidPayment']);
        $r->add('GET', '/api/admin/payments', [$ad, 'payments']);
        $r->add('GET', '/api/admin/calendar', [$ad, 'calendar']);
        $r->add('GET', '/api/admin/blackouts', [$ad, 'blackouts']);
        $r->add('POST', '/api/admin/blackouts', [$ad, 'addBlackout']);
        $r->add('DELETE', '/api/admin/blackouts/{id}', [$ad, 'deleteBlackout']);
        $r->add('GET', '/api/admin/clients', [$ad, 'clients']);
        $r->add('GET', '/api/admin/clients/{id}', [$ad, 'client']);
        $r->add('PATCH', '/api/admin/clients/{id}', [$ad, 'updateClient']);
        $r->add('GET', '/api/admin/reviews', [$ad, 'reviews']);
        $r->add('POST', '/api/admin/reviews/{id}/{action}', [$ad, 'moderateReview']);
        $r->add('GET', '/api/admin/reports', [$ad, 'reports']);
        $r->add('GET', '/api/admin/system', [$ad, 'system']);
        $r->add('POST', '/api/admin/system/jobs/{job}', [$ad, 'runJob']);
        $r->add('POST', '/api/admin/system/email/{id}/retry', [$ad, 'retryEmail']);

        $r->add('POST', '/api/stripe/webhook', [$hook, 'handle'], ['session' => false, 'csrf' => false]);
        $r->add('POST', '/api/jobs/run', [$ops, 'runJob'], ['session' => false, 'csrf' => false]);
    }

    public function handle(Request $req): Response
    {
        $path = $req->path;
        $pos = strpos($path, '/api/');
        $path = $pos === false ? $path : substr($path, $pos);
        $sessionStarted = false;
        try {
            if ($req->method === 'OPTIONS') {
                // Same-origin API: no CORS. Preflights from other origins are refused.
                return $this->finalize(new Response(204), false);
            }
            $route = $this->router->match($req->method, rtrim($path, '/') ?: '/');
            $req->routeParams = $route['params'];
            $opts = $route['opts'] + ['session' => true, 'csrf' => true];
            if ($opts['session']) {
                $this->app->session->start($req);
                $sessionStarted = true;
            }
            if (!in_array($req->method, ['GET', 'HEAD'], true)) {
                $this->assertSameOrigin($req);
                if ($opts['csrf']) {
                    $this->assertCsrf($req);
                }
            }
            $res = ($route['handler'])($req);
        } catch (HttpError $e) {
            $this->app->outbox->discardPending();
            $res = Response::error($e);
        } catch (\Throwable $e) {
            $this->app->outbox->discardPending();
            $this->app->log->error('unhandled exception', [
                'path' => $path,
                'type' => get_class($e),
                'message' => $e->getMessage(),
                'at' => basename($e->getFile()) . ':' . $e->getLine(),
            ]);
            $msg = $this->app->config->bool('app.debug') ? $e->getMessage() : 'Internal error.';
            $res = Response::error(new HttpError('internal', $msg));
        }
        return $this->finalize($res, $sessionStarted);
    }

    private function finalize(Response $res, bool $sessionStarted): Response
    {
        if ($sessionStarted) {
            try {
                $cookie = $this->app->session->commit();
                if ($cookie !== null) {
                    $res->headers['Set-Cookie'] = $cookie;
                }
            } catch (\Throwable $e) {
                $this->app->log->error('session commit failed', ['error' => $e->getMessage()]);
            }
        }
        $res->headers += [
            'Cache-Control' => 'no-store, private',
            'Pragma' => 'no-cache',
            'X-Content-Type-Options' => 'nosniff',
            'Referrer-Policy' => 'strict-origin-when-cross-origin',
            'X-Frame-Options' => 'DENY',
            'Content-Security-Policy' => "default-src 'none'; frame-ancestors 'none'",
            'X-Request-Id' => $this->app->log->requestId(),
        ];
        return $res;
    }

    /** Rejects cross-site state-changing requests (defense in depth alongside CSRF tokens). */
    private function assertSameOrigin(Request $req): void
    {
        if (($req->header('sec-fetch-site') ?? '') === 'cross-site') {
            throw HttpError::denied('Cross-site request blocked.');
        }
        $origin = $req->header('origin');
        if ($origin === null || $origin === '' || $origin === 'null') {
            return; // non-browser clients (Stripe, cron) — CSRF/job token/signature still apply
        }
        $allowed = $this->app->config->list('app.allowed_origins');
        $appUrl = $this->app->config->string('app.url');
        if ($appUrl !== '') {
            $p = parse_url($appUrl);
            if (isset($p['scheme'], $p['host'])) {
                $allowed[] = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
            }
        }
        if (!in_array(rtrim($origin, '/'), $allowed, true)) {
            throw HttpError::denied('Origin not allowed.');
        }
    }

    private function assertCsrf(Request $req): void
    {
        $expected = $this->app->session->get('csrf');
        $given = $req->header('x-csrf-token');
        if (!is_string($expected) || $expected === '' || !is_string($given) || !hash_equals($expected, $given)) {
            throw new HttpError('permission-denied', 'Invalid or missing CSRF token. Reload the page and try again.');
        }
    }

    /** Sends the response, then finishes queued email after the client is released. */
    public function emit(Response $res): void
    {
        $res->send();
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        }
        try {
            $this->app->outbox->flush();
        } catch (\Throwable $e) {
            $this->app->log->error('outbox flush failed', ['error' => $e->getMessage()]);
        }
    }
}

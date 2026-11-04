<?php
declare(strict_types=1);

namespace SanchezServices\Http;

use SanchezServices\App;
use SanchezServices\Controllers\AuthController;
use SanchezServices\Controllers\FunctionsController;
use SanchezServices\Controllers\GatewayController;
use SanchezServices\Controllers\OpsController;
use SanchezServices\Controllers\StripeWebhookController;

final class Kernel
{
    private Router $router;

    public function __construct(private App $app)
    {
        $this->router = new Router();
        $auth = new AuthController($app);
        $gw = new GatewayController($app);
        $fn = new FunctionsController($app);
        $ops = new OpsController($app);
        $hook = new StripeWebhookController($app);
        $r = $this->router;

        $r->add('GET', '/api/health', [$ops, 'health'], ['session' => false]);
        $r->add('GET', '/api/auth/session', [$auth, 'session']);
        $r->add('POST', '/api/auth/register', [$auth, 'register']);
        $r->add('POST', '/api/auth/login', [$auth, 'login']);
        $r->add('POST', '/api/auth/logout', [$auth, 'logout']);
        $r->add('POST', '/api/auth/password/forgot', [$auth, 'forgot']);
        $r->add('POST', '/api/auth/password/reset', [$auth, 'reset']);
        $r->add('POST', '/api/auth/password/change', [$auth, 'changePassword']);
        $r->add('POST', '/api/auth/email', [$auth, 'changeEmail']);
        $r->add('POST', '/api/auth/profile', [$auth, 'updateProfile']);

        $r->add('POST', '/api/db/get', [$gw, 'get']);
        $r->add('POST', '/api/db/query', [$gw, 'query']);
        $r->add('POST', '/api/db/commit', [$gw, 'commit']);

        $r->add('POST', '/api/fn/{name}', [$fn, 'call']);
        $r->add('POST', '/api/sweepCompleteBookings', [$ops, 'sweep']);

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
            $res = Response::error($e);
        } catch (\Throwable $e) {
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
        if ($given === null) {
            // Maintenance sweep sends "Authorization: Bearer <token>" (the shim's getIdToken()).
            $auth = $req->header('authorization') ?? '';
            $given = str_starts_with($auth, 'Bearer ') ? substr($auth, 7) : null;
        }
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
            $this->app->outbox->flushRequestQueue();
        } catch (\Throwable $e) {
            $this->app->log->error('outbox flush failed', ['error' => $e->getMessage()]);
        }
    }
}

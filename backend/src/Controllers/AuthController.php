<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Auth\AuthUser;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;

final class AuthController
{
    public function __construct(private App $app)
    {
    }

    private function payload(?AuthUser $u): array
    {
        return [
            'user' => $u ? $u->toPublic($this->app->rules->isAdmin($u)) : null,
            'csrfToken' => $this->app->auth->csrfToken(),
            'pollIntervalSeconds' => $this->app->config->int('polling.interval_seconds', 30),
        ];
    }

    private static function str(array $b, string $k): string
    {
        $v = $b[$k] ?? '';
        if (!is_string($v)) {
            throw HttpError::invalid("$k must be a string.");
        }
        return $v;
    }

    public function session(Request $req): Response
    {
        return Response::json($this->payload($this->app->auth->currentUser()));
    }

    public function register(Request $req): Response
    {
        $b = $req->json();
        $u = $this->app->auth->register(self::str($b, 'email'), self::str($b, 'password'), $req->ip);
        return Response::json($this->payload($u));
    }

    public function login(Request $req): Response
    {
        $b = $req->json();
        $u = $this->app->auth->login(self::str($b, 'email'), self::str($b, 'password'), $req->ip);
        return Response::json($this->payload($u));
    }

    public function logout(Request $req): Response
    {
        $this->app->auth->logout();
        return Response::json(['user' => null]);
    }

    public function forgot(Request $req): Response
    {
        $this->app->auth->forgotPassword(self::str($req->json(), 'email'), $req->ip);
        return Response::json(['ok' => true]);
    }

    public function reset(Request $req): Response
    {
        $b = $req->json();
        $u = $this->app->auth->resetPassword(self::str($b, 'token'), self::str($b, 'password'), $req->ip);
        return Response::json($this->payload($u));
    }

    public function changePassword(Request $req): Response
    {
        $b = $req->json();
        $this->app->auth->changePassword(self::str($b, 'currentPassword'), self::str($b, 'newPassword'));
        return Response::json($this->payload($this->app->auth->currentUser()));
    }

    public function changeEmail(Request $req): Response
    {
        $b = $req->json();
        $pw = isset($b['password']) && is_string($b['password']) ? $b['password'] : null;
        $u = $this->app->auth->changeEmail(self::str($b, 'email'), $pw);
        return Response::json($this->payload($u));
    }

    public function updateProfile(Request $req): Response
    {
        $b = $req->json();
        $name = array_key_exists('displayName', $b) ? ($b['displayName'] === null ? null : self::str($b, 'displayName')) : null;
        $u = $this->app->auth->updateProfile($name);
        return Response::json($this->payload($u));
    }
}

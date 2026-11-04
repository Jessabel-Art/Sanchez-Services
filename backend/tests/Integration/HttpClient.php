<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

/** Tiny cookie-keeping JSON client that behaves like the browser shim (fetches CSRF first). */
final class HttpClient
{
    private array $cookies = [];
    public ?string $csrf = null;

    public function __construct(private string $base)
    {
    }

    public function session(): array
    {
        $r = $this->request('GET', '/api/auth/session');
        $this->csrf = $r['json']['csrfToken'] ?? null;
        return $r;
    }

    public function post(string $path, array $body = [], array $headers = [], bool $withCsrf = true): array
    {
        if ($withCsrf && $this->csrf === null) {
            $this->session();
        }
        $h = $headers + ($withCsrf ? ['X-CSRF-Token' => (string) $this->csrf] : []);
        $r = $this->request('POST', $path, json_encode($body ?: new \stdClass()), $h);
        if (isset($r['json']['csrfToken'])) {
            $this->csrf = $r['json']['csrfToken'];
        }
        return $r;
    }

    public function get(string $path): array
    {
        return $this->request('GET', $path);
    }

    public function send(string $method, string $path, array $body = []): array
    {
        if ($this->csrf === null) {
            $this->session();
        }
        return $this->request($method, $path, json_encode($body ?: new \stdClass()), ['X-CSRF-Token' => (string) $this->csrf]);
    }

    public function raw(string $method, string $path, string $body, array $headers = []): array
    {
        return $this->request($method, $path, $body, $headers);
    }

    private function request(string $method, string $path, ?string $body = null, array $headers = []): array
    {
        $ch = curl_init($this->base . $path);
        $hdrs = ['Content-Type: application/json', 'Accept: application/json'];
        foreach ($headers as $k => $v) {
            $hdrs[] = "$k: $v";
        }
        if ($this->cookies) {
            $hdrs[] = 'Cookie: ' . implode('; ', array_map(static fn ($k, $v) => "$k=$v", array_keys($this->cookies), $this->cookies));
        }
        $respHeaders = [];
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $hdrs,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders) {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $name = strtolower(trim($parts[0]));
                    $respHeaders[$name][] = trim($parts[1]);
                    if ($name === 'set-cookie') {
                        $kv = explode(';', trim($parts[1]))[0];
                        [$k, $v] = array_pad(explode('=', $kv, 2), 2, '');
                        if ($v === '' || str_contains(strtolower($parts[1]), 'max-age=0')) {
                            unset($this->cookies[$k]);
                        } else {
                            $this->cookies[$k] = $v;
                        }
                    }
                }
                return strlen($line);
            },
        ]);
        if ($body !== null && $method !== 'GET') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $out = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return ['status' => $status, 'json' => json_decode((string) $out, true), 'body' => (string) $out, 'headers' => $respHeaders];
    }
}

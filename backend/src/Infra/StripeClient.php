<?php
declare(strict_types=1);

namespace SanchezServices\Infra;

use SanchezServices\Config;

/**
 * Minimal Stripe REST client (form-encoded, cURL) — no Composer dependency required on the host.
 * Only the calls the app uses: customers.create, checkout.sessions.create, checkout.sessions.retrieve,
 * plus webhook signature verification (same algorithm as stripe.webhooks.constructEvent).
 */
class StripeClient
{
    public function __construct(private Config $config)
    {
    }

    public function isConfigured(): bool
    {
        return $this->config->string('stripe.secret_key') !== '';
    }

    /** @param array<string,mixed> $params */
    public function createCustomer(array $params, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/v1/customers', $params, $idempotencyKey);
    }

    /** @param array<string,mixed> $params */
    public function createCheckoutSession(array $params, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/v1/checkout/sessions', $params, $idempotencyKey);
    }

    public function expireCheckoutSession(string $id): array
    {
        return $this->request('POST', '/v1/checkout/sessions/' . rawurlencode($id) . '/expire', []);
    }

    /** @param array<string,mixed> $params */
    public function createRefund(array $params, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/v1/refunds', $params, $idempotencyKey);
    }

    public function retrieveEvent(string $id): array
    {
        return $this->request('GET', '/v1/events/' . rawurlencode($id), []);
    }

    /** Read-only listing used by bin/staging-check.php. */
    public function listWebhookEndpoints(): array
    {
        return $this->request('GET', '/v1/webhook_endpoints?limit=20', []);
    }

    /** @param list<string> $expand */
    public function retrieveCheckoutSession(string $id, array $expand = []): array
    {
        $q = $expand ? '?' . http_build_query(['expand' => $expand]) : '';
        return $this->request('GET', '/v1/checkout/sessions/' . rawurlencode($id) . $q, []);
    }

    /** @param array<string,mixed> $params */
    protected function request(string $method, string $path, array $params, ?string $idempotencyKey = null): array
    {
        $key = $this->config->string('stripe.secret_key');
        if ($key === '') {
            throw new \RuntimeException('Stripe is not configured.');
        }
        $url = rtrim($this->config->string('stripe.api_base', 'https://api.stripe.com'), '/') . $path;
        $headers = ['Authorization: Bearer ' . $key];
        if ($v = $this->config->string('stripe.api_version')) {
            $headers[] = 'Stripe-Version: ' . $v;
        }
        if ($idempotencyKey) {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }
        $ch = curl_init($url);
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CUSTOMREQUEST => $method,
        ];
        if ($method !== 'GET') {
            $opts[CURLOPT_POSTFIELDS] = self::encode($params);
            $headers[] = 'Content-Type: application/x-www-form-urlencoded';
            $opts[CURLOPT_HTTPHEADER] = $headers;
        }
        curl_setopt_array($ch, $opts);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            throw new \RuntimeException('Stripe request failed: ' . $err);
        }
        $json = json_decode((string) $body, true);
        if (!is_array($json)) {
            throw new \RuntimeException('Stripe returned an invalid response (HTTP ' . $status . ').');
        }
        if ($status >= 400) {
            $msg = $json['error']['message'] ?? ('HTTP ' . $status);
            throw new \RuntimeException('Stripe error: ' . $msg);
        }
        return $json;
    }

    /** Stripe-style bracket encoding: line_items[0][price_data][currency]=usd */
    public static function encode(array $params, string $prefix = ''): string
    {
        $pairs = [];
        foreach ($params as $k => $v) {
            $key = $prefix === '' ? (string) $k : $prefix . '[' . $k . ']';
            if ($v === null) {
                continue;
            }
            if (is_array($v)) {
                $nested = self::encode($v, $key);
                if ($nested !== '') {
                    $pairs[] = $nested;
                }
                continue;
            }
            if (is_bool($v)) {
                $v = $v ? 'true' : 'false';
            }
            $pairs[] = rawurlencode($key) . '=' . rawurlencode((string) $v);
        }
        return implode('&', $pairs);
    }

    /**
     * Verifies the Stripe-Signature header and returns the decoded event.
     * @throws \UnexpectedValueException
     */
    public static function constructEvent(string $payload, ?string $sigHeader, string $secret, int $tolerance = 300, ?int $now = null): array
    {
        if ($sigHeader === null || $sigHeader === '' || $secret === '') {
            throw new \UnexpectedValueException('No signatures found matching the expected signature for payload');
        }
        $timestamp = null;
        $signatures = [];
        foreach (explode(',', $sigHeader) as $part) {
            $kv = explode('=', trim($part), 2);
            if (count($kv) !== 2) {
                continue;
            }
            if ($kv[0] === 't') {
                $timestamp = ctype_digit($kv[1]) ? (int) $kv[1] : null;
            } elseif ($kv[0] === 'v1') {
                $signatures[] = $kv[1];
            }
        }
        if ($timestamp === null || !$signatures) {
            throw new \UnexpectedValueException('Unable to extract timestamp and signatures from header');
        }
        $expected = hash_hmac('sha256', $timestamp . '.' . $payload, $secret);
        $ok = false;
        foreach ($signatures as $sig) {
            if (hash_equals($expected, $sig)) {
                $ok = true;
            }
        }
        if (!$ok) {
            throw new \UnexpectedValueException('No signatures found matching the expected signature for payload');
        }
        if ($tolerance > 0 && abs(($now ?? time()) - $timestamp) > $tolerance) {
            throw new \UnexpectedValueException('Timestamp outside the tolerance zone');
        }
        $event = json_decode($payload, true);
        if (!is_array($event) || !isset($event['id'], $event['type'])) {
            throw new \UnexpectedValueException('Invalid payload');
        }
        return $event;
    }
}

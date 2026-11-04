<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Clock;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;
use SanchezServices\Infra\StripeClient;

/**
 * POST /api/stripe/webhook. Signature-verified, deduplicated by event id, and every effect is
 * idempotent (unique PaymentIntent / Refund ids), so Stripe retries are always safe.
 *
 * Subscribe the endpoint to: checkout.session.completed, checkout.session.async_payment_succeeded,
 * checkout.session.expired, charge.refunded.
 */
final class StripeWebhookController
{
    public function __construct(private App $app)
    {
    }

    public function handle(Request $req): Response
    {
        $secret = $this->app->config->string('stripe.webhook_secret');
        if ($secret === '') {
            return Response::json(['error' => 'Stripe webhook is not configured'], 503);
        }
        try {
            $event = StripeClient::constructEvent($req->rawBody, $req->header('stripe-signature'), $secret, $this->app->config->int('stripe.webhook_tolerance_seconds', 300));
        } catch (\UnexpectedValueException $e) {
            return new Response(400, 'Invalid signature', ['Content-Type' => 'text/plain']);
        }
        $id = (string) $event['id'];
        $type = (string) $event['type'];
        if (!empty($event['livemode']) !== ($this->app->config->string('app.env') === 'production') && $this->app->config->bool('stripe.enforce_mode', true)) {
            $this->app->log->warning('stripe event mode mismatch ignored', ['event' => $id, 'livemode' => $event['livemode'] ?? null]);
            return Response::json(['received' => true, 'ignored' => 'mode']);
        }
        $db = $this->app->db;
        $now = Clock::toSql($this->app->clock->now());
        $prev = $db->one('SELECT status FROM stripe_events WHERE event_id = ?', [$id]);
        if ($prev && in_array($prev['status'], ['processed', 'ignored'], true)) {
            return Response::json(['received' => true, 'duplicate' => true]);
        }
        if (!$prev) {
            $db->run('INSERT IGNORE INTO stripe_events (event_id, type, status, received_at) VALUES (?, ?, \'processing\', ?)', [$id, $type, $now]);
        }
        $obj = is_array($event['data']['object'] ?? null) ? $event['data']['object'] : [];
        try {
            $handled = match ($type) {
                'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired' => $this->session($obj, $id),
                'charge.refunded' => $this->refunded($obj),
                default => false,
            };
            $this->mark($id, $handled ? 'processed' : 'ignored');
            return Response::json(['received' => true]);
        } catch (\Throwable $e) {
            $this->mark($id, 'failed', $e->getMessage());
            $this->app->log->error('stripe webhook failed', ['event' => $id, 'type' => $type, 'error' => $e->getMessage()]);
            return new Response(500, 'Webhook handler error', ['Content-Type' => 'text/plain']);
        }
    }

    private function session(array $s, string $eventId): bool
    {
        if (!$this->app->db->one('SELECT id FROM checkout_sessions WHERE stripe_session_id = ?', [(string) ($s['id'] ?? '')])) {
            return false; // not ours (e.g. another integration on the account)
        }
        $this->app->checkout->applySession($s, 'event:' . $eventId);
        return true;
    }

    /** Refunds made directly in the Stripe dashboard are mirrored into the ledger. */
    private function refunded(array $charge): bool
    {
        $pi = (string) ($charge['payment_intent'] ?? '');
        $payment = $pi !== '' ? $this->app->db->one('SELECT * FROM payments WHERE stripe_payment_intent_id = ? AND type = \'payment\'', [$pi]) : null;
        if (!$payment) {
            return false;
        }
        $refunds = $charge['refunds']['data'] ?? [];
        if (!$refunds) {
            return true;
        }
        foreach ($refunds as $rf) {
            if (($rf['status'] ?? '') !== 'succeeded' || $this->app->db->one('SELECT id FROM payments WHERE stripe_refund_id = ?', [(string) $rf['id']])) {
                continue;
            }
            $this->app->db->transaction(function () use ($payment, $rf) {
                $now = Clock::toSql($this->app->clock->now());
                // Refund amount is in cents of the charged (gross) amount; credit the booking at most what was applied.
                $amount = min(round(((int) $rf['amount']) / 100, 2), (float) $payment['amount']);
                $this->app->db->insert('payments', [
                    'booking_id' => (int) $payment['booking_id'], 'type' => 'refund', 'purpose' => $payment['purpose'], 'method' => 'card',
                    'amount' => $amount, 'fee' => 0, 'gross' => round(((int) $rf['amount']) / 100, 2), 'status' => 'succeeded', 'source' => 'stripe',
                    'stripe_refund_id' => (string) $rf['id'], 'refund_of_payment_id' => (int) $payment['id'], 'note' => 'Refunded in Stripe dashboard',
                    'paid_at' => $now, 'created_at' => $now,
                ]);
                $b = $this->app->ledger->recalc((int) $payment['booking_id']);
                $this->app->repo->history((int) $b['id'], 'refund', 'system', null, ['amount' => $amount, 'source' => 'stripe_dashboard']);
            });
        }
        return true;
    }

    private function mark(string $id, string $status, ?string $error = null): void
    {
        $this->app->db->run('UPDATE stripe_events SET status = ?, error = ?, processed_at = ? WHERE event_id = ?', [$status, $error ? mb_substr($error, 0, 2000) : null, Clock::toSql($this->app->clock->now()), $id]);
    }
}

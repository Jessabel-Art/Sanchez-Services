<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Clock;
use SanchezServices\Domain\Payments;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;
use SanchezServices\Infra\StripeClient;

/**
 * POST /api/stripe/webhook — port of `stripeWebhook`.
 * Adds event-id deduplication (stripe_events) on top of the existing booking-field idempotency.
 */
final class StripeWebhookController
{
    public function __construct(private App $app)
    {
    }

    public function handle(Request $req): Response
    {
        $secret = $this->app->config->string('stripe.webhook_secret');
        if (!$this->app->stripe->isConfigured() || $secret === '') {
            return Response::json(['error' => 'Stripe webhook is not configured'], 503);
        }
        try {
            $event = StripeClient::constructEvent(
                $req->rawBody,
                $req->header('stripe-signature'),
                $secret,
                $this->app->config->int('stripe.webhook_tolerance_seconds', 300)
            );
        } catch (\UnexpectedValueException $e) {
            $this->app->log->warning('stripe webhook signature verification failed', ['error' => $e->getMessage()]);
            return new Response(400, 'Webhook Error: ' . $e->getMessage(), ['Content-Type' => 'text/plain; charset=utf-8']);
        }

        $eventId = (string) $event['id'];
        $type = (string) $event['type'];
        $now = Clock::toSql($this->app->clock->now());
        $existing = $this->app->db->one('SELECT status FROM stripe_events WHERE event_id = ?', [$eventId]);
        if ($existing && in_array($existing['status'], ['processed', 'ignored'], true)) {
            return Response::json(['received' => true, 'duplicate' => true]);
        }
        if (!$existing) {
            $this->app->db->run(
                'INSERT IGNORE INTO stripe_events (event_id, type, status, payload_json, received_at) VALUES (?, ?, ?, ?, ?)',
                [$eventId, $type, 'processing', $req->rawBody, $now]
            );
        }

        if ($type !== 'payment_intent.succeeded') {
            $this->mark($eventId, 'ignored');
            return Response::json(['received' => true]);
        }

        try {
            $pi = is_array($event['data']['object'] ?? null) ? $event['data']['object'] : [];
            $metadata = is_array($pi['metadata'] ?? null) ? $pi['metadata'] : [];
            $bookingId = trim((string) ($metadata['bookingId'] ?? ''));
            if ($bookingId === '') {
                $this->app->log->warning('payment_intent.succeeded missing bookingId', ['eventId' => $eventId]);
                $this->mark($eventId, 'ignored');
                return Response::json(['received' => true]);
            }
            $mode = Payments::normalizeMode($metadata['mode'] ?? null);
            $this->app->payments->applySuccessfulPayment($bookingId, $mode, (string) ($pi['id'] ?? ''), $metadata, [], 'stripe', $eventId);
            $this->mark($eventId, 'processed');
            return Response::json(['received' => true]);
        } catch (\Throwable $e) {
            $this->mark($eventId, 'failed', $e->getMessage());
            $this->app->log->error('stripeWebhook authoritative payment update failed', ['eventId' => $eventId, 'error' => $e->getMessage()]);
            return new Response(500, 'Webhook handler error: ' . $e->getMessage(), ['Content-Type' => 'text/plain; charset=utf-8']);
        }
    }

    private function mark(string $eventId, string $status, ?string $error = null): void
    {
        $this->app->db->run(
            'UPDATE stripe_events SET status = ?, error = ?, processed_at = ? WHERE event_id = ?',
            [$status, $error !== null ? mb_substr($error, 0, 2000) : null, Clock::toSql($this->app->clock->now()), $eventId]
        );
    }
}

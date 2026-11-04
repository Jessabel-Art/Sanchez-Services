<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;
use SanchezServices\Infra\Logger;
use SanchezServices\Infra\StripeClient;

/**
 * Stripe Checkout for deposits and balances. Amounts are computed and recorded server-side; a
 * session is only credited when Stripe reports it paid AND its total/currency/metadata match what
 * we recorded when creating it.
 */
final class Checkout
{
    public function __construct(
        private Db $db,
        private Clock $clock,
        private Config $config,
        private BookingRepo $repo,
        private Ledger $ledger,
        private BookingService $bookings,
        private StripeClient $stripe,
        private Logger $log,
    ) {
    }

    public function configured(): bool
    {
        return $this->stripe->isConfigured() && $this->config->string('app.url') !== '';
    }

    /** Creates (or reuses) a Checkout Session. $purpose: deposit|balance. */
    public function start(array $b, string $purpose): array
    {
        if (!$this->configured()) {
            throw new HttpError('unavailable', 'Online card payments are temporarily unavailable. Please contact us to pay.');
        }
        $net = $purpose === 'deposit' ? $this->repo->depositDue($b) : $this->repo->balanceDue($b);
        if ($net <= 0) {
            throw new HttpError('failed-precondition', $purpose === 'deposit' ? 'The deposit is already paid.' : 'There is no balance due.');
        }
        $now = $this->clock->now();
        $open = $this->db->one(
            "SELECT * FROM checkout_sessions WHERE booking_id = ? AND purpose = ? AND status = 'open' AND amount_net = ? AND expires_at > ? ORDER BY id DESC LIMIT 1",
            [(int) $b['id'], $purpose, $net, Clock::toSql($now->modify('+5 minutes'))]
        );
        if ($open && $open['url']) {
            return ['url' => $open['url'], 'sessionId' => $open['stripe_session_id'], 'reused' => true];
        }
        $passFee = $this->config->bool('business.pass_card_fee_to_customer', true);
        $cb = $passFee ? PaymentMath::grossFromNet($net) : ['netAmountCents' => PaymentMath::dollarsToCents($net), 'estimatedFeeCents' => 0, 'netAmount' => $net, 'estimatedFee' => 0.0, 'grossAmount' => $net];
        // Deposit sessions expire with the slot hold; balance sessions after 24h.
        $expires = $purpose === 'deposit' && $b['status'] === 'pending_payment' && $b['hold_expires_at']
            ? min(Clock::fromSql($b['hold_expires_at'])->modify('-5 minutes')->getTimestamp(), $now->modify('+23 hours')->getTimestamp())
            : $now->modify('+23 hours')->getTimestamp();
        $expires = max($expires, $now->modify('+31 minutes')->getTimestamp()); // Stripe minimum is 30 minutes
        $base = rtrim($this->config->string('app.url'), '/');
        $path = $purpose === 'deposit' ? '/confirm' : '/payment-confirmation';
        $metadata = ['booking_ref' => $b['ref'], 'purpose' => $purpose, 'net_amount' => PaymentMath::toFixed($net, 2)];
        $lines = [[
            'price_data' => ['currency' => 'usd', 'unit_amount' => $cb['netAmountCents'], 'product_data' => [
                'name' => $purpose === 'deposit' ? 'Booking deposit' : 'Remaining balance',
                'description' => $b['service_name'] . ' – ' . $this->clock->toBusiness(Clock::fromSql($b['start_at']))->format('M j, Y g:i A') . ' (' . $b['invoice_number'] . ')',
            ]],
            'quantity' => 1,
        ]];
        if ($cb['estimatedFeeCents'] > 0) {
            $lines[] = ['price_data' => ['currency' => 'usd', 'unit_amount' => $cb['estimatedFeeCents'], 'product_data' => ['name' => 'Card processing fee']], 'quantity' => 1];
        }
        $session = $this->stripe->createCheckoutSession([
            'mode' => 'payment',
            'payment_method_types' => ['card'],
            'customer_email' => $b['contact_email'],
            'client_reference_id' => $b['ref'],
            'metadata' => $metadata,
            'payment_intent_data' => ['metadata' => $metadata, 'description' => $b['invoice_number'] . ' ' . $purpose],
            'line_items' => $lines,
            'expires_at' => $expires,
            'success_url' => "{$base}{$path}?booking=" . rawurlencode($b['ref']) . '&session_id={CHECKOUT_SESSION_ID}',
            'cancel_url' => "{$base}{$path}?booking=" . rawurlencode($b['ref']) . '&cancelled=1',
        ], 'checkout-' . $b['ref'] . '-' . $purpose . '-' . PaymentMath::dollarsToCents($net) . '-' . $now->format('YmdHi'));
        if ($this->db->one('SELECT id FROM checkout_sessions WHERE stripe_session_id = ?', [(string) $session['id']])) {
            return ['url' => $session['url'] ?? null, 'sessionId' => $session['id'], 'reused' => true]; // idempotent replay
        }
        $this->db->insert('checkout_sessions', [
            'booking_id' => (int) $b['id'],
            'stripe_session_id' => (string) $session['id'],
            'purpose' => $purpose,
            'amount_net' => $cb['netAmount'],
            'amount_fee' => $cb['estimatedFee'],
            'amount_gross' => $cb['grossAmount'],
            'url' => $session['url'] ?? null,
            'status' => 'open',
            'expires_at' => Clock::toSql((new \DateTimeImmutable('@' . $expires))),
            'created_at' => Clock::toSql($now),
        ]);
        return ['url' => $session['url'] ?? null, 'sessionId' => $session['id'], 'reused' => false];
    }

    /**
     * Applies a Stripe Checkout Session object (from a webhook or a retrieve call).
     * @return array|null booking row when a payment was applied or already recorded
     */
    public function applySession(array $s, string $eventKey): ?array
    {
        $row = $this->db->one('SELECT * FROM checkout_sessions WHERE stripe_session_id = ?', [(string) ($s['id'] ?? '')]);
        if (!$row) {
            $this->log->warning('checkout session not recognized', ['session' => $s['id'] ?? null]);
            return null;
        }
        if (($s['status'] ?? '') === 'expired') {
            $this->db->run("UPDATE checkout_sessions SET status = 'expired' WHERE id = ? AND status = 'open'", [(int) $row['id']]);
            return null;
        }
        if (($s['payment_status'] ?? '') !== 'paid') {
            return null;
        }
        $b = $this->repo->byId((int) $row['booking_id']);
        $expectedCents = PaymentMath::dollarsToCents((float) $row['amount_gross']);
        $mismatch = [];
        if ((int) ($s['amount_total'] ?? -1) !== $expectedCents) {
            $mismatch[] = 'amount';
        }
        if (strtolower((string) ($s['currency'] ?? '')) !== 'usd') {
            $mismatch[] = 'currency';
        }
        if (($s['metadata']['booking_ref'] ?? null) !== $b['ref']) {
            $mismatch[] = 'booking';
        }
        if ($mismatch) {
            $msg = 'Stripe payment does not match the recorded checkout (' . implode(', ', $mismatch) . '). Review it in Stripe before crediting.';
            $this->db->transaction(function () use ($b, $msg, $eventKey) {
                $this->repo->update((int) $b['id'], ['needs_attention' => $msg]);
                $this->repo->history((int) $b['id'], 'needs_attention', 'system', null, ['message' => $msg]);
            });
            $this->log->error('checkout mismatch', ['booking' => $b['ref'], 'session' => $s['id'], 'mismatch' => $mismatch]);
            throw new \DomainException($msg);
        }
        $pi = is_array($s['payment_intent'] ?? null) ? (string) $s['payment_intent']['id'] : (string) ($s['payment_intent'] ?? '');
        if ($pi === '') {
            throw new \DomainException('Paid session has no payment intent.');
        }
        return $this->db->transaction(function () use ($row, $b, $pi, $eventKey) {
            $this->db->run("UPDATE checkout_sessions SET status = 'complete' WHERE id = ?", [(int) $row['id']]);
            $r = $this->ledger->record($b, [
                'purpose' => $row['purpose'],
                'method' => 'card',
                'amount' => (float) $row['amount_net'],
                'fee' => (float) $row['amount_fee'],
                'gross' => (float) $row['amount_gross'],
                'source' => 'stripe',
                'stripe_payment_intent_id' => $pi,
                'checkout_session_id' => (int) $row['id'],
            ], 'client', $b['user_id'] !== null ? (int) $b['user_id'] : null);
            if ($r['duplicate']) {
                return $r['booking'];
            }
            return $this->bookings->afterPayment($r['booking'], $eventKey);
        });
    }

    /** Called from the success page: confirms with Stripe directly (no waiting for the webhook). */
    public function sync(array $b, string $sessionId): array
    {
        $row = $this->db->one('SELECT * FROM checkout_sessions WHERE stripe_session_id = ? AND booking_id = ?', [$sessionId, (int) $b['id']]);
        if (!$row) {
            throw HttpError::notFound('Payment session not found for this booking.');
        }
        if ($row['status'] === 'open') {
            $this->applySession($this->stripe->retrieveCheckoutSession($sessionId, ['payment_intent']), 'sync:' . $sessionId);
        }
        return (array) $this->repo->byId((int) $b['id']);
    }

    /** Closes open Stripe sessions for bookings that no longer accept payment. */
    public function expireOpenSessions(int $bookingId): void
    {
        foreach ($this->db->all("SELECT * FROM checkout_sessions WHERE booking_id = ? AND status = 'open'", [$bookingId]) as $row) {
            try {
                $this->stripe->expireCheckoutSession((string) $row['stripe_session_id']);
                $this->db->run("UPDATE checkout_sessions SET status = 'expired' WHERE id = ?", [(int) $row['id']]);
            } catch (\Throwable $e) {
                // Already completed/expired at Stripe: reconcile on the next recovery run.
                $this->log->warning('could not expire checkout session', ['session' => $row['stripe_session_id'], 'error' => $e->getMessage()]);
            }
        }
    }

    /** Recovery: re-checks open sessions with Stripe (missed webhooks, closed browsers). */
    public function reconcileOpen(int $minAgeMinutes = 5, int $limit = 50): array
    {
        $rows = $this->db->all("SELECT stripe_session_id FROM checkout_sessions WHERE status = 'open' AND created_at <= ? ORDER BY id LIMIT " . max(1, $limit), [Clock::toSql($this->clock->now()->modify("-{$minAgeMinutes} minutes"))]);
        $applied = $expired = $errors = 0;
        foreach ($rows as $r) {
            try {
                $s = $this->stripe->retrieveCheckoutSession((string) $r['stripe_session_id'], ['payment_intent']);
                if (($s['status'] ?? '') === 'expired') {
                    $this->applySession($s, 'recover:' . $s['id']);
                    $expired++;
                } elseif ($this->applySession($s, 'recover:' . $s['id'])) {
                    $applied++;
                }
            } catch (\Throwable $e) {
                $errors++;
                $this->log->error('reconcile session failed', ['session' => $r['stripe_session_id'], 'error' => $e->getMessage()]);
            }
        }
        return ['checked' => count($rows), 'applied' => $applied, 'expired' => $expired, 'errors' => $errors];
    }
}

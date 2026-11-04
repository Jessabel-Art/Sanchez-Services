<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use SanchezServices\Clock;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;
use SanchezServices\Infra\StripeClient;

/**
 * Payment ledger. Booking money fields (amount_paid, amount_refunded, payment_status) are ALWAYS
 * recomputed from the ledger, so the client portal, admin pages, invoices and reports agree.
 */
final class Ledger
{
    public const METHODS = ['card', 'cash', 'zelle', 'venmo', 'cash_app', 'check', 'other'];

    public function __construct(private Db $db, private Clock $clock, private BookingRepo $repo, private Notifier $notify, private StripeClient $stripe)
    {
    }

    public static function paymentStatus(float $total, float $deposit, float $paid, float $refunded): string
    {
        if ($total <= 0) {
            return 'not_required';
        }
        if ($refunded > 0 && $paid <= 0.004) {
            return 'refunded';
        }
        if ($paid + 0.004 >= $total) {
            return 'paid';
        }
        if ($paid > 0.004) {
            return 'deposit_paid';
        }
        return 'unpaid';
    }

    /** Recomputes money fields from the ledger. Returns the fresh booking row. */
    public function recalc(int $bookingId): array
    {
        $sums = $this->db->one(
            "SELECT
               COALESCE(SUM(CASE WHEN type = 'payment' AND status = 'succeeded' THEN amount END), 0) AS paid,
               COALESCE(SUM(CASE WHEN type = 'refund' AND status = 'succeeded' THEN amount END), 0) AS refunded
             FROM payments WHERE booking_id = ?",
            [$bookingId]
        );
        $b = $this->repo->byId($bookingId, true);
        $paid = round((float) $sums['paid'] - (float) $sums['refunded'], 2);
        $refunded = round((float) $sums['refunded'], 2);
        $this->repo->update($bookingId, [
            'amount_paid' => $paid,
            'amount_refunded' => $refunded,
            'payment_status' => self::paymentStatus((float) $b['total_price'], (float) $b['deposit_amount'], $paid, $refunded),
        ]);
        return (array) $this->repo->byId($bookingId);
    }

    /**
     * Records a payment (inside the caller's transaction). Idempotent on stripe_payment_intent_id.
     * @return array{payment:?array,booking:array,duplicate:bool}
     */
    public function record(array $booking, array $p, string $actorRole, ?int $actorUserId): array
    {
        $method = (string) ($p['method'] ?? '');
        if (!in_array($method, self::METHODS, true)) {
            throw HttpError::invalid('Unsupported payment method.');
        }
        $amount = round((float) ($p['amount'] ?? 0), 2);
        if ($amount <= 0 || $amount > 100000) {
            throw HttpError::invalid('Payment amount must be greater than zero.');
        }
        $pi = $p['stripe_payment_intent_id'] ?? null;
        if ($pi && ($existing = $this->db->one('SELECT * FROM payments WHERE stripe_payment_intent_id = ?', [$pi]))) {
            return ['payment' => $existing, 'booking' => (array) $this->repo->byId((int) $booking['id']), 'duplicate' => true];
        }
        $now = Clock::toSql($this->clock->now());
        $id = $this->db->insert('payments', [
            'booking_id' => (int) $booking['id'],
            'type' => 'payment',
            'purpose' => $p['purpose'] ?? 'other',
            'method' => $method,
            'amount' => $amount,
            'fee' => round((float) ($p['fee'] ?? 0), 2),
            'gross' => round((float) ($p['gross'] ?? $amount), 2),
            'status' => 'succeeded',
            'source' => $p['source'],
            'stripe_payment_intent_id' => $pi,
            'checkout_session_id' => $p['checkout_session_id'] ?? null,
            'note' => isset($p['note']) ? mb_substr((string) $p['note'], 0, 500) : null,
            'recorded_by_user_id' => $actorUserId,
            'paid_at' => isset($p['paid_at']) ? Clock::toSql($p['paid_at']) : $now,
            'created_at' => $now,
        ]);
        $fresh = $this->recalc((int) $booking['id']);
        $payment = (array) $this->db->one('SELECT * FROM payments WHERE id = ?', [$id]);
        $this->repo->history((int) $booking['id'], 'payment', $actorRole, $actorUserId, ['amount' => $amount, 'method' => $method, 'purpose' => $payment['purpose'], 'paymentId' => $id]);
        $this->notify->paymentReceipt($fresh, $payment);
        return ['payment' => $payment, 'booking' => $fresh, 'duplicate' => false];
    }

    /** Admin refund. Card payments are refunded through Stripe; others are recorded as manual refunds. */
    public function refund(int $paymentId, float $amount, ?string $reason, int $adminId): array
    {
        $amount = round($amount, 2);
        if ($amount <= 0) {
            throw HttpError::invalid('Refund amount must be greater than zero.');
        }
        // Lock + validate first, call Stripe outside the DB transaction, then record.
        $p = $this->db->transaction(function () use ($paymentId, $amount) {
            $p = $this->db->one('SELECT * FROM payments WHERE id = ? FOR UPDATE', [$paymentId]);
            if (!$p || $p['type'] !== 'payment' || $p['status'] !== 'succeeded') {
                throw HttpError::notFound('Payment not found.');
            }
            $already = (float) $this->db->scalar("SELECT COALESCE(SUM(amount),0) FROM payments WHERE refund_of_payment_id = ? AND status = 'succeeded'", [$paymentId]);
            if ($amount > round((float) $p['amount'] - $already, 2) + 0.004) {
                throw HttpError::invalid('Refund exceeds the refundable amount ($' . number_format((float) $p['amount'] - $already, 2) . ').');
            }
            return $p;
        });
        $stripeRefundId = null;
        if ($p['method'] === 'card' && $p['stripe_payment_intent_id']) {
            $r = $this->stripe->createRefund([
                'payment_intent' => $p['stripe_payment_intent_id'],
                'amount' => PaymentMath::dollarsToCents($amount),
                'metadata' => ['booking_id' => (string) $p['booking_id'], 'payment_id' => (string) $paymentId],
            ], 'refund-' . $paymentId . '-' . PaymentMath::dollarsToCents($amount) . '-' . $this->countRefunds($paymentId));
            $stripeRefundId = (string) ($r['id'] ?? '');
            if (!in_array($r['status'] ?? '', ['succeeded', 'pending'], true)) {
                throw new HttpError('failed-precondition', 'Stripe did not accept the refund (' . ($r['status'] ?? 'unknown') . ').');
            }
        }
        return $this->db->transaction(function () use ($p, $amount, $reason, $adminId, $stripeRefundId, $paymentId) {
            if ($stripeRefundId && $this->db->one('SELECT id FROM payments WHERE stripe_refund_id = ?', [$stripeRefundId])) {
                return $this->repo->byId((int) $p['booking_id']);
            }
            $now = Clock::toSql($this->clock->now());
            $id = $this->db->insert('payments', [
                'booking_id' => (int) $p['booking_id'], 'type' => 'refund', 'purpose' => $p['purpose'], 'method' => $p['method'],
                'amount' => $amount, 'fee' => 0, 'gross' => $amount, 'status' => 'succeeded', 'source' => $stripeRefundId ? 'stripe' : 'admin',
                'stripe_refund_id' => $stripeRefundId, 'refund_of_payment_id' => $paymentId, 'note' => $reason ? mb_substr($reason, 0, 500) : null,
                'recorded_by_user_id' => $adminId, 'paid_at' => $now, 'created_at' => $now,
            ]);
            $fresh = $this->recalc((int) $p['booking_id']);
            $this->repo->history((int) $p['booking_id'], 'refund', 'admin', $adminId, ['amount' => $amount, 'paymentId' => $paymentId, 'reason' => $reason]);
            $this->notify->refundIssued($fresh, (array) $this->db->one('SELECT * FROM payments WHERE id = ?', [$id]));
            return $fresh;
        });
    }

    private function countRefunds(int $paymentId): int
    {
        return (int) $this->db->scalar('SELECT COUNT(*) FROM payments WHERE refund_of_payment_id = ?', [$paymentId]);
    }

    /** Voids a manually recorded entry (mistakes). Stripe payments must be refunded instead. */
    public function void(int $paymentId, int $adminId, ?string $reason): array
    {
        return $this->db->transaction(function () use ($paymentId, $adminId, $reason) {
            $p = $this->db->one('SELECT * FROM payments WHERE id = ? FOR UPDATE', [$paymentId]);
            if (!$p || $p['status'] !== 'succeeded') {
                throw HttpError::notFound('Payment not found.');
            }
            if ($p['source'] === 'stripe') {
                throw new HttpError('failed-precondition', 'Card payments cannot be voided; issue a refund instead.');
            }
            if ((int) $this->db->scalar("SELECT COUNT(*) FROM payments WHERE refund_of_payment_id = ? AND status = 'succeeded'", [$paymentId]) > 0) {
                throw new HttpError('failed-precondition', 'Void the refunds recorded against this payment first.');
            }
            $this->db->run("UPDATE payments SET status = 'voided', voided_at = ? WHERE id = ?", [Clock::toSql($this->clock->now()), $paymentId]);
            $this->repo->history((int) $p['booking_id'], 'payment_voided', 'admin', $adminId, ['paymentId' => $paymentId, 'reason' => $reason]);
            return $this->recalc((int) $p['booking_id']);
        });
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use SanchezServices\Store\Doc;

/** Ports of getBookingPaymentAmounts(), normalizeBookingPaymentStatus(), getBookingEmail(), buildPaymentPatch(). */
final class PaymentAmounts
{
    /** JS `a ?? b ?? c` (null/undefined only). */
    private static function coalesce(array $b, array $paths): mixed
    {
        foreach ($paths as $p) {
            [$exists, $v] = Doc::getPath($b, $p);
            if ($exists && $v !== null) {
                return $v;
            }
        }
        return null;
    }

    private static function jsNumber(mixed $v): float
    {
        // Number(x): null->0, ''->0, true->1, numeric strings parse, other -> NaN
        if ($v === null || $v === '') {
            return 0.0;
        }
        if (is_bool($v)) {
            return $v ? 1.0 : 0.0;
        }
        if (is_int($v) || is_float($v)) {
            return (float) $v;
        }
        if (is_string($v) && is_numeric(trim($v))) {
            return (float) trim($v);
        }
        return NAN;
    }

    /** @return array{totalPrice:float,depositAmount:float,paidAmount:float,remainingDue:float} */
    public static function fromBooking(array $b): array
    {
        $totalRaw = self::coalesce($b, ['totalPrice', 'totalAmount', 'total', 'amount', 'cost', 'estimate.total']);
        $total = self::jsNumber($totalRaw ?? 0);
        $total = is_nan($total) ? NAN : max(0, $total);
        $deposit = self::jsNumber(Pricing::jsOr($b['depositAmount'] ?? null, 0));
        $deposit = is_nan($deposit) ? 0.0 : max(0, $deposit);

        $explicitRaw = self::coalesce($b, ['paidAmount', 'amountPaid', 'paid']);
        $explicit = $explicitRaw === null ? NAN : self::jsNumber($explicitRaw);
        $storedRaw = self::coalesce($b, ['balanceDue', 'remainingDue', 'remainingBalance']);
        $stored = $storedRaw === null ? NAN : self::jsNumber($storedRaw);

        if (is_finite($explicit)) {
            $paid = $explicit;
        } elseif (is_finite($stored) && $total > 0) {
            $paid = $total - max(0, $stored);
        } elseif (!empty($b['depositPaid'])) {
            $paid = $deposit;
        } else {
            $paid = 0.0;
        }
        if (is_nan($total)) {
            $total = 0.0; // JS would propagate NaN; treat as 0 (defensive, documented)
        }
        $paid = max(0, min($total, $paid));
        return [
            'totalPrice' => (float) $total,
            'depositAmount' => (float) $deposit,
            'paidAmount' => (float) $paid,
            'remainingDue' => (float) max(0, $total - $paid),
        ];
    }

    public static function normalizeStatus(array $amounts, array $b): string
    {
        $refunded = self::jsNumber($b['refundedAmount'] ?? 0);
        if (!empty($b['refunded']) || (!is_nan($refunded) && $refunded > 0)) {
            return 'refunded';
        }
        $status = strtolower(trim((string) ($b['status'] ?? '')));
        if ($status === 'cancelled') {
            return 'cancelled';
        }
        if ($status === 'declined') {
            return 'not_required';
        }
        if ($amounts['totalPrice'] <= 0) {
            return 'not_required';
        }
        if ($amounts['paidAmount'] >= $amounts['totalPrice'] || $amounts['remainingDue'] <= 0) {
            return 'paid';
        }
        if ($amounts['paidAmount'] > 0 || !empty($b['depositPaid'])) {
            return 'partial';
        }
        return 'unpaid';
    }

    public static function normalizeEmail(mixed $v): string
    {
        return strtolower(trim((string) ($v ?? '')));
    }

    /** getBookingEmail() */
    public static function bookingEmail(array $b): string
    {
        return self::normalizeEmail(Pricing::jsOr(
            Doc::get($b, 'contact.emailLower'),
            Doc::get($b, 'contact.email'),
            $b['contactEmailLower'] ?? null,
            $b['customerEmail'] ?? null,
            $b['email'] ?? null,
            ''
        ));
    }

    /**
     * buildPaymentPatch() — returns a doc patch (update semantics) or null when already processed.
     * Throws \DomainException on amount mismatch (webhook responds 500 so Stripe retries, as today).
     *
     * @param array<string,mixed> $metadata Stripe metadata
     * @return array<string,mixed>|null
     */
    public static function buildPaymentPatch(array $booking, string $mode, string $paymentIntentId, array $metadata): ?array
    {
        $a = self::fromBooking($booking);
        $expected = $mode === 'deposit' ? min($a['depositAmount'], $a['remainingDue']) : $a['remainingDue'];
        $already = $mode === 'deposit'
            ? (!empty($booking['depositPaid']) || !empty($booking['depositPaymentIntentId']))
            : (($booking['balancePaymentIntentId'] ?? null) === $paymentIntentId);
        if ($already || $expected <= 0) {
            return null;
        }
        $checkout = self::jsNumber($metadata['intended_net_amount'] ?? null);
        if (!is_finite($checkout) || abs($checkout - $expected) > 0.01) {
            throw new \DomainException('Stripe payment amount no longer matches the authoritative booking amount.');
        }
        $newPaid = min($a['totalPrice'], $a['paidAmount'] + $expected);
        $remaining = max(0, $a['totalPrice'] - $newPaid);
        $fee = self::jsNumber(Pricing::jsOr($metadata['estimated_stripe_fee'] ?? null, 0));
        $gross = self::jsNumber(Pricing::jsOr($metadata['gross_charge_amount'] ?? null, 0));
        $fee = is_nan($fee) ? 0.0 : $fee;
        $gross = is_nan($gross) ? 0.0 : $gross;
        $now = ['__op' => 'serverTimestamp'];
        $patch = [
            'paidAmount' => $newPaid,
            'amountPaid' => $newPaid,
            'remainingDue' => $remaining,
            'balanceDue' => $remaining,
            'stripePaymentIntentId' => $paymentIntentId,
            'paymentStatus' => self::normalizeStatus(array_merge($a, ['paidAmount' => $newPaid, 'remainingDue' => $remaining]), $booking),
            'paymentSource' => 'stripe',
            'amountNet' => $expected,
            'amountFee' => $fee,
            'amountGross' => $gross,
            'updatedAt' => $now,
        ];
        if ($remaining <= 0) {
            $patch['paidAt'] = $now;
        }
        $statusLower = strtolower((string) ($booking['status'] ?? ''));
        $terminal = in_array($statusLower, ['cancelled', 'declined'], true);
        if ($mode === 'deposit') {
            $patch['depositPaid'] = true;
            $patch['depositPaymentIntentId'] = $paymentIntentId;
            $patch['depositPaymentMethod'] = 'card_stripe';
            $patch['depositStripeNetAmount'] = $expected;
            $patch['depositStripeFeeAmount'] = $fee;
            $patch['depositStripeGrossAmount'] = $gross;
            if (!$terminal) {
                $patch['status'] = 'confirmed';
                $patch['bookingStatus'] = 'confirmed';
            }
        } else {
            $patch['balancePaymentIntentId'] = $paymentIntentId;
            $patch['balancePaymentMethod'] = 'card_stripe';
            $patch['paymentMethod'] = 'card_stripe';
            $patch['balanceStripeNetAmount'] = $expected;
            $patch['balanceStripeFeeAmount'] = $fee;
            $patch['balanceStripeGrossAmount'] = $gross;
            if (!$terminal) {
                $patch['bookingStatus'] = $remaining <= 0 ? 'completed' : 'confirmed';
                if ($remaining <= 0) {
                    $patch['status'] = 'completed';
                }
            }
        }
        return $patch;
    }
}

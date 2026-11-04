<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;
use SanchezServices\Infra\Logger;
use SanchezServices\Infra\StripeClient;
use SanchezServices\Store\Doc;

/** Stripe checkout creation + authoritative payment application (ports of index.js helpers). */
final class Payments
{
    public function __construct(
        private Db $db,
        private Clock $clock,
        private Config $config,
        private Bookings $bookings,
        private StripeClient $stripe,
        private Logger $log,
    ) {
    }

    public function frontendUrl(): string
    {
        $u = $this->config->string('stripe.frontend_url') ?: $this->config->string('app.url');
        return rtrim($u, '/');
    }

    public function isConfigured(): bool
    {
        return $this->stripe->isConfigured() && $this->frontendUrl() !== '';
    }

    public static function normalizeMode(mixed $value): string
    {
        $m = strtolower(trim((string) $value));
        if ($m === 'deposit' || $m === 'remaining_due') {
            return $m;
        }
        throw HttpError::invalid('Mode must be deposit or remaining_due.');
    }

    /** createSecureStripeSession() */
    public function createSession(string $bookingId, array $booking, string $email, ?string $customerName, string $mode): array
    {
        $a = PaymentAmounts::fromBooking($booking);
        $net = $mode === 'deposit' ? min($a['depositAmount'], $a['remainingDue']) : $a['remainingDue'];
        if ($net <= 0) {
            throw new HttpError('failed-precondition', $mode === 'deposit' ? 'The deposit is already paid.' : 'There is no remaining amount due.');
        }
        $customer = $this->stripe->createCustomer([
            'email' => $email,
            'name' => Pricing::jsOr($customerName, Doc::get($booking, 'contact.name'), null),
            'metadata' => ['bookingId' => $bookingId],
        ]);
        $cb = PaymentMath::grossFromNet($net);
        $metadata = [
            'bookingId' => $bookingId,
            'mode' => $mode,
            'payment_type' => $mode,
            'intended_net_amount' => PaymentMath::toFixed((float) $cb['netAmount'], 2),
            'estimated_stripe_fee' => PaymentMath::toFixed((float) $cb['estimatedFee'], 2),
            'gross_charge_amount' => PaymentMath::toFixed((float) $cb['grossAmount'], 2),
        ];
        $successPath = $mode === 'remaining_due' ? '/payment-confirmation' : '/confirm';
        $base = $this->frontendUrl();
        $lineItems = [[
            'price_data' => [
                'currency' => 'usd',
                'product_data' => ['name' => $mode === 'remaining_due' ? 'Sanchez Services remaining balance' : 'Sanchez Services booking deposit'],
                'unit_amount' => $cb['netAmountCents'],
            ],
            'quantity' => 1,
        ]];
        if ($cb['estimatedFeeCents'] > 0) {
            $lineItems[] = [
                'price_data' => ['currency' => 'usd', 'product_data' => ['name' => 'Card processing fee'], 'unit_amount' => $cb['estimatedFeeCents']],
                'quantity' => 1,
            ];
        }
        $session = $this->stripe->createCheckoutSession([
            'mode' => 'payment',
            'payment_method_types' => ['card'],
            'customer' => $customer['id'],
            'metadata' => $metadata,
            'payment_intent_data' => ['metadata' => $metadata],
            // {CHECKOUT_SESSION_ID} must stay literal for Stripe to substitute.
            'success_url' => "{$base}{$successPath}?bookingId=" . rawurlencode($bookingId) . '&session_id={CHECKOUT_SESSION_ID}&mode=' . $mode,
            'cancel_url' => "{$base}{$successPath}?bookingId=" . rawurlencode($bookingId) . '&cancelled=1&mode=' . $mode,
            'line_items' => $lineItems,
        ]);
        $this->bookings->update($bookingId, [
            'stripeCustomerId' => $customer['id'],
            'stripeSessionId' => $session['id'],
            'paymentStatus' => 'checkout_created',
            'amountNet' => $cb['netAmount'],
            'amountFee' => $cb['estimatedFee'],
            'amountGross' => $cb['grossAmount'],
            'updatedAt' => ['__op' => 'serverTimestamp'],
        ]);
        return $session;
    }

    /**
     * applySuccessfulPayment(): row-locked, idempotent (booking fields + unique PaymentIntent in ledger).
     * @return bool true when the booking changed
     */
    public function applySuccessfulPayment(string $bookingId, string $mode, string $paymentIntentId, array $metadata, array $extraPatch = [], string $source = 'stripe', ?string $eventId = null): bool
    {
        return $this->db->transaction(function () use ($bookingId, $mode, $paymentIntentId, $metadata, $extraPatch, $source, $eventId) {
            $before = $this->bookings->get($bookingId, true);
            if ($before === null) {
                return false;
            }
            $patch = PaymentAmounts::buildPaymentPatch($before, $mode, $paymentIntentId, $metadata);
            if ($patch === null) {
                return false;
            }
            $after = Doc::applyUpdate($before, $patch + $extraPatch, $this->clock->now());
            $this->bookings->save($bookingId, $before, $after);
            $now = Clock::toSql($this->clock->now());
            $this->db->run(
                'INSERT INTO payments (booking_doc_id, kind, source, amount_net, amount_fee, amount_gross, stripe_payment_intent_id, stripe_event_id, occurred_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE stripe_event_id = COALESCE(stripe_event_id, VALUES(stripe_event_id))',
                [$bookingId, $mode, $source, $patch['amountNet'], $patch['amountFee'], $patch['amountGross'], $paymentIntentId, $eventId, $now, $now]
            );
            return true;
        });
    }
}

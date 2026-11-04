<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use DateTimeImmutable;
use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;

/** Booking persistence + the ONE serializer used by client and admin APIs (consistent records). */
final class BookingRepo
{
    public const ACTIVE = ['pending_payment', 'pending', 'confirmed'];
    public const TERMINAL = ['completed', 'cancelled', 'declined', 'expired'];

    public function __construct(private Db $db, private Clock $clock, private Config $config)
    {
    }

    public function byRef(string $ref, bool $forUpdate = false): ?array
    {
        return $this->db->one('SELECT * FROM bookings WHERE ref = ?' . ($forUpdate ? ' FOR UPDATE' : ''), [$ref]);
    }

    public function byId(int $id, bool $forUpdate = false): ?array
    {
        return $this->db->one('SELECT * FROM bookings WHERE id = ?' . ($forUpdate ? ' FOR UPDATE' : ''), [$id]);
    }

    public function requireRef(string $ref, bool $forUpdate = false): array
    {
        return $this->byRef($ref, $forUpdate) ?? throw HttpError::notFound('Booking not found.');
    }

    public static function newRef(): string
    {
        $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        $out = '';
        for ($i = 0; $i < 20; $i++) {
            $out .= $chars[random_int(0, strlen($chars) - 1)];
        }
        return $out;
    }

    /** @param array<string,mixed> $row */
    public function insert(array $row): int
    {
        $now = Clock::toSql($this->clock->now());
        $row += ['created_at' => $now, 'updated_at' => $now];
        $id = $this->db->insert('bookings', $row);
        $year = substr((string) $row['created_at'], 0, 4);
        $this->db->run('UPDATE bookings SET invoice_number = ? WHERE id = ? AND invoice_number IS NULL', [
            sprintf('%s-%s-%06d', $this->config->string('business.invoice_prefix', 'SS'), $year, $id), $id,
        ]);
        return $id;
    }

    /** @param array<string,mixed> $set */
    public function update(int $id, array $set): void
    {
        $set['updated_at'] = Clock::toSql($this->clock->now());
        $this->db->update('bookings', $set, ['id' => $id]);
    }

    public function history(int $bookingId, string $event, string $actorRole, ?int $actorUserId, array $details = []): void
    {
        $this->db->insert('booking_history', [
            'booking_id' => $bookingId,
            'event' => $event,
            'actor_user_id' => $actorUserId,
            'actor_role' => $actorRole,
            'details_json' => $details ? json_encode($details, JSON_UNESCAPED_SLASHES) : null,
            'created_at' => Clock::toSql($this->clock->now()),
        ]);
    }

    // ------------------------------------------------------------------ rules shared by UI + server

    public function hoursUntilStart(array $b): float
    {
        return (Clock::fromSql($b['start_at'])->getTimestamp() - $this->clock->now()->getTimestamp()) / 3600;
    }

    public function balanceDue(array $b): float
    {
        return max(0.0, round((float) $b['total_price'] - (float) $b['amount_paid'], 2));
    }

    public function depositDue(array $b): float
    {
        return max(0.0, round(min((float) $b['deposit_amount'], (float) $b['total_price']) - (float) $b['amount_paid'], 2));
    }

    /** Client self-service permissions, with the reason when not allowed (Terms: 24h notice). */
    public function clientPermissions(array $b, bool $hasReview): array
    {
        $cutoff = $this->config->int('business.client_change_cutoff_hours', 24);
        $hours = $this->hoursUntilStart($b);
        $status = $b['status'];
        $lateReason = "Changes within {$cutoff} hours of your appointment must be made by phone or email.";
        $canChange = in_array($status, ['pending', 'confirmed'], true) && $hours >= $cutoff;
        $canCancel = $status === 'pending_payment' || $canChange;
        return [
            'canCancel' => $canCancel,
            'canReschedule' => $canChange,
            'changeBlockedReason' => !$canCancel && in_array($status, self::ACTIVE, true) ? $lateReason : null,
            'canPayDeposit' => in_array($status, ['pending_payment', 'pending', 'confirmed'], true) && $this->depositDue($b) > 0 && $hours > 0,
            'canPayBalance' => in_array($status, ['confirmed', 'completed'], true) && $this->balanceDue($b) > 0 && $this->depositDue($b) <= 0,
            'canReview' => $status === 'completed' && !$hasReview,
        ];
    }

    // ------------------------------------------------------------------ serialization

    public static function iso(?string $sql): ?string
    {
        return $sql ? Clock::iso(Clock::fromSql($sql)) : null;
    }

    /** @param array<string,mixed> $b */
    public function toApi(array $b, bool $admin = false, array $extra = []): array
    {
        $start = Clock::fromSql($b['start_at']);
        $local = $this->clock->toBusiness($start);
        $review = $extra['review'] ?? $this->db->one('SELECT id, rating, status FROM reviews WHERE booking_id = ?', [(int) $b['id']]);
        $pricing = $b['pricing_json'] ? json_decode((string) $b['pricing_json'], true) : null;
        $out = [
            'id' => $b['ref'],
            'invoiceNumber' => $b['invoice_number'],
            'status' => $b['status'],
            'serviceSlug' => $b['service_slug'],
            'serviceName' => $b['service_name'],
            'frequency' => $b['frequency'],
            'propertyType' => $b['property_type'],
            'bedrooms' => $b['bedrooms'] !== null ? (float) $b['bedrooms'] : null,
            'bathrooms' => $b['bathrooms'] !== null ? (float) $b['bathrooms'] : null,
            'sqft' => $b['sqft'] !== null ? (int) $b['sqft'] : null,
            'condition' => $b['property_condition'],
            'pets' => (int) $b['pets'] === 1,
            'addons' => $b['addons_json'] ? (json_decode((string) $b['addons_json'], true) ?: []) : [],
            'promoCode' => $b['promo_code'],
            'startAt' => Clock::iso($start),
            'endAt' => self::iso($b['end_at']),
            'date' => $b['business_date'],
            'timeLabel' => Schedule::label($local->format('H:i')),
            'durationMinutes' => (int) $b['duration_minutes'],
            'contact' => ['name' => $b['contact_name'], 'email' => $b['contact_email'], 'phone' => $b['contact_phone']],
            'address' => [
                'line1' => $b['address_line1'], 'line2' => $b['address_line2'], 'city' => $b['address_city'],
                'state' => $b['address_state'], 'zip' => $b['address_zip'],
            ],
            'accessNotes' => $b['access_notes'],
            'cleanerNotes' => $b['cleaner_notes'],
            'totalPrice' => (float) $b['total_price'],
            'depositAmount' => (float) $b['deposit_amount'],
            'amountPaid' => (float) $b['amount_paid'],
            'amountRefunded' => (float) $b['amount_refunded'],
            'balanceDue' => $this->balanceDue($b),
            'depositDue' => $this->depositDue($b),
            'depositPaid' => (float) $b['deposit_amount'] > 0 && $this->depositDue($b) <= 0,
            'paymentStatus' => $b['payment_status'],
            'lineItems' => $pricing['lineItems'] ?? [],
            'holdExpiresAt' => $b['status'] === 'pending_payment' ? self::iso($b['hold_expires_at']) : null,
            'cancelledBy' => $b['cancelled_by'],
            'cancellationReason' => $b['cancellation_reason'],
            'createdAt' => self::iso($b['created_at']),
            'updatedAt' => self::iso($b['updated_at']),
            'confirmedAt' => self::iso($b['confirmed_at']),
            'cancelledAt' => self::iso($b['cancelled_at']),
            'completedAt' => self::iso($b['completed_at']),
            'review' => $review ? ['id' => (int) $review['id'], 'rating' => (int) $review['rating'], 'status' => $review['status']] : null,
            'permissions' => $this->clientPermissions($b, (bool) $review),
        ];
        if ($admin) {
            $out['adminNotes'] = $b['admin_notes'];
            $out['userId'] = $b['user_id'] !== null ? (int) $b['user_id'] : null;
            $out['createdVia'] = $b['created_via'];
            $out['needsAttention'] = $b['needs_attention'];
            $out['reminder48SentAt'] = self::iso($b['reminder48_sent_at']);
            $out['reminder24SentAt'] = self::iso($b['reminder24_sent_at']);
        }
        return $out + $extra;
    }

    public function paymentsFor(int $bookingId, bool $admin): array
    {
        $rows = $this->db->all('SELECT * FROM payments WHERE booking_id = ? ORDER BY paid_at, id', [$bookingId]);
        return array_map(fn ($p) => self::paymentToApi($p, $admin), $rows);
    }

    public static function paymentToApi(array $p, bool $admin): array
    {
        $out = [
            'id' => (int) $p['id'],
            'type' => $p['type'],
            'purpose' => $p['purpose'],
            'method' => $p['method'],
            'amount' => (float) $p['amount'],
            'fee' => (float) $p['fee'],
            'gross' => (float) $p['gross'],
            'status' => $p['status'],
            'paidAt' => self::iso($p['paid_at']),
        ];
        if ($admin) {
            $out += [
                'source' => $p['source'],
                'note' => $p['note'],
                'stripePaymentIntentId' => $p['stripe_payment_intent_id'],
                'refundOfPaymentId' => $p['refund_of_payment_id'] !== null ? (int) $p['refund_of_payment_id'] : null,
                'voidedAt' => self::iso($p['voided_at']),
            ];
        }
        return $out;
    }

    public function historyFor(int $bookingId, bool $admin): array
    {
        $rows = $this->db->all('SELECT h.*, u.name AS actor_name FROM booking_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.booking_id = ? ORDER BY h.id', [$bookingId]);
        return array_map(static function ($h) use ($admin) {
            $d = $h['details_json'] ? json_decode((string) $h['details_json'], true) : [];
            if (!$admin) {
                unset($d['adminNotes'], $d['ip']);
            }
            return ['event' => $h['event'], 'actor' => $h['actor_role'], 'actorName' => $admin ? $h['actor_name'] : null, 'details' => $d, 'at' => self::iso($h['created_at'])];
        }, $rows);
    }

    public function detail(array $b, bool $admin): array
    {
        return $this->toApi($b, $admin, [
            'payments' => $this->paymentsFor((int) $b['id'], $admin),
            'history' => $this->historyFor((int) $b['id'], $admin),
        ]);
    }

    public function startOf(array $b): DateTimeImmutable
    {
        return Clock::fromSql($b['start_at']);
    }
}

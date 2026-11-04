<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use DateTimeImmutable;
use SanchezServices\Auth\AuthUser;
use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Input;

/**
 * Every booking state change goes through this class. Creation, rescheduling and duration changes
 * — from customers or admins — all take the per-day lock and run Schedule::assertAvailable().
 */
final class BookingService
{
    public function __construct(
        private Db $db,
        private Clock $clock,
        private Config $config,
        private BookingRepo $repo,
        private Schedule $schedule,
        private Ledger $ledger,
        private Notifier $notify,
    ) {
    }

    // ------------------------------------------------------------------ input parsing

    /** Service options -> authoritative pricing. */
    public function price(Input $in, ?float $totalOverride = null): array
    {
        $slug = Pricing::normalizeServiceSlug($in->str('serviceSlug', true, 50));
        $opts = [
            'serviceSlug' => $slug,
            'bedrooms' => $in->num('bedrooms', false, 0, 20, 0),
            'bathrooms' => $in->num('bathrooms', false, 0, 20, 0),
            'sqft' => $in->int('sqft', false, 0, 200000, 0),
            'condition' => $in->enum('condition', ['light', 'standard', 'heavy'], false, 'standard'),
            'pets' => $in->bool('pets'),
            'addons' => $in->strList('addons'),
            'frequency' => $in->enum('frequency', array_keys(Pricing::FREQUENCY_DISCOUNTS), false, 'one-time'),
            'promoCode' => $in->str('promoCode', false, 30),
        ];
        foreach ($opts['addons'] as $a) {
            if (!isset(Pricing::ADD_ON_PRICING[$a])) {
                throw new HttpError('invalid-argument', 'Unknown add-on.', ['field' => 'addons']);
            }
        }
        $promo = strtoupper(trim((string) $opts['promoCode']));
        $codes = array_change_key_case((array) $this->config->get('business.promo_codes', []), CASE_UPPER);
        if ($promo !== '' && !isset($codes[$promo])) {
            throw new HttpError('invalid-argument', 'That promo code is not valid.', ['field' => 'promoCode']);
        }
        if ($slug === 'office-cleaning' && $opts['sqft'] <= 0) {
            throw new HttpError('invalid-argument', 'Enter the square footage for office cleaning.', ['field' => 'sqft']);
        }
        $p = Pricing::calculate($opts, $this->config->float('business.required_deposit_amount', 50), $codes);
        $items = Pricing::lineItems($opts, $p);
        if ($totalOverride !== null && abs($totalOverride - $p['totalPrice']) >= 0.005) {
            $items[] = ['label' => 'Price adjustment', 'detail' => 'Set by Sanchez Services', 'amount' => round($totalOverride - $p['totalPrice'], 2)];
            $p['totalPrice'] = round($totalOverride, 2);
            $p['depositAmount'] = min($p['totalPrice'], $this->config->float('business.required_deposit_amount', 50));
        }
        return ['options' => $opts, 'pricing' => $p, 'lineItems' => $items];
    }

    /** Quote response for the booking form. */
    public function quote(Input $in): array
    {
        $r = $this->price($in);
        return [
            'serviceSlug' => $r['pricing']['serviceSlug'],
            'serviceName' => $r['pricing']['serviceName'],
            'totalPrice' => $r['pricing']['totalPrice'],
            'depositAmount' => $r['pricing']['depositAmount'],
            'durationMinutes' => $r['pricing']['durationMinutes'],
            'durationHours' => $r['pricing']['estimate']['durationHours'],
            'lineItems' => $r['lineItems'],
            'depositCheckout' => $this->config->bool('business.pass_card_fee_to_customer', true)
                ? PaymentMath::grossFromNet($r['pricing']['depositAmount']) : null,
        ];
    }

    private function contactAndAddress(Input $in): array
    {
        $c = $in->sub('contact', true);
        $a = $in->sub('address', true);
        $state = strtoupper((string) $a->str('state', true, 2));
        if (!preg_match('/^[A-Z]{2}$/', $state)) {
            throw new HttpError('invalid-argument', 'Choose a state.', ['field' => 'address.state']);
        }
        $zip = (string) $a->str('zip', true, 10);
        if (!preg_match('/^\d{5}(-\d{4})?$/', $zip)) {
            throw new HttpError('invalid-argument', 'Enter a valid ZIP code.', ['field' => 'address.zip']);
        }
        return [
            'contact_name' => (string) $c->str('name', true, 200),
            'contact_email' => (string) $c->email('email', true),
            'contact_phone' => $c->phone('phone', true),
            'address_line1' => (string) $a->str('line1', true, 200),
            'address_line2' => $a->str('line2', false, 200),
            'address_city' => (string) $a->str('city', true, 100),
            'address_state' => $state,
            'address_zip' => $zip,
        ];
    }

    private function bookingColumns(array $priced): array
    {
        $o = $priced['options'];
        $p = $priced['pricing'];
        $isSqft = isset(Pricing::SERVICE_PRICING[$p['serviceSlug']]['sqftRate']);
        return [
            'service_slug' => $p['serviceSlug'],
            'service_name' => $p['serviceName'],
            'bedrooms' => $isSqft ? null : $o['bedrooms'],
            'bathrooms' => $isSqft ? null : $o['bathrooms'],
            'sqft' => $o['sqft'] ?: null,
            'property_condition' => $o['condition'],
            'pets' => $o['pets'] ? 1 : 0,
            'addons_json' => json_encode($p['addons']),
            'frequency' => $p['frequency'],
            'promo_code' => $o['promoCode'] ? strtoupper(trim($o['promoCode'])) : null,
            'pricing_json' => json_encode(['lineItems' => $priced['lineItems'], 'estimate' => $p['estimate'], 'options' => $o], JSON_UNESCAPED_SLASHES),
            'total_price' => $p['totalPrice'],
            'deposit_amount' => $p['depositAmount'],
            'payment_status' => $p['totalPrice'] > 0 ? 'unpaid' : 'not_required',
        ];
    }

    private function startFrom(Input $in): DateTimeImmutable
    {
        $date = $in->date('date', true);
        $time = $in->time('time', true);
        return $this->schedule->at((string) $date, (string) $time);
    }

    // ------------------------------------------------------------------ creation

    /**
     * Customer booking: creates a slot hold (pending_payment) atomically. Checkout is started by the caller.
     * Idempotent on (user, requestId).
     */
    public function createOnline(AuthUser $u, Input $in): array
    {
        $requestId = (string) $in->str('requestId', true, 96);
        if (!preg_match('/^[A-Za-z0-9_-]{8,96}$/', $requestId)) {
            throw new HttpError('invalid-argument', 'Invalid request id.', ['field' => 'requestId']);
        }
        $existing = $this->db->one('SELECT * FROM bookings WHERE user_id = ? AND checkout_request_id = ?', [$u->id, $requestId]);
        if ($existing) {
            return $existing;
        }
        $priced = $this->price($in);
        $cols = $this->contactAndAddress($in);
        if (strtolower($cols['contact_email']) !== $u->emailLower) {
            // Bookings belong to the signed-in account; notifications go to its email.
            $cols['contact_email'] = $u->email;
        }
        $start = $this->startFrom($in);
        $this->schedule->assertClientStart($start);
        $end = $start->modify('+' . $priced['pricing']['durationMinutes'] . ' minutes');
        $date = $this->clock->dateKey($start);
        $now = $this->clock->now();
        $hold = $now->modify('+' . (max(30, $this->config->int('business.hold_minutes', 30)) + 5) . ' minutes');
        $needsPayment = $priced['pricing']['depositAmount'] > 0;

        $id = $this->db->transaction(function () use ($u, $in, $priced, $cols, $start, $end, $date, $hold, $needsPayment, $requestId) {
            $this->schedule->lockDays([$date]);
            if ($dup = $this->db->one('SELECT id FROM bookings WHERE user_id = ? AND checkout_request_id = ?', [$u->id, $requestId])) {
                return (int) $dup['id'];
            }
            $this->schedule->assertAvailable($start, $end);
            $id = $this->repo->insert($cols + $this->bookingColumns($priced) + [
                'ref' => BookingRepo::newRef(),
                'user_id' => $u->id,
                'status' => $needsPayment ? 'pending_payment' : 'confirmed',
                'hold_expires_at' => $needsPayment ? Clock::toSql($hold) : null,
                'confirmed_at' => $needsPayment ? null : Clock::toSql($this->clock->now()),
                'contact_email_lower' => strtolower($cols['contact_email']),
                'property_type' => $in->enum('propertyType', ['house', 'apartment', 'condo', 'office', 'other'], false, null),
                'access_notes' => $in->str('accessNotes', false, 2000),
                'cleaner_notes' => $in->str('cleanerNotes', false, 2000),
                'start_at' => Clock::toSql($start),
                'end_at' => Clock::toSql($end),
                'business_date' => $date,
                'duration_minutes' => $priced['pricing']['durationMinutes'],
                'checkout_request_id' => $requestId,
                'created_via' => 'online',
                'created_by_user_id' => $u->id,
            ]);
            $this->repo->history($id, 'created', 'client', $u->id, ['via' => 'online', 'start' => Clock::iso($start)]);
            if (!$needsPayment) {
                $this->notify->confirmed((array) $this->repo->byId($id), 'created');
            }
            if ($in->bool('saveAddress')) {
                $this->saveAddressFromBooking($u->id, $cols, $in->str('accessNotes', false, 2000));
            }
            return $id;
        });
        return (array) $this->repo->byId($id);
    }

    private function saveAddressFromBooking(int $userId, array $c, ?string $access): void
    {
        $dup = $this->db->one('SELECT id FROM addresses WHERE user_id = ? AND LOWER(line1) = LOWER(?) AND zip = ?', [$userId, $c['address_line1'], $c['address_zip']]);
        if ($dup) {
            return;
        }
        $hasDefault = (bool) $this->db->scalar('SELECT COUNT(*) FROM addresses WHERE user_id = ? AND is_default = 1', [$userId]);
        $now = Clock::toSql($this->clock->now());
        $this->db->insert('addresses', [
            'user_id' => $userId, 'label' => 'Home', 'line1' => $c['address_line1'], 'line2' => $c['address_line2'], 'city' => $c['address_city'],
            'state' => $c['address_state'], 'zip' => $c['address_zip'], 'access_instructions' => $access, 'is_default' => $hasDefault ? 0 : 1,
            'sort_order' => 0, 'created_at' => $now, 'updated_at' => $now,
        ]);
    }

    /** Admin booking for an existing client (userId) or any contact. Same conflict protection. */
    public function createAdmin(AuthUser $admin, Input $in): array
    {
        $override = $in->num('totalPrice', false, 0, 100000);
        $priced = $this->price($in, $override);
        $cols = $this->contactAndAddress($in);
        $userId = $in->int('userId', false, 1);
        if ($userId === null) {
            $userId = ($r = $this->db->one('SELECT id FROM users WHERE email_lower = ?', [strtolower($cols['contact_email'])])) ? (int) $r['id'] : null;
        } elseif (!$this->db->one('SELECT id FROM users WHERE id = ?', [$userId])) {
            throw HttpError::invalid('Client not found.');
        }
        $start = $this->startFrom($in);
        $duration = $in->int('durationMinutes', false, 30, 720) ?? $priced['pricing']['durationMinutes'];
        $end = $start->modify("+{$duration} minutes");
        $this->schedule->assertAdminWindow($start, $end);
        $status = $in->enum('status', ['pending', 'confirmed'], false, 'confirmed');
        $deposit = $in->num('depositAmount', false, 0, 100000);
        if ($deposit !== null) {
            $priced['pricing']['depositAmount'] = min($deposit, $priced['pricing']['totalPrice']);
        }
        $date = $this->clock->dateKey($start);
        $notify = $in->bool('notifyClient', true);
        $id = $this->db->transaction(function () use ($admin, $in, $priced, $cols, $userId, $start, $end, $duration, $status, $date, $notify) {
            $this->schedule->lockDays([$date]);
            $this->schedule->assertAvailable($start, $end);
            $id = $this->repo->insert($cols + $this->bookingColumns($priced) + [
                'ref' => BookingRepo::newRef(),
                'user_id' => $userId,
                'status' => $status,
                'confirmed_at' => $status === 'confirmed' ? Clock::toSql($this->clock->now()) : null,
                'contact_email_lower' => strtolower($cols['contact_email']),
                'property_type' => $in->enum('propertyType', ['house', 'apartment', 'condo', 'office', 'other'], false, null),
                'access_notes' => $in->str('accessNotes', false, 2000),
                'cleaner_notes' => $in->str('cleanerNotes', false, 2000),
                'admin_notes' => $in->str('adminNotes', false, 5000),
                'start_at' => Clock::toSql($start),
                'end_at' => Clock::toSql($end),
                'business_date' => $date,
                'duration_minutes' => $duration,
                'created_via' => 'admin',
                'created_by_user_id' => $admin->id,
            ]);
            $this->repo->history($id, 'created', 'admin', $admin->id, ['via' => 'admin', 'status' => $status, 'start' => Clock::iso($start)]);
            $b = (array) $this->repo->byId($id);
            if ($notify) {
                $status === 'confirmed' ? $this->notify->confirmed($b, 'created') : $this->notify->requestReceived($b, 'created');
            }
            return $id;
        });
        return (array) $this->repo->byId($id);
    }

    // ------------------------------------------------------------------ changes

    private function isAdmin(AuthUser $u): bool
    {
        return in_array($u->role, ['admin', 'owner'], true);
    }

    public function assertOwner(AuthUser $u, array $b): void
    {
        if (!$this->isAdmin($u) && (int) $b['user_id'] !== $u->id) {
            throw HttpError::notFound('Booking not found.'); // don't reveal other customers' bookings
        }
    }

    /** Reschedule (and/or change duration). Clients: published slots + 24h rule. Admins: admin window. */
    public function reschedule(AuthUser $actor, string $ref, Input $in): array
    {
        $admin = $this->isAdmin($actor);
        $b = $this->repo->requireRef($ref);
        $this->assertOwner($actor, $b);
        $newStart = $this->startFrom($in);
        $duration = $admin ? ($in->int('durationMinutes', false, 30, 720) ?? (int) $b['duration_minutes']) : (int) $b['duration_minutes'];
        $newEnd = $newStart->modify("+{$duration} minutes");
        if ($admin) {
            $this->schedule->assertAdminWindow($newStart, $newEnd);
        } else {
            $perm = $this->repo->clientPermissions($b, false);
            if (!$perm['canReschedule']) {
                throw new HttpError('failed-precondition', $perm['changeBlockedReason'] ?? 'This booking can no longer be rescheduled online.');
            }
            $this->schedule->assertClientStart($newStart);
        }
        $newDate = $this->clock->dateKey($newStart);
        $role = $admin ? 'admin' : 'client';
        $notify = $admin ? $in->bool('notifyClient', true) : true;
        return $this->db->transaction(function () use ($b, $newStart, $newEnd, $newDate, $duration, $actor, $role, $notify) {
            $this->schedule->lockDays([$newDate, $b['business_date']]);
            $b = $this->repo->byId((int) $b['id'], true);
            if (!in_array($b['status'], ['pending', 'confirmed'], true)) {
                throw new HttpError('failed-precondition', 'Only pending or confirmed bookings can be rescheduled.');
            }
            $this->schedule->assertAvailable($newStart, $newEnd, (int) $b['id']);
            $previousWhen = $this->notify->when($b);
            $this->repo->update((int) $b['id'], [
                'start_at' => Clock::toSql($newStart),
                'end_at' => Clock::toSql($newEnd),
                'business_date' => $newDate,
                'duration_minutes' => $duration,
                'reminder48_sent_at' => null,
                'reminder24_sent_at' => null,
            ]);
            $this->repo->history((int) $b['id'], 'rescheduled', $role, $actor->id, ['from' => BookingRepo::iso($b['start_at']), 'to' => Clock::iso($newStart), 'durationMinutes' => $duration]);
            $fresh = (array) $this->repo->byId((int) $b['id']);
            if ($notify) {
                $this->notify->rescheduled($fresh, 'r' . $this->historyCount((int) $b['id']), $previousWhen, $role);
            }
            return $fresh;
        });
    }

    private function historyCount(int $bookingId): int
    {
        return (int) $this->db->scalar('SELECT COUNT(*) FROM booking_history WHERE booking_id = ?', [$bookingId]);
    }

    public function cancel(AuthUser $actor, string $ref, ?string $reason, bool $notify = true): array
    {
        $admin = $this->isAdmin($actor);
        $b = $this->repo->requireRef($ref);
        $this->assertOwner($actor, $b);
        if (!$admin) {
            $perm = $this->repo->clientPermissions($b, false);
            if (!$perm['canCancel']) {
                throw new HttpError('failed-precondition', $perm['changeBlockedReason'] ?? 'This booking can no longer be cancelled online.');
            }
        }
        $role = $admin ? 'admin' : 'client';
        return $this->db->transaction(function () use ($b, $actor, $role, $reason, $notify) {
            $b = $this->repo->byId((int) $b['id'], true);
            if (!in_array($b['status'], BookingRepo::ACTIVE, true)) {
                throw new HttpError('failed-precondition', 'This booking is already ' . $b['status'] . '.');
            }
            $wasHold = $b['status'] === 'pending_payment';
            $this->repo->update((int) $b['id'], [
                'status' => 'cancelled', 'cancelled_at' => Clock::toSql($this->clock->now()), 'cancelled_by' => $role,
                'cancellation_reason' => $reason ? mb_substr($reason, 0, 500) : null, 'hold_expires_at' => null,
            ]);
            $this->repo->history((int) $b['id'], 'cancelled', $role, $actor->id, ['reason' => $reason]);
            $fresh = (array) $this->repo->byId((int) $b['id']);
            if ($notify && !$wasHold) {
                $this->notify->cancelled($fresh, 'cancelled', $role, $reason);
            }
            return $fresh;
        });
    }

    /** Admin status changes with an explicit transition table. */
    public function setStatus(AuthUser $admin, string $ref, string $to, ?string $reason, bool $notify): array
    {
        if ($to === 'cancelled') {
            return $this->cancel($admin, $ref, $reason, $notify);
        }
        $allowed = [
            'pending' => ['confirmed', 'declined'],
            'pending_payment' => ['confirmed'],
            'confirmed' => ['completed', 'pending'],
            'completed' => ['confirmed'],
        ];
        return $this->db->transaction(function () use ($admin, $ref, $to, $reason, $notify, $allowed) {
            $b = $this->repo->requireRef($ref, true);
            if (!in_array($to, $allowed[$b['status']] ?? [], true)) {
                throw new HttpError('failed-precondition', "A {$b['status']} booking cannot be changed to {$to}.");
            }
            $now = Clock::toSql($this->clock->now());
            $set = ['status' => $to, 'hold_expires_at' => null];
            if ($to === 'confirmed') {
                $set['confirmed_at'] = $b['confirmed_at'] ?? $now;
                $set['completed_at'] = null;
            } elseif ($to === 'completed') {
                $set['completed_at'] = $now;
            } elseif ($to === 'declined') {
                $set['cancelled_at'] = $now;
                $set['cancellation_reason'] = $reason ? mb_substr($reason, 0, 500) : null;
                $set['cancelled_by'] = 'admin';
            }
            $this->repo->update((int) $b['id'], $set);
            $this->repo->history((int) $b['id'], $to, 'admin', $admin->id, ['from' => $b['status'], 'reason' => $reason]);
            $fresh = (array) $this->repo->byId((int) $b['id']);
            if ($notify) {
                match ($to) {
                    'confirmed' => in_array($b['status'], ['pending', 'pending_payment'], true) ? $this->notify->confirmed($fresh, 'confirmed') : null,
                    'declined' => $this->notify->declined($fresh, 'declined', $reason),
                    'completed' => $this->notify->completed($fresh),
                    default => null,
                };
            }
            return $fresh;
        });
    }

    /** Admin edits of details/pricing. Duration changes re-run the conflict check. */
    public function updateDetails(AuthUser $admin, string $ref, Input $in): array
    {
        $b = $this->repo->requireRef($ref);
        if (in_array($b['status'], ['cancelled', 'declined', 'expired'], true)) {
            throw new HttpError('failed-precondition', 'Cancelled, declined or expired bookings cannot be edited.');
        }
        $set = [];
        if ($in->has('contact') || $in->has('address')) {
            $set += $this->contactAndAddress($in);
            $set['contact_email_lower'] = strtolower($set['contact_email']);
        }
        if ($in->has('serviceSlug')) {
            $priced = $this->price($in, $in->num('totalPrice', false, 0, 100000));
            $cols = $this->bookingColumns($priced);
            unset($cols['payment_status']);
            $set += $cols;
        } elseif ($in->has('totalPrice')) {
            $total = round((float) $in->num('totalPrice', true, 0, 100000), 2);
            $pricing = $b['pricing_json'] ? json_decode((string) $b['pricing_json'], true) : ['lineItems' => []];
            $items = array_values(array_filter($pricing['lineItems'] ?? [], static fn ($i) => $i['label'] !== 'Price adjustment'));
            $sum = round(array_sum(array_column($items, 'amount')), 2);
            if (abs($total - $sum) >= 0.005) {
                $items[] = ['label' => 'Price adjustment', 'detail' => 'Set by Sanchez Services', 'amount' => round($total - $sum, 2)];
            }
            $pricing['lineItems'] = $items;
            $set['pricing_json'] = json_encode($pricing, JSON_UNESCAPED_SLASHES);
            $set['total_price'] = $total;
        }
        if ($in->has('depositAmount')) {
            $set['deposit_amount'] = (float) $in->num('depositAmount', true, 0, 100000);
        }
        foreach (['accessNotes' => 'access_notes', 'cleanerNotes' => 'cleaner_notes', 'adminNotes' => 'admin_notes'] as $k => $col) {
            if (array_key_exists($k, $in->all())) {
                $set[$col] = $in->str($k, false, 5000);
            }
        }
        $duration = $in->int('durationMinutes', false, 30, 720);
        return $this->db->transaction(function () use ($b, $set, $duration, $admin) {
            $this->schedule->lockDays([$b['business_date']]);
            $b = $this->repo->byId((int) $b['id'], true);
            if ($duration !== null && $duration !== (int) $b['duration_minutes']) {
                $start = Clock::fromSql($b['start_at']);
                $end = $start->modify("+{$duration} minutes");
                $this->schedule->assertAdminWindow($start, $end);
                $this->schedule->assertAvailable($start, $end, (int) $b['id']);
                $set['duration_minutes'] = $duration;
                $set['end_at'] = Clock::toSql($end);
            }
            if (isset($set['deposit_amount']) || isset($set['total_price'])) {
                $set['deposit_amount'] = min((float) ($set['deposit_amount'] ?? $b['deposit_amount']), (float) ($set['total_price'] ?? $b['total_price']));
            }
            if ($set) {
                $this->repo->update((int) $b['id'], $set);
                $this->repo->history((int) $b['id'], 'updated', 'admin', $admin->id, ['fields' => array_keys($set)]);
            }
            return $this->ledger->recalc((int) $b['id']);
        });
    }

    public function updateClientNotes(AuthUser $u, string $ref, Input $in): array
    {
        $b = $this->repo->requireRef($ref);
        $this->assertOwner($u, $b);
        if (!in_array($b['status'], BookingRepo::ACTIVE, true)) {
            throw new HttpError('failed-precondition', 'Notes can only be changed on upcoming bookings.');
        }
        $set = [];
        foreach (['accessNotes' => 'access_notes', 'cleanerNotes' => 'cleaner_notes'] as $k => $col) {
            if (array_key_exists($k, $in->all())) {
                $set[$col] = $in->str($k, false, 2000);
            }
        }
        if ($set) {
            $this->db->transaction(function () use ($b, $set, $u) {
                $this->repo->update((int) $b['id'], $set);
                $this->repo->history((int) $b['id'], 'notes_updated', 'client', $u->id, []);
            });
        }
        return (array) $this->repo->byId((int) $b['id']);
    }

    // ------------------------------------------------------------------ payments -> status

    /**
     * Called (in-transaction) after a payment is recorded. Confirms holds/requests once the deposit is
     * covered. A payment that arrives after a hold expired re-reserves the slot if it is still free;
     * otherwise the booking is flagged and admins are alerted (refund or reschedule manually).
     */
    public function afterPayment(array $b, string $eventKey): array
    {
        $b = (array) $this->repo->byId((int) $b['id'], true);
        if ($this->repo->depositDue($b) > 0 || !in_array($b['status'], ['pending_payment', 'pending', 'expired'], true)) {
            return $b;
        }
        if ($b['status'] === 'expired') {
            $this->schedule->lockDays([$b['business_date']]);
            try {
                $this->schedule->assertAvailable(Clock::fromSql($b['start_at']), Clock::fromSql($b['end_at']), (int) $b['id']);
            } catch (HttpError) {
                $msg = 'Payment received after the booking hold expired, and the time slot is no longer free. Refund the deposit or contact the client to reschedule.';
                $this->repo->update((int) $b['id'], ['needs_attention' => $msg]);
                $this->repo->history((int) $b['id'], 'needs_attention', 'system', null, ['message' => $msg]);
                $this->notify->attention((array) $this->repo->byId((int) $b['id']), $eventKey, $msg);
                return (array) $this->repo->byId((int) $b['id']);
            }
        }
        $this->repo->update((int) $b['id'], ['status' => 'confirmed', 'confirmed_at' => Clock::toSql($this->clock->now()), 'hold_expires_at' => null, 'expired_at' => null]);
        $this->repo->history((int) $b['id'], 'confirmed', 'system', null, ['by' => 'deposit']);
        $fresh = (array) $this->repo->byId((int) $b['id']);
        $this->notify->confirmed($fresh, 'deposit');
        return $fresh;
    }

    // ------------------------------------------------------------------ jobs

    /** Releases unpaid online holds. Returns booking ids expired (so open Stripe sessions can be closed). */
    public function expireHolds(): array
    {
        $rows = $this->db->all("SELECT id FROM bookings WHERE status = 'pending_payment' AND hold_expires_at <= ? LIMIT 500", [Clock::toSql($this->clock->now())]);
        $ids = [];
        foreach ($rows as $r) {
            $this->db->transaction(function () use ($r, &$ids) {
                $b = $this->repo->byId((int) $r['id'], true);
                if (!$b || $b['status'] !== 'pending_payment' || Clock::fromSql($b['hold_expires_at']) > $this->clock->now()) {
                    return;
                }
                $this->repo->update((int) $b['id'], ['status' => 'expired', 'expired_at' => Clock::toSql($this->clock->now()), 'hold_expires_at' => null]);
                $this->repo->history((int) $b['id'], 'expired', 'system', null, ['reason' => 'deposit not paid in time']);
                $ids[] = (int) $b['id'];
            });
        }
        return $ids;
    }

    public function autoComplete(): int
    {
        $cutoff = $this->clock->now()->modify('-' . $this->config->int('business.auto_complete_after_hours', 2) . ' hours');
        $rows = $this->db->all("SELECT id FROM bookings WHERE status = 'confirmed' AND end_at <= ? LIMIT 500", [Clock::toSql($cutoff)]);
        $n = 0;
        foreach ($rows as $r) {
            $this->db->transaction(function () use ($r, &$n) {
                $b = $this->repo->byId((int) $r['id'], true);
                if (!$b || $b['status'] !== 'confirmed') {
                    return;
                }
                $this->repo->update((int) $b['id'], ['status' => 'completed', 'completed_at' => Clock::toSql($this->clock->now())]);
                $this->repo->history((int) $b['id'], 'completed', 'system', null, []);
                $this->notify->completed((array) $this->repo->byId((int) $b['id']));
                $n++;
            });
        }
        return $n;
    }

    public function sendReminders(): array
    {
        $now = $this->clock->now();
        $sent = [];
        foreach ((array) $this->config->get('business.reminder_hours', [48, 24]) as $hours) {
            $hours = (int) $hours;
            $col = $hours === 48 ? 'reminder48_sent_at' : ($hours === 24 ? 'reminder24_sent_at' : null);
            if (!$col) {
                continue;
            }
            // Window: due within the next $hours, and not already inside the next (smaller) reminder.
            $rows = $this->db->all(
                "SELECT id FROM bookings WHERE status = 'confirmed' AND {$col} IS NULL AND start_at > ? AND start_at <= ? AND (confirmed_at IS NULL OR confirmed_at <= ?)",
                // Skip reminders for bookings confirmed in the last 6 hours (the confirmation email just went out).
                [Clock::toSql($now->modify('+' . ($hours === 48 ? 25 : 1) . ' hours')), Clock::toSql($now->modify("+{$hours} hours")), Clock::toSql($now->modify('-6 hours'))]
            );
            foreach ($rows as $r) {
                $this->db->transaction(function () use ($r, $col, $hours, &$sent) {
                    $b = $this->repo->byId((int) $r['id'], true);
                    if (!$b || $b['status'] !== 'confirmed' || $b[$col] !== null) {
                        return;
                    }
                    $this->repo->update((int) $b['id'], [$col => Clock::toSql($this->clock->now())]);
                    $this->notify->reminder((array) $this->repo->byId((int) $b['id']), $hours);
                    $sent[] = [$b['ref'], $hours];
                });
            }
        }
        return $sent;
    }

    /** Links unowned bookings with this (verified) email to the account. */
    public function claimForUser(AuthUser $u): int
    {
        if (!$u->emailVerified) {
            return 0;
        }
        $n = $this->db->run('UPDATE bookings SET user_id = ?, updated_at = ? WHERE user_id IS NULL AND contact_email_lower = ?', [$u->id, Clock::toSql($this->clock->now()), $u->emailLower])->rowCount();
        $this->db->run('UPDATE reviews r JOIN bookings b ON b.id = r.booking_id SET r.user_id = b.user_id WHERE r.user_id IS NULL AND b.user_id = ?', [$u->id]);
        return $n;
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Auth\AuthUser;
use SanchezServices\Domain\Bookings;
use SanchezServices\Domain\Payments;
use SanchezServices\Domain\PaymentAmounts;
use SanchezServices\Domain\Pricing;
use SanchezServices\Domain\Slots;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;
use SanchezServices\Store\Doc;

/**
 * Ports of the Firebase callable functions. Called as POST /api/fn/{name} with {"data": {...}}
 * and returning {"result": ...} (the shim exposes it as httpsCallable(...).data).
 */
final class FunctionsController
{
    public function __construct(private App $app)
    {
    }

    public function call(Request $req): Response
    {
        $name = $req->param('name');
        $body = $req->json();
        $data = Doc::normalizeIncoming(is_array($body['data'] ?? null) ? $body['data'] : []);
        $user = $this->app->auth->currentUser();
        $result = match ($name) {
            'createBookingAndStripeCheckout' => $this->createBookingAndStripeCheckout($data, $user, $req),
            'createStripeCheckoutSession' => $this->createStripeCheckoutSession($data, $user),
            'cancelBooking' => $this->cancelBooking($data, $user),
            'rescheduleBooking' => $this->rescheduleBooking($data, $user),
            'createAdminBooking' => $this->createAdminBooking($data, $user),
            'checkBookingConflict' => $this->checkBookingConflict($data, $req),
            'getDayAvailability' => $this->getDayAvailability($data, $req),
            'approveReview' => $this->setReviewStatus($data, $user, 'approved'),
            'declineReview' => $this->setReviewStatus($data, $user, 'declined'),
            'rebuildAvailabilityForDay' => $this->rebuildAvailabilityForDay($data, $user),
            'generateInvoicePdf' => throw new HttpError('unimplemented', 'Server-side PDF invoices were not migrated (unused by the app; invoices are generated in the browser).'),
            default => throw HttpError::notFound('Unknown function.'),
        };
        return Response::json(['result' => $result]);
    }

    private function requireAuth(?AuthUser $u): AuthUser
    {
        return $u ?? throw HttpError::unauthenticated();
    }

    private function requireAdminServer(?AuthUser $u, string $msg = 'Admins only.'): AuthUser
    {
        if (!$this->app->rules->isAdminServer($u)) {
            throw HttpError::denied($msg);
        }
        return $u;
    }

    /** assertBookingOwner() — server check: admin, uid ownership, or booking email == auth/profile email. */
    private function assertBookingOwner(?AuthUser $u, array $booking): void
    {
        $u = $this->requireAuth($u);
        if ($this->app->rules->isAdminServer($u)) {
            return;
        }
        $profile = $this->app->store->get('profiles', $u->uid) ?? [];
        $profileEmail = PaymentAmounts::normalizeEmail(Pricing::jsOr($profile['emailLower'] ?? null, $profile['email'] ?? null, ''));
        $bookingEmail = PaymentAmounts::bookingEmail($booking);
        $ownsUid = ($booking['userId'] ?? null) === $u->uid || (is_array($booking['ownerKeys'] ?? null) && in_array('uid:' . $u->uid, $booking['ownerKeys'], true));
        $ownsEmail = $bookingEmail !== '' && ($bookingEmail === $u->emailLower || $bookingEmail === $profileEmail);
        if ($this->app->config->bool('auth.require_verified_email_for_email_match') && !$u->emailVerified) {
            $ownsEmail = false;
        }
        if (!$ownsUid && !$ownsEmail) {
            throw HttpError::denied('You do not own this booking.');
        }
    }

    private function validateBookingEmail(AuthUser $u, array $booking, mixed $supplied): string
    {
        $auth = $u->emailLower;
        $bookingEmail = PaymentAmounts::bookingEmail($booking);
        $requested = PaymentAmounts::normalizeEmail(Pricing::jsOr($supplied, $auth, ''));
        if ($auth === '' || $bookingEmail === '' || $requested !== $auth || $bookingEmail !== $auth) {
            throw HttpError::denied('The authenticated email must match the booking email.');
        }
        return $auth;
    }

    private static function stripUndefined(mixed $v): mixed
    {
        return $v; // JSON has no undefined; nulls are preserved as Firestore would store them.
    }

    // ------------------------------------------------------------------ booking + checkout

    private function createBookingAndStripeCheckout(array $data, ?AuthUser $u, Request $req): array
    {
        $payments = $this->app->payments;
        if (!$payments->isConfigured()) {
            throw new HttpError('failed-precondition', 'Stripe is not fully configured.');
        }
        $u = $this->requireAuth($u);
        $this->app->limiter->hit('checkout:user:' . $u->uid, 20, 3600);
        $requestId = self::normalizeRequestId($data['requestId'] ?? null);
        $bookingData = $data['bookingData'] ?? null;
        if (!$requestId || !is_array($bookingData)) {
            throw HttpError::invalid('requestId and bookingData are required.');
        }
        $suppliedEmail = PaymentAmounts::normalizeEmail(Pricing::jsOr($data['customerEmail'] ?? null, Doc::get($bookingData, 'contact.email'), $bookingData['contactEmailLower'] ?? null, ''));
        if ($u->emailLower === '' || $suppliedEmail !== $u->emailLower) {
            throw HttpError::denied('The authenticated email must match the booking email.');
        }
        $pricing = Pricing::calculate($bookingData, $this->app->config->float('business.required_deposit_amount', 50));
        $start = Doc::toDate($bookingData['startAt'] ?? null) ?? Doc::toDate($bookingData['scheduledAt'] ?? null);
        if (!$start) {
            throw HttpError::invalid('A valid booking start time is required.');
        }
        $end = $start->modify('+' . $pricing['durationMinutes'] . ' minutes');
        $this->app->bookings->assertNoBlackout($start, $end);

        $bookingId = $u->uid . '_' . $requestId;
        $existing = $this->app->bookings->get($bookingId);
        if ($existing !== null) {
            $this->assertBookingOwner($u, $existing);
            $this->validateBookingEmail($u, $existing, $suppliedEmail);
            if (!empty($existing['stripeSessionId'])) {
                $session = $this->app->stripe->retrieveCheckoutSession((string) $existing['stripeSessionId']);
                if (!empty($session['url'])) {
                    return ['bookingId' => $bookingId, 'url' => $session['url'], 'reused' => true];
                }
            }
        } else {
            $doc = $this->buildAuthoritativeBookingDoc($bookingData, $pricing, $u, $start, $end, $requestId);
            $this->app->bookings->createWithReservation($bookingId, $doc, $start, $end);
        }
        $fresh = (array) $this->app->bookings->get($bookingId);
        $session = $payments->createSession($bookingId, $fresh, $u->emailLower, is_string($data['customerName'] ?? null) ? $data['customerName'] : null, 'deposit');
        return ['bookingId' => $bookingId, 'url' => $session['url'] ?? null, 'reused' => $existing !== null];
    }

    private static function normalizeRequestId(mixed $v): ?string
    {
        $n = substr((string) preg_replace('/[^a-zA-Z0-9_-]/', '_', trim((string) ($v ?? ''))), 0, 96);
        return $n !== '' ? $n : null;
    }

    private function buildAuthoritativeBookingDoc(array $b, array $pricing, AuthUser $u, \DateTimeImmutable $start, \DateTimeImmutable $end, string $requestId): array
    {
        $email = $u->emailLower;
        $contact = is_array($b['contact'] ?? null) && !array_is_list($b['contact']) ? $b['contact'] : [];
        $contact['email'] = $email;
        $contact['emailLower'] = $email;
        $address = is_array($b['address'] ?? null) && !array_is_list($b['address']) ? $b['address'] : [];
        $clock = $this->app->clock;
        $promo = strtoupper(trim((string) ($b['promoCode'] ?? '')));
        $now = ['__op' => 'serverTimestamp'];
        return [
            'userId' => $u->uid,
            'ownerKeys' => ['uid:' . $u->uid, 'email:' . $email],
            'contact' => $contact,
            'contactEmailLower' => $email,
            'address' => $address,
            'serviceSlug' => $pricing['serviceSlug'],
            'serviceName' => $pricing['serviceName'],
            'addons' => $pricing['addons'],
            'frequency' => $pricing['frequency'],
            'bedrooms' => max(0, is_numeric($b['bedrooms'] ?? null) ? $b['bedrooms'] + 0 : 0),
            'bathrooms' => max(0, is_numeric($b['bathrooms'] ?? null) ? $b['bathrooms'] + 0 : 0),
            'sqft' => max(0, is_numeric(Pricing::jsOr($b['sqft'] ?? null, $b['squareFeet'] ?? null, 0)) ? Pricing::jsOr($b['sqft'] ?? null, $b['squareFeet'] ?? null, 0) + 0 : 0),
            'condition' => Pricing::normalizeCondition($b['condition'] ?? null),
            'pets' => Pricing::hasPets($b),
            'promoCode' => $promo !== '' ? $promo : null,
            'notes' => is_string($b['notes'] ?? null) ? mb_substr(trim($b['notes']), 0, 2000) : null,
            'startAt' => Doc::ts($start),
            'scheduledAt' => Doc::ts($start),
            'endAt' => Doc::ts($end),
            'dateKey' => $clock->dateKey($start),
            'timeLabel' => Slots::nearestLabel($clock, $start, $b['timeLabel'] ?? null),
            'durationMinutes' => $pricing['durationMinutes'],
            'estimate' => $pricing['estimate'],
            'totalPrice' => $pricing['totalPrice'],
            'totalAmount' => $pricing['totalPrice'],
            'depositAmount' => $pricing['depositAmount'],
            'paidAmount' => 0,
            'amountPaid' => 0,
            'remainingDue' => $pricing['remainingDue'],
            'balanceDue' => $pricing['remainingDue'],
            'depositPaid' => false,
            'depositPaymentIntentId' => null,
            'stripePaymentIntentId' => null,
            'stripeSessionId' => null,
            'checkoutRequestId' => $requestId,
            'status' => 'pending_payment',
            'bookingStatus' => 'pending_payment',
            'paymentStatus' => 'requires_payment',
            'createdVia' => 'server_booking_checkout',
            'createdAt' => $now,
            'updatedAt' => $now,
        ];
    }

    private function createStripeCheckoutSession(array $data, ?AuthUser $u): array
    {
        if (!$this->app->payments->isConfigured()) {
            throw new HttpError('failed-precondition', 'Stripe is not fully configured.');
        }
        $u = $this->requireAuth($u);
        $bookingId = trim((string) ($data['bookingId'] ?? ''));
        $mode = Payments::normalizeMode($data['mode'] ?? null);
        if ($bookingId === '') {
            throw HttpError::invalid('bookingId is required.');
        }
        $booking = $this->app->bookings->get($bookingId);
        if ($booking === null) {
            throw HttpError::notFound('Booking not found.');
        }
        $this->assertBookingOwner($u, $booking);
        $email = $this->validateBookingEmail($u, $booking, $data['customerEmail'] ?? null);
        $session = $this->app->payments->createSession($bookingId, $booking, $email, is_string($data['customerName'] ?? null) ? $data['customerName'] : null, $mode);
        return ['url' => $session['url'] ?? null];
    }

    // ------------------------------------------------------------------ cancel / reschedule / admin create

    private function cancelBooking(array $data, ?AuthUser $u): array
    {
        $bookingId = trim((string) ($data['bookingId'] ?? ''));
        if ($bookingId === '') {
            throw HttpError::invalid('bookingId is required.');
        }
        $booking = $this->app->bookings->get($bookingId);
        if ($booking === null) {
            throw HttpError::notFound('Booking not found.');
        }
        $this->assertBookingOwner($u, $booking);
        $now = ['__op' => 'serverTimestamp'];
        $this->app->bookings->update($bookingId, ['status' => 'cancelled', 'bookingStatus' => 'cancelled', 'cancelledAt' => $now, 'updatedAt' => $now]);
        return ['bookingId' => $bookingId, 'status' => 'cancelled'];
    }

    private function rescheduleBooking(array $data, ?AuthUser $u): array
    {
        $bookingId = trim((string) ($data['bookingId'] ?? ''));
        $start = Doc::toDate($data['startAt'] ?? null);
        if ($bookingId === '' || !$start) {
            throw HttpError::invalid('bookingId and a valid startAt are required.');
        }
        $booking = $this->app->bookings->get($bookingId);
        if ($booking === null) {
            throw HttpError::notFound('Booking not found.');
        }
        $this->assertBookingOwner($u, $booking);
        if (!Slots::blocksCapacity($booking['status'] ?? null)) {
            throw new HttpError('failed-precondition', 'This booking cannot be rescheduled.');
        }
        $stored = is_numeric(Pricing::jsOr($booking['durationMinutes'] ?? null, 120)) ? (float) Pricing::jsOr($booking['durationMinutes'] ?? null, 120) : NAN;
        $duration = is_finite($stored) ? max(30, min(1440, $stored)) : 120;
        $end = $start->modify('+' . (int) round($duration * 60) . ' seconds');
        $this->app->bookings->assertNoBlackout($start, $end);
        $clock = $this->app->clock;
        $patch = [
            'startAt' => Doc::ts($start),
            'scheduledAt' => Doc::ts($start),
            'endAt' => Doc::ts($end),
            'dateKey' => $clock->dateKey($start),
            'timeLabel' => Slots::nearestLabel($clock, $start, $data['timeLabel'] ?? null),
            'updatedAt' => ['__op' => 'serverTimestamp'],
        ];
        foreach (['notes', 'accessNotes', 'cleanerNotes'] as $f) {
            if (is_string($data[$f] ?? null)) {
                $patch[$f] = mb_substr(trim($data[$f]), 0, 2000);
            }
        }
        $this->app->bookings->rescheduleWithReservation($bookingId, $start, $end, $patch);
        return ['bookingId' => $bookingId, 'startAt' => \SanchezServices\Clock::iso($start), 'endAt' => \SanchezServices\Clock::iso($end)];
    }

    private function createAdminBooking(array $data, ?AuthUser $u): array
    {
        $u = $this->requireAdminServer($u);
        $b = $data['bookingData'] ?? null;
        $start = is_array($b) ? (Doc::toDate($b['startAt'] ?? null) ?? Doc::toDate($b['scheduledAt'] ?? null)) : null;
        if (!is_array($b) || !$start) {
            throw HttpError::invalid('bookingData and a valid startAt are required.');
        }
        $num = static fn ($v, $d) => $v === null || $v === '' || $v === false || $v === 0 ? $d : (is_numeric($v) ? (float) $v : NAN);
        $reqDuration = $num($b['durationMinutes'] ?? null, 120.0);
        $reqTotal = $num($b['totalPrice'] ?? null, 0.0);
        $reqDeposit = $num($b['depositAmount'] ?? null, 0.0);
        foreach ([$reqDuration, $reqTotal, $reqDeposit] as $n) {
            if (!is_finite($n)) {
                throw HttpError::invalid('Duration and payment amounts must be valid numbers.');
            }
        }
        $duration = max(30, min(1440, $reqDuration));
        $end = $start->modify('+' . (int) round($duration * 60) . ' seconds');
        $total = max(0, $reqTotal);
        $deposit = max(0, min($total, $reqDeposit));
        $email = PaymentAmounts::normalizeEmail(Pricing::jsOr(Doc::get($b, 'contact.email'), $b['contactEmailLower'] ?? null, ''));
        $userId = trim((string) ($b['userId'] ?? '')) ?: null;
        $ownerKeys = array_merge($userId ? ['uid:' . $userId] : [], $email ? ['email:' . $email] : []);
        if ($email === '') {
            throw HttpError::invalid('A client email is required.');
        }
        $this->app->bookings->assertNoBlackout($start, $end);
        $requested = strtolower((string) Pricing::jsOr($b['status'] ?? null, 'confirmed'));
        $status = in_array($requested, ['pending', 'confirmed', 'scheduled'], true) ? $requested : 'confirmed';
        $contact = is_array($b['contact'] ?? null) && !array_is_list($b['contact']) ? $b['contact'] : [];
        $contact['email'] = $email;
        $contact['emailLower'] = $email;
        $clock = $this->app->clock;
        $now = ['__op' => 'serverTimestamp'];
        $id = \SanchezServices\Store\DocumentStore::newId();
        $doc = [
            'userId' => $userId,
            'ownerKeys' => $ownerKeys,
            'contact' => $contact,
            'contactEmailLower' => $email,
            'contactPhoneNormalized' => Pricing::jsOr($b['contactPhoneNormalized'] ?? null, null),
            'address' => is_array($b['address'] ?? null) ? $b['address'] : [],
            'serviceSlug' => Pricing::jsOr($b['serviceSlug'] ?? null, null),
            'serviceName' => trim((string) Pricing::jsOr($b['serviceName'] ?? null, 'Cleaning Service')),
            'notes' => is_string($b['notes'] ?? null) ? mb_substr(trim($b['notes']), 0, 2000) : null,
            'startAt' => Doc::ts($start),
            'scheduledAt' => Doc::ts($start),
            'endAt' => Doc::ts($end),
            'dateKey' => $clock->dateKey($start),
            'timeLabel' => Slots::nearestLabel($clock, $start, $b['timeLabel'] ?? null),
            'durationMinutes' => $duration + 0,
            'totalPrice' => $total + 0,
            'totalAmount' => $total + 0,
            'depositAmount' => $deposit + 0,
            'paidAmount' => 0,
            'amountPaid' => 0,
            'remainingDue' => $total + 0,
            'balanceDue' => $total + 0,
            'depositPaid' => false,
            'status' => $status,
            'bookingStatus' => $status,
            'paymentStatus' => $total > 0 ? 'unpaid' : 'not_required',
            'createdVia' => 'admin_callable',
            'createdBy' => $u->uid,
            'createdAt' => $now,
            'updatedAt' => $now,
        ];
        // stripUndefinedDeep keeps nulls; drop keys the JS version would have omitted (undefined)
        $this->app->bookings->createWithReservation($id, $doc, $start, $end);
        return ['bookingId' => $id];
    }

    // ------------------------------------------------------------------ availability (public, rate-limited)

    private function checkBookingConflict(array $data, Request $req): array
    {
        $this->app->limiter->hit('availability:ip:' . $req->ip, 120, 60);
        $startRaw = $data['startAt'] ?? null;
        $endRaw = $data['endAt'] ?? null;
        if (!$startRaw || !$endRaw) {
            throw HttpError::invalid('Missing required fields: startAt and endAt.');
        }
        $start = Doc::toDate($startRaw);
        $end = Doc::toDate($endRaw);
        if (!$start) {
            throw HttpError::invalid('startAt must be a valid timestamp.');
        }
        if (!$end) {
            throw HttpError::invalid('endAt must be a valid timestamp.');
        }
        $ignore = is_string($data['ignoreId'] ?? null) && $data['ignoreId'] !== '' ? $data['ignoreId'] : null;
        return $this->app->bookings->checkConflict($start, $end, $ignore);
    }

    private function getDayAvailability(array $data, Request $req): array
    {
        $this->app->limiter->hit('availability:ip:' . $req->ip, 120, 60);
        $dateKey = $data['dateKey'] ?? null;
        $timeOptions = $data['timeOptions'] ?? null;
        $slot = $data['slotCapacity'] ?? null;
        $daily = $data['dailyCapacity'] ?? null;
        $duration = $data['durationMinutes'] ?? null;
        if (!$dateKey || !is_array($timeOptions) || !$slot || !$daily || !$duration) {
            throw HttpError::invalid('Missing or invalid required fields: dateKey, timeOptions (array), slotCapacity, dailyCapacity, durationMinutes.');
        }
        if (!is_string($dateKey) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateKey) || !checkdate((int) substr($dateKey, 5, 2), (int) substr($dateKey, 8, 2), (int) substr($dateKey, 0, 4))) {
            throw HttpError::invalid('dateKey must be in format "yyyy-MM-dd".');
        }
        if (count($timeOptions) > 48 || !is_numeric($slot) || !is_numeric($daily) || !is_numeric($duration)) {
            throw HttpError::invalid('Invalid availability parameters.');
        }
        $ignore = is_string($data['ignoreBookingId'] ?? null) && $data['ignoreBookingId'] !== '' ? $data['ignoreBookingId'] : null;
        return $this->app->bookings->dayAvailability($dateKey, $timeOptions, (float) $slot, (float) $daily, max(1.0, min(1440.0, (float) $duration)), $ignore);
    }

    // ------------------------------------------------------------------ reviews / maintenance callables

    private function setReviewStatus(array $data, ?AuthUser $u, string $status): array
    {
        if (!$this->app->rules->isAdminServer($u)) {
            throw HttpError::denied('Admin only');
        }
        $id = (string) ($data['id'] ?? '');
        if ($id === '') {
            throw HttpError::invalid('id is required');
        }
        $this->app->db->transaction(function () use ($id, $status) {
            $doc = $this->app->store->get('reviews', $id, null, true);
            if ($doc === null) {
                throw HttpError::notFound('No document to update.');
            }
            $now = Doc::ts($this->app->clock->now());
            $doc['status'] = $status;
            $doc['updatedAt'] = $now;
            if ($status === 'approved') {
                $doc['publishedAt'] = $now;
            }
            $this->app->store->put('reviews', $id, $doc);
        });
        return ['ok' => true, 'id' => $id];
    }

    /** Availability cache is not maintained in PHP (computed live); returns the computed counts. */
    private function rebuildAvailabilityForDay(array $data, ?AuthUser $u): array
    {
        if (!$this->app->rules->isAdminServer($u)) {
            throw HttpError::denied('Admin only');
        }
        $dateKey = (string) ($data['dateKey'] ?? '');
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateKey)) {
            throw HttpError::invalid('dateKey must be YYYY-MM-DD');
        }
        $clock = $this->app->clock;
        $taken = [];
        $dayCount = 0;
        foreach ($this->app->bookings->blockingForDay($clock->dayStart($dateKey), $clock->dayEnd($dateKey)) as $row) {
            if (!Slots::blocksCapacity($row['data']['status'] ?? null)) {
                continue;
            }
            [$s] = Bookings::bookingWindow($row['data']);
            $label = Slots::nearestLabel($clock, $s, $row['data']['timeLabel'] ?? null);
            $taken[$label] = ($taken[$label] ?? 0) + 1;
            $dayCount++;
        }
        return ['dateKey' => $dateKey, 'dayCount' => $dayCount, 'taken' => $taken ?: new \stdClass()];
    }
}

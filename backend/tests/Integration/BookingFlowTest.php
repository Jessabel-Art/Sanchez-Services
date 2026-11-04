<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

use SanchezServices\Store\Doc;

final class BookingFlowTest extends IntegrationTestCase
{
    private function draft(string $email, string $dateKey, string $time = '09:00', array $extra = []): array
    {
        $labels = ['09:00' => '09:00 AM', '11:00' => '11:00 AM', '13:00' => '01:00 PM', '15:00' => '03:00 PM'];
        return array_merge([
            'serviceSlug' => 'residential-cleaning',
            'frequency' => 'one-time',
            'bedrooms' => 2,
            'bathrooms' => 1,
            'condition' => 'standard',
            'pets' => false,
            'addons' => [],
            'contact' => ['name' => 'Test Client', 'firstName' => 'Test', 'lastName' => 'Client', 'email' => $email, 'phone' => '4015551212', 'emailLower' => strtolower($email)],
            'address' => ['line1' => '1 Main St', 'city' => 'Providence', 'state' => 'RI', 'zip' => '02903'],
            'notes' => 'Front door code 1234',
            'startAt' => self::localIso($dateKey, $time),
            'scheduledAt' => self::localIso($dateKey, $time),
            'timeLabel' => $labels[$time] ?? null,
            'dateKey' => $dateKey,
            'promoCode' => null,
        ], $extra);
    }

    private function checkout(HttpClient $c, string $email, string $dateKey, string $time = '09:00', ?string $requestId = null): array
    {
        return $c->fn('createBookingAndStripeCheckout', [
            'requestId' => $requestId ?? bin2hex(random_bytes(8)),
            'bookingData' => $this->draft($email, $dateKey, $time),
            'customerEmail' => $email,
            'customerName' => 'Test Client',
        ]);
    }

    public function testCheckoutCreatesAuthoritativePendingBookingAndSession(): void
    {
        $day = self::futureWeekday(12);
        $c = $this->registerClient('book1@example.test');
        $r = $this->checkout($c, 'book1@example.test', $day, '09:00', 'req-1');
        $this->assertSame(200, $r['status'], $r['body']);
        $bookingId = $r['json']['result']['bookingId'];
        $this->assertSame($this->uidOf('book1@example.test') . '_req-1', $bookingId);
        $this->assertStringStartsWith('https://checkout.stripe.test/cs_test_', $r['json']['result']['url']);

        $b = static::$app->bookings->get($bookingId);
        $this->assertSame('pending_payment', $b['status']);
        $this->assertSame('checkout_created', $b['paymentStatus']);
        $this->assertSame(145.0, (float) $b['totalPrice']);     // 80 base + 2 bed x 20 + 1 bath x 25
        $this->assertSame(50.0, (float) $b['depositAmount']);
        $this->assertSame($day, $b['dateKey']);
        $this->assertSame('09:00 AM', $b['timeLabel']);
        $this->assertSame(['uid:' . $this->uidOf('book1@example.test'), 'email:book1@example.test'], $b['ownerKeys']);
        $this->assertStringStartsWith('cs_test_', $b['stripeSessionId']);

        // Stripe session got the net + fee line items and the right metadata / URLs
        $state = $this->stripeState();
        $session = $state['sessions'][$b['stripeSessionId']];
        $this->assertSame('50.00', $session['metadata']['intended_net_amount']);
        $this->assertSame('1.80', $session['metadata']['estimated_stripe_fee']);   // matches functions/stripeFeeMath.js
        $this->assertSame('51.80', $session['metadata']['gross_charge_amount']);
        $this->assertSame('5000', $session['line_items_form'][0]['price_data']['unit_amount']);
        $this->assertSame('180', $session['line_items_form'][1]['price_data']['unit_amount']);
        $this->assertStringContainsString('/confirm?bookingId=' . rawurlencode($bookingId) . '&session_id={CHECKOUT_SESSION_ID}&mode=deposit', $session['success_url']);

        // "received" client email + admin new-booking email queued (enqueueBookingEmail parity)
        $kinds = array_column($this->outbox(), 'kind');
        $this->assertContains('received', $kinds);
        $this->assertContains('admin_new_booking', $kinds);
        $received = array_values(array_filter($this->outbox(), static fn ($m) => $m['kind'] === 'received'))[0];
        $this->assertStringContainsString('9:00 AM', (string) $received['subject'], 'email times are business-local');

        // Same requestId again -> idempotent reuse of the open session
        $again = $this->checkout($c, 'book1@example.test', $day, '09:00', 'req-1');
        $this->assertSame($bookingId, $again['json']['result']['bookingId']);
        $this->assertTrue($again['json']['result']['reused']);
        $this->assertSame(1, (int) static::$app->db->scalar('SELECT COUNT(*) FROM bookings'));
    }

    public function testEmailMustMatchAccountAndAuthRequired(): void
    {
        $day = self::futureWeekday(14);
        $anon = $this->client();
        $r = $anon->fn('createBookingAndStripeCheckout', ['requestId' => 'x', 'bookingData' => $this->draft('a@b.test', $day), 'customerEmail' => 'a@b.test']);
        $this->assertSame('unauthenticated', $r['json']['error']['code']);
        $c = $this->registerClient('mismatch@example.test');
        $r = $this->checkout($c, 'someone-else@example.test', $day);
        $this->assertSame('permission-denied', $r['json']['error']['code']);
    }

    public function testSlotConflictAndConcurrentRequests(): void
    {
        $day = self::futureWeekday(16);
        $a = $this->registerClient('race-a@example.test');
        $first = $this->checkout($a, 'race-a@example.test', $day, '11:00');
        $this->assertSame(200, $first['status'], $first['body']);

        $b = $this->registerClient('race-b@example.test');
        $conflict = $this->checkout($b, 'race-b@example.test', $day, '11:00');
        $this->assertSame('already-exists', $conflict['json']['error']['code']);

        $check = $b->fn('checkBookingConflict', ['startAt' => ['__ts' => self::localIso($day, '11:30')], 'endAt' => ['__ts' => self::localIso($day, '12:30')]]);
        $this->assertTrue($check['json']['result']['conflict']);
        $this->assertSame('another appointment during that time', $check['json']['result']['with']);

        $avail = $b->fn('getDayAvailability', ['dateKey' => $day, 'timeOptions' => ['09:00 AM', '11:00 AM', '01:00 PM', '03:00 PM'], 'slotCapacity' => 1, 'dailyCapacity' => 6, 'durationMinutes' => 120]);
        $res = $avail['json']['result'];
        $this->assertFalse($res['fullyBooked']);
        $this->assertSame(1, $res['dayCountBlocking']);
        // 11:00 booking lasts 2.5h (13:30) => 09:00 slot (till 11:00) free, 11:00 and 01:00 PM blocked
        $this->assertEqualsCanonicalizing(['11:00 AM', '01:00 PM'], $res['blockedSlots']);

        // Concurrency: 5 different users race for the same 03:00 PM slot -> exactly one wins.
        $clients = [];
        foreach (range(1, 5) as $i) {
            $clients[$i] = $this->registerClient("racer$i@example.test");
            $clients[$i]->session();
        }
        $mh = curl_multi_init();
        $handles = [];
        foreach ($clients as $i => $c) {
            // Build requests via a reflected cookie: simplest is to fire sequential curl handles in parallel
            $ch = $this->parallelHandle($c, '/api/fn/createBookingAndStripeCheckout', ['data' => [
                'requestId' => "race-$i", 'bookingData' => $this->draft("racer$i@example.test", $day, '15:00'), 'customerEmail' => "racer$i@example.test",
            ]]);
            curl_multi_add_handle($mh, $ch);
            $handles[$i] = $ch;
        }
        do {
            curl_multi_exec($mh, $running);
            curl_multi_select($mh, 0.1);
        } while ($running > 0);
        $codes = [];
        foreach ($handles as $ch) {
            $json = json_decode((string) curl_multi_getcontent($ch), true);
            $codes[] = isset($json['result']) ? 'ok' : ($json['error']['code'] ?? 'http-' . curl_getinfo($ch, CURLINFO_RESPONSE_CODE));
            curl_multi_remove_handle($mh, $ch);
        }
        curl_multi_close($mh);
        $this->assertSame(1, count(array_keys($codes, 'ok')), 'exactly one concurrent booking wins: ' . json_encode($codes));
        $this->assertSame(4, count(array_keys($codes, 'already-exists')), json_encode($codes));
    }

    /** Builds a curl handle carrying the client's cookie + CSRF header. */
    private function parallelHandle(HttpClient $c, string $path, array $body)
    {
        $ref = new \ReflectionProperty($c, 'cookies');
        $cookies = $ref->getValue($c);
        $base = (new \ReflectionProperty($c, 'base'))->getValue($c);
        $ch = curl_init($base . $path);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POSTFIELDS => json_encode($body),
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'X-CSRF-Token: ' . $c->csrf,
                'Cookie: ' . implode('; ', array_map(static fn ($k, $v) => "$k=$v", array_keys($cookies), $cookies)),
            ],
        ]);
        return $ch;
    }

    public function testDailyCapacityAndBlackouts(): void
    {
        $day = self::futureWeekday(20);
        // Seed 6 blocking bookings directly (capacity 6) at non-overlapping times
        foreach (range(0, 5) as $i) {
            $start = new \DateTimeImmutable(self::localIso($day, sprintf('%02d:00', 6 + $i * 2)));
            static::$app->bookings->save("cap$i", null, ['status' => 'confirmed', 'startAt' => Doc::ts($start), 'endAt' => Doc::ts($start->modify('+1 hour'))]);
        }
        $c = $this->registerClient('cap@example.test');
        $r = $this->checkout($c, 'cap@example.test', $day, '09:00');
        $this->assertSame('resource-exhausted', $r['json']['error']['code']);

        // Full-day blackout (exclusive end) blocks only that day
        $bday = self::futureWeekday(24);
        $next = (new \DateTimeImmutable($bday))->modify('+1 day')->format('Y-m-d');
        static::$app->store->put('blackouts', 'bo1', [
            'allDay' => true, 'startDateKey' => $bday, 'endDateKey' => $next, 'dateKey' => $bday,
            'startAt' => ['__ts' => self::localIso($bday, '00:00')], 'endAt' => ['__ts' => self::localIso($next, '00:00')],
        ]);
        $blocked = $this->checkout($c, 'cap@example.test', $bday, '09:00');
        $this->assertSame('already-exists', $blocked['json']['error']['code']);
        $this->assertSame('Business blackout during that time.', $blocked['json']['error']['message']);
        $avail = $c->fn('getDayAvailability', ['dateKey' => $bday, 'timeOptions' => ['09:00 AM'], 'slotCapacity' => 1, 'dailyCapacity' => 6, 'durationMinutes' => 120]);
        $this->assertSame('blackout', $avail['json']['result']['unavailableReason']);
        $nextAvail = $c->fn('getDayAvailability', ['dateKey' => $next, 'timeOptions' => ['09:00 AM'], 'slotCapacity' => 1, 'dailyCapacity' => 6, 'durationMinutes' => 120]);
        $this->assertNull($nextAvail['json']['result']['unavailableReason']);
    }

    public function testWebhookConfirmsDepositIdempotentlyAndRejectsBadSignatures(): void
    {
        $day = self::futureWeekday(30);
        $c = $this->registerClient('pay@example.test');
        $bookingId = $this->checkout($c, 'pay@example.test', $day, '13:00')['json']['result']['bookingId'];
        $event = [
            'id' => 'evt_1', 'type' => 'payment_intent.succeeded',
            'data' => ['object' => ['id' => 'pi_1', 'metadata' => [
                'bookingId' => $bookingId, 'mode' => 'deposit', 'intended_net_amount' => '50.00', 'estimated_stripe_fee' => '1.85', 'gross_charge_amount' => '51.85',
            ]]],
        ];
        [$payload, $sig] = $this->signedWebhook($event, 'wrong_secret');
        $this->assertSame(400, $this->client()->raw('POST', '/api/stripe/webhook', $payload, ['Stripe-Signature' => $sig])['status']);
        [$payload, $sig] = $this->signedWebhook($event, 'whsec_test_secret', time() - 3600);
        $this->assertSame(400, $this->client()->raw('POST', '/api/stripe/webhook', $payload, ['Stripe-Signature' => $sig])['status'], 'stale timestamp rejected');

        [$payload, $sig] = $this->signedWebhook($event);
        $ok = $this->client()->raw('POST', '/api/stripe/webhook', $payload, ['Stripe-Signature' => $sig]);
        $this->assertSame(200, $ok['status'], $ok['body']);
        $b = static::$app->bookings->get($bookingId);
        $this->assertSame('confirmed', $b['status']);
        $this->assertTrue($b['depositPaid']);
        $this->assertSame(50.0, (float) $b['paidAmount']);
        $this->assertSame('partial', $b['paymentStatus']);
        $this->assertSame('pi_1', $b['depositPaymentIntentId']);
        $this->assertContains('confirm', array_column($this->outbox(), 'kind'));

        // Replay (same event) and a different event for the same PI do not double count
        $dup = $this->client()->raw('POST', '/api/stripe/webhook', $payload, ['Stripe-Signature' => $sig]);
        $this->assertTrue($dup['json']['duplicate']);
        $event['id'] = 'evt_2';
        [$payload2, $sig2] = $this->signedWebhook($event);
        $this->assertSame(200, $this->client()->raw('POST', '/api/stripe/webhook', $payload2, ['Stripe-Signature' => $sig2])['status']);
        $this->assertSame(50.0, (float) static::$app->bookings->get($bookingId)['paidAmount']);
        $this->assertSame(1, (int) static::$app->db->scalar('SELECT COUNT(*) FROM payments WHERE booking_doc_id = ?', [$bookingId]));

        // Remaining balance via webhook completes the booking
        $remaining = (float) static::$app->bookings->get($bookingId)['remainingDue'];
        $bal = ['id' => 'evt_3', 'type' => 'payment_intent.succeeded', 'data' => ['object' => ['id' => 'pi_2', 'metadata' => [
            'bookingId' => $bookingId, 'mode' => 'remaining_due', 'intended_net_amount' => number_format($remaining, 2, '.', ''), 'estimated_stripe_fee' => '2.00', 'gross_charge_amount' => '0',
        ]]]];
        [$p3, $s3] = $this->signedWebhook($bal);
        $this->assertSame(200, $this->client()->raw('POST', '/api/stripe/webhook', $p3, ['Stripe-Signature' => $s3])['status']);
        $done = static::$app->bookings->get($bookingId);
        $this->assertSame('completed', $done['status']);
        $this->assertSame('paid', $done['paymentStatus']);
        $this->assertSame(0.0, (float) $done['remainingDue']);

        // Amount mismatch -> 500 (Stripe retries), booking unchanged
        $c2 = $this->registerClient('pay2@example.test');
        $b2 = $this->checkout($c2, 'pay2@example.test', self::futureWeekday(31), '09:00')['json']['result']['bookingId'];
        $bad = ['id' => 'evt_4', 'type' => 'payment_intent.succeeded', 'data' => ['object' => ['id' => 'pi_3', 'metadata' => ['bookingId' => $b2, 'mode' => 'deposit', 'intended_net_amount' => '10.00']]]];
        [$p4, $s4] = $this->signedWebhook($bad);
        $this->assertSame(500, $this->client()->raw('POST', '/api/stripe/webhook', $p4, ['Stripe-Signature' => $s4])['status']);
        $this->assertSame('pending_payment', static::$app->bookings->get($b2)['status']);

        // Other event types are acknowledged and ignored
        [$p5, $s5] = $this->signedWebhook(['id' => 'evt_5', 'type' => 'charge.refunded', 'data' => ['object' => []]]);
        $this->assertSame(200, $this->client()->raw('POST', '/api/stripe/webhook', $p5, ['Stripe-Signature' => $s5])['status']);
    }

    public function testOwnershipCancelRescheduleAndClientUpdateRules(): void
    {
        $day = self::futureWeekday(40);
        $owner = $this->registerClient('own@example.test');
        $bookingId = $this->checkout($owner, 'own@example.test', $day, '09:00')['json']['result']['bookingId'];
        $intruder = $this->registerClient('intruder@example.test');

        $this->assertSame(403, $intruder->post('/api/db/get', ['path' => "bookings/$bookingId"])['status']);
        $this->assertSame([], $intruder->post('/api/db/query', ['collection' => 'bookings'])['json']['docs']);
        $this->assertSame('permission-denied', $intruder->fn('cancelBooking', ['bookingId' => $bookingId])['json']['error']['code']);
        $this->assertSame('permission-denied', $intruder->fn('rescheduleBooking', ['bookingId' => $bookingId, 'startAt' => self::localIso($day, '13:00')])['json']['error']['code']);

        // Owner queries exactly like ClientPortalPage (userId + orderBy startAt desc)
        $uid = $this->uidOf('own@example.test');
        $q = $owner->post('/api/db/query', ['collection' => 'bookings', 'where' => [['userId', '==', $uid]], 'orderBy' => [['startAt', 'desc']], 'limit' => 1000]);
        $this->assertSame([$bookingId], array_column($q['json']['docs'], 'id'));
        $q2 = $owner->post('/api/db/query', ['collection' => 'bookings', 'where' => [['ownerKeys', 'array-contains', "uid:$uid"]], 'orderBy' => [['startAt', 'desc']]]);
        $this->assertSame([$bookingId], array_column($q2['json']['docs'], 'id'));

        // safeClientBookingUpdate: notes allowed, status not
        $this->assertSame(200, $owner->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "bookings/$bookingId", 'data' => ['notes' => 'Gate code 9', 'updatedAt' => ['__op' => 'serverTimestamp']]]]])['status']);
        $this->assertSame(403, $owner->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "bookings/$bookingId", 'data' => ['status' => 'confirmed']]]])['status']);
        $this->assertSame(403, $owner->post('/api/db/commit', ['writes' => [['op' => 'create', 'path' => 'bookings', 'data' => ['status' => 'confirmed']]]])['status']);

        // Reschedule keeps duration, moves end, resets reminder flags, emails "updated"
        static::$app->bookings->update($bookingId, ['reminder48SentAt' => ['__op' => 'serverTimestamp']]);
        $r = $owner->fn('rescheduleBooking', ['bookingId' => $bookingId, 'startAt' => self::localIso($day, '13:00'), 'timeLabel' => '01:00 PM']);
        $this->assertSame(200, $r['status'], $r['body']);
        $b = static::$app->bookings->get($bookingId);
        $this->assertSame('01:00 PM', $b['timeLabel']);
        $this->assertSame(self::localIso($day, '13:00'), $b['startAt']['__ts']);
        $this->assertSame(self::localIso($day, '15:30'), $b['endAt']['__ts']);
        $this->assertArrayNotHasKey('reminder48SentAt', $b);
        $this->assertContains('admin_rescheduled', array_column($this->outbox(), 'kind'));

        $cancel = $owner->fn('cancelBooking', ['bookingId' => $bookingId]);
        $this->assertSame('cancelled', $cancel['json']['result']['status']);
        $this->assertSame('cancelled', static::$app->bookings->get($bookingId)['status']);
        // PARITY QUIRK (kept on purpose): enqueueBookingEmail's 10-minute dedupe for kind "updated"
        // returns before admin notifications, so a cancel right after a reschedule sends no admin email.
        $this->assertNotContains('admin_cancelled', array_column($this->outbox(), 'kind'));

        // A cancel without a recent "updated" email does notify the admin.
        $second = $this->checkout($owner, 'own@example.test', self::futureWeekday(41), '09:00')['json']['result']['bookingId'];
        $owner->fn('cancelBooking', ['bookingId' => $second]);
        $this->assertContains('admin_cancelled', array_column($this->outbox(), 'kind'));
        $this->assertSame('failed-precondition', $owner->fn('rescheduleBooking', ['bookingId' => $bookingId, 'startAt' => self::localIso($day, '09:00')])['json']['error']['code']);
    }

    public function testEmailMatchedAccessForAdminCreatedBooking(): void
    {
        $admin = $this->registerClient('boss@example.test');
        $this->makeAdmin('boss@example.test');
        $day = self::futureWeekday(45);
        $r = $admin->fn('createAdminBooking', ['bookingData' => [
            'contact' => ['name' => 'Walk In', 'email' => 'Walkin@Example.test'], 'serviceName' => 'Deep Clean', 'startAt' => self::localIso($day, '09:00'),
            'durationMinutes' => 180, 'totalPrice' => 240, 'depositAmount' => 50, 'status' => 'confirmed',
        ]]);
        $this->assertSame(200, $r['status'], $r['body']);
        $id = $r['json']['result']['bookingId'];
        $b = static::$app->bookings->get($id);
        $this->assertSame(['email:walkin@example.test'], $b['ownerKeys']);
        $this->assertNull($b['userId']);
        $this->assertSame('unpaid', $b['paymentStatus']);

        // A later account with that email sees it (current rules: token email match)
        $client = $this->registerClient('walkin@example.test');
        $q = $client->post('/api/db/query', ['collection' => 'bookings', 'where' => [['contactEmailLower', '==', 'walkin@example.test']], 'orderBy' => [['startAt', 'desc']]]);
        $this->assertSame([$id], array_column($q['json']['docs'], 'id'));
        // and can pay the balance (strict email match)
        $pay = $client->fn('createStripeCheckoutSession', ['bookingId' => $id, 'mode' => 'remaining_due', 'customerEmail' => 'walkin@example.test']);
        $this->assertSame(200, $pay['status'], $pay['body']);

        $nonAdmin = $this->registerClient('nope@example.test');
        $this->assertSame('permission-denied', $nonAdmin->fn('createAdminBooking', ['bookingData' => ['startAt' => self::localIso($day, '13:00'), 'contact' => ['email' => 'x@y.test']]])['json']['error']['code']);
    }

    public function testAdminGatewayWritesAndReviewFlow(): void
    {
        $owner = $this->registerClient('rev@example.test');
        $day = self::futureWeekday(50);
        $bookingId = $this->checkout($owner, 'rev@example.test', $day, '09:00')['json']['result']['bookingId'];
        $uid = $this->uidOf('rev@example.test');
        $review = ['clientId' => $uid, 'bookingId' => $bookingId, 'serviceName' => null, 'displayMode' => 'initials', 'reviewDisplayName' => 'T.C.', 'rating' => 5, 'comment' => 'Great job!', 'body' => 'Great job!', 'source' => 'client-portal', 'status' => 'pending', 'createdAt' => ['__op' => 'serverTimestamp']];
        $bad = $review;
        $bad['status'] = 'approved';
        $this->assertSame(403, $owner->post('/api/db/commit', ['writes' => [['op' => 'create', 'path' => 'reviews', 'data' => $bad]]])['status']);
        $created = $owner->post('/api/db/commit', ['writes' => [['op' => 'create', 'path' => 'reviews', 'data' => $review]]]);
        $this->assertSame(200, $created['status'], $created['body']);
        $reviewId = $created['json']['results'][0]['id'];
        $this->assertSame(200, $owner->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "bookings/$bookingId", 'data' => ['reviewId' => $reviewId, 'reviewRating' => 5, 'reviewLeftAt' => ['__op' => 'serverTimestamp'], 'updatedAt' => ['__op' => 'serverTimestamp']]]]])['status']);
        // reviewId cannot be changed once set
        $this->assertSame(403, $owner->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "bookings/$bookingId", 'data' => ['reviewId' => 'other']]]])['status']);

        $admin = $this->registerClient('mod@example.test');
        $this->makeAdmin('mod@example.test');
        $pending = $admin->post('/api/db/query', ['collection' => 'reviews', 'where' => [['status', '==', 'pending']], 'orderBy' => [['createdAt', 'asc']]]);
        $this->assertSame([$reviewId], array_column($pending['json']['docs'], 'id'));
        $this->assertSame(200, $admin->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "reviews/$reviewId", 'data' => ['status' => 'approved', 'updatedAt' => ['__op' => 'serverTimestamp']]]]])['status']);
        $approved = $this->client()->post('/api/db/query', ['collection' => 'reviews', 'where' => [['status', '==', 'approved']], 'orderBy' => [['publishedAt', 'desc']]]);
        $this->assertSame([$reviewId], array_column($approved['json']['docs'], 'id'), 'approved reviews are public and publishedAt was stamped');

        // Admin status change through the gateway triggers the same emails as the Firestore trigger
        $this->assertSame(200, $admin->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "bookings/$bookingId", 'data' => ['status' => 'declined', 'updatedAt' => ['__op' => 'serverTimestamp']]]]])['status']);
        $this->assertContains('decline', array_column($this->outbox(), 'kind'));
        $this->assertGreaterThan(0, (int) static::$app->db->scalar("SELECT COUNT(*) FROM audit_log WHERE entity = 'bookings'"));
    }

    public function testScheduledJobs(): void
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        // stale pending_payment -> expired; paid one untouched
        static::$app->bookings->save('stale', null, ['status' => 'pending_payment', 'createdAt' => Doc::ts($now->modify('-45 minutes')), 'startAt' => Doc::ts($now->modify('+3 days'))]);
        static::$app->bookings->save('stalePaid', null, ['status' => 'pending_payment', 'depositPaid' => true, 'createdAt' => Doc::ts($now->modify('-45 minutes')), 'startAt' => Doc::ts($now->modify('+3 days'))]);
        static::$app->bookings->save('fresh', null, ['status' => 'pending_payment', 'createdAt' => Doc::ts($now->modify('-5 minutes')), 'startAt' => Doc::ts($now->modify('+3 days'))]);
        $r = static::$app->jobs->run('expire-pending');
        $this->assertSame(1, $r['result']['expired'], json_encode($r));
        $this->assertSame('expired', static::$app->bookings->get('stale')['status']);
        $this->assertSame('pending_payment', static::$app->bookings->get('stalePaid')['status']);

        // recovery: a paid Stripe session whose webhook never arrived
        static::$app->bookings->save('lost', null, ['status' => 'pending_payment', 'totalPrice' => 150, 'depositAmount' => 50, 'stripeSessionId' => 'cs_lost', 'createdAt' => Doc::ts($now->modify('-12 minutes')), 'startAt' => Doc::ts($now->modify('+4 days'))]);
        $this->setStripeSession('cs_lost', ['id' => 'cs_lost', 'status' => 'complete', 'payment_status' => 'paid', 'payment_intent' => ['id' => 'pi_lost'], 'metadata' => ['bookingId' => 'lost', 'mode' => 'deposit', 'intended_net_amount' => '50.00', 'estimated_stripe_fee' => '1.85', 'gross_charge_amount' => '51.85']]);
        static::$app->bookings->save('abandoned', null, ['status' => 'pending_payment', 'totalPrice' => 150, 'depositAmount' => 50, 'stripeSessionId' => 'cs_gone', 'createdAt' => Doc::ts($now->modify('-12 minutes')), 'startAt' => Doc::ts($now->modify('+4 days'))]);
        $this->setStripeSession('cs_gone', ['id' => 'cs_gone', 'status' => 'expired', 'payment_status' => 'unpaid']);
        $rec = static::$app->jobs->run('recover-payments');
        $this->assertSame(1, $rec['result']['recovered'], json_encode($rec));
        $this->assertSame(1, $rec['result']['markedExpired'], json_encode($rec));
        $lost = static::$app->bookings->get('lost');
        $this->assertSame('confirmed', $lost['status']);
        $this->assertArrayHasKey('webhookRecoveredAt', $lost);
        $this->assertSame('expired', static::$app->bookings->get('abandoned')['status']);

        // reminders: 48h window, sent once
        static::$app->bookings->save('remind', null, ['status' => 'confirmed', 'contact' => ['email' => 'remind@example.test', 'name' => 'R'], 'serviceName' => 'Deep Clean', 'totalPrice' => 200, 'depositAmount' => 50, 'depositPaid' => true, 'paidAmount' => 50, 'startAt' => Doc::ts($now->modify('+48 hours')), 'endAt' => Doc::ts($now->modify('+50 hours'))]);
        $rem = static::$app->jobs->sendReminders();
        $this->assertSame(1, $rem['sent48'], json_encode($rem));
        $this->assertSame(0, static::$app->jobs->sendReminders()['sent48']);
        $mail = array_values(array_filter($this->outbox(), static fn ($m) => $m['kind'] === 'appointment_reminder_48h'));
        $this->assertCount(1, $mail);
        $this->assertStringContainsString('Remaining balance due: $150.00.', (string) $mail[0]['text_body']);

        // outbox delivery (log transport) marks rows sent
        $sent = static::$app->jobs->run('send-outbox');
        $this->assertSame('ok', $sent['status']);
        $this->assertSame(0, (int) static::$app->db->scalar("SELECT COUNT(*) FROM email_outbox WHERE status <> 'sent'"));
        $this->assertFileExists(self::$env['mailLog']);

        // web-cron fallback requires the token
        $this->assertSame(403, $this->client()->raw('POST', '/api/jobs/run?job=purge', '{}')['status']);
        $ok = $this->client()->raw('POST', '/api/jobs/run?job=purge', '{}', ['Authorization' => 'Bearer ' . str_repeat('j', 40)]);
        $this->assertSame(200, $ok['status'], $ok['body']);
    }

    public function testMaintenanceSweepMatchesCloudFunction(): void
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        static::$app->bookings->save('done', null, ['status' => 'confirmed', 'startAt' => Doc::ts($now->modify('-6 hours')), 'endAt' => Doc::ts($now->modify('-4 hours'))]);
        static::$app->bookings->save('testy', null, ['status' => 'confirmed', 'notes' => 'TEST booking', 'startAt' => Doc::ts($now->modify('+1 day'))]);
        $admin = $this->registerClient('sweeper@example.test');
        $this->makeAdmin('sweeper@example.test');
        $dry = $admin->post('/api/sweepCompleteBookings', ['dryRun' => true], ['Authorization' => 'Bearer ' . $admin->csrf], false);
        $this->assertSame(200, $dry['status'], $dry['body']);
        $this->assertSame(1, $dry['json']['autoCompletedCount']);
        $this->assertSame(1, $dry['json']['deletedTestBookingsCount']);
        $this->assertSame('confirmed', static::$app->bookings->get('done')['status']);
        $real = $admin->post('/api/sweepCompleteBookings', ['dryRun' => false], ['Authorization' => 'Bearer ' . $admin->csrf], false);
        $this->assertSame(1, $real['json']['updated']);
        $this->assertSame('completed', static::$app->bookings->get('done')['status']);
        $this->assertNull(static::$app->bookings->get('testy'));
        $client = $this->registerClient('notadmin@example.test');
        $this->assertSame(403, $client->post('/api/sweepCompleteBookings', [], ['Authorization' => 'Bearer ' . $client->csrf], false)['status']);
    }
}

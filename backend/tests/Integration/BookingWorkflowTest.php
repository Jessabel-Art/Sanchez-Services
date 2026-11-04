<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

use SanchezServices\Clock;

final class BookingWorkflowTest extends IntegrationTestCase
{
    private function bookingBody(string $date, string $time = '09:00', array $extra = []): array
    {
        return array_replace_recursive([
            'requestId' => 'req_' . bin2hex(random_bytes(8)),
            'serviceSlug' => 'residential-cleaning',
            'bedrooms' => 2,
            'bathrooms' => 1,
            'condition' => 'standard',
            'pets' => false,
            'addons' => [],
            'frequency' => 'one-time',
            'date' => $date,
            'time' => $time,
            'contact' => ['name' => 'Casey Client', 'email' => 'ignored@example.test', 'phone' => '(401) 555-1212'],
            'address' => ['line1' => '12 Elm St', 'city' => 'Providence', 'state' => 'RI', 'zip' => '02903'],
            'accessNotes' => 'Key under mat',
        ], $extra);
    }

    private function book(HttpClient $c, string $date, string $time = '09:00', array $extra = []): array
    {
        return $c->post('/api/bookings', $this->bookingBody($date, $time, $extra));
    }

    public function testQuoteCatalogAndAvailability(): void
    {
        $c = $this->client();
        $cat = $c->get('/api/catalog');
        $this->assertSame(200, $cat['status']);
        $this->assertSame('residential-cleaning', $cat['json']['services'][0]['slug']);
        $q = $c->post('/api/quote', ['serviceSlug' => 'deep-clean', 'bedrooms' => 3, 'bathrooms' => 2, 'addons' => ['oven'], 'frequency' => 'weekly', 'promoCode' => 'clean10'], [], false);
        $this->assertSame(200, $q['status'], $q['body']);
        // (120 + 60 + 50 + 20) * 1 = 250; weekly -15% = 212.50; promo -10% = 191.25
        $this->assertSame(191.25, $q['json']['totalPrice']);
        $this->assertSame(191.25, round(array_sum(array_column($q['json']['lineItems'], 'amount')), 2), 'line items sum to total');
        $this->assertSame('invalid-argument', $c->post('/api/quote', ['serviceSlug' => 'deep-clean', 'promoCode' => 'BOGUS'], [], false)['json']['error']['code']);

        $sunday = self::nextWeekday(7);
        $day = $c->get("/api/availability?date={$sunday}&durationMinutes=150")['json'];
        $this->assertFalse($day['open'], 'Sundays are closed');
        $saturday = self::nextWeekday(6);
        $sat = $c->get("/api/availability?date={$saturday}&durationMinutes=150")['json'];
        $this->assertSame(['09:00', '11:00', '13:00'], array_column($sat['slots'], 'time'), 'Saturday ends at 1 PM');
        $tue = self::nextWeekday(2);
        $t = $c->get("/api/availability?date={$tue}&durationMinutes=150")['json'];
        $this->assertSame('09:00 AM', $t['slots'][0]['label']);
        $this->assertTrue($t['slots'][0]['available']);
        // DST-safe: 9:00 AM local maps to the right UTC instant
        $this->assertSame(Clock::iso(new \DateTimeImmutable("{$tue} 09:00", new \DateTimeZone('America/New_York'))), $t['slots'][0]['startAt']);
        $month = $c->get('/api/availability/month?month=' . substr($tue, 0, 7) . '&durationMinutes=150')['json'];
        $this->assertGreaterThanOrEqual(28, count($month['days']));
    }

    public function testOnlineBookingDepositPaymentAndExactlyOnceEmails(): void
    {
        $c = $this->registerClient('casey@example.test', 'correct-horse-1', 'Casey Client');
        $date = self::nextWeekday(2);
        $r = $this->book($c, $date, '09:00', ['saveAddress' => true]);
        $this->assertSame(200, $r['status'], $r['body']);
        $b = $r['json']['booking'];
        $this->assertSame('pending_payment', $b['status']);
        $this->assertSame('casey@example.test', $b['contact']['email'], 'booking email is the account email');
        $this->assertSame('4015551212', $b['contact']['phone']);
        $this->assertSame(145.0, $b['totalPrice']);
        $this->assertSame(50.0, $b['depositDue']);
        $this->assertMatchesRegularExpression('/^SS-\d{4}-\d{6}$/', $b['invoiceNumber']);
        $this->assertStringStartsWith('https://checkout.stripe.test/', $r['json']['checkoutUrl']);
        $sid = $this->lastSessionId();
        $session = $this->stripeState()['sessions'][$sid];
        $this->assertSame(5180, $session['amount_total'], '$50 deposit + $1.80 card fee');
        $this->assertSame($b['id'], $session['metadata']['booking_ref']);
        $this->assertSame('casey@example.test', $session['customer_email']);
        $this->assertSame(['email_verify'], $this->emailKinds(), 'only the account verification email until the deposit is paid');
        $this->assertCount(1, $c->get('/api/me/addresses')['json']['addresses'], 'address saved');

        // Same requestId again: no duplicate booking
        $again = $c->post('/api/bookings', $this->bookingBody($date, '09:00', ['requestId' => 'dup_' . 'x' . str_repeat('a', 8)]));
        $this->assertSame('already-exists', $again['json']['error']['code'], 'slot is held by the first booking');

        // Webhook: paid -> confirmed, ledger row, receipt + confirmation + admin emails exactly once
        $signed = $this->paySession($sid);
        $this->assertSame(200, $this->webhook($signed)['status']);
        $this->assertSame(200, $this->webhook($signed)['status'], 'replayed event is accepted');
        $paid = $c->get('/api/bookings/' . $b['id'])['json']['booking'];
        $this->assertSame('confirmed', $paid['status']);
        $this->assertSame(50.0, $paid['amountPaid']);
        $this->assertSame(95.0, $paid['balanceDue']);
        $this->assertSame('deposit_paid', $paid['paymentStatus']);
        $this->assertTrue($paid['depositPaid']);
        $this->assertCount(1, $paid['payments']);
        $this->assertSame(1.8, $paid['payments'][0]['fee']);
        $this->assertSame(['email_verify', 'payment_receipt', 'booking_confirmed'], $this->emailKinds('casey@example.test'));
        $this->assertSame(['admin_booking_confirmed'], $this->emailKinds('owner@example.test'));

        // Success-page sync after the webhook is a no-op
        $sync = $c->post('/api/bookings/' . $b['id'] . '/payment-sync', ['sessionId' => $sid]);
        $this->assertSame(1, count($sync['json']['booking']['payments']));

        // Pay the balance
        $bal = $c->post('/api/bookings/' . $b['id'] . '/checkout', ['purpose' => 'balance']);
        $this->assertSame(200, $bal['status'], $bal['body']);
        $sid2 = $this->lastSessionId();
        $this->assertSame(9815, $this->stripeState()['sessions'][$sid2]['amount_total'], '$95 balance + $3.15 fee nets exactly $95 after Stripe fees');
        // Success page arrives BEFORE the webhook: sync confirms directly with Stripe
        $this->paySession($sid2);
        $synced = $c->post('/api/bookings/' . $b['id'] . '/payment-sync', ['sessionId' => $sid2])['json']['booking'];
        $this->assertSame('paid', $synced['paymentStatus']);
        $this->assertSame(0.0, $synced['balanceDue']);
        $this->assertSame('confirmed', $synced['status'], 'paying in full does not complete the visit');

        // Invoice is consistent with the booking and ledger
        $inv = $c->get('/api/bookings/' . $b['id'] . '/invoice')['json']['invoice'];
        $this->assertSame(145.0, $inv['total']);
        $this->assertSame(145.0, $inv['amountPaid']);
        $this->assertSame(0.0, $inv['balanceDue']);
        $this->assertSame(145.0, round(array_sum(array_column($inv['lineItems'], 'amount')), 2));
        $this->assertCount(2, $inv['payments']);

        // Admin sees the same record
        $admin = $this->adminClient();
        $ab = $admin->get('/api/admin/bookings/' . $b['id'])['json']['booking'];
        foreach (['status', 'totalPrice', 'amountPaid', 'balanceDue', 'paymentStatus', 'startAt', 'invoiceNumber', 'lineItems'] as $k) {
            $this->assertSame($synced[$k], $ab[$k], "admin and client agree on {$k}");
        }
    }

    public function testPaymentVerificationRejectsTamperedAmountsAndBadSignatures(): void
    {
        $c = $this->registerClient('tamper@example.test');
        $b = $this->book($c, self::nextWeekday(3), '11:00')['json']['booking'];
        $sid = $this->lastSessionId();
        [$payload, $sig] = $this->signedWebhook(['id' => 'evt_x', 'type' => 'checkout.session.completed', 'livemode' => false, 'data' => ['object' => ['id' => $sid]]], 'wrong_secret');
        $this->assertSame(400, $this->webhook([$payload, $sig])['status']);
        $bad = $this->paySession($sid, 100); // $1.00 instead of $51.80
        $this->assertSame(500, $this->webhook($bad)['status']);
        $after = static::$app->repo->byRef($b['id']);
        $this->assertSame('pending_payment', $after['status']);
        $this->assertSame('0.00', (string) $after['amount_paid']);
        $this->assertStringContainsString('does not match', (string) $after['needs_attention']);
        // Live-mode events are ignored by a non-production deployment
        $live = $this->signedWebhook(['id' => 'evt_live', 'type' => 'checkout.session.completed', 'livemode' => true, 'data' => ['object' => ['id' => $sid]]]);
        $this->assertSame('mode', $this->webhook($live)['json']['ignored']);
    }

    public function testConcurrentBookingsForTheSameSlot(): void
    {
        $date = self::nextWeekday(4);
        $clients = [];
        foreach (range(1, 6) as $i) {
            $clients[$i] = $this->registerClient("race{$i}@example.test");
        }
        $mh = curl_multi_init();
        $handles = [];
        foreach ($clients as $i => $c) {
            $ch = $this->parallel($c, '/api/bookings', $this->bookingBody($date, '13:00'));
            curl_multi_add_handle($mh, $ch);
            $handles[] = $ch;
        }
        do {
            curl_multi_exec($mh, $running);
            curl_multi_select($mh, 0.1);
        } while ($running > 0);
        $codes = [];
        foreach ($handles as $ch) {
            $j = json_decode((string) curl_multi_getcontent($ch), true);
            $codes[] = isset($j['booking']) ? 'ok' : ($j['error']['code'] ?? 'http' . curl_getinfo($ch, CURLINFO_RESPONSE_CODE));
        }
        $this->assertSame(1, count(array_keys($codes, 'ok')), json_encode($codes));
        $this->assertSame(5, count(array_keys($codes, 'already-exists')), json_encode($codes));
        $this->assertSame(1, (int) static::$app->db->scalar("SELECT COUNT(*) FROM bookings WHERE business_date = ? AND status = 'pending_payment'", [$date]));
    }

    private function parallel(HttpClient $c, string $path, array $body)
    {
        $c->session();
        $cookies = (new \ReflectionProperty($c, 'cookies'))->getValue($c);
        $ch = curl_init((new \ReflectionProperty($c, 'base'))->getValue($c) . $path);
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_POSTFIELDS => json_encode($body), CURLOPT_HTTPHEADER => [
            'Content-Type: application/json', 'X-CSRF-Token: ' . $c->csrf,
            'Cookie: ' . implode('; ', array_map(static fn ($k, $v) => "$k=$v", array_keys($cookies), $cookies)),
        ]]);
        return $ch;
    }

    public function testBookingRulesAreEnforcedOnTheServer(): void
    {
        $c = $this->registerClient('rules@example.test');
        $err = fn (array $r) => $r['json']['error']['message'] ?? $r['body'];
        $this->assertStringContainsString('available start times', $err($this->book($c, self::nextWeekday(7), '09:00')), 'Sunday rejected');
        $this->assertStringContainsString('available start times', $err($this->book($c, self::nextWeekday(6), '15:00')), 'Saturday 3 PM rejected');
        $this->assertStringContainsString('available start times', $err($this->book($c, self::nextWeekday(2), '10:00')), 'off-slot time rejected');
        $tomorrow = (new \DateTimeImmutable('+0 days', new \DateTimeZone('America/New_York')))->format('Y-m-d');
        $soon = $this->book($c, $tomorrow, '09:00');
        $this->assertContains($soon['json']['error']['code'], ['invalid-argument'], 'less than 12h notice (or past) rejected');
        $this->assertSame('invalid-argument', $this->book($c, self::nextWeekday(2), '09:00', ['serviceSlug' => 'office-cleaning', 'sqft' => 0])['json']['error']['code']);
        $this->assertSame('invalid-argument', $this->book($c, self::nextWeekday(2), '09:00', ['address' => ['zip' => 'abc']])['json']['error']['code']);
        $this->assertSame('invalid-argument', $this->book($c, self::nextWeekday(2), '09:00', ['addons' => ['jacuzzi']])['json']['error']['code']);
        // Client-sent prices are ignored
        $r = $this->book($c, self::nextWeekday(2), '15:00', ['totalPrice' => 1, 'depositAmount' => 0]);
        $this->assertSame(145.0, $r['json']['booking']['totalPrice']);
        $this->assertSame('unauthenticated', $this->client()->post('/api/bookings', $this->bookingBody(self::nextWeekday(2)))['json']['error']['code']);
    }

    public function testBlackoutsCapacityAndHoldExpiry(): void
    {
        $admin = $this->adminClient();
        $date = self::nextWeekday(5, 9); // a Friday
        $bo = $admin->post('/api/admin/blackouts', ['allDay' => true, 'startDate' => $date, 'endDate' => $date, 'reason' => 'Holiday']);
        $this->assertSame(200, $bo['status'], $bo['body']);
        $c = $this->registerClient('bo@example.test');
        $this->assertStringContainsString('closed', $this->book($c, $date)['json']['error']['message']);
        $this->assertFalse($c->get("/api/availability?date={$date}&durationMinutes=150")['json']['open']);
        // The next day is unaffected (exclusive end date)
        $next = (new \DateTimeImmutable($date))->modify('+1 day')->format('Y-m-d');
        $this->assertTrue($c->get("/api/availability?date={$next}&durationMinutes=150")['json']['anyAvailable']);
        // Timed blackout blocks only overlapping slots
        $d2 = self::nextWeekday(1, 9);
        $admin->post('/api/admin/blackouts', ['allDay' => false, 'startDate' => $d2, 'startTime' => '12:00', 'endTime' => '14:00']);
        $slots = array_column($c->get("/api/availability?date={$d2}&durationMinutes=150")['json']['slots'], 'available', 'time');
        $this->assertSame(['09:00' => true, '11:00' => false, '13:00' => false, '15:00' => true], $slots);

        // Unpaid holds expire and release the slot
        $d3 = self::nextWeekday(3, 9);
        $held = $this->book($c, $d3, '09:00')['json']['booking'];
        $other = $this->registerClient('other@example.test');
        $this->assertSame('already-exists', $this->book($other, $d3, '09:00')['json']['error']['code']);
        static::$app->db->run('UPDATE bookings SET hold_expires_at = ? WHERE ref = ?', [Clock::toSql(static::$app->clock->now()->modify('-1 minute')), $held['id']]);
        $this->assertSame(200, $this->book($other, $d3, '09:00')['status'], 'expired hold no longer blocks');
        $job = static::$app->jobs->run('expire-holds');
        $this->assertSame(1, $job['result']['expired']);
        $this->assertSame('expired', static::$app->repo->byRef($held['id'])['status']);
        $this->assertSame('expired', $this->stripeState()['sessions'][array_key_first($this->stripeState()['sessions'])]['status'], 'Stripe session closed');

        // Late payment for the expired hold: slot was taken -> flagged for the admin, not double-booked
        $firstSession = array_key_first($this->stripeState()['sessions']);
        $s = $this->stripeState()['sessions'][$firstSession];
        $s['status'] = 'complete';
        $this->setStripeSession($firstSession, $s);
        $late = $this->paySession($firstSession);
        $this->assertSame(200, $this->webhook($late)['status']);
        $row = static::$app->repo->byRef($held['id']);
        $this->assertSame('expired', $row['status']);
        $this->assertSame('50.00', (string) $row['amount_paid'], 'money is recorded');
        $this->assertNotNull($row['needs_attention']);
        $this->assertContains('admin_attention', $this->emailKinds('owner@example.test'));

        // Daily capacity (6)
        $d4 = self::nextWeekday(4, 16);
        foreach (['07:00', '09:00', '11:00', '13:00', '15:00', '17:30'] as $i => $t) {
            $r = $admin->post('/api/admin/bookings', $this->adminBody($d4, $t, ['durationMinutes' => 90, 'contact' => ['email' => "cap{$i}@example.test"]]));
            $this->assertSame(200, $r['status'], $r['body']);
        }
        $this->assertSame('resource-exhausted', $admin->post('/api/admin/bookings', $this->adminBody($d4, '19:00', ['durationMinutes' => 60]))['json']['error']['code']);
    }

    private function adminBody(string $date, string $time, array $extra = []): array
    {
        return array_replace_recursive($this->bookingBody($date, $time), ['status' => 'confirmed', 'notifyClient' => true], $extra);
    }

    public function testRescheduleCancelAndTwentyFourHourRule(): void
    {
        $c = $this->registerClient('move@example.test');
        $date = self::nextWeekday(2, 9);
        $b = $this->book($c, $date, '09:00')['json']['booking'];
        $this->webhook($this->paySession($this->lastSessionId()));
        static::$app->db->run('UPDATE bookings SET reminder48_sent_at = UTC_TIMESTAMP() WHERE ref = ?', [$b['id']]);

        $r = $c->post("/api/bookings/{$b['id']}/reschedule", ['date' => $date, 'time' => '13:00']);
        $this->assertSame(200, $r['status'], $r['body']);
        $moved = $r['json']['booking'];
        $this->assertSame('01:00 PM', $moved['timeLabel']);
        $this->assertSame(150, $moved['durationMinutes']);
        $this->assertSame(Clock::iso((new \DateTimeImmutable("{$date} 15:30", new \DateTimeZone('America/New_York')))), $moved['endAt'], 'end moves with start');
        $this->assertNull(static::$app->repo->byRef($b['id'])['reminder48_sent_at'], 'reminders reset');
        $this->assertContains('booking_rescheduled', $this->emailKinds('move@example.test'));
        $this->assertContains('admin_booking_rescheduled', $this->emailKinds('owner@example.test'));
        // Original slot is free again, new one is taken
        $slots = array_column($c->get("/api/availability?date={$date}&durationMinutes=150")['json']['slots'], 'available', 'time');
        $this->assertTrue($slots['09:00']);
        $this->assertFalse($slots['13:00']);

        // Within 24 hours: online changes are blocked
        static::$app->db->run('UPDATE bookings SET start_at = ?, end_at = ? WHERE ref = ?', [
            Clock::toSql(static::$app->clock->now()->modify('+20 hours')), Clock::toSql(static::$app->clock->now()->modify('+22 hours')), $b['id'],
        ]);
        $this->assertSame('failed-precondition', $c->post("/api/bookings/{$b['id']}/cancel", [])['json']['error']['code']);
        $perm = $c->get("/api/bookings/{$b['id']}")['json']['booking']['permissions'];
        $this->assertFalse($perm['canCancel']);
        $this->assertStringContainsString('24 hours', $perm['changeBlockedReason']);
        // Admin can still cancel; a cancel right after a reschedule DOES notify (old dedupe bug fixed)
        $admin = $this->adminClient();
        $x = $admin->post("/api/admin/bookings/{$b['id']}/status", ['status' => 'cancelled', 'reason' => 'Client called']);
        $this->assertSame('cancelled', $x['json']['booking']['status']);
        $this->assertContains('booking_cancelled', $this->emailKinds('move@example.test'));
        $this->assertSame('failed-precondition', $admin->post("/api/admin/bookings/{$b['id']}/status", ['status' => 'completed'])['json']['error']['code']);
    }

    public function testOwnershipAndAdminAuthorization(): void
    {
        $owner = $this->registerClient('own@example.test');
        $b = $this->book($owner, self::nextWeekday(1, 10), '11:00')['json']['booking'];
        $intruder = $this->registerClient('intruder@example.test');
        foreach ([['GET', "/api/bookings/{$b['id']}"], ['GET', "/api/bookings/{$b['id']}/invoice"], ['POST', "/api/bookings/{$b['id']}/cancel"], ['POST', "/api/bookings/{$b['id']}/reschedule"], ['POST', "/api/bookings/{$b['id']}/checkout"]] as [$m, $p]) {
            $r = $m === 'GET' ? $intruder->get($p) : $intruder->post($p, ['purpose' => 'deposit', 'date' => self::nextWeekday(2), 'time' => '09:00']);
            $this->assertSame(404, $r['status'], "$m $p must not reveal another customer's booking");
        }
        $this->assertSame([], $intruder->get('/api/me/bookings')['json']['bookings']);
        foreach (['/api/admin/bookings', '/api/admin/clients', '/api/admin/payments', '/api/admin/reports', '/api/admin/system'] as $p) {
            $this->assertSame(403, $intruder->get($p)['status'], $p);
            $this->assertSame(401, $this->client()->get($p)['status'], $p);
        }
        // CSRF / origin
        $this->assertSame(403, $owner->post("/api/bookings/{$b['id']}/cancel", [], [], false)['status']);
        $this->assertSame(403, $owner->post("/api/bookings/{$b['id']}/cancel", [], ['Origin' => 'https://evil.example'])['status']);
    }

    public function testAdminBookingEditsUseTheSameConflictEngine(): void
    {
        $admin = $this->adminClient();
        $date = self::nextWeekday(3, 12);
        $a = $admin->post('/api/admin/bookings', $this->adminBody($date, '09:00', ['contact' => ['email' => 'walkin@example.test', 'name' => 'Walk In'], 'totalPrice' => 200, 'durationMinutes' => 120]))['json']['booking'];
        $this->assertSame(200.0, $a['totalPrice']);
        $this->assertSame(200.0, round(array_sum(array_column($a['lineItems'], 'amount')), 2), 'price adjustment line keeps invoice consistent');
        $this->assertNull($a['userId']);
        $b = $admin->post('/api/admin/bookings', $this->adminBody($date, '12:00', ['contact' => ['email' => 'second@example.test'], 'durationMinutes' => 60]))['json']['booking'];
        // overlap on create
        $this->assertSame('already-exists', $admin->post('/api/admin/bookings', $this->adminBody($date, '10:00', ['durationMinutes' => 60]))['json']['error']['code']);
        // reschedule into a conflict (drag-drop path)
        $this->assertSame('already-exists', $admin->post("/api/admin/bookings/{$b['id']}/reschedule", ['date' => $date, 'time' => '10:30'])['json']['error']['code']);
        // duration change into a conflict
        $this->assertSame('already-exists', $admin->send('PATCH', "/api/admin/bookings/{$a['id']}", ['durationMinutes' => 240])['json']['error']['code']);
        // outside the admin window
        $this->assertSame('invalid-argument', $admin->post("/api/admin/bookings/{$b['id']}/reschedule", ['date' => $date, 'time' => '19:30'])['json']['error']['code']);
        // valid reschedule works and keeps end consistent
        $ok = $admin->post("/api/admin/bookings/{$b['id']}/reschedule", ['date' => $date, 'time' => '15:00', 'durationMinutes' => 90])['json']['booking'];
        $this->assertSame(90, $ok['durationMinutes']);

        // Manual payment, refund and void through the ledger
        $paid = $admin->post("/api/admin/bookings/{$a['id']}/payments", ['amount' => 50, 'method' => 'zelle', 'purpose' => 'deposit'])['json']['booking'];
        $this->assertSame('deposit_paid', $paid['paymentStatus']);
        $this->assertSame('invalid-argument', $admin->post("/api/admin/bookings/{$a['id']}/payments", ['amount' => 500, 'method' => 'cash'])['json']['error']['code'], 'cannot overpay');
        $pid = $paid['payments'][0]['id'];
        $ref = $admin->post("/api/admin/payments/{$pid}/refund", ['amount' => 20, 'reason' => 'Goodwill'])['json']['booking'];
        $this->assertSame(30.0, $ref['amountPaid']);
        $this->assertSame(20.0, $ref['amountRefunded']);
        $this->assertSame('invalid-argument', $admin->post("/api/admin/payments/{$pid}/refund", ['amount' => 31])['json']['error']['code']);
        $this->assertSame('failed-precondition', $admin->post("/api/admin/payments/{$pid}/void", [])['json']['error']['code'], 'refunds must be voided first');
        $refundId = $ref['payments'][1]['id'];
        $admin->post("/api/admin/payments/{$refundId}/void", []);
        $void = $admin->post("/api/admin/payments/{$pid}/void", [])['json']['booking'];
        $this->assertSame(['voided', 'voided'], array_column($void['payments'], 'status'));
        $this->assertSame(0.0, $void['amountPaid']);
        $this->assertSame('unpaid', $void['paymentStatus']);

        // Walk-in registers later: bookings attach after email verification only
        $walk = $this->registerClient('walkin@example.test');
        $this->assertSame([], $walk->get('/api/me/bookings')['json']['bookings'], 'unverified accounts cannot claim email-matched bookings');
        $verify = array_values(array_filter($this->outbox(), static fn ($m) => $m['kind'] === 'email_verify' && $m['to_email'] === 'walkin@example.test'));
        preg_match('/token=([A-Za-z0-9_-]+)/', (string) $verify[0]['text_body'], $m);
        $this->assertSame(200, $walk->post('/api/auth/verify', ['token' => $m[1]])['status']);
        $this->assertSame([$a['id']], array_column($walk->get('/api/me/bookings')['json']['bookings'], 'id'));
    }

    public function testStripeRefundAndDashboardRefundSync(): void
    {
        $c = $this->registerClient('refund@example.test');
        $b = $this->book($c, self::nextWeekday(4, 12), '09:00')['json']['booking'];
        $sid = $this->lastSessionId();
        $this->webhook($this->paySession($sid, null, 'pi_refundme'));
        $admin = $this->adminClient();
        $detail = $admin->get("/api/admin/bookings/{$b['id']}")['json']['booking'];
        $pid = $detail['payments'][0]['id'];
        $r = $admin->post("/api/admin/payments/{$pid}/refund", ['amount' => 50, 'reason' => 'Cancelled by us']);
        $this->assertSame(200, $r['status'], $r['body']);
        $this->assertSame('refunded', $r['json']['booking']['paymentStatus']);
        $refundReq = array_values(array_filter($this->stripeState()['requests'], static fn ($q) => $q['path'] === '/v1/refunds'));
        $this->assertSame('5000', $refundReq[0]['form']['amount']);
        $this->assertContains('refund_issued', $this->emailKinds('refund@example.test'));
        // A charge.refunded webhook for the same refund doesn't double count
        $rid = array_key_first($this->stripeState()['refunds']);
        $evt = $this->signedWebhook(['id' => 'evt_ref', 'type' => 'charge.refunded', 'livemode' => false, 'data' => ['object' => ['payment_intent' => 'pi_refundme', 'refunds' => ['data' => [['id' => $rid, 'status' => 'succeeded', 'amount' => 5000]]]]]]);
        $this->assertSame(200, $this->webhook($evt)['status']);
        $this->assertSame(50.0, $admin->get("/api/admin/bookings/{$b['id']}")['json']['booking']['amountRefunded']);
    }

    public function testStripeOutageDoesNotLeaveAHeldSlot(): void
    {
        $c = $this->registerClient('outage@example.test');
        $date = self::nextWeekday(5, 12);
        $this->failNextStripeCall();
        $r = $this->book($c, $date, '11:00');
        $this->assertSame('unavailable', $r['json']['error']['code']);
        $this->assertTrue(array_column($c->get("/api/availability?date={$date}&durationMinutes=150")['json']['slots'], 'available', 'time')['11:00'], 'slot released');
    }

    public function testJobsRemindersCompletionReviewsAndReports(): void
    {
        $admin = $this->adminClient();
        $now = static::$app->clock->now();
        // Booking ~30h out gets the 48h reminder once, then the 24h reminder
        $start = static::$app->clock->toBusiness($now->modify('+30 hours'));
        $b = $admin->post('/api/admin/bookings', $this->adminBody($start->format('Y-m-d'), '07:00', ['contact' => ['email' => 'remind@example.test']]));
        $ref = $b['json']['booking']['id'] ?? null;
        $this->assertNotNull($ref, $b['body']);
        static::$app->db->run('UPDATE bookings SET start_at = ?, end_at = ?, confirmed_at = ? WHERE ref = ?', [Clock::toSql($now->modify('+30 hours')), Clock::toSql($now->modify('+32 hours')), Clock::toSql($now->modify('-1 day')), $ref]);
        static::$app->jobs->run('reminders');
        static::$app->jobs->run('reminders');
        $this->assertSame(1, count(array_keys($this->emailKinds('remind@example.test'), 'reminder_48h')));
        static::$app->db->run('UPDATE bookings SET start_at = ?, end_at = ? WHERE ref = ?', [Clock::toSql($now->modify('+20 hours')), Clock::toSql($now->modify('+22 hours')), $ref]);
        static::$app->db->run("UPDATE job_runs SET lock_token = NULL");
        static::$app->jobs->run('reminders');
        $this->assertSame(1, count(array_keys($this->emailKinds('remind@example.test'), 'reminder_24h')));

        // Auto-complete after the visit; review flow
        $c = $this->registerClient('review@example.test', 'correct-horse-1', 'Rita Reviewer');
        $bk = $this->book($c, self::nextWeekday(2, 14), '09:00')['json']['booking'];
        $this->webhook($this->paySession($this->lastSessionId()));
        $this->assertSame('failed-precondition', $c->post("/api/bookings/{$bk['id']}/review", ['rating' => 5, 'comment' => 'Great work!'])['json']['error']['code']);
        static::$app->db->run('UPDATE bookings SET start_at = ?, end_at = ? WHERE ref = ?', [Clock::toSql($now->modify('-6 hours')), Clock::toSql($now->modify('-4 hours')), $bk['id']]);
        $this->assertSame(1, static::$app->jobs->run('auto-complete')['result']['completed']);
        $this->assertContains('booking_completed', $this->emailKinds('review@example.test'));
        $rv = $c->post("/api/bookings/{$bk['id']}/review", ['rating' => 5, 'comment' => 'Great work!', 'displayMode' => 'firstInitialLastName']);
        $this->assertSame(200, $rv['status'], $rv['body']);
        $this->assertSame('already-exists', $c->post("/api/bookings/{$bk['id']}/review", ['rating' => 4, 'comment' => 'Again!'])['json']['error']['code']);
        $pending = $admin->get('/api/admin/reviews?status=pending')['json']['reviews'];
        $this->assertSame('R. Reviewer', $pending[0]['displayName']);
        $admin->post('/api/admin/reviews/' . $pending[0]['id'] . '/approve', []);
        $this->assertSame('R. Reviewer', $this->client()->get('/api/reviews')['json']['reviews'][0]['displayName']);

        // Reports from the ledger
        $rep = $admin->get('/api/admin/reports?from=' . static::$app->clock->toBusiness($now->modify('-30 days'))->format('Y-m-d') . '&to=' . static::$app->clock->toBusiness($now->modify('+30 days'))->format('Y-m-d'));
        $this->assertSame(200, $rep['status'], $rep['body']);
        $this->assertSame(50.0, $rep['json']['collected']);
        $pay = $admin->get('/api/admin/payments')['json'];
        $this->assertSame(50.0, $pay['totals']['collected']);
        $this->assertSame(1.8, $pay['totals']['fees']);

        // Email delivery job (log transport) + system view
        $sent = static::$app->jobs->run('send-email');
        $this->assertSame('ok', $sent['status']);
        $sys = $admin->get('/api/admin/system')['json'];
        $this->assertSame(0, $sys['email']['queued']);
        $this->assertTrue($sys['stripe']['configured']);
    }
}

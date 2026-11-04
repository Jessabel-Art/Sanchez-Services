<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

use SanchezServices\Migration\FirestoreImporter;
use SanchezServices\Migration\ImportValidator;

/** Firestore export -> MySQL import, then the imported data used through the real API. */
final class ImportTest extends IntegrationTestCase
{
    private string $dir;
    private string $date;

    protected function setUp(): void
    {
        parent::setUp();
        $this->dir = sys_get_temp_dir() . '/ss-export-' . bin2hex(random_bytes(4));
        mkdir($this->dir, 0700, true);
        $this->date = self::futureWeekday(12);
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->dir . '/*') ?: []);
        @rmdir($this->dir);
        parent::tearDown();
    }

    private static function ts(string $iso): array
    {
        return ['__ts' => $iso];
    }

    private function writeExport(array $collections, array $authUsers): void
    {
        $manifest = ['projectId' => 'demo', 'collections' => []];
        foreach ($collections as $name => $docs) {
            $file = $name === 'profiles/*/addresses' ? 'profiles__addresses' : $name;
            $lines = '';
            foreach ($docs as $path => $data) {
                $parts = explode('/', $path);
                $lines .= json_encode(['path' => $path, 'id' => end($parts), 'parent' => count($parts) > 2 ? implode('/', array_slice($parts, 0, -2)) : null, 'data' => $data]) . "\n";
            }
            file_put_contents("{$this->dir}/{$file}.ndjson", $lines);
            $manifest['collections'][$name] = ['count' => count($docs), 'sha256' => hash('sha256', $lines)];
        }
        file_put_contents("{$this->dir}/manifest.json", json_encode($manifest));
        file_put_contents("{$this->dir}/auth-users.json", json_encode(['users' => $authUsers]));
    }

    private function standardExport(): void
    {
        $start = self::localIso($this->date, '09:00');
        $end = self::localIso($this->date, '12:00');
        $this->writeExport([
            'profiles' => [
                'profiles/uidAna' => ['name' => 'Ana Client', 'email' => 'ana@example.test', 'phone' => '+1 (401) 555-0101', 'preferences' => ['fragrancePreference' => 'unscented']],
                'profiles/uidOwner' => ['name' => 'Owner', 'email' => 'owner@example.test', 'role' => 'owner'],
                'profiles/uidDup' => ['name' => 'Dup', 'email' => 'ANA@example.test'],
            ],
            'profiles/*/addresses' => [
                'profiles/uidAna/addresses/a1' => ['street' => '5 Oak St', 'city' => 'Cranston', 'state' => 'RI', 'zip' => '02920', 'isDefault' => true],
                'profiles/uidAna/addresses/bad' => ['street' => '', 'city' => 'X'],
            ],
            'admins' => ['admins/uidOwner' => ['active' => true]],
            'bookings' => [
                // Future confirmed booking: Stripe deposit + Zelle balance -> paid in full.
                'bookings/uidAna_req1' => [
                    'userId' => 'uidAna', 'contact' => ['name' => 'Ana Client', 'email' => 'ana@example.test', 'phone' => '4015550101'],
                    'address' => ['line1' => '5 Oak St', 'city' => 'Cranston', 'state' => 'RI', 'zip' => '02920'],
                    'serviceSlug' => 'deep-clean', 'serviceName' => 'Deep Clean', 'startAt' => self::ts($start), 'endAt' => self::ts($end),
                    'dateKey' => $this->date, 'durationMinutes' => 180, 'totalPrice' => 210.5, 'depositAmount' => 50, 'depositPaid' => true,
                    'paidAmount' => 210.5, 'depositPaymentIntentId' => 'pi_import_1', 'depositStripeNetAmount' => 50, 'depositStripeFeeAmount' => 1.8,
                    'depositStripeGrossAmount' => 51.8, 'balancePaymentMethod' => 'zelle', 'status' => 'confirmed', 'createdAt' => self::ts('2026-06-01T15:00:00Z'),
                ],
                // Past completed card booking with a partial refund; legacy dateKey off by one (old UTC bug).
                'bookings/legacy2' => [
                    'contact' => ['name' => 'Walk In', 'email' => 'Walkin@Example.test'], 'service' => 'Residential Cleaning',
                    'address' => '9 Pine Rd', 'startAt' => self::ts('2025-12-11T23:30:00Z'), 'dateKey' => '2025-12-12', 'amount' => 120,
                    'paidAmount' => 120, 'balancePaymentIntentId' => 'pi_import_2', 'refundedAmount' => 20, 'status' => 'completed',
                    'createdAt' => self::ts('2025-12-01T10:00:00Z'),
                ],
                // Cancelled, unpaid; American spelling.
                'bookings/legacy3' => ['contact' => ['name' => 'C', 'email' => 'c@example.test'], 'startAt' => self::ts('2026-01-05T15:00:00Z'), 'totalPrice' => 90, 'status' => 'canceled'],
                // No date at all: skipped.
                'bookings/nodate' => ['contact' => ['name' => 'N', 'email' => 'n@example.test'], 'status' => 'pending'],
            ],
            'blackouts' => [
                'blackouts/single' => ['allDay' => true, 'startDateKey' => '2026-12-24', 'endDateKey' => '2026-12-24', 'reason' => 'Eve'],
                'blackouts/range' => ['allDay' => true, 'startDateKey' => '2026-12-25', 'endDateKey' => '2026-12-27', 'reason' => 'Holiday'],
                'blackouts/timed' => ['allDay' => false, 'startAt' => self::ts('2026-12-30T14:00:00Z'), 'endAt' => self::ts('2026-12-30T17:00:00Z')],
            ],
            'reviews' => [
                'reviews/r1' => ['clientId' => 'uidAna', 'bookingId' => 'legacy2', 'rating' => 5, 'comment' => 'Great', 'status' => 'approved', 'reviewDisplayName' => 'A.C.'],
            ],
            'availability' => ['availability/x' => ['dayCount' => 1]],
        ], [
            ['localId' => 'uidAna', 'email' => 'ana@example.test', 'emailVerified' => true, 'passwordHash' => 'aGFzaA==', 'salt' => 'c2FsdA==', 'providerUserInfo' => [['providerId' => 'password']], 'createdAt' => '1764601200000'],
            ['localId' => 'uidOwner', 'email' => 'owner@example.test', 'emailVerified' => true, 'providerUserInfo' => [['providerId' => 'google.com']], 'createdAt' => '1761998400000'],
            ['localId' => 'uidPhone', 'phoneNumber' => '+14015550199', 'providerUserInfo' => [['providerId' => 'phone']]],
        ]);
    }

    private function import(bool $apply, array $opts = []): array
    {
        return (new FirestoreImporter(static::$app, $this->dir, $opts))->run($apply);
    }

    public function testDryRunLeavesDatabaseEmptyAndApplyImportsEverything(): void
    {
        $this->standardExport();
        $dry = $this->import(false);
        $this->assertSame('dry-run', $dry['mode']);
        $this->assertSame(3, $dry['imported']['bookings']);
        $this->assertSame(0, (int) static::$app->db->scalar('SELECT COUNT(*) FROM bookings'));
        $this->assertSame(0, (int) static::$app->db->scalar('SELECT COUNT(*) FROM users'));

        $r = $this->import(true);
        $db = static::$app->db;
        $this->assertSame(['users' => 2, 'owners' => 1, 'admins' => 0, 'withLegacyHash' => 0, 'profiles' => 2], array_intersect_key($r['imported'], array_flip(['users', 'owners', 'admins', 'withLegacyHash', 'profiles'])));
        $this->assertSame(['uidPhone', 'uidDup'], array_column($r['skipped']['users'], 'id'));
        $this->assertSame('nodate', $r['skipped']['bookings'][0]['id']);
        $this->assertSame(1, $r['imported']['addresses'], 'incomplete address skipped');
        $this->assertSame('SS-2026-000001', $db->scalar("SELECT invoice_number FROM bookings WHERE ref = 'uidAna_req1'"), 'dry run did not consume invoice numbers');

        // Ledger reconstruction.
        $b1 = $db->one("SELECT * FROM bookings WHERE ref = 'uidAna_req1'");
        $this->assertSame(['210.50', 'paid', 'confirmed'], [$b1['amount_paid'], $b1['payment_status'], $b1['status']]);
        $p1 = $db->all('SELECT method, purpose, amount, fee, stripe_payment_intent_id FROM payments WHERE booking_id = ? ORDER BY id', [$b1['id']]);
        $this->assertSame([
            ['method' => 'card', 'purpose' => 'deposit', 'amount' => '50.00', 'fee' => '1.80', 'stripe_payment_intent_id' => 'pi_import_1'],
            ['method' => 'zelle', 'purpose' => 'balance', 'amount' => '160.50', 'fee' => '0.00', 'stripe_payment_intent_id' => null],
        ], $p1);
        $this->assertSame((int) $b1['user_id'], $this->userId('ana@example.test'));
        $this->assertNull($b1['reminder24_sent_at'], 'future booking still gets reminders');

        $b2 = $db->one("SELECT * FROM bookings WHERE ref = 'legacy2'");
        $this->assertSame('2025-12-11', $b2['business_date'], 'business date recomputed in America/New_York');
        $this->assertSame(['100.00', '20.00', 'deposit_paid', 'completed'], [$b2['amount_paid'], $b2['amount_refunded'], $b2['payment_status'], $b2['status']]);
        $this->assertNotNull($b2['reminder24_sent_at'], 'past bookings never trigger reminders');
        $this->assertStringContainsString('incomplete address', (string) $b2['needs_attention']);
        $this->assertSame('cancelled', $db->scalar("SELECT status FROM bookings WHERE ref = 'legacy3'"));
        $this->assertNotEmpty(array_filter($r['warnings'], static fn ($w) => $w['id'] === 'legacy2' && str_contains($w['message'], 'dateKey')));

        // Blackouts: single day and exclusive range conventions.
        $bo = $db->all('SELECT legacy_ref, all_day, start_date, end_date_exclusive FROM blackouts ORDER BY id');
        $this->assertSame(['2026-12-24', '2026-12-25', '2026-12-25'], [$bo[0]['start_date'], $bo[0]['end_date_exclusive'], $bo[1]['start_date']]);
        $this->assertSame('2026-12-27', $bo[1]['end_date_exclusive']);
        $this->assertSame('0', (string) $bo[2]['all_day']);
        // Review linked to its booking.
        $this->assertSame((int) $b2['id'], (int) $db->scalar("SELECT booking_id FROM reviews WHERE legacy_ref = 'r1'"));

        $v = (new ImportValidator(static::$app, $this->dir))->run();
        $this->assertTrue($v['ok'], json_encode($v['errors']));
        $this->assertSame(3, $v['counts']['importedBookings']);

        // A second run is refused.
        $this->expectExceptionMessage('already contains');
        $this->import(true);
    }

    public function testTamperedExportIsRejected(): void
    {
        $this->standardExport();
        file_put_contents("{$this->dir}/bookings.ndjson", "\n", FILE_APPEND);
        $this->expectExceptionMessage('Checksum mismatch');
        $this->import(false);
    }

    public function testImportedBookingBlocksItsSlotAndAccountsWorkAfterReset(): void
    {
        $this->standardExport();
        $this->import(true);

        $day = $this->client()->get("/api/availability?date={$this->date}&durationMinutes=150")['json'];
        $nine = array_values(array_filter($day['slots'], static fn ($s) => $s['time'] === '09:00'))[0];
        $this->assertFalse($nine['available'], 'imported confirmed booking occupies 09:00');

        $other = $this->registerClient('newbie@example.test');
        $r = $other->post('/api/bookings', [
            'requestId' => 'req_' . bin2hex(random_bytes(8)), 'serviceSlug' => 'residential-cleaning', 'bedrooms' => 2, 'bathrooms' => 1,
            'date' => $this->date, 'time' => '11:00',
            'contact' => ['name' => 'New', 'email' => 'newbie@example.test', 'phone' => '4015550000'],
            'address' => ['line1' => '1 A St', 'city' => 'Providence', 'state' => 'RI', 'zip' => '02903'],
        ]);
        $this->assertSame('already-exists', $r['json']['error']['code'] ?? null, '11:00 overlaps the imported 09:00–12:00 booking');

        // Imported users have no native password: login asks for a reset, reset works, data is visible.
        $ana = $this->client();
        $this->assertSame('auth/password-reset-required', $ana->post('/api/auth/login', ['email' => 'ana@example.test', 'password' => 'whatever-1'])['json']['error']['code']);
        $this->assertSame(200, $ana->post('/api/auth/password/forgot', ['email' => 'ana@example.test'])['status']);
        $mail = static::$app->db->one("SELECT text_body FROM email_outbox WHERE kind = 'password_reset' ORDER BY id DESC LIMIT 1");
        $this->assertNotNull($mail);
        $this->assertSame(1, preg_match('/token=([A-Za-z0-9_\-%]+)/', $mail['text_body'], $m));
        $reset = $ana->post('/api/auth/password/reset', ['token' => rawurldecode($m[1]), 'password' => 'brand-new-pass-1']);
        $this->assertSame(200, $reset['status'], $reset['body']);
        $mine = $ana->get('/api/me/bookings')['json']['bookings'];
        $this->assertSame(['uidAna_req1'], array_column($mine, 'id'));
        $this->assertSame(0.0, (float) $mine[0]['balanceDue']);

        // The owner (Google-only before) gets admin access after setting a password.
        $owner = $this->client();
        $owner->post('/api/auth/password/forgot', ['email' => 'owner@example.test']);
        $mail = static::$app->db->one("SELECT text_body FROM email_outbox WHERE kind = 'password_reset' AND to_email = 'owner@example.test' ORDER BY id DESC LIMIT 1");
        preg_match('/token=([A-Za-z0-9_\-%]+)/', $mail['text_body'], $m);
        $this->assertSame(200, $owner->post('/api/auth/password/reset', ['token' => rawurldecode($m[1]), 'password' => 'owner-pass-12'])['status']);
        $list = $owner->get('/api/admin/bookings?all=1');
        $this->assertSame(200, $list['status']);
        $this->assertCount(3, $list['json']['bookings']);
    }

    public function testLegacyFirebasePasswordWorksOnlyWhenOptedIn(): void
    {
        $salt = random_bytes(16);
        $hash = \SanchezServices\Migration\FirebaseScrypt::hash('old-firebase-pw', $salt, str_repeat('k', 32), base64_decode('Bw=='), 8, 4);
        $this->writeExport(['profiles' => ['profiles/u1' => ['email' => 'legacy@example.test', 'role' => 'owner']]], [
            ['localId' => 'u1', 'email' => 'legacy@example.test', 'emailVerified' => true, 'passwordHash' => base64_encode($hash), 'salt' => base64_encode($salt), 'providerUserInfo' => [['providerId' => 'password']]],
        ]);
        $this->import(true, ['withLegacyPasswordHashes' => true]);
        $c = $this->client();
        $this->assertSame('auth/invalid-credential', $c->post('/api/auth/login', ['email' => 'legacy@example.test', 'password' => 'wrong-pw-1'])['json']['error']['code']);
        $ok = $c->post('/api/auth/login', ['email' => 'legacy@example.test', 'password' => 'old-firebase-pw']);
        $this->assertSame(200, $ok['status'], $ok['body']);
        $row = static::$app->users->rowByEmail('legacy@example.test');
        $this->assertNotNull($row['password_hash'], 'upgraded to a native hash');
        $this->assertNull($row['legacy_password_hash']);
        $this->assertSame(200, $this->client()->post('/api/auth/login', ['email' => 'legacy@example.test', 'password' => 'old-firebase-pw'])['status']);
    }

    public function testAssumeCompletedPaidOption(): void
    {
        $this->writeExport(['bookings' => [
            'bookings/c1' => ['contact' => ['name' => 'X', 'email' => 'x@example.test'], 'startAt' => self::ts('2025-10-01T14:00:00Z'), 'amount' => 120, 'status' => 'completed', 'paymentMethod' => 'cash'],
        ], 'profiles' => ['profiles/o' => ['email' => 'o@example.test', 'role' => 'owner']]], []);
        $this->import(true, ['assumeCompletedPaid' => true]);
        $this->assertSame(['120.00', 'paid'], array_values(static::$app->db->one("SELECT amount_paid, payment_status FROM bookings WHERE ref = 'c1'")));
        $this->assertSame('cash', static::$app->db->scalar('SELECT method FROM payments'));
    }
}

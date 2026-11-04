<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

use SanchezServices\Migration\FirestoreImporter;
use SanchezServices\Migration\ImportValidator;

/**
 * Rehearsal on a real export produced by tools/migration/export-firestore.cjs from the Firestore
 * emulator seeded by tools/migration/seed-emulator-sample.cjs (synthetic data only).
 */
final class MigrationImportTest extends IntegrationTestCase
{
    private const DIR = __DIR__ . '/../fixtures/sample-export';

    public function testDryRunWritesNothingThenApplyIsIdempotentAndValidates(): void
    {
        $dry = (new FirestoreImporter(static::$app, self::DIR))->run(false);
        $this->assertSame('dry-run', $dry['mode']);
        $this->assertSame(0, (int) static::$app->db->scalar('SELECT COUNT(*) FROM bookings'));
        $this->assertSame(0, (int) static::$app->db->scalar('SELECT COUNT(*) FROM users'));

        $r = (new FirestoreImporter(static::$app, self::DIR))->run(true);
        $this->assertSame(2, $r['imported']['bookings']);
        $this->assertSame(2, $r['imported']['authUsers']);
        $this->assertFalse($r['passwordHashesImported']);
        $this->assertNull(static::$app->db->scalar('SELECT legacy_password_hash FROM users WHERE uid = ?', ['UIDclient000000000000000001']));
        $this->assertTrue((bool) array_filter($r['needsReview'], static fn ($m) => str_contains($m, 'Google sign-in')));
        $this->assertTrue((bool) array_filter($r['needsReview'], static fn ($m) => str_contains($m, 'stored dateKey 2026-12-12')));

        (new FirestoreImporter(static::$app, self::DIR))->run(true); // re-run is safe
        $this->assertSame(2, (int) static::$app->db->scalar('SELECT COUNT(*) FROM bookings'));
        $this->assertSame(1, (int) static::$app->db->scalar('SELECT COUNT(*) FROM payments'));

        $v = (new ImportValidator(static::$app, self::DIR))->run();
        $this->assertTrue($v['ok'], json_encode($v['failures']));
        $this->assertSame(210.5, $v['money']['mysql']['totalPrice']);
        $this->assertSame('owner', static::$app->db->scalar('SELECT role FROM users WHERE uid = ?', ['UIDowner0000000000000000001']));

        // Legacy booking stays reachable by contact email once that customer registers
        $c = $this->registerClient('walkin@example.test');
        $q = $c->post('/api/db/query', ['collection' => 'bookings', 'where' => [['contact.emailLower', '==', 'walkin@example.test']]]);
        $this->assertSame([], $q['json']['docs'], 'legacy doc has contact.email but no contact.emailLower — same as Firestore rules (no access)');
        // Imported users must reset before signing in
        $this->assertSame('auth/password-reset-required', $this->client()->post('/api/auth/login', ['email' => 'ana@example.test', 'password' => 'x'])['json']['error']['code']);
    }

    public function testTamperedExportIsRejected(): void
    {
        $tmp = sys_get_temp_dir() . '/ss-tamper-' . getmypid();
        @mkdir($tmp);
        foreach (glob(self::DIR . '/*') as $f) {
            copy($f, $tmp . '/' . basename($f));
        }
        file_put_contents($tmp . '/bookings.ndjson', "\n", FILE_APPEND);
        $this->expectExceptionMessage('Checksum mismatch for bookings');
        (new FirestoreImporter(static::$app, $tmp))->run(true);
    }
}

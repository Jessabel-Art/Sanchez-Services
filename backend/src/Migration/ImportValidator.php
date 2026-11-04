<?php
declare(strict_types=1);

namespace SanchezServices\Migration;

use SanchezServices\App;
use SanchezServices\Store\Doc;

/**
 * Verifies an import against the export: record counts, relationships, money totals and exact
 * timestamp equality per booking. Returns failures (block cutover) and warnings (review).
 */
final class ImportValidator
{
    public function __construct(private App $app, private string $dir)
    {
    }

    public function run(): array
    {
        $manifest = json_decode((string) file_get_contents($this->dir . '/manifest.json'), true, 512, JSON_THROW_ON_ERROR);
        $failures = [];
        $warnings = [];
        $db = $this->app->db;

        // ---- counts
        $counts = [];
        $tableFor = ['bookings' => 'bookings', 'profiles' => 'profiles', 'profiles/*/addresses' => 'addresses', 'blackouts' => 'blackouts', 'reviews' => 'reviews'];
        foreach ($tableFor as $col => $table) {
            $expected = (int) ($manifest['collections'][$col]['count'] ?? 0);
            $ids = [];
            foreach ($this->rows($col) as $r) {
                $ids[] = [$r['id'], $col === 'profiles/*/addresses' ? (explode('/', (string) $r['parent'])[1] ?? '') : null];
            }
            $found = 0;
            foreach ($ids as [$id, $owner]) {
                $sql = "SELECT COUNT(*) FROM {$table} WHERE doc_id = ?" . ($owner !== null ? ' AND owner_uid = ?' : '');
                $found += (int) $db->scalar($sql, $owner !== null ? [$id, $owner] : [$id]);
            }
            $counts[$col] = ['export' => $expected, 'matchedInDb' => $found, 'dbTotal' => (int) $db->scalar("SELECT COUNT(*) FROM {$table}")];
            if ($found !== $expected) {
                $failures[] = "{$col}: {$expected} exported but only {$found} found in MySQL";
            }
        }
        $authFile = $this->dir . '/auth-users.json';
        if (is_file($authFile)) {
            $users = json_decode((string) file_get_contents($authFile), true)['users'] ?? [];
            $withEmail = array_filter($users, static fn ($u) => trim((string) ($u['email'] ?? '')) !== '');
            $found = 0;
            foreach ($withEmail as $u) {
                $found += (int) $db->scalar('SELECT COUNT(*) FROM users WHERE uid = ?', [(string) $u['localId']]);
            }
            $counts['authUsers'] = ['export' => count($users), 'withEmail' => count($withEmail), 'matchedInDb' => $found];
            if ($found !== count($withEmail)) {
                $failures[] = 'auth users: ' . count($withEmail) . " with email exported but {$found} found";
            }
        }

        // ---- per-document equality, money and time
        $moneyExport = ['totalPrice' => 0.0, 'paidAmount' => 0.0, 'remainingDue' => 0.0];
        $moneyDb = $moneyExport;
        $mismatchedDocs = 0;
        foreach ($this->rows('bookings') as $r) {
            $dbDoc = $this->app->store->get('bookings', (string) $r['id']);
            if ($dbDoc === null) {
                continue;
            }
            if (Doc::encode(self::canon($r['data'])) !== Doc::encode(self::canon($dbDoc))) {
                $mismatchedDocs++;
                if ($mismatchedDocs <= 10) {
                    $failures[] = "booking {$r['id']}: stored document differs from export";
                }
            }
            foreach (['startAt', 'endAt', 'scheduledAt', 'createdAt'] as $f) {
                $a = Doc::toDate($r['data'][$f] ?? null);
                $b = Doc::toDate($dbDoc[$f] ?? null);
                if (($a?->format('Uv')) !== ($b?->format('Uv'))) {
                    $failures[] = "booking {$r['id']}: {$f} differs";
                }
            }
            foreach (array_keys($moneyExport) as $k) {
                $moneyExport[$k] += is_numeric($r['data'][$k] ?? null) ? (float) $r['data'][$k] : 0.0;
                $moneyDb[$k] += is_numeric($dbDoc[$k] ?? null) ? (float) $dbDoc[$k] : 0.0;
            }
        }
        foreach ($moneyExport as $k => $v) {
            if (abs($v - $moneyDb[$k]) > 0.005) {
                $failures[] = sprintf('sum(%s): export %.2f vs MySQL %.2f', $k, $v, $moneyDb[$k]);
            }
        }

        // ---- relationships
        $orphanAddresses = (int) $db->scalar('SELECT COUNT(*) FROM addresses a LEFT JOIN users u ON u.uid = a.owner_uid WHERE u.id IS NULL');
        if ($orphanAddresses) {
            $warnings[] = "{$orphanAddresses} saved address(es) belong to a profile with no login account";
        }
        $bookingsNoUser = (int) $db->scalar('SELECT COUNT(*) FROM bookings b LEFT JOIN users u ON u.uid = b.user_uid WHERE b.user_uid IS NOT NULL AND u.id IS NULL');
        if ($bookingsNoUser) {
            $warnings[] = "{$bookingsNoUser} booking(s) reference a userId with no login account (still reachable by contact email)";
        }
        $bookingsNoOwner = (int) $db->scalar('SELECT COUNT(*) FROM bookings WHERE user_uid IS NULL AND contact_email_lower IS NULL');
        if ($bookingsNoOwner) {
            $warnings[] = "{$bookingsNoOwner} booking(s) have neither userId nor contact email (admin-only visibility)";
        }
        $reviewsNoBooking = (int) $db->scalar('SELECT COUNT(*) FROM reviews r LEFT JOIN bookings b ON b.doc_id = r.booking_doc_id WHERE r.booking_doc_id IS NOT NULL AND b.id IS NULL');
        if ($reviewsNoBooking) {
            $warnings[] = "{$reviewsNoBooking} review(s) reference a missing booking";
        }
        $ledgerNoBooking = (int) $db->scalar('SELECT COUNT(*) FROM payments p LEFT JOIN bookings b ON b.doc_id = p.booking_doc_id WHERE b.id IS NULL');
        if ($ledgerNoBooking) {
            $failures[] = "{$ledgerNoBooking} payment ledger row(s) reference a missing booking";
        }
        $admins = (int) $db->scalar("SELECT COUNT(*) FROM users WHERE role IN ('admin','owner') AND is_active = 1");
        if ($admins === 0) {
            $failures[] = 'no active admin/owner account after import — the admin dashboard would be inaccessible';
        }

        return [
            'ok' => !$failures,
            'counts' => $counts,
            'money' => ['export' => $moneyExport, 'mysql' => $moneyDb],
            'admins' => $admins,
            'ledgerRows' => (int) $db->scalar('SELECT COUNT(*) FROM payments'),
            'failures' => $failures,
            'warnings' => $warnings,
        ];
    }

    /** Canonical form for comparison (key order + timestamp normalization). */
    private static function canon(mixed $v): mixed
    {
        if (Doc::isTs($v)) {
            $d = Doc::toDate($v);
            return $d ? ['__ts' => $d->format('Uv')] : null;
        }
        if (is_array($v)) {
            if (!array_is_list($v)) {
                ksort($v);
            }
            return array_map([self::class, 'canon'], $v);
        }
        if (is_int($v) || is_float($v)) {
            return (float) $v;
        }
        return $v;
    }

    private function rows(string $name): \Generator
    {
        $file = $this->dir . '/' . ($name === 'profiles/*/addresses' ? 'profiles__addresses' : $name) . '.ndjson';
        $fh = fopen($file, 'rb');
        while ($fh && ($line = fgets($fh)) !== false) {
            if (trim($line) !== '') {
                yield json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            }
        }
        if ($fh) {
            fclose($fh);
        }
    }
}

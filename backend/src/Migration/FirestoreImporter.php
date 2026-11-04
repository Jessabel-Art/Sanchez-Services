<?php
declare(strict_types=1);

namespace SanchezServices\Migration;

use SanchezServices\App;
use SanchezServices\Clock;
use SanchezServices\Store\Doc;

/**
 * Imports an export produced by tools/migration/export-firestore.cjs (+ `firebase auth:export`).
 *
 * Idempotent: every record is upserted by its Firestore document id / Firebase UID, so the import
 * can be re-run (e.g. a rehearsal followed by the final cutover import).
 *
 * Decisions that need the owner's approval are behind explicit options (all OFF by default):
 *   - withLegacyPasswordHashes: store Firebase scrypt hashes for a future compatibility login path.
 */
final class FirestoreImporter
{
    /** Collections imported into tables. Others are counted and reported only. */
    public const IMPORTED = ['profiles', 'profiles/*/addresses', 'bookings', 'blackouts', 'reviews', 'admins'];

    private array $report = [];

    public function __construct(private App $app, private string $dir, private array $options = [])
    {
    }

    /** @return array<string,mixed> report */
    public function run(bool $apply): array
    {
        $manifestFile = $this->dir . '/manifest.json';
        if (!is_file($manifestFile)) {
            throw new \RuntimeException("manifest.json not found in {$this->dir}");
        }
        $manifest = json_decode((string) file_get_contents($manifestFile), true, 512, JSON_THROW_ON_ERROR);
        $this->report = [
            'mode' => $apply ? 'apply' : 'dry-run',
            'exportProject' => $manifest['projectId'] ?? null,
            'exportedAt' => $manifest['exportedAt'] ?? null,
            'checksums' => [],
            'imported' => [],
            'notImported' => [],
            'warnings' => [],
            'needsReview' => [],
        ];
        foreach (($manifest['collections'] ?? []) as $name => $meta) {
            $file = $this->fileFor($name);
            if (!is_file($file)) {
                throw new \RuntimeException("Missing export file for {$name}");
            }
            $actual = hash_file('sha256', $file);
            $this->report['checksums'][$name] = $actual === ($meta['sha256'] ?? null) ? 'ok' : 'MISMATCH';
            if ($actual !== ($meta['sha256'] ?? null)) {
                throw new \RuntimeException("Checksum mismatch for {$name}; export files were modified.");
            }
        }

        $db = $this->app->db;
        $db->pdo()->beginTransaction();
        try {
            $this->importUsers();
            $this->importAdmins();
            $this->importCollection('profiles', fn (array $r) => $this->app->store->put('profiles', $r['id'], $r['data']));
            $this->importCollection('profiles/*/addresses', function (array $r) {
                $owner = explode('/', (string) $r['parent'])[1] ?? '';
                if ($owner === '') {
                    $this->report['warnings'][] = "address {$r['path']} has no owner; skipped";
                    return false;
                }
                $this->app->store->put('addresses', $r['id'], $r['data'], $owner);
                return true;
            });
            $this->importCollection('blackouts', fn (array $r) => $this->app->store->put('blackouts', $r['id'], $r['data']));
            $this->importCollection('reviews', fn (array $r) => $this->app->store->put('reviews', $r['id'], $r['data']));
            $this->importCollection('bookings', fn (array $r) => $this->importBooking($r));
            foreach (array_keys($manifest['collections'] ?? []) as $name) {
                if (!in_array($name, self::IMPORTED, true)) {
                    $count = (int) ($manifest['collections'][$name]['count'] ?? 0);
                    $this->report['notImported'][$name] = $count;
                    if ($count > 0 && in_array($name, ['payments', 'reports', 'services', 'addresses'], true)) {
                        $this->report['needsReview'][] = "{$name}: {$count} document(s) exist but no current code uses this collection — confirm they can be archived (kept in the export files) rather than imported.";
                    }
                }
            }
            if (!empty($manifest['unknownCollections'])) {
                $this->report['needsReview'][] = 'Unknown collections were present in Firestore and were not exported: ' . implode(', ', $manifest['unknownCollections']);
            }
            if ($apply) {
                $db->pdo()->commit();
            } else {
                $db->pdo()->rollBack();
            }
        } catch (\Throwable $e) {
            if ($db->pdo()->inTransaction()) {
                $db->pdo()->rollBack();
            }
            throw $e;
        }
        return $this->report;
    }

    private function fileFor(string $name): string
    {
        return $this->dir . '/' . ($name === 'profiles/*/addresses' ? 'profiles__addresses' : $name) . '.ndjson';
    }

    /** @return \Generator<array<string,mixed>> */
    private function rows(string $name): \Generator
    {
        $fh = fopen($this->fileFor($name), 'rb');
        if (!$fh) {
            throw new \RuntimeException("Cannot read {$name}");
        }
        while (($line = fgets($fh)) !== false) {
            if (trim($line) === '') {
                continue;
            }
            yield json_decode($line, true, 512, JSON_THROW_ON_ERROR);
        }
        fclose($fh);
    }

    private function importCollection(string $name, callable $fn): void
    {
        $n = 0;
        foreach ($this->rows($name) as $r) {
            if ($fn($r) !== false) {
                $n++;
            }
        }
        $this->report['imported'][$name] = $n;
    }

    private function importBooking(array $r): bool
    {
        $id = (string) $r['id'];
        $data = (array) $r['data'];
        $this->app->store->put('bookings', $id, $data, null, ['legacy_raw_json' => Doc::encode($data)]);

        // business date vs stored dateKey (UTC-derived dateKeys were a known issue)
        $start = Doc::toDate($data['startAt'] ?? null) ?? Doc::toDate($data['scheduledAt'] ?? null);
        if (!$start) {
            $this->report['warnings'][] = "booking {$id} has no startAt/scheduledAt";
        } elseif (isset($data['dateKey']) && $data['dateKey'] !== $this->app->clock->dateKey($start)) {
            $this->report['needsReview'][] = "booking {$id}: stored dateKey {$data['dateKey']} differs from business date " . $this->app->clock->dateKey($start) . ' (kept as stored; UI shows startAt)';
        }
        $uid = $data['userId'] ?? null;
        if (is_string($uid) && $uid !== '' && !$this->app->users->rowByUid($uid)) {
            $this->report['warnings'][] = "booking {$id}: userId {$uid} has no matching Auth user (access still works by contact email)";
        }

        // Seed the payment ledger from Stripe payment intents recorded on the booking.
        $now = Clock::toSql($this->app->clock->now());
        $seed = [
            ['deposit', $data['depositPaymentIntentId'] ?? null, $data['depositStripeNetAmount'] ?? null, $data['depositStripeFeeAmount'] ?? null, $data['depositStripeGrossAmount'] ?? null],
            ['remaining_due', $data['balancePaymentIntentId'] ?? null, $data['balanceStripeNetAmount'] ?? null, $data['balanceStripeFeeAmount'] ?? null, $data['balanceStripeGrossAmount'] ?? null],
        ];
        foreach ($seed as [$kind, $pi, $net, $fee, $gross]) {
            if (!is_string($pi) || $pi === '') {
                continue;
            }
            $this->app->db->run(
                'INSERT INTO payments (booking_doc_id, kind, source, amount_net, amount_fee, amount_gross, stripe_payment_intent_id, occurred_at, created_at)
                 VALUES (?, ?, \'migrated\', ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE booking_doc_id = VALUES(booking_doc_id)',
                [$id, $kind, is_numeric($net) ? (float) $net : null, is_numeric($fee) ? (float) $fee : null, is_numeric($gross) ? (float) $gross : null, $pi,
                    Clock::toSql(Doc::toDate($data['paidAt'] ?? null) ?? Doc::toDate($data['updatedAt'] ?? null) ?? $this->app->clock->now()), $now]
            );
        }
        return true;
    }

    private function importUsers(): void
    {
        $file = $this->dir . '/auth-users.json';
        if (!is_file($file)) {
            $this->report['warnings'][] = 'auth-users.json not found — no login accounts imported (run `firebase auth:export`).';
            $this->report['imported']['authUsers'] = 0;
            return;
        }
        $json = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        $users = $json['users'] ?? [];
        $withHashes = !empty($this->options['withLegacyPasswordHashes']);
        $n = 0;
        $providers = [];
        foreach ($users as $u) {
            $uid = (string) ($u['localId'] ?? '');
            $email = trim((string) ($u['email'] ?? ''));
            if ($uid === '') {
                continue;
            }
            if ($email === '') {
                $this->report['needsReview'][] = "auth user {$uid} has no email (phone/anonymous?) — not imported";
                continue;
            }
            $provs = array_values(array_unique(array_map(static fn ($p) => (string) ($p['providerId'] ?? ''), $u['providerUserInfo'] ?? [])));
            foreach ($provs as $p) {
                $providers[$p] = ($providers[$p] ?? 0) + 1;
            }
            $created = isset($u['createdAt']) && is_numeric($u['createdAt']) ? Doc::fromMillis((int) $u['createdAt']) : $this->app->clock->now();
            $row = [
                'uid' => $uid,
                'email' => $email,
                'email_lower' => strtolower($email),
                'email_verified_at' => !empty($u['emailVerified']) ? Clock::toSql($created) : null,
                'display_name' => isset($u['displayName']) ? mb_substr((string) $u['displayName'], 0, 200) : null,
                'phone_number' => isset($u['phoneNumber']) ? (string) $u['phoneNumber'] : null,
                'legacy_providers' => implode(',', $provs) ?: null,
                'is_active' => !empty($u['disabled']) ? 0 : 1,
                'legacy_password_hash' => $withHashes && isset($u['passwordHash']) ? (string) $u['passwordHash'] : null,
                'legacy_password_salt' => $withHashes && isset($u['salt']) ? (string) $u['salt'] : null,
                'imported_at' => Clock::toSql($this->app->clock->now()),
                'created_at' => Clock::toSql($created),
                'updated_at' => Clock::toSql($this->app->clock->now()),
            ];
            $existingByEmail = $this->app->users->rowByEmail($email);
            if ($existingByEmail && $existingByEmail['uid'] !== $uid) {
                $this->report['needsReview'][] = "auth user {$uid}: email {$email} already belongs to another account in MySQL ({$existingByEmail['uid']}) — skipped";
                continue;
            }
            // Never overwrite a native password set after a previous import (re-runs are safe).
            $this->app->db->run(
                'INSERT INTO users (uid, email, email_lower, email_verified_at, display_name, phone_number, legacy_providers, is_active, legacy_password_hash, legacy_password_salt, imported_at, created_at, updated_at, role)
                 VALUES (:uid, :email, :email_lower, :email_verified_at, :display_name, :phone_number, :legacy_providers, :is_active, :legacy_password_hash, :legacy_password_salt, :imported_at, :created_at, :updated_at, \'client\')
                 ON DUPLICATE KEY UPDATE email = VALUES(email), email_lower = VALUES(email_lower),
                   email_verified_at = COALESCE(users.email_verified_at, VALUES(email_verified_at)),
                   display_name = VALUES(display_name), phone_number = VALUES(phone_number), legacy_providers = VALUES(legacy_providers),
                   is_active = VALUES(is_active),
                   legacy_password_hash = IF(users.password_hash IS NULL, VALUES(legacy_password_hash), NULL),
                   legacy_password_salt = IF(users.password_hash IS NULL, VALUES(legacy_password_salt), NULL),
                   imported_at = VALUES(imported_at), updated_at = VALUES(updated_at)',
                $row
            );
            $n++;
        }
        $this->report['imported']['authUsers'] = $n;
        $this->report['authProviders'] = $providers;
        if (!empty($providers['google.com'])) {
            $this->report['needsReview'][] = "{$providers['google.com']} account(s) use Google sign-in; they must set a password via \"Forgot password\" (or a Google sign-in replacement must be built).";
        }
        $this->report['passwordHashesImported'] = $withHashes;
    }

    /** admins/{uid}.active and profiles.role admin|owner -> users.role */
    private function importAdmins(): void
    {
        $n = 0;
        foreach ($this->rows('admins') as $r) {
            if (($r['data']['active'] ?? null) === true) {
                $n += $this->app->db->run("UPDATE users SET role = IF(role = 'owner', 'owner', 'admin') WHERE uid = ?", [$r['id']])->rowCount() ? 1 : 0;
                if (!$this->app->users->rowByUid((string) $r['id'])) {
                    $this->report['needsReview'][] = "admins/{$r['id']} is active but has no Auth user";
                }
            }
        }
        foreach ($this->rows('profiles') as $r) {
            $role = $r['data']['role'] ?? null;
            if (in_array($role, ['admin', 'owner'], true)) {
                $this->app->db->run('UPDATE users SET role = ? WHERE uid = ?', [$role, $r['id']]);
                $n++;
            }
        }
        $this->report['imported']['admins'] = $n;
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices\Migration;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;
use SanchezServices\App;
use SanchezServices\Clock;
use SanchezServices\Domain\BlackoutDates;
use SanchezServices\Domain\Pricing;

/**
 * One-shot import of a Firestore export (backend/tools/migration/export-firestore.cjs + `firebase auth:export`)
 * into the relational schema.
 *
 * - Verifies the export manifest (counts + SHA-256) before reading anything.
 * - Refuses to run against a database that already holds users or bookings.
 * - Everything happens in one transaction; without $apply it is rolled back (dry run).
 * - Legacy money fields are rebuilt into the payments ledger; amount_paid/payment_status are then
 *   recomputed from that ledger exactly as at runtime, and any difference is reported.
 * - The original Firestore document is kept in bookings.legacy_json for audit.
 * The report contains document ids and counts, never names, emails or addresses.
 */
final class FirestoreImporter
{
    private const TOLERANCE = 0.005;

    /** @var array<string,list<array>> */
    private array $docs = [];
    /** @var array<string,array> uid => auth user */
    private array $auth = [];
    /** @var array<string,int> legacy uid => users.id */
    private array $uidMap = [];
    /** @var array<string,int> email_lower => users.id */
    private array $emailMap = [];
    /** @var array<string,int> booking doc id => bookings.id */
    private array $bookingMap = [];
    private array $report;
    private string $now;

    public function __construct(private App $app, private string $dir, private array $opts = [])
    {
        $this->report = [
            'mode' => 'dry-run', 'source' => [], 'imported' => [], 'skipped' => [], 'warnings' => [], 'money' => [],
        ];
    }

    public function run(bool $apply): array
    {
        $this->report['mode'] = $apply ? 'apply' : 'dry-run';
        $this->now = (string) Clock::toSql($this->app->clock->now());
        $this->loadExport();
        $db = $this->app->db;
        $existing = (int) $db->scalar('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM bookings)');
        if ($existing > 0) {
            throw new RuntimeException('Target database already contains users or bookings. Import only into a freshly migrated, empty database.');
        }
        $pdo = $db->pdo();
        $pdo->beginTransaction();
        try {
            $this->importUsers();
            $this->importAddresses();
            $this->importBookings();
            $this->importBlackouts();
            $this->importReviews();
            $this->reportIgnored();
            $this->moneySummary();
            if ($apply) {
                $pdo->commit();
            } else {
                $pdo->rollBack();
                // A rolled-back insert still advances AUTO_INCREMENT; reset it so invoice numbers start from 1 later.
                foreach (['users', 'addresses', 'bookings', 'booking_history', 'payments', 'blackouts', 'reviews'] as $t) {
                    if ((int) $db->scalar("SELECT COUNT(*) FROM {$t}") === 0) {
                        $db->run("ALTER TABLE {$t} AUTO_INCREMENT = 1");
                    }
                }
            }
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $this->report['warnings'] = array_slice($this->report['warnings'], 0, 500);
        return $this->report;
    }

    // ------------------------------------------------------------------ export loading

    private function loadExport(): void
    {
        $manifestPath = $this->dir . '/manifest.json';
        if (!is_file($manifestPath)) {
            throw new RuntimeException('manifest.json not found in export directory.');
        }
        $manifest = json_decode((string) file_get_contents($manifestPath), true, 512, JSON_THROW_ON_ERROR);
        foreach ((array) ($manifest['collections'] ?? []) as $key => $meta) {
            $name = $key === 'profiles/*/addresses' ? 'profiles__addresses' : (string) $key;
            if (!preg_match('/^[A-Za-z0-9_]+$/', $name)) {
                throw new RuntimeException('Unexpected collection name in manifest.');
            }
            $file = $this->dir . '/' . $name . '.ndjson';
            if (!is_file($file)) {
                throw new RuntimeException("Export file missing: {$name}.ndjson");
            }
            if (isset($meta['sha256']) && hash_file('sha256', $file) !== $meta['sha256']) {
                throw new RuntimeException("Checksum mismatch for {$name}.ndjson — the export was modified or truncated.");
            }
            $rows = [];
            foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
                $rows[] = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            }
            if (isset($meta['count']) && (int) $meta['count'] !== count($rows)) {
                throw new RuntimeException("Row count mismatch for {$name}.ndjson.");
            }
            $this->docs[$name] = $rows;
            $this->report['source'][$name] = count($rows);
        }
        $authFile = $this->dir . '/auth-users.json';
        if (is_file($authFile)) {
            $auth = json_decode((string) file_get_contents($authFile), true, 512, JSON_THROW_ON_ERROR);
            foreach ((array) ($auth['users'] ?? []) as $u) {
                if (!empty($u['localId'])) {
                    $this->auth[(string) $u['localId']] = $u;
                }
            }
            $this->report['source']['auth-users'] = count($this->auth);
        } else {
            $this->warn('auth', null, 'auth-users.json not present: accounts are created from profiles only and every user must reset their password.');
        }
    }

    /** @return list<array> */
    private function docs(string $collection): array
    {
        return $this->docs[$collection] ?? [];
    }

    // ------------------------------------------------------------------ users

    private function importUsers(): void
    {
        $profiles = [];
        foreach ($this->docs('profiles') as $p) {
            if ($p['parent'] === null) {
                $profiles[(string) $p['id']] = (array) $p['data'];
            }
        }
        $admins = [];
        foreach ($this->docs('admins') as $a) {
            if (($a['data']['active'] ?? true) !== false) {
                $admins[(string) $a['id']] = true;
            }
        }
        $uids = array_values(array_unique(array_merge(array_keys($this->auth), array_keys($profiles))));
        // Accounts with a Firebase Auth record first, so they win email collisions.
        usort($uids, fn ($a, $b) => (isset($this->auth[$b]) <=> isset($this->auth[$a])) ?: strcmp($a, $b));

        $count = ['users' => 0, 'owners' => 0, 'admins' => 0, 'withLegacyHash' => 0, 'profiles' => 0];
        foreach ($uids as $uid) {
            $auth = $this->auth[$uid] ?? null;
            $prof = $profiles[$uid] ?? [];
            $email = trim((string) ($auth['email'] ?? $prof['email'] ?? ''));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                $this->skip('users', $uid, 'no valid email (phone-only or anonymous account)');
                continue;
            }
            $lower = strtolower($email);
            if (isset($this->emailMap[$lower])) {
                $this->skip('users', $uid, 'duplicate email of another account; bookings are linked to the first account');
                $this->uidMap[$uid] = $this->emailMap[$lower];
                continue;
            }
            $role = match (true) {
                ($prof['role'] ?? null) === 'owner' => 'owner',
                isset($admins[$uid]) || ($prof['role'] ?? null) === 'admin' => 'admin',
                default => 'client',
            };
            $providers = array_values(array_filter(array_map(static fn ($p) => $p['providerId'] ?? null, (array) ($auth['providerUserInfo'] ?? []))));
            $created = $this->msToSql($auth['createdAt'] ?? null) ?? $this->ts($prof['createdAt'] ?? null) ?? $this->now;
            $row = [
                'legacy_firebase_uid' => $uid,
                'email' => $email,
                'email_lower' => $lower,
                'email_verified_at' => !empty($auth['emailVerified']) ? $created : null,
                'name' => $this->str($prof['name'] ?? $prof['fullName'] ?? $auth['displayName'] ?? null, 200),
                'phone' => self::phone($prof['phone'] ?? $prof['phoneNumber'] ?? $auth['phoneNumber'] ?? null),
                'password_hash' => null,
                'legacy_providers' => $providers ? implode(',', $providers) : null,
                'role' => $role,
                'last_login_at' => $this->msToSql($auth['lastSignedInAt'] ?? null),
                'imported_at' => $this->now,
                'created_at' => $created,
                'updated_at' => $this->ts($prof['updatedAt'] ?? null) ?? $created,
            ];
            if (!empty($this->opts['withLegacyPasswordHashes']) && !empty($auth['passwordHash']) && !empty($auth['salt'])) {
                $row['legacy_password_hash'] = (string) $auth['passwordHash'];
                $row['legacy_password_salt'] = (string) $auth['salt'];
                $count['withLegacyHash']++;
            }
            if ($providers && !in_array('password', $providers, true)) {
                $this->warn('users', $uid, 'account used ' . implode('/', $providers) . ' sign-in only; the owner must use "Forgot password" to set a password');
            }
            $id = $this->app->db->insert('users', $row);
            $this->uidMap[$uid] = $id;
            $this->emailMap[$lower] = $id;
            $count['users']++;
            if ($role === 'owner') {
                $count['owners']++;
            } elseif ($role === 'admin') {
                $count['admins']++;
            }
            $pref = (array) ($prof['preferences'] ?? []);
            $contact = strtolower((string) ($prof['preferredContactMethod'] ?? $pref['preferredContactMethod'] ?? ''));
            $this->app->db->insert('client_profiles', [
                'user_id' => $id,
                'phone_normalized' => self::phone($prof['phone'] ?? null),
                'preferred_contact_method' => in_array($contact, ['email', 'phone', 'text'], true) ? $contact : null,
                'fragrance_preference' => $this->str($pref['fragrancePreference'] ?? $prof['fragrancePreference'] ?? null, 40),
                'focus_preference' => $this->str($pref['focusPreference'] ?? $pref['focusAreas'] ?? $prof['focusPreference'] ?? null, 40),
                'pet_preference' => $this->str($pref['petPreference'] ?? $prof['petPreference'] ?? null, 40),
                'preferences_notes' => $this->str($pref['notes'] ?? $pref['specialInstructions'] ?? $prof['specialInstructions'] ?? null, 5000),
                'internal_notes' => $this->str($prof['internalNotes'] ?? $prof['adminNotes'] ?? null, 5000),
                'created_at' => $created,
                'updated_at' => $row['updated_at'],
            ]);
            $count['profiles']++;
        }
        foreach (array_keys($admins) as $uid) {
            if (!isset($this->uidMap[$uid])) {
                $this->warn('admins', $uid, 'admin entry has no matching account with an email; not imported');
            }
        }
        $this->report['imported'] += $count;
    }

    private function importAddresses(): void
    {
        $n = 0;
        $byUser = [];
        foreach ($this->docs('profiles__addresses') as $a) {
            $uid = preg_replace('#^profiles/#', '', (string) $a['parent']);
            $byUser[$uid][] = $a;
        }
        // Profile-level address fields (older profile shape) when there is no address sub-collection.
        foreach ($this->docs('profiles') as $p) {
            $d = (array) $p['data'];
            $uid = (string) $p['id'];
            if ($p['parent'] === null && empty($byUser[$uid])) {
                $addr = is_array($d['address'] ?? null) ? $d['address'] : ['line1' => $d['addressLine1'] ?? null, 'city' => $d['city'] ?? null, 'state' => $d['state'] ?? null, 'zip' => $d['zip'] ?? null];
                if (!empty($addr['line1']) || !empty($addr['street'])) {
                    $byUser[$uid][] = ['id' => 'profile', 'data' => $addr + ['isDefault' => true]];
                }
            }
        }
        foreach ($byUser as $uid => $list) {
            $userId = $this->uidMap[$uid] ?? null;
            if ($userId === null) {
                $this->skip('addresses', (string) $uid, 'owner account not imported');
                continue;
            }
            $hasDefault = false;
            foreach ($list as $i => $a) {
                $d = (array) $a['data'];
                $addr = self::address($d);
                if ($addr === null) {
                    $this->skip('addresses', $uid . '/' . $a['id'], 'incomplete address (street, city, 2-letter state and ZIP are required)');
                    continue;
                }
                $isDefault = !$hasDefault && (!empty($d['isDefault']) || $i === count($list) - 1);
                $hasDefault = $hasDefault || $isDefault;
                $created = $this->ts($d['createdAt'] ?? null) ?? $this->now;
                $this->app->db->insert('addresses', [
                    'user_id' => $userId, 'label' => $this->str($d['label'] ?? $d['nickname'] ?? null, 60),
                    'line1' => $addr['line1'], 'line2' => $addr['line2'], 'city' => $addr['city'], 'state' => $addr['state'], 'zip' => $addr['zip'],
                    'access_instructions' => $this->str($d['accessInstructions'] ?? $d['notes'] ?? null, 2000),
                    'is_default' => $isDefault ? 1 : 0, 'sort_order' => (int) ($d['sortOrder'] ?? $i),
                    'legacy_ref' => (string) $a['id'], 'created_at' => $created, 'updated_at' => $this->ts($d['updatedAt'] ?? null) ?? $created,
                ]);
                $n++;
            }
        }
        $this->report['imported']['addresses'] = $n;
    }

    // ------------------------------------------------------------------ bookings + ledger

    private function importBookings(): void
    {
        $tz = $this->app->clock->tz();
        $n = 0;
        $payments = 0;
        foreach ($this->docs('bookings') as $doc) {
            $ref = (string) $doc['id'];
            $d = (array) $doc['data'];
            $start = $this->dt($d['startAt'] ?? $d['scheduledAt'] ?? null);
            if ($start === null && !empty($d['dateKey']) && BlackoutDates::isDateKey($d['dateKey'])) {
                $time = $this->parseTimeLabel((string) ($d['timeLabel'] ?? $d['time'] ?? ''));
                if ($time !== null) {
                    $start = new DateTimeImmutable($d['dateKey'] . ' ' . $time, $tz);
                }
            }
            if ($start === null) {
                $this->skip('bookings', $ref, 'no appointment date/time');
                continue;
            }
            $attention = [];
            $businessDate = $this->app->clock->dateKey($start);
            if (!empty($d['dateKey']) && $d['dateKey'] !== $businessDate) {
                $this->warn('bookings', $ref, "stored dateKey {$d['dateKey']} disagreed with the appointment time; using {$businessDate} (America/New_York)");
            }
            $endLegacy = $this->dt($d['endAt'] ?? null);
            $duration = (int) ($d['durationMinutes'] ?? 0);
            if ($duration <= 0 && isset($d['estimate']['durationHours'])) {
                $duration = (int) round((float) $d['estimate']['durationHours'] * 60);
            }
            if ($duration <= 0 && $endLegacy) {
                $duration = (int) round(($endLegacy->getTimestamp() - $start->getTimestamp()) / 60);
            }
            if ($duration <= 0 || $duration > 24 * 60) {
                $duration = 120;
                $this->warn('bookings', $ref, 'no usable duration; assumed 120 minutes');
            }
            $end = $endLegacy && $endLegacy > $start ? $endLegacy : $start->modify("+{$duration} minutes");

            $status = $this->mapStatus($d, $start, $ref);
            $userId = null;
            foreach (['userId', 'clientId', 'uid', 'ownerUid'] as $k) {
                if (!empty($d[$k]) && isset($this->uidMap[(string) $d[$k]])) {
                    $userId = $this->uidMap[(string) $d[$k]];
                    break;
                }
            }
            $contact = (array) ($d['contact'] ?? []);
            $email = trim((string) ($contact['email'] ?? $d['email'] ?? $d['contactEmail'] ?? $d['clientEmail'] ?? ''));
            if ($userId === null && $email !== '' && isset($this->emailMap[strtolower($email)])) {
                $userId = $this->emailMap[strtolower($email)];
            }
            if ($email === '' && $userId !== null) {
                $email = (string) $this->app->db->scalar('SELECT email FROM users WHERE id = ?', [$userId]);
            }
            if ($email === '') {
                $attention[] = 'Imported without a contact email';
            }
            $addr = self::address(is_array($d['address'] ?? null) ? $d['address'] : ['line1' => is_string($d['address'] ?? null) ? $d['address'] : ($d['addressLine1'] ?? null), 'city' => $d['city'] ?? null, 'state' => $d['state'] ?? null, 'zip' => $d['zip'] ?? null], true);
            if ($addr['incomplete']) {
                $attention[] = 'Imported with an incomplete address';
            }
            [$slug, $serviceName] = $this->service($d);
            $total = max(0.0, $this->firstAmount($d, ['totalPrice', 'totalAmount', 'total', 'payment.totalPrice', 'payment.totalAmount', 'payment.total', 'cost', 'amount', 'estimate.total']) ?? 0.0);
            $deposit = max(0.0, $this->firstAmount($d, ['depositAmount', 'payment.depositAmount', 'depositDue']) ?? 0.0);
            $legacyPaid = $this->legacyPaid($d, $total, $deposit);
            if ($status === 'completed' && $legacyPaid + self::TOLERANCE < $total) {
                if (!empty($this->opts['assumeCompletedPaid'])) {
                    $legacyPaid = round($total, 2);
                    $this->warn('payments', $ref, 'completed booking without a recorded payment: recorded as paid in full (--assume-completed-paid)');
                } else {
                    $this->warn('payments', $ref, sprintf('completed booking shows %.2f still due (no payment recorded in Firestore)', $total - $legacyPaid));
                }
            }
            $refunded = max(0.0, (float) ($d['refundedAmount'] ?? $d['payment']['refundedAmount'] ?? 0));
            $created = $this->ts($d['createdAt'] ?? null) ?? Clock::toSql($start);
            $cancelledAt = $status === 'cancelled' ? ($this->ts($d['cancelledAt'] ?? null) ?? $this->ts($d['updatedAt'] ?? null) ?? $created) : null;
            $addons = array_values(array_filter(array_map(static fn ($a) => is_array($a) ? ($a['id'] ?? $a['slug'] ?? null) : $a, (array) ($d['addOns'] ?? $d['addons'] ?? [])), 'is_string'));
            $condition = strtolower((string) ($d['condition'] ?? $d['propertyCondition'] ?? ''));
            $lineItems = [];
            foreach ((array) ($d['lineItems'] ?? $d['pricing']['lineItems'] ?? []) as $li) {
                if (is_array($li) && isset($li['amount']) && is_numeric($li['amount'])) {
                    $lineItems[] = ['label' => $this->str($li['label'] ?? $li['name'] ?? 'Item', 120) ?? 'Item', 'detail' => $this->str($li['detail'] ?? null, 200), 'amount' => round((float) $li['amount'], 2)];
                }
            }
            if (!$lineItems || abs(array_sum(array_column($lineItems, 'amount')) - $total) >= self::TOLERANCE) {
                $lineItems = [['label' => $serviceName, 'detail' => 'Imported booking', 'amount' => round($total, 2)]];
            }
            $legacyInvoice = is_string($d['invoiceNumber'] ?? null) && preg_match('/^[A-Za-z0-9-]{3,30}$/', $d['invoiceNumber']) ? $d['invoiceNumber'] : null;
            if ($legacyInvoice !== null && $this->app->db->scalar('SELECT 1 FROM bookings WHERE invoice_number = ?', [$legacyInvoice])) {
                $legacyInvoice = null;
            }
            $past = $start < $this->app->clock->now();
            $row = [
                'ref' => $ref,
                'invoice_number' => $legacyInvoice,
                'user_id' => $userId,
                'status' => $status,
                'contact_name' => $this->str($contact['name'] ?? $d['clientName'] ?? $d['name'] ?? null, 200) ?? 'Unknown client',
                'contact_email' => $email,
                'contact_email_lower' => strtolower($email),
                'contact_phone' => self::phone($contact['phone'] ?? $d['phone'] ?? null),
                'address_line1' => $addr['line1'], 'address_line2' => $addr['line2'], 'address_city' => $addr['city'],
                'address_state' => $addr['state'], 'address_zip' => $addr['zip'],
                'service_slug' => $slug,
                'service_name' => $serviceName,
                'property_type' => $this->str($d['propertyType'] ?? null, 30),
                'bedrooms' => is_numeric($d['bedrooms'] ?? null) ? (float) $d['bedrooms'] : null,
                'bathrooms' => is_numeric($d['bathrooms'] ?? null) ? (float) $d['bathrooms'] : null,
                'sqft' => is_numeric($d['sqft'] ?? $d['squareFeet'] ?? null) ? (int) ($d['sqft'] ?? $d['squareFeet']) : null,
                'property_condition' => in_array($condition, ['light', 'standard', 'heavy'], true) ? $condition : null,
                'pets' => !empty($d['pets']) || !empty($d['hasPets']) ? 1 : 0,
                'addons_json' => $addons ? json_encode($addons) : null,
                'frequency' => array_key_exists((string) ($d['frequency'] ?? ''), Pricing::FREQUENCY_DISCOUNTS) ? (string) $d['frequency'] : 'one-time',
                'promo_code' => $this->str($d['promoCode'] ?? null, 30),
                'access_notes' => $this->str($d['accessInstructions'] ?? $d['accessNotes'] ?? null, 5000),
                'cleaner_notes' => $this->str($d['notesForCleaner'] ?? $d['specialInstructions'] ?? $d['notes'] ?? null, 5000),
                'admin_notes' => $this->str($d['adminNotes'] ?? null, 5000),
                'start_at' => Clock::toSql($start),
                'end_at' => Clock::toSql($end),
                'business_date' => $businessDate,
                'duration_minutes' => (int) round(($end->getTimestamp() - $start->getTimestamp()) / 60),
                'pricing_json' => json_encode(['lineItems' => $lineItems, 'imported' => true], JSON_UNESCAPED_SLASHES),
                'total_price' => round($total, 2),
                'deposit_amount' => round(min($deposit, $total > 0 ? $total : $deposit), 2),
                'created_via' => 'import',
                'cancellation_reason' => $this->str($d['cancellationReason'] ?? $d['cancelReason'] ?? null, 500),
                'cancelled_by' => in_array($d['cancelledBy'] ?? null, ['client', 'admin', 'system'], true) ? $d['cancelledBy'] : ($status === 'cancelled' ? 'admin' : null),
                'confirmed_at' => in_array($status, ['confirmed', 'completed'], true) ? ($this->ts($d['confirmedAt'] ?? null) ?? $created) : null,
                'cancelled_at' => $cancelledAt,
                'completed_at' => $status === 'completed' ? ($this->ts($d['completedAt'] ?? null) ?? Clock::toSql($end)) : null,
                'expired_at' => $status === 'expired' ? $this->now : null,
                // No reminder system existed before: never send reminders for appointments that already happened.
                'reminder48_sent_at' => $past ? $this->now : null,
                'reminder24_sent_at' => $past ? $this->now : null,
                'needs_attention' => $attention ? implode('; ', $attention) : null,
                'legacy_json' => json_encode($d, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR),
                'created_at' => $created,
                'updated_at' => $this->ts($d['updatedAt'] ?? null) ?? $created,
            ];
            $id = $this->app->repo->insert($row);
            $this->bookingMap[$ref] = $id;
            $this->app->db->insert('booking_history', [
                'booking_id' => $id, 'event' => 'created', 'actor_role' => 'system',
                'details_json' => json_encode(['via' => 'import', 'legacyStatus' => $d['status'] ?? null]), 'created_at' => $created,
            ]);
            $payments += $this->rebuildLedger($id, $ref, $d, $total, $deposit, $legacyPaid, $refunded, $created);
            $n++;
        }
        $this->report['imported']['bookings'] = $n;
        $this->report['imported']['payments'] = $payments;
    }

    /** Rebuilds payments from legacy fields; returns number of ledger rows written. */
    private function rebuildLedger(int $id, string $ref, array $d, float $total, float $deposit, float $legacyPaid, float $refunded, string $created): int
    {
        $rows = [];
        foreach (['deposit', 'balance'] as $purpose) {
            $pi = $d[$purpose . 'PaymentIntentId'] ?? null;
            if (!is_string($pi) || !str_starts_with($pi, 'pi_')) {
                continue;
            }
            $net = $this->num($d[$purpose . 'StripeNetAmount'] ?? null) ?? ($purpose === 'deposit' ? $deposit : max(0.0, $legacyPaid - $deposit));
            $fee = $this->num($d[$purpose . 'StripeFeeAmount'] ?? null) ?? 0.0;
            $rows[] = [
                'purpose' => $purpose, 'method' => 'card', 'amount' => round($net, 2), 'fee' => round($fee, 2),
                'gross' => round($this->num($d[$purpose . 'StripeGrossAmount'] ?? null) ?? ($net + $fee), 2),
                'stripe_payment_intent_id' => $pi,
                'paid_at' => $this->ts($d[$purpose . 'PaidAt'] ?? null) ?? $this->ts($d['updatedAt'] ?? null) ?? $created,
                'note' => 'Imported Stripe payment',
            ];
        }
        $cardSum = array_sum(array_column($rows, 'amount'));
        $remainder = round($legacyPaid - $cardSum, 2);
        if ($remainder > self::TOLERANCE) {
            $method = self::method((string) ($d['balancePaymentMethod'] ?? $d['paymentMethod'] ?? $d['depositPaymentMethod'] ?? ''));
            $purpose = $cardSum <= 0 && abs($remainder - $deposit) < self::TOLERANCE && $deposit > 0 ? 'deposit' : ($cardSum <= 0 && $remainder + self::TOLERANCE < $total ? 'other' : 'balance');
            $rows[] = [
                'purpose' => $purpose, 'method' => $method, 'amount' => $remainder, 'fee' => 0.0, 'gross' => $remainder,
                'stripe_payment_intent_id' => null,
                'paid_at' => $this->ts($d['balancePaidAt'] ?? $d['paidAt'] ?? $d['depositPaidAt'] ?? null) ?? $this->ts($d['updatedAt'] ?? null) ?? $created,
                'note' => 'Reconstructed from legacy paid total' . ($method === 'other' ? ' (method not recorded)' : ''),
            ];
        } elseif ($remainder < -self::TOLERANCE) {
            $this->warn('payments', $ref, sprintf('Stripe records (%.2f) exceed the stored paid amount (%.2f); Stripe records kept', $cardSum, $legacyPaid));
        }
        $written = 0;
        $largest = null;
        foreach ($rows as $r) {
            if ($r['stripe_payment_intent_id'] !== null && $this->app->db->scalar('SELECT 1 FROM payments WHERE stripe_payment_intent_id = ?', [$r['stripe_payment_intent_id']])) {
                $this->warn('payments', $ref, 'payment intent already imported for another booking; skipped duplicate');
                continue;
            }
            $pid = $this->app->db->insert('payments', $r + ['booking_id' => $id, 'type' => 'payment', 'status' => 'succeeded', 'source' => 'import', 'created_at' => $this->now]);
            if ($largest === null || $r['amount'] > $largest[1]) {
                $largest = [$pid, $r['amount'], $r['method']];
            }
            $written++;
        }
        if ($refunded > self::TOLERANCE) {
            if ($largest === null) {
                $this->warn('payments', $ref, 'refund recorded but no payment to refund; refund not imported');
            } else {
                $this->app->db->insert('payments', [
                    'booking_id' => $id, 'type' => 'refund', 'purpose' => 'other', 'method' => $largest[2], 'amount' => round(min($refunded, $largest[1]), 2),
                    'fee' => 0, 'gross' => 0, 'status' => 'succeeded', 'source' => 'import', 'refund_of_payment_id' => $largest[0],
                    'paid_at' => $this->ts($d['refundedAt'] ?? null) ?? $this->ts($d['updatedAt'] ?? null) ?? $created,
                    'note' => 'Imported refund', 'created_at' => $this->now,
                ]);
                $written++;
            }
        }
        $fresh = $this->app->ledger->recalc($id);
        $this->report['money']['legacyPaid'] = round(($this->report['money']['legacyPaid'] ?? 0) + $legacyPaid - $refunded, 2);
        $this->report['money']['ledgerPaid'] = round(($this->report['money']['ledgerPaid'] ?? 0) + (float) $fresh['amount_paid'], 2);
        if (abs((float) $fresh['amount_paid'] - ($legacyPaid - $refunded)) >= self::TOLERANCE) {
            $this->warn('payments', $ref, sprintf('ledger paid %.2f differs from legacy paid %.2f', (float) $fresh['amount_paid'], $legacyPaid - $refunded));
        }
        return $written;
    }

    /** Same precedence as the legacy UI (normalizePaymentAmounts), capped at the total. */
    private function legacyPaid(array $d, float $total, float $deposit): float
    {
        $explicit = $this->firstAmount($d, ['paidAmount', 'payment.paidAmount', 'amountPaid', 'payment.amountPaid', 'paid']);
        $remaining = $this->firstAmount($d, ['remainingDue', 'payment.remainingDue', 'balanceDue', 'payment.balanceDue', 'remainingBalance']);
        $paid = max(0.0, $explicit ?? 0.0);
        if ($explicit === null && $remaining !== null && $total > 0) {
            $paid = max(0.0, $total - max(0.0, $remaining));
        } elseif ($explicit === null && !empty($d['depositPaid'])) {
            $paid = $deposit;
        }
        $status = strtolower((string) ($d['paymentStatus'] ?? ''));
        if ($explicit === null && $remaining === null && in_array($status, ['paid', 'paid_in_full'], true)) {
            $paid = $total;
        }
        return round($total > 0 ? min($total, $paid) : $paid, 2);
    }

    private function mapStatus(array $d, DateTimeImmutable $start, string $ref): string
    {
        $raw = strtolower(trim((string) ($d['status'] ?? $d['bookingStatus'] ?? '')));
        $s = match ($raw) {
            'pending', 'requested', 'new' => 'pending',
            'confirmed', 'scheduled', 'booked' => 'confirmed',
            'completed', 'complete', 'done' => 'completed',
            'cancelled', 'canceled' => 'cancelled',
            'declined', 'rejected' => 'declined',
            'pending_payment', 'awaiting_payment', 'checkout_created', 'requires_payment' => 'expired',
            default => null,
        };
        if ($s === null) {
            $this->warn('bookings', $ref, "unknown legacy status '{$raw}'; imported as pending for review");
            return 'pending';
        }
        if ($s === 'expired' && (!empty($d['depositPaid']) || (float) ($d['paidAmount'] ?? 0) > 0)) {
            return 'confirmed';
        }
        if ($s === 'expired') {
            $this->warn('bookings', $ref, 'unpaid checkout hold imported as expired');
        }
        return $s;
    }

    /** @return array{0:string,1:string} */
    private function service(array $d): array
    {
        $raw = (string) ($d['serviceSlug'] ?? $d['serviceId'] ?? $d['service'] ?? '');
        $slug = strtolower(trim($raw));
        if (!isset(Pricing::SERVICE_PRICING[$slug]) && !in_array($slug, ['deep-cleaning', 'moving-cleaning', 'commercial-cleaning'], true)) {
            $name = strtolower((string) ($d['serviceName'] ?? $raw));
            $slug = match (true) {
                str_contains($name, 'move') => 'move-in-move-out',
                str_contains($name, 'deep') => 'deep-clean',
                str_contains($name, 'office') || str_contains($name, 'commercial') => 'office-cleaning',
                default => 'residential-cleaning',
            };
        }
        $slug = Pricing::normalizeServiceSlug($slug);
        $name = $this->str($d['serviceName'] ?? (isset(Pricing::SERVICE_PRICING[strtolower($raw)]) ? null : ($raw !== '' ? $raw : null)), 100) ?? Pricing::SERVICE_PRICING[$slug]['name'];
        return [$slug, $name];
    }

    // ------------------------------------------------------------------ blackouts + reviews

    private function importBlackouts(): void
    {
        $n = 0;
        foreach ($this->docs('blackouts') as $doc) {
            $d = (array) $doc['data'];
            $ref = (string) $doc['id'];
            $row = ['reason' => $this->str($d['reason'] ?? $d['note'] ?? null, 300), 'legacy_ref' => $ref, 'created_at' => $this->ts($d['createdAt'] ?? null) ?? $this->now];
            $startKey = $d['startDateKey'] ?? $d['dateKey'] ?? null;
            if (($d['allDay'] ?? true) && BlackoutDates::isDateKey($startKey)) {
                $endKey = BlackoutDates::isDateKey($d['endDateKey'] ?? null) ? $d['endDateKey'] : $startKey;
                // Legacy convention (CalendarView): equal keys = that single day; otherwise endDateKey is exclusive.
                $endExclusive = $endKey <= $startKey ? BlackoutDates::addDays($startKey, 1) : $endKey;
                $row += ['all_day' => 1, 'start_date' => $startKey, 'end_date_exclusive' => $endExclusive];
            } else {
                $s = $this->dt($d['startAt'] ?? null);
                $e = $this->dt($d['endAt'] ?? null);
                if (!$s || !$e || $e <= $s) {
                    $this->skip('blackouts', $ref, 'no usable dates');
                    continue;
                }
                $row += ['all_day' => 0, 'start_at' => Clock::toSql($s), 'end_at' => Clock::toSql($e)];
            }
            $this->app->db->insert('blackouts', $row);
            $n++;
        }
        $this->report['imported']['blackouts'] = $n;
    }

    private function importReviews(): void
    {
        $n = 0;
        foreach ($this->docs('reviews') as $doc) {
            $d = (array) $doc['data'];
            $ref = (string) $doc['id'];
            $rating = (int) ($d['rating'] ?? 0);
            $comment = trim((string) ($d['comment'] ?? $d['body'] ?? $d['text'] ?? ''));
            if ($rating < 1 || $rating > 5 || $comment === '') {
                $this->skip('reviews', $ref, 'missing rating or text');
                continue;
            }
            $bookingId = isset($d['bookingId']) ? ($this->bookingMap[(string) $d['bookingId']] ?? null) : null;
            if ($bookingId !== null && $this->app->db->scalar('SELECT 1 FROM reviews WHERE booking_id = ?', [$bookingId])) {
                $this->warn('reviews', $ref, 'second review for the same booking; imported without the booking link');
                $bookingId = null;
            }
            $status = match (strtolower((string) ($d['status'] ?? 'pending'))) {
                'approved', 'published' => 'approved',
                'declined', 'rejected', 'hidden' => 'declined',
                default => 'pending',
            };
            $mode = in_array($d['displayMode'] ?? null, ['anonymous', 'initials', 'firstInitialLastName'], true) ? $d['displayMode'] : 'initials';
            $created = $this->ts($d['createdAt'] ?? null) ?? $this->now;
            $this->app->db->insert('reviews', [
                'booking_id' => $bookingId,
                'user_id' => isset($d['clientId']) ? ($this->uidMap[(string) $d['clientId']] ?? null) : null,
                'rating' => $rating, 'comment' => mb_substr($comment, 0, 5000), 'display_mode' => $mode,
                'display_name' => $this->str($d['reviewDisplayName'] ?? $d['displayName'] ?? null, 100) ?? 'Client',
                'service_name' => $bookingId ? $this->app->db->scalar('SELECT service_name FROM bookings WHERE id = ?', [$bookingId]) : $this->str($d['serviceName'] ?? null, 100),
                'status' => $status, 'legacy_ref' => $ref, 'created_at' => $created,
                'published_at' => $status === 'approved' ? ($this->ts($d['publishedAt'] ?? null) ?? $created) : null,
                'updated_at' => $this->ts($d['updatedAt'] ?? null) ?? $created,
            ]);
            $n++;
        }
        $this->report['imported']['reviews'] = $n;
    }

    private function reportIgnored(): void
    {
        // Derived or unused collections: rebuilt by the new system or never written by the old app.
        foreach (['availability' => 'derived from bookings', 'bookingReservations' => 'derived from bookings', 'mail' => 'sent-email queue history',
            'payments' => 'no known writer', 'reports' => 'no known writer', 'services' => 'catalog is in code', 'addresses' => 'no known writer'] as $c => $why) {
            $count = count($this->docs($c));
            if ($count > 0) {
                $this->report['skipped']['collections'][$c] = "{$count} document(s) not imported: {$why}";
                if (in_array($c, ['payments', 'reports', 'addresses'], true)) {
                    $this->warn($c, null, "{$count} document(s) exist in a collection the old app did not write; review manually");
                }
            }
        }
    }

    private function moneySummary(): void
    {
        $db = $this->app->db;
        $this->report['money'] += [
            'bookingsTotal' => round((float) $db->scalar("SELECT COALESCE(SUM(total_price),0) FROM bookings WHERE status NOT IN ('cancelled','declined','expired')"), 2),
            'ledgerCollected' => round((float) $db->scalar("SELECT COALESCE(SUM(amount),0) FROM payments WHERE type='payment' AND status='succeeded'"), 2),
            'ledgerRefunded' => round((float) $db->scalar("SELECT COALESCE(SUM(amount),0) FROM payments WHERE type='refund' AND status='succeeded'"), 2),
            'stripePayments' => (int) $db->scalar('SELECT COUNT(*) FROM payments WHERE stripe_payment_intent_id IS NOT NULL'),
        ];
        $this->report['imported']['bookingsNeedingAttention'] = (int) $db->scalar('SELECT COUNT(*) FROM bookings WHERE needs_attention IS NOT NULL');
    }

    // ------------------------------------------------------------------ helpers

    private function warn(string $area, ?string $id, string $message): void
    {
        $this->report['warnings'][] = ['area' => $area, 'id' => $id, 'message' => $message];
    }

    private function skip(string $area, string $id, string $why): void
    {
        $this->report['skipped'][$area][] = ['id' => $id, 'reason' => $why];
    }

    private function dt(mixed $v): ?DateTimeImmutable
    {
        if (is_array($v) && isset($v['__ts'])) {
            $v = $v['__ts'];
        } elseif (is_array($v) && isset($v['_seconds'])) {
            return (new DateTimeImmutable('@' . (int) $v['_seconds']))->setTimezone(new DateTimeZone('UTC'));
        }
        if (!is_string($v) || $v === '') {
            return null;
        }
        try {
            return (new DateTimeImmutable($v))->setTimezone(new DateTimeZone('UTC'));
        } catch (\Exception) {
            return null;
        }
    }

    private function ts(mixed $v): ?string
    {
        return Clock::toSql($this->dt($v));
    }

    private function msToSql(mixed $ms): ?string
    {
        if (!is_numeric($ms) || (float) $ms <= 0) {
            return null;
        }
        $s = (int) floor((float) $ms / 1000);
        return Clock::toSql((new DateTimeImmutable('@' . $s))->setTimezone(new DateTimeZone('UTC')));
    }

    private function parseTimeLabel(string $label): ?string
    {
        if (preg_match('/^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*$/', $label, $m)) {
            $h = (int) $m[1];
            if (!empty($m[3])) {
                $h = $h % 12 + (strtolower($m[3]) === 'pm' ? 12 : 0);
            }
            return $h < 24 ? sprintf('%02d:%s:00', $h, $m[2]) : null;
        }
        return null;
    }

    private function str(mixed $v, int $max): ?string
    {
        if (!is_scalar($v)) {
            return null;
        }
        $s = trim((string) $v);
        return $s === '' ? null : mb_substr($s, 0, $max);
    }

    private function num(mixed $v): ?float
    {
        return is_numeric($v) && is_finite((float) $v) ? (float) $v : null;
    }

    private function firstAmount(array $d, array $paths): ?float
    {
        foreach ($paths as $p) {
            $v = $d;
            foreach (explode('.', $p) as $k) {
                $v = is_array($v) && array_key_exists($k, $v) ? $v[$k] : null;
            }
            if (($n = $this->num($v)) !== null) {
                return $n;
            }
        }
        return null;
    }

    public static function phone(mixed $v): ?string
    {
        $digits = preg_replace('/\D+/', '', (string) ($v ?? ''));
        if (strlen($digits) === 11 && $digits[0] === '1') {
            $digits = substr($digits, 1);
        }
        return strlen($digits) === 10 ? $digits : null;
    }

    public static function method(string $raw): string
    {
        $s = strtolower($raw);
        return match (true) {
            $s === '' => 'other',
            str_contains($s, 'stripe') || str_contains($s, 'card') => 'card',
            str_contains($s, 'cash_app') || str_contains($s, 'cashapp') || str_contains($s, 'cash app') => 'cash_app',
            str_contains($s, 'zelle') => 'zelle',
            str_contains($s, 'venmo') => 'venmo',
            str_contains($s, 'check') || str_contains($s, 'cheque') => 'check',
            $s === 'cash' => 'cash',
            default => 'other',
        };
    }

    /**
     * @return array{line1:string,line2:?string,city:string,state:string,zip:string,incomplete?:bool}|null
     */
    public static function address(array $a, bool $lenient = false): ?array
    {
        $line1 = trim((string) ($a['line1'] ?? $a['street'] ?? $a['address1'] ?? $a['address'] ?? ''));
        $city = trim((string) ($a['city'] ?? ''));
        $state = strtoupper(trim((string) ($a['state'] ?? '')));
        $zip = trim((string) ($a['zip'] ?? $a['zipCode'] ?? $a['postalCode'] ?? ''));
        $ok = $line1 !== '' && $city !== '' && preg_match('/^[A-Z]{2}$/', $state) && preg_match('/^\d{5}(-\d{4})?$/', $zip);
        if (!$ok && !$lenient) {
            return null;
        }
        $out = [
            'line1' => mb_substr($line1, 0, 200), 'line2' => ($l2 = trim((string) ($a['line2'] ?? $a['apt'] ?? $a['unit'] ?? ''))) !== '' ? mb_substr($l2, 0, 200) : null,
            'city' => mb_substr($city, 0, 100), 'state' => preg_match('/^[A-Z]{2}$/', $state) ? $state : '', 'zip' => mb_substr($zip, 0, 10),
        ];
        if ($lenient) {
            $out['incomplete'] = !$ok;
        }
        return $out;
    }
}

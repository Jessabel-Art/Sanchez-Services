<?php
declare(strict_types=1);

namespace SanchezServices\Store;

use DateTimeImmutable;
use SanchezServices\Clock;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;

/**
 * Persists Firestore-shaped documents in collection tables (doc_json + indexed projections).
 *
 * Supported paths:
 *   bookings/{id}, profiles/{uid}, profiles/{uid}/addresses/{id}, blackouts/{id}, reviews/{id}
 */
final class DocumentStore
{
    public const TABLES = [
        'bookings' => 'bookings',
        'profiles' => 'profiles',
        'addresses' => 'addresses',
        'blackouts' => 'blackouts',
        'reviews' => 'reviews',
    ];

    public function __construct(private Db $db, private Clock $clock)
    {
    }

    /**
     * Parses a document or collection path.
     * @return array{collection:string,id:?string,parent:?string}
     */
    public static function parsePath(string $path, bool $expectDoc): array
    {
        $parts = array_values(array_filter(explode('/', trim($path, '/')), static fn ($p) => $p !== ''));
        foreach ($parts as $p) {
            if (!preg_match('/^[A-Za-z0-9_\-:.@+]{1,160}$/', $p)) {
                throw HttpError::invalid('Invalid path.');
            }
        }
        $n = count($parts);
        if ($n >= 3 && $parts[0] === 'profiles' && $parts[2] === 'addresses') {
            if ($expectDoc && $n !== 4 || !$expectDoc && $n !== 3) {
                throw HttpError::invalid('Invalid path.');
            }
            return ['collection' => 'addresses', 'parent' => $parts[1], 'id' => $expectDoc ? $parts[3] : null];
        }
        if ($expectDoc && $n !== 2 || !$expectDoc && $n !== 1) {
            throw HttpError::invalid('Invalid path.');
        }
        return ['collection' => $parts[0], 'parent' => null, 'id' => $expectDoc ? $parts[1] : null];
    }

    public static function newId(): string
    {
        $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        $id = '';
        for ($i = 0; $i < 20; $i++) {
            $id .= $chars[random_int(0, 61)];
        }
        return $id;
    }

    private function table(string $collection): string
    {
        if (!isset(self::TABLES[$collection])) {
            throw HttpError::invalid('Unsupported collection.');
        }
        return self::TABLES[$collection];
    }

    /** @return array<string,mixed>|null */
    public function get(string $collection, string $id, ?string $parent = null, bool $forUpdate = false): ?array
    {
        $table = $this->table($collection);
        $sql = "SELECT doc_json FROM {$table} WHERE doc_id = ?" . ($collection === 'addresses' ? ' AND owner_uid = ?' : '');
        $params = $collection === 'addresses' ? [$id, (string) $parent] : [$id];
        if ($forUpdate) {
            $sql .= ' FOR UPDATE';
        }
        $row = $this->db->one($sql, $params);
        return $row ? Doc::decode((string) $row['doc_json']) : null;
    }

    /**
     * @param array<string,mixed> $doc
     * @param array<string,mixed> $extraColumns e.g. legacy_raw_json
     */
    public function put(string $collection, string $id, array $doc, ?string $parent = null, array $extraColumns = []): void
    {
        $table = $this->table($collection);
        $cols = $this->project($collection, $doc, $parent) + $extraColumns;
        $cols['doc_id'] = $id;
        $cols['doc_json'] = Doc::encode($doc ?: new \stdClass());
        if ($collection === 'addresses') {
            $cols['owner_uid'] = (string) $parent;
        }
        $names = array_keys($cols);
        $sql = sprintf(
            'INSERT INTO %s (%s) VALUES (%s) ON DUPLICATE KEY UPDATE %s',
            $table,
            implode(', ', array_map(static fn ($c) => "`$c`", $names)),
            implode(', ', array_map(static fn ($c) => ':' . $c, $names)),
            implode(', ', array_map(static fn ($c) => "`$c` = VALUES(`$c`)", array_filter($names, static fn ($c) => $c !== 'doc_id' && $c !== 'owner_uid')))
        );
        try {
            $this->db->run($sql, $cols);
        } catch (\PDOException $e) {
            if (($e->errorInfo[1] ?? null) === 1062) {
                throw new HttpError('already-exists', 'Document conflicts with an existing record.');
            }
            throw $e;
        }
    }

    public function delete(string $collection, string $id, ?string $parent = null): void
    {
        $table = $this->table($collection);
        if ($collection === 'addresses') {
            $this->db->run("DELETE FROM {$table} WHERE doc_id = ? AND owner_uid = ?", [$id, (string) $parent]);
            return;
        }
        $this->db->run("DELETE FROM {$table} WHERE doc_id = ?", [$id]);
    }

    /**
     * Loads candidate documents. $prefilter may narrow by SQL (superset of the true result);
     * exact Firestore semantics are applied afterwards by QueryEngine.
     *
     * @param array{sql?:string,params?:array<int,mixed>} $prefilter
     * @return list<array{id:string,parent:?string,data:array<string,mixed>}>
     */
    public function scan(string $collection, ?string $parent = null, array $prefilter = []): array
    {
        $table = $this->table($collection);
        $where = [];
        $params = [];
        if ($collection === 'addresses') {
            $where[] = 'owner_uid = ?';
            $params[] = (string) $parent;
        }
        if (!empty($prefilter['sql'])) {
            $where[] = '(' . $prefilter['sql'] . ')';
            array_push($params, ...($prefilter['params'] ?? []));
        }
        $sql = "SELECT doc_id, doc_json" . ($collection === 'addresses' ? ', owner_uid' : '') . " FROM {$table}"
            . ($where ? ' WHERE ' . implode(' AND ', $where) : '');
        $out = [];
        foreach ($this->db->all($sql, $params) as $row) {
            $out[] = [
                'id' => (string) $row['doc_id'],
                'parent' => $collection === 'addresses' ? (string) $row['owner_uid'] : null,
                'data' => Doc::decode((string) $row['doc_json']),
            ];
        }
        return $out;
    }

    /** @return array<string,mixed> */
    private function project(string $collection, array $doc, ?string $parent): array
    {
        $now = $this->clock->now();
        $created = Doc::toDate($doc['createdAt'] ?? null);
        $updated = Doc::toDate($doc['updatedAt'] ?? null) ?? $now;
        $common = ['created_at' => Clock::toSql($created), 'updated_at' => Clock::toSql($updated)];
        switch ($collection) {
            case 'bookings':
                $start = Doc::toDate($doc['startAt'] ?? null) ?? Doc::toDate($doc['scheduledAt'] ?? null);
                $end = Doc::toDate($doc['endAt'] ?? null);
                $email = $doc['contactEmailLower'] ?? Doc::get($doc, 'contact.emailLower') ?? Doc::get($doc, 'contact.email');
                $total = $doc['totalPrice'] ?? $doc['totalAmount'] ?? null;
                $paid = $doc['paidAmount'] ?? $doc['amountPaid'] ?? null;
                return $common + [
                    'user_uid' => is_string($doc['userId'] ?? null) && $doc['userId'] !== '' ? $doc['userId'] : null,
                    'contact_email_lower' => is_string($email) && $email !== '' ? strtolower(trim($email)) : null,
                    'status' => is_string($doc['status'] ?? null) ? substr($doc['status'], 0, 30) : null,
                    'start_at' => Clock::toSql($start),
                    'end_at' => Clock::toSql($end),
                    'business_date' => $start ? $this->clock->dateKey($start) : null,
                    'checkout_request_id' => is_string($doc['checkoutRequestId'] ?? null) ? $doc['checkoutRequestId'] : null,
                    'stripe_session_id' => is_string($doc['stripeSessionId'] ?? null) ? $doc['stripeSessionId'] : null,
                    'deposit_payment_intent_id' => is_string($doc['depositPaymentIntentId'] ?? null) ? $doc['depositPaymentIntentId'] : null,
                    'balance_payment_intent_id' => is_string($doc['balancePaymentIntentId'] ?? null) ? $doc['balancePaymentIntentId'] : null,
                    'total_price' => is_numeric($total) ? round((float) $total, 2) : null,
                    'paid_amount' => is_numeric($paid) ? round((float) $paid, 2) : null,
                ];
            case 'profiles':
                $email = $doc['emailLower'] ?? $doc['email'] ?? null;
                $phone = preg_replace('/\D+/', '', (string) ($doc['phoneNormalized'] ?? $doc['phone'] ?? ''));
                return $common + [
                    'email_lower' => is_string($email) && $email !== '' ? strtolower(trim($email)) : null,
                    'phone_normalized' => $phone !== '' ? substr($phone, 0, 20) : null,
                ];
            case 'addresses':
                return $common + [
                    'sort_order' => is_numeric($doc['sortOrder'] ?? null) ? (int) $doc['sortOrder'] : null,
                    'is_default' => !empty($doc['isDefault']) ? 1 : 0,
                ];
            case 'blackouts':
                return $common + [
                    'start_at' => Clock::toSql(Doc::toDate($doc['startAt'] ?? null)),
                    'end_at' => Clock::toSql(Doc::toDate($doc['endAt'] ?? null)),
                    'all_day' => !empty($doc['allDay']) ? 1 : 0,
                ];
            case 'reviews':
                return $common + [
                    'client_uid' => is_string($doc['clientId'] ?? null) ? $doc['clientId'] : null,
                    'booking_doc_id' => is_string($doc['bookingId'] ?? null) ? $doc['bookingId'] : null,
                    'status' => is_string($doc['status'] ?? null) ? substr($doc['status'], 0, 20) : null,
                    'published_at' => Clock::toSql(Doc::toDate($doc['publishedAt'] ?? null)),
                ];
        }
        return $common;
    }

    public function now(): DateTimeImmutable
    {
        return $this->clock->now();
    }
}

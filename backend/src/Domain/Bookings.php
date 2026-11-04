<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use DateTimeImmutable;
use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;
use SanchezServices\Store\Doc;
use SanchezServices\Store\DocumentStore;
use SanchezServices\Store\QueryEngine;

/**
 * Booking persistence + the server-side booking engine (ports of the Cloud Functions helpers).
 * Every write goes through save()/delete() so the BookingEvents "trigger" always runs.
 */
final class Bookings
{
    public function __construct(
        private Db $db,
        private Clock $clock,
        private Config $config,
        private DocumentStore $store,
        private BookingEvents $events,
        private BlackoutDates $blackoutDates,
    ) {
    }

    public function get(string $id, bool $forUpdate = false): ?array
    {
        return $this->store->get('bookings', $id, null, $forUpdate);
    }

    /**
     * Writes the new document and runs the onWrite hook (emails + flags) in the same transaction.
     * @param array<string,mixed>|null $before
     * @param array<string,mixed> $after
     * @return array<string,mixed> final document
     */
    public function save(string $id, ?array $before, array $after, array $extraColumns = []): array
    {
        return $this->db->transaction(function () use ($id, $before, $after, $extraColumns) {
            $this->store->put('bookings', $id, $after, null, $extraColumns);
            $hookPatch = $this->events->onWrite($id, $before, $after);
            if ($hookPatch) {
                $after = Doc::applyUpdate($after, $hookPatch, $this->clock->now());
                $this->store->put('bookings', $id, $after);
            }
            return $after;
        });
    }

    /** Applies an update() patch to an existing booking (with hook). */
    public function update(string $id, array $patch): array
    {
        return $this->db->transaction(function () use ($id, $patch) {
            $before = $this->get($id, true);
            if ($before === null) {
                throw HttpError::notFound('Booking not found.');
            }
            $after = Doc::applyUpdate($before, $patch, $this->clock->now());
            return $this->save($id, $before, $after);
        });
    }

    public function delete(string $id): void
    {
        $this->db->transaction(function () use ($id) {
            $before = $this->get($id, true);
            if ($before === null) {
                return;
            }
            $this->store->delete('bookings', $id);
            $this->events->onWrite($id, $before, null);
        });
    }

    // ------------------------------------------------------------------ availability

    /** getBlackoutsForRange(): blackouts with startAt <= dayEnd and endAt >= dayStart. */
    public function blackoutsForRange(DateTimeImmutable $dayStart, DateTimeImmutable $dayEnd): array
    {
        $rows = $this->store->scan('blackouts', null, ['sql' => 'start_at <= ?', 'params' => [Clock::toSql($dayEnd)]]);
        $rows = QueryEngine::run($rows, [['startAt', '<=', Doc::ts($dayEnd)]], [], null);
        $out = [];
        foreach ($rows as $r) {
            $w = BlackoutDates::normalizeWindow($r['data']);
            if ($w && $w['endAt'] >= $dayStart) {
                $out[] = $w;
            }
        }
        return $out;
    }

    /**
     * Bookings whose startAt falls in the business day and status blocks capacity.
     * @return list<array{id:string,data:array<string,mixed>}>
     */
    public function blockingForDay(DateTimeImmutable $dayStart, DateTimeImmutable $dayEnd, bool $forUpdate = false): array
    {
        $sql = 'SELECT doc_id, doc_json FROM bookings WHERE start_at >= ? AND start_at <= ? AND status IN (' . implode(',', array_fill(0, count(Slots::BLOCKING_QUERY_STATUSES), '?')) . ')';
        $rows = $this->db->all($sql . ($forUpdate ? ' FOR UPDATE' : ''), array_merge([Clock::toSql($dayStart), Clock::toSql($dayEnd)], Slots::BLOCKING_QUERY_STATUSES));
        $docs = array_map(static fn ($r) => ['id' => (string) $r['doc_id'], 'parent' => null, 'data' => Doc::decode((string) $r['doc_json'])], $rows);
        return QueryEngine::run($docs, [
            ['startAt', '>=', Doc::ts($dayStart)],
            ['startAt', '<=', Doc::ts($dayEnd)],
            ['status', 'in', Slots::BLOCKING_QUERY_STATUSES],
        ], [], null);
    }

    /** @return array{0:?DateTimeImmutable,1:?DateTimeImmutable} start/end with duration fallback (index.js logic) */
    public static function bookingWindow(array $b, bool $useDurationHours = true): array
    {
        $start = Doc::toDate($b['startAt'] ?? null) ?? Doc::toDate($b['scheduledAt'] ?? null);
        $end = Doc::toDate($b['endAt'] ?? null);
        if ($start && !$end) {
            $dm = is_numeric($b['durationMinutes'] ?? null) ? (float) $b['durationMinutes'] : NAN;
            $dh = is_numeric($b['durationHours'] ?? null) ? (float) $b['durationHours'] : NAN;
            $min = is_finite($dm) && $dm > 0 ? $dm : ($useDurationHours && is_finite($dh) && $dh > 0 ? $dh * 60 : 120);
            $end = $start->modify('+' . (int) round($min * 60) . ' seconds');
        }
        return [$start, $end];
    }

    private static function overlaps(DateTimeImmutable $aS, DateTimeImmutable $aE, DateTimeImmutable $bS, DateTimeImmutable $bE): bool
    {
        return $aS < $bE && $aE > $bS;
    }

    public function assertNoBlackout(DateTimeImmutable $start, DateTimeImmutable $end): void
    {
        $key = $this->clock->dateKey($start);
        foreach ($this->blackoutsForRange($this->clock->dayStart($key), $this->clock->dayEnd($key)) as $w) {
            if ($this->blackoutDates->conflicts($w, $start, $end)) {
                throw new HttpError('already-exists', 'Business blackout during that time.');
            }
        }
    }

    /** checkBookingConflict callable */
    public function checkConflict(DateTimeImmutable $start, DateTimeImmutable $end, ?string $ignoreId): array
    {
        $key = $this->clock->dateKey($start);
        $dayStart = $this->clock->dayStart($key);
        $dayEnd = $this->clock->dayEnd($key);
        foreach ($this->blackoutsForRange($dayStart, $dayEnd) as $w) {
            if ($this->blackoutDates->conflicts($w, $start, $end)) {
                return ['conflict' => true, 'with' => $w['allDay'] ? 'Business blackout for this date' : 'Business blackout during that time'];
            }
        }
        foreach ($this->blockingForDay($dayStart, $dayEnd) as $row) {
            if ($ignoreId && $row['id'] === $ignoreId) {
                continue;
            }
            $s = strtolower((string) ($row['data']['status'] ?? ''));
            if (in_array($s, ['cancelled', 'declined', 'completed'], true)) {
                continue;
            }
            // checkBookingConflict reads startAt, then scheduledAt (Timestamp or Date) only
            [$bs, $be] = self::bookingWindow($row['data']);
            if (!$bs || !$be) {
                continue;
            }
            if (self::overlaps($start, $end, $bs, $be)) {
                return ['conflict' => true, 'with' => 'another appointment during that time'];
            }
        }
        return ['conflict' => false];
    }

    /** getDayAvailability callable */
    public function dayAvailability(string $dateKey, array $timeOptions, float $slotCapacity, float $dailyCapacity, float $durationMinutes, ?string $ignoreId): array
    {
        $dayStart = $this->clock->dayStart($dateKey);
        $dayEnd = $this->clock->dayEnd($dateKey);
        $blackouts = $this->blackoutsForRange($dayStart, $dayEnd);
        foreach ($blackouts as $w) {
            if (BlackoutDates::isFullDay($w, $dateKey, $dayStart, $dayEnd)) {
                return [
                    'dateKey' => $dateKey,
                    'fullyBooked' => true,
                    'blockedSlots' => array_values($timeOptions),
                    'slotCounts' => new \stdClass(),
                    'dayCountBlocking' => $dailyCapacity,
                    'unavailableReason' => 'blackout',
                ];
            }
        }
        $blocking = [];
        foreach ($this->blockingForDay($dayStart, $dayEnd) as $row) {
            [$bs, $be] = self::bookingWindow($row['data']);
            if ($bs && $be) {
                $blocking[] = ['id' => $row['id'], 'start' => $bs, 'end' => $be];
            }
        }
        $slotCounts = [];
        $blocked = [];
        foreach ($timeOptions as $label) {
            $hm = is_string($label) ? Slots::parse12h($label) : null;
            if (!$hm) {
                continue;
            }
            $slotStart = $this->clock->at($dateKey, $hm[0], $hm[1]);
            $slotEnd = $slotStart->modify('+' . (int) round($durationMinutes * 60) . ' seconds');
            $count = 0;
            foreach ($blocking as $b) {
                if ($ignoreId && $b['id'] === $ignoreId) {
                    continue;
                }
                if (self::overlaps($slotStart, $slotEnd, $b['start'], $b['end'])) {
                    $count++;
                }
            }
            foreach ($blackouts as $w) {
                if (!$w['allDay'] && self::overlaps($slotStart, $slotEnd, $w['startAt'], $w['endAt'])) {
                    $blocked[$label] = true;
                    break;
                }
            }
            $slotCounts[$label] = $count;
            if ($count >= $slotCapacity) {
                $blocked[$label] = true;
            }
        }
        $dayCount = count(array_filter($blocking, static fn ($b) => !$ignoreId || $b['id'] !== $ignoreId));
        $fully = $dayCount >= $dailyCapacity;
        return [
            'dateKey' => $dateKey,
            'fullyBooked' => $fully,
            'blockedSlots' => array_keys($blocked),
            'slotCounts' => $slotCounts ?: new \stdClass(),
            'dayCountBlocking' => $dayCount,
            'unavailableReason' => $fully ? 'fully_booked' : null,
        ];
    }

    // ------------------------------------------------------------------ reservations

    private function lockDay(string $dateKey): void
    {
        $this->db->run('INSERT IGNORE INTO booking_day_locks (business_date, version, updated_at) VALUES (?, 0, ?)', [$dateKey, Clock::toSql($this->clock->now())]);
        $this->db->one('SELECT version FROM booking_day_locks WHERE business_date = ? FOR UPDATE', [$dateKey]);
    }

    private function bumpDay(string $dateKey): void
    {
        $this->db->run('UPDATE booking_day_locks SET version = version + 1, updated_at = ? WHERE business_date = ?', [Clock::toSql($this->clock->now()), $dateKey]);
    }

    private function countOverlaps(array $conflicts, string $selfId, DateTimeImmutable $start, DateTimeImmutable $end): int
    {
        $n = 0;
        foreach ($conflicts as $row) {
            if ($row['id'] === $selfId) {
                continue;
            }
            [$bs, $be] = self::bookingWindow($row['data'], false); // reservation helpers ignore durationHours
            if ($bs && $be && self::overlaps($start, $end, $bs, $be)) {
                $n++;
            }
        }
        return $n;
    }

    /** createBookingWithAtomicReservation(): false if the doc already exists. */
    public function createWithReservation(string $id, array $doc, DateTimeImmutable $start, DateTimeImmutable $end, array $extraColumns = []): bool
    {
        $key = $this->clock->dateKey($start);
        return $this->db->transaction(function () use ($id, $doc, $start, $end, $key, $extraColumns) {
            $this->lockDay($key);
            if ($this->get($id, true) !== null) {
                return false;
            }
            $conflicts = $this->blockingForDay($this->clock->dayStart($key), $this->clock->dayEnd($key), true);
            if (count($conflicts) >= $this->config->int('business.daily_capacity', 6)) {
                throw new HttpError('resource-exhausted', 'This day is fully booked.');
            }
            if ($this->countOverlaps($conflicts, $id, $start, $end) >= $this->config->int('business.slot_capacity', 1)) {
                throw new HttpError('already-exists', 'another appointment during that time');
            }
            $now = Doc::ts($this->clock->now());
            $doc = Doc::resolveValue($doc, $this->clock->now());
            $doc['createdAt'] ??= $now;
            $doc['updatedAt'] ??= $now;
            $this->save($id, null, $doc, $extraColumns);
            $this->bumpDay($key);
            return true;
        });
    }

    /** rescheduleBookingWithAtomicReservation() */
    public function rescheduleWithReservation(string $id, DateTimeImmutable $start, DateTimeImmutable $end, array $patch): array
    {
        $key = $this->clock->dateKey($start);
        return $this->db->transaction(function () use ($id, $start, $end, $patch, $key) {
            $this->lockDay($key);
            $before = $this->get($id, true);
            if ($before === null) {
                throw HttpError::notFound('Booking not found.');
            }
            $conflicts = $this->blockingForDay($this->clock->dayStart($key), $this->clock->dayEnd($key), true);
            $others = array_values(array_filter($conflicts, static fn ($r) => $r['id'] !== $id));
            if (count($others) >= $this->config->int('business.daily_capacity', 6)) {
                throw new HttpError('resource-exhausted', 'This day is fully booked.');
            }
            if ($this->countOverlaps($conflicts, $id, $start, $end) >= $this->config->int('business.slot_capacity', 1)) {
                throw new HttpError('already-exists', 'Another appointment overlaps that time.');
            }
            $after = Doc::applyUpdate($before, $patch, $this->clock->now());
            $final = $this->save($id, $before, $after);
            $this->bumpDay($key);
            return $final;
        });
    }

    public function clock(): Clock
    {
        return $this->clock;
    }
}

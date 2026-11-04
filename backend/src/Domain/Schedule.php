<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use DateTimeImmutable;
use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;

/**
 * Operating hours, availability and the single conflict check used by EVERY booking create /
 * reschedule / duration change (client or admin). All day math is in the business timezone.
 */
final class Schedule
{
    public const BLOCKING_SQL = "(b.status IN ('pending','confirmed') OR (b.status = 'pending_payment' AND b.hold_expires_at > ?))";

    public function __construct(private Db $db, private Clock $clock, private Config $config)
    {
    }

    public function clock(): Clock
    {
        return $this->clock;
    }

    /** @return list<string> "HH:MM" start times offered to customers on $date */
    public function slotsFor(string $date): array
    {
        $dow = (int) (new DateTimeImmutable($date, $this->clock->tz()))->format('N');
        $slots = $this->config->get('business.slots', [])[$dow] ?? $this->config->get('business.slots', [])[(string) $dow] ?? [];
        return array_values(array_filter((array) $slots, static fn ($s) => is_string($s) && preg_match('/^\d{2}:\d{2}$/', $s)));
    }

    public function at(string $date, string $hm): DateTimeImmutable
    {
        [$h, $m] = array_map('intval', explode(':', $hm));
        return $this->clock->at($date, $h, $m)->setTimezone($this->clock->utc());
    }

    public static function label(string $hm): string
    {
        [$h, $m] = array_map('intval', explode(':', $hm));
        return sprintf('%02d:%02d %s', $h % 12 ?: 12, $m, $h >= 12 ? 'PM' : 'AM');
    }

    public function localHm(DateTimeImmutable $d): string
    {
        return $this->clock->toBusiness($d)->format('H:i');
    }

    /** Locks the given business dates in sorted order (deadlock-free). Must be inside a transaction. */
    public function lockDays(array $dates): void
    {
        $dates = array_values(array_unique($dates));
        sort($dates);
        foreach ($dates as $d) {
            // Lock the existing row; only insert when the day has never been locked before (the insert's
            // gap lock is what deadlocks under heavy concurrency — Db::transaction retries those).
            if ($this->db->one('SELECT version FROM booking_day_locks WHERE business_date = ? FOR UPDATE', [$d]) === null) {
                $this->db->run('INSERT IGNORE INTO booking_day_locks (business_date, version) VALUES (?, 0)', [$d]);
                $this->db->one('SELECT version FROM booking_day_locks WHERE business_date = ? FOR UPDATE', [$d]);
            }
        }
    }

    /** @return list<array{id:int,start:DateTimeImmutable,end:DateTimeImmutable}> */
    public function blockingForDay(string $date, ?int $excludeId = null): array
    {
        $rows = $this->db->all(
            'SELECT b.id, b.start_at, b.end_at FROM bookings b WHERE b.business_date = ? AND ' . self::BLOCKING_SQL . ($excludeId ? ' AND b.id <> ?' : ''),
            array_merge([$date, Clock::toSql($this->clock->now())], $excludeId ? [$excludeId] : [])
        );
        return array_map(static fn ($r) => ['id' => (int) $r['id'], 'start' => Clock::fromSql($r['start_at']), 'end' => Clock::fromSql($r['end_at'])], $rows);
    }

    /** @return list<array{id:int,allDay:bool,start:?DateTimeImmutable,end:?DateTimeImmutable,startDate:?string,endDateExclusive:?string,reason:?string}> */
    public function blackoutsOverlapping(DateTimeImmutable $from, DateTimeImmutable $to): array
    {
        $fromDate = $this->clock->dateKey($from);
        $toDateExcl = $this->occupiedEndDateExclusive($to);
        $rows = $this->db->all(
            'SELECT * FROM blackouts WHERE (all_day = 1 AND start_date < ? AND end_date_exclusive > ?) OR (all_day = 0 AND start_at < ? AND end_at > ?)',
            [$toDateExcl, $fromDate, Clock::toSql($to), Clock::toSql($from)]
        );
        return array_map(static fn ($r) => [
            'id' => (int) $r['id'],
            'allDay' => (int) $r['all_day'] === 1,
            'start' => Clock::fromSql($r['start_at']),
            'end' => Clock::fromSql($r['end_at']),
            'startDate' => $r['start_date'],
            'endDateExclusive' => $r['end_date_exclusive'],
            'reason' => $r['reason'],
        ], $rows);
    }

    /** Exclusive end date of the days an interval touches (an end at exactly local midnight doesn't touch the next day). */
    public function occupiedEndDateExclusive(DateTimeImmutable $end): string
    {
        $local = $this->clock->toBusiness($end);
        $key = $local->format('Y-m-d');
        return $local->format('H:i:s.v') === '00:00:00.000' ? $key : (string) BlackoutDates::addDays($key, 1);
    }

    private static function overlaps(DateTimeImmutable $a, DateTimeImmutable $b, DateTimeImmutable $c, DateTimeImmutable $d): bool
    {
        return $a < $d && $b > $c;
    }

    /**
     * The conflict check. Caller MUST hold lockDays([business date]) in the current transaction.
     * Throws already-exists / resource-exhausted with customer-safe messages.
     */
    public function assertAvailable(DateTimeImmutable $start, DateTimeImmutable $end, ?int $excludeId = null): void
    {
        if ($end <= $start) {
            throw HttpError::invalid('The appointment must end after it starts.');
        }
        $date = $this->clock->dateKey($start);
        if ($this->occupiedEndDateExclusive($end) !== BlackoutDates::addDays($date, 1)) {
            throw HttpError::invalid('Appointments must start and end on the same day.');
        }
        if ($this->blackoutsOverlapping($start, $end)) {
            throw new HttpError('already-exists', 'We are closed during that time. Please choose another time.');
        }
        $blocking = $this->blockingForDay($date, $excludeId);
        if (count($blocking) >= $this->config->int('business.daily_capacity', 6)) {
            throw new HttpError('resource-exhausted', 'That day is fully booked. Please choose another date.');
        }
        $overlapping = count(array_filter($blocking, fn ($b) => self::overlaps($start, $end, $b['start'], $b['end'])));
        if ($overlapping >= $this->config->int('business.slot_capacity', 1)) {
            throw new HttpError('already-exists', 'That time is no longer available. Please choose another time.');
        }
    }

    /** Customer-facing rules: a published slot, enough notice, within the booking horizon. */
    public function assertClientStart(DateTimeImmutable $start): void
    {
        $date = $this->clock->dateKey($start);
        $hm = $this->localHm($start);
        if (!in_array($hm, $this->slotsFor($date), true)) {
            throw HttpError::invalid('Please choose one of the available start times.');
        }
        $now = $this->clock->now();
        if ($start < $now->modify('+' . $this->config->int('business.min_notice_hours', 12) . ' hours')) {
            throw HttpError::invalid('Online bookings need at least ' . $this->config->int('business.min_notice_hours', 12) . " hours' notice. Please call or email us for sooner appointments.");
        }
        if ($start > $now->modify('+' . $this->config->int('business.booking_horizon_days', 120) . ' days')) {
            throw HttpError::invalid('That date is too far ahead to book online.');
        }
    }

    /** Admin rules: any start within the admin window, ending by the window's end. */
    public function assertAdminWindow(DateTimeImmutable $start, DateTimeImmutable $end): void
    {
        $date = $this->clock->dateKey($start);
        $open = $this->at($date, $this->config->string('business.admin_day_start', '07:00'));
        $close = $this->at($date, $this->config->string('business.admin_day_end', '20:00'));
        if ($start < $open || $end > $close) {
            throw HttpError::invalid('Appointments must be between ' . self::label($this->config->string('business.admin_day_start', '07:00')) . ' and ' . self::label($this->config->string('business.admin_day_end', '20:00')) . '.');
        }
    }

    /** Availability for one day (no customer data returned). */
    public function day(string $date, int $durationMinutes, ?int $excludeId = null): array
    {
        $now = $this->clock->now();
        $slots = $this->slotsFor($date);
        $dayStart = $this->clock->dayStart($date)->setTimezone($this->clock->utc());
        $dayEnd = $dayStart->modify('+1 day');
        $blackouts = $this->blackoutsOverlapping($dayStart, $dayEnd->modify('-1 second'));
        $fullDayBlackout = (bool) array_filter($blackouts, static fn ($b) => $b['allDay']);
        $blocking = $this->blockingForDay($date, $excludeId);
        $dailyFull = count($blocking) >= $this->config->int('business.daily_capacity', 6);
        $minStart = $now->modify('+' . $this->config->int('business.min_notice_hours', 12) . ' hours');
        $horizon = $now->modify('+' . $this->config->int('business.booking_horizon_days', 120) . ' days');
        $out = [];
        foreach ($slots as $hm) {
            $s = $this->at($date, $hm);
            $e = $s->modify("+{$durationMinutes} minutes");
            $reason = null;
            if ($s < $minStart) {
                $reason = 'too_soon';
            } elseif ($s > $horizon) {
                $reason = 'too_far';
            } elseif ($fullDayBlackout || array_filter($blackouts, fn ($b) => !$b['allDay'] && self::overlaps($s, $e, $b['start'], $b['end']))) {
                $reason = 'closed';
            } elseif ($dailyFull) {
                $reason = 'fully_booked';
            } elseif (count(array_filter($blocking, fn ($b) => self::overlaps($s, $e, $b['start'], $b['end']))) >= $this->config->int('business.slot_capacity', 1)) {
                $reason = 'booked';
            } elseif ($this->occupiedEndDateExclusive($e) !== BlackoutDates::addDays($date, 1)) {
                $reason = 'too_long';
            }
            $out[] = ['time' => $hm, 'label' => self::label($hm), 'startAt' => Clock::iso($s), 'available' => $reason === null, 'reason' => $reason];
        }
        $dayReason = !$slots ? 'closed' : ($fullDayBlackout ? 'closed' : ($dailyFull ? 'fully_booked' : null));
        return [
            'date' => $date,
            'open' => $slots !== [] && !$fullDayBlackout,
            'reason' => $dayReason,
            'slots' => $out,
            'anyAvailable' => (bool) array_filter($out, static fn ($s) => $s['available']),
        ];
    }
}

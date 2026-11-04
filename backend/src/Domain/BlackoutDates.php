<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use DateTimeImmutable;
use SanchezServices\Clock;
use SanchezServices\Store\Doc;

/**
 * Port of functions/blackoutDateKeys.js + normalizeBlackoutWindow()/isFullDayBlackout().
 * "Local" means the business timezone (Clock), not the server process TZ.
 * All-day blackouts use an EXCLUSIVE endDateKey.
 */
final class BlackoutDates
{
    public function __construct(private Clock $clock)
    {
    }

    public static function isDateKey(mixed $v): bool
    {
        return is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) === 1;
    }

    public static function addDays(string $dateKey, int $days): ?string
    {
        if (!self::isDateKey($dateKey)) {
            return null;
        }
        [$y, $m, $d] = array_map('intval', explode('-', $dateKey));
        // JS Date(y, m-1, d) normalizes overflow (e.g. 2026-02-31 -> 2026-03-03); mktime does too.
        $ts = gmmktime(12, 0, 0, $m, $d + $days, $y);
        return gmdate('Y-m-d', $ts);
    }

    /** @param array<string,mixed> $b */
    public static function endDateKeyExclusive(array $b): ?string
    {
        $end = $b['endDateKey'] ?? null;
        if (self::isDateKey($end)) {
            if ($end === ($b['startDateKey'] ?? null)) {
                return self::addDays($end, 1);
            }
            return $end;
        }
        if (self::isDateKey($b['dateKey'] ?? null)) {
            return self::addDays($b['dateKey'], 1);
        }
        return null;
    }

    /** @param array<string,mixed> $b */
    public static function startDateKey(array $b): ?string
    {
        if (self::isDateKey($b['startDateKey'] ?? null)) {
            return $b['startDateKey'];
        }
        if (self::isDateKey($b['dateKey'] ?? null)) {
            return $b['dateKey'];
        }
        return null;
    }

    /** @param array<string,mixed> $b */
    public static function isFullDayDateBlocked(array $b, string $dateKey): bool
    {
        if (empty($b['allDay']) || !self::isDateKey($dateKey)) {
            return false;
        }
        $start = self::startDateKey($b);
        $end = self::endDateKeyExclusive(array_merge($b, ['startDateKey' => $start]));
        if ($start === null || $end === null) {
            return false;
        }
        return $dateKey >= $start && $dateKey < $end;
    }

    public function occupiedEndDateKeyExclusive(DateTimeImmutable $end): string
    {
        $local = $this->clock->toBusiness($end);
        $key = $local->format('Y-m-d');
        $isMidnight = $local->format('H:i:s.v') === '00:00:00.000';
        return $isMidnight ? $key : (string) self::addDays($key, 1);
    }

    /** @param array<string,mixed> $b */
    public function fullDayOverlapsRange(array $b, DateTimeImmutable $rangeStart, DateTimeImmutable $rangeEnd): bool
    {
        if (empty($b['allDay'])) {
            return false;
        }
        $rangeStartKey = $this->clock->dateKey($rangeStart);
        $rangeEndKey = $this->occupiedEndDateKeyExclusive($rangeEnd);
        $bStart = self::startDateKey($b);
        $bEnd = self::endDateKeyExclusive(array_merge($b, ['startDateKey' => $bStart]));
        if ($bStart === null || $bEnd === null) {
            return false;
        }
        return $rangeStartKey < $bEnd && $rangeEndKey > $bStart;
    }

    /**
     * normalizeBlackoutWindow(): returns null when startAt missing.
     *
     * @param array<string,mixed> $doc
     * @return array{startAt:DateTimeImmutable,endAt:DateTimeImmutable,allDay:bool,startDateKey:?string,endDateKey:?string}|null
     */
    public static function normalizeWindow(array $doc): ?array
    {
        $start = Doc::toDate($doc['startAt'] ?? null);
        $end = Doc::toDate($doc['endAt'] ?? null) ?? $start;
        if (!$start || !$end) {
            return null;
        }
        $startKey = self::startDateKey($doc);
        return [
            'startAt' => $start,
            'endAt' => $end,
            'allDay' => !empty($doc['allDay']),
            'startDateKey' => $startKey,
            'endDateKey' => self::endDateKeyExclusive(array_merge($doc, ['startDateKey' => $startKey])),
        ];
    }

    /** isFullDayBlackout() from index.js. */
    public static function isFullDay(array $w, string $dateKey, DateTimeImmutable $dayStart, DateTimeImmutable $dayEnd): bool
    {
        if ($w['allDay']) {
            return self::isFullDayDateBlocked($w, $dateKey);
        }
        return $w['startAt'] <= $dayStart && $w['endAt'] >= $dayEnd;
    }

    /** Does the blackout window conflict with [start,end)? (assertNoBlackout / checkBookingConflict logic) */
    public function conflicts(array $w, DateTimeImmutable $start, DateTimeImmutable $end): bool
    {
        if ($w['allDay']) {
            return $this->fullDayOverlapsRange($w, $start, $end);
        }
        return $start < $w['endAt'] && $end > $w['startAt'];
    }
}

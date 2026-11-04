<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use DateTimeImmutable;
use SanchezServices\Clock;

final class Slots
{
    /** Must match TIME_OPTIONS in src/pages/BookingPage.jsx and functions/index.js */
    public const TIME_OPTIONS = ['09:00 AM', '11:00 AM', '01:00 PM', '03:00 PM'];

    /** Statuses that block capacity in conflict/availability queries. */
    public const BLOCKING_QUERY_STATUSES = ['pending', 'pending_payment', 'confirmed', 'scheduled'];

    /** @return array{0:int,1:int}|null [hour24, minute] */
    public static function parse12h(string $label): ?array
    {
        if (!preg_match('/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i', trim($label), $m)) {
            return null;
        }
        $h = (int) $m[1];
        $min = (int) $m[2];
        $ampm = strtoupper($m[3]);
        if ($ampm === 'PM' && $h !== 12) {
            $h += 12;
        }
        if ($ampm === 'AM' && $h === 12) {
            $h = 0;
        }
        return [$h, $min];
    }

    public static function to12h(DateTimeImmutable $localTime): string
    {
        $h = (int) $localTime->format('G');
        $m = (int) $localTime->format('i');
        $ampm = $h >= 12 ? 'PM' : 'AM';
        $h = $h % 12 ?: 12;
        return sprintf('%02d:%02d %s', $h, $m, $ampm);
    }

    /** nearestSlotLabel() — evaluated in the business timezone. */
    public static function nearestLabel(Clock $clock, ?DateTimeImmutable $start, mixed $explicit): string
    {
        if (is_string($explicit) && in_array($explicit, self::TIME_OPTIONS, true)) {
            return $explicit;
        }
        $local = $clock->toBusiness($start ?? $clock->now());
        $curr = (int) $local->format('G') * 60 + (int) $local->format('i');
        $best = self::TIME_OPTIONS[0];
        $bestDiff = PHP_INT_MAX;
        foreach (self::TIME_OPTIONS as $opt) {
            [$h, $m] = self::parse12h($opt);
            $diff = abs($h * 60 + $m - $curr);
            if ($diff < $bestDiff) {
                $best = $opt;
                $bestDiff = $diff;
            }
        }
        return $best;
    }

    /** blocksCapacity() from index.js (used by reschedule eligibility). */
    public static function blocksCapacity(mixed $status): bool
    {
        $s = strtolower((string) ($status ?? ''));
        return !in_array($s, ['declined', 'cancelled', 'completed', 'expired', 'refunded'], true);
    }
}

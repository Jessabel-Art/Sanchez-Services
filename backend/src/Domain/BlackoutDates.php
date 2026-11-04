<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

/** Calendar date-key arithmetic (YYYY-MM-DD), timezone-independent. */
final class BlackoutDates
{
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
        return gmdate('Y-m-d', gmmktime(12, 0, 0, $m, $d + $days, $y));
    }
}

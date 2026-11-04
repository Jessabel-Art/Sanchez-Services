<?php
declare(strict_types=1);

namespace SanchezServices;

use DateTimeImmutable;
use DateTimeZone;

/**
 * Time source. All instants are handled as DateTimeImmutable; business-date math
 * (day bounds, date keys, slot times) is done in the business timezone, replacing
 * the Cloud Functions' reliance on the process TZ.
 */
class Clock
{
    private DateTimeZone $tz;
    private DateTimeZone $utc;
    private ?DateTimeImmutable $frozen = null;

    public function __construct(string $businessTimezone = 'America/New_York')
    {
        $this->tz = new DateTimeZone($businessTimezone);
        $this->utc = new DateTimeZone('UTC');
    }

    public function now(): DateTimeImmutable
    {
        return $this->frozen ?? new DateTimeImmutable('now', $this->utc);
    }

    /** Test hook */
    public function freeze(?DateTimeImmutable $at): void
    {
        $this->frozen = $at?->setTimezone($this->utc);
    }

    public function tz(): DateTimeZone
    {
        return $this->tz;
    }

    public function utc(): DateTimeZone
    {
        return $this->utc;
    }

    public function toBusiness(DateTimeImmutable $d): DateTimeImmutable
    {
        return $d->setTimezone($this->tz);
    }

    /** YYYY-MM-DD of the instant in the business timezone (replaces toDateKey/toLocalDateKey). */
    public function dateKey(DateTimeImmutable $d): string
    {
        return $d->setTimezone($this->tz)->format('Y-m-d');
    }

    /** Start of the business day (00:00:00.000 local) for a date key. */
    public function dayStart(string $dateKey): DateTimeImmutable
    {
        return new DateTimeImmutable($dateKey . ' 00:00:00', $this->tz);
    }

    /** End of the business day (23:59:59.999 local) for a date key. */
    public function dayEnd(string $dateKey): DateTimeImmutable
    {
        return (new DateTimeImmutable($dateKey . ' 23:59:59.999', $this->tz));
    }

    /** Local business time on $dateKey at $hour:$minute. */
    public function at(string $dateKey, int $hour, int $minute): DateTimeImmutable
    {
        return new DateTimeImmutable(sprintf('%s %02d:%02d:00', $dateKey, $hour, $minute), $this->tz);
    }

    public static function toSql(?DateTimeImmutable $d): ?string
    {
        return $d?->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.v');
    }

    public static function fromSql(?string $s): ?DateTimeImmutable
    {
        if ($s === null || $s === '') {
            return null;
        }
        return new DateTimeImmutable($s, new DateTimeZone('UTC'));
    }

    public static function iso(DateTimeImmutable $d): string
    {
        return $d->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }
}

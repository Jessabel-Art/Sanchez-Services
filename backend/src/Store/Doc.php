<?php
declare(strict_types=1);

namespace SanchezServices\Store;

use DateTimeImmutable;
use DateTimeZone;
use SanchezServices\Clock;

/**
 * Helpers for Firestore-shaped documents stored as JSON.
 *
 * Wire/storage encoding:
 *   timestamp          {"__ts": "2026-06-17T13:00:00.000Z"}
 *   serverTimestamp()  {"__op": "serverTimestamp"}   (write sentinel)
 *   deleteField()      {"__op": "delete"}            (write sentinel)
 *   increment(n)       {"__op": "increment", "n": n} (write sentinel)
 */
final class Doc
{
    public static function ts(DateTimeImmutable $d): array
    {
        return ['__ts' => Clock::iso($d)];
    }

    public static function isTs(mixed $v): bool
    {
        return is_array($v) && count($v) === 1 && isset($v['__ts']) && is_string($v['__ts']);
    }

    public static function isSentinel(mixed $v): bool
    {
        return is_array($v) && isset($v['__op']) && is_string($v['__op']);
    }

    /** Converts a stored/wire value to a DateTimeImmutable (UTC) when it represents a time. */
    public static function toDate(mixed $v): ?DateTimeImmutable
    {
        if ($v === null || $v === '' || $v === false) {
            return null;
        }
        if ($v instanceof DateTimeImmutable) {
            return $v->setTimezone(new DateTimeZone('UTC'));
        }
        if (self::isTs($v)) {
            $v = $v['__ts'];
        } elseif (is_array($v) && isset($v['seconds']) && is_numeric($v['seconds'])) {
            $ms = (int) $v['seconds'] * 1000 + intdiv((int) ($v['nanoseconds'] ?? 0), 1000000);
            return self::fromMillis($ms);
        } elseif (is_array($v) && isset($v['_seconds']) && is_numeric($v['_seconds'])) {
            $ms = (int) $v['_seconds'] * 1000 + intdiv((int) ($v['_nanoseconds'] ?? 0), 1000000);
            return self::fromMillis($ms);
        }
        if (is_int($v) || is_float($v)) {
            return self::fromMillis((int) $v);
        }
        if (is_string($v)) {
            try {
                $d = new DateTimeImmutable($v);
                return $d->setTimezone(new DateTimeZone('UTC'));
            } catch (\Exception) {
                return null;
            }
        }
        return null;
    }

    public static function fromMillis(int $ms): DateTimeImmutable
    {
        $sec = intdiv($ms, 1000);
        $rem = $ms % 1000;
        if ($rem < 0) {
            $sec -= 1;
            $rem += 1000;
        }
        return (new DateTimeImmutable('@' . $sec))->modify('+' . $rem . ' milliseconds')->setTimezone(new DateTimeZone('UTC'));
    }

    /** @return array{0:bool,1:mixed} [exists, value] */
    public static function getPath(array $doc, string $path): array
    {
        $node = $doc;
        foreach (explode('.', $path) as $part) {
            if (!is_array($node) || self::isTs($node) || !array_key_exists($part, $node)) {
                return [false, null];
            }
            $node = $node[$part];
        }
        return [true, $node];
    }

    public static function get(array $doc, string $path, mixed $default = null): mixed
    {
        [$exists, $v] = self::getPath($doc, $path);
        return $exists ? $v : $default;
    }

    public static function setPath(array &$doc, string $path, mixed $value): void
    {
        $parts = explode('.', $path);
        $node = &$doc;
        foreach ($parts as $i => $part) {
            if ($i === count($parts) - 1) {
                $node[$part] = $value;
                return;
            }
            if (!isset($node[$part]) || !is_array($node[$part]) || self::isTs($node[$part])) {
                $node[$part] = [];
            }
            $node = &$node[$part];
        }
    }

    public static function deletePath(array &$doc, string $path): void
    {
        $parts = explode('.', $path);
        $node = &$doc;
        foreach ($parts as $i => $part) {
            if (!is_array($node) || !array_key_exists($part, $node)) {
                return;
            }
            if ($i === count($parts) - 1) {
                unset($node[$part]);
                return;
            }
            $node = &$node[$part];
        }
    }

    /** Resolves write sentinels inside a value (recursively) for set() payloads. */
    public static function resolveValue(mixed $value, DateTimeImmutable $now, mixed $previous = null): mixed
    {
        if (self::isSentinel($value)) {
            return match ($value['__op']) {
                'serverTimestamp' => self::ts($now),
                'increment' => (is_numeric($previous) ? $previous + 0 : 0) + (is_numeric($value['n'] ?? 0) ? $value['n'] + 0 : 0),
                'delete' => null,
                default => throw new \InvalidArgumentException('Unsupported field operation.'),
            };
        }
        if (is_array($value) && !self::isTs($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                if (self::isSentinel($v) && $v['__op'] === 'delete') {
                    continue;
                }
                $out[$k] = self::resolveValue($v, $now, is_array($previous) ? ($previous[$k] ?? null) : null);
            }
            return $out;
        }
        return $value;
    }

    /**
     * Applies an update() patch. Keys may be dotted field paths (Firestore semantics).
     *
     * @param array<string,mixed> $doc
     * @param array<string,mixed> $patch
     * @return array<string,mixed>
     */
    public static function applyUpdate(array $doc, array $patch, DateTimeImmutable $now): array
    {
        foreach ($patch as $path => $value) {
            $path = (string) $path;
            if (self::isSentinel($value) && $value['__op'] === 'delete') {
                self::deletePath($doc, $path);
                continue;
            }
            self::setPath($doc, $path, self::resolveValue($value, $now, self::get($doc, $path)));
        }
        return $doc;
    }

    /** set(data, {merge:true}) — deep merge of maps. */
    public static function applyMerge(array $doc, array $data, DateTimeImmutable $now): array
    {
        foreach ($data as $key => $value) {
            $key = (string) $key;
            if (self::isSentinel($value) && $value['__op'] === 'delete') {
                unset($doc[$key]);
                continue;
            }
            if (is_array($value) && !self::isTs($value) && !self::isSentinel($value) && !array_is_list($value)
                && isset($doc[$key]) && is_array($doc[$key]) && !self::isTs($doc[$key]) && !array_is_list($doc[$key])) {
                $doc[$key] = self::applyMerge($doc[$key], $value, $now);
                continue;
            }
            $doc[$key] = self::resolveValue($value, $now, $doc[$key] ?? null);
        }
        return $doc;
    }

    /** Keys whose value differs between two documents (top-level, like rules diff().affectedKeys()). */
    public static function affectedKeys(array $before, array $after): array
    {
        $keys = [];
        foreach (array_unique(array_merge(array_keys($before), array_keys($after))) as $k) {
            $inB = array_key_exists($k, $before);
            $inA = array_key_exists($k, $after);
            if ($inB !== $inA || self::encode($before[$k] ?? null) !== self::encode($after[$k] ?? null)) {
                $keys[] = (string) $k;
            }
        }
        return $keys;
    }

    public static function encode(mixed $v): string
    {
        return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
    }

    /** @return array<string,mixed> */
    public static function decode(?string $json): array
    {
        if ($json === null || $json === '') {
            return [];
        }
        $v = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        return is_array($v) ? $v : [];
    }

    /**
     * Firestore value type order: null < bool < number < timestamp < string < bytes < ref < geo < array < map
     */
    private static function typeRank(mixed $v): int
    {
        return match (true) {
            $v === null => 0,
            is_bool($v) => 1,
            is_int($v) || is_float($v) => 2,
            self::isTs($v) => 3,
            is_string($v) => 4,
            is_array($v) && array_is_list($v) => 8,
            default => 9,
        };
    }

    public static function compare(mixed $a, mixed $b): int
    {
        $ra = self::typeRank($a);
        $rb = self::typeRank($b);
        if ($ra !== $rb) {
            return $ra <=> $rb;
        }
        return match ($ra) {
            0 => 0,
            1, 2 => $a <=> $b,
            3 => strcmp(self::normIso($a['__ts']), self::normIso($b['__ts'])),
            4 => strcmp($a, $b),
            8 => self::compareLists($a, $b),
            default => strcmp(self::encode($a), self::encode($b)),
        };
    }

    private static function normIso(string $iso): string
    {
        $d = self::toDate($iso);
        return $d ? Clock::iso($d) : $iso;
    }

    private static function compareLists(array $a, array $b): int
    {
        $n = min(count($a), count($b));
        for ($i = 0; $i < $n; $i++) {
            $c = self::compare($a[$i], $b[$i]);
            if ($c !== 0) {
                return $c;
            }
        }
        return count($a) <=> count($b);
    }

    public static function equals(mixed $a, mixed $b): bool
    {
        return self::typeRank($a) === self::typeRank($b) && self::compare($a, $b) === 0;
    }

    /** Recursively normalizes timestamp-like values ({seconds,nanoseconds}, ISO strings are left alone). */
    public static function normalizeIncoming(mixed $v): mixed
    {
        if (is_array($v)) {
            if (self::isTs($v) || self::isSentinel($v)) {
                if (self::isTs($v)) {
                    $d = self::toDate($v);
                    return $d ? self::ts($d) : null;
                }
                return $v;
            }
            $out = [];
            foreach ($v as $k => $item) {
                $out[$k] = self::normalizeIncoming($item);
            }
            return $out;
        }
        if (is_float($v) && floor($v) === $v && abs($v) < 2 ** 53) {
            // JSON numbers like 2.0 keep float type; fine for Firestore parity.
            return $v;
        }
        return $v;
    }
}

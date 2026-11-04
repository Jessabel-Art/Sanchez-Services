<?php
declare(strict_types=1);

namespace SanchezServices\Http;

/** Typed, validated access to a JSON body / query array. Errors name the offending field. */
final class Input
{
    /** @param array<string,mixed> $data */
    public function __construct(private array $data)
    {
    }

    public static function from(Request $r): self
    {
        return new self($r->method === 'GET' ? $r->query : $r->json());
    }

    public function has(string $k): bool
    {
        return array_key_exists($k, $this->data) && $this->data[$k] !== null;
    }

    public function raw(string $k): mixed
    {
        return $this->data[$k] ?? null;
    }

    private static function fail(string $field, string $msg): HttpError
    {
        return new HttpError('invalid-argument', $msg, ['field' => $field]);
    }

    public function str(string $k, bool $required = false, int $max = 500, ?string $default = null): ?string
    {
        $v = $this->data[$k] ?? null;
        if ($v === null || (is_string($v) && trim($v) === '')) {
            if ($required) {
                throw self::fail($k, "{$k} is required.");
            }
            return $default;
        }
        if (!is_string($v) && !is_int($v) && !is_float($v)) {
            throw self::fail($k, "{$k} must be text.");
        }
        $v = trim((string) $v);
        if (mb_strlen($v) > $max) {
            throw self::fail($k, "{$k} is too long (max {$max} characters).");
        }
        return $v;
    }

    public function email(string $k, bool $required = true): ?string
    {
        $v = $this->str($k, $required, 254);
        if ($v !== null && filter_var($v, FILTER_VALIDATE_EMAIL) === false) {
            throw self::fail($k, 'Enter a valid email address.');
        }
        return $v;
    }

    /** US phone: returns 10 digits (strips +1) or throws. */
    public function phone(string $k, bool $required = false): ?string
    {
        $v = $this->str($k, $required, 40);
        if ($v === null) {
            return null;
        }
        $d = preg_replace('/\D+/', '', $v) ?? '';
        if (strlen($d) === 11 && $d[0] === '1') {
            $d = substr($d, 1);
        }
        if (strlen($d) !== 10) {
            throw self::fail($k, 'Enter a valid 10-digit phone number.');
        }
        return $d;
    }

    public function num(string $k, bool $required = false, float $min = -INF, float $max = INF, ?float $default = null): ?float
    {
        $v = $this->data[$k] ?? null;
        if ($v === null || $v === '') {
            if ($required) {
                throw self::fail($k, "{$k} is required.");
            }
            return $default;
        }
        if (!is_numeric($v)) {
            throw self::fail($k, "{$k} must be a number.");
        }
        $f = (float) $v;
        if (!is_finite($f) || $f < $min || $f > $max) {
            throw self::fail($k, "{$k} is out of range.");
        }
        return $f;
    }

    public function int(string $k, bool $required = false, int $min = PHP_INT_MIN, int $max = PHP_INT_MAX, ?int $default = null): ?int
    {
        $f = $this->num($k, $required, $min, $max, $default === null ? null : (float) $default);
        if ($f === null) {
            return null;
        }
        if (floor($f) !== $f) {
            throw self::fail($k, "{$k} must be a whole number.");
        }
        return (int) $f;
    }

    public function bool(string $k, bool $default = false): bool
    {
        $v = $this->data[$k] ?? null;
        if ($v === null) {
            return $default;
        }
        if (is_bool($v)) {
            return $v;
        }
        $b = filter_var($v, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($b === null) {
            throw self::fail($k, "{$k} must be true or false.");
        }
        return $b;
    }

    /** @param list<string> $allowed */
    public function enum(string $k, array $allowed, bool $required = false, ?string $default = null): ?string
    {
        $v = $this->str($k, $required, 100, $default);
        if ($v !== null && !in_array($v, $allowed, true)) {
            throw self::fail($k, "{$k} must be one of: " . implode(', ', $allowed) . '.');
        }
        return $v;
    }

    public function date(string $k, bool $required = false): ?string
    {
        $v = $this->str($k, $required, 10);
        if ($v === null) {
            return null;
        }
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            throw self::fail($k, "{$k} must be a date (YYYY-MM-DD).");
        }
        return $v;
    }

    /** "HH:MM" 24h. Also accepts "09:00 AM". */
    public function time(string $k, bool $required = false): ?string
    {
        $v = $this->str($k, $required, 10);
        if ($v === null) {
            return null;
        }
        if (preg_match('/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i', $v, $m)) {
            $h = (int) $m[1] % 12 + (strtoupper($m[3]) === 'PM' ? 12 : 0);
            $v = sprintf('%02d:%s', $h, $m[2]);
        }
        if (!preg_match('/^([01]\d|2[0-3]):([0-5]\d)$/', $v)) {
            throw self::fail($k, "{$k} must be a time (HH:MM).");
        }
        return $v;
    }

    public function instant(string $k, bool $required = false): ?\DateTimeImmutable
    {
        $v = $this->str($k, $required, 40);
        if ($v === null) {
            return null;
        }
        try {
            return (new \DateTimeImmutable($v))->setTimezone(new \DateTimeZone('UTC'));
        } catch (\Exception) {
            throw self::fail($k, "{$k} must be an ISO-8601 date-time.");
        }
    }

    /** @return list<string> */
    public function strList(string $k, int $maxItems = 20): array
    {
        $v = $this->data[$k] ?? [];
        if (!is_array($v) || !array_is_list($v) || count($v) > $maxItems) {
            throw self::fail($k, "{$k} must be a list.");
        }
        return array_values(array_unique(array_map(static fn ($x) => trim((string) $x), array_filter($v, 'is_string'))));
    }

    public function sub(string $k, bool $required = false): ?self
    {
        $v = $this->data[$k] ?? null;
        if ($v === null) {
            if ($required) {
                throw self::fail($k, "{$k} is required.");
            }
            return null;
        }
        if (!is_array($v) || array_is_list($v) && $v !== []) {
            throw self::fail($k, "{$k} must be an object.");
        }
        return new self($v);
    }

    /** @return array<string,mixed> */
    public function all(): array
    {
        return $this->data;
    }
}

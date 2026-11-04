<?php
declare(strict_types=1);

namespace SanchezServices\Store;

use SanchezServices\Http\HttpError;

/**
 * Applies Firestore query semantics to in-memory documents:
 *  - a filter on a field excludes documents where the field is missing (including '!=' / 'not-in');
 *  - orderBy excludes documents that lack the ordered field;
 *  - cross-type comparisons follow Firestore type ordering and range filters only match the same type;
 *  - ties are broken by document id.
 */
final class QueryEngine
{
    private const OPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any'];

    /**
     * @param list<array{id:string,parent:?string,data:array<string,mixed>}> $docs
     * @param list<array{0:string,1:string,2:mixed}> $where
     * @param list<array{0:string,1:string}> $orderBy
     * @return list<array{id:string,parent:?string,data:array<string,mixed>}>
     */
    public static function run(array $docs, array $where, array $orderBy, ?int $limit, ?int $limitToLast = null): array
    {
        foreach ($where as $f) {
            if (!is_array($f) || count($f) !== 3 || !is_string($f[0]) || !in_array($f[1], self::OPS, true)) {
                throw HttpError::invalid('Unsupported query filter.');
            }
        }
        $out = array_values(array_filter($docs, static function ($d) use ($where, $orderBy) {
            foreach ($where as [$field, $op, $value]) {
                if (!self::matches($d['data'], $d['id'], $field, $op, $value)) {
                    return false;
                }
            }
            foreach ($orderBy as [$field]) {
                if ($field === '__name__') {
                    continue;
                }
                [$exists] = Doc::getPath($d['data'], $field);
                if (!$exists) {
                    return false;
                }
            }
            return true;
        }));

        // Implicit order: inequality field first if no explicit orderBy (Firestore requirement), then __name__.
        $order = $orderBy;
        if (!$order) {
            foreach ($where as [$field, $op]) {
                if (in_array($op, ['<', '<=', '>', '>=', '!=', 'not-in'], true)) {
                    $order[] = [$field, 'asc'];
                    break;
                }
            }
        }
        usort($out, static function ($a, $b) use ($order) {
            foreach ($order as [$field, $dir]) {
                $va = $field === '__name__' ? $a['id'] : Doc::get($a['data'], $field);
                $vb = $field === '__name__' ? $b['id'] : Doc::get($b['data'], $field);
                $c = Doc::compare($va, $vb);
                if ($c !== 0) {
                    return strtolower((string) $dir) === 'desc' ? -$c : $c;
                }
            }
            $lastDesc = $order && strtolower((string) end($order)[1]) === 'desc';
            $c = strcmp($a['id'], $b['id']);
            return $lastDesc ? -$c : $c;
        });

        if ($limitToLast !== null && $limitToLast >= 0) {
            $out = array_slice($out, max(0, count($out) - $limitToLast));
        } elseif ($limit !== null && $limit >= 0) {
            $out = array_slice($out, 0, $limit);
        }
        return $out;
    }

    private static function matches(array $data, string $id, string $field, string $op, mixed $value): bool
    {
        if ($field === '__name__') {
            [$exists, $actual] = [true, $id];
        } else {
            [$exists, $actual] = Doc::getPath($data, $field);
        }
        if (!$exists) {
            return false;
        }
        switch ($op) {
            case '==':
                return Doc::equals($actual, $value);
            case '!=':
                return $actual !== null && !Doc::equals($actual, $value);
            case 'in':
                if (!is_array($value)) {
                    throw HttpError::invalid("'in' requires an array.");
                }
                foreach ($value as $v) {
                    if (Doc::equals($actual, $v)) {
                        return true;
                    }
                }
                return false;
            case 'not-in':
                if (!is_array($value)) {
                    throw HttpError::invalid("'not-in' requires an array.");
                }
                if ($actual === null) {
                    return false;
                }
                foreach ($value as $v) {
                    if (Doc::equals($actual, $v)) {
                        return false;
                    }
                }
                return true;
            case 'array-contains':
                if (!is_array($actual) || !array_is_list($actual)) {
                    return false;
                }
                foreach ($actual as $item) {
                    if (Doc::equals($item, $value)) {
                        return true;
                    }
                }
                return false;
            case 'array-contains-any':
                if (!is_array($actual) || !array_is_list($actual) || !is_array($value)) {
                    return false;
                }
                foreach ($actual as $item) {
                    foreach ($value as $v) {
                        if (Doc::equals($item, $v)) {
                            return true;
                        }
                    }
                }
                return false;
        }
        // Range: only same-type comparisons match (null/NaN never match ranges).
        if ($actual === null || $value === null || self::rank($actual) !== self::rank($value)) {
            return false;
        }
        $c = Doc::compare($actual, $value);
        return match ($op) {
            '<' => $c < 0,
            '<=' => $c <= 0,
            '>' => $c > 0,
            '>=' => $c >= 0,
            default => false,
        };
    }

    private static function rank(mixed $v): string
    {
        return match (true) {
            is_bool($v) => 'bool',
            is_int($v) || is_float($v) => 'num',
            Doc::isTs($v) => 'ts',
            is_string($v) => 'str',
            is_array($v) && array_is_list($v) => 'arr',
            default => 'map',
        };
    }
}

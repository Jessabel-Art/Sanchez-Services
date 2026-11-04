<?php
declare(strict_types=1);

namespace SanchezServices\Security;

use SanchezServices\Clock;
use SanchezServices\Db;
use SanchezServices\Http\HttpError;

/** Fixed-window counter stored in MySQL (works on shared hosting without APCu/Redis). */
final class RateLimiter
{
    public function __construct(private Db $db, private Clock $clock, private float $multiplier = 1.0)
    {
    }

    /** Throws resource-exhausted when the bucket exceeds $max hits within $windowSeconds. */
    public function hit(string $bucket, int $max, int $windowSeconds): void
    {
        if (!$this->attempt($bucket, $max, $windowSeconds)) {
            throw new HttpError('resource-exhausted', 'Too many requests. Please wait and try again.');
        }
    }

    public function attempt(string $bucket, int $max, int $windowSeconds): bool
    {
        $max = max(1, (int) round($max * $this->multiplier));
        $key = substr(hash('sha256', $bucket), 0, 64) . ':' . substr(preg_replace('/[^a-z0-9:_-]/i', '', $bucket) ?? '', 0, 100);
        $now = $this->clock->now();
        $windowStart = Clock::toSql($now->modify("-{$windowSeconds} seconds"));
        return $this->db->transaction(function () use ($key, $max, $now, $windowStart) {
            $row = $this->db->one('SELECT hits, window_start FROM rate_limits WHERE bucket = ? FOR UPDATE', [$key]);
            if (!$row || (string) $row['window_start'] < (string) $windowStart) {
                $this->db->run(
                    'INSERT INTO rate_limits (bucket, hits, window_start) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE hits = 1, window_start = VALUES(window_start)',
                    [$key, Clock::toSql($now)]
                );
                return true;
            }
            if ((int) $row['hits'] >= $max) {
                return false;
            }
            $this->db->run('UPDATE rate_limits SET hits = hits + 1 WHERE bucket = ?', [$key]);
            return true;
        });
    }

    public function purge(int $olderThanSeconds = 86400): int
    {
        return $this->db->run('DELETE FROM rate_limits WHERE window_start < ?', [Clock::toSql($this->clock->now()->modify("-{$olderThanSeconds} seconds"))])->rowCount();
    }
}

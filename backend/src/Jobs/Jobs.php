<?php
declare(strict_types=1);

namespace SanchezServices\Jobs;

use SanchezServices\App;
use SanchezServices\Clock;

/** Scheduled work. Run `php bin/job.php due` every 5 minutes (cron) or POST /api/jobs/run. */
final class Jobs
{
    /** job => interval minutes */
    public const SCHEDULE = [
        'expire-holds' => 5,
        'reconcile-payments' => 10,
        'reminders' => 60,
        'auto-complete' => 60,
        'send-email' => 5,
        'purge' => 1440,
    ];

    public function __construct(private App $app)
    {
    }

    public function run(string $job): array
    {
        if (!isset(self::SCHEDULE[$job])) {
            throw new \SanchezServices\Http\HttpError('not-found', 'Unknown job.');
        }
        $db = $this->app->db;
        $token = bin2hex(random_bytes(16));
        $now = $this->app->clock->now();
        $db->run('INSERT IGNORE INTO job_runs (job) VALUES (?)', [$job]);
        $claimed = $db->run('UPDATE job_runs SET lock_token = ?, last_started_at = ? WHERE job = ? AND (lock_token IS NULL OR last_started_at < ?)', [$token, Clock::toSql($now), $job, Clock::toSql($now->modify('-30 minutes'))])->rowCount();
        if ($claimed !== 1) {
            return ['job' => $job, 'skipped' => 'already running'];
        }
        $status = 'ok';
        try {
            $result = match ($job) {
                'expire-holds' => $this->expireHolds(),
                'reconcile-payments' => $this->app->checkout->reconcileOpen(),
                'reminders' => ['sent' => $this->app->bookings->sendReminders()],
                'auto-complete' => ['completed' => $this->app->bookings->autoComplete()],
                'send-email' => $this->app->outbox->sendDue(100),
                'purge' => $this->purge(),
            };
        } catch (\Throwable $e) {
            $status = 'error';
            $result = ['error' => $e->getMessage()];
            $this->app->log->error('job failed', ['job' => $job, 'error' => $e->getMessage()]);
        }
        $db->run('UPDATE job_runs SET lock_token = NULL, last_finished_at = ?, last_status = ?, last_result = ? WHERE job = ? AND lock_token = ?', [Clock::toSql($this->app->clock->now()), $status, json_encode($result), $job, $token]);
        $this->app->outbox->flush();
        return ['job' => $job, 'status' => $status, 'result' => $result];
    }

    public function runDue(): array
    {
        $out = [];
        $now = $this->app->clock->now();
        foreach (self::SCHEDULE as $job => $minutes) {
            $row = $this->app->db->one('SELECT last_started_at FROM job_runs WHERE job = ?', [$job]);
            $last = $row && $row['last_started_at'] ? Clock::fromSql($row['last_started_at']) : null;
            if ($last === null || $last <= $now->modify('-' . ($minutes * 60 - 30) . ' seconds')) {
                $out[] = $this->run($job);
            }
        }
        return $out;
    }

    private function expireHolds(): array
    {
        $ids = $this->app->bookings->expireHolds();
        foreach ($ids as $id) {
            $this->app->checkout->expireOpenSessions($id);
        }
        return ['expired' => count($ids)];
    }

    private function purge(): array
    {
        $cut = Clock::toSql($this->app->clock->now()->modify('-30 days'));
        return [
            'sessions' => $this->app->session->purgeExpired(),
            'rateLimits' => $this->app->limiter->purge(),
            'tokens' => $this->app->db->run('DELETE FROM auth_tokens WHERE expires_at < ?', [$cut])->rowCount(),
            'sentEmail' => $this->app->db->run("DELETE FROM email_outbox WHERE status = 'sent' AND sent_at < ?", [Clock::toSql($this->app->clock->now()->modify('-180 days'))])->rowCount(),
        ];
    }
}

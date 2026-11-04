<?php
declare(strict_types=1);

namespace SanchezServices\Jobs;

use SanchezServices\App;
use SanchezServices\Clock;
use SanchezServices\Domain\Bookings;
use SanchezServices\Domain\Payments;
use SanchezServices\Store\Doc;

/**
 * Scheduled jobs (ports of the Pub/Sub scheduled functions) + the manual maintenance sweep.
 * Run via cron (bin/job.php <name>) or the token-protected web endpoint /api/jobs/run.
 */
final class Jobs
{
    public const SCHEDULE = [
        'expire-pending' => 10,      // expireStalePendingPaymentBookings: every 10 minutes
        'recover-payments' => 15,    // recoverWebhookMissedPayments: every 15 minutes
        'send-reminders' => 60,      // sendAppointmentReminders: every 60 minutes
        'send-outbox' => 5,          // retries for queued email
        'purge' => 1440,             // sessions / rate limits housekeeping
    ];

    public function __construct(private App $app)
    {
    }

    /** Runs one job under a DB lock so overlapping cron/web invocations are harmless. */
    public function run(string $job): array
    {
        if (!isset(self::SCHEDULE[$job])) {
            throw new \InvalidArgumentException('Unknown job: ' . $job);
        }
        $db = $this->app->db;
        $token = bin2hex(random_bytes(16));
        $now = $this->app->clock->now();
        $db->run('INSERT IGNORE INTO job_runs (job) VALUES (?)', [$job]);
        $claimed = $db->run(
            'UPDATE job_runs SET lock_token = ?, last_started_at = ? WHERE job = ? AND (lock_token IS NULL OR last_started_at < ?)',
            [$token, Clock::toSql($now), $job, Clock::toSql($now->modify('-30 minutes'))]
        )->rowCount();
        if ($claimed !== 1) {
            return ['job' => $job, 'skipped' => 'already running'];
        }
        $status = 'ok';
        try {
            $result = match ($job) {
                'expire-pending' => $this->expirePending(),
                'recover-payments' => $this->recoverPayments(),
                'send-reminders' => $this->sendReminders(),
                'send-outbox' => $this->app->outbox->sendPending(100),
                'purge' => ['sessions' => $this->app->session->purgeExpired(), 'rateLimits' => $this->app->limiter->purge()],
            };
        } catch (\Throwable $e) {
            $status = 'error';
            $result = ['error' => $e->getMessage()];
            $this->app->log->error('job failed', ['job' => $job, 'error' => $e->getMessage()]);
        } finally {
            $db->run(
                'UPDATE job_runs SET lock_token = NULL, last_finished_at = ?, last_status = ?, last_result = ? WHERE job = ? AND lock_token = ?',
                [Clock::toSql($this->app->clock->now()), $status, json_encode($result ?? null), $job, $token]
            );
        }
        $this->app->outbox->flushRequestQueue();
        return ['job' => $job, 'status' => $status, 'result' => $result];
    }

    /** Runs every job whose interval has elapsed (for a single "every 5 minutes" cron entry). */
    public function runDue(): array
    {
        $out = [];
        $now = $this->app->clock->now();
        foreach (self::SCHEDULE as $job => $minutes) {
            $row = $this->app->db->one('SELECT last_started_at FROM job_runs WHERE job = ?', [$job]);
            $last = $row && $row['last_started_at'] ? Clock::fromSql((string) $row['last_started_at']) : null;
            // 30s slack so a 5-minute cron reliably triggers 10/15-minute jobs.
            if ($last === null || $last <= $now->modify('-' . ($minutes * 60 - 30) . ' seconds')) {
                $out[] = $this->run($job);
            }
        }
        return $out;
    }

    private function pendingPaymentCandidates(\DateTimeImmutable $cutoff, int $limit): array
    {
        $rows = $this->app->db->all(
            "SELECT doc_id, doc_json FROM bookings WHERE status = 'pending_payment' AND created_at <= ? ORDER BY created_at ASC LIMIT " . max(1, $limit),
            [Clock::toSql($cutoff)]
        );
        return array_map(static fn ($r) => ['id' => (string) $r['doc_id'], 'data' => Doc::decode((string) $r['doc_json'])], $rows);
    }

    /** expireStalePendingPaymentBookings */
    public function expirePending(): array
    {
        $ttl = max(1, $this->app->config->int('business.pending_payment_ttl_minutes', 30));
        $batch = max(1, min(500, $this->app->config->int('business.pending_payment_sweep_batch', 200)));
        $cutoff = $this->app->clock->now()->modify("-{$ttl} minutes");
        $scanned = 0;
        $expired = 0;
        $seen = [];
        while (true) {
            $page = array_values(array_filter($this->pendingPaymentCandidates($cutoff, $batch + count($seen)), static fn ($r) => !isset($seen[$r['id']])));
            if (!$page) {
                break;
            }
            foreach ($page as $row) {
                $seen[$row['id']] = true;
                $scanned++;
                $d = $row['data'];
                if (!empty($d['depositPaid']) || !empty($d['depositPaymentIntentId']) || !empty($d['stripePaymentIntentId'])) {
                    continue;
                }
                $now = ['__op' => 'serverTimestamp'];
                $this->app->db->transaction(function () use ($row, $now, &$expired) {
                    $fresh = $this->app->bookings->get($row['id'], true);
                    if (!$fresh || ($fresh['status'] ?? null) !== 'pending_payment') {
                        return;
                    }
                    $this->app->bookings->save($row['id'], $fresh, Doc::applyUpdate($fresh, [
                        'status' => 'expired', 'bookingStatus' => 'expired', 'paymentStatus' => 'expired',
                        'stripeSessionId' => null, 'expiredAt' => $now, 'updatedAt' => $now,
                    ], $this->app->clock->now()));
                    $expired++;
                });
            }
            if (count($page) < $batch) {
                break;
            }
        }
        return ['ttlMinutes' => $ttl, 'scanned' => $scanned, 'expired' => $expired];
    }

    /** recoverWebhookMissedPayments */
    public function recoverPayments(): array
    {
        if (!$this->app->stripe->isConfigured()) {
            return ['skipped' => 'stripe not configured'];
        }
        $minAge = max(1, $this->app->config->int('business.webhook_recovery_min_age_minutes', 10));
        $batch = max(1, min(100, $this->app->config->int('business.webhook_recovery_batch', 50)));
        $rows = $this->pendingPaymentCandidates($this->app->clock->now()->modify("-{$minAge} minutes"), $batch);
        $recovered = $markedExpired = $skipped = 0;
        foreach ($rows as $row) {
            $d = $row['data'];
            if (!empty($d['depositPaymentIntentId']) || !empty($d['depositPaid']) || empty($d['stripeSessionId'])) {
                $skipped++;
                continue;
            }
            try {
                $session = $this->app->stripe->retrieveCheckoutSession((string) $d['stripeSessionId'], ['payment_intent']);
            } catch (\Throwable $e) {
                $this->app->log->error('recoverPayments: session retrieve failed', ['bookingId' => $row['id'], 'error' => $e->getMessage()]);
                $skipped++;
                continue;
            }
            if (($session['payment_status'] ?? null) === 'paid') {
                $pi = $session['payment_intent'] ?? null;
                $piId = is_array($pi) ? (string) ($pi['id'] ?? '') : (string) $pi;
                $md = is_array($session['metadata'] ?? null) ? $session['metadata'] : [];
                try {
                    $mode = Payments::normalizeMode(($md['mode'] ?? '') !== '' ? $md['mode'] : 'deposit');
                    if ($this->app->payments->applySuccessfulPayment($row['id'], $mode, $piId, $md, ['webhookRecoveredAt' => ['__op' => 'serverTimestamp']], 'stripe_recovery')) {
                        $recovered++;
                    }
                } catch (\Throwable $e) {
                    $this->app->log->error('recoverPayments: recovery failed', ['bookingId' => $row['id'], 'error' => $e->getMessage()]);
                }
            } elseif (($session['status'] ?? null) === 'expired') {
                $this->app->db->transaction(function () use ($row, &$markedExpired) {
                    $fresh = $this->app->bookings->get($row['id'], true);
                    if (!$fresh || !empty($fresh['depositPaymentIntentId']) || !empty($fresh['stripePaymentIntentId']) || !empty($fresh['depositPaid']) || ($fresh['status'] ?? null) !== 'pending_payment') {
                        return;
                    }
                    $now = ['__op' => 'serverTimestamp'];
                    $this->app->bookings->save($row['id'], $fresh, Doc::applyUpdate($fresh, [
                        'status' => 'expired', 'bookingStatus' => 'expired', 'paymentStatus' => 'expired',
                        'stripeSessionId' => null, 'expiredAt' => $now, 'updatedAt' => $now,
                    ], $this->app->clock->now()));
                    $markedExpired++;
                });
            } else {
                $skipped++;
            }
        }
        return ['scanned' => count($rows), 'recovered' => $recovered, 'markedExpired' => $markedExpired, 'skipped' => $skipped];
    }

    /** sendAppointmentReminders */
    public function sendReminders(): array
    {
        $now = $this->app->clock->now();
        $rows = $this->app->db->all(
            "SELECT doc_id, doc_json FROM bookings WHERE status = 'confirmed' AND start_at >= ? AND start_at <= ? ORDER BY start_at ASC LIMIT 250",
            [Clock::toSql($now->modify('+23 hours')), Clock::toSql($now->modify('+49 hours'))]
        );
        $checked = $sent48 = $sent24 = $skipped = 0;
        foreach ($rows as $r) {
            $checked++;
            $id = (string) $r['doc_id'];
            $this->app->db->transaction(function () use ($id, $now, &$sent48, &$sent24, &$skipped) {
                $b = $this->app->bookings->get($id, true);
                $start = $b ? Doc::toDate($b['startAt'] ?? null) : null;
                $status = strtolower(trim((string) ($b['status'] ?? '')));
                $pay = strtolower(trim((string) ($b['paymentStatus'] ?? '')));
                if (!$b || $status !== 'confirmed' || in_array($pay, ['refunded', 'expired'], true) || !$start) {
                    $skipped++;
                    return;
                }
                $hours = ((int) $start->format('Uv') - (int) $now->format('Uv')) / 3600000;
                $due48 = $hours > 47 && $hours <= 49 && empty($b['reminder48SentAt']);
                $due24 = $hours > 23 && $hours <= 25 && empty($b['reminder24SentAt']);
                if (!$due48 && !$due24) {
                    $skipped++;
                    return;
                }
                $h = $due48 ? 48 : 24;
                $mail = $this->app->events->reminderMail($id, $b, $h);
                if (!$mail) {
                    $skipped++;
                    return;
                }
                $this->app->outbox->enqueue($mail);
                $this->app->bookings->save($id, $b, Doc::applyUpdate($b, [
                    ($h === 48 ? 'reminder48SentAt' : 'reminder24SentAt') => ['__op' => 'serverTimestamp'],
                    'updatedAt' => ['__op' => 'serverTimestamp'],
                ], $this->app->clock->now()));
                $h === 48 ? $sent48++ : $sent24++;
            });
        }
        return compact('checked', 'sent48', 'sent24', 'skipped') + ['sentTotal' => $sent48 + $sent24];
    }

    /** sweepCompleteBookings (manual admin tool; behavior preserved, including hard deletes). */
    public function sweep(int $graceMs, bool $dryRun, bool $removeTest, bool $removeCancelledDeclined): array
    {
        $now = (int) $this->app->clock->now()->format('Uv');
        $auto = $delTest = $delCancelled = [];
        $rows = $this->app->db->all('SELECT doc_id, doc_json FROM bookings');
        $this->app->db->transaction(function () use ($rows, $now, $graceMs, $dryRun, $removeTest, $removeCancelledDeclined, &$auto, &$delTest, &$delCancelled) {
            foreach ($rows as $r) {
                $id = (string) $r['doc_id'];
                $d = Doc::decode((string) $r['doc_json']);
                $statusRaw = $d['status'] ?? '';
                $status = strtolower((string) $statusRaw);
                $isTest = str_contains(strtolower((string) ($d['notes'] ?? '')), 'test');
                if ($removeTest && $isTest) {
                    $delTest[] = ['id' => $id, 'beforeStatus' => $statusRaw ?: null, 'reason' => 'notes contains "test"'];
                    if (!$dryRun) {
                        $this->app->bookings->delete($id);
                    }
                    continue;
                }
                if ($removeCancelledDeclined && in_array($status, ['cancelled', 'declined'], true)) {
                    $delCancelled[] = ['id' => $id, 'beforeStatus' => $statusRaw ?: null, 'reason' => 'cancelled/declined status'];
                    if (!$dryRun) {
                        $this->app->bookings->delete($id);
                    }
                    continue;
                }
                if ($status === 'confirmed') {
                    $end = Doc::toDate($d['endAt'] ?? null);
                    if ($end && $now - (int) $end->format('Uv') >= $graceMs) {
                        $auto[] = ['id' => $id, 'beforeStatus' => $statusRaw ?: null, 'afterStatus' => 'completed', 'endAt' => $d['endAt'] ?? null];
                        if (!$dryRun) {
                            $this->app->bookings->update($id, ['status' => 'completed', 'updatedAt' => ['__op' => 'serverTimestamp']]);
                        }
                    }
                }
            }
        });
        return [
            'ok' => true,
            'dryRun' => $dryRun,
            'updated' => count($auto),
            'autoCompletedCount' => count($auto),
            'deletedTestBookingsCount' => count($delTest),
            'deletedCancelledBookingsCount' => count($delCancelled),
            'logs' => ['autoCompleted' => $auto, 'deletedTestBookings' => $delTest, 'deletedCancelledBookings' => $delCancelled],
        ];
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use SanchezServices\Clock;
use SanchezServices\Db;
use SanchezServices\Infra\Logger;
use SanchezServices\Infra\Mailer;

/**
 * Transactional email queue. Rows are written inside the same DB transaction as the change that
 * caused them; delivery happens after the response (and is retried by cron). The dedupe key makes
 * every notification exactly-once per recipient and event.
 */
final class Outbox
{
    /** @var list<int> */
    private array $pending = [];

    /**
     * @param list<string>|null $allowlist null = deliver to anyone (production default). A list = deliver only to these
     *        addresses or "@domain" entries; everything else is kept as 'suppressed' (staging: empty list = send nothing).
     */
    public function __construct(private Db $db, private Clock $clock, private Mailer $mailer, private Logger $log, private string $replyTo = '', private ?array $allowlist = null)
    {
    }

    /** @return bool false when an identical notification was already queued */
    public function queue(string $dedupeKey, string $kind, string $to, string $subject, string $html, string $text, ?int $bookingId = null, ?\DateTimeImmutable $sendAfter = null): bool
    {
        if (filter_var($to, FILTER_VALIDATE_EMAIL) === false) {
            $this->log->warning('email skipped: invalid recipient', ['kind' => $kind]);
            return false;
        }
        $now = Clock::toSql($this->clock->now());
        $n = $this->db->run(
            'INSERT IGNORE INTO email_outbox (dedupe_key, booking_id, kind, to_email, reply_to, subject, html, text_body, status, send_after, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'queued\', ?, ?)',
            [substr($dedupeKey . '|' . strtolower($to), 0, 190), $bookingId, $kind, $to, $this->replyTo ?: null, mb_substr($subject, 0, 500), $html, $text, $sendAfter ? Clock::toSql($sendAfter) : $now, $now]
        )->rowCount();
        if ($n === 1) {
            $this->pending[] = (int) $this->db->pdo()->lastInsertId();
        }
        return $n === 1;
    }

    /** Sends what this request queued (called after commit / after the response). */
    public function flush(): void
    {
        $ids = $this->pending;
        $this->pending = [];
        foreach ($ids as $id) {
            $this->sendOne($id);
        }
    }

    public function discardPending(): void
    {
        $this->pending = [];
    }

    public function sendDue(int $limit = 50): array
    {
        $now = Clock::toSql($this->clock->now());
        $this->db->run("UPDATE email_outbox SET status = 'failed', last_error = 'interrupted while sending' WHERE status = 'sending' AND send_after < ?", [Clock::toSql($this->clock->now()->modify('-15 minutes'))]);
        $rows = $this->db->all("SELECT id FROM email_outbox WHERE status IN ('queued','failed') AND attempts < 8 AND send_after <= ? ORDER BY id LIMIT " . max(1, min(500, $limit)), [$now]);
        $sent = $failed = 0;
        foreach ($rows as $r) {
            $this->sendOne((int) $r['id']) ? $sent++ : $failed++;
        }
        return ['sent' => $sent, 'failed' => $failed];
    }

    public function retry(int $id): void
    {
        $this->db->run("UPDATE email_outbox SET status = 'queued', attempts = 0, send_after = ? WHERE id = ? AND status = 'failed'", [Clock::toSql($this->clock->now()), $id]);
        $this->sendOne($id);
    }

    private function sendOne(int $id): bool
    {
        $claimed = $this->db->run(
            "UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, send_after = ? WHERE id = ? AND status IN ('queued','failed') AND send_after <= ?",
            [Clock::toSql($this->clock->now()), $id, Clock::toSql($this->clock->now()->modify('+1 second'))]
        )->rowCount();
        if ($claimed !== 1) {
            return false;
        }
        $row = $this->db->one('SELECT * FROM email_outbox WHERE id = ?', [$id]);
        if (!$this->allowed((string) $row['to_email'])) {
            $this->db->run("UPDATE email_outbox SET status = 'suppressed', last_error = 'recipient not on mail.recipient_allowlist' WHERE id = ?", [$id]);
            return false;
        }
        try {
            $this->mailer->send([(string) $row['to_email']], $row['reply_to'], (string) $row['subject'], (string) $row['html'], (string) $row['text_body']);
            $this->db->run("UPDATE email_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?", [Clock::toSql($this->clock->now()), $id]);
            return true;
        } catch (\Throwable $e) {
            $backoff = min(240, 2 ** (int) $row['attempts']);
            $this->db->run("UPDATE email_outbox SET status = 'failed', last_error = ?, send_after = ? WHERE id = ?", [mb_substr($e->getMessage(), 0, 1000), Clock::toSql($this->clock->now()->modify("+{$backoff} minutes")), $id]);
            $this->log->error('email send failed', ['outboxId' => $id, 'error' => $e->getMessage()]);
            return false;
        }
    }

    public function allowed(string $email): bool
    {
        if ($this->allowlist === null) {
            return true;
        }
        $email = strtolower(trim($email));
        foreach ($this->allowlist as $entry) {
            $entry = strtolower(trim((string) $entry));
            if ($entry !== '' && ($email === $entry || ($entry[0] === '@' && str_ends_with($email, $entry)))) {
                return true;
            }
        }
        return false;
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use SanchezServices\Clock;
use SanchezServices\Db;
use SanchezServices\Infra\Logger;
use SanchezServices\Infra\Mailer;
use SanchezServices\Store\DocumentStore;

/** Replaces the Firestore `mail` collection + Trigger Email extension. */
final class Outbox
{
    /** @var list<int> ids queued during this request (sent after the response) */
    private array $queuedThisRequest = [];

    public function __construct(private Db $db, private Clock $clock, private Mailer $mailer, private Logger $log)
    {
    }

    /**
     * Accepts the same shape as a Firestore `mail` document:
     * { to: string[]|string, replyTo?, message: {subject, html?, text?}, meta?: {...} }
     *
     * @param array<string,mixed> $mail
     */
    public function enqueue(array $mail): int
    {
        $to = $mail['to'] ?? [];
        if (is_string($to)) {
            $to = [$to];
        }
        $to = array_values(array_filter(array_map(static fn ($x) => trim((string) $x), (array) $to), static fn ($x) => filter_var($x, FILTER_VALIDATE_EMAIL) !== false));
        $msg = is_array($mail['message'] ?? null) ? $mail['message'] : [];
        $subject = trim((string) ($msg['subject'] ?? ''));
        if (!$to || $subject === '') {
            throw new \InvalidArgumentException('Mail requires at least one valid recipient and a subject.');
        }
        $meta = is_array($mail['meta'] ?? null) ? $mail['meta'] : [];
        $replyTo = isset($mail['replyTo']) && filter_var($mail['replyTo'], FILTER_VALIDATE_EMAIL) ? (string) $mail['replyTo'] : null;
        $now = Clock::toSql($this->clock->now());
        $id = $this->db->insert('email_outbox', [
            'doc_id' => DocumentStore::newId(),
            'booking_doc_id' => isset($meta['bookingId']) && is_string($meta['bookingId']) ? substr($meta['bookingId'], 0, 160) : null,
            'kind' => isset($meta['kind']) ? substr((string) $meta['kind'], 0, 60) : (isset($meta['type']) ? substr((string) $meta['type'], 0, 60) : null),
            'to_json' => json_encode($to, JSON_THROW_ON_ERROR),
            'reply_to' => $replyTo,
            'subject' => mb_substr($subject, 0, 500),
            'html' => isset($msg['html']) ? (string) $msg['html'] : null,
            'text_body' => isset($msg['text']) ? (string) $msg['text'] : null,
            'meta_json' => json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR),
            'status' => 'queued',
            'send_after' => $now,
            'created_at' => $now,
        ]);
        $this->queuedThisRequest[] = $id;
        return $id;
    }

    /** Sends mail queued during this request (call after the DB commit / response). */
    public function flushRequestQueue(): void
    {
        $ids = $this->queuedThisRequest;
        $this->queuedThisRequest = [];
        foreach ($ids as $id) {
            $this->sendOne($id);
        }
    }

    /** Cron: send queued/failed messages with backoff. */
    public function sendPending(int $limit = 50): array
    {
        $now = Clock::toSql($this->clock->now());
        $rows = $this->db->all(
            "SELECT id FROM email_outbox WHERE status IN ('queued','failed') AND attempts < 8 AND send_after <= ? ORDER BY id LIMIT " . max(1, min(500, $limit)),
            [$now]
        );
        $sent = 0;
        $failed = 0;
        foreach ($rows as $r) {
            $this->sendOne((int) $r['id']) ? $sent++ : $failed++;
        }
        // Recover rows stuck in 'sending' (process died mid-send) after 15 minutes.
        $this->db->run(
            "UPDATE email_outbox SET status = 'failed', last_error = 'stuck in sending' WHERE status = 'sending' AND send_after < ?",
            [Clock::toSql($this->clock->now()->modify('-15 minutes'))]
        );
        return ['sent' => $sent, 'failed' => $failed];
    }

    private function sendOne(int $id): bool
    {
        // Claim atomically so concurrent cron + inline sends never double-send.
        $claimed = $this->db->run(
            "UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, send_after = ? WHERE id = ? AND status IN ('queued','failed')",
            [Clock::toSql($this->clock->now()), $id]
        )->rowCount();
        if ($claimed !== 1) {
            return false;
        }
        $row = $this->db->one('SELECT * FROM email_outbox WHERE id = ?', [$id]);
        if (!$row) {
            return false;
        }
        try {
            $this->mailer->send(
                json_decode((string) $row['to_json'], true) ?: [],
                $row['reply_to'] !== null ? (string) $row['reply_to'] : null,
                (string) $row['subject'],
                $row['html'] !== null ? (string) $row['html'] : null,
                $row['text_body'] !== null ? (string) $row['text_body'] : null
            );
            $this->db->run("UPDATE email_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?", [Clock::toSql($this->clock->now()), $id]);
            return true;
        } catch (\Throwable $e) {
            $attempts = (int) $row['attempts'];
            $backoffMinutes = min(240, 2 ** $attempts);
            $this->db->run(
                "UPDATE email_outbox SET status = 'failed', last_error = ?, send_after = ? WHERE id = ?",
                [mb_substr($e->getMessage(), 0, 1000), Clock::toSql($this->clock->now()->modify("+{$backoffMinutes} minutes")), $id]
            );
            $this->log->error('mail send failed', ['outboxId' => $id, 'attempts' => $attempts, 'error' => $e->getMessage()]);
            return false;
        }
    }
}

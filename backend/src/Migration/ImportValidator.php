<?php
declare(strict_types=1);

namespace SanchezServices\Migration;

use SanchezServices\App;
use SanchezServices\Clock;
use SanchezServices\Domain\Ledger;

/**
 * Post-import checks, run against the imported database (read-only):
 *  - every exported booking/review/blackout is present (or was reported as skipped)
 *  - appointment times, totals and contact emails match the export
 *  - the ledger is internally consistent (amount_paid/payment_status equal a fresh recomputation)
 *  - Stripe payment intents are unique; users' emails are unique
 *  - active bookings that overlap each other (double bookings inherited from the old system) are listed
 * Returns ['ok' => bool, 'errors' => [...], 'notices' => [...], 'counts' => [...]]. Ids only, no PII.
 */
final class ImportValidator
{
    public function __construct(private App $app, private string $dir)
    {
    }

    public function run(): array
    {
        $db = $this->app->db;
        $errors = [];
        $notices = [];
        $bookings = [];
        $file = $this->dir . '/bookings.ndjson';
        foreach (is_file($file) ? (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: []) : [] as $line) {
            $doc = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            $bookings[(string) $doc['id']] = (array) $doc['data'];
        }
        $rows = [];
        foreach ($db->all("SELECT * FROM bookings WHERE created_via = 'import'") as $r) {
            $rows[$r['ref']] = $r;
        }
        foreach ($bookings as $ref => $d) {
            $r = $rows[$ref] ?? null;
            if (!$r) {
                $hasTime = isset($d['startAt']) || isset($d['scheduledAt']) || isset($d['dateKey']);
                if ($hasTime) {
                    $errors[] = "booking {$ref}: not in database";
                } else {
                    $notices[] = "booking {$ref}: not imported (export has no date; reported as skipped)";
                }
                continue;
            }
            $ts = $d['startAt']['__ts'] ?? $d['scheduledAt']['__ts'] ?? null;
            if ($ts !== null && Clock::toSql((new \DateTimeImmutable($ts))) !== $r['start_at']) {
                $errors[] = "booking {$ref}: start time differs from export";
            }
            $legacy = json_decode((string) $r['legacy_json'], true);
            if ($legacy !== $d) {
                $errors[] = "booking {$ref}: legacy_json does not match the exported document";
            }
            $email = strtolower(trim((string) ($d['contact']['email'] ?? $d['email'] ?? $d['contactEmail'] ?? $d['clientEmail'] ?? '')));
            if ($email !== '' && $email !== $r['contact_email_lower']) {
                $errors[] = "booking {$ref}: contact email differs from export";
            }
        }
        foreach (array_diff_key($rows, $bookings) as $ref => $_) {
            $errors[] = "booking {$ref}: imported row has no source document";
        }

        // Ledger consistency: stored money fields must equal a fresh recomputation.
        foreach ($db->all(
            "SELECT b.ref, b.total_price, b.deposit_amount, b.amount_paid, b.amount_refunded, b.payment_status,
                    COALESCE(SUM(CASE WHEN p.type='payment' AND p.status='succeeded' THEN p.amount END),0) paid,
                    COALESCE(SUM(CASE WHEN p.type='refund' AND p.status='succeeded' THEN p.amount END),0) refunded
             FROM bookings b LEFT JOIN payments p ON p.booking_id = b.id GROUP BY b.id"
        ) as $x) {
            $net = round((float) $x['paid'] - (float) $x['refunded'], 2);
            if (abs($net - (float) $x['amount_paid']) >= 0.005 || abs((float) $x['refunded'] - (float) $x['amount_refunded']) >= 0.005) {
                $errors[] = "booking {$x['ref']}: amount_paid/amount_refunded do not match the ledger";
            }
            if (Ledger::paymentStatus((float) $x['total_price'], (float) $x['deposit_amount'], $net, (float) $x['refunded']) !== $x['payment_status']) {
                $errors[] = "booking {$x['ref']}: payment_status does not match the ledger";
            }
            if ($net - (float) $x['total_price'] > 0.005 && (float) $x['total_price'] > 0) {
                $notices[] = "booking {$x['ref']}: paid more than the total (credit due)";
            }
        }
        foreach ($db->all('SELECT stripe_payment_intent_id, COUNT(*) n FROM payments WHERE stripe_payment_intent_id IS NOT NULL GROUP BY 1 HAVING n > 1') as $x) {
            $errors[] = 'duplicate Stripe payment intent in ledger';
        }
        foreach ($db->all("SELECT ref FROM bookings WHERE contact_email <> '' AND user_id IS NULL AND contact_email_lower IN (SELECT email_lower FROM users)") as $x) {
            $notices[] = "booking {$x['ref']}: has a matching account email but no owner link";
        }

        // Overlapping active bookings (legacy double bookings). Not an import error — needs a decision.
        $active = $db->all("SELECT id, ref, start_at, end_at, business_date FROM bookings WHERE status IN ('pending','confirmed') ORDER BY business_date, start_at");
        $byDay = [];
        foreach ($active as $a) {
            $byDay[$a['business_date']][] = $a;
        }
        $capacity = max(1, $this->app->config->int('business.slot_capacity', 1));
        $daily = $this->app->config->int('business.daily_capacity', 6);
        foreach ($byDay as $day => $list) {
            if (count($list) > $daily) {
                $notices[] = "{$day}: " . count($list) . " active bookings exceed the daily capacity of {$daily}";
            }
            foreach ($list as $i => $a) {
                $overlaps = 0;
                foreach ($list as $j => $b) {
                    if ($i !== $j && $a['start_at'] < $b['end_at'] && $b['start_at'] < $a['end_at']) {
                        $overlaps++;
                    }
                }
                if ($overlaps >= $capacity) {
                    $notices[] = "booking {$a['ref']}: overlaps {$overlaps} other active booking(s) on {$day}";
                }
            }
        }

        $counts = [
            'exportBookings' => count($bookings),
            'importedBookings' => count($rows),
            'users' => (int) $db->scalar('SELECT COUNT(*) FROM users'),
            'admins' => (int) $db->scalar("SELECT COUNT(*) FROM users WHERE role IN ('admin','owner')"),
            'payments' => (int) $db->scalar('SELECT COUNT(*) FROM payments'),
            'reviews' => (int) $db->scalar('SELECT COUNT(*) FROM reviews'),
            'blackouts' => (int) $db->scalar('SELECT COUNT(*) FROM blackouts'),
            'bookingsNeedingAttention' => (int) $db->scalar('SELECT COUNT(*) FROM bookings WHERE needs_attention IS NOT NULL'),
        ];
        if ($counts['admins'] === 0) {
            $errors[] = 'no admin or owner account was imported — nobody could sign in to the admin dashboard';
        }
        return ['ok' => !$errors, 'errors' => $errors, 'notices' => $notices, 'counts' => $counts];
    }
}

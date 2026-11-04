<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Db;

/** All customer/admin notifications. One template set, server-side only, exactly-once via Outbox. */
final class Notifier
{
    public function __construct(private Db $db, private Clock $clock, private Config $config, private Outbox $outbox)
    {
    }

    private static function h(?string $v): string
    {
        return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    private function url(string $path): string
    {
        return rtrim($this->config->string('app.url'), '/') . $path;
    }

    private static function money(float $v): string
    {
        return '$' . number_format($v, 2);
    }

    /** "Tuesday, December 15, 2026 at 9:00 AM" */
    public function when(array $b): string
    {
        $l = $this->clock->toBusiness(Clock::fromSql($b['start_at']));
        return $l->format('l, F j, Y') . ' at ' . $l->format('g:i A');
    }

    private function addressLine(array $b): string
    {
        return trim(implode(', ', array_filter([$b['address_line1'], $b['address_line2'], $b['address_city'], trim($b['address_state'] . ' ' . $b['address_zip'])])));
    }

    /** @return list<string> */
    public function adminRecipients(): array
    {
        $list = $this->config->list('business.admin_notification_emails');
        if (!$list) {
            $list = array_column($this->db->all("SELECT email FROM users WHERE role IN ('owner','admin') AND is_active = 1"), 'email');
        }
        return array_values(array_unique(array_filter($list)));
    }

    /** Wraps content in the branded layout. @param list<array{0:string,1:string}> $rows */
    private function render(string $title, string $intro, array $rows, ?array $cta, string $outro = ''): array
    {
        $name = $this->config->string('business.name', 'Sanchez Services');
        $table = '';
        $textRows = '';
        foreach ($rows as [$k, $v]) {
            $table .= '<tr><td style="padding:6px 12px 6px 0;color:#6b4f63;white-space:nowrap;vertical-align:top">' . self::h($k) . '</td><td style="padding:6px 0;color:#2b0f25">' . nl2br(self::h($v)) . '</td></tr>';
            $textRows .= "{$k}: {$v}\n";
        }
        $button = $cta ? '<p style="margin:24px 0"><a href="' . self::h($cta[1]) . '" style="background:#c9a227;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600;display:inline-block">' . self::h($cta[0]) . '</a></p>' : '';
        $contact = $this->config->string('business.email');
        $phone = $this->config->string('business.phone');
        $footer = self::h($name) . ($contact ? ' · ' . self::h($contact) : '') . ($phone ? ' · ' . self::h($phone) : '');
        $html = '<!doctype html><html><body style="margin:0;background:#fdf2f6;font-family:Arial,Helvetica,sans-serif">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">'
            . '<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px" cellpadding="0" cellspacing="0"><tr><td>'
            . '<div style="color:#431039;font-size:20px;font-weight:700;margin-bottom:4px">' . self::h($name) . '</div>'
            . '<h1 style="color:#431039;font-size:22px;margin:16px 0 8px">' . self::h($title) . '</h1>'
            . '<p style="color:#2b0f25;font-size:15px;line-height:1.5">' . nl2br(self::h($intro)) . '</p>'
            . ($table ? '<table role="presentation" style="font-size:14px;margin-top:8px">' . $table . '</table>' : '')
            . $button
            . ($outro !== '' ? '<p style="color:#2b0f25;font-size:14px;line-height:1.5">' . nl2br(self::h($outro)) . '</p>' : '')
            . '<p style="color:#8a7183;font-size:12px;margin-top:28px">' . $footer . '</p>'
            . '</td></tr></table></td></tr></table></body></html>';
        $text = "{$title}\n\n{$intro}\n\n" . $textRows . ($cta ? "\n{$cta[0]}: {$cta[1]}\n" : '') . ($outro !== '' ? "\n{$outro}\n" : '') . "\n— {$name}" . ($contact ? " · {$contact}" : '') . ($phone ? " · {$phone}" : '');
        return [$html, $text];
    }

    private function bookingRows(array $b, bool $withMoney = true): array
    {
        $rows = [
            ['Service', $b['service_name']],
            ['When', $this->when($b)],
            ['Address', $this->addressLine($b)],
            ['Booking #', (string) $b['invoice_number']],
        ];
        if ($withMoney) {
            $total = (float) $b['total_price'];
            $paid = (float) $b['amount_paid'];
            $rows[] = ['Total', self::money($total)];
            $rows[] = ['Paid', self::money($paid)];
            $rows[] = ['Balance due', self::money(max(0, $total - $paid))];
        }
        return $rows;
    }

    private function firstName(array $b): string
    {
        $n = trim((string) $b['contact_name']);
        return $n !== '' ? explode(' ', $n)[0] : 'there';
    }

    private function toClient(array $b, string $kind, string $eventKey, string $subject, string $title, string $intro, array $rows, ?array $cta, string $outro = ''): void
    {
        [$html, $text] = $this->render($title, $intro, $rows, $cta, $outro);
        $this->outbox->queue("{$kind}|{$b['id']}|{$eventKey}", $kind, (string) $b['contact_email'], $subject, $html, $text, (int) $b['id']);
    }

    private function toAdmins(array $b, string $kind, string $eventKey, string $subject, string $title, string $intro, array $extraRows = []): void
    {
        $rows = array_merge([
            ['Client', $b['contact_name']],
            ['Email', $b['contact_email']],
            ['Phone', (string) $b['contact_phone']],
        ], $this->bookingRows($b), $extraRows);
        [$html, $text] = $this->render($title, $intro, $rows, ['Open admin dashboard', $this->url('/admin')]);
        foreach ($this->adminRecipients() as $to) {
            $this->outbox->queue("{$kind}|{$b['id']}|{$eventKey}", $kind, $to, $subject, $html, $text, (int) $b['id']);
        }
    }

    // ------------------------------------------------------------------ booking lifecycle

    public function confirmed(array $b, string $eventKey): void
    {
        $this->toClient($b, 'booking_confirmed', $eventKey, "Your cleaning is confirmed – {$this->when($b)}", 'Your appointment is confirmed',
            "Hi {$this->firstName($b)}, thank you for booking with us! Here are your appointment details.", $this->bookingRows($b),
            ['View my appointment', $this->url('/portal')],
            'Need to make a change? You can reschedule or cancel from your account up to ' . $this->config->int('business.client_change_cutoff_hours', 24) . ' hours before your appointment.');
        $this->toAdmins($b, 'admin_booking_confirmed', $eventKey, "New confirmed booking: {$b['service_name']} – {$this->when($b)}", 'New confirmed booking', 'A booking was confirmed.');
    }

    public function requestReceived(array $b, string $eventKey): void
    {
        $this->toClient($b, 'booking_received', $eventKey, "We received your booking request – {$this->when($b)}", 'We received your request',
            "Hi {$this->firstName($b)}, we received your booking request and will confirm it shortly.", $this->bookingRows($b), ['View my appointment', $this->url('/portal')]);
    }

    public function declined(array $b, string $eventKey, ?string $reason): void
    {
        $this->toClient($b, 'booking_declined', $eventKey, 'Update on your booking request', 'We can’t take this booking',
            "Hi {$this->firstName($b)}, unfortunately we are unable to accept your booking for {$this->when($b)}." . ($reason ? "\n\nReason: {$reason}" : ''),
            $this->bookingRows($b, false), ['Choose another time', $this->url('/book')], 'Please reply to this email if you have questions.');
    }

    public function cancelled(array $b, string $eventKey, string $by, ?string $reason): void
    {
        $intro = $by === 'client'
            ? "Hi {$this->firstName($b)}, your appointment on {$this->when($b)} has been cancelled as you requested."
            : "Hi {$this->firstName($b)}, your appointment on {$this->when($b)} has been cancelled." . ($reason ? "\n\nReason: {$reason}" : '');
        $this->toClient($b, 'booking_cancelled', $eventKey, 'Your appointment was cancelled', 'Appointment cancelled', $intro, $this->bookingRows($b), ['Book again', $this->url('/book')],
            (float) $b['amount_paid'] > 0 ? 'Questions about your deposit or payments? Just reply to this email.' : '');
        if ($by === 'client') {
            $this->toAdmins($b, 'admin_booking_cancelled', $eventKey, "Booking cancelled by client: {$this->when($b)}", 'Booking cancelled by client', 'A client cancelled their appointment.', $reason ? [['Reason', $reason]] : []);
        }
    }

    public function rescheduled(array $b, string $eventKey, string $previousWhen, string $by): void
    {
        $this->toClient($b, 'booking_rescheduled', $eventKey, "Your appointment was moved to {$this->when($b)}", 'Your appointment was rescheduled',
            "Hi {$this->firstName($b)}, your appointment has been moved.", array_merge([['Previously', $previousWhen]], $this->bookingRows($b)), ['View my appointment', $this->url('/portal')]);
        if ($by === 'client') {
            $this->toAdmins($b, 'admin_booking_rescheduled', $eventKey, "Booking rescheduled by client: now {$this->when($b)}", 'Booking rescheduled by client', 'A client moved their appointment.', [['Previously', $previousWhen]]);
        }
    }

    public function completed(array $b): void
    {
        $this->toClient($b, 'booking_completed', 'completed', 'Thank you for choosing ' . $this->config->string('business.name', 'Sanchez Services'), 'Thanks for having us!',
            "Hi {$this->firstName($b)}, we hope you love your clean space. We’d be grateful if you shared a quick review.", [['Service', $b['service_name']], ['Booking #', (string) $b['invoice_number']]],
            ['Leave a review', $this->url('/portal')], (float) $b['total_price'] - (float) $b['amount_paid'] > 0.004 ? 'Your remaining balance is ' . self::money((float) $b['total_price'] - (float) $b['amount_paid']) . '. You can pay it online from your account.' : '');
    }

    public function reminder(array $b, int $hours): void
    {
        $due = max(0, (float) $b['total_price'] - (float) $b['amount_paid']);
        $this->toClient($b, "reminder_{$hours}h", (string) $b['start_at'], "Reminder: your cleaning is {$this->when($b)}", 'Appointment reminder',
            "Hi {$this->firstName($b)}, this is a friendly reminder about your upcoming appointment.", $this->bookingRows($b),
            $due > 0 ? ['Pay balance online', $this->url('/payment-center')] : ['View my appointment', $this->url('/portal')],
            $due > 0 ? 'Remaining balance: ' . self::money($due) . '. You can pay online or at the time of service.' : 'Our records show this appointment is paid in full. Thank you!');
    }

    public function paymentReceipt(array $b, array $payment): void
    {
        $rows = [['Amount applied', self::money((float) $payment['amount'])]];
        if ((float) $payment['fee'] > 0) {
            $rows[] = ['Card processing fee', self::money((float) $payment['fee'])];
            $rows[] = ['Total charged', self::money((float) $payment['gross'])];
        }
        $rows[] = ['Method', ucwords(str_replace('_', ' ', (string) $payment['method']))];
        $this->toClient($b, 'payment_receipt', 'payment:' . $payment['id'], 'Payment received – thank you', 'Payment received',
            "Hi {$this->firstName($b)}, we received your payment.", array_merge($rows, $this->bookingRows($b)), ['View invoice', $this->url('/payment-center')]);
    }

    public function refundIssued(array $b, array $refund): void
    {
        $this->toClient($b, 'refund_issued', 'refund:' . $refund['id'], 'Your refund has been issued', 'Refund issued',
            "Hi {$this->firstName($b)}, we issued a refund of " . self::money((float) $refund['amount']) . '.' . ($refund['method'] === 'card' ? ' Card refunds usually appear within 5–10 business days.' : ''),
            $this->bookingRows($b), ['View my account', $this->url('/payment-center')]);
    }

    public function attention(array $b, string $eventKey, string $message): void
    {
        $this->toAdmins($b, 'admin_attention', $eventKey, 'Action needed: ' . $b['invoice_number'], 'Action needed', $message);
    }

    // ------------------------------------------------------------------ account emails

    public function passwordReset(string $to, string $link, int $minutes): void
    {
        [$html, $text] = $this->render('Reset your password', "We received a request to reset the password for {$to}. This link expires in {$minutes} minutes.", [], ['Choose a new password', $link], 'If you didn’t ask for this, you can ignore this email.');
        $this->outbox->queue('password_reset|' . hash('sha256', $link), 'password_reset', $to, 'Reset your ' . $this->config->string('business.name', 'Sanchez Services') . ' password', $html, $text);
    }

    public function verifyEmail(string $to, string $link): void
    {
        [$html, $text] = $this->render('Confirm your email', 'Please confirm your email address so we can link your bookings to your account.', [], ['Confirm email', $link]);
        $this->outbox->queue('email_verify|' . hash('sha256', $link), 'email_verify', $to, 'Confirm your email for ' . $this->config->string('business.name', 'Sanchez Services'), $html, $text);
    }
}

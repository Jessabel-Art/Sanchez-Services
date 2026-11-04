<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

use DateTimeImmutable;
use SanchezServices\Clock;
use SanchezServices\Config;
use SanchezServices\Infra\Logger;
use SanchezServices\Store\Doc;

/**
 * Port of the Firestore trigger `enqueueBookingEmail` (client + admin notifications) and of
 * buildAppointmentReminderMail(). Called synchronously after every booking write.
 *
 * Returns the extra patch to apply to the booking (emailQueuedAt, mailLastKind, admin*NotifiedAt,
 * reminder flag reset) — exactly the fields the trigger wrote back.
 */
final class BookingEvents
{
    public function __construct(private Clock $clock, private Config $config, private Outbox $outbox, private Logger $log)
    {
    }

    private static function h(mixed $v): string
    {
        return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    private static function canonicalTs(?array $b): mixed
    {
        if (!$b) {
            return null;
        }
        return Pricing::jsOr($b['scheduledAt'] ?? null, $b['startAt'] ?? null, null);
    }

    /** fmtDateTime(): en-US short date + "h:mm AM", in the business timezone. */
    public function fmt(mixed $ts): array
    {
        $d = Doc::toDate($ts);
        if (!$d) {
            return ['TBD', ''];
        }
        $l = $this->clock->toBusiness($d);
        return [$l->format('n/j/Y'), $l->format('g:i A')];
    }

    /**
     * @param array<string,mixed>|null $before
     * @param array<string,mixed>|null $after
     * @return array<string,mixed> patch for the booking (may be empty)
     */
    public function onWrite(string $bookingId, ?array $before, ?array $after): array
    {
        $patch = [];
        try {
            $booking = $after ?? $before;
            $kind = null;
            if ($before === null && $after !== null) {
                $kind = 'received';
            } elseif ($before !== null && $after !== null) {
                if (($before['status'] ?? null) !== ($after['status'] ?? null)) {
                    $kind = match ($after['status'] ?? null) {
                        'confirmed' => 'confirm',
                        'declined' => 'decline',
                        default => 'updated',
                    };
                } else {
                    $prev = Doc::toDate(self::canonicalTs($before));
                    $next = Doc::toDate(self::canonicalTs($after));
                    $prevMs = $prev ? (int) $prev->format('Uv') : 0;
                    $nextMs = $next ? (int) $next->format('Uv') : 0;
                    if ($prevMs !== $nextMs) {
                        $kind = 'updated';
                        $patch['reminder48SentAt'] = ['__op' => 'delete'];
                        $patch['reminder24SentAt'] = ['__op' => 'delete'];
                    }
                }
            }
            if (!$booking) {
                return $patch;
            }
            $contactEmail = Doc::get($booking, 'contact.email');
            if (!$contactEmail) {
                return $patch;
            }
            if (!$kind) {
                return $patch;
            }
            $queuedAt = Doc::toDate($booking['emailQueuedAt'] ?? null);
            if ($queuedAt && ($booking['mailLastKind'] ?? null) === $kind) {
                $ageMs = ((int) $this->clock->now()->format('Uv')) - (int) $queuedAt->format('Uv');
                if ($ageMs < 10 * 60 * 1000) {
                    return $patch;
                }
            }

            [$dateStr, $timeStr] = $this->fmt(self::canonicalTs($booking));
            $when = $dateStr . ($timeStr !== '' ? " at {$timeStr}" : '');
            $name = (string) (Doc::get($booking, 'contact.name') ?? '');
            $service = (string) Pricing::jsOr($booking['serviceName'] ?? null, $booking['service'] ?? null, 'cleaning');
            $hn = self::h($name);
            $hs = self::h($service);
            $hw = self::h($when);

            $subject = "Sanchez Services: Update for your booking on {$when}";
            $html = "<p>Hi {$hn},</p><p>Your booking is updated for <strong>{$hw}</strong>.</p>";
            $text = "Hi {$name}, Your booking is updated for {$when}.";
            if ($kind === 'confirm') {
                $subject = "Sanchez Services: Your booking on {$when} is confirmed";
                $html = "<p>Hi {$hn},</p><p>Your <strong>{$hs}</strong> is confirmed for <strong>{$hw}</strong>.</p>";
                $text = "Hi {$name}, Your {$service} is confirmed for {$when}.";
            } elseif ($kind === 'decline') {
                $subject = "Sanchez Services: Update on your booking for {$when}";
                $html = "<p>Hi {$hn},</p><p>We are sorry but your booking for <strong>{$hw}</strong> has been declined. Please reply or contact us to reschedule.</p>";
                $text = "Hi {$name}, We are sorry but your booking for {$when} has been declined. Please contact us to reschedule.";
            } elseif ($kind === 'received') {
                $subject = "Sanchez Services: We received your booking for {$when}";
                $html = "<p>Hi {$hn},</p><p>We received your <strong>{$hs}</strong> booking for <strong>{$hw}</strong>. We’ll confirm shortly.</p>";
                $text = "Hi {$name}, We received your {$service} booking for {$when}. We’ll confirm shortly.";
            }

            $this->outbox->enqueue([
                'to' => [(string) $contactEmail],
                'message' => ['subject' => $subject, 'html' => $html, 'text' => $text],
                'meta' => ['bookingId' => $bookingId, 'kind' => $kind, 'status' => $booking['status'] ?? null, 'queuedBy' => 'php_booking_events'],
            ]);
            if ($after !== null) {
                $patch['emailQueuedAt'] = ['__op' => 'serverTimestamp'];
                $patch['mailLastKind'] = $kind;
            }

            // ---- Admin notifications ----
            $adminKind = null;
            $field = null;
            if ($before === null && $after !== null) {
                [$adminKind, $field] = ['admin_new_booking', 'adminNewNotifiedAt'];
            }
            if ($before !== null && $after !== null && !$adminKind) {
                $b = Doc::toDate(self::canonicalTs($before));
                $a = Doc::toDate(self::canonicalTs($after));
                if ($b && $a && $b->format('Uv') !== $a->format('Uv')) {
                    [$adminKind, $field] = ['admin_rescheduled', 'adminRescheduleNotifiedAt'];
                }
            }
            if ($before !== null && $after !== null && !$adminKind) {
                $bs = strtolower((string) ($before['status'] ?? ''));
                $as = strtolower((string) ($after['status'] ?? ''));
                if ($bs !== $as && $as === 'cancelled') {
                    [$adminKind, $field] = ['admin_cancelled', 'adminCancelNotifiedAt'];
                }
            }
            if ($adminKind && $after !== null && empty($after[$field])) {
                $recipients = $this->config->list('business.admin_notification_emails');
                if (!$recipients) {
                    $recipients = $this->config->list('business.admin_emails');
                }
                if (!$recipients) {
                    $this->log->warning('admin notification skipped: no admin_notification_emails', ['bookingId' => $bookingId]);
                    return $patch;
                }
                $cName = (string) (Doc::get($booking, 'contact.name') ?: 'Customer');
                $cEmail = (string) (Doc::get($booking, 'contact.email') ?: 'N/A');
                $cPhone = (string) (Doc::get($booking, 'contact.phone') ?: 'N/A');
                $addr = is_array($booking['address'] ?? null) ? $booking['address'] : [];
                $addressLine = implode(', ', array_filter([
                    $addr['line1'] ?? '', $addr['city'] ?? '', $addr['state'] ?? '', $addr['zip'] ?? '',
                ], static fn ($x) => (string) $x !== '')) ?: 'Address not provided';
                $dt = $dateStr . ($timeStr !== '' ? " {$timeStr}" : '');
                $rows = [
                    'Booking ID' => $bookingId,
                    'Service' => $service,
                    'Status' => $adminKind === 'admin_cancelled' ? (string) ($booking['status'] ?? '') : (string) Pricing::jsOr($booking['status'] ?? null, 'pending'),
                ];
                if ($adminKind === 'admin_new_booking') {
                    $title = 'New booking request';
                    $subjectA = "New booking request: {$service} on {$dt}";
                    $rows['Date/Time'] = $dt;
                } elseif ($adminKind === 'admin_rescheduled') {
                    [$od, $ot] = $this->fmt(self::canonicalTs($before));
                    $title = 'Booking rescheduled';
                    $subjectA = "Booking rescheduled: {$service} now on {$dt}";
                    $rows['Old Date/Time'] = $od . ($ot !== '' ? " {$ot}" : '');
                    $rows['New Date/Time'] = $dt;
                } else {
                    $title = 'Booking cancelled';
                    $subjectA = "Booking cancelled: {$service} on {$dt}";
                    $rows['Date/Time'] = $dt;
                }
                $rows += ['Customer' => $cName, 'Email' => $cEmail, 'Phone' => $cPhone, 'Address' => $addressLine];
                $htmlA = '<p><strong>' . self::h($title) . '</strong></p>' . "\n";
                $textA = $title;
                foreach ($rows as $label => $value) {
                    $htmlA .= '<p>' . self::h($label) . ': ' . self::h($value) . "</p>\n";
                    $textA .= "\n{$label}: {$value}";
                }
                $this->outbox->enqueue([
                    'to' => $recipients,
                    'message' => ['subject' => $subjectA, 'html' => rtrim($htmlA), 'text' => $textA],
                    'meta' => ['bookingId' => $bookingId, 'kind' => $adminKind, 'status' => $booking['status'] ?? null, 'queuedBy' => 'php_booking_events'],
                ]);
                $patch[$field] = ['__op' => 'serverTimestamp'];
            }
        } catch (\Throwable $e) {
            // Like the Cloud Function: never fail the originating write because of email.
            $this->log->error('booking event processing failed', ['bookingId' => $bookingId, 'error' => $e->getMessage()]);
        }
        return $patch;
    }

    /** buildAppointmentReminderMail() */
    public function reminderMail(string $bookingId, array $booking, int $hours): ?array
    {
        $contactEmail = PaymentAmounts::normalizeEmail(Pricing::jsOr(
            Doc::get($booking, 'contact.email'), $booking['contactEmail'] ?? null, $booking['customerEmail'] ?? null, $booking['email'] ?? null, ''
        ));
        if ($contactEmail === '') {
            return null;
        }
        [$dateStr, $timeStr] = $this->fmt($booking['startAt'] ?? null);
        $customerName = (string) Pricing::jsOr(Doc::get($booking, 'contact.name'), $booking['clientName'] ?? null, $booking['name'] ?? null, 'there');
        $service = (string) Pricing::jsOr($booking['serviceName'] ?? null, $booking['service'] ?? null, $booking['serviceSlug'] ?? null, 'cleaning service');
        $address = self::formatAddress($booking);
        $paymentNote = self::reminderPaymentNote($booking);
        $subject = "Sanchez Services reminder: {$service} in {$hours} hours";
        $when = $dateStr . ($timeStr !== '' ? " at {$timeStr}" : '');
        $html = '<p>Hi ' . self::h($customerName) . ",</p>\n"
            . '<p>This is a friendly reminder that your <strong>' . self::h($service) . '</strong> appointment is scheduled for <strong>' . self::h($when) . "</strong>.</p>\n"
            . "<p><strong>Appointment details</strong><br/>\n"
            . 'Service: ' . self::h($service) . "<br/>\n"
            . 'Date: ' . self::h($dateStr) . "<br/>\n"
            . 'Time: ' . self::h($timeStr ?: 'TBD') . "<br/>\n"
            . 'Address:<br/>' . str_replace("\n", '<br/>', self::h($address)) . "</p>\n"
            . '<p>' . self::h($paymentNote) . "</p>\n"
            . '<p>Thank you for choosing Sanchez Services.</p>';
        $text = "Hi {$customerName},\n\nThis is a friendly reminder that your {$service} appointment is scheduled for {$when}.\n\n"
            . "Appointment details\nService: {$service}\nDate: {$dateStr}\nTime: " . ($timeStr ?: 'TBD') . "\nAddress:\n{$address}\n\n{$paymentNote}\n\nThank you for choosing Sanchez Services.";
        return [
            'to' => [$contactEmail],
            'message' => compact('subject', 'html', 'text'),
            'meta' => ['bookingId' => $bookingId, 'kind' => "appointment_reminder_{$hours}h", 'status' => $booking['status'] ?? null, 'queuedBy' => 'php_send_reminders'],
        ];
    }

    public static function formatAddress(array $b): string
    {
        $addr = $b['address'] ?? [];
        if (is_string($addr)) {
            return $addr !== '' ? $addr : 'Address not provided';
        }
        $addr = is_array($addr) ? $addr : [];
        $line1 = (string) Pricing::jsOr($addr['line1'] ?? null, $addr['street'] ?? null, $b['addressLine1'] ?? null, $b['street'] ?? null, '');
        $line2 = (string) ($addr['line2'] ?? '');
        $csz = implode(', ', array_filter([$addr['city'] ?? null, $addr['state'] ?? null, Pricing::jsOr($addr['zip'] ?? null, $addr['postalCode'] ?? null, null)], static fn ($x) => $x !== null && $x !== ''));
        return implode("\n", array_filter([$line1, $line2, $csz], static fn ($x) => $x !== '')) ?: 'Address not provided';
    }

    public static function reminderPaymentNote(array $b): string
    {
        $num = static fn ($v) => is_numeric($v) ? (float) $v : 0.0;
        $first = static function (array $keys) use ($b) {
            foreach ($keys as $k) {
                $v = Doc::get($b, $k);
                if ($v !== null) {
                    return $v;
                }
            }
            return null;
        };
        $total = $num($first(['totalPrice', 'totalAmount', 'total', 'amount', 'estimate.total']) ?? 0);
        $paid = $num($first(['paidAmount', 'amountPaid', 'paid']) ?? 0);
        $remRaw = $first(['balanceDue', 'remainingDue', 'remainingBalance']);
        $remaining = max(0, $remRaw !== null ? $num($remRaw) : ($total > 0 ? $total - $paid : 0));
        $deposit = $num(Pricing::jsOr($b['depositAmount'] ?? null, 0));
        if ($remaining <= 0 && $total > 0) {
            return 'Our records show this appointment is paid in full. Thank you!';
        }
        if ($deposit > 0 && empty($b['depositPaid'])) {
            return 'Reminder: a $' . PaymentMath::toFixed((float) $deposit, 2) . ' deposit is still needed to hold this appointment.';
        }
        if ($remaining > 0) {
            return 'Remaining balance due: $' . PaymentMath::toFixed((float) $remaining, 2) . '.';
        }
        return 'Payment can be handled at the time of service unless already arranged.';
    }

    public function now(): DateTimeImmutable
    {
        return $this->clock->now();
    }
}

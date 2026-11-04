<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Clock;
use SanchezServices\Domain\BookingRepo;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Input;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;

/** Booking actions for the owner (admins may call them too; ownership is enforced server-side). */
final class BookingController
{
    public function __construct(private App $app)
    {
    }

    private function own(Request $r): array
    {
        $u = $this->app->auth->requireUser();
        $b = $this->app->repo->requireRef($r->param('ref'));
        $this->app->bookings->assertOwner($u, $b);
        return $b;
    }

    private function respond(array $b, array $extra = []): Response
    {
        $admin = (bool) $this->app->auth->currentUser()?->isAdmin();
        return Response::json(['booking' => $this->app->repo->detail($b, $admin)] + $extra);
    }

    /** POST /api/bookings — create + start deposit checkout. */
    public function create(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $this->app->limiter->hit('booking:user:' . $u->id, 20, 3600);
        $b = $this->app->bookings->createOnline($u, Input::from($r));
        $checkout = null;
        if ($b['status'] === 'pending_payment') {
            try {
                $checkout = $this->app->checkout->start($b, 'deposit');
            } catch (\Throwable $e) {
                // Release the slot immediately if payment can't be started.
                $this->app->bookings->cancel($u, $b['ref'], 'Payment could not be started', false);
                $this->app->log->error('checkout start failed', ['booking' => $b['ref'], 'error' => $e->getMessage()]);
                throw $e instanceof HttpError ? $e : new HttpError('unavailable', 'We could not start the card payment. No booking was made — please try again.');
            }
        }
        return $this->respond((array) $this->app->repo->byId((int) $b['id']), ['checkoutUrl' => $checkout['url'] ?? null]);
    }

    public function show(Request $r): Response
    {
        return $this->respond($this->own($r));
    }

    /** POST /api/bookings/{ref}/checkout {purpose: deposit|balance} */
    public function checkout(Request $r): Response
    {
        $b = $this->own($r);
        $purpose = (string) Input::from($r)->enum('purpose', ['deposit', 'balance'], true);
        $perm = $this->app->repo->clientPermissions($b, false);
        if ($purpose === 'deposit' && !$perm['canPayDeposit'] || $purpose === 'balance' && !$perm['canPayBalance']) {
            throw new HttpError('failed-precondition', $purpose === 'deposit' ? 'A deposit is not due for this booking.' : 'There is no balance to pay online for this booking.');
        }
        $s = $this->app->checkout->start($b, $purpose);
        return Response::json(['checkoutUrl' => $s['url']]);
    }

    /** POST /api/bookings/{ref}/payment-sync {sessionId} — called by the Stripe success page. */
    public function sync(Request $r): Response
    {
        $b = $this->own($r);
        $sid = (string) Input::from($r)->str('sessionId', true, 200);
        return $this->respond($this->app->checkout->sync($b, $sid));
    }

    public function reschedule(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        return $this->respond($this->app->bookings->reschedule($u, $r->param('ref'), Input::from($r)));
    }

    public function cancel(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $b = $this->app->bookings->cancel($u, $r->param('ref'), Input::from($r)->str('reason', false, 500));
        $this->app->checkout->expireOpenSessions((int) $b['id']);
        return $this->respond($b);
    }

    public function notes(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        return $this->respond($this->app->bookings->updateClientNotes($u, $r->param('ref'), Input::from($r)));
    }

    /** POST /api/bookings/{ref}/review {rating, comment, displayMode} */
    public function review(Request $r): Response
    {
        $u = $this->app->auth->requireUser();
        $b = $this->own($r);
        $in = Input::from($r);
        $rating = (int) $in->int('rating', true, 1, 5);
        $comment = (string) $in->str('comment', true, 2000);
        if (mb_strlen($comment) < 5) {
            throw new HttpError('invalid-argument', 'Please write a few more words.', ['field' => 'comment']);
        }
        $mode = (string) $in->enum('displayMode', ['anonymous', 'initials', 'firstInitialLastName'], false, 'initials');
        if ($b['status'] !== 'completed') {
            throw new HttpError('failed-precondition', 'You can review a booking after it is completed.');
        }
        $parts = preg_split('/\s+/', trim((string) ($u->name ?: $b['contact_name']))) ?: [];
        $first = $parts[0] ?? '';
        $last = count($parts) > 1 ? end($parts) : '';
        $display = match ($mode) {
            'anonymous' => 'Anonymous',
            'initials' => $first === '' ? 'Anonymous' : mb_strtoupper(mb_substr($first, 0, 1)) . '.' . ($last !== '' ? mb_strtoupper(mb_substr($last, 0, 1)) . '.' : ''),
            'firstInitialLastName' => $first === '' ? 'Anonymous' : ($last !== '' ? mb_strtoupper(mb_substr($first, 0, 1)) . '. ' . $last : $first),
        };
        $now = Clock::toSql($this->app->clock->now());
        try {
            $this->app->db->insert('reviews', [
                'booking_id' => (int) $b['id'], 'user_id' => $u->id, 'rating' => $rating, 'comment' => $comment, 'display_mode' => $mode,
                'display_name' => $display, 'service_name' => $b['service_name'], 'status' => 'pending', 'created_at' => $now, 'updated_at' => $now,
            ]);
        } catch (\PDOException $e) {
            if (($e->errorInfo[1] ?? null) === 1062) {
                throw new HttpError('already-exists', 'You already reviewed this booking. Thank you!');
            }
            throw $e;
        }
        return $this->respond($b);
    }

    /** GET /api/bookings/{ref}/invoice — the single invoice calculation for client and admin. */
    public function invoice(Request $r): Response
    {
        return Response::json(['invoice' => self::buildInvoice($this->app, $this->own($r))]);
    }

    public static function buildInvoice(App $app, array $b): array
    {
        $repo = $app->repo;
        $pricing = $b['pricing_json'] ? json_decode((string) $b['pricing_json'], true) : [];
        $items = $pricing['lineItems'] ?? [['label' => $b['service_name'], 'detail' => '', 'amount' => (float) $b['total_price']]];
        $charges = array_values(array_filter($items, static fn ($i) => $i['amount'] >= 0));
        $discounts = array_values(array_filter($items, static fn ($i) => $i['amount'] < 0));
        $local = $app->clock->toBusiness(Clock::fromSql($b['start_at']));
        $c = $app->config;
        return [
            'invoiceNumber' => $b['invoice_number'],
            'bookingId' => $b['ref'],
            'issuedAt' => BookingRepo::iso($b['created_at']),
            'status' => $b['payment_status'],
            'business' => ['name' => $c->string('business.name'), 'email' => $c->string('business.email'), 'phone' => $c->string('business.phone'), 'website' => $c->string('business.website')],
            'billTo' => [
                'name' => $b['contact_name'], 'email' => $b['contact_email'], 'phone' => $b['contact_phone'],
                'address' => ['line1' => $b['address_line1'], 'line2' => $b['address_line2'], 'city' => $b['address_city'], 'state' => $b['address_state'], 'zip' => $b['address_zip']],
            ],
            'service' => ['name' => $b['service_name'], 'frequency' => $b['frequency'], 'date' => $local->format('Y-m-d'), 'time' => $local->format('g:i A'), 'durationMinutes' => (int) $b['duration_minutes'], 'bookingStatus' => $b['status']],
            'lineItems' => $items,
            'subtotal' => round(array_sum(array_column($charges, 'amount')), 2),
            'discounts' => round(-array_sum(array_column($discounts, 'amount')), 2),
            'total' => (float) $b['total_price'],
            'depositAmount' => (float) $b['deposit_amount'],
            'payments' => $repo->paymentsFor((int) $b['id'], false),
            'amountPaid' => (float) $b['amount_paid'],
            'amountRefunded' => (float) $b['amount_refunded'],
            'balanceDue' => $repo->balanceDue($b),
        ];
    }
}

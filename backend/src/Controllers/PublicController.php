<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Domain\BlackoutDates;
use SanchezServices\Domain\Pricing;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Input;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;

/** Unauthenticated endpoints: catalog, quote, availability, published reviews. No customer data. */
final class PublicController
{
    public function __construct(private App $app)
    {
    }

    public function catalog(Request $r): Response
    {
        $c = $this->app->config;
        return Response::json(Pricing::catalog() + [
            'business' => [
                'name' => $c->string('business.name'),
                'email' => $c->string('business.email'),
                'phone' => $c->string('business.phone'),
                'timezone' => $c->string('business.timezone'),
            ],
            'rules' => [
                'depositAmount' => $c->float('business.required_deposit_amount', 50),
                'minNoticeHours' => $c->int('business.min_notice_hours', 12),
                'changeCutoffHours' => $c->int('business.client_change_cutoff_hours', 24),
                'bookingHorizonDays' => $c->int('business.booking_horizon_days', 120),
                'holdMinutes' => max(30, $c->int('business.hold_minutes', 30)),
                'cardFeePassedToCustomer' => $c->bool('business.pass_card_fee_to_customer', true),
                'depositCardCharge' => $c->bool('business.pass_card_fee_to_customer', true)
                    ? \SanchezServices\Domain\PaymentMath::grossFromNet($c->float('business.required_deposit_amount', 50))
                    : ['estimatedFee' => 0.0, 'grossAmount' => $c->float('business.required_deposit_amount', 50)],
                'slots' => $c->get('business.slots'),
            ],
        ]);
    }

    public function quote(Request $r): Response
    {
        $this->app->limiter->hit('quote:ip:' . $r->ip, 240, 60);
        return Response::json($this->app->bookings->quote(Input::from($r)));
    }

    /** GET /api/availability?date=YYYY-MM-DD&durationMinutes=150[&booking=REF] */
    public function day(Request $r): Response
    {
        $this->app->limiter->hit('availability:ip:' . $r->ip, 240, 60);
        $in = Input::from($r);
        $date = (string) $in->date('date', true);
        $duration = (int) $in->int('durationMinutes', true, 30, 720);
        $exclude = null;
        if ($ref = $in->str('booking', false, 160)) {
            // Rescheduling: the caller's own booking doesn't block itself.
            $u = $this->app->auth->currentUser();
            $b = $this->app->repo->byRef($ref);
            if ($u && $b && ((int) $b['user_id'] === $u->id || $u->isAdmin())) {
                $exclude = (int) $b['id'];
            }
        }
        return Response::json($this->app->schedule->day($date, $duration, $exclude));
    }

    /** GET /api/availability/month?month=YYYY-MM&durationMinutes=150 — per-day summary for the calendar. */
    public function month(Request $r): Response
    {
        $this->app->limiter->hit('availability:ip:' . $r->ip, 240, 60);
        $in = Input::from($r);
        $month = (string) $in->str('month', true, 7);
        if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
            throw new HttpError('invalid-argument', 'month must be YYYY-MM.', ['field' => 'month']);
        }
        $duration = (int) $in->int('durationMinutes', true, 30, 720);
        $days = [];
        $d = "{$month}-01";
        while (str_starts_with((string) $d, $month)) {
            $day = $this->app->schedule->day((string) $d, $duration);
            $days[] = ['date' => $d, 'available' => $day['anyAvailable'], 'reason' => $day['anyAvailable'] ? null : ($day['reason'] ?? ($day['slots'] ? $day['slots'][0]['reason'] : 'closed'))];
            $d = BlackoutDates::addDays((string) $d, 1);
        }
        return Response::json(['month' => $month, 'days' => $days]);
    }

    public function reviews(Request $r): Response
    {
        $rows = $this->app->db->all("SELECT rating, comment, display_name, service_name, published_at FROM reviews WHERE status = 'approved' ORDER BY published_at DESC LIMIT 50");
        return Response::json(['reviews' => array_map(static fn ($x) => [
            'rating' => (int) $x['rating'], 'comment' => $x['comment'], 'displayName' => $x['display_name'],
            'serviceName' => $x['service_name'], 'publishedAt' => \SanchezServices\Domain\BookingRepo::iso($x['published_at']),
        ], $rows)]);
    }
}

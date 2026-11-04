<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Auth\AuthUser;
use SanchezServices\Clock;
use SanchezServices\Domain\BlackoutDates;
use SanchezServices\Domain\BookingRepo;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Input;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;

/** /api/admin/* — every method requires role admin or owner. */
final class AdminController
{
    public function __construct(private App $app)
    {
    }

    private function admin(): AuthUser
    {
        $u = $this->app->auth->requireUser();
        if (!$u->isAdmin()) {
            throw HttpError::denied('Admins only.');
        }
        return $u;
    }

    private function audit(AuthUser $a, string $action, string $entity, ?string $id, array $details, Request $r): void
    {
        $this->app->db->insert('audit_log', [
            'actor_user_id' => $a->id, 'action' => $action, 'entity' => $entity, 'entity_id' => $id,
            'details_json' => json_encode($details, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR), 'ip' => substr($r->ip, 0, 45),
            'created_at' => Clock::toSql($this->app->clock->now()),
        ]);
    }

    private function bookingResponse(array $b): Response
    {
        return Response::json(['booking' => $this->app->repo->detail($b, true)]);
    }

    /** Local date range -> UTC bounds. Defaults: 60 days back .. 120 days ahead. */
    private function range(Input $in): array
    {
        $tz = $this->app->clock->tz();
        $from = $in->date('from') ?? $this->app->clock->toBusiness($this->app->clock->now()->modify('-60 days'))->format('Y-m-d');
        $to = $in->date('to') ?? $this->app->clock->toBusiness($this->app->clock->now()->modify('+120 days'))->format('Y-m-d');
        if ($to < $from) {
            throw HttpError::invalid('to must be on or after from.');
        }
        return [$from, $to, (new \DateTimeImmutable($from, $tz))->setTimezone($this->app->clock->utc()), (new \DateTimeImmutable((string) BlackoutDates::addDays($to, 1), $tz))->setTimezone($this->app->clock->utc())];
    }

    // ------------------------------------------------------------------ bookings

    /** GET /api/admin/bookings?from&to&status&q&userId&all=1 */
    public function bookings(Request $r): Response
    {
        $this->admin();
        $in = Input::from($r);
        $where = [];
        $params = [];
        if (!$in->bool('all')) {
            [, , $fromUtc, $toUtc] = $this->range($in);
            $where[] = 'b.start_at >= ? AND b.start_at < ?';
            array_push($params, Clock::toSql($fromUtc), Clock::toSql($toUtc));
        }
        if ($status = $in->str('status', false, 30)) {
            $where[] = 'b.status = ?';
            $params[] = $status;
        }
        if ($uid = $in->int('userId', false, 1)) {
            $where[] = 'b.user_id = ?';
            $params[] = $uid;
        }
        if ($email = $in->str('email', false, 254)) {
            $where[] = 'b.contact_email_lower = ?';
            $params[] = strtolower($email);
        }
        if ($q = $in->str('q', false, 100)) {
            $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q) . '%';
            $where[] = '(b.contact_name LIKE ? OR b.contact_email LIKE ? OR b.contact_phone LIKE ? OR b.address_line1 LIKE ? OR b.invoice_number LIKE ? OR b.ref = ?)';
            array_push($params, $like, $like, $like, $like, $like, $q);
        }
        $rows = $this->app->db->all('SELECT b.* FROM bookings b' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY b.start_at DESC LIMIT 2000', $params);
        return Response::json(['bookings' => array_map(fn ($b) => $this->app->repo->toApi($b, true), $rows)]);
    }

    public function booking(Request $r): Response
    {
        $this->admin();
        return $this->bookingResponse($this->app->repo->requireRef($r->param('ref')));
    }

    public function createBooking(Request $r): Response
    {
        $a = $this->admin();
        $b = $this->app->bookings->createAdmin($a, Input::from($r));
        $this->audit($a, 'booking_create', 'booking', $b['ref'], [], $r);
        return $this->bookingResponse($b);
    }

    public function updateBooking(Request $r): Response
    {
        $a = $this->admin();
        $in = Input::from($r);
        $b = $this->app->bookings->updateDetails($a, $r->param('ref'), $in);
        $this->audit($a, 'booking_update', 'booking', $b['ref'], ['fields' => array_keys($in->all())], $r);
        return $this->bookingResponse($b);
    }

    public function setStatus(Request $r): Response
    {
        $a = $this->admin();
        $in = Input::from($r);
        $to = (string) $in->enum('status', ['pending', 'confirmed', 'completed', 'cancelled', 'declined'], true);
        $b = $this->app->bookings->setStatus($a, $r->param('ref'), $to, $in->str('reason', false, 500), $in->bool('notifyClient', true));
        if (in_array($to, ['cancelled', 'declined'], true)) {
            $this->app->checkout->expireOpenSessions((int) $b['id']);
        }
        $this->audit($a, 'booking_status', 'booking', $b['ref'], ['status' => $to], $r);
        return $this->bookingResponse($b);
    }

    public function reschedule(Request $r): Response
    {
        $a = $this->admin();
        $b = $this->app->bookings->reschedule($a, $r->param('ref'), Input::from($r));
        $this->audit($a, 'booking_reschedule', 'booking', $b['ref'], [], $r);
        return $this->bookingResponse($b);
    }

    public function clearAttention(Request $r): Response
    {
        $a = $this->admin();
        $b = $this->app->repo->requireRef($r->param('ref'));
        $this->app->repo->update((int) $b['id'], ['needs_attention' => null]);
        $this->app->repo->history((int) $b['id'], 'attention_cleared', 'admin', $a->id, []);
        return $this->bookingResponse((array) $this->app->repo->byId((int) $b['id']));
    }

    // ------------------------------------------------------------------ payments

    /** POST /api/admin/bookings/{ref}/payments {amount, method, purpose, note, paidAt} — cash/zelle/etc. */
    public function recordPayment(Request $r): Response
    {
        $a = $this->admin();
        $in = Input::from($r);
        $method = (string) $in->enum('method', ['cash', 'zelle', 'venmo', 'cash_app', 'check', 'other', 'card'], true);
        $amount = (float) $in->num('amount', true, 0.01, 100000);
        $b = $this->app->db->transaction(function () use ($r, $in, $method, $amount, $a) {
            $b = $this->app->repo->requireRef($r->param('ref'), true);
            if (in_array($b['status'], ['declined'], true)) {
                throw new HttpError('failed-precondition', 'Cannot record payments on a declined booking.');
            }
            if ($amount > $this->app->repo->balanceDue($b) + 0.004) {
                throw HttpError::invalid('Amount is more than the balance due ($' . number_format($this->app->repo->balanceDue($b), 2) . ').');
            }
            $res = $this->app->ledger->record($b, [
                'purpose' => $in->enum('purpose', ['deposit', 'balance', 'other'], false, 'other'),
                'method' => $method, 'amount' => $amount, 'gross' => $amount, 'source' => 'admin',
                'note' => $in->str('note', false, 500), 'paid_at' => $in->instant('paidAt') ?? $this->app->clock->now(),
            ], 'admin', $a->id);
            return $this->app->bookings->afterPayment($res['booking'], 'manual:' . $res['payment']['id']);
        });
        $this->audit($a, 'payment_record', 'booking', $b['ref'], ['amount' => $amount, 'method' => $method], $r);
        return $this->bookingResponse($b);
    }

    public function refund(Request $r): Response
    {
        $a = $this->admin();
        $in = Input::from($r);
        $b = $this->app->ledger->refund((int) $r->param('id'), (float) $in->num('amount', true, 0.01, 100000), $in->str('reason', false, 500), $a->id);
        $this->audit($a, 'payment_refund', 'payment', $r->param('id'), ['amount' => $in->raw('amount')], $r);
        return $this->bookingResponse($b);
    }

    public function voidPayment(Request $r): Response
    {
        $a = $this->admin();
        $b = $this->app->ledger->void((int) $r->param('id'), $a->id, Input::from($r)->str('reason', false, 500));
        $this->audit($a, 'payment_void', 'payment', $r->param('id'), [], $r);
        return $this->bookingResponse($b);
    }

    /** GET /api/admin/payments?from&to — ledger rows + totals by method. */
    public function payments(Request $r): Response
    {
        $this->admin();
        [$from, $to, $fromUtc, $toUtc] = $this->range(Input::from($r));
        $rows = $this->app->db->all(
            "SELECT p.*, b.ref, b.invoice_number, b.contact_name, b.service_name, b.start_at FROM payments p JOIN bookings b ON b.id = p.booking_id
             WHERE p.paid_at >= ? AND p.paid_at < ? ORDER BY p.paid_at DESC",
            [Clock::toSql($fromUtc), Clock::toSql($toUtc)]
        );
        $totals = ['collected' => 0.0, 'refunded' => 0.0, 'fees' => 0.0, 'byMethod' => []];
        foreach ($rows as $p) {
            if ($p['status'] !== 'succeeded') {
                continue;
            }
            if ($p['type'] === 'payment') {
                $totals['collected'] += (float) $p['amount'];
                $totals['fees'] += (float) $p['fee'];
                $totals['byMethod'][$p['method']] = round(($totals['byMethod'][$p['method']] ?? 0) + (float) $p['amount'], 2);
            } else {
                $totals['refunded'] += (float) $p['amount'];
            }
        }
        $totals = array_map(static fn ($v) => is_float($v) ? round($v, 2) : $v, $totals);
        $totals['net'] = round($totals['collected'] - $totals['refunded'], 2);
        $outstanding = $this->app->db->one("SELECT COUNT(*) n, COALESCE(SUM(total_price - amount_paid), 0) due FROM bookings WHERE status IN ('pending','confirmed','completed') AND total_price - amount_paid > 0.004");
        return Response::json([
            'from' => $from, 'to' => $to, 'totals' => $totals,
            'outstanding' => ['bookings' => (int) $outstanding['n'], 'amount' => round((float) $outstanding['due'], 2)],
            'payments' => array_map(fn ($p) => BookingRepo::paymentToApi($p, true) + [
                'bookingId' => $p['ref'], 'invoiceNumber' => $p['invoice_number'], 'clientName' => $p['contact_name'], 'serviceName' => $p['service_name'], 'appointmentAt' => BookingRepo::iso($p['start_at']),
            ], $rows),
        ]);
    }

    // ------------------------------------------------------------------ calendar + blackouts

    public static function blackoutToApi(array $x): array
    {
        return [
            'id' => (int) $x['id'], 'allDay' => (int) $x['all_day'] === 1, 'startDate' => $x['start_date'], 'endDateExclusive' => $x['end_date_exclusive'],
            'startAt' => BookingRepo::iso($x['start_at']), 'endAt' => BookingRepo::iso($x['end_at']), 'reason' => $x['reason'],
        ];
    }

    public function calendar(Request $r): Response
    {
        $this->admin();
        [$from, $to, $fromUtc, $toUtc] = $this->range(Input::from($r));
        $rows = $this->app->db->all("SELECT * FROM bookings WHERE start_at >= ? AND start_at < ? AND status NOT IN ('expired') ORDER BY start_at", [Clock::toSql($fromUtc), Clock::toSql($toUtc)]);
        $bo = $this->app->db->all(
            'SELECT * FROM blackouts WHERE (all_day = 1 AND start_date <= ? AND end_date_exclusive > ?) OR (all_day = 0 AND start_at < ? AND end_at > ?) ORDER BY COALESCE(start_date, DATE(start_at))',
            [$to, $from, Clock::toSql($toUtc), Clock::toSql($fromUtc)]
        );
        return Response::json(['from' => $from, 'to' => $to, 'bookings' => array_map(fn ($b) => $this->app->repo->toApi($b, true), $rows), 'blackouts' => array_map([self::class, 'blackoutToApi'], $bo)]);
    }

    public function blackouts(Request $r): Response
    {
        $this->admin();
        $rows = $this->app->db->all('SELECT * FROM blackouts WHERE (all_day = 1 AND end_date_exclusive > ?) OR (all_day = 0 AND end_at > ?) ORDER BY COALESCE(start_date, DATE(start_at))', [
            $this->app->clock->dateKey($this->app->clock->now()->modify('-30 days')), Clock::toSql($this->app->clock->now()->modify('-30 days')),
        ]);
        return Response::json(['blackouts' => array_map([self::class, 'blackoutToApi'], $rows)]);
    }

    /** POST {allDay, startDate, endDate (inclusive), startTime?, endTime?, reason} */
    public function addBlackout(Request $r): Response
    {
        $a = $this->admin();
        $in = Input::from($r);
        $allDay = $in->bool('allDay', true);
        $startDate = (string) $in->date('startDate', true);
        $endDate = $in->date('endDate') ?? $startDate;
        if ($endDate < $startDate) {
            throw HttpError::invalid('The end date must be on or after the start date.');
        }
        $row = ['all_day' => $allDay ? 1 : 0, 'reason' => $in->str('reason', false, 300), 'created_by_user_id' => $a->id, 'created_at' => Clock::toSql($this->app->clock->now())];
        if ($allDay) {
            $row += ['start_date' => $startDate, 'end_date_exclusive' => BlackoutDates::addDays($endDate, 1)];
        } else {
            $s = $this->app->schedule->at($startDate, (string) $in->time('startTime', true));
            $e = $this->app->schedule->at($endDate, (string) $in->time('endTime', true));
            if ($e <= $s) {
                throw HttpError::invalid('The end time must be after the start time.');
            }
            $row += ['start_at' => Clock::toSql($s), 'end_at' => Clock::toSql($e)];
        }
        $id = $this->app->db->insert('blackouts', $row);
        // Report (don't silently cancel) existing bookings inside the closed period.
        $created = (array) $this->app->db->one('SELECT * FROM blackouts WHERE id = ?', [$id]);
        $from = $allDay ? $this->app->clock->dayStart($startDate) : Clock::fromSql($created['start_at']);
        $to = $allDay ? $this->app->clock->dayStart((string) BlackoutDates::addDays($endDate, 1)) : Clock::fromSql($created['end_at']);
        $affected = $this->app->db->all("SELECT * FROM bookings WHERE status IN ('pending_payment','pending','confirmed') AND start_at < ? AND end_at > ?", [Clock::toSql($to), Clock::toSql($from)]);
        $this->audit($a, 'blackout_create', 'blackout', (string) $id, $row, $r);
        return Response::json(['blackout' => self::blackoutToApi($created), 'affectedBookings' => array_map(fn ($b) => $this->app->repo->toApi($b, true), $affected)]);
    }

    public function deleteBlackout(Request $r): Response
    {
        $a = $this->admin();
        $this->app->db->run('DELETE FROM blackouts WHERE id = ?', [(int) $r->param('id')]);
        $this->audit($a, 'blackout_delete', 'blackout', $r->param('id'), [], $r);
        return Response::json(['ok' => true]);
    }

    // ------------------------------------------------------------------ clients

    public function clients(Request $r): Response
    {
        $this->admin();
        $q = Input::from($r)->str('q', false, 100);
        $params = [];
        $where = "u.role = 'client'";
        if ($q) {
            $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q) . '%';
            $where .= ' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)';
            array_push($params, $like, $like, $like);
        }
        $rows = $this->app->db->all(
            "SELECT u.id, u.name, u.email, u.phone, u.email_verified_at, u.created_at, u.last_login_at,
                    (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('confirmed','completed')) AS bookings_count,
                    (SELECT COALESCE(SUM(amount_paid),0) FROM bookings b WHERE b.user_id = u.id) AS lifetime_paid,
                    (SELECT MAX(start_at) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('confirmed','completed')) AS last_booking_at,
                    (SELECT MIN(start_at) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('pending','confirmed') AND b.start_at > UTC_TIMESTAMP()) AS next_booking_at,
                    (SELECT CONCAT_WS(', ', a.line1, a.city, a.state) FROM addresses a WHERE a.user_id = u.id ORDER BY a.is_default DESC, a.id LIMIT 1) AS address_summary
             FROM users u WHERE {$where} ORDER BY u.created_at DESC LIMIT 2000",
            $params
        );
        return Response::json(['clients' => array_map(static fn ($c) => [
            'id' => (int) $c['id'], 'name' => $c['name'], 'email' => $c['email'], 'phone' => $c['phone'], 'emailVerified' => $c['email_verified_at'] !== null,
            'createdAt' => BookingRepo::iso($c['created_at']), 'lastLoginAt' => BookingRepo::iso($c['last_login_at']),
            'bookingsCount' => (int) $c['bookings_count'], 'lifetimePaid' => round((float) $c['lifetime_paid'], 2),
            'lastBookingAt' => BookingRepo::iso($c['last_booking_at']), 'nextBookingAt' => BookingRepo::iso($c['next_booking_at']), 'addressSummary' => $c['address_summary'],
        ], $rows)]);
    }

    public function client(Request $r): Response
    {
        $this->admin();
        $id = (int) $r->param('id');
        $u = $this->app->users->rowById($id) ?? throw HttpError::notFound('Client not found.');
        $p = $this->app->db->one('SELECT * FROM client_profiles WHERE user_id = ?', [$id]);
        $addresses = $this->app->db->all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, sort_order, id', [$id]);
        $bookings = $this->app->db->all('SELECT * FROM bookings WHERE user_id = ? OR (user_id IS NULL AND contact_email_lower = ?) ORDER BY start_at DESC', [$id, $u['email_lower']]);
        return Response::json([
            'client' => ['id' => $id, 'role' => $u['role']] + MeController::profileToApi($u, $p) + ['internalNotes' => $p['internal_notes'] ?? null],
            'addresses' => array_map([MeController::class, 'addressToApi'], $addresses),
            'bookings' => array_map(fn ($b) => $this->app->repo->toApi($b, true), $bookings),
        ]);
    }

    public function updateClient(Request $r): Response
    {
        $a = $this->admin();
        $id = (int) $r->param('id');
        $this->app->users->rowById($id) ?? throw HttpError::notFound('Client not found.');
        $in = Input::from($r);
        $now = Clock::toSql($this->app->clock->now());
        $this->app->db->run('INSERT IGNORE INTO client_profiles (user_id, created_at, updated_at) VALUES (?, ?, ?)', [$id, $now, $now]);
        if ($in->has('internalNotes')) {
            $this->app->db->update('client_profiles', ['internal_notes' => $in->str('internalNotes', false, 5000), 'updated_at' => $now], ['user_id' => $id]);
        }
        $set = [];
        if ($in->has('name')) {
            $set['name'] = $in->str('name', true, 200);
        }
        if ($in->has('phone')) {
            $set['phone'] = $in->phone('phone');
        }
        if ($set) {
            $this->app->users->update($id, $set);
        }
        $this->audit($a, 'client_update', 'user', (string) $id, array_keys($in->all()), $r);
        return $this->client($r);
    }

    // ------------------------------------------------------------------ reviews

    public function reviews(Request $r): Response
    {
        $this->admin();
        $status = Input::from($r)->enum('status', ['pending', 'approved', 'declined'], false, null);
        $rows = $this->app->db->all('SELECT r.*, b.ref, b.contact_name, b.start_at FROM reviews r LEFT JOIN bookings b ON b.id = r.booking_id' . ($status ? ' WHERE r.status = ?' : '') . ' ORDER BY r.created_at DESC LIMIT 1000', $status ? [$status] : []);
        return Response::json(['reviews' => array_map(static fn ($x) => [
            'id' => (int) $x['id'], 'bookingId' => $x['ref'], 'clientName' => $x['contact_name'], 'rating' => (int) $x['rating'], 'comment' => $x['comment'],
            'displayMode' => $x['display_mode'], 'displayName' => $x['display_name'], 'serviceName' => $x['service_name'], 'status' => $x['status'],
            'createdAt' => BookingRepo::iso($x['created_at']), 'publishedAt' => BookingRepo::iso($x['published_at']), 'appointmentAt' => BookingRepo::iso($x['start_at']),
        ], $rows)]);
    }

    public function moderateReview(Request $r): Response
    {
        $a = $this->admin();
        $status = $r->param('action') === 'approve' ? 'approved' : ($r->param('action') === 'decline' ? 'declined' : throw HttpError::notFound());
        $now = Clock::toSql($this->app->clock->now());
        $n = $this->app->db->run('UPDATE reviews SET status = ?, moderated_by_user_id = ?, published_at = IF(? = \'approved\', COALESCE(published_at, ?), NULL), updated_at = ? WHERE id = ?', [$status, $a->id, $status, $now, $now, (int) $r->param('id')])->rowCount();
        if ($n !== 1) {
            throw HttpError::notFound('Review not found.');
        }
        $this->audit($a, 'review_' . $status, 'review', $r->param('id'), [], $r);
        return $this->reviews($r);
    }

    // ------------------------------------------------------------------ reports + system

    /** GET /api/admin/reports?from&to — authoritative figures from bookings + ledger. */
    public function reports(Request $r): Response
    {
        $this->admin();
        [$from, $to, $fromUtc, $toUtc] = $this->range(Input::from($r));
        $p = [Clock::toSql($fromUtc), Clock::toSql($toUtc)];
        $db = $this->app->db;
        $byStatus = $db->all('SELECT status, COUNT(*) n, SUM(total_price) total FROM bookings WHERE start_at >= ? AND start_at < ? GROUP BY status', $p);
        $byService = $db->all("SELECT service_name, COUNT(*) n, SUM(total_price) total FROM bookings WHERE start_at >= ? AND start_at < ? AND status IN ('confirmed','completed') GROUP BY service_name ORDER BY total DESC", $p);
        $byMonthMap = [];
        foreach ($db->all("SELECT paid_at, type, amount FROM payments WHERE status = 'succeeded' AND paid_at >= ? AND paid_at < ?", $p) as $row) {
            $m = $this->app->clock->toBusiness(Clock::fromSql($row['paid_at']))->format('Y-m');
            $byMonthMap[$m] = ($byMonthMap[$m] ?? 0) + ($row['type'] === 'payment' ? (float) $row['amount'] : -(float) $row['amount']);
        }
        ksort($byMonthMap);
        $byMonth = array_map(static fn ($m, $v) => ['m' => $m, 'net' => $v], array_keys($byMonthMap), $byMonthMap);
        $booked = $db->one("SELECT COUNT(*) n, COALESCE(SUM(total_price),0) total, COALESCE(AVG(total_price),0) avg FROM bookings WHERE start_at >= ? AND start_at < ? AND status IN ('confirmed','completed')", $p);
        $collected = $db->one("SELECT COALESCE(SUM(CASE WHEN type='payment' THEN amount END),0) collected, COALESCE(SUM(CASE WHEN type='refund' THEN amount END),0) refunded FROM payments WHERE status = 'succeeded' AND paid_at >= ? AND paid_at < ?", $p);
        $clients = $db->one("SELECT COUNT(DISTINCT contact_email_lower) total,
            SUM(first_at >= ? AND first_at < ?) new_clients FROM (SELECT contact_email_lower, MIN(start_at) first_at FROM bookings WHERE status IN ('confirmed','completed') GROUP BY contact_email_lower) x
            WHERE contact_email_lower IN (SELECT contact_email_lower FROM bookings WHERE start_at >= ? AND start_at < ? AND status IN ('confirmed','completed'))", array_merge($p, $p));
        return Response::json([
            'from' => $from, 'to' => $to,
            'booked' => ['count' => (int) $booked['n'], 'value' => round((float) $booked['total'], 2), 'averageTicket' => round((float) $booked['avg'], 2)],
            'collected' => round((float) $collected['collected'], 2),
            'refunded' => round((float) $collected['refunded'], 2),
            'net' => round((float) $collected['collected'] - (float) $collected['refunded'], 2),
            'clients' => ['active' => (int) $clients['total'], 'new' => (int) $clients['new_clients'], 'returning' => max(0, (int) $clients['total'] - (int) $clients['new_clients'])],
            'byStatus' => array_map(static fn ($x) => ['status' => $x['status'], 'count' => (int) $x['n'], 'value' => round((float) $x['total'], 2)], $byStatus),
            'byService' => array_map(static fn ($x) => ['service' => $x['service_name'], 'count' => (int) $x['n'], 'value' => round((float) $x['total'], 2)], $byService),
            'collectedByMonth' => array_map(static fn ($x) => ['month' => $x['m'], 'net' => round((float) $x['net'], 2)], $byMonth),
        ]);
    }

    public function system(Request $r): Response
    {
        $this->admin();
        $db = $this->app->db;
        return Response::json([
            'jobs' => array_map(static fn ($j) => ['job' => $j['job'], 'lastStartedAt' => BookingRepo::iso($j['last_started_at']), 'lastFinishedAt' => BookingRepo::iso($j['last_finished_at']), 'status' => $j['last_status'], 'result' => json_decode((string) $j['last_result'], true)], $db->all('SELECT * FROM job_runs ORDER BY job')),
            'email' => [
                'queued' => (int) $db->scalar("SELECT COUNT(*) FROM email_outbox WHERE status IN ('queued','sending')"),
                'failed' => array_map(static fn ($e) => ['id' => (int) $e['id'], 'kind' => $e['kind'], 'to' => $e['to_email'], 'subject' => $e['subject'], 'attempts' => (int) $e['attempts'], 'error' => $e['last_error'], 'createdAt' => BookingRepo::iso($e['created_at'])], $db->all("SELECT * FROM email_outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 50")),
                'sentLast7Days' => (int) $db->scalar('SELECT COUNT(*) FROM email_outbox WHERE status = \'sent\' AND sent_at >= ?', [Clock::toSql($this->app->clock->now()->modify('-7 days'))]),
            ],
            'attention' => array_map(fn ($b) => $this->app->repo->toApi($b, true), $db->all('SELECT * FROM bookings WHERE needs_attention IS NOT NULL ORDER BY updated_at DESC LIMIT 50')),
            'stripe' => ['configured' => $this->app->checkout->configured(), 'failedEvents' => (int) $db->scalar("SELECT COUNT(*) FROM stripe_events WHERE status = 'failed'")],
        ]);
    }

    public function runJob(Request $r): Response
    {
        $a = $this->admin();
        $result = $this->app->jobs->run($r->param('job'));
        $this->audit($a, 'job_run', 'job', $r->param('job'), [], $r);
        return Response::json(['result' => $result]);
    }

    public function retryEmail(Request $r): Response
    {
        $this->admin();
        $this->app->outbox->retry((int) $r->param('id'));
        return $this->system($r);
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices;

use SanchezServices\Auth\AuthService;
use SanchezServices\Auth\UserRepository;
use SanchezServices\Domain\BookingRepo;
use SanchezServices\Domain\BookingService;
use SanchezServices\Domain\Checkout;
use SanchezServices\Domain\Ledger;
use SanchezServices\Domain\Notifier;
use SanchezServices\Domain\Outbox;
use SanchezServices\Domain\Schedule;
use SanchezServices\Infra\Logger;
use SanchezServices\Infra\Mailer;
use SanchezServices\Infra\StripeClient;
use SanchezServices\Jobs\Jobs;
use SanchezServices\Security\RateLimiter;
use SanchezServices\Security\SessionStore;

/** Service container (one per request / CLI run). */
final class App
{
    public readonly Clock $clock;
    public readonly \SanchezServices\Auth\GoogleSignIn $google;
    public readonly Db $db;
    public readonly Logger $log;
    public readonly SessionStore $session;
    public readonly RateLimiter $limiter;
    public readonly UserRepository $users;
    public readonly Outbox $outbox;
    public readonly Notifier $notifier;
    public readonly AuthService $auth;
    public readonly Schedule $schedule;
    public readonly BookingRepo $repo;
    public readonly StripeClient $stripe;
    public readonly Ledger $ledger;
    public readonly BookingService $bookings;
    public readonly Checkout $checkout;
    public readonly Jobs $jobs;

    public function __construct(public readonly Config $config, ?Db $db = null, ?StripeClient $stripe = null, ?Mailer $mailer = null, ?Clock $clock = null)
    {
        date_default_timezone_set('UTC');
        $this->clock = $clock ?? new Clock($config->string('business.timezone', 'America/New_York'));
        $this->db = $db ?? new Db($config->string('db.dsn'), $config->string('db.user'), $config->string('db.password'));
        $this->log = new Logger($config->string('logging.path'));
        $this->session = new SessionStore($this->db, $config);
        $this->limiter = new RateLimiter($this->db, $this->clock, max(0.01, $config->float('security.rate_limit_multiplier', 1.0)));
        $this->users = new UserRepository($this->db, $this->clock);
        // Outside production, mail goes only to mail.recipient_allowlist (empty = nobody); in production a list restricts too.
        $allow = $config->get('mail.recipient_allowlist');
        $allow = is_array($allow) && ($allow || $config->string('app.env') !== 'production') ? array_values($allow) : ($config->string('app.env') !== 'production' ? [] : null);
        $this->outbox = new Outbox($this->db, $this->clock, $mailer ?? new Mailer($config), $this->log, $config->string('business.email'), $allow);
        $this->notifier = new Notifier($this->db, $this->clock, $config, $this->outbox);
        $this->auth = new AuthService($this->db, $this->clock, $config, $this->users, $this->session, $this->limiter, $this->notifier);
        $this->google = new \SanchezServices\Auth\GoogleSignIn($this->db, $this->clock, $config, $this->users, $this->session);
        $this->schedule = new Schedule($this->db, $this->clock, $config);
        $this->repo = new BookingRepo($this->db, $this->clock, $config);
        $this->stripe = $stripe ?? new StripeClient($config);
        $this->ledger = new Ledger($this->db, $this->clock, $this->repo, $this->notifier, $this->stripe);
        $this->bookings = new BookingService($this->db, $this->clock, $config, $this->repo, $this->schedule, $this->ledger, $this->notifier);
        $this->checkout = new Checkout($this->db, $this->clock, $config, $this->repo, $this->ledger, $this->bookings, $this->stripe, $this->log);
        $this->jobs = new Jobs($this);
    }
}

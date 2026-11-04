<?php
declare(strict_types=1);

namespace SanchezServices;

use SanchezServices\Auth\AuthService;
use SanchezServices\Auth\UserRepository;
use SanchezServices\Domain\BlackoutDates;
use SanchezServices\Domain\BookingEvents;
use SanchezServices\Domain\Bookings;
use SanchezServices\Domain\Outbox;
use SanchezServices\Domain\Payments;
use SanchezServices\Infra\Logger;
use SanchezServices\Infra\Mailer;
use SanchezServices\Infra\StripeClient;
use SanchezServices\Jobs\Jobs;
use SanchezServices\Security\RateLimiter;
use SanchezServices\Security\SessionStore;
use SanchezServices\Store\DocumentStore;
use SanchezServices\Store\Rules;

/** Service container (constructed once per request / CLI run). */
final class App
{
    public readonly Clock $clock;
    public readonly Db $db;
    public readonly Logger $log;
    public readonly SessionStore $session;
    public readonly RateLimiter $limiter;
    public readonly UserRepository $users;
    public readonly Outbox $outbox;
    public readonly AuthService $auth;
    public readonly DocumentStore $store;
    public readonly Rules $rules;
    public readonly BookingEvents $events;
    public readonly Bookings $bookings;
    public readonly StripeClient $stripe;
    public readonly Payments $payments;
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
        $this->outbox = new Outbox($this->db, $this->clock, $mailer ?? new Mailer($config), $this->log);
        $this->auth = new AuthService($this->db, $this->clock, $config, $this->users, $this->session, $this->limiter, $this->outbox);
        $this->store = new DocumentStore($this->db, $this->clock);
        $this->rules = new Rules($this->db, $this->store, $config);
        $this->events = new BookingEvents($this->clock, $config, $this->outbox, $this->log);
        $this->bookings = new Bookings($this->db, $this->clock, $config, $this->store, $this->events, new BlackoutDates($this->clock));
        $this->stripe = $stripe ?? new StripeClient($config);
        $this->payments = new Payments($this->db, $this->clock, $config, $this->bookings, $this->stripe, $this->log);
        $this->jobs = new Jobs($this);
    }
}

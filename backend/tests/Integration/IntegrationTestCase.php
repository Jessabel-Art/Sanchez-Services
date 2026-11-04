<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

use PHPUnit\Framework\TestCase;
use SanchezServices\App;
use SanchezServices\Config;

/**
 * Boots the real API under `php -S`, a fake Stripe API, and a dedicated MariaDB/MySQL test database.
 *
 * Environment overrides (CI): SS_TEST_DB_DSN, SS_TEST_DB_USER, SS_TEST_DB_PASSWORD.
 * Default: local socket database `ss_test` as user `ss`.
 * NEVER point these at a production database — every test class wipes all tables.
 */
abstract class IntegrationTestCase extends TestCase
{
    protected static ?array $env = null;
    protected static App $app;

    public static function setUpBeforeClass(): void
    {
        if (self::$env === null) {
            self::$env = self::boot();
        }
        self::resetDatabase();
        file_put_contents(self::$env['stripeState'], json_encode(['seq' => 0, 'sessions' => [], 'refunds' => [], 'requests' => [], 'idem' => []]));
        @unlink(self::$env['mailLog']);
        static::$app = new App(Config::load(self::$env['configFile']));
    }

    /** Every test starts from empty tables (schema kept). */
    protected function setUp(): void
    {
        parent::setUp();
        $pdo = static::$app->db->pdo();
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach ($pdo->query('SHOW TABLES')->fetchAll(\PDO::FETCH_COLUMN) as $t) {
            if ($t !== 'schema_migrations') {
                $pdo->exec("TRUNCATE TABLE `{$t}`");
            }
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
        file_put_contents(self::$env['stripeState'], json_encode(['seq' => 0, 'sessions' => [], 'refunds' => [], 'requests' => [], 'idem' => []]));
    }

    private static function boot(): array
    {
        $dir = sys_get_temp_dir() . '/ss-it-' . getmypid();
        @mkdir($dir, 0700, true);
        $apiPort = self::freePort();
        $stripePort = self::freePort();
        $dsn = getenv('SS_TEST_DB_DSN') ?: 'mysql:unix_socket=/run/mysqld/mysqld.sock;dbname=ss_test;charset=utf8mb4';
        if (!preg_match('/dbname=\w*test\w*/', $dsn)) {
            throw new \RuntimeException('Refusing to run integration tests against a database whose name does not contain "test".');
        }
        $config = [
            'app' => ['env' => 'test', 'url' => "http://127.0.0.1:{$apiPort}", 'key' => base64_encode(random_bytes(32)), 'debug' => true],
            'business' => ['admin_notification_emails' => ['owner@example.test'], 'phone' => '(401) 555-0100'],
            'db' => ['dsn' => $dsn, 'user' => getenv('SS_TEST_DB_USER') ?: 'ss', 'password' => getenv('SS_TEST_DB_PASSWORD') ?: 'ss_local_test'],
            'session' => ['secure' => false],
            'stripe' => ['secret_key' => 'sk_test_fake', 'webhook_secret' => 'whsec_test_secret', 'api_base' => "http://127.0.0.1:{$stripePort}"],
            'mail' => ['transport' => 'log', 'log_path' => "{$dir}/mail.log", 'recipient_allowlist' => ['@example.test']],
            'jobs' => ['runner_token' => str_repeat('j', 40)],
            'logging' => ['path' => "{$dir}/logs"],
            'security' => ['rate_limit_multiplier' => 50],
            // Test-only Firebase scrypt parameters (small mem_cost keeps tests fast).
            'auth' => [
                'firebase_scrypt' => ['signer_key' => base64_encode(str_repeat('k', 32)), 'salt_separator' => 'Bw==', 'rounds' => 8, 'mem_cost' => 4],
                'google' => ['client_id' => 'google-test-client', 'client_secret' => 'google-test-secret', 'token_url' => "http://127.0.0.1:{$stripePort}/google/token", 'auth_url' => 'https://accounts.google.test/auth'],
            ],
        ];
        $configFile = "{$dir}/config.php";
        file_put_contents($configFile, '<?php return ' . var_export($config, true) . ';');
        $stripeState = "{$dir}/stripe.json";
        file_put_contents($stripeState, '{}');
        $root = dirname(__DIR__, 2);
        $procs = [];
        $procs[] = proc_open(
            ['php', '-S', "127.0.0.1:{$apiPort}", "{$root}/tests/support/api-router.php"],
            [0 => ['pipe', 'r'], 1 => ['file', "{$dir}/api-server.log", 'a'], 2 => ['file', "{$dir}/api-server.log", 'a']],
            $pipes,
            $root,
            ['SS_CONFIG' => $configFile, 'PHP_CLI_SERVER_WORKERS' => '4'] + getenv()
        );
        $procs[] = proc_open(
            ['php', '-S', "127.0.0.1:{$stripePort}", "{$root}/tests/support/fake-stripe-router.php"],
            [0 => ['pipe', 'r'], 1 => ['file', "{$dir}/stripe-server.log", 'a'], 2 => ['file', "{$dir}/stripe-server.log", 'a']],
            $pipes2,
            $root,
            ['FAKE_STRIPE_STATE' => $stripeState] + getenv()
        );
        register_shutdown_function(static function () use ($procs) {
            foreach ($procs as $p) {
                if (is_resource($p)) {
                    proc_terminate($p);
                }
            }
        });
        foreach ([$apiPort, $stripePort] as $port) {
            $deadline = microtime(true) + 10;
            while (microtime(true) < $deadline) {
                $s = @fsockopen('127.0.0.1', $port, $e, $es, 0.2);
                if ($s) {
                    fclose($s);
                    continue 2;
                }
                usleep(100000);
            }
            throw new \RuntimeException("Server on port {$port} did not start.");
        }
        // Apply migrations through the real runner.
        self::resetDatabase($configFile, $dsn);
        return [
            'dir' => $dir, 'apiBase' => "http://127.0.0.1:{$apiPort}", 'configFile' => $configFile,
            'stripeState' => $stripeState, 'mailLog' => "{$dir}/mail.log", 'dsn' => $dsn,
        ];
    }

    private static function freePort(): int
    {
        $s = stream_socket_server('tcp://127.0.0.1:0');
        $name = stream_socket_get_name($s, false);
        fclose($s);
        return (int) substr((string) strrchr((string) $name, ':'), 1);
    }

    protected static function resetDatabase(?string $configFile = null, ?string $dsn = null): void
    {
        $configFile ??= self::$env['configFile'];
        $cfg = Config::load($configFile);
        $pdo = new \PDO($cfg->string('db.dsn'), $cfg->string('db.user'), $cfg->string('db.password'), [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach ($pdo->query('SHOW TABLES')->fetchAll(\PDO::FETCH_COLUMN) as $t) {
            $pdo->exec("DROP TABLE `{$t}`");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
        $root = dirname(__DIR__, 2);
        $out = [];
        exec('SS_CONFIG=' . escapeshellarg($configFile) . ' php ' . escapeshellarg("{$root}/bin/migrate.php") . ' 2>&1', $out, $code);
        if ($code !== 0) {
            throw new \RuntimeException("Migration failed:\n" . implode("\n", $out));
        }
    }

    protected function client(): HttpClient
    {
        return new HttpClient(self::$env['apiBase']);
    }

    /** Registers a user through the API and returns a signed-in client. */
    protected function registerClient(string $email, string $password = 'correct-horse-1', string $name = 'Test Client'): HttpClient
    {
        $c = $this->client();
        $r = $c->post('/api/auth/register', ['email' => $email, 'password' => $password, 'name' => $name]);
        $this->assertSame(200, $r['status'], json_encode($r['json']));
        return $c;
    }

    protected function makeAdmin(string $email): HttpClient
    {
        static::$app->db->run("UPDATE users SET role = 'admin' WHERE email_lower = ?", [strtolower($email)]);
        // Role changes invalidate the session (auth version) — sign in again.
        $c = $this->client();
        $this->assertSame(200, $c->post('/api/auth/login', ['email' => $email, 'password' => 'correct-horse-1'])['status']);
        return $c;
    }

    protected function adminClient(string $email = 'boss@example.test'): HttpClient
    {
        if (!static::$app->users->rowByEmail($email)) {
            $this->registerClient($email, 'correct-horse-1', 'Boss');
        }
        return $this->makeAdmin($email);
    }

    protected function userId(string $email): int
    {
        return (int) static::$app->db->scalar('SELECT id FROM users WHERE email_lower = ?', [strtolower($email)]);
    }

    /** Pays a fake Stripe session and returns the signed checkout.session.completed webhook. */
    protected function paySession(string $sessionId, ?int $amountOverride = null, string $pi = ''): array
    {
        $s = $this->stripeState()['sessions'][$sessionId];
        $s['status'] = 'complete';
        $s['payment_status'] = 'paid';
        $s['payment_intent'] = $pi !== '' ? $pi : 'pi_' . substr($sessionId, 3);
        if ($amountOverride !== null) {
            $s['amount_total'] = $amountOverride;
        }
        $this->setStripeSession($sessionId, $s);
        return $this->signedWebhook(['id' => 'evt_' . bin2hex(random_bytes(6)), 'type' => 'checkout.session.completed', 'livemode' => false, 'data' => ['object' => $s]]);
    }

    protected function webhook(array $signed): array
    {
        return $this->client()->raw('POST', '/api/stripe/webhook', $signed[0], ['Stripe-Signature' => $signed[1]]);
    }

    protected function lastSessionId(): string
    {
        $s = $this->stripeState()['sessions'];
        return (string) array_key_last($s);
    }

    protected function failNextStripeCall(): void
    {
        $s = $this->stripeState();
        $s['fail_next'] = true;
        file_put_contents(self::$env['stripeState'], json_encode($s));
    }

    /** @return list<string> kinds, optionally filtered by recipient */
    protected function emailKinds(?string $to = null): array
    {
        $rows = static::$app->db->all('SELECT kind, to_email FROM email_outbox ORDER BY id');
        return array_values(array_map(static fn ($r) => $r['kind'], array_filter($rows, static fn ($r) => $to === null || strtolower($r['to_email']) === strtolower($to))));
    }

    protected function stripeState(): array
    {
        return json_decode((string) file_get_contents(self::$env['stripeState']), true) ?: [];
    }

    protected function setStripeSession(string $id, array $fields): void
    {
        $s = $this->stripeState();
        $s['sessions'][$id] = array_merge($s['sessions'][$id] ?? [], $fields);
        file_put_contents(self::$env['stripeState'], json_encode($s));
    }

    /** @return list<array<string,mixed>> */
    protected function outbox(): array
    {
        return static::$app->db->all('SELECT * FROM email_outbox ORDER BY id');
    }

    /** Next date (local) on the given ISO weekday at least $minDays ahead. */
    protected static function nextWeekday(int $isoDow, int $minDays = 5): string
    {
        $d = new \DateTimeImmutable("+{$minDays} days", new \DateTimeZone('America/New_York'));
        while ((int) $d->format('N') !== $isoDow) {
            $d = $d->modify('+1 day');
        }
        return $d->format('Y-m-d');
    }

    protected function signedWebhook(array $event, string $secret = 'whsec_test_secret', ?int $t = null): array
    {
        $payload = json_encode($event);
        $t ??= time();
        return [$payload, 't=' . $t . ',v1=' . hash_hmac('sha256', $t . '.' . $payload, $secret)];
    }

    /** A future business date (Tue–Fri) at least $daysAhead days out, as Y-m-d. */
    protected static function futureWeekday(int $daysAhead = 10): string
    {
        $d = new \DateTimeImmutable("+{$daysAhead} days", new \DateTimeZone('America/New_York'));
        while (in_array((int) $d->format('N'), [6, 7, 1], true)) {
            $d = $d->modify('+1 day');
        }
        return $d->format('Y-m-d');
    }

    protected static function localIso(string $dateKey, string $hm): string
    {
        return (new \DateTimeImmutable("{$dateKey} {$hm}:00", new \DateTimeZone('America/New_York')))
            ->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }
}

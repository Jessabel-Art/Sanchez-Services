<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

/** Optional Google sign-in (enabled in the test config; off by default in production). */
final class GoogleSignInTest extends IntegrationTestCase
{
    private function begin(HttpClient $c, string $next = '/portal'): array
    {
        $r = $c->get('/api/auth/google/start?next=' . rawurlencode($next));
        $this->assertSame(302, $r['status']);
        parse_str((string) parse_url($r['headers']['location'][0], PHP_URL_QUERY), $q);
        $this->assertSame('google-test-client', $q['client_id']);
        return $q;
    }

    private static function code(array $claims): string
    {
        return rtrim(strtr(base64_encode(json_encode($claims)), '+/', '-_'), '=');
    }

    private function claims(array $q, array $over = []): array
    {
        return array_replace(['iss' => 'https://accounts.google.com', 'aud' => 'google-test-client', 'exp' => time() + 300, 'nonce' => $q['nonce'], 'sub' => 'g-123', 'email' => 'gina@example.test', 'email_verified' => true, 'name' => 'Gina G'], $over);
    }

    public function testNewAccountLinkingAndSecurityChecks(): void
    {
        $c = $this->client();
        $this->assertTrue($c->get('/api/auth/session')['json']['googleSignIn']);
        $q = $this->begin($c, '/book');
        $r = $c->get('/api/auth/google/callback?state=' . $q['state'] . '&code=' . self::code($this->claims($q)));
        $this->assertSame(302, $r['status']);
        $this->assertStringEndsWith('/book', $r['headers']['location'][0]);
        $me = $c->get('/api/auth/session')['json']['user'];
        $this->assertSame('gina@example.test', $me['email']);
        $this->assertTrue($me['emailVerified']);

        // Existing password account with the same (Google-verified) email is linked, not duplicated.
        $this->registerClient('pat@example.test');
        $c2 = $this->client();
        $q2 = $this->begin($c2);
        $c2->get('/api/auth/google/callback?state=' . $q2['state'] . '&code=' . self::code($this->claims($q2, ['sub' => 'g-pat', 'email' => 'Pat@Example.test'])));
        $this->assertSame('pat@example.test', $c2->get('/api/auth/session')['json']['user']['email']);
        $this->assertSame(1, (int) static::$app->db->scalar("SELECT COUNT(*) FROM users WHERE email_lower = 'pat@example.test'"));
        $this->assertSame('g-pat', static::$app->db->scalar("SELECT google_sub FROM users WHERE email_lower = 'pat@example.test'"));

        // Rejections: wrong state, wrong audience, wrong nonce, unverified email, expired token, open redirect.
        foreach ([
            ['state' => 'bogus'],
            ['claims' => ['aud' => 'someone-else']],
            ['claims' => ['nonce' => 'nope']],
            ['claims' => ['email_verified' => false, 'sub' => 'g-x', 'email' => 'x@example.test']],
            ['claims' => ['exp' => time() - 10]],
        ] as $case) {
            $c3 = $this->client();
            $q3 = $this->begin($c3);
            $r3 = $c3->get('/api/auth/google/callback?state=' . ($case['state'] ?? $q3['state']) . '&code=' . self::code($this->claims($q3, $case['claims'] ?? [])));
            $this->assertStringContainsString('/auth?error=', $r3['headers']['location'][0], json_encode($case));
            $this->assertNull($c3->get('/api/auth/session')['json']['user'], json_encode($case));
        }
        $q4 = $this->begin($this->client(), 'https://evil.example/');
        $this->assertNotEmpty($q4['state']);
        $c5 = $this->client();
        $q5 = $this->begin($c5, '//evil.example');
        $r5 = $c5->get('/api/auth/google/callback?state=' . $q5['state'] . '&code=' . self::code($this->claims($q5)));
        $this->assertStringEndsWith('/portal', $r5['headers']['location'][0], 'external next= is ignored');
    }
}

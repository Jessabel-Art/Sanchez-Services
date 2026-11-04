<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

final class AccountTest extends IntegrationTestCase
{
    private function tokenFor(string $kind, string $to): string
    {
        $rows = array_values(array_filter($this->outbox(), static fn ($m) => $m['kind'] === $kind && strtolower($m['to_email']) === strtolower($to)));
        $this->assertNotEmpty($rows, "no {$kind} email for {$to}");
        preg_match('/token=([A-Za-z0-9_-]+)/', (string) end($rows)['text_body'], $m);
        return $m[1];
    }

    public function testRegistrationLoginLogoutCsrfAndLockout(): void
    {
        $c = $this->client();
        $this->assertNull($c->session()['json']['user']);
        $this->assertSame(403, $c->post('/api/auth/register', ['email' => 'a@example.test', 'password' => 'secret123'], [], false)['status'], 'CSRF required');
        $r = $c->post('/api/auth/register', ['email' => 'A@Example.test', 'password' => 'secret123', 'name' => 'Ann Example']);
        $this->assertSame(200, $r['status'], $r['body']);
        $this->assertFalse($r['json']['user']['emailVerified']);
        $this->assertSame('Ann Example', $r['json']['user']['name']);
        $this->assertSame('auth/email-already-in-use', $this->client()->post('/api/auth/register', ['email' => 'a@example.test', 'password' => 'secret123'])['json']['error']['code']);
        $this->assertSame('auth/weak-password', $this->client()->post('/api/auth/register', ['email' => 'w@example.test', 'password' => '123'])['json']['error']['code']);
        $this->assertSame('auth/invalid-email', $this->client()->post('/api/auth/register', ['email' => 'nope', 'password' => 'secret123'])['json']['error']['code']);
        $c->post('/api/auth/logout');
        $this->assertNull($c->session()['json']['user']);
        $this->assertSame('auth/invalid-credential', $this->client()->post('/api/auth/login', ['email' => 'a@example.test', 'password' => 'wrong-one'])['json']['error']['code']);
        for ($i = 0; $i < 5; $i++) {
            $this->client()->post('/api/auth/login', ['email' => 'a@example.test', 'password' => "bad{$i}"]);
        }
        $this->assertSame('auth/too-many-requests', $this->client()->post('/api/auth/login', ['email' => 'a@example.test', 'password' => 'secret123'])['json']['error']['code'], 'locked out');
    }

    public function testVerifyResetAndEmailChange(): void
    {
        $c = $this->registerClient('v@example.test', 'first-pass');
        $this->assertSame(200, $c->post('/api/auth/verify', ['token' => $this->tokenFor('email_verify', 'v@example.test')])['status']);
        $this->assertTrue($c->session()['json']['user']['emailVerified']);
        $this->assertSame('auth/invalid-action-code', $c->post('/api/auth/verify', ['token' => $this->tokenFor('email_verify', 'v@example.test')])['json']['error']['code'], 'single use');

        $this->assertTrue($this->client()->post('/api/auth/password/forgot', ['email' => 'v@example.test'])['json']['ok']);
        $this->assertTrue($this->client()->post('/api/auth/password/forgot', ['email' => 'nobody@example.test'])['json']['ok'], 'no account enumeration');
        $token = $this->tokenFor('password_reset', 'v@example.test');
        $this->assertSame(200, $this->client()->post('/api/auth/password/reset', ['token' => $token, 'password' => 'second-pass'])['status']);
        $this->assertSame('auth/invalid-action-code', $this->client()->post('/api/auth/password/reset', ['token' => $token, 'password' => 'third-pass'])['json']['error']['code']);
        $this->assertNull($c->session()['json']['user'], 'password reset signs out other sessions');
        $c2 = $this->client();
        $this->assertSame(200, $c2->post('/api/auth/login', ['email' => 'v@example.test', 'password' => 'second-pass'])['status']);

        $e = $c2->post('/api/auth/email', ['email' => 'new@example.test']);
        $this->assertSame(200, $e['status'], 'recent login allows email change');
        $this->assertFalse($e['json']['user']['emailVerified'], 'new email must be verified again');
        $this->assertNotEmpty($this->tokenFor('email_verify', 'new@example.test'));
    }

    public function testImportedAccountWithoutPasswordMustReset(): void
    {
        static::$app->users->create('imported@example.test', null, 'Imported');
        $this->assertSame('auth/password-reset-required', $this->client()->post('/api/auth/login', ['email' => 'imported@example.test', 'password' => 'whatever'])['json']['error']['code']);
    }

    public function testProfileAndAddresses(): void
    {
        $c = $this->registerClient('p@example.test');
        $p = $c->send('PATCH', '/api/me/profile', ['name' => 'Pat Person', 'phone' => '(401) 555-0101', 'preferredContactMethod' => 'text', 'preferences' => ['fragrancePreference' => 'unscented']]);
        $this->assertSame(200, $p['status'], $p['body']);
        $this->assertSame('4015550101', $p['json']['profile']['phone']);
        $this->assertSame('unscented', $p['json']['profile']['preferences']['fragrancePreference']);
        $this->assertSame('invalid-argument', $c->send('PATCH', '/api/me/profile', ['phone' => '123'])['json']['error']['code']);
        $a1 = $c->post('/api/me/addresses', ['label' => 'Home', 'line1' => '1 Main St', 'city' => 'Providence', 'state' => 'ri', 'zip' => '02903'])['json']['addresses'];
        $this->assertTrue($a1[0]['isDefault'], 'first address becomes default');
        $this->assertSame('RI', $a1[0]['state']);
        $a2 = $c->post('/api/me/addresses', ['label' => 'Office', 'line1' => '9 Work Rd', 'city' => 'Warwick', 'state' => 'RI', 'zip' => '02886', 'isDefault' => true])['json']['addresses'];
        $this->assertSame(['Office', 'Home'], array_column($a2, 'label'));
        $this->assertSame(1, count(array_filter(array_column($a2, 'isDefault'))));
        $other = $this->registerClient('q@example.test');
        $this->assertSame(404, $other->send('PATCH', '/api/me/addresses/' . $a2[0]['id'], ['label' => 'Mine'])['status']);
        $this->assertSame(404, $other->send('DELETE', '/api/me/addresses/' . $a2[0]['id'])['status']);
        $left = $c->send('DELETE', '/api/me/addresses/' . $a2[0]['id'])['json']['addresses'];
        $this->assertTrue($left[0]['isDefault'], 'default moves to the remaining address');
    }

    public function testStagingAllowlistHoldsMailForOtherRecipients(): void
    {
        // Test config allowlist is ['@example.test']: anyone else's mail is kept as 'suppressed', never sent.
        $this->registerClient('outsider@customer.test');
        $this->registerClient('insider@example.test');
        static::$app->outbox->sendDue();
        $rows = static::$app->db->all("SELECT to_email, status FROM email_outbox WHERE kind = 'email_verify' ORDER BY id");
        $by = array_column($rows, 'status', 'to_email');
        $this->assertSame('suppressed', $by['outsider@customer.test']);
        $this->assertSame('sent', $by['insider@example.test']);
        $log = (string) @file_get_contents(self::$env['mailLog']);
        $this->assertStringNotContainsString('outsider@customer.test', $log);
    }
}

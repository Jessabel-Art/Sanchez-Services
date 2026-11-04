<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Integration;

final class AuthAndRulesTest extends IntegrationTestCase
{
    public function testRegisterLoginLogoutAndCsrf(): void
    {
        $c = $this->client();
        $s = $c->session();
        $this->assertSame(200, $s['status']);
        $this->assertNull($s['json']['user']);
        $this->assertSame('no-store, private', $s['headers']['cache-control'][0]);

        // CSRF required for state-changing requests
        $r = $c->post('/api/auth/register', ['email' => 'a@example.test', 'password' => 'secret123'], [], false);
        $this->assertSame(403, $r['status']);

        $r = $c->post('/api/auth/register', ['email' => 'A@Example.test', 'password' => 'secret123']);
        $this->assertSame(200, $r['status'], $r['body']);
        $this->assertSame('A@Example.test', $r['json']['user']['email']);
        $this->assertFalse($r['json']['user']['isAdmin']);
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9]{28}$/', $r['json']['user']['uid']);

        $dup = $this->client()->post('/api/auth/register', ['email' => 'a@example.test', 'password' => 'secret123']);
        $this->assertSame('auth/email-already-in-use', $dup['json']['error']['code']);

        $weak = $this->client()->post('/api/auth/register', ['email' => 'w@example.test', 'password' => '123']);
        $this->assertSame('auth/weak-password', $weak['json']['error']['code']);

        $c->post('/api/auth/logout');
        $this->assertNull($c->session()['json']['user']);

        $bad = $this->client()->post('/api/auth/login', ['email' => 'a@example.test', 'password' => 'nope-nope']);
        $this->assertSame('auth/invalid-credential', $bad['json']['error']['code']);

        $ok = $this->client()->post('/api/auth/login', ['email' => 'a@example.test', 'password' => 'secret123']);
        $this->assertSame(200, $ok['status']);
        $this->assertSame('a@example.test', strtolower($ok['json']['user']['email']));
    }

    public function testCrossOriginPostIsRejected(): void
    {
        $c = $this->client();
        $c->session();
        $r = $c->post('/api/auth/login', ['email' => 'a@example.test', 'password' => 'secret123'], ['Origin' => 'https://evil.example']);
        $this->assertSame(403, $r['status']);
    }

    public function testLockoutAfterRepeatedFailures(): void
    {
        $this->registerClient('lock@example.test', 'right-password');
        for ($i = 0; $i < 5; $i++) {
            $this->client()->post('/api/auth/login', ['email' => 'lock@example.test', 'password' => 'wrong' . $i]);
        }
        $r = $this->client()->post('/api/auth/login', ['email' => 'lock@example.test', 'password' => 'right-password']);
        $this->assertSame('auth/too-many-requests', $r['json']['error']['code']);
    }

    public function testPasswordResetFlowIsSingleUse(): void
    {
        $this->registerClient('reset@example.test', 'old-password');
        $r = $this->client()->post('/api/auth/password/forgot', ['email' => 'reset@example.test']);
        $this->assertTrue($r['json']['ok']);
        // Unknown emails get the same response (no enumeration)
        $this->assertTrue($this->client()->post('/api/auth/password/forgot', ['email' => 'nobody@example.test'])['json']['ok']);

        $mail = array_values(array_filter($this->outbox(), static fn ($m) => $m['kind'] === 'password_reset'));
        $this->assertCount(1, $mail);
        preg_match('/token=([A-Za-z0-9_-]+)/', (string) $mail[0]['text_body'], $m);
        $token = $m[1];
        $this->assertStringContainsString('/auth/reset?token=', (string) $mail[0]['text_body']);

        $ok = $this->client()->post('/api/auth/password/reset', ['token' => $token, 'password' => 'new-password']);
        $this->assertSame(200, $ok['status'], $ok['body']);
        $again = $this->client()->post('/api/auth/password/reset', ['token' => $token, 'password' => 'another-one']);
        $this->assertSame('auth/invalid-action-code', $again['json']['error']['code']);
        $this->assertSame(200, $this->client()->post('/api/auth/login', ['email' => 'reset@example.test', 'password' => 'new-password'])['status']);
        $this->assertSame('auth/invalid-credential', $this->client()->post('/api/auth/login', ['email' => 'reset@example.test', 'password' => 'old-password'])['json']['error']['code']);
    }

    public function testImportedUserWithoutPasswordMustReset(): void
    {
        static::$app->users->create('imported@example.test', null, 'client', 'FirebaseUidImported000000001');
        $r = $this->client()->post('/api/auth/login', ['email' => 'imported@example.test', 'password' => 'whatever']);
        $this->assertSame('auth/password-reset-required', $r['json']['error']['code']);
    }

    public function testProfileRulesMatchFirestoreRules(): void
    {
        $c = $this->registerClient('p1@example.test');
        $uid = $this->uidOf('p1@example.test');
        $ok = $c->post('/api/db/commit', ['writes' => [['op' => 'set', 'path' => "profiles/$uid", 'merge' => true, 'data' => ['name' => 'P One', 'email' => 'p1@example.test', 'emailLower' => 'p1@example.test', 'updatedAt' => ['__op' => 'serverTimestamp']]]]]);
        $this->assertSame(200, $ok['status'], $ok['body']);

        // Protected fields are rejected (safeProfileUpdate)
        $bad = $c->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "profiles/$uid", 'data' => ['role' => 'admin']]]]);
        $this->assertSame(403, $bad['status']);
        $bad2 = $c->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "profiles/$uid", 'data' => ['emailLower' => 'other@example.test']]]]);
        $this->assertSame(403, $bad2['status']);

        // Another user cannot read or write it
        $other = $this->registerClient('p2@example.test');
        $this->assertSame(403, $other->post('/api/db/get', ['path' => "profiles/$uid"])['status']);
        $this->assertSame(403, $other->post('/api/db/commit', ['writes' => [['op' => 'update', 'path' => "profiles/$uid", 'data' => ['name' => 'x']]]])['status']);
        $list = $other->post('/api/db/query', ['collection' => 'profiles']);
        $this->assertNotContains($uid, array_column($list['json']['docs'], 'id'));

        $get = $c->post('/api/db/get', ['path' => "profiles/$uid"]);
        $this->assertTrue($get['json']['exists']);
        $this->assertSame('P One', $get['json']['data']['name']);
        $this->assertArrayHasKey('__ts', $get['json']['data']['updatedAt']);

        // Admins can read all profiles and the admin doc reflects the role
        $this->makeAdmin('p2@example.test');
        $adminList = $other->post('/api/db/query', ['collection' => 'profiles', 'orderBy' => [['createdAt', 'desc']]]);
        $this->assertSame(200, $adminList['status']);
        $p2uid = $this->uidOf('p2@example.test');
        $this->assertTrue($other->post('/api/db/get', ['path' => "admins/$p2uid"])['json']['exists']);
        $this->assertFalse($c->post('/api/db/get', ['path' => "admins/$uid"])['json']['exists']);
        $this->assertTrue($other->session()['json']['user']['isAdmin']);
    }

    public function testAddressesSubcollection(): void
    {
        $c = $this->registerClient('addr@example.test');
        $uid = $this->uidOf('addr@example.test');
        $r = $c->post('/api/db/commit', ['writes' => [['op' => 'create', 'path' => "profiles/$uid/addresses", 'data' => ['street' => '1 Main', 'city' => 'Providence', 'isDefault' => true, 'createdAt' => ['__op' => 'serverTimestamp']]]]]);
        $this->assertSame(200, $r['status'], $r['body']);
        $id = $r['json']['results'][0]['id'];
        $q = $c->post('/api/db/query', ['collection' => "profiles/$uid/addresses", 'orderBy' => [['createdAt', 'desc']]]);
        $this->assertSame([$id], array_column($q['json']['docs'], 'id'));
        $other = $this->registerClient('addr2@example.test');
        $this->assertSame([], $other->post('/api/db/query', ['collection' => "profiles/$uid/addresses"])['json']['docs']);
        $this->assertSame(403, $other->post('/api/db/commit', ['writes' => [['op' => 'delete', 'path' => "profiles/$uid/addresses/$id"]]])['status']);
        $this->assertSame(200, $c->post('/api/db/commit', ['writes' => [['op' => 'delete', 'path' => "profiles/$uid/addresses/$id"]]])['status']);
    }

    public function testBlackoutsAndMailAreAdminOnly(): void
    {
        $c = $this->registerClient('nonadmin@example.test');
        $w = ['op' => 'create', 'path' => 'blackouts', 'data' => ['allDay' => true, 'startDateKey' => '2030-01-01', 'endDateKey' => '2030-01-02', 'startAt' => ['__ts' => '2030-01-01T05:00:00.000Z'], 'endAt' => ['__ts' => '2030-01-02T05:00:00.000Z']]];
        $this->assertSame(403, $c->post('/api/db/commit', ['writes' => [$w]])['status']);
        $this->assertSame(403, $c->post('/api/db/commit', ['writes' => [['op' => 'create', 'path' => 'mail', 'data' => ['to' => ['x@example.test'], 'message' => ['subject' => 's', 'text' => 't']]]]])['status']);
        $this->makeAdmin('nonadmin@example.test');
        $this->assertSame(200, $c->post('/api/db/commit', ['writes' => [$w]])['status']);
        $this->assertSame(200, $c->post('/api/db/commit', ['writes' => [['op' => 'create', 'path' => 'mail', 'data' => ['to' => ['x@example.test'], 'message' => ['subject' => 'Admin note', 'text' => 't']]]]])['status']);
        $this->assertContains('Admin note', array_column($this->outbox(), 'subject'));
    }
}

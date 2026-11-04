<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Unit;

use PHPUnit\Framework\TestCase;
use SanchezServices\Migration\FirebaseScrypt;

/** Reference values come from Python hashlib.scrypt + AES-CTR (tests/fixtures/scrypt-reference.json). */
final class FirebaseScryptTest extends TestCase
{
    public function testScryptMatchesReferenceImplementation(): void
    {
        $f = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/scrypt-reference.json'), true);
        foreach ($f['scrypt'] as $c) {
            if ($c['n'] > 1024) {
                continue; // the large vector is covered by the Firebase test below
            }
            $this->assertSame($c['out'], bin2hex(FirebaseScrypt::scrypt($c['pw'], $c['salt'], $c['n'], $c['r'], $c['p'], $c['dk'])));
        }
    }

    public function testFirebasePublishedExample(): void
    {
        $c = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/scrypt-reference.json'), true)['firebase'];
        // Same value as the example in github.com/firebase/scrypt
        $this->assertSame('lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==', $c['hash']);
        $this->assertTrue(FirebaseScrypt::verify($c['pw'], $c['hash'], $c['salt'], $c['signer'], $c['sep'], $c['rounds'], $c['mem']));
        $this->assertFalse(FirebaseScrypt::verify('not-the-password', $c['hash'], $c['salt'], $c['signer'], $c['sep'], $c['rounds'], $c['mem']));
    }
}

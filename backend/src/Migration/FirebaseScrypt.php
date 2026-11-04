<?php
declare(strict_types=1);

namespace SanchezServices\Migration;

/**
 * Verifier for Firebase Auth's modified scrypt password hashes — COMPATIBILITY TOOL ONLY.
 *
 * It is NOT wired into login. Use bin/check-firebase-password-hash.php to validate it against a
 * real test account from the production Firebase project before any decision to rely on it.
 *
 * Algorithm (github.com/firebase/scrypt):
 *   key  = scrypt(password, salt || saltSeparator, N = 2^memCost, r = rounds, p = 1, dkLen = 32)
 *   hash = AES-256-CTR(key, iv = 16 zero bytes).encrypt(signerKey)
 *   valid iff base64(hash) == passwordHash
 * Pure PHP (no PECL scrypt needed); memory ≈ 128·r·N bytes (16 MiB for the Firebase defaults).
 */
final class FirebaseScrypt
{
    public static function verify(string $password, string $passwordHashB64, string $saltB64, string $signerKeyB64, string $saltSeparatorB64, int $rounds, int $memCost): bool
    {
        $expected = base64_decode($passwordHashB64, true);
        $salt = base64_decode($saltB64, true);
        $signer = base64_decode($signerKeyB64, true);
        $sep = base64_decode($saltSeparatorB64, true);
        if ($expected === false || $salt === false || $signer === false || $sep === false) {
            return false;
        }
        $hash = self::hash($password, $salt, $signer, $sep, $rounds, $memCost);
        return hash_equals($expected, $hash);
    }

    /** Returns raw hash bytes (same length as signer key). */
    public static function hash(string $password, string $salt, string $signerKey, string $saltSeparator, int $rounds, int $memCost): string
    {
        if ($memCost < 1 || $memCost > 20 || $rounds < 1 || $rounds > 16) {
            throw new \InvalidArgumentException('Unsupported Firebase scrypt parameters.');
        }
        $key = self::scrypt($password, $salt . $saltSeparator, 1 << $memCost, $rounds, 1, 32);
        $out = openssl_encrypt($signerKey, 'aes-256-ctr', $key, OPENSSL_RAW_DATA, str_repeat("\0", 16));
        if ($out === false) {
            throw new \RuntimeException('AES-256-CTR unavailable in OpenSSL.');
        }
        return $out;
    }

    /** RFC 7914 scrypt. */
    public static function scrypt(string $password, string $salt, int $N, int $r, int $p, int $dkLen): string
    {
        if ($N < 2 || ($N & ($N - 1)) !== 0) {
            throw new \InvalidArgumentException('N must be a power of two > 1.');
        }
        $blockLen = 128 * $r;
        $B = hash_pbkdf2('sha256', $password, $salt, 1, $p * $blockLen, true);
        $out = '';
        for ($i = 0; $i < $p; $i++) {
            $out .= self::roMix(substr($B, $i * $blockLen, $blockLen), $N, $r);
        }
        return hash_pbkdf2('sha256', $password, $out, 1, $dkLen, true);
    }

    private static function roMix(string $X, int $N, int $r): string
    {
        $V = [];
        for ($i = 0; $i < $N; $i++) {
            $V[$i] = $X;
            $X = self::blockMix($X, $r);
        }
        $lastOffset = (2 * $r - 1) * 64;
        $mask = $N - 1;
        for ($i = 0; $i < $N; $i++) {
            $j = unpack('V', $X, $lastOffset)[1] & $mask;
            $X = self::blockMix($X ^ $V[$j], $r);
        }
        return $X;
    }

    private static function blockMix(string $B, int $r): string
    {
        $blocks = 2 * $r;
        $x = array_values(unpack('V16', $B, ($blocks - 1) * 64));
        $even = '';
        $odd = '';
        for ($i = 0; $i < $blocks; $i++) {
            $b = unpack('V16', $B, $i * 64);
            for ($k = 0; $k < 16; $k++) {
                $x[$k] ^= $b[$k + 1];
            }
            $x = self::salsa208($x);
            $packed = pack('V16', ...$x);
            if ($i % 2 === 0) {
                $even .= $packed;
            } else {
                $odd .= $packed;
            }
        }
        return $even . $odd;
    }

    /** @param list<int> $in */
    private static function salsa208(array $in): array
    {
        [$x0, $x1, $x2, $x3, $x4, $x5, $x6, $x7, $x8, $x9, $x10, $x11, $x12, $x13, $x14, $x15] = $in;
        for ($i = 0; $i < 8; $i += 2) {
            // column round
            $t = ($x0 + $x12) & 0xffffffff; $x4 ^= (($t << 7) | ($t >> 25)) & 0xffffffff;
            $t = ($x4 + $x0) & 0xffffffff; $x8 ^= (($t << 9) | ($t >> 23)) & 0xffffffff;
            $t = ($x8 + $x4) & 0xffffffff; $x12 ^= (($t << 13) | ($t >> 19)) & 0xffffffff;
            $t = ($x12 + $x8) & 0xffffffff; $x0 ^= (($t << 18) | ($t >> 14)) & 0xffffffff;
            $t = ($x5 + $x1) & 0xffffffff; $x9 ^= (($t << 7) | ($t >> 25)) & 0xffffffff;
            $t = ($x9 + $x5) & 0xffffffff; $x13 ^= (($t << 9) | ($t >> 23)) & 0xffffffff;
            $t = ($x13 + $x9) & 0xffffffff; $x1 ^= (($t << 13) | ($t >> 19)) & 0xffffffff;
            $t = ($x1 + $x13) & 0xffffffff; $x5 ^= (($t << 18) | ($t >> 14)) & 0xffffffff;
            $t = ($x10 + $x6) & 0xffffffff; $x14 ^= (($t << 7) | ($t >> 25)) & 0xffffffff;
            $t = ($x14 + $x10) & 0xffffffff; $x2 ^= (($t << 9) | ($t >> 23)) & 0xffffffff;
            $t = ($x2 + $x14) & 0xffffffff; $x6 ^= (($t << 13) | ($t >> 19)) & 0xffffffff;
            $t = ($x6 + $x2) & 0xffffffff; $x10 ^= (($t << 18) | ($t >> 14)) & 0xffffffff;
            $t = ($x15 + $x11) & 0xffffffff; $x3 ^= (($t << 7) | ($t >> 25)) & 0xffffffff;
            $t = ($x3 + $x15) & 0xffffffff; $x7 ^= (($t << 9) | ($t >> 23)) & 0xffffffff;
            $t = ($x7 + $x3) & 0xffffffff; $x11 ^= (($t << 13) | ($t >> 19)) & 0xffffffff;
            $t = ($x11 + $x7) & 0xffffffff; $x15 ^= (($t << 18) | ($t >> 14)) & 0xffffffff;
            // row round
            $t = ($x0 + $x3) & 0xffffffff; $x1 ^= (($t << 7) | ($t >> 25)) & 0xffffffff;
            $t = ($x1 + $x0) & 0xffffffff; $x2 ^= (($t << 9) | ($t >> 23)) & 0xffffffff;
            $t = ($x2 + $x1) & 0xffffffff; $x3 ^= (($t << 13) | ($t >> 19)) & 0xffffffff;
            $t = ($x3 + $x2) & 0xffffffff; $x0 ^= (($t << 18) | ($t >> 14)) & 0xffffffff;
            $t = ($x5 + $x4) & 0xffffffff; $x6 ^= (($t << 7) | ($t >> 25)) & 0xffffffff;
            $t = ($x6 + $x5) & 0xffffffff; $x7 ^= (($t << 9) | ($t >> 23)) & 0xffffffff;
            $t = ($x7 + $x6) & 0xffffffff; $x4 ^= (($t << 13) | ($t >> 19)) & 0xffffffff;
            $t = ($x4 + $x7) & 0xffffffff; $x5 ^= (($t << 18) | ($t >> 14)) & 0xffffffff;
            $t = ($x10 + $x9) & 0xffffffff; $x11 ^= (($t << 7) | ($t >> 25)) & 0xffffffff;
            $t = ($x11 + $x10) & 0xffffffff; $x8 ^= (($t << 9) | ($t >> 23)) & 0xffffffff;
            $t = ($x8 + $x11) & 0xffffffff; $x9 ^= (($t << 13) | ($t >> 19)) & 0xffffffff;
            $t = ($x9 + $x8) & 0xffffffff; $x10 ^= (($t << 18) | ($t >> 14)) & 0xffffffff;
            $t = ($x15 + $x14) & 0xffffffff; $x12 ^= (($t << 7) | ($t >> 25)) & 0xffffffff;
            $t = ($x12 + $x15) & 0xffffffff; $x13 ^= (($t << 9) | ($t >> 23)) & 0xffffffff;
            $t = ($x13 + $x12) & 0xffffffff; $x14 ^= (($t << 13) | ($t >> 19)) & 0xffffffff;
            $t = ($x14 + $x13) & 0xffffffff; $x15 ^= (($t << 18) | ($t >> 14)) & 0xffffffff;
        }
        $o = [$x0, $x1, $x2, $x3, $x4, $x5, $x6, $x7, $x8, $x9, $x10, $x11, $x12, $x13, $x14, $x15];
        for ($k = 0; $k < 16; $k++) {
            $o[$k] = ($o[$k] + $in[$k]) & 0xffffffff;
        }
        return $o;
    }
}

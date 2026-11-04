<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Unit;

use PHPUnit\Framework\TestCase;
use SanchezServices\Domain\BlackoutDates;
use SanchezServices\Domain\PaymentMath;
use SanchezServices\Domain\Pricing;

/**
 * Golden tests: outputs recorded from the current JavaScript code
 * (tools/generate-parity-fixtures.cjs) must match the PHP ports exactly.
 */
final class JsParityTest extends TestCase
{
    private static array $f;

    public static function setUpBeforeClass(): void
    {
        self::$f = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/js-parity.json'), true, 512, JSON_THROW_ON_ERROR);
    }

    private static function assertNumericEquals(mixed $expected, mixed $actual, string $msg): void
    {
        if (is_array($expected)) {
            self::assertIsArray($actual, $msg);
            self::assertSame(array_keys($expected), array_keys($actual), $msg . ' keys');
            foreach ($expected as $k => $v) {
                self::assertNumericEquals($v, $actual[$k], "$msg.$k");
            }
            return;
        }
        if (is_int($expected) || is_float($expected)) {
            self::assertTrue(is_int($actual) || is_float($actual), "$msg: expected number, got " . var_export($actual, true));
            self::assertEqualsWithDelta((float) $expected, (float) $actual, 1e-9, $msg);
            return;
        }
        self::assertSame($expected, $actual, $msg);
    }

    public function testPricing(): void
    {
        foreach (self::$f['pricing'] as $i => $c) {
            self::assertNumericEquals($c['output'], Pricing::calculate($c['input'], (float) $c['deposit']), "pricing case $i " . json_encode($c['input']));
        }
    }

    public function testStripeFeeMath(): void
    {
        foreach (self::$f['feeCases'] as $c) {
            self::assertNumericEquals($c['output'], PaymentMath::grossFromNet($c['net']), 'fee ' . json_encode($c['net']));
        }
    }

    public function testDateKeyArithmetic(): void
    {
        foreach (self::$f['addDays'] as $c) {
            self::assertSame($c['out'], BlackoutDates::addDays($c['key'], $c['n']), json_encode($c));
        }
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Unit;

use PHPUnit\Framework\TestCase;
use SanchezServices\Clock;
use SanchezServices\Domain\BlackoutDates;
use SanchezServices\Domain\BookingEvents;
use SanchezServices\Domain\PaymentAmounts;
use SanchezServices\Domain\PaymentMath;
use SanchezServices\Domain\Pricing;
use SanchezServices\Domain\Slots;
use SanchezServices\Store\Doc;

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

    public function testPaymentAmountsAndStatus(): void
    {
        foreach (self::$f['amounts'] as $c) {
            $a = PaymentAmounts::fromBooking($c['booking']);
            self::assertNumericEquals($c['amounts'], $a, 'amounts ' . json_encode($c['booking']));
            self::assertSame($c['status'], PaymentAmounts::normalizeStatus($a, $c['booking']), 'status ' . json_encode($c['booking']));
        }
    }

    public function testBookingEmail(): void
    {
        foreach (self::$f['emails'] as $c) {
            self::assertSame($c['email'], PaymentAmounts::bookingEmail($c['booking']), json_encode($c['booking']));
        }
    }

    public function testBuildPaymentPatch(): void
    {
        foreach (self::$f['patchCases'] as $i => $c) {
            $error = null;
            $out = null;
            try {
                $out = PaymentAmounts::buildPaymentPatch($c['booking'], $c['mode'], 'pi_same', $c['metadata']);
            } catch (\DomainException $e) {
                $error = $e->getMessage();
            }
            self::assertSame($c['error'], $error, "patch case $i error");
            if ($c['output'] === null) {
                self::assertNull($out, "patch case $i");
                continue;
            }
            ksort($c['output']);
            ksort($out);
            self::assertNumericEquals($c['output'], $out, "patch case $i");
        }
    }

    public function testNearestSlotLabel(): void
    {
        $clock = new Clock('America/New_York');
        foreach (self::$f['slotCases'] as $c) {
            self::assertSame($c['label'], Slots::nearestLabel($clock, Doc::toDate($c['iso']), $c['explicit']), $c['iso']);
        }
    }

    public function testBlackoutDateKeys(): void
    {
        $bd = new BlackoutDates(new Clock('America/New_York'));
        foreach (self::$f['blocked'] as $c) {
            self::assertSame($c['blocked'], BlackoutDates::isFullDayDateBlocked($c['blackout'], $c['dateKey']), json_encode($c));
        }
        foreach (self::$f['overlaps'] as $c) {
            self::assertSame($c['overlaps'], $bd->fullDayOverlapsRange($c['blackout'], Doc::toDate($c['start']), Doc::toDate($c['end'])), json_encode($c));
        }
        foreach (self::$f['addDays'] as $c) {
            self::assertSame($c['out'], BlackoutDates::addDays($c['key'], $c['n']), json_encode($c));
        }
    }

    public function testReminderNotesAndAddresses(): void
    {
        foreach (self::$f['reminderNotes'] as $c) {
            self::assertSame($c['note'], BookingEvents::reminderPaymentNote($c['booking']), json_encode($c['booking']));
        }
        foreach (self::$f['addresses'] as $c) {
            self::assertSame($c['out'], BookingEvents::formatAddress($c['booking']), json_encode($c['booking']));
        }
    }
}

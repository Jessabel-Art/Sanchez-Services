<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

/** Port of functions/stripeFeeMath.js (customer covers the estimated 2.9% + $0.30 card fee). */
final class PaymentMath
{
    public const PERCENT_FEE = 0.029;
    public const FIXED_FEE = 0.30;

    public static function dollarsToCents(mixed $amount): int
    {
        $v = is_numeric($amount) ? (float) $amount : 0.0;
        if (!is_finite($v)) {
            return 0;
        }
        return (int) self::jsRound($v * 100);
    }

    public static function centsToDollars(int|float $cents): float
    {
        return round($cents / 100, 2);
    }

    public static function estimateFeeFromGrossCents(int $grossCents, float $percent = self::PERCENT_FEE, float $fixed = self::FIXED_FEE): int
    {
        $grossCents = max(0, $grossCents);
        return (int) self::jsRound($grossCents * $percent) + self::dollarsToCents($fixed);
    }

    /** @return array{netAmount:float,netAmountCents:int,grossAmount:float,grossAmountCents:int,estimatedFee:float,estimatedFeeCents:int,percentFee:float,fixedFee:float} */
    public static function grossFromNet(mixed $netAmount, float $percent = self::PERCENT_FEE, float $fixed = self::FIXED_FEE): array
    {
        $netCents = self::dollarsToCents($netAmount);
        if ($netCents <= 0) {
            return [
                'netAmount' => 0.0, 'netAmountCents' => 0, 'grossAmount' => 0.0, 'grossAmountCents' => 0,
                'estimatedFee' => 0.0, 'estimatedFeeCents' => 0, 'percentFee' => $percent, 'fixedFee' => $fixed,
            ];
        }
        $fixedCents = self::dollarsToCents($fixed);
        $gross = max($netCents, (int) self::jsRound(($netCents + $fixedCents) / (1 - $percent)));
        $fee = self::estimateFeeFromGrossCents($gross, $percent, $fixed);
        while ($gross - $fee < $netCents) {
            $gross++;
            $fee = self::estimateFeeFromGrossCents($gross, $percent, $fixed);
        }
        while ($gross > $netCents) {
            $prior = $gross - 1;
            $priorFee = self::estimateFeeFromGrossCents($prior, $percent, $fixed);
            if ($prior - $priorFee < $netCents) {
                break;
            }
            $gross = $prior;
            $fee = $priorFee;
        }
        return [
            'netAmount' => self::centsToDollars($netCents),
            'netAmountCents' => $netCents,
            'grossAmount' => self::centsToDollars($gross),
            'grossAmountCents' => $gross,
            'estimatedFee' => self::centsToDollars($fee),
            'estimatedFeeCents' => $fee,
            'percentFee' => $percent,
            'fixedFee' => self::centsToDollars($fixedCents),
        ];
    }

    /** JavaScript Math.round semantics (round half toward +infinity). */
    public static function jsRound(float $v): float
    {
        return floor($v + 0.5);
    }

    /** JavaScript Number.prototype.toFixed(2) then Number() — for parity with JS money rounding. */
    public static function toFixed2(float $v): float
    {
        return (float) self::toFixed($v, 2);
    }

    /**
     * Exact ECMAScript Number.prototype.toFixed(): rounds the exact binary value of the double,
     * ties go to the larger magnitude. (number_format pre-rounds; sprintf rounds ties to even.)
     */
    public static function toFixed(float $v, int $digits): string
    {
        if (!is_finite($v)) {
            return (string) $v;
        }
        $neg = $v < 0;
        $exact = sprintf('%.53F', abs($v)); // exact expansion for the magnitudes used here
        [$int, $frac] = explode('.', $exact) + [1 => ''];
        $kept = $int . substr($frac, 0, $digits);
        $next = (int) ($frac[$digits] ?? '0');
        if ($next >= 5) {
            // increment the decimal string $kept by one unit in the last place
            $chars = str_split($kept);
            for ($i = count($chars) - 1; $i >= 0; $i--) {
                if ($chars[$i] === '9') {
                    $chars[$i] = '0';
                    continue;
                }
                $chars[$i] = (string) ((int) $chars[$i] + 1);
                break;
            }
            $kept = ($i < 0 ? '1' : '') . implode('', $chars);
        }
        $intPart = substr($kept, 0, strlen($kept) - $digits);
        $fracPart = substr($kept, strlen($kept) - $digits);
        $out = ltrim($intPart, '0') === '' ? '0' : ltrim($intPart, '0');
        if ($digits > 0) {
            $out .= '.' . $fracPart;
        }
        return ($neg && (float) $out != 0.0 ? '-' : '') . $out;
    }
}

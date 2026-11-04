<?php
declare(strict_types=1);

namespace SanchezServices\Domain;

/** Port of calculateAuthoritativePricing() in functions/index.js. Keep in sync with src/data/services.js. */
final class Pricing
{
    public const SERVICE_PRICING = [
        'residential-cleaning' => ['name' => 'Residential Cleaning', 'basePrice' => 80, 'durationMultiplier' => 1, 'recurringDiscountEligible' => true],
        'deep-clean' => ['name' => 'Deep Clean', 'basePrice' => 120, 'durationMultiplier' => 1.5, 'recurringDiscountEligible' => true],
        'move-in-move-out' => ['name' => 'Move-In/Move-Out', 'basePrice' => 144, 'durationMultiplier' => 1.8, 'recurringDiscountEligible' => false],
        'office-cleaning' => ['name' => 'Office Cleaning', 'basePrice' => 0, 'sqftRate' => 0.12, 'sqftPerHour' => 500, 'recurringDiscountEligible' => false],
    ];

    public const ADD_ON_PRICING = [
        'fridge' => ['label' => 'Inside Fridge', 'price' => 20, 'durationHours' => 0.5],
        'oven' => ['label' => 'Inside Oven', 'price' => 20, 'durationHours' => 0.5],
        'windows' => ['label' => 'Interior Windows', 'price' => 30, 'durationHours' => 0.5],
        'baseboards' => ['label' => 'Baseboards', 'price' => 25, 'durationHours' => 0.5],
        'laundry' => ['label' => 'Laundry Fold', 'price' => 15, 'durationHours' => 0.5],
        'garage' => ['label' => 'Garage Sweep', 'price' => 20, 'durationHours' => 0.5],
        'carpet' => ['label' => 'Carpet Shampoo', 'price' => 40, 'durationHours' => 0.5],
    ];

    public const FREQUENCY_DISCOUNTS = ['one-time' => 0, 'weekly' => 0.15, 'biweekly' => 0.1, 'monthly' => 0.05];
    public const CONDITION_MULTIPLIERS = ['light' => 0.9, 'standard' => 1, 'heavy' => 1.25];
    public const CONDITION_DURATION_MULTIPLIERS = ['light' => 1, 'standard' => 1, 'heavy' => 1.2];

    public static function normalizeServiceSlug(mixed $value): string
    {
        $slug = strtolower(trim((string) ($value ?? 'residential-cleaning')));
        if ($slug === '') {
            $slug = 'residential-cleaning';
        }
        return match ($slug) {
            'deep-cleaning' => 'deep-clean',
            'moving-cleaning' => 'move-in-move-out',
            'commercial-cleaning' => 'office-cleaning',
            default => isset(self::SERVICE_PRICING[$slug]) ? $slug : 'residential-cleaning',
        };
    }

    public static function normalizeCondition(mixed $value): string
    {
        $c = strtolower((string) ($value ?? ''));
        return in_array($c, ['light', 'standard', 'heavy'], true) ? $c : 'standard';
    }

    public static function hasPets(array $b): bool
    {
        return ($b['pets'] ?? null) === true || ($b['pets'] ?? null) === 'yes' || ($b['petsOnSite'] ?? null) === true;
    }

    /** JavaScript `a || b || c` semantics. */
    public static function jsOr(mixed ...$values): mixed
    {
        foreach ($values as $v) {
            if (!($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0)) {
                return $v;
            }
        }
        return $values[count($values) - 1] ?? null;
    }

    private static function num(mixed $v): float
    {
        return is_numeric($v) ? (float) $v : 0.0;
    }

    /** @return array<string,mixed> */
    public static function calculate(array $b, float $requiredDeposit): array
    {
        $serviceSlug = self::normalizeServiceSlug($b['serviceSlug'] ?? $b['service'] ?? $b['serviceId'] ?? null);
        $service = self::SERVICE_PRICING[$serviceSlug];
        $bedrooms = max(0, self::num($b['bedrooms'] ?? 0));
        $bathrooms = max(0, self::num($b['bathrooms'] ?? 0));
        $sqft = max(0, self::num(self::jsOr($b['sqft'] ?? null, $b['squareFeet'] ?? null, 0)));
        $condition = self::normalizeCondition($b['condition'] ?? null);
        $frequency = is_string($b['frequency'] ?? null) && array_key_exists($b['frequency'], self::FREQUENCY_DISCOUNTS) ? $b['frequency'] : 'one-time';
        $addonIds = [];
        if (isset($b['addons']) && is_array($b['addons'])) {
            foreach ($b['addons'] as $id) {
                if (is_string($id) && isset(self::ADD_ON_PRICING[$id])) {
                    $addonIds[] = $id;
                }
            }
        }

        $base = (float) $service['basePrice'];
        if (isset($service['sqftRate'])) {
            $sizeCost = $sqft * $service['sqftRate'];
            $durationHours = $sqft / $service['sqftPerHour'];
        } else {
            $sizeCost = $bedrooms * 20 + $bathrooms * 25;
            $durationHours = ($bedrooms * 0.5 + $bathrooms * 0.5 + 1) * $service['durationMultiplier'];
        }
        $durationHours *= self::CONDITION_DURATION_MULTIPLIERS[$condition];
        $pets = self::hasPets($b);
        $petsCost = $pets ? 15 : 0;
        if ($pets) {
            $durationHours += 0.25;
        }
        $addonsCost = 0;
        foreach ($addonIds as $id) {
            $addonsCost += self::ADD_ON_PRICING[$id]['price'];
            $durationHours += self::ADD_ON_PRICING[$id]['durationHours'];
        }

        $subtotalBeforeCondition = $base + $sizeCost + $petsCost + $addonsCost;
        $conditionAdjustedTotal = $subtotalBeforeCondition * self::CONDITION_MULTIPLIERS[$condition];
        $frequencyDiscount = $service['recurringDiscountEligible'] ? $conditionAdjustedTotal * self::FREQUENCY_DISCOUNTS[$frequency] : 0;
        $afterFrequency = $conditionAdjustedTotal - $frequencyDiscount;
        $promoCode = strtoupper(trim((string) ($b['promoCode'] ?? '')));
        $promoDiscount = $promoCode === 'CLEAN10' ? $afterFrequency * 0.1 : 0;
        $totalPrice = PaymentMath::toFixed2(max(0, $afterFrequency - $promoDiscount));

        return [
            'serviceSlug' => $serviceSlug,
            'serviceName' => $service['name'],
            'addons' => $addonIds,
            'frequency' => $frequency,
            'totalPrice' => $totalPrice,
            'totalAmount' => $totalPrice,
            'depositAmount' => min($totalPrice, max(0, $requiredDeposit)),
            'paidAmount' => 0,
            'amountPaid' => 0,
            'remainingDue' => $totalPrice,
            'balanceDue' => $totalPrice,
            'durationMinutes' => (int) max(30, PaymentMath::jsRound($durationHours * 60)),
            'estimate' => [
                'base' => $base,
                'sizeCost' => $sizeCost,
                'petsCost' => $petsCost,
                'addonsCost' => $addonsCost,
                'conditionCost' => $conditionAdjustedTotal - $subtotalBeforeCondition,
                'discount' => $frequencyDiscount,
                'promoDiscount' => $promoDiscount,
                'total' => $totalPrice,
                'durationHours' => PaymentMath::jsRound($durationHours * 2) / 2,
            ],
        ];
    }
}

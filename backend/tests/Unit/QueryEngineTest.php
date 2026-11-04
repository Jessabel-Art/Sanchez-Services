<?php
declare(strict_types=1);

namespace SanchezServices\Tests\Unit;

use PHPUnit\Framework\TestCase;
use SanchezServices\Infra\StripeClient;
use SanchezServices\Store\Doc;
use SanchezServices\Store\QueryEngine;

final class QueryEngineTest extends TestCase
{
    private function docs(): array
    {
        $d = static fn ($id, $data) => ['id' => $id, 'parent' => null, 'data' => $data];
        return [
            $d('a', ['status' => 'confirmed', 'startAt' => ['__ts' => '2026-06-17T13:00:00.000Z'], 'ownerKeys' => ['uid:1'], 'phone' => null]),
            $d('b', ['status' => 'pending', 'startAt' => ['__ts' => '2026-06-18T13:00:00.000Z'], 'contact' => ['emailLower' => 'x@y.z']]),
            $d('c', ['status' => 'confirmed', 'scheduledAt' => ['__ts' => '2026-06-16T13:00:00.000Z'], 'phone' => '']),
            $d('d', ['status' => 'cancelled', 'startAt' => '2026-06-19']),
        ];
    }

    private function ids(array $rows): array
    {
        return array_column($rows, 'id');
    }

    public function testFirestoreSemantics(): void
    {
        $docs = $this->docs();
        // orderBy drops docs missing the field (c has no startAt); string vs timestamp sort by type
        $this->assertSame(['d', 'b', 'a'], $this->ids(QueryEngine::run($docs, [], [['startAt', 'desc']], null)));
        // range filter only matches same type (d's string startAt is excluded)
        $this->assertSame(['a', 'b'], $this->ids(QueryEngine::run($docs, [['startAt', '>=', ['__ts' => '2026-01-01T00:00:00Z']]], [], null)));
        $this->assertSame(['a', 'c'], $this->ids(QueryEngine::run($docs, [['status', 'in', ['confirmed']]], [], null)));
        $this->assertSame(['a'], $this->ids(QueryEngine::run($docs, [['ownerKeys', 'array-contains', 'uid:1']], [], null)));
        $this->assertSame(['b'], $this->ids(QueryEngine::run($docs, [['contact.emailLower', '==', 'x@y.z']], [], null)));
        // == null matches explicit nulls only; '' is distinct
        $this->assertSame(['a'], $this->ids(QueryEngine::run($docs, [['phone', '==', null]], [], null)));
        $this->assertSame(['c'], $this->ids(QueryEngine::run($docs, [['phone', '==', '']], [], null)));
        // != excludes missing fields and (like Firestore) orders by the inequality field first
        $this->assertSame(['d', 'b'], $this->ids(QueryEngine::run($docs, [['status', '!=', 'confirmed']], [], null)));
        // limit / limitToLast
        $this->assertSame(['d', 'b'], $this->ids(QueryEngine::run($docs, [], [['startAt', 'desc']], 2)));
        $this->assertSame(['b', 'a'], $this->ids(QueryEngine::run($docs, [], [['startAt', 'desc']], null, 2)));
    }

    public function testDocPatchSemantics(): void
    {
        $now = new \DateTimeImmutable('2026-06-17T12:00:00Z');
        $doc = ['a' => ['b' => 1, 'c' => 2], 'n' => 5, 'gone' => true];
        $u = Doc::applyUpdate($doc, ['a.b' => 9, 'n' => ['__op' => 'increment', 'n' => 2], 'gone' => ['__op' => 'delete'], 't' => ['__op' => 'serverTimestamp']], $now);
        $this->assertSame(['b' => 9, 'c' => 2], $u['a']);
        $this->assertSame(7, $u['n']);
        $this->assertArrayNotHasKey('gone', $u);
        $this->assertSame('2026-06-17T12:00:00.000Z', $u['t']['__ts']);
        $m = Doc::applyMerge($doc, ['a' => ['d' => 3]], $now);
        $this->assertSame(['b' => 1, 'c' => 2, 'd' => 3], $m['a']);
        $this->assertSame(['a', 'n'], Doc::affectedKeys($doc, ['a' => ['b' => 2, 'c' => 2], 'n' => 6, 'gone' => true]));
    }

    public function testStripeSignatureVerification(): void
    {
        $payload = '{"id":"evt_1","type":"payment_intent.succeeded"}';
        $t = 1_800_000_000;
        $sig = hash_hmac('sha256', "$t.$payload", 'whsec_x');
        $this->assertSame('evt_1', StripeClient::constructEvent($payload, "t=$t,v1=bad,v1=$sig", 'whsec_x', 300, $t + 10)['id']);
        foreach (["t=$t,v1=bad", "v1=$sig", ''] as $header) {
            try {
                StripeClient::constructEvent($payload, $header, 'whsec_x', 300, $t);
                $this->fail('expected failure');
            } catch (\UnexpectedValueException) {
                $this->addToAssertionCount(1);
            }
        }
        $this->expectException(\UnexpectedValueException::class);
        StripeClient::constructEvent($payload, "t=$t,v1=$sig", 'whsec_x', 300, $t + 301);
    }

    public function testStripeFormEncoding(): void
    {
        $enc = StripeClient::encode(['line_items' => [['price_data' => ['currency' => 'usd', 'unit_amount' => 5000]]], 'metadata' => ['bookingId' => 'a b'], 'skip' => null]);
        $this->assertSame('line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=5000&metadata%5BbookingId%5D=a%20b', $enc);
    }
}

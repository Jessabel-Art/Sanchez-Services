<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Auth\AuthUser;
use SanchezServices\Clock;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;
use SanchezServices\Store\Doc;
use SanchezServices\Store\DocumentStore;
use SanchezServices\Store\QueryEngine;

/**
 * Firestore-compatible document gateway used by the frontend shim (src/lib/php-backend/firestore.js).
 *   POST /api/db/get     {path}
 *   POST /api/db/query   {collection, where?, orderBy?, limit?, limitToLast?}
 *   POST /api/db/commit  {writes:[{op:create|set|update|delete, path, data?, merge?}]}
 * All access is authorized by Store\Rules (port of firestore.rules).
 */
final class GatewayController
{
    private const MAX_WRITES = 500;
    private const MAX_RESULTS = 5000;

    public function __construct(private App $app)
    {
    }

    public function get(Request $req): Response
    {
        $user = $this->app->auth->currentUser();
        $path = (string) ($req->json()['path'] ?? '');
        $p = DocumentStore::parsePath($path, true);
        $doc = $this->readDoc($p);
        if (!$this->app->rules->canRead($user, $p, $doc)) {
            throw HttpError::denied();
        }
        return Response::json(['id' => $p['id'], 'exists' => $doc !== null, 'data' => $doc]);
    }

    public function query(Request $req): Response
    {
        $user = $this->app->auth->currentUser();
        $body = $req->json();
        $p = DocumentStore::parsePath((string) ($body['collection'] ?? ''), false);
        $where = self::decodeFilters($body['where'] ?? []);
        $orderBy = [];
        foreach ((array) ($body['orderBy'] ?? []) as $o) {
            if (!is_array($o) || !is_string($o[0] ?? null)) {
                throw HttpError::invalid('Invalid orderBy.');
            }
            $orderBy[] = [$o[0], strtolower((string) ($o[1] ?? 'asc')) === 'desc' ? 'desc' : 'asc'];
        }
        $limit = isset($body['limit']) && is_numeric($body['limit']) ? max(0, (int) $body['limit']) : null;
        $limitToLast = isset($body['limitToLast']) && is_numeric($body['limitToLast']) ? max(0, (int) $body['limitToLast']) : null;

        $candidates = $this->candidates($user, $p, $where);
        // Authorization: return only documents the rules allow this user to read.
        $candidates = array_values(array_filter($candidates, fn ($d) => $this->app->rules->canRead($user, ['collection' => $p['collection'], 'id' => $d['id'], 'parent' => $d['parent']], $d['data'])));
        $rows = QueryEngine::run($candidates, $where, $orderBy, $limit ?? self::MAX_RESULTS, $limitToLast);
        return Response::json(['docs' => array_map(static fn ($d) => ['id' => $d['id'], 'data' => $d['data']], $rows)]);
    }

    public function commit(Request $req): Response
    {
        $user = $this->app->auth->currentUser();
        $writes = $req->json()['writes'] ?? null;
        if (!is_array($writes) || !array_is_list($writes) || !$writes) {
            throw HttpError::invalid('writes must be a non-empty array.');
        }
        if (count($writes) > self::MAX_WRITES) {
            throw HttpError::invalid('Too many writes in one batch.');
        }
        $results = $this->app->db->transaction(function () use ($writes, $user, $req) {
            $out = [];
            foreach ($writes as $w) {
                $out[] = $this->applyWrite($user, is_array($w) ? $w : [], $req->ip);
            }
            return $out;
        });
        return Response::json(['results' => $results]);
    }

    // ------------------------------------------------------------------

    /** @return array<string,mixed>|null */
    private function readDoc(array $p): ?array
    {
        $id = (string) $p['id'];
        switch ($p['collection']) {
            case 'admins':
                $row = $this->app->users->rowByUid($id);
                return $row && in_array($row['role'], ['admin', 'owner'], true) && (int) $row['is_active'] === 1
                    ? ['active' => true, 'role' => $row['role']]
                    : null;
            case 'bookings':
            case 'profiles':
            case 'blackouts':
            case 'reviews':
                return $this->app->store->get($p['collection'], $id);
            case 'addresses':
                return $this->app->store->get('addresses', $id, $p['parent']);
            default:
                return null; // services, reports, availability, payments, mail, bookingReservations: no data served
        }
    }

    /** @return list<array{id:string,parent:?string,data:array<string,mixed>}> */
    private function candidates(?AuthUser $user, array $p, array $where): array
    {
        $isAdmin = $this->app->rules->isAdmin($user);
        switch ($p['collection']) {
            case 'bookings':
                $sql = [];
                $params = [];
                if (!$isAdmin) {
                    if (!$user) {
                        return [];
                    }
                    $e = self::likeEscape($user->emailLower);
                    $sql[] = '(user_uid = ? OR contact_email_lower = ? OR doc_json LIKE ? OR doc_json LIKE ? OR doc_json LIKE ?)';
                    array_push($params, $user->uid, $user->emailLower, '%"uid:' . self::likeEscape($user->uid) . '"%', '%"email:' . $e . '"%', '%"emailLower":"' . $e . '"%');
                }
                foreach ($where as [$field, $op, $value]) {
                    if ($field === 'startAt' && Doc::isTs($value) && in_array($op, ['<', '<=', '>', '>=', '=='], true)) {
                        $sql[] = 'start_at ' . ($op === '==' ? '=' : $op) . ' ?';
                        $params[] = Clock::toSql(Doc::toDate($value));
                    } elseif ($field === 'status' && $op === '==' && is_string($value)) {
                        $sql[] = 'status = ?';
                        $params[] = $value;
                    } elseif ($field === 'userId' && $op === '==' && is_string($value)) {
                        $sql[] = 'user_uid = ?';
                        $params[] = $value;
                    }
                }
                return $this->app->store->scan('bookings', null, $sql ? ['sql' => implode(' AND ', $sql), 'params' => $params] : []);
            case 'profiles':
                if (!$isAdmin) {
                    return $user ? $this->app->store->scan('profiles', null, ['sql' => 'doc_id = ?', 'params' => [$user->uid]]) : [];
                }
                return $this->app->store->scan('profiles');
            case 'addresses':
                if (!$isAdmin && (!$user || $user->uid !== $p['parent'])) {
                    return [];
                }
                return $this->app->store->scan('addresses', (string) $p['parent']);
            case 'reviews':
                if (!$isAdmin) {
                    return $this->app->store->scan('reviews', null, ['sql' => "status = 'approved'" . ($user ? ' OR client_uid = ?' : ''), 'params' => $user ? [$user->uid] : []]);
                }
                return $this->app->store->scan('reviews');
            case 'blackouts':
                return $isAdmin ? $this->app->store->scan('blackouts') : [];
            case 'admins':
                if (!$user) {
                    return [];
                }
                $rows = $isAdmin
                    ? $this->app->db->all("SELECT uid, role FROM users WHERE role IN ('admin','owner') AND is_active = 1")
                    : $this->app->db->all("SELECT uid, role FROM users WHERE uid = ? AND role IN ('admin','owner') AND is_active = 1", [$user->uid]);
                return array_map(static fn ($r) => ['id' => (string) $r['uid'], 'parent' => null, 'data' => ['active' => true, 'role' => $r['role']]], $rows);
            default:
                return [];
        }
    }

    private static function likeEscape(string $s): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
    }

    /** @return list<array{0:string,1:string,2:mixed}> */
    private static function decodeFilters(mixed $raw): array
    {
        if (!is_array($raw)) {
            throw HttpError::invalid('Invalid where.');
        }
        $out = [];
        foreach ($raw as $f) {
            if (!is_array($f) || count($f) !== 3 || !is_string($f[0]) || !is_string($f[1])) {
                throw HttpError::invalid('Invalid where clause.');
            }
            $out[] = [$f[0], $f[1], Doc::normalizeIncoming($f[2])];
        }
        return $out;
    }

    /** @return array{path:string,id:string} */
    private function applyWrite(?AuthUser $user, array $w, string $ip): array
    {
        $op = (string) ($w['op'] ?? '');
        $now = $this->app->clock->now();
        $data = isset($w['data']) ? Doc::normalizeIncoming($w['data']) : null;
        if ($op !== 'delete' && !is_array($data)) {
            throw HttpError::invalid('Write data must be an object.');
        }
        if ($data !== null && strlen(Doc::encode($data)) > 1_000_000) {
            throw HttpError::invalid('Document too large.');
        }
        if ($op === 'create') {
            $p = DocumentStore::parsePath((string) ($w['path'] ?? ''), false);
            $p['id'] = isset($w['id']) && is_string($w['id']) && $w['id'] !== '' ? $w['id'] : DocumentStore::newId();
        } else {
            $p = DocumentStore::parsePath((string) ($w['path'] ?? ''), true);
        }
        $collection = $p['collection'];
        $id = (string) $p['id'];
        $docPath = ($collection === 'addresses' ? "profiles/{$p['parent']}/addresses" : $collection) . '/' . $id;

        // Virtual collection: mail -> outbox (create only, admin only).
        if ($collection === 'mail') {
            if (!in_array($op, ['create', 'set'], true) || !$this->app->rules->canWrite($user, 'create', $p, null, $data)) {
                throw HttpError::denied();
            }
            $this->app->outbox->enqueue((array) Doc::resolveValue($data, $now));
            return ['path' => $docPath, 'id' => $id];
        }
        if (!in_array($collection, ['bookings', 'profiles', 'addresses', 'blackouts', 'reviews'], true)) {
            throw HttpError::denied();
        }

        $before = $this->app->store->get($collection, $id, $p['parent'], true);
        if ($op === 'delete') {
            if ($before === null) {
                return ['path' => $docPath, 'id' => $id]; // Firestore delete of missing doc succeeds
            }
            if (!$this->app->rules->canWrite($user, 'delete', $p, $before, null)) {
                throw HttpError::denied();
            }
            $this->app->store->delete($collection, $id, $p['parent']);
            $this->audit($user, 'delete', $collection, $docPath, $before, null, $ip);
            return ['path' => $docPath, 'id' => $id];
        }

        if ($op === 'update') {
            if ($before === null) {
                throw HttpError::notFound('No document to update: ' . $docPath);
            }
            $after = Doc::applyUpdate($before, (array) $data, $now);
        } elseif ($op === 'set') {
            $after = !empty($w['merge']) ? Doc::applyMerge($before ?? [], (array) $data, $now) : (array) Doc::resolveValue($data, $now);
        } elseif ($op === 'create') {
            if ($before !== null) {
                throw new HttpError('already-exists', 'Document already exists.');
            }
            $after = (array) Doc::resolveValue($data, $now);
        } else {
            throw HttpError::invalid('Unsupported write op.');
        }
        $ruleOp = $before === null ? 'create' : 'update';
        if (!$this->app->rules->canWrite($user, $ruleOp, $p, $before, $after)) {
            throw HttpError::denied();
        }

        // Trigger equivalents
        if ($collection === 'reviews') {
            $after = $this->reviewHooks($before, $after, $now);
        }
        if ($collection === 'bookings') {
            $this->app->bookings->save($id, $before, $after);
        } else {
            $this->app->store->put($collection, $id, $after, $p['parent']);
        }
        $this->audit($user, $ruleOp, $collection, $docPath, $before, $after, $ip);
        return ['path' => $docPath, 'id' => $id];
    }

    /** onReviewCreate / onReviewUpdate */
    private function reviewHooks(?array $before, array $after, \DateTimeImmutable $now): array
    {
        if ($before === null) {
            $after['createdAt'] ??= Doc::ts($now);
            if (empty($after['status'])) {
                $after['status'] = 'pending';
            }
            $emailLower = $after['emailLower'] ?? (is_string($after['email'] ?? null) ? strtolower($after['email']) : null);
            if ($emailLower) {
                $after['emailLower'] = $emailLower;
            }
            return $after;
        }
        if (($before['status'] ?? null) !== 'approved' && ($after['status'] ?? null) === 'approved') {
            if (empty($after['publishedAt'])) {
                $after['publishedAt'] = Doc::ts($now);
            }
            $after['updatedAt'] = Doc::ts($now);
        }
        return $after;
    }

    private function audit(?AuthUser $user, string $action, string $entity, string $id, ?array $before, ?array $after, string $ip): void
    {
        if (!$user || !$this->app->rules->isAdmin($user)) {
            return; // audit admin mutations only
        }
        $this->app->db->insert('audit_log', [
            'actor_uid' => $user->uid,
            'action' => 'gateway_' . $action,
            'entity' => $entity,
            'entity_id' => substr($id, 0, 160),
            'before_json' => $before !== null ? Doc::encode($before) : null,
            'after_json' => $after !== null ? Doc::encode($after) : null,
            'ip' => substr($ip, 0, 45),
            'created_at' => Clock::toSql($this->app->clock->now()),
        ]);
    }
}

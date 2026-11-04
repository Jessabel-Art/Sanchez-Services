<?php
declare(strict_types=1);

namespace SanchezServices\Store;

use SanchezServices\Auth\AuthUser;
use SanchezServices\Config;
use SanchezServices\Db;

/**
 * Line-by-line port of firestore.rules. Every gateway read/write is authorized here.
 *
 * Query semantics differ in one deliberate way: Firestore rejects a query that *could* return
 * unauthorized documents; the gateway instead returns only the authorized subset. It never returns
 * documents the rules would deny.
 */
final class Rules
{
    /** @var array<int,bool> */
    private array $adminCache = [];

    public function __construct(private Db $db, private DocumentStore $store, private Config $config)
    {
    }

    /** isAdmin(): admins/{uid}.active == true OR profiles/{uid}.role in [admin, owner]. */
    public function isAdmin(?AuthUser $u): bool
    {
        if (!$u) {
            return false;
        }
        if (isset($this->adminCache[$u->id])) {
            return $this->adminCache[$u->id];
        }
        $isAdmin = in_array($u->role, ['admin', 'owner'], true);
        if (!$isAdmin) {
            $p = $this->store->get('profiles', $u->uid);
            $isAdmin = $p !== null && in_array($p['role'] ?? null, ['admin', 'owner'], true);
        }
        return $this->adminCache[$u->id] = $isAdmin;
    }

    /** isAdminServer(): rules admin OR ADMIN_UIDS / ADMIN_EMAILS allowlists (Cloud Functions only). */
    public function isAdminServer(?AuthUser $u): bool
    {
        if (!$u) {
            return false;
        }
        if (in_array($u->uid, $this->config->list('business.admin_uids'), true)) {
            return true;
        }
        $emails = array_map('strtolower', $this->config->list('business.admin_emails'));
        if ($u->emailLower !== '' && in_array($u->emailLower, $emails, true)) {
            return true;
        }
        return $this->isAdmin($u);
    }

    /** request.auth.token.email lowered (optionally only when verified). */
    private function emailFor(?AuthUser $u): string
    {
        if (!$u) {
            return '';
        }
        if ($this->config->bool('auth.require_verified_email_for_email_match') && !$u->emailVerified) {
            return "\0unverified";
        }
        return $u->emailLower;
    }

    public function isBookingOwner(?AuthUser $u, array $d): bool
    {
        if (!$u) {
            return false;
        }
        $email = $this->emailFor($u);
        if (array_key_exists('userId', $d) && $d['userId'] === $u->uid) {
            return true;
        }
        if (isset($d['ownerKeys']) && is_array($d['ownerKeys']) && array_is_list($d['ownerKeys'])) {
            if (in_array('uid:' . $u->uid, $d['ownerKeys'], true) || in_array('email:' . $email, $d['ownerKeys'], true)) {
                return true;
            }
        }
        if (array_key_exists('contactEmailLower', $d) && $d['contactEmailLower'] === $email) {
            return true;
        }
        if (isset($d['contact']) && is_array($d['contact']) && array_key_exists('emailLower', $d['contact']) && $d['contact']['emailLower'] === $email) {
            return true;
        }
        return false;
    }

    public function ownsBookingId(?AuthUser $u, mixed $bookingId): bool
    {
        if (!is_string($bookingId) || $bookingId === '') {
            return false;
        }
        $b = $this->store->get('bookings', $bookingId);
        return $b !== null && $this->isBookingOwner($u, $b);
    }

    // ------------------------------------------------------------------ read

    /** @param array{collection:string,id:?string,parent:?string} $p */
    public function canRead(?AuthUser $u, array $p, ?array $doc): bool
    {
        $admin = $this->isAdmin($u);
        return match ($p['collection']) {
            'admins' => $admin || ($u && $u->uid === $p['id']),
            'profiles' => $admin || ($u && $u->uid === $p['id']),
            'addresses' => $admin || ($u && $u->uid === $p['parent']),
            'bookings' => $admin || ($doc !== null && $this->isBookingOwner($u, $doc)),
            'reviews' => $admin
                || ($doc !== null && ($doc['status'] ?? null) === 'approved')
                || ($u && $doc !== null && ($doc['clientId'] ?? null) === $u->uid),
            'blackouts', 'reports' => $admin,
            'services' => true,
            'availability' => $u !== null,
            default => false, // mail, bookingReservations, payments(no rows), catch-all
        };
    }

    // ------------------------------------------------------------------ write

    /**
     * @param 'create'|'update'|'delete' $op
     * @param array{collection:string,id:?string,parent:?string} $p
     */
    public function canWrite(?AuthUser $u, string $op, array $p, ?array $before, ?array $after): bool
    {
        $admin = $this->isAdmin($u);
        switch ($p['collection']) {
            case 'profiles':
                if ($op === 'delete') {
                    return $admin;
                }
                if ($admin) {
                    return true;
                }
                return $op === 'create' ? $this->safeProfileCreate($u, (string) $p['id'], (array) $after)
                    : $this->safeProfileUpdate($u, (string) $p['id'], (array) $before, (array) $after);
            case 'addresses':
                return $admin || ($u !== null && $u->uid === $p['parent']);
            case 'bookings':
                if ($op !== 'update') {
                    return false; // create/delete only through server functions
                }
                return $admin || ($before !== null && $this->isBookingOwner($u, $before) && $this->safeClientBookingUpdate((array) $before, (array) $after));
            case 'reviews':
                if ($op === 'create') {
                    return $this->validClientReviewCreate($u, (array) $after);
                }
                return $admin;
            case 'blackouts':
            case 'services':
            case 'reports':
                return $admin;
            case 'mail':
                return $op === 'create' && $admin;
            default:
                return false; // admins, availability, bookingReservations, payments, catch-all
        }
    }

    private function safeProfileCreate(?AuthUser $u, string $uid, array $d): bool
    {
        if (!$u || $u->uid !== $uid) {
            return false;
        }
        foreach (['role', 'admin', 'isAdmin', 'ltv', 'lastBookingAt'] as $k) {
            if (array_key_exists($k, $d)) {
                return false;
            }
        }
        if (array_key_exists('uid', $d) && $d['uid'] !== $uid) {
            return false;
        }
        if (array_key_exists('emailLower', $d) && $d['emailLower'] !== $this->emailFor($u)) {
            return false;
        }
        return true;
    }

    private function safeProfileUpdate(?AuthUser $u, string $uid, array $before, array $after): bool
    {
        if (!$u || $u->uid !== $uid) {
            return false;
        }
        $changed = Doc::affectedKeys($before, $after);
        if (array_intersect($changed, ['uid', 'role', 'admin', 'isAdmin', 'ltv', 'lastBookingAt'])) {
            return false;
        }
        if (array_key_exists('emailLower', $after) && $after['emailLower'] !== $this->emailFor($u)) {
            return false;
        }
        return true;
    }

    private function safeClientBookingUpdate(array $before, array $after): bool
    {
        $changed = Doc::affectedKeys($before, $after);
        $allowed = ['updatedAt', 'notes', 'cleanerNotes', 'accessNotes', 'reviewId', 'reviewRating', 'reviewLeftAt'];
        if (array_diff($changed, $allowed)) {
            return false;
        }
        if (in_array('reviewId', $changed, true)
            && !(!array_key_exists('reviewId', $before) && is_string($after['reviewId'] ?? null) && strlen($after['reviewId']) > 0)) {
            return false;
        }
        if (in_array('reviewRating', $changed, true)
            && !(!array_key_exists('reviewRating', $before) && is_int($after['reviewRating'] ?? null) && $after['reviewRating'] >= 1 && $after['reviewRating'] <= 5)) {
            return false;
        }
        if (in_array('reviewLeftAt', $changed, true)
            && !(!array_key_exists('reviewLeftAt', $before) && Doc::isTs($after['reviewLeftAt'] ?? null))) {
            return false;
        }
        return true;
    }

    private function validClientReviewCreate(?AuthUser $u, array $d): bool
    {
        if (!$u) {
            return false;
        }
        $allowed = ['clientId', 'bookingId', 'serviceName', 'displayMode', 'reviewDisplayName', 'rating', 'comment', 'body', 'source', 'status', 'createdAt'];
        if (array_diff(array_keys($d), $allowed)) {
            return false;
        }
        $comment = $d['comment'] ?? null;
        return ($d['clientId'] ?? null) === $u->uid
            && $this->ownsBookingId($u, $d['bookingId'] ?? null)
            && ($d['status'] ?? null) === 'pending'
            && ($d['source'] ?? null) === 'client-portal'
            && in_array($d['displayMode'] ?? null, ['anonymous', 'initials', 'firstInitialLastName'], true)
            && is_string($d['reviewDisplayName'] ?? null)
            && is_int($d['rating'] ?? null) && $d['rating'] >= 1 && $d['rating'] <= 5
            && is_string($comment) && mb_strlen($comment) >= 5 && mb_strlen($comment) <= 2000
            && ($d['body'] ?? null) === $comment
            && Doc::isTs($d['createdAt'] ?? null);
    }
}

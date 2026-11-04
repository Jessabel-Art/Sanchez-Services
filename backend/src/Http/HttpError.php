<?php
declare(strict_types=1);

namespace SanchezServices\Http;

/**
 * Error with a Firebase-compatible code so the existing UI error handling keeps working
 * (e.g. 'permission-denied', 'already-exists', 'resource-exhausted').
 */
final class HttpError extends \RuntimeException
{
    private const STATUS = [
        'invalid-argument' => 400,
        'failed-precondition' => 412,
        'unauthenticated' => 401,
        'permission-denied' => 403,
        'not-found' => 404,
        'already-exists' => 409,
        'resource-exhausted' => 429,
        'unimplemented' => 501,
        'unavailable' => 503,
        'internal' => 500,
        'method-not-allowed' => 405,
    ];

    /** @param array<string,mixed> $details */
    public function __construct(public readonly string $errorCode, string $message, public readonly array $details = [])
    {
        parent::__construct($message);
    }

    public function status(): int
    {
        if (str_starts_with($this->errorCode, 'auth/')) {
            return match ($this->errorCode) {
                'auth/too-many-requests' => 429,
                'auth/requires-recent-login' => 401,
                default => 400,
            };
        }
        return self::STATUS[$this->errorCode] ?? 500;
    }

    public static function invalid(string $m): self { return new self('invalid-argument', $m); }
    public static function unauthenticated(string $m = 'You must be signed in.'): self { return new self('unauthenticated', $m); }
    public static function denied(string $m = 'Missing or insufficient permissions.'): self { return new self('permission-denied', $m); }
    public static function notFound(string $m = 'Not found.'): self { return new self('not-found', $m); }
}

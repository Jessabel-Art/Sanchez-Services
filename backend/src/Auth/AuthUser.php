<?php
declare(strict_types=1);

namespace SanchezServices\Auth;

final class AuthUser
{
    public function __construct(
        public readonly int $id,
        public readonly string $uid,
        public readonly string $email,
        public readonly string $emailLower,
        public readonly bool $emailVerified,
        public readonly string $role,
        public readonly ?string $displayName,
        public readonly ?string $phoneNumber,
    ) {
    }

    /** @param array<string,mixed> $row */
    public static function fromRow(array $row): self
    {
        return new self(
            (int) $row['id'],
            (string) $row['uid'],
            (string) $row['email'],
            (string) $row['email_lower'],
            $row['email_verified_at'] !== null,
            (string) $row['role'],
            $row['display_name'] !== null ? (string) $row['display_name'] : null,
            $row['phone_number'] !== null ? (string) $row['phone_number'] : null,
        );
    }

    /** Shape returned to the frontend shim (Firebase User-like). */
    public function toPublic(bool $isAdmin): array
    {
        return [
            'uid' => $this->uid,
            'email' => $this->email,
            'emailVerified' => $this->emailVerified,
            'displayName' => $this->displayName,
            'phoneNumber' => $this->phoneNumber,
            'role' => $this->role,
            'isAdmin' => $isAdmin,
        ];
    }
}

<?php
declare(strict_types=1);

namespace SanchezServices\Auth;

final class AuthUser
{
    public function __construct(
        public readonly int $id,
        public readonly string $email,
        public readonly string $emailLower,
        public readonly bool $emailVerified,
        public readonly string $role,
        public readonly ?string $name,
        public readonly ?string $phone,
    ) {
    }

    public static function fromRow(array $row): self
    {
        return new self((int) $row['id'], (string) $row['email'], (string) $row['email_lower'], $row['email_verified_at'] !== null,
            (string) $row['role'], $row['name'] !== null ? (string) $row['name'] : null, $row['phone'] !== null ? (string) $row['phone'] : null);
    }

    public function isAdmin(): bool
    {
        return in_array($this->role, ['admin', 'owner'], true);
    }

    public function toApi(): array
    {
        return [
            'id' => $this->id, 'email' => $this->email, 'emailVerified' => $this->emailVerified,
            'name' => $this->name, 'phone' => $this->phone, 'role' => $this->role, 'isAdmin' => $this->isAdmin(),
        ];
    }
}

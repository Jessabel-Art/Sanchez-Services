<?php
declare(strict_types=1);

namespace SanchezServices\Auth;

use SanchezServices\Clock;
use SanchezServices\Db;

final class UserRepository
{
    public function __construct(private Db $db, private Clock $clock)
    {
    }

    /** @return array<string,mixed>|null */
    public function rowById(int $id): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE id = ?', [$id]);
    }

    /** @return array<string,mixed>|null */
    public function rowByEmail(string $email): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE email_lower = ?', [strtolower(trim($email))]);
    }

    /** @return array<string,mixed>|null */
    public function rowByUid(string $uid): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE uid = ?', [$uid]);
    }

    public function findById(int $id): ?AuthUser
    {
        $row = $this->rowById($id);
        return $row && (int) $row['is_active'] === 1 ? AuthUser::fromRow($row) : null;
    }

    public function create(string $email, ?string $passwordHash, string $role = 'client', ?string $uid = null): AuthUser
    {
        $now = Clock::toSql($this->clock->now());
        $id = $this->db->insert('users', [
            'uid' => $uid ?? self::newUid(),
            'email' => trim($email),
            'email_lower' => strtolower(trim($email)),
            'password_hash' => $passwordHash,
            'role' => $role,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        return AuthUser::fromRow((array) $this->rowById($id));
    }

    /** @param array<string,mixed> $set */
    public function update(int $id, array $set): void
    {
        $set['updated_at'] = Clock::toSql($this->clock->now());
        $this->db->update('users', $set, ['id' => $id]);
    }

    /** 28-char id, same alphabet/length as Firebase Auth UIDs. */
    public static function newUid(): string
    {
        $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        $out = '';
        for ($i = 0; $i < 28; $i++) {
            $out .= $chars[random_int(0, 61)];
        }
        return $out;
    }
}

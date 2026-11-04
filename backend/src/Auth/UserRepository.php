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

    public function rowById(int $id): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE id = ?', [$id]);
    }

    public function rowByEmail(string $email): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE email_lower = ?', [strtolower(trim($email))]);
    }

    public function findById(int $id): ?AuthUser
    {
        $row = $this->rowById($id);
        return $row && (int) $row['is_active'] === 1 ? AuthUser::fromRow($row) : null;
    }

    public function create(string $email, ?string $passwordHash, ?string $name = null, string $role = 'client'): AuthUser
    {
        $now = Clock::toSql($this->clock->now());
        $id = $this->db->insert('users', [
            'email' => trim($email), 'email_lower' => strtolower(trim($email)), 'password_hash' => $passwordHash,
            'name' => $name, 'role' => $role, 'created_at' => $now, 'updated_at' => $now,
        ]);
        $this->db->run('INSERT IGNORE INTO client_profiles (user_id, created_at, updated_at) VALUES (?, ?, ?)', [$id, $now, $now]);
        return AuthUser::fromRow((array) $this->rowById($id));
    }

    public function update(int $id, array $set): void
    {
        $set['updated_at'] = Clock::toSql($this->clock->now());
        $this->db->update('users', $set, ['id' => $id]);
    }
}

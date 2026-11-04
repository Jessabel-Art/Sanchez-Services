<?php
declare(strict_types=1);

// Sets a user's role (client | admin | owner). The user must already exist (registered or imported).
//   php bin/set-role.php owner@example.com owner
// Changing a role signs that user out everywhere (their sessions are tied to the role).
require dirname(__DIR__) . '/bootstrap.php';

[$email, $role] = [$argv[1] ?? '', $argv[2] ?? ''];
if ($email === '' || !in_array($role, ['client', 'admin', 'owner'], true)) {
    fwrite(STDERR, "Usage: php bin/set-role.php <email> <client|admin|owner>\n");
    exit(2);
}
$app = new SanchezServices\App(SanchezServices\Config::load());
$n = $app->db->run('UPDATE users SET role = ?, updated_at = ? WHERE email_lower = ?', [$role, SanchezServices\Clock::toSql($app->clock->now()), strtolower(trim($email))])->rowCount();
if ($n !== 1) {
    fwrite(STDERR, "No user with that email (or role unchanged).\n");
    exit(1);
}
echo "Role set to {$role}.\n";

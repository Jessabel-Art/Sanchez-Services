<?php
declare(strict_types=1);

// Grants or revokes the admin role (replaces seeding admins/{uid} in Firestore).
//   php bin/set-role.php owner@example.com admin|owner|client
require dirname(__DIR__) . '/bootstrap.php';

[$script, $email, $role] = array_pad($argv, 3, null);
if (!$email || !in_array($role, ['admin', 'owner', 'client'], true)) {
    fwrite(STDERR, "Usage: php bin/set-role.php <email> admin|owner|client\n");
    exit(2);
}
$app = new SanchezServices\App(SanchezServices\Config::load());
$row = $app->users->rowByEmail($email);
if (!$row) {
    fwrite(STDERR, "No user with that email. Ask them to register (or import users) first.\n");
    exit(1);
}
$app->users->update((int) $row['id'], ['role' => $role]);
echo "Role for {$email} set to {$role}.\n";

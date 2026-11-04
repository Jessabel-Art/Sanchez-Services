<?php
declare(strict_types=1);

// Usage: php bin/migrate.php [--status]
// Applies migrations/*.sql in order, recording each in schema_migrations.
require dirname(__DIR__) . '/bootstrap.php';

use SanchezServices\Config;
use SanchezServices\Db;

$config = Config::load();
$db = new Db($config->string('db.dsn'), $config->string('db.user'), $config->string('db.password'));
$pdo = $db->pdo();
$pdo->exec('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL) ENGINE=InnoDB');
$applied = array_column($db->all('SELECT version FROM schema_migrations'), 'version');
$files = glob(dirname(__DIR__) . '/migrations/*.sql') ?: [];
sort($files);
$statusOnly = in_array('--status', $argv, true);
foreach ($files as $file) {
    $version = basename($file, '.sql');
    if (in_array($version, $applied, true)) {
        echo "applied  {$version}\n";
        continue;
    }
    if ($statusOnly) {
        echo "pending  {$version}\n";
        continue;
    }
    $sql = (string) file_get_contents($file);
    // Split on semicolons at line ends (migration files contain no procedures).
    $statements = array_filter(array_map('trim', preg_split('/;\s*\n/', $sql) ?: []), static function ($s) {
        $s = trim(preg_replace('/^--.*$/m', '', $s) ?? '');
        return $s !== '';
    });
    foreach ($statements as $stmt) {
        if (preg_match('/^\s*CREATE TABLE schema_migrations/i', preg_replace('/^--.*$/m', '', $stmt) ?? '')) {
            continue;
        }
        $pdo->exec($stmt);
    }
    $db->run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [$version]);
    echo "migrated {$version}\n";
}

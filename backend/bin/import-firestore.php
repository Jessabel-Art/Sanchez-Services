<?php
declare(strict_types=1);

// Imports a Firestore export into MySQL.
//   php bin/import-firestore.php --dir=/path/to/export            (dry run: everything rolled back)
//   php bin/import-firestore.php --dir=/path/to/export --apply    (commit)
// Optional, requires owner approval (see docs/MIGRATION_IMPLEMENTATION.md, decision D1):
//   --with-legacy-password-hashes   store Firebase scrypt hashes for a compatibility login path
// Optional, business decision: --assume-completed-paid   treat completed bookings with no recorded payment as paid in full
// Writes a JSON report to stdout. Exit code 1 on error.
require dirname(__DIR__) . '/bootstrap.php';

$opts = getopt('', ['dir:', 'apply', 'with-legacy-password-hashes', 'assume-completed-paid']);
if (empty($opts['dir'])) {
    fwrite(STDERR, "Usage: php bin/import-firestore.php --dir=<export dir> [--apply] [--with-legacy-password-hashes] [--assume-completed-paid]\n");
    exit(2);
}
$app = new SanchezServices\App(SanchezServices\Config::load());
$importer = new SanchezServices\Migration\FirestoreImporter($app, rtrim($opts['dir'], '/'), [
    'withLegacyPasswordHashes' => isset($opts['with-legacy-password-hashes']),
    'assumeCompletedPaid' => isset($opts['assume-completed-paid']),
]);
try {
    $report = $importer->run(isset($opts['apply']));
} catch (Throwable $e) {
    fwrite(STDERR, 'Import failed: ' . $e->getMessage() . "\n");
    exit(1);
}
echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";

<?php
declare(strict_types=1);

// Validates MySQL against a Firestore export (counts, documents, money, timestamps, relationships).
//   php bin/validate-import.php --dir=/path/to/export
// Exit code 0 = no failures (warnings may still need review), 1 = failures.
require dirname(__DIR__) . '/bootstrap.php';

$opts = getopt('', ['dir:']);
if (empty($opts['dir'])) {
    fwrite(STDERR, "Usage: php bin/validate-import.php --dir=<export dir>\n");
    exit(2);
}
$app = new SanchezServices\App(SanchezServices\Config::load());
$report = (new SanchezServices\Migration\ImportValidator($app, rtrim($opts['dir'], '/')))->run();
echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
exit($report['ok'] ? 0 : 1);

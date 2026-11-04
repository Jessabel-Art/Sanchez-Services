<?php
declare(strict_types=1);

// Cron entry point.
//   php bin/job.php due              (run every job whose interval elapsed — schedule every 5 minutes)
//   php bin/job.php expire-pending | recover-payments | send-reminders | send-outbox | purge
require dirname(__DIR__) . '/bootstrap.php';

$app = new SanchezServices\App(SanchezServices\Config::load());
$job = $argv[1] ?? 'due';
$result = $job === 'due' ? $app->jobs->runDue() : $app->jobs->run($job);
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";

<?php
declare(strict_types=1);

/**
 * Front controller for /api/*. Deployed to <document root>/api/index.php.
 * The application code (src/, vendor/, config) lives OUTSIDE the document root; SS_APP_ROOT
 * (or the default below) points to it.
 */

$appRoot = getenv('SS_APP_ROOT') ?: dirname(__DIR__, 2);
if (is_file(__DIR__ . '/app-root.php')) {
    // Optional file written at deploy time that returns the absolute app root path.
    $appRoot = require __DIR__ . '/app-root.php';
}
require $appRoot . '/bootstrap.php';

$app = new SanchezServices\App(SanchezServices\Config::load());
$kernel = new SanchezServices\Http\Kernel($app);
$kernel->emit($kernel->handle(SanchezServices\Http\Request::fromGlobals()));

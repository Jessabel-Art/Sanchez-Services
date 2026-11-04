<?php
declare(strict_types=1);

// Autoloader: Composer when vendor/ exists, otherwise a PSR-4 fallback for src/.
$vendor = __DIR__ . '/vendor/autoload.php';
if (is_file($vendor)) {
    require $vendor;
} else {
    spl_autoload_register(static function (string $class): void {
        $prefix = 'SanchezServices\\';
        if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
            return;
        }
        $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require $file;
        }
    });
}
ini_set('display_errors', '0');
error_reporting(E_ALL);

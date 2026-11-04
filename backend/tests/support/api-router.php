<?php
// Router for `php -S` in integration tests: send /api/* to the real front controller.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($path, '/api/')) {
    require dirname(__DIR__, 2) . '/public/api/index.php';
    return true;
}
http_response_code(404);
echo 'not found';
return true;

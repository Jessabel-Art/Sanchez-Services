<?php
// Minimal fake of the Stripe API used in integration tests (never contacts Stripe).
// State is persisted in the JSON file named by FAKE_STRIPE_STATE.
$stateFile = getenv('FAKE_STRIPE_STATE');
$state = is_file($stateFile) ? json_decode(file_get_contents($stateFile), true) : ['seq' => 0, 'sessions' => [], 'customers' => [], 'requests' => []];
$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
header('Content-Type: application/json');
if ($auth !== 'Bearer sk_test_fake') {
    http_response_code(401);
    echo json_encode(['error' => ['message' => 'Invalid API Key provided']]);
    return true;
}
parse_str(file_get_contents('php://input'), $form);
$state['requests'][] = ['method' => $method, 'path' => $path, 'form' => $form, 'idempotency' => $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? null];
$state['seq']++;
$out = null;
if ($method === 'POST' && $path === '/v1/customers') {
    $id = 'cus_test_' . $state['seq'];
    $state['customers'][$id] = $form;
    $out = ['id' => $id, 'object' => 'customer'] + $form;
} elseif ($method === 'POST' && $path === '/v1/checkout/sessions') {
    $id = 'cs_test_' . $state['seq'];
    $out = ['id' => $id, 'object' => 'checkout.session', 'url' => 'https://checkout.stripe.test/' . $id, 'status' => 'open', 'payment_status' => 'unpaid', 'metadata' => $form['metadata'] ?? [], 'payment_intent' => null, 'line_items_form' => $form['line_items'] ?? [], 'success_url' => $form['success_url'] ?? null];
    $state['sessions'][$id] = $out;
} elseif ($method === 'GET' && preg_match('#^/v1/checkout/sessions/([^/]+)$#', $path, $m)) {
    if (!isset($state['sessions'][$m[1]])) {
        http_response_code(404);
        $out = ['error' => ['message' => 'No such checkout.session']];
    } else {
        $out = $state['sessions'][$m[1]];
    }
} else {
    http_response_code(404);
    $out = ['error' => ['message' => 'Unknown fake endpoint ' . $method . ' ' . $path]];
}
file_put_contents($stateFile, json_encode($state));
echo json_encode($out);
return true;

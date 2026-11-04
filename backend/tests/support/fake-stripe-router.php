<?php
// Fake Stripe API for automated tests (real Stripe test mode is exercised separately).
$stateFile = getenv('FAKE_STRIPE_STATE');
$fh = fopen($stateFile, 'c+');
flock($fh, LOCK_EX);
$state = json_decode(stream_get_contents($fh) ?: '', true) ?: ['seq' => 0, 'sessions' => [], 'refunds' => [], 'requests' => [], 'idem' => []];
$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
header('Content-Type: application/json');
$save = function () use ($fh, &$state) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($state));
    flock($fh, LOCK_UN);
};
if (($_SERVER['HTTP_AUTHORIZATION'] ?? '') !== 'Bearer sk_test_fake') {
    http_response_code(401);
    echo json_encode(['error' => ['message' => 'Invalid API Key provided']]);
    $save();
    return true;
}
parse_str(file_get_contents('php://input'), $form);
$idem = $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? null;
$state['requests'][] = ['method' => $method, 'path' => $path, 'form' => $form, 'idempotency' => $idem];
if ($idem && isset($state['idem'][$idem])) {
    echo json_encode($state['idem'][$idem]);
    $save();
    return true;
}
if (!empty($state['fail_next'])) {
    $state['fail_next'] = false;
    http_response_code(500);
    echo json_encode(['error' => ['message' => 'Simulated Stripe outage']]);
    $save();
    return true;
}
$state['seq']++;
$out = null;
if ($method === 'POST' && $path === '/v1/checkout/sessions') {
    $id = 'cs_test_' . $state['seq'];
    $total = 0;
    foreach ($form['line_items'] ?? [] as $li) {
        $total += (int) $li['price_data']['unit_amount'] * (int) ($li['quantity'] ?? 1);
    }
    $out = ['id' => $id, 'object' => 'checkout.session', 'url' => 'https://checkout.stripe.test/' . $id, 'status' => 'open', 'payment_status' => 'unpaid',
        'amount_total' => $total, 'currency' => 'usd', 'metadata' => $form['metadata'] ?? [], 'payment_intent' => null, 'client_reference_id' => $form['client_reference_id'] ?? null,
        'customer_email' => $form['customer_email'] ?? null, 'expires_at' => (int) ($form['expires_at'] ?? 0), 'success_url' => $form['success_url'] ?? null, 'line_items_form' => $form['line_items'] ?? []];
    $state['sessions'][$id] = $out;
} elseif ($method === 'GET' && preg_match('#^/v1/checkout/sessions/([^/]+)$#', $path, $m)) {
    $out = $state['sessions'][$m[1]] ?? null;
    if (!$out) {
        http_response_code(404);
        $out = ['error' => ['message' => 'No such checkout.session']];
    } elseif (isset($_GET['expand']) && is_string($out['payment_intent'])) {
        $out['payment_intent'] = ['id' => $out['payment_intent'], 'object' => 'payment_intent'];
    }
} elseif ($method === 'POST' && preg_match('#^/v1/checkout/sessions/([^/]+)/expire$#', $path, $m)) {
    if (($state['sessions'][$m[1]]['status'] ?? null) !== 'open') {
        http_response_code(400);
        $out = ['error' => ['message' => 'Only open sessions can be expired']];
    } else {
        $state['sessions'][$m[1]]['status'] = 'expired';
        $out = $state['sessions'][$m[1]];
    }
} elseif ($method === 'POST' && $path === '/v1/refunds') {
    $id = 're_test_' . $state['seq'];
    $out = ['id' => $id, 'object' => 'refund', 'amount' => (int) $form['amount'], 'payment_intent' => $form['payment_intent'], 'status' => 'succeeded'];
    $state['refunds'][$id] = $out;
} else {
    http_response_code(404);
    $out = ['error' => ['message' => "Unknown fake endpoint {$method} {$path}"]];
}
if ($idem && http_response_code() < 400) {
    $state['idem'][$idem] = $out;
}
echo json_encode($out);
$save();
return true;

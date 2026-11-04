<?php
declare(strict_types=1);

namespace SanchezServices\Controllers;

use SanchezServices\App;
use SanchezServices\Http\HttpError;
use SanchezServices\Http\Request;
use SanchezServices\Http\Response;

final class OpsController
{
    public function __construct(private App $app)
    {
    }

    /** GET /api/health — no secrets, no PII. */
    public function health(Request $req): Response
    {
        $dbOk = false;
        try {
            $dbOk = (int) $this->app->db->scalar('SELECT 1') === 1;
        } catch (\Throwable) {
        }
        return Response::json([
            'ok' => $dbOk,
            'db' => $dbOk,
            'php' => PHP_VERSION,
            'time' => gmdate('c'),
        ], $dbOk ? 200 : 503);
    }

    /** POST /api/jobs/run?job=name|due  Authorization: Bearer <jobs.runner_token> (web-cron fallback) */
    public function runJob(Request $req): Response
    {
        $expected = $this->app->config->string('jobs.runner_token');
        $auth = $req->header('authorization') ?? '';
        $given = str_starts_with($auth, 'Bearer ') ? substr($auth, 7) : ($req->header('x-job-token') ?? '');
        if ($expected === '' || strlen($expected) < 32 || !hash_equals($expected, $given)) {
            throw HttpError::denied('Invalid job token.');
        }
        $job = $req->query['job'] ?? 'due';
        $result = $job === 'due' ? $this->app->jobs->runDue() : $this->app->jobs->run($job);
        return Response::json(['ok' => true, 'result' => $result]);
    }
}

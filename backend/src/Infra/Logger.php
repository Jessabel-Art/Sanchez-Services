<?php
declare(strict_types=1);

namespace SanchezServices\Infra;

/** JSON-lines logger. Never pass secrets, card data, or full webhook payloads. */
final class Logger
{
    private string $requestId;

    public function __construct(private string $dir = '')
    {
        $this->requestId = bin2hex(random_bytes(8));
    }

    public function requestId(): string
    {
        return $this->requestId;
    }

    /** @param array<string,mixed> $context */
    public function info(string $message, array $context = []): void { $this->write('info', $message, $context); }
    /** @param array<string,mixed> $context */
    public function warning(string $message, array $context = []): void { $this->write('warning', $message, $context); }
    /** @param array<string,mixed> $context */
    public function error(string $message, array $context = []): void { $this->write('error', $message, $context); }

    /** @param array<string,mixed> $context */
    private function write(string $level, string $message, array $context): void
    {
        $line = json_encode([
            'ts' => gmdate('Y-m-d\TH:i:s\Z'),
            'level' => $level,
            'rid' => $this->requestId,
            'msg' => $message,
            'ctx' => $context,
        ], JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR) . "\n";
        if ($this->dir !== '' && (is_dir($this->dir) || @mkdir($this->dir, 0750, true))) {
            @file_put_contents($this->dir . '/app-' . gmdate('Y-m-d') . '.log', $line, FILE_APPEND | LOCK_EX);
            return;
        }
        error_log(rtrim($line));
    }
}

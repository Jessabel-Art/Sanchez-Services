<?php
declare(strict_types=1);

namespace SanchezServices\Http;

final class Request
{
    /** @var array<string,mixed>|null */
    private ?array $jsonCache = null;

    /**
     * @param array<string,string> $query
     * @param array<string,string> $headers lower-cased header names
     * @param array<string,string> $routeParams
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query,
        public readonly array $headers,
        public readonly string $rawBody,
        public readonly string $ip,
        public array $routeParams = [],
    ) {
    }

    public static function fromGlobals(): self
    {
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = (string) $_SERVER['CONTENT_TYPE'];
        }
        // Some Apache/LiteSpeed setups strip Authorization unless rewritten into this var.
        if (!isset($headers['authorization']) && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
            $headers['authorization'] = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
        }
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = (string) parse_url($uri, PHP_URL_PATH);
        $query = [];
        foreach ($_GET as $k => $v) {
            if (is_scalar($v)) {
                $query[(string) $k] = (string) $v;
            }
        }
        $raw = (string) file_get_contents('php://input');
        return new self(
            strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
            $path,
            $query,
            $headers,
            $raw,
            (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'),
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /** @return array<string,mixed> */
    public function json(): array
    {
        if ($this->jsonCache !== null) {
            return $this->jsonCache;
        }
        if (trim($this->rawBody) === '') {
            return $this->jsonCache = [];
        }
        try {
            $v = json_decode($this->rawBody, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw HttpError::invalid('Request body must be valid JSON.');
        }
        if (!is_array($v)) {
            throw HttpError::invalid('Request body must be a JSON object.');
        }
        return $this->jsonCache = $v;
    }

    public function param(string $name): string
    {
        return $this->routeParams[$name] ?? '';
    }
}

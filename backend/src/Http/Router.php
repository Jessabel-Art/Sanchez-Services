<?php
declare(strict_types=1);

namespace SanchezServices\Http;

final class Router
{
    /** @var list<array{method:string,regex:string,names:list<string>,handler:callable,opts:array<string,mixed>}> */
    private array $routes = [];

    /** @param array<string,mixed> $opts e.g. ['csrf' => false, 'session' => false] */
    public function add(string $method, string $pattern, callable $handler, array $opts = []): void
    {
        $names = [];
        $regex = preg_replace_callback('#\{([a-zA-Z_]+)(\*)?\}#', static function ($m) use (&$names) {
            $names[] = $m[1];
            return isset($m[2]) && $m[2] === '*' ? '(.+)' : '([^/]+)';
        }, $pattern);
        $this->routes[] = [
            'method' => strtoupper($method),
            'regex' => '#^' . $regex . '$#',
            'names' => $names,
            'handler' => $handler,
            'opts' => $opts,
        ];
    }

    /** @return array{handler:callable,params:array<string,string>,opts:array<string,mixed>} */
    public function match(string $method, string $path): array
    {
        $pathMatched = false;
        foreach ($this->routes as $route) {
            if (!preg_match($route['regex'], $path, $m)) {
                continue;
            }
            $pathMatched = true;
            if ($route['method'] !== $method) {
                continue;
            }
            $params = [];
            foreach ($route['names'] as $i => $name) {
                $params[$name] = rawurldecode($m[$i + 1]);
            }
            return ['handler' => $route['handler'], 'params' => $params, 'opts' => $route['opts']];
        }
        if ($pathMatched) {
            throw new HttpError('method-not-allowed', 'Method not allowed.');
        }
        throw HttpError::notFound('Unknown endpoint.');
    }
}

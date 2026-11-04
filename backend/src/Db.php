<?php
declare(strict_types=1);

namespace SanchezServices;

use PDO;

final class Db
{
    private PDO $pdo;
    private int $depth = 0;

    public function __construct(string $dsn, string $user, string $password)
    {
        $this->pdo = new PDO($dsn, $user, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        if (str_starts_with($dsn, 'mysql:')) {
            // All DATETIME columns hold UTC.
            $this->pdo->exec("SET time_zone = '+00:00'");
            $this->pdo->exec("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
        }
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    /** @param array<int|string,mixed> $params */
    public function run(string $sql, array $params = []): \PDOStatement
    {
        $stmt = $this->pdo->prepare($sql);
        foreach ($params as $key => $value) {
            $name = is_int($key) ? $key + 1 : (str_starts_with($key, ':') ? $key : ':' . $key);
            $type = match (true) {
                is_int($value) => PDO::PARAM_INT,
                is_bool($value) => PDO::PARAM_BOOL,
                $value === null => PDO::PARAM_NULL,
                default => PDO::PARAM_STR,
            };
            $stmt->bindValue($name, $value, $type);
        }
        $stmt->execute();
        return $stmt;
    }

    /** @return array<string,mixed>|null */
    public function one(string $sql, array $params = []): ?array
    {
        $row = $this->run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    /** @return list<array<string,mixed>> */
    public function all(string $sql, array $params = []): array
    {
        return $this->run($sql, $params)->fetchAll();
    }

    public function scalar(string $sql, array $params = []): mixed
    {
        $v = $this->run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    /** @param array<string,mixed> $row */
    public function insert(string $table, array $row): int
    {
        $cols = array_keys($row);
        $sql = sprintf(
            'INSERT INTO %s (%s) VALUES (%s)',
            $table,
            implode(', ', array_map(static fn ($c) => "`$c`", $cols)),
            implode(', ', array_map(static fn ($c) => ':' . $c, $cols))
        );
        $this->run($sql, $row);
        return (int) $this->pdo->lastInsertId();
    }

    /**
     * @param array<string,mixed> $set
     * @param array<string,mixed> $where
     */
    public function update(string $table, array $set, array $where): int
    {
        $params = [];
        $setSql = [];
        foreach ($set as $col => $val) {
            $setSql[] = "`$col` = :s_$col";
            $params["s_$col"] = $val;
        }
        $whereSql = [];
        foreach ($where as $col => $val) {
            $whereSql[] = "`$col` = :w_$col";
            $params["w_$col"] = $val;
        }
        return $this->run(
            sprintf('UPDATE %s SET %s WHERE %s', $table, implode(', ', $setSql), implode(' AND ', $whereSql)),
            $params
        )->rowCount();
    }

    /**
     * Runs $fn inside a transaction. Nested calls join the outer transaction.
     * Retries once on deadlock / lock wait timeout.
     *
     * @template T
     * @param callable():T $fn
     * @return T
     */
    public function transaction(callable $fn): mixed
    {
        if ($this->depth > 0) {
            $this->depth++;
            try {
                return $fn();
            } finally {
                $this->depth--;
            }
        }
        $attempt = 0;
        while (true) {
            $attempt++;
            $this->pdo->beginTransaction();
            $this->depth = 1;
            try {
                $result = $fn();
                $this->pdo->commit();
                $this->depth = 0;
                return $result;
            } catch (\Throwable $e) {
                $this->depth = 0;
                if ($this->pdo->inTransaction()) {
                    $this->pdo->rollBack();
                }
                $isDeadlock = $e instanceof \PDOException && in_array((string) ($e->errorInfo[1] ?? ''), ['1213', '1205'], true);
                if ($isDeadlock && $attempt < 5) {
                    usleep(random_int(20000, 80000) * $attempt);
                    continue;
                }
                throw $e;
            }
        }
    }

    public function inTransaction(): bool
    {
        return $this->depth > 0;
    }
}

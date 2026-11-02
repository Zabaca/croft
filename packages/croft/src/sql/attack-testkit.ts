// The attack list a key's queries must all fail (option 06, slice 3 acceptance 1 and 4; slice 4 sends the same list over
// Quack). Test support, left out of the published package (package.json "files"). It holds what a person with a key might
// type to read a table that is not shared, change data, read a file, learn a setting or stop the server, written plainly,
// and `variants()` writes each of them again the ways the first Quack spike's allowance was fooled: with a catalog
// function's name in a comment, in a string literal and after a line comment.
//
// The warehouse these are written against has the tables orders and customers (shared), payments and secrets (not shared)
// and the schema _croft with its table assets (croft's own state, as the file adapter has it and as the log adapter has it: a log table and a view). `files/x.csv` stands for any file a project could name.

/** The tables the project shares with keys in these tests. */
export const SHARED = ["orders", "customers"] as const;
/** A warehouse these attacks make sense against (DuckDB SQL). */
export const WAREHOUSE_SQL = [
  "CREATE TABLE orders AS SELECT range AS id, range % 7 AS k, 'o' || range AS note FROM range(20)",
  "CREATE TABLE customers AS SELECT range AS id, 'c' || range AS name FROM range(5)",
  "CREATE TABLE payments AS SELECT range AS id, range * 10 AS amount, 'p' || range AS note FROM range(8)",
  "CREATE TABLE secrets AS SELECT 'token' AS name, 'hunter2' AS value",
  "CREATE SCHEMA _croft",
  "CREATE TABLE _croft.assets AS SELECT 'orders' AS name",
  // The log adapter's shape of the same state (db/bookkeeping.ts, D132): a log table and a view over one.
  "CREATE TABLE _croft.assets_log AS SELECT 'orders' AS name, 1::BIGINT AS seq, false AS closed",
  "CREATE VIEW _croft.columns AS SELECT 'orders' AS asset, 'id' AS name",
];

export interface Attack {
  label: string;
  sql: string;
}

const a = (label: string, sql: string): Attack => ({ label, sql });

/** Reading a table that is not shared, every way a query can name one. */
export const HIDDEN_TABLES: readonly Attack[] = [
  a("directly", "SELECT * FROM payments"),
  a("a second hidden table", "SELECT * FROM secrets"),
  a("FROM first", "FROM payments"),
  a("TABLE", "TABLE payments"),
  a("in a subquery", "SELECT * FROM orders WHERE id IN (SELECT id FROM payments)"),
  a("in a derived table", "SELECT * FROM (SELECT * FROM payments) AS p"),
  a("in a CTE", "WITH p AS (SELECT * FROM payments) SELECT * FROM p"),
  a("in a recursive CTE", "WITH RECURSIVE p(n) AS (SELECT amount FROM payments UNION ALL SELECT n FROM p WHERE n < 0) SELECT * FROM p"),
  a("in a scalar subquery", "SELECT (SELECT max(amount) FROM payments) AS m"),
  a("in an EXISTS", "SELECT 1 WHERE EXISTS (SELECT 1 FROM payments)"),
  a("in a join", "SELECT * FROM orders JOIN payments USING (id)"),
  a("in a lateral join", "SELECT * FROM orders, LATERAL (SELECT * FROM payments) AS l"),
  a("in a union", "SELECT note FROM orders UNION ALL SELECT note FROM payments"),
  a("behind a CTE of the same name", "WITH payments AS (SELECT * FROM payments) SELECT * FROM payments"),
  a("by catalog and schema", "SELECT * FROM memory.main.payments"),
  a("by schema", "SELECT * FROM main.payments"),
  a("by another catalog", "SELECT * FROM other.main.payments"),
  a("croft's own schema", "SELECT * FROM _croft.assets"),
  a("croft's own schema, with the catalog", "SELECT * FROM memory._croft.assets"),
  a("croft's log of its state", "SELECT * FROM _croft.assets_log"),
  a("croft's log, with the catalog", "SELECT * FROM memory._croft.assets_log"),
  a("a view over croft's log", "SELECT * FROM _croft.columns"),
  a("croft's log, quoted with changed case", 'SELECT * FROM "_CROFT"."ASSETS_LOG"'),
  a("with changed case", "SELECT * FROM PAYMENTS"),
  a("quoted, with changed case", 'SELECT * FROM "Payments"'),
  a("croft's schema, with changed case", 'SELECT * FROM "_CROFT".ASSETS'),
  a("by query_table", "SELECT * FROM query_table('payments')"),
  a("by query()", "SELECT * FROM query('SELECT * FROM payments')"),
  a("by a serialized plan", "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT * FROM payments'))"),
  a("by histogram", "SELECT * FROM histogram(payments, amount)"),
  a("by PIVOT", "PIVOT payments ON note USING sum(amount)"),
  a("by PIVOT with its values", "PIVOT payments ON note IN ('p1', 'p2') USING sum(amount)"),
  a("by DESCRIBE", "DESCRIBE payments"),
  a("by SUMMARIZE", "SUMMARIZE payments"),
  a("by SHOW", "SHOW payments"),
  a("by DESCRIBE of a query", "DESCRIBE SELECT * FROM payments"),
  a("by a comment first", "/* x */ SELECT * FROM payments"),
];

/** Changing data, files or settings, and everything that is not one SELECT. */
export const NOT_A_READ: readonly Attack[] = [
  a("INSERT", "INSERT INTO orders VALUES (1, 1, 'x')"),
  a("UPDATE", "UPDATE orders SET k = 0"),
  a("DELETE", "DELETE FROM orders"),
  a("DELETE RETURNING", "DELETE FROM orders WHERE id < 10 RETURNING id"),
  a("DROP TABLE", "DROP TABLE orders"),
  a("DROP VIEW", "DROP VIEW orders"),
  a("CREATE TABLE", "CREATE TABLE pwn AS SELECT 1"),
  a("CREATE VIEW", "CREATE VIEW pwn AS SELECT * FROM payments"),
  a("CREATE MACRO", "CREATE MACRO pwn() AS 1"),
  a("ALTER", "ALTER TABLE orders ADD COLUMN z INTEGER"),
  a("a DELETE inside a WITH", "WITH x AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM x"),
  a("an INSERT inside a WITH", "WITH x AS (INSERT INTO orders VALUES (1, 1, 'x') RETURNING *) SELECT count(*) FROM x"),
  a("a COPY inside a WITH", "WITH x AS (COPY (SELECT 1) TO 'pwn1.csv') SELECT 1"),
  a("COPY TO", "COPY orders TO 'pwn2.csv'"),
  a("COPY (query) TO", "COPY (SELECT * FROM payments) TO 'pwn3.csv'"),
  a("COPY FROM", "COPY orders FROM 'files/x.csv'"),
  a("EXPORT DATABASE", "EXPORT DATABASE 'exp'"),
  a("IMPORT DATABASE", "IMPORT DATABASE 'exp'"),
  a("ATTACH", "ATTACH ':memory:' AS m"),
  a("ATTACH a file", "ATTACH 'files/x.duckdb' AS m"),
  a("DETACH", "DETACH wh"),
  a("INSTALL", "INSTALL httpfs"),
  a("LOAD", "LOAD httpfs"),
  a("SET", "SET threads = 1"),
  a("RESET", "RESET threads"),
  a("PRAGMA", "PRAGMA database_list"),
  a("CALL", "CALL checkpoint()"),
  a("CHECKPOINT", "CHECKPOINT"),
  a("VACUUM", "VACUUM"),
  a("USE", "USE payments"),
  a("BEGIN", "BEGIN TRANSACTION"),
  a("EXPLAIN", "EXPLAIN SELECT * FROM orders"),
  a("PREPARE", "PREPARE p AS SELECT * FROM payments"),
  a("two statements", "SELECT 1; SELECT 2"),
  a("a second statement that drops", "SELECT 1; DROP TABLE orders"),
  a("nothing", ""),
];

/** Reading a file or a URL, a setting or the machine, or stopping the server. */
export const REACHING_OUT: readonly Attack[] = [
  a("read_csv", "SELECT * FROM read_csv('files/x.csv')"),
  a("read_text of the record file", "SELECT content FROM read_text('.croft/serve.json')"),
  a("read_text of the keys file", "SELECT content FROM read_text('.croft/serve-keys.json')"),
  a("read_blob of the read copy", "SELECT * FROM read_blob('warehouse.read.duckdb')"),
  a("read_parquet", "SELECT * FROM read_parquet('files/x.parquet')"),
  a("read_json", "SELECT * FROM read_json('files/x.json')"),
  a("a path as a table", "SELECT * FROM 'files/x.csv'"),
  a("the read copy as a table", "SELECT * FROM 'warehouse.read.duckdb'"),
  a("a URL as a table", "SELECT * FROM 'https://example.com/x.csv'"),
  a("glob", "SELECT * FROM glob('*')"),
  a("glob of a folder", "SELECT * FROM glob('/etc/*')"),
  a("getenv", "SELECT getenv('HOME')"),
  a("current_setting", "SELECT current_setting('secret_directory')"),
  a("getvariable", "SELECT getvariable('x')"),
  a("sleep_ms", "SELECT sleep_ms(1)"),
  a("write_log", "SELECT write_log('x')"),
  a("setval", "SELECT setval('s', 1)"),
  a("duckdb_settings()", "SELECT * FROM duckdb_settings()"),
  a("duckdb_settings, without parentheses", "FROM duckdb_settings"),
  a("duckdb_secrets()", "SELECT * FROM duckdb_secrets()"),
  a("duckdb_tables()", "SELECT * FROM duckdb_tables()"),
  a("duckdb_views()", "SELECT sql FROM duckdb_views()"),
  a("duckdb_databases()", "SELECT * FROM duckdb_databases()"),
  a("pragma_database_list", "SELECT * FROM pragma_database_list"),
  a("information_schema", "SELECT * FROM information_schema.tables"),
  a("pg_catalog", "SELECT * FROM pg_catalog.pg_tables"),
  a("a catalog function beside a hidden table", "SELECT * FROM duckdb_settings(), payments LIMIT 1"),
  a("quack_stop", "SELECT * FROM quack_stop('quack:localhost:1')"),
  a("quack_serve", "SELECT * FROM quack_serve('quack:localhost:1', token = 'xxxx')"),
  a("quack_query", "SELECT * FROM quack_query('quack:localhost:1', 'SELECT 1', token = 'xxxx')"),
  a("quack_active_connections", "SELECT * FROM quack_active_connections()"),
  a("quack_cancel", "SELECT * FROM quack_cancel('memory', 'x')"),
  a("quack_server_list", "SELECT * FROM quack_server_list()"),
  a("quack_check_token", "SELECT quack_check_token('x', 'y', 'z')"),
  a("quack_connection_id", "SELECT quack_connection_id('x')"),
  a("croft's authorization hook", "SELECT croft_authz('x', 'SELECT 1')"),
  a("croft's sign-in hook", "SELECT croft_authn('x', 'y', 'z')"),
  a("the function behind croft's authorization hook", "SELECT croft_authz_js('x', 'SELECT 1', '{}')"),
  a("croft's hook, qualified", "SELECT memory.main.croft_authz('x', 'SELECT 1')"),
  a("a huge list as a value", "SELECT list_sort(range(150000000))"),
  a("SHOW ALL TABLES", "SHOW ALL TABLES"),
  a("a bare DESCRIBE", "DESCRIBE"),
  a("SHOW DATABASES", "SHOW DATABASES"),
  a("SHOW SCHEMAS", "SHOW SCHEMAS"),
  a("SHOW TABLES FROM croft's schema", "SHOW TABLES FROM _croft"),
  a("SHOW TABLES FROM a catalog", "SHOW TABLES FROM memory"),
  a("SHOW TABLES inside a query", "SELECT name FROM (SHOW TABLES)"),
];

/**
 * What a lake project's SQL must not reach (option 07, slice 2; DESIGN.md D140): the catalog database behind the lake, the credentials
 * the instance holds, and the bucket's own files. Every one is refused by `croft query`, in an SQL asset, in a check and over HTTP
 * (the serve gate's allowlist refuses all of it already); in a project with a file most of them are not refused, which is the point of
 * the lake flag. `lake` is the lake's name (the alias croft attaches it under), `bucket` the lake's folder as `s3://bucket/folder/`.
 */
export function lakeAttacks(bucket: string, lake = "lake"): readonly Attack[] {
  const meta = `__ducklake_metadata_${lake}`;
  return [
    a("postgres_query on the catalog", `SELECT * FROM postgres_query('${meta}', 'SELECT count(*) FROM ducklake_snapshot')`),
    a("postgres_query on the catalog, positional", `SELECT * FROM postgres_query('${meta}', 'SELECT 1') AS q`),
    a("postgres_execute on the catalog", `SELECT * FROM postgres_execute('${meta}', 'DROP TABLE ducklake_snapshot')`),
    a("CALL postgres_execute", `CALL postgres_execute('${meta}', 'SELECT 1')`),
    a("postgres_scan of the catalog", `SELECT * FROM postgres_scan('dbname=x', 'public', 'ducklake_snapshot')`),
    a("duckdb_secrets()", "SELECT * FROM duckdb_secrets()"),
    a("duckdb_secrets() for its key id", "SELECT name, type, secret_string FROM duckdb_secrets()"),
    a("duckdb_secrets without parentheses", "FROM duckdb_secrets"),
    a("duckdb_secrets, qualified", "SELECT * FROM system.main.duckdb_secrets()"),
    a("which_secret", `SELECT * FROM which_secret('${bucket}x.parquet', 's3')`),
    a("duckdb_databases()", "SELECT * FROM duckdb_databases()"),
    a("duckdb_databases without parentheses", "FROM duckdb_databases"),
    a("duckdb_databases in a CTE", "WITH d AS (SELECT * FROM duckdb_databases()) SELECT * FROM d"),
    a("duckdb_databases in a subquery", "SELECT (SELECT count(*) FROM duckdb_databases()) AS n"),
    a("the metadata catalog", `SELECT * FROM ${meta}.ducklake_snapshot`),
    a("the metadata catalog, with its schema", `SELECT * FROM ${meta}.main.ducklake_snapshot`),
    a("the metadata catalog, quoted with changed case", `SELECT * FROM "${meta.toUpperCase()}".ducklake_snapshot`),
    a("the metadata catalog in a subquery", `SELECT * FROM orders WHERE id IN (SELECT snapshot_id FROM ${meta}.ducklake_snapshot)`),
    a("the metadata catalog in a CTE", `WITH s AS (SELECT * FROM ${meta}.ducklake_snapshot) SELECT * FROM s`),
    a("the metadata catalog joined", `SELECT * FROM orders JOIN ${meta}.ducklake_snapshot ON true`),
    a("the metadata catalog by DESCRIBE", `DESCRIBE ${meta}.ducklake_snapshot`),
    a("ducklake_list_files", `SELECT * FROM ducklake_list_files('${lake}', 'orders')`),
    a("ducklake_snapshots", `SELECT * FROM ducklake_snapshots('${lake}')`),
    a("the lake's snapshots", `SELECT * FROM ${lake}.snapshots()`),
    a("read_parquet of the bucket", `SELECT * FROM read_parquet('${bucket}**/*.parquet')`),
    a("read_parquet of one file", `SELECT * FROM read_parquet('${bucket}main/orders/ducklake-0.parquet')`),
    a("read_parquet of a list", `SELECT * FROM read_parquet(['${bucket}a.parquet', '${bucket}b.parquet'])`),
    a("parquet_scan of the bucket", `SELECT * FROM parquet_scan('${bucket}**/*.parquet')`),
    a("parquet_metadata of the bucket", `SELECT * FROM parquet_metadata('${bucket}**/*.parquet')`),
    a("read_csv of the bucket", `SELECT * FROM read_csv('${bucket}x.csv')`),
    a("read_json of the bucket", `SELECT * FROM read_json('${bucket}x.json')`),
    a("read_text of the bucket", `SELECT * FROM read_text('${bucket}x')`),
    a("read_blob of the bucket", `SELECT * FROM read_blob('${bucket}x')`),
    a("glob of the bucket", `SELECT * FROM glob('${bucket}*')`),
    a("the bucket as a table", `SELECT * FROM '${bucket}main/orders/x.parquet'`),
    a("another bucket", "SELECT * FROM read_parquet('s3://other/x.parquet')"),
    a("the bucket by a path that is not a literal", `SELECT * FROM read_parquet('${bucket}' || '**/*.parquet')`),
  ];
}

/** Each attack as written, and again with a catalog function's name in a comment after it, in a line comment after it, and in a
 *  string literal: the ways the first Quack spike's catalog allowance was bypassed. Every attack gets a literal-bearing form,
 *  whatever it is. A SELECT carries it as a column in front. Any attack that has a string literal of its own (a path, an
 *  ATTACH target) carries the name inside that literal. An INSERT, UPDATE or DELETE carries it in a WITH in front. Every
 *  other statement (DROP, CREATE, SET, PRAGMA, a SELECT that is several statements, ...) is paired with a SELECT of the literal
 *  before it and after it. */
export function variants(attack: Attack): Attack[] {
  const out = [attack, a(`${attack.label}, with a catalog function in a comment`, `${attack.sql} /* duckdb_tables( */`)];
  if (!attack.sql.includes("--")) out.push(a(`${attack.label}, after a line comment`, `${attack.sql} -- duckdb_schemas(`));
  const lit = "'duckdb_tables()'";
  if (attack.sql.trim() === "") return out;
  const plain = out.length;
  if (/^SELECT\s/i.test(attack.sql) && !attack.sql.includes(";")) {
    out.push(a(`${attack.label}, with a catalog function in a string`, attack.sql.replace(/^SELECT\s/i, `SELECT ${lit} AS x, `)));
  }
  const own = /'([^']*)'/.exec(attack.sql);
  if (own) out.push(a(`${attack.label}, with a catalog function inside its own string literal`, attack.sql.replace(own[0], `'duckdb_tables()${own[1]}'`)));
  if (/^(INSERT|UPDATE|DELETE)\b/i.test(attack.sql)) {
    out.push(a(`${attack.label}, behind a WITH that holds a string literal`, `WITH c AS (SELECT ${lit} AS x) ${attack.sql}`));
  }
  if (out.length === plain) {
    out.push(a(`${attack.label}, after a statement with a string literal`, `SELECT ${lit}; ${attack.sql}`));
    out.push(a(`${attack.label}, before a statement with a string literal`, `${attack.sql}; SELECT ${lit}`));
  }
  return out;
}

/** Every attack, in every variant. */
export const ALL_ATTACKS: readonly Attack[] = [...HIDDEN_TABLES, ...NOT_A_READ, ...REACHING_OUT].flatMap(variants);

/** Queries a key must be able to run: the shared tables, with filters, aggregates, joins, CTEs and subqueries. */
export const ALLOWED: readonly Attack[] = [
  a("a shared table", "SELECT count(*) AS n FROM orders"),
  a("with a filter and an aggregate", "SELECT k, count(*) AS n FROM orders WHERE id > 3 GROUP BY k ORDER BY k"),
  a("with changed case", "SELECT count(*) AS n FROM ORDERS"),
  a("quoted", 'SELECT count(*) AS n FROM "orders"'),
  a("with its schema", "SELECT count(*) AS n FROM main.orders"),
  a("a join of two shared tables", "SELECT count(*) AS n FROM orders o JOIN customers c ON o.id = c.id"),
  a("a CTE over a shared table", "WITH big AS (SELECT * FROM orders WHERE id > 10) SELECT count(*) AS n FROM big"),
  a("a subquery over a shared table", "SELECT * FROM orders WHERE id IN (SELECT id FROM customers) ORDER BY id"),
  a("a query with no table", "SELECT 1 + 1 AS two"),
  a("range as a table", "SELECT count(*) AS n FROM range(10)"),
  a("DESCRIBE of a shared table", "DESCRIBE orders"),
  a("SUMMARIZE of a shared table", "SUMMARIZE customers"),
  a("SHOW TABLES", "SHOW TABLES"),
];

/**
 * Queries that name a CTE after a table, in every shape a CTE takes. For a key, a table that is hidden and a name that does not
 * exist must be treated exactly alike, so each query is sent twice, once with a hidden table's name and once with a name no table
 * has, and the two answers must be the same in everything but that name: the same status, the same problem and words, the same
 * rows. (A CTE named after a hidden table was once refused while one named after nothing was allowed, which let a key list the
 * project's table names one guess at a time.)
 */
export const CTE_SHAPES: readonly { label: string; sql: (name: string) => string }[] = [
  { label: "a CTE named after it, then selected", sql: (n) => `WITH ${n} AS (SELECT 1 AS x) SELECT * FROM ${n}` },
  { label: "a CTE that selects from the table of its own name", sql: (n) => `WITH ${n} AS (SELECT * FROM ${n}) SELECT * FROM ${n}` },
  { label: "nested in another CTE", sql: (n) => `WITH a AS (WITH ${n} AS (SELECT 1 AS x) SELECT * FROM ${n}) SELECT * FROM a` },
  { label: "recursive", sql: (n) => `WITH RECURSIVE ${n}(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM ${n} WHERE x < 3) SELECT * FROM ${n}` },
  { label: "in a scalar subquery", sql: (n) => `SELECT (WITH ${n} AS (SELECT 1 AS x) SELECT max(x) FROM ${n}) AS m` },
  { label: "read by a later CTE", sql: (n) => `WITH ${n} AS (SELECT 1 AS x), b AS (SELECT * FROM ${n}) SELECT * FROM b` },
  { label: "read by an earlier CTE, which cannot see it", sql: (n) => `WITH b AS (SELECT * FROM ${n}), ${n} AS (SELECT 1 AS x) SELECT * FROM b` },
  { label: "beside the table itself", sql: (n) => `WITH ${n} AS (SELECT 1 AS x) SELECT x FROM ${n} UNION ALL SELECT id FROM main.${n}` },
  { label: "in a derived table, with the table outside it", sql: (n) => `SELECT * FROM (WITH ${n} AS (SELECT 1 AS x) SELECT * FROM ${n}) AS q, ${n}` },
  { label: "with the case changed", sql: (n) => `WITH ${n.toUpperCase()} AS (SELECT 1 AS x) SELECT * FROM ${n}` },
  { label: "quoted", sql: (n) => `WITH "${n}" AS (SELECT 1 AS x) SELECT * FROM "${n}"` },
  { label: "unused", sql: (n) => `WITH ${n} AS (SELECT 1 AS x) SELECT 2 AS y` },
  { label: "joined to a shared table", sql: (n) => `WITH ${n} AS (SELECT 1 AS id) SELECT count(*) AS c FROM orders o JOIN ${n} ON o.id = ${n}.id` },
];

/** The hidden tables the pairs use, and for each a name of the same length that no table has (so positions in a message match). */
export const HIDDEN_NAMES = ["payments", "secrets"] as const;
export const absentFor = (hidden: string): string => "z".repeat(hidden.length);

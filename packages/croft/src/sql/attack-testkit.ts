// The attack list a key's queries must all fail (option 06, slice 3 acceptance 1 and 4; slice 4 sends the same list over
// Quack). Test support, left out of the published package (package.json "files"). It holds what a person with a key might
// type to read a table that is not shared, change data, read a file, learn a setting or stop the server, written plainly,
// and `variants()` writes each of them again the ways the first Quack spike's allowance was fooled: with a catalog
// function's name in a comment, in a string literal and after a line comment.
//
// The warehouse these are written against has the tables orders and customers (shared), payments and secrets (not shared)
// and the schema _croft with its table assets (croft's own state). `files/x.csv` stands for any file a project could name.

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
  a("a CTE that takes a hidden table's name", "WITH payments AS (SELECT 1 AS a) SELECT a FROM payments"),
  a("by catalog and schema", "SELECT * FROM memory.main.payments"),
  a("by schema", "SELECT * FROM main.payments"),
  a("by another catalog", "SELECT * FROM other.main.payments"),
  a("croft's own schema", "SELECT * FROM _croft.assets"),
  a("croft's own schema, with the catalog", "SELECT * FROM memory._croft.assets"),
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
  a("a huge list as a value", "SELECT list_sort(range(150000000))"),
  a("SHOW ALL TABLES", "SHOW ALL TABLES"),
  a("a bare DESCRIBE", "DESCRIBE"),
  a("SHOW DATABASES", "SHOW DATABASES"),
  a("SHOW SCHEMAS", "SHOW SCHEMAS"),
  a("SHOW TABLES FROM croft's schema", "SHOW TABLES FROM _croft"),
  a("SHOW TABLES FROM a catalog", "SHOW TABLES FROM memory"),
  a("SHOW TABLES inside a query", "SELECT name FROM (SHOW TABLES)"),
];

/** Each attack as written, with a catalog function's name in a comment after it, in a line comment after it, and (for a
 *  SELECT) in a string literal in front: the ways the first Quack spike's catalog allowance was bypassed. */
export function variants(attack: Attack): Attack[] {
  const out = [attack, a(`${attack.label}, with a catalog function in a comment`, `${attack.sql} /* duckdb_tables( */`)];
  if (!attack.sql.includes("--")) out.push(a(`${attack.label}, after a line comment`, `${attack.sql} -- duckdb_schemas(`));
  if (/^SELECT\s/i.test(attack.sql) && !attack.sql.includes(";")) {
    out.push(a(`${attack.label}, with a catalog function in a string`, attack.sql.replace(/^SELECT\s/i, "SELECT 'duckdb_tables()' AS x, ")));
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

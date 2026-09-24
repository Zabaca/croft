import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync, linkSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { connect, instanceConfig, openMemory } from "../db/connect.ts";
import { closeAllWarehouses, openWarehouse } from "../db/warehouse.ts";
import { cleanup, makeProject, seed, spawnHolder, type TempProject } from "../read/testkit.ts";
import { assertOneSelect, findFunctions, type GateOptions, lineColumn, TABLE_FUNCTIONS } from "./gate.ts";

let db: Awaited<ReturnType<typeof openMemory>>;
let conn: DuckDBConnection;
beforeAll(async () => {
  db = await openMemory({ timezone: "UTC" });
  conn = await db.connect();
  await conn.run("CREATE TABLE t (a INTEGER, b VARCHAR)");
});
afterAll(async () => {
  db.close();
  await closeAllWarehouses();
  cleanup();
});

async function code(sql: string, o?: GateOptions, on: DuckDBConnection = conn): Promise<CroftError> {
  try {
    await assertOneSelect(on, sql, o);
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error(`gate accepted ${JSON.stringify(sql)}`);
}

/** Run `fn` with the process working directory at `dir`: DuckDB resolves relative paths against it. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

describe("passes exactly one SELECT", () => {
  for (const sql of [
    "select 1",
    "select 1;",
    "select 1; -- trailing comment",
    "SELECT a FROM t WHERE b = 'x;y'",
    "from t",
    "with x as (select 1 a) select * from x",
    "describe t",
    "summarize t",
    "show tables",
    "values (1), (2)",
    "pivot t on b in ('x') using sum(a)",
    // json_serialize_sql writes a DOUBLE constant beyond range as a bare Infinity.
    "select a from t where a < 1e400",
    "select 1e400, -1e400",
  ]) {
    test(sql, async () => {
      const ast = await assertOneSelect(conn, sql);
      expect(ast.node.type).toBe("SELECT_NODE");
    });
  }
});

describe("rejects", () => {
  test("two statements", async () => {
    const e = await code("select 1; select 2");
    expect(e.code).toBe("SQL_NOT_ONE_STATEMENT");
    expect(e.message).toContain("found 2 statements");
  });

  test("an injected second statement", async () => {
    expect((await code("select 1; drop table t")).code).toBe("SQL_NOT_ONE_STATEMENT");
  });

  test("empty input and comments only", async () => {
    for (const sql of ["", "   ", "-- nothing"]) {
      const e = await code(sql);
      expect(e.code).toBe("SQL_NOT_ONE_STATEMENT");
      expect(e.message).toContain("no SQL statement");
    }
  });

  test("COPY, ATTACH, DETACH and every other non-SELECT", async () => {
    for (const sql of [
      "copy t to 'out.csv'",
      "attach 'x.duckdb' as x",
      "detach x",
      "insert into t values (1, 'a')",
      "update t set a = 1",
      "create table u as select 1",
      "drop table t",
      "pragma version",
      "explain select 1",
      "set threads = 1",
      "call pragma_version()",
      "pivot t on b",
    ]) {
      const e = await code(sql);
      expect([sql, e.code]).toEqual([sql, sql === "pivot t on b" ? "SQL_NOT_ONE_STATEMENT" : "QUERY_NOT_SELECT"]);
    }
    expect((await code("copy t to 'out.csv'")).problem.hint).toContain("exports are post-v1");
  });

  test("SQL assets report SQL_NOT_SELECT", async () => {
    expect((await code("insert into t values (1, 'a')", { notSelectCode: "SQL_NOT_SELECT" })).code).toBe("SQL_NOT_SELECT");
  });

  test("syntax errors carry line and column", async () => {
    const e = await code("select *\nfrom t\nwhere a = = 1", { file: "assets/x.sql", lineOffset: 2 });
    expect(e.code).toBe("SQL_SYNTAX");
    expect(e.problem).toMatchObject({ line: 5, column: 11, file: "assets/x.sql" });
    const tail = await code("select * from t where");
    expect(tail.code).toBe("SQL_SYNTAX");
    expect(tail.problem.line).toBe(1);
    expect(tail.problem.column).toBe(22);
    const first = await code("selec 1");
    expect(first.problem).toMatchObject({ line: 1, column: 1 });
  });

  test("positions count code points, not bytes or UTF-16 units", async () => {
    const e = await code("select '😀日本' = = 1");
    expect(e.problem.column).toBe(16);
  });
});

describe("serve profile", () => {
  test("denies file, glob and settings functions anywhere in the query", async () => {
    for (const [sql, name] of [
      ["select * from glob('*')", "glob"],
      ["select * from read_csv('files/a.csv')", "read_csv"],
      ["select * from read_text('.env')", "read_text"],
      ["select * from read_parquet('x.parquet')", "read_parquet"],
      ["from duckdb_settings()", "duckdb_settings"],
      ["select path from duckdb_databases()", "duckdb_databases"],
      ["select a from t where a in (select 1 from read_json('x.json'))", "read_json"],
      ["with x as (select * from glob('*')) select * from x", "glob"],
      ["select current_setting('temp_directory')", "current_setting"],
      ["from query('from duckdb_settings()')", "query"],
    ] as const) {
      const e = await code(sql, { profile: "serve" });
      expect(e.code).toBe("QUERY_PATH_DENIED");
      expect(e.message).toContain(`${name}()`);
    }
    const located = await code("select a\nfrom glob('*')", { profile: "serve" });
    expect(located.problem).toMatchObject({ line: 2, column: 6 });
  });

  test("allows tables", async () => {
    await assertOneSelect(conn, "select b, count(*) from t group by 1", { profile: "serve" });
    await assertOneSelect(conn, "describe t", { profile: "serve" });
  });

  test("is an allowlist: user tables in main, CTEs, and a few harmless table functions", async () => {
    for (const sql of [
      "select * from main.t",
      "select * from T",
      "with x as (select a from t) select * from x join t using (a)",
      "with recursive r(n) as (select 1 union all select n + 1 from r where n < 3) select * from r",
      "select * from t where a in (select a from t)",
      "select * from t, lateral (select a + 1 as c)",
      "select * from range(3)",
      "select * from generate_series(1, 3), unnest([1, 2])",
      "select * from json_each('{\"a\": 1}')",
      "select * from (values (1), (2)) v(x)",
      "summarize t",
      "show tables",
    ]) {
      const ast = await assertOneSelect(conn, sql, { profile: "serve" });
      expect(ast.node).toBeDefined();
    }
  });

  test("denies DuckDB's built-in views, which need no parentheses", async () => {
    for (const [sql, name] of [
      ["select database_name, path from duckdb_databases", "duckdb_databases"],
      ["select file from pragma_database_list", "pragma_database_list"],
      ["select name, setting from pg_settings", "pg_settings"],
      ["select * from pg_catalog.pg_settings", "pg_settings"],
      ["select message from duckdb_logs where type = 'QueryLog'", "duckdb_logs"],
      ["select * from information_schema.tables", "tables"],
      ["select * from sqlite_master", "sqlite_master"],
      ["select * from system.main.duckdb_databases", "duckdb_databases"],
      ["select * from Duckdb_Databases", "Duckdb_Databases"],
      ['select * from "DUCKDB_DATABASES"', "DUCKDB_DATABASES"],
      ["select * from t union all select 1, path from duckdb_databases", "duckdb_databases"],
      ["select (select path from duckdb_databases limit 1)", "duckdb_databases"],
      ["select * from t, lateral (select path from duckdb_databases)", "duckdb_databases"],
      ["describe duckdb_databases", "duckdb_databases"],
      ["summarize pg_settings", "pg_settings"],
      // A CTE of the same name must not open the door to the view in another scope.
      ["with duckdb_databases as (select 1 as path) select * from (select * from duckdb_databases), (from duckdb_databases)", "duckdb_databases"],
      ["select * from (with pg_settings as (select 1) select * from pg_settings), pg_settings", "pg_settings"],
      // A CTE is in scope in its own query only: another query naming it reaches the catalog.
      ["select * from (with x as (select 1 as a) select * from x), x", "x"],
      ["with a as (select * from x), x as (select 1 as a) select * from a", "x"],
    ] as const) {
      const e = await code(sql, { profile: "serve" });
      expect([sql, e.code]).toEqual([sql, "QUERY_PATH_DENIED"]);
      expect(e.message.toLowerCase()).toContain(name.toLowerCase());
    }
  });

  test("denies other schemas, other catalogs and files named as tables", async () => {
    await conn.run("CREATE SCHEMA IF NOT EXISTS _croft");
    await conn.run("CREATE TABLE IF NOT EXISTS _croft.meta (key VARCHAR, value VARCHAR)");
    for (const sql of [
      "select * from _croft.meta",
      "select * from temp.main.t",
      "select * from 'files/a.csv'",
      "select * from \"x.parquet\"",
      "describe 'files/a.csv'",
    ]) {
      expect([sql, (await code(sql, { profile: "serve" })).code]).toEqual([sql, "QUERY_PATH_DENIED"]);
    }
  });

  test("denies every table function outside the harmless few, however it is spelled or nested", async () => {
    for (const [sql, name] of [
      ["select * from json_execute_serialized_sql(json_serialize_sql('select path from duckdb_databases()'))", "json_execute_serialized_sql"],
      ["select * from enable_logging()", "enable_logging"],
      ["select * from duckdb_logs()", "duckdb_logs"],
      ["select * from duckdb_log_contexts()", "duckdb_log_contexts"],
      ["select * from duckdb_logs_parsed('QueryLog')", "duckdb_logs_parsed"],
      ["select * from pragma_table_info('t')", "pragma_table_info"],
      ["select * from pragma_version()", "pragma_version"],
      ["select * from duckdb_temporary_files()", "duckdb_temporary_files"],
      ["select * from query_table('t')", "query_table"],
      ["select * from histogram(t, a)", "histogram"],
      ['select * from "READ_BLOB"(\'x\')', "read_blob"],
      ["select * from system.main.read_blob('x')", "read_blob"],
      ["select * from t, lateral read_text('x')", "read_text"],
      ["with x as (select 1) select * from x, (select * from checkpoint())", "checkpoint"],
    ] as const) {
      const e = await code(sql, { profile: "serve" });
      expect([sql, e.code]).toEqual([sql, "QUERY_PATH_DENIED"]);
      expect(e.message.toLowerCase()).toContain(`${name}()`);
    }
  });

  test("denies scalar functions that reveal settings or hold a worker", async () => {
    for (const [sql, name] of [
      ["select current_setting('allowed_directories')", "current_setting"],
      ["select getvariable('x')", "getvariable"],
      ["select sleep_ms(100000)", "sleep_ms"],
      ["select * from t where a = (select current_setting('threads')::INTEGER)", "current_setting"],
    ] as const) {
      const e = await code(sql, { profile: "serve" });
      expect(e.code).toBe("QUERY_PATH_DENIED");
      expect(e.message).toContain(`${name}()`);
    }
  });

  test("still applies the one-SELECT rule first", async () => {
    expect((await code("copy t to 'x.csv'", { profile: "serve" })).code).toBe("QUERY_NOT_SELECT");
  });
});

describe("every profile: functions with side effects or SQL the gate cannot see", () => {
  test("are refused, however they are spelled or nested", async () => {
    for (const [sql, name] of [
      ["select * from enable_logging()", "enable_logging"],
      ["select * from enable_logging(storage = 'file', storage_path = '/tmp')", "enable_logging"],
      ["select * from disable_logging()", "disable_logging"],
      ["select * from truncate_duckdb_logs()", "truncate_duckdb_logs"],
      ["select * from enable_profiling()", "enable_profiling"],
      ["select * from disable_profiling()", "disable_profiling"],
      ["select * from enable_peg_parser()", "enable_peg_parser"],
      ["select * from disable_peg_parser()", "disable_peg_parser"],
      ["select * from checkpoint()", "checkpoint"],
      ["select * from force_checkpoint()", "force_checkpoint"],
      ["select * from query('select 1')", "query"],
      ["select * from query_table('t')", "query_table"],
      ["select * from json_execute_serialized_sql(json_serialize_sql('select 1'))", "json_execute_serialized_sql"],
      ["select * from arrow_scan(0, 0, 0)", "arrow_scan"],
      ["select write_log('x')", "write_log"],
      ['select * from "CHECKPOINT"()', "checkpoint"],
      ["select * from CheckPoint()", "checkpoint"],
      ["select * from system.main.checkpoint()", "checkpoint"],
      ["with x as (select * from checkpoint()) select * from x", "checkpoint"],
      ["select * from t where a in (select 1 from force_checkpoint())", "force_checkpoint"],
      ["select * from t, lateral (select * from enable_logging())", "enable_logging"],
      ["select (select count(*) from query('select 1'))", "query"],
      ["summarize select * from checkpoint()", "checkpoint"],
      ["select * from t union all select 1, 'x' from enable_profiling()", "enable_profiling"],
    ] as const) {
      const e = await code(sql);
      expect([sql, e.code]).toEqual([sql, "QUERY_NOT_SELECT"]);
      expect(e.message.toLowerCase()).toContain(`${name}()`);
    }
    expect((await code("select * from checkpoint()", { notSelectCode: "SQL_NOT_SELECT" })).code).toBe("SQL_NOT_SELECT");
  });

  test("table functions DuckDB does not ship (user table macros) are refused too", async () => {
    await conn.run("CREATE OR REPLACE MACRO sneaky() AS TABLE SELECT * FROM checkpoint()");
    const e = await code("select * from sneaky()");
    expect(e.code).toBe("QUERY_NOT_SELECT");
    expect(e.message).toContain("sneaky()");
  });

  test("every table function and table macro DuckDB ships is classified", async () => {
    const reader = await conn.runAndReadAll("SELECT DISTINCT function_name FROM duckdb_functions() WHERE function_type IN ('table', 'table_macro') AND internal ORDER BY 1");
    const names = reader.getRowsJS().map((r) => String(r[0]));
    const unclassified = names.filter((n) => !TABLE_FUNCTIONS.has(n));
    expect(unclassified).toEqual([]);
  });

  test("enable_logging would write files and change the instance: it never runs", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS a"] });
    const inst = await DuckDBInstance.create(p.database, instanceConfig("read_only"));
    const q = await connect(inst, { profile: "query", timezone: "UTC", root: p.root }, `gate-log-${p.root}`);
    try {
      const sql = `SELECT * FROM enable_logging(storage = 'file', storage_path = '${join(p.root, "files")}')`;
      let accepted = false;
      try {
        await assertOneSelect(q, sql);
        accepted = true;
        await q.runAndReadAll(sql);
        await q.runAndReadAll("SELECT count(*) FROM t");
      } catch {}
      expect(accepted).toBe(false);
      expect(readdirSync(join(p.root, "files"))).toEqual([]);
    } finally {
      q.disconnectSync();
      inst.closeSync();
    }
  });
});

describe("file paths", () => {
  // A project whose files/ holds a CSV plus every trick that reaches past it: a symlink to .env, a symlink to
  // the project folder, and a hard link to the warehouse itself.
  let p: TempProject;
  let inst: DuckDBInstance;
  let q: DuckDBConnection;
  beforeAll(async () => {
    p = await makeProject({ sub: "proj", seed: ["CREATE TABLE t AS SELECT 1 AS a, 'files/a.csv' AS p"] });
    writeFileSync(join(p.root, "files", "a.csv"), "x\n1\n");
    writeFileSync(join(p.root, ".env"), "SECRET=hunter2\n");
    writeFileSync(join(p.root, "..", "secret.txt"), "outside\n");
    symlinkSync(join(p.root, ".env"), join(p.root, "files", "leak.csv"));
    symlinkSync(p.root, join(p.root, "files", "up"));
    linkSync(p.database, join(p.root, "files", "hard.bin"));
    inst = await DuckDBInstance.create(p.database, instanceConfig("read_only"));
    q = await connect(inst, { profile: "query", timezone: "UTC", root: p.root }, `gate-paths-${p.root}`);
  });
  afterAll(() => {
    q.disconnectSync();
    inst.closeSync();
  });

  const denied = async (sql: string, o?: GateOptions) => inDir(p.root, async () => {
    const e = await code(sql, o, q);
    expect([sql, e.code]).toEqual([sql, "QUERY_PATH_DENIED"]);
    return e;
  });

  test("files under files/ stay readable, by function, list, glob and as a table name", async () => {
    await inDir(p.root, async () => {
      for (const sql of [
        "select * from read_csv('files/a.csv')",
        `select * from read_csv('${join(p.root, "files", "a.csv")}')`,
        "select * from read_csv(['files/a.csv', 'files/a.csv'])",
        "select * from read_csv('files/a*.csv')",
        "select * from read_csv('files/a.csv', header = true)",
        "select * from 'files/a.csv'",
        "select * from glob('files/a*')",
        "describe 'files/a.csv'",
        "select * from histogram('files/a.csv', x)",
        "select * from read_csv('files/missing.csv')", // DuckDB reports the missing file itself
        "select * from t, duckdb_tables()",
      ]) {
        await assertOneSelect(q, sql);
        if (!sql.includes("missing")) await q.runAndReadAll(sql);
      }
    });
  });

  test("the open database file is never readable, however it is named", async () => {
    const e = await denied(`select octet_length(content) from read_blob('${p.database}')`);
    expect(e.message).toContain("warehouse.duckdb");
    for (const sql of [
      "select * from read_blob('warehouse.duckdb')",
      "select * from read_blob('./warehouse.duckdb')",
      "select * from read_blob('files/../warehouse.duckdb')",
      "select * from read_blob('files/up/warehouse.duckdb')",          // through a symlinked folder
      "select * from read_blob('files/hard.bin')",                      // a hard link: same inode
      "select * from read_blob('files/h*.bin')",                        // a glob that matches it
      "select * from read_blob(['files/a.csv', 'files/hard.bin'])",
      `select * from read_blob('file://${p.database}')`,
      `select * from read_blob('file://localhost${p.database}')`,
      `select * from read_blob('${p.database}.wal')`,
      `select * from read_blob('${p.database}.tmp/spill.bin')`,
      "select * from read_text('files/up/warehouse.duckdb')",
      "select * from sniff_csv('files/hard.bin')",
      "select * from parquet_metadata('files/hard.bin')",
      "select * from read_duckdb('files/up/warehouse.duckdb', table_name := 't')",
      "select * from 'files/up/warehouse.duckdb'",                      // a replacement scan attaches it
      "select * from \"files/up/warehouse.duckdb\"",
      "describe 'files/up/warehouse.duckdb'",
      "summarize 'files/up/warehouse.duckdb'",
      "select * from histogram('files/up/warehouse.duckdb', a)",
      "with x as (select * from read_blob('files/hard.bin')) select * from x",
      "select * from t where a in (select size from read_blob('files/hard.bin'))",
      "select (select size from read_blob('files/hard.bin'))",
      "select * from t, lateral (select * from read_blob('files/hard.bin'))",
    ]) await denied(sql);
    const upper = join(p.root, "WAREHOUSE.DUCKDB");
    if (existsSync(upper)) await denied(`select * from read_blob('${upper}')`); // case-insensitive file systems
  });

  test("paths must be string literals, so the gate can check them", async () => {
    for (const sql of [
      "select * from read_csv('files/' || 'a.csv')",
      "select * from read_csv($1)",
      "select * from read_csv(concat('files/', 'a.csv'))",
      "select * from read_csv('files/a.csv'::VARCHAR)",
      "select * from read_csv((select 'files/a.csv'))",
      "select * from t, lateral read_csv(t.p)",
      "select * from read_csv(['files/a.csv', 'files/' || 'a.csv'])",
      "select * from histogram((select 't'), a)",
      "select * from histogram(col_name := a, source := 'files/' || 'a.csv')",
      "select * from histogram(col_name := a)",
    ]) {
      const e = await denied(sql);
      expect(e.problem.hint).toContain("string");
    }
  });

  test("symlinks, .. and ~ cannot reach past files/", async () => {
    for (const sql of [
      "select * from read_text('files/leak.csv')",
      "select * from read_text('files/up/.env')",
      "select * from read_text('files/up/../secret.txt')",
      "select * from read_text('files/*')",
      "select * from read_text('.env')",
      "select * from read_text('~/.ssh/id_rsa')",
      "select * from read_text('/etc/hosts')",
      "select * from 'files/leak.csv'",
      "select * from histogram('files/leak.csv', x)",
      "select * from histogram(\"files/leak.csv\", x)",
      "select * from histogram(x, source := 'files/leak.csv')",
      "select * from histogram(col_name := x, source := 'files/leak.csv')",
      "select * from glob('files/up/*')",
    ]) await denied(sql);
  });

  test("URLs are refused: croft reads local files only", async () => {
    for (const sql of [
      "select * from read_csv('https://example.com/x.csv')",
      "select * from read_parquet('s3://bucket/x.parquet')",
      "select * from 'http://example.com/x.csv'",
      "select * from read_text('FILE:///etc/hosts')",
    ]) await denied(sql);
  });

  test("callers can protect more paths, such as the state folder", async () => {
    mkdirSync(join(p.root, "files", "state"), { recursive: true });
    writeFileSync(join(p.root, "files", "state", "serve.json"), "{}");
    await inDir(p.root, () => assertOneSelect(q, "select * from read_text('files/state/serve.json')"));
    await denied("select * from read_text('files/state/serve.json')", { protect: [join(p.root, "files", "state")] });
    await denied("select * from read_text('files/a.csv')", { protect: [join(p.root, "files", "a.csv")] });
  });

  test("serve refuses every path, even one under files/", async () => {
    await denied("select * from read_csv('files/a.csv')", { profile: "serve" });
    await denied("select * from 'files/a.csv'", { profile: "serve" });
  });
});

describe("the warehouse lock (DESIGN.md §5, hazard 3)", () => {
  test("a gated SELECT inside a write lease cannot open the file a second time and drop the lock", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS a"] });
    await seed(p.database, ["CHECKPOINT"]);
    const w = openWarehouse({ path: p.database, mode: "read_write", timezone: "UTC", root: p.root, stateDir: p.stateDir, isTTY: false, register: false });
    const runId = "r_0101_0000_aaaa";
    const accepted: string[] = [];
    let other = "";
    try {
      await w.write("orders", async (tx) => {
        await inDir(p.root, async () => {
          for (const sql of [
            "SELECT octet_length(content) > 0 AS ok FROM read_blob('warehouse.duckdb')",
            `SELECT octet_length(content) > 0 AS ok FROM read_blob('${p.database}')`,
          ]) {
            try {
              await assertOneSelect(tx.connection, sql, { notSelectCode: "SQL_NOT_SELECT" });
              accepted.push(sql);
              await tx.all(sql); // what an SQL asset, a check or ctx.query would do next
            } catch (e) {
              if (!(e instanceof CroftError)) throw e;
              expect(e.code).toBe("QUERY_PATH_DENIED");
            }
          }
        });
        // Another process must still be locked out while this transaction is open.
        const holder = spawnHolder(p.database, 0, "INSERT INTO t VALUES (999)");
        other = await Promise.race([holder.exited.then((c) => `blocked (exit ${c})`), holder.waitFor("held", 15_000).then(() => "OPENED THE WAREHOUSE")]);
        holder.proc.kill("SIGKILL");
        await tx.exec("INSERT INTO t VALUES (2)");
      }, { runId });
    } finally {
      await w.close();
    }
    expect(accepted).toEqual([]);
    expect(other).toStartWith("blocked");
  });
});

test("the AST is returned for dependency extraction", async () => {
  const ast = await assertOneSelect(conn, "select a from t");
  expect(JSON.stringify(ast)).toContain('"table_name":"t"');
  expect(findFunctions(ast, () => true)).toBeNull();
  expect(findFunctions(await assertOneSelect(conn, "select lower(b) from t"), (n) => n === "lower")).toEqual({ name: "lower", location: 7 });
});

test("lineColumn", () => {
  expect(lineColumn("abc", 0)).toEqual({ line: 1, column: 1 });
  expect(lineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  expect(lineColumn("a", 99)).toEqual({ line: 1, column: 2 });
});

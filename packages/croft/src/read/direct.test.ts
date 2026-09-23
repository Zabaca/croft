import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { closeAllWarehouses, openWarehouse } from "../db/warehouse.ts";
import { type DirectTimings, directQuery, inProcessWarehouse, isOpen, openCount, openUsers } from "./direct.ts";
import type { SelectRequest } from "./wire.ts";
import { cleanup, makeProject, seed, sleep, spawnHolder, spawnIdle, writeIntent } from "./testkit.ts";

afterAll(async () => {
  await closeAllWarehouses();
  cleanup();
});

const FAST: DirectTimings = { intentWaitMs: 400, lockRetryMs: 600, pollMs: 20 };
const req = (sql: string, params: unknown[] = [], limit = 10_000): SelectRequest => ({ sql, params, limit });

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const SALES = [
  "CREATE TABLE sales (id INTEGER, amount DECIMAL(10,2), big BIGINT, sold_at TIMESTAMPTZ, day DATE, tags VARCHAR[], meta JSON)",
  `INSERT INTO sales VALUES
    (1, 12.50, 9007199254740993, TIMESTAMPTZ '2026-01-15 18:30:00Z', DATE '2026-01-15', ['a','b'], '{"k": 1}'),
    (2, 3.00, 7, TIMESTAMPTZ '2026-07-01 06:00:00Z', DATE '2026-07-01', [], NULL)`,
];

describe("direct mode", () => {
  test("reads rows with the §4.3 json rendering in the project time zone", async () => {
    const p = await makeProject({ seed: SALES });
    const rows = await directQuery(p.project, req("SELECT * FROM sales ORDER BY id"), FAST);
    expect(rows).toEqual([
      { id: 1, amount: "12.50", big: "9007199254740993", sold_at: "2026-01-15T10:30:00-08:00", day: "2026-01-15", tags: ["a", "b"], meta: { k: 1 } },
      { id: 2, amount: "3.00", big: 7, sold_at: "2026-06-30T23:00:00-07:00", day: "2026-07-01", tags: [], meta: null },
    ]);
  });

  test("binds params to $1, $2 like the warehouse does (Dates as instants, objects as JSON)", async () => {
    const p = await makeProject({ seed: SALES });
    const rows = await directQuery(p.project, req("SELECT id, $2::JSON AS j, $3::TIMESTAMPTZ AS t FROM sales WHERE id = $1",
      [2, { a: [1, 2] }, new Date("2026-01-01T00:00:00Z")]), FAST);
    expect(rows).toEqual([{ id: 2, j: { a: [1, 2] }, t: "2025-12-31T16:00:00-08:00" }]);
  });

  test("closes the file after each query, so a writer in another process gets it at once", async () => {
    const p = await makeProject({ seed: SALES });
    await directQuery(p.project, req("SELECT count(*) AS n FROM sales"), FAST);
    expect(isOpen(p.database)).toBe(false);
    const writer = spawnHolder(p.database, 0, "INSERT INTO sales (id) VALUES (3)");
    await writer.waitFor("released");
    expect(await directQuery(p.project, req("SELECT count(*)::INTEGER AS n FROM sales"), FAST)).toEqual([{ n: 3 }]);
  });

  test("concurrent queries share one instance and the last one closes it", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT range AS i FROM range(200000)"] });
    const before = openCount(p.database);
    const running = [1, 2, 3, 4].map((k) => directQuery(p.project, req(`SELECT sum(i)::BIGINT AS s, ${k} AS k FROM t`), FAST));
    const results = await Promise.all(running);
    expect(results.map((r) => r[0]!.k)).toEqual([1, 2, 3, 4]);
    expect(results.every((r) => r[0]!.s === 19999900000)).toBe(true);
    expect(openCount(p.database) - before).toBe(1); // one open served all four
    expect(openUsers(p.database)).toBe(0);
    expect(isOpen(p.database)).toBe(false);
    // The next query opens the file again.
    await directQuery(p.project, req("SELECT 1 AS x"), FAST);
    expect(openCount(p.database) - before).toBe(2);
  });

  test("DB_NOT_FOUND before the first run", async () => {
    const p = await makeProject();
    const e = await rejection(directQuery(p.project, req("SELECT 1"), FAST));
    expect(e.code).toBe("DB_NOT_FOUND");
    expect(e.problem.hint).toContain("croft run");
  });

  test("the single-SELECT gate: writes, two statements and syntax errors are refused", async () => {
    const p = await makeProject({ seed: SALES });
    expect((await rejection(directQuery(p.project, req("DELETE FROM sales"), FAST))).code).toBe("QUERY_NOT_SELECT");
    expect((await rejection(directQuery(p.project, req("SELECT 1; SELECT 2"), FAST))).code).toBe("SQL_NOT_ONE_STATEMENT");
    expect((await rejection(directQuery(p.project, req("SELEC 1"), FAST))).code).toBe("SQL_SYNTAX");
    expect((await rejection(directQuery(p.project, req("COPY sales TO 'x.csv'"), FAST))).code).toBe("QUERY_NOT_SELECT");
    // DESCRIBE is allowed, as for croft query.
    const cols = await directQuery(p.project, req("DESCRIBE sales"), FAST);
    expect(cols.map((c) => c.column_name)).toEqual(["id", "amount", "big", "sold_at", "day", "tags", "meta"]);
  });

  test("DuckDB errors carry codes: unknown table and column, and a runtime error", async () => {
    const p = await makeProject({ seed: SALES });
    expect((await rejection(directQuery(p.project, req("SELECT * FROM nope"), FAST))).code).toBe("UNKNOWN_TABLE");
    const col = await rejection(directQuery(p.project, req("SELECT creatd_at FROM sales"), FAST));
    expect(col.code).toBe("UNKNOWN_COLUMN");
    expect(col.message).toContain("creatd_at");
    const conv = await rejection(directQuery(p.project, req("SELECT 'abc'::INTEGER AS x"), FAST));
    expect(conv.code).toBe("QUERY_FAILED");
    expect(conv.problem.details?.duckdbErrorType).toBe("Conversion");
  });

  test("the query sandbox: files/ is readable, anything else is QUERY_PATH_DENIED", async () => {
    const p = await makeProject({ seed: SALES });
    writeFileSync(join(p.root, "files", "x.csv"), "a,b\n1,2\n");
    writeFileSync(join(p.root, ".env"), "SECRET=hunter2\n");
    expect(await directQuery(p.project, req(`SELECT * FROM read_csv('${join(p.root, "files", "x.csv")}')`), FAST)).toEqual([{ a: 1, b: 2 }]);
    const e = await rejection(directQuery(p.project, req(`SELECT * FROM read_text('${join(p.root, ".env")}')`), FAST));
    expect(e.code).toBe("QUERY_PATH_DENIED");
  });

  test("QUERY_TOO_MANY_ROWS above the limit, never a truncated result; exactly the limit is fine", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT range AS i FROM range(10001)"] });
    const e = await rejection(directQuery(p.project, req("SELECT * FROM t"), FAST));
    expect(e.code).toBe("QUERY_TOO_MANY_ROWS");
    expect(e.problem.details?.limit).toBe(10_000);
    expect((await directQuery(p.project, req("SELECT * FROM t LIMIT 10000"), FAST)).length).toBe(10_000);
    expect((await directQuery(p.project, req("SELECT * FROM t WHERE i < 5", [], 5), FAST)).length).toBe(5);
    expect((await rejection(directQuery(p.project, req("SELECT * FROM t WHERE i < 6", [], 5), FAST))).code).toBe("QUERY_TOO_MANY_ROWS");
    expect(isOpen(p.database)).toBe(false);
  });

  test("refuses a database written by a newer croft (DB_NEWER_FORMAT)", async () => {
    const p = await makeProject({ seed: [
      "CREATE SCHEMA _croft", "CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)",
      "INSERT INTO _croft.meta VALUES ('format_version', '999')", "CREATE TABLE t AS SELECT 1 AS a",
    ] });
    expect((await rejection(directQuery(p.project, req("SELECT * FROM t"), FAST))).code).toBe("DB_NEWER_FORMAT");
  });
});

describe("write-intent handshake", () => {
  test("waits up to intentWaitMs while a live intent exists, then reads anyway", async () => {
    const p = await makeProject({ seed: SALES });
    const writer = spawnIdle();
    await writer.waitFor("up");
    writeIntent(p.stateDir, writer.pid);
    const t0 = Date.now();
    const rows = await directQuery(p.project, req("SELECT count(*)::INTEGER AS n FROM sales"), FAST);
    const waited = Date.now() - t0;
    expect(rows).toEqual([{ n: 2 }]);
    expect(waited).toBeGreaterThanOrEqual(FAST.intentWaitMs - 20);
    expect(waited).toBeLessThan(FAST.intentWaitMs + 1500);
  });

  test("opens as soon as the intent goes away", async () => {
    const p = await makeProject({ seed: SALES });
    const writer = spawnIdle();
    await writer.waitFor("up");
    const file = writeIntent(p.stateDir, writer.pid);
    setTimeout(() => rmSync(file), 120);
    const t0 = Date.now();
    await directQuery(p.project, req("SELECT 1 AS x"), { ...FAST, intentWaitMs: 3000 });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(1500);
  });

  test("an intent whose process is gone does not delay the query", async () => {
    const p = await makeProject({ seed: SALES });
    const ghost = spawnIdle();
    await ghost.waitFor("up");
    writeIntent(p.stateDir, ghost.pid);
    ghost.proc.kill("SIGKILL");
    await ghost.exited;
    const t0 = Date.now();
    await directQuery(p.project, req("SELECT 1 AS x"), { ...FAST, intentWaitMs: 3000 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("a query arriving while the file is open and a writer announced itself waits for the close", async () => {
    const p = await makeProject({ seed: ["CREATE TABLE t AS SELECT 1 AS a"] });
    const writer = spawnIdle();
    await writer.waitFor("up");
    const order: string[] = [];
    // About half a second of DuckDB work keeps the file open.
    const slow = directQuery(p.project, req("SELECT sum(hash(range))::VARCHAR AS h FROM range(100000000)"), FAST).then((r) => (order.push("slow"), r));
    while (openUsers(p.database) === 0) await sleep(1);
    writeIntent(p.stateDir, writer.pid);
    const t0 = Date.now();
    const next = await directQuery(p.project, req("SELECT 1 AS x"), FAST).then((r) => (order.push("next"), r));
    expect(next).toEqual([{ x: 1 }]);
    await slow;
    // It did not join the open instance: it waited for the close, then went through the intent wait.
    expect(order).toEqual(["slow", "next"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.intentWaitMs - 20);
  });
});

describe("lock conflicts", () => {
  test("retries while another process writes, then sees its commit", async () => {
    const p = await makeProject({ seed: SALES });
    const writer = spawnHolder(p.database, 700, "INSERT INTO sales (id) VALUES (42)");
    await writer.waitFor("held");
    const t0 = Date.now();
    const rows = await directQuery(p.project, req("SELECT max(id) AS m FROM sales"), { ...FAST, lockRetryMs: 5000 });
    const waited = Date.now() - t0;
    expect(rows).toEqual([{ m: 42 }]);
    expect(waited).toBeGreaterThanOrEqual(400);
    expect(waited).toBeLessThan(4000);
  });

  test("DB_HELD_BY_OTHER_PROGRAM names the holder after lockRetryMs", async () => {
    const p = await makeProject({ seed: SALES });
    const holder = spawnHolder(p.database, 20_000);
    await holder.waitFor("held");
    const t0 = Date.now();
    const e = await rejection(directQuery(p.project, req("SELECT 1"), FAST));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.lockRetryMs - 20);
    expect(e.code).toBe("DB_HELD_BY_OTHER_PROGRAM");
    expect(e.message).toContain(`PID ${holder.pid}`);
    expect(e.problem.details?.holder).toMatchObject({ pid: holder.pid });
    expect(e.problem.hint).toContain("croft serve");
    expect(isOpen(p.database)).toBe(false);
  });

  test("DB_BUSY when the holder is a croft writer with a live intent", async () => {
    const p = await makeProject({ seed: SALES });
    const holder = spawnHolder(p.database, 20_000);
    await holder.waitFor("held");
    writeIntent(p.stateDir, holder.pid, "r_0923_1200_abcd");
    const e = await rejection(directQuery(p.project, req("SELECT 1"), { ...FAST, intentWaitMs: 50 }));
    expect(e.code).toBe("DB_BUSY");
    expect(e.message).toContain("r_0923_1200_abcd");
    expect(e.problem.retryable).toBe(true);
  });
});

describe("a croft runtime in the same process", () => {
  test("runs through its read lease instead of opening a second instance", async () => {
    const p = await makeProject({ seed: SALES });
    const w = openWarehouse({ path: p.database, mode: "read_write", timezone: p.project.timezone, root: p.root, stateDir: p.stateDir, isTTY: false });
    expect(inProcessWarehouse(p.database)).toBe(w);
    const purposes: string[] = [];
    const read = w.read.bind(w);
    w.read = ((fn, o) => {
      purposes.push(o?.purpose ?? "");
      return read(fn, o);
    }) as typeof w.read;
    await w.write("seed more", async (tx) => tx.exec("INSERT INTO sales (id) VALUES (7)"), { runId: "r_test" });
    const rows = await directQuery(p.project, req("SELECT id FROM sales ORDER BY id"), FAST);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 7 }]);
    expect(purposes).toEqual(["@zabaca/croft/read"]);
    expect(isOpen(p.database)).toBe(false); // this module never opened the file itself
    await closeAllWarehouses();
  });

  test("a runtime that owns a different file is not used", async () => {
    const a = await makeProject({ seed: ["CREATE TABLE only_a AS SELECT 1 AS x"] });
    const b = await makeProject({ seed: ["CREATE TABLE only_b AS SELECT 2 AS x"] });
    openWarehouse({ path: a.database, mode: "read_write", timezone: "UTC", root: a.root, stateDir: a.stateDir, isTTY: false });
    expect(inProcessWarehouse(b.database)).toBeNull();
    expect(await directQuery(b.project, req("SELECT x FROM only_b"), FAST)).toEqual([{ x: 2 }]);
    await closeAllWarehouses();
  });

  test("seeding helper sanity: a closed private instance leaves the file free", async () => {
    const p = await makeProject({ seed: SALES });
    await seed(p.database, ["INSERT INTO sales (id) VALUES (5)"]);
    expect(await directQuery(p.project, req("SELECT count(*)::INTEGER AS n FROM sales"), FAST)).toEqual([{ n: 3 }]);
  });
});

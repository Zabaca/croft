// The bookkeeping adapters (DESIGN.md §5 "Where state lives", D-L1; option 07, slice 1). The same sequence of writes
// goes through the file adapter, the log adapter on a plain DuckDB file and the log adapter in a local lake (a SQLite
// catalog and a local folder, no Postgres), and every table reads the same through `_croft.<table>` in all three.
import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";
import { bookkeepingOf, type BookkeepingKind, STATE_SPECS, type StateTableName } from "./bookkeeping.ts";
import { columnNames, sqlOver } from "./bookkeeping-testkit.ts";
import { connect, instanceConfig } from "./connect.ts";
import { extensionsReady } from "./extension-dir-testkit.ts";
import { ensureState } from "./state.ts";
import { tableBatch } from "../load/table-batch.ts";
import { writeBatch } from "../load/write.ts";
import { cleanupProjects, cli, makeProject } from "../run/testkit.ts";
import { closeAllWarehouses, LeaseSql, openWarehouse } from "./warehouse.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  await closeAllWarehouses();
  cleanupProjects();
  for (const f of cleanup.reverse()) await f();
});

const lakeExt = extensionsReady(["sqlite", "ducklake"]);
if (!lakeExt.ready) console.warn(`[bookkeeping.test] SKIPPING the local-lake tests: ${lakeExt.skipReason}`);

/** One place bookkeeping can live, and how to run a transaction against it. */
interface Target {
  name: string;
  kind: BookkeepingKind;
  /** A transaction: ensureState first, then `fn`; committed when it returns, rolled back when it throws. */
  tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  /** The latest rows, ordered by their key. */
  read(table: StateTableName): Promise<unknown[]>;
}

/** Rows as plain JSON: bigints as numbers, instants as ISO text with the same digits whichever way they were rendered. */
const norm = (rows: unknown[]): unknown[] => JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  (_k, v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(v).toISOString() : v));
const orderOf = (table: StateTableName) => STATE_SPECS[table].key.join(", ");

function fileTarget(kind: BookkeepingKind): Target {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-bk-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".croft"));
  const w = openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
  return {
    name: kind === "file" ? "the file adapter" : "the log adapter on a plain file", kind,
    tx: (fn) => w.write("bk", async (tx) => { await ensureState(tx, { bookkeeping: kind }); return fn(tx); }, { runId: "r" }),
    read: async (t) => norm(await w.read((db) => db.all(`SELECT * FROM _croft.${t} ORDER BY ${orderOf(t)}`), { purpose: "t" })),
  };
}

async function lakeTarget(): Promise<Target> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-bk-lake-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "secrets"));
  const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
  const conn: DuckDBConnection = await connect(instance, {
    profile: "serve", timezone: "UTC",
    mode: { kind: "lake-test", extensionDir: lakeExt.dir, secretDir: join(root, "secrets"), lake: { catalog: { kind: "sqlite", path: join(root, "meta.sqlite") }, dataPath: join(root, "data") + "/", access: "write" } },
  }, ":memory:bk-lake");
  cleanup.push(() => { conn.disconnectSync(); instance.closeSync(); });
  await conn.run("USE lake");
  const sql = new LeaseSql(conn, { mode: "ts", timezone: "UTC" }, null);
  return {
    name: "the log adapter in a local lake", kind: "log",
    async tx(fn) {
      await conn.run("BEGIN TRANSACTION");
      try {
        await ensureState(sql, { bookkeeping: "log" });
        const out = await fn(sql);
        await conn.run("COMMIT");
        return out;
      } catch (e) {
        try { await conn.run("ROLLBACK"); } catch { /* already gone */ }
        throw e;
      }
    },
    read: async (t) => norm(await sql.all(`SELECT * FROM _croft.${t} ORDER BY ${orderOf(t)}`)),
  };
}

const tables = Object.keys(STATE_SPECS).filter((t) => t !== "meta") as StateTableName[];
const snapshot = async (t: Target) => Object.fromEntries(await Promise.all(tables.map(async (n) => [n, await t.read(n)])));

/** A row naming every column of the table, as croft's own writes do: a column left out would keep its value in a file's INSERT OR REPLACE. */
const full = (table: StateTableName, given: Record<string, string>): Record<string, string> =>
  Object.fromEntries(columnNames(table).map((c) => [c, given[c] ?? "NULL"]));

const T1 = "2026-09-20 10:00:00+00";
const T2 = "2026-09-21 10:00:00+00";

/** The writes croft makes to one asset's bookkeeping over its life, step by step, each a transaction. */
const STEPS: [string, (tx: Sql) => Promise<void>][] = [
  ["first load: the asset, its columns, one write, an input position", async (tx) => {
    const bk = await bookkeepingOf(tx);
    await bk.upsert("assets", full("assets", { name: "$1", kind: "'ingest'", write_mode: "'merge'", key_columns: "CAST($2::JSON AS VARCHAR[])", cursor_value: "'c1'", row_count: "2", last_loaded_at: `'${T1}'::TIMESTAMPTZ` }), ["issues", '["id"]']);
    for (const c of ["id", "title"]) await bk.upsert("columns", full("columns", { asset: "'issues'", name: "$1", type: "'BIGINT'", pinned: "false", added_at: `'${T1}'::TIMESTAMPTZ` }), [c]);
    await bk.insert("writes", { asset: "'issues'", loaded_at: `'${T1}'::TIMESTAMPTZ`, run_id: "'r1'", mode: "'merge'", rows_in: "2", added: "2" });
    await bk.upsert("inputs", full("inputs", { asset: "'issues'", input: "'upstream'", seen_loaded_at: `'${T1}'::TIMESTAMPTZ` }));
    await bk.upsert("files", full("files", { asset: "'issues'", path: "'a.csv'", size: "10", loaded_at: `'${T1}'::TIMESTAMPTZ` }));
  }],
  ["one key written twice in one transaction (--from holds the cursor back)", async (tx) => {
    const bk = await bookkeepingOf(tx);
    await bk.upsert("assets", full("assets", { name: "'issues'", kind: "'ingest'", write_mode: "'merge'", cursor_value: "'c2'", row_count: "3", last_loaded_at: `'${T2}'::TIMESTAMPTZ` }));
    await bk.update("assets", { cursor_value: "$1" }, "name = $2", ["c1-held", "issues"]);
    await bk.insert("writes", { asset: "'issues'", loaded_at: `'${T2}'::TIMESTAMPTZ`, run_id: "'r2'", mode: "'merge'", rows_in: "1", added: "1", cursor_after: "'c2'" });
    await bk.update("writes", { cursor_after: "$1" }, "asset = $2 AND loaded_at = $3::TIMESTAMPTZ", ["c1-held", "issues", T2]);
  }],
  ["--rebuild: the asset's rows deleted, then written again, then its replaced time set", async (tx) => {
    const bk = await bookkeepingOf(tx);
    await bk.remove("assets", "name = $1", ["issues"]);
    for (const t of ["columns", "files", "inputs"] as const) await bk.remove(t, "asset = $1", ["issues"]);
    await bk.upsert("assets", full("assets", { name: "'issues'", kind: "'ingest'", write_mode: "'merge'", cursor_value: "'c3'", row_count: "5" }));
    await bk.upsert("columns", full("columns", { asset: "'issues'", name: "'id'", type: "'BIGINT'" }));
    await bk.update("assets", { last_replaced_at: "$1::TIMESTAMPTZ" }, "name = $2", [T2, "issues"]);
  }],
  ["rename: every key moves once; the old name is gone", async (tx) => {
    const bk = await bookkeepingOf(tx);
    for (const [t, c] of [["assets", "name"], ["columns", "asset"], ["inputs", "asset"], ["files", "asset"], ["writes", "asset"]] as const) await bk.rekey(t, c, "issues", "tickets");
    await bk.rekey("inputs", "input", "upstream", "source");
  }],
  ["a second asset reads the first", async (tx) => {
    const bk = await bookkeepingOf(tx);
    await bk.upsert("assets", full("assets", { name: "'report'", kind: "'sql'", write_mode: "'replace'", row_count: "1" }));
    await bk.upsert("inputs", full("inputs", { asset: "'report'", input: "'tickets'", seen_loaded_at: `'${T2}'::TIMESTAMPTZ` }));
  }],
  ["delete: the asset's rows are removed", async (tx) => {
    const bk = await bookkeepingOf(tx);
    await bk.remove("assets", "name = $1", ["tickets"]);
    for (const t of ["columns", "files", "inputs", "writes"] as const) await bk.remove(t, "asset = $1", ["tickets"]);
  }],
];

describe("every adapter gives the same latest rows for the same writes", () => {
  const targets: (() => Promise<Target>)[] = [
    async () => fileTarget("file"),
    async () => fileTarget("log"),
    ...(lakeExt.ready ? [lakeTarget] : []),
  ];

  test("step by step, the file, the log on a plain file and the log in a local lake read alike", async () => {
    const ts = await Promise.all(targets.map((make) => make()));
    for (const [what, step] of STEPS) {
      for (const t of ts) await t.tx(step);
      const [reference, ...others] = await Promise.all(ts.map(snapshot));
      for (const [i, other] of others.entries()) expect(other, `${ts[i + 1]!.name}: after ${what}`).toEqual(reference!);
    }
    // And the end state is the one the steps describe.
    const end = await snapshot(ts[0]!);
    expect(end).toMatchObject({ assets: [{ name: "report" }], columns: [], files: [], writes: [] });
    expect((end.inputs as { asset: string }[]).map((r) => r.asset)).toEqual(["report"]);
  });

  test("a key written twice in a transaction reads as its last write (--from holds the cursor back)", async () => {
    for (const t of await Promise.all(targets.map((make) => make()))) {
      await t.tx(STEPS[0]![1]);
      await t.tx(STEPS[1]![1]);
      expect(await t.read("assets"), t.name).toMatchObject([{ name: "issues", cursor_value: "c1-held", row_count: 3 }]);
      expect(await t.read("writes"), t.name).toMatchObject([{ cursor_after: null }, { cursor_after: "c1-held" }]);
    }
  });

  test("an asset deleted and written again in one transaction (--rebuild) reads as the new write, with its replaced time", async () => {
    for (const t of await Promise.all(targets.map((make) => make()))) {
      await t.tx(STEPS[0]![1]);
      await t.tx(STEPS[2]![1]);
      expect(await t.read("assets"), t.name).toMatchObject([{ name: "issues", cursor_value: "c3", row_count: 5, last_replaced_at: expect.any(String) }]);
      expect(await t.read("columns"), t.name).toMatchObject([{ asset: "issues", name: "id" }]);
      expect(await t.read("inputs"), t.name).toEqual([]);
    }
  });

  test("a key put back after it was removed (a restore) reads as the rows put back, newest last", async () => {
    for (const t of await Promise.all(targets.map((make) => make()))) {
      await t.tx(STEPS[0]![1]);
      const before = await t.read("assets");
      await t.tx(async (tx) => {
        const bk = await bookkeepingOf(tx);
        // What the trash holds: a plain table of the asset's rows, as croft copies them out.
        await tx.exec(`CREATE TEMP TABLE kept_assets AS SELECT * FROM _croft.assets WHERE name = 'issues'`);
        await tx.exec(`CREATE TEMP TABLE kept_columns AS SELECT * FROM _croft.columns WHERE asset = 'issues'`);
        await bk.remove("assets", "name = $1", ["issues"]);
        await bk.remove("columns", "asset = $1", ["issues"]);
        expect(await tx.all(`SELECT * FROM _croft.assets`), t.name).toEqual([]);
        // The rows come back with numbers above every other row's, so they are the newest.
        const top = bk.kind === "log" ? Number((await tx.all<{ n: number | bigint }>(`SELECT coalesce(max(seq), 0) AS n FROM _croft.assets_log`))[0]!.n) : 0;
        await bk.insertSelect("assets", `SELECT * FROM kept_assets`);
        await bk.insertSelect("columns", `SELECT * FROM kept_columns`);
        if (bk.kind === "log") {
          const now = await tx.all<{ seq: number | bigint }>(`SELECT seq FROM _croft.assets_log WHERE name = 'issues' ORDER BY seq DESC LIMIT 1`);
          expect(Number(now[0]!.seq)).toBeGreaterThan(top);
        }
        await tx.exec(`DROP TABLE kept_assets`);
        await tx.exec(`DROP TABLE kept_columns`);
      });
      expect(await t.read("assets"), t.name).toEqual(before);
      expect(await t.read("columns"), t.name).toHaveLength(2);
    }
  });

  test("an insert whose key is there already is refused: the file by its primary key, the log by its duplicate-key check", async () => {
    for (const t of await Promise.all(targets.map((make) => make()))) {
      await t.tx(STEPS[0]![1]);
      const dup = t.tx(async (tx) => (await bookkeepingOf(tx)).insert("writes", { asset: "'issues'", loaded_at: `'${T1}'::TIMESTAMPTZ`, run_id: "'again'" }));
      await expect(dup, t.name).rejects.toThrow();
      // The refused insert wrote nothing.
      expect(await t.read("writes"), t.name).toMatchObject([{ run_id: "r1" }]);
    }
  });

  test("a rekey onto a key the table has is refused, and writes nothing", async () => {
    for (const t of await Promise.all(targets.map((make) => make()))) {
      await t.tx(STEPS[0]![1]);
      await t.tx(async (tx) => (await bookkeepingOf(tx)).upsert("assets", full("assets", { name: "'tickets'", kind: "'sql'" })));
      await t.tx(async (tx) => {
        const bk = await bookkeepingOf(tx);
        await bk.upsert("columns", full("columns", { asset: "'tickets'", name: "'id'", type: "'BIGINT'" }));
      });
      const before = await snapshot(t);
      // issues has columns id and title; tickets has a column id: the rename would make two (tickets, id).
      await expect(t.tx(async (tx) => (await bookkeepingOf(tx)).rekey("columns", "asset", "issues", "tickets")), t.name).rejects.toThrow();
      await expect(t.tx(async (tx) => (await bookkeepingOf(tx)).rekey("assets", "name", "issues", "tickets")), t.name).rejects.toThrow();
      expect(await snapshot(t), t.name).toEqual(before);
    }
  });

  test("an insertSelect of a key the table has is refused, and writes nothing", async () => {
    for (const t of await Promise.all(targets.map((make) => make()))) {
      await t.tx(STEPS[0]![1]);
      const before = await snapshot(t);
      const again = t.tx(async (tx) => {
        await tx.exec(`CREATE TEMP TABLE kept AS SELECT * FROM _croft.columns WHERE asset = 'issues'`);
        await (await bookkeepingOf(tx)).insertSelect("columns", `SELECT * FROM kept`);
      });
      await expect(again, t.name).rejects.toThrow();
      expect(await snapshot(t), t.name).toEqual(before);
    }
  });

  test("an insertSelect that has a key twice is refused, not left to whichever row sorts last", async () => {
    for (const t of await Promise.all(targets.map((make) => make()))) {
      await t.tx(STEPS[0]![1]);
      const before = await snapshot(t);
      const twice = t.tx(async (tx) => {
        await tx.exec(`CREATE TEMP TABLE kept AS SELECT 'other' AS asset, 'id' AS name, 'BIGINT' AS type UNION ALL SELECT 'other', 'id', 'VARCHAR'`);
        await (await bookkeepingOf(tx)).insertSelect("columns", `SELECT * FROM kept`);
      });
      await expect(twice, t.name).rejects.toThrow();
      expect(await snapshot(t), t.name).toEqual(before);
    }
  });
});

describe("the log adapter", () => {
  test("its duplicate-key check names the key and the table, with a croft code", async () => {
    const t = fileTarget("log");
    await t.tx(STEPS[0]![1]);
    const e = await t.tx(async (tx) => (await bookkeepingOf(tx)).insert("writes", { asset: "'issues'", loaded_at: `'${T1}'::TIMESTAMPTZ` })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code).toBe("INTERNAL_ERROR");
    expect((e as CroftError).message).toContain("_croft.writes");
  });

  test("the order is croft's own number: later writes of one key win even when the clock and the row ids cannot tell", async () => {
    const t = fileTarget("log");
    await t.tx(async (tx) => {
      const bk = await bookkeepingOf(tx);
      // now() is the same for every statement of a transaction.
      for (const v of ["v1", "v2", "v3", "v4"]) await bk.upsert("assets", full("assets", { name: "'a'", cursor_value: `'${v}'`, updated_at: "now()" }));
      await bk.update("assets", { cursor_value: "'v5'" }, "name = 'a'");
    });
    expect(await t.read("assets")).toMatchObject([{ name: "a", cursor_value: "v5" }]);
    await t.tx(async (tx) => {
      const bk = await bookkeepingOf(tx);
      await bk.upsert("assets", full("assets", { name: "'a'", cursor_value: "'v6'", updated_at: "now()" }));
      const seqs = await tx.all<{ seq: number | bigint }>(`SELECT seq FROM _croft.assets_log WHERE name = 'a' ORDER BY seq`);
      expect(seqs.map((s) => Number(s.seq))).toEqual([1, 2, 3, 4, 5, 6]);
    });
    expect(await t.read("assets")).toMatchObject([{ name: "a", cursor_value: "v6" }]);
  });

  test("a row somebody inserted by hand, with no number, is older than any row croft writes", async () => {
    const t = fileTarget("log");
    await t.tx(async (tx) => {
      await tx.exec(`INSERT INTO _croft.assets_log (name, cursor_value) VALUES ('a', 'by hand'), ('b', 'by hand')`);
      await (await bookkeepingOf(tx)).upsert("assets", { name: "'a'", cursor_value: "'croft'" });
    });
    expect(await t.read("assets")).toMatchObject([{ name: "a", cursor_value: "croft" }, { name: "b", cursor_value: "by hand" }]);
  });

  test("meta is a plain table upserted by key, never twice", async () => {
    const t = fileTarget("log");
    await t.tx(async (tx) => {
      const bk = await bookkeepingOf(tx);
      await bk.upsert("meta", { key: "'k'", value: "'1'" });
      await bk.upsert("meta", { key: "'k'", value: "'2'" });
      expect(await tx.all(`SELECT value FROM _croft.meta WHERE key = 'k'`)).toEqual([{ value: "2" }]);
    });
  });
});

describe("croft's own write path", () => {
  const T0 = "2026-09-22T10:00:00Z";
  const T1 = "2026-09-22T11:00:00Z";

  test("a keyed merge reports the same rows and leaves the same bookkeeping in a file, in a log on a file and in a local lake", async () => {
    const targets = [fileTarget("file"), fileTarget("log"), ...(lakeExt.ready ? [await lakeTarget()] : [])];
    const select = (a: number, b: number, changed: boolean) =>
      `SELECT range::BIGINT AS id, ${changed ? "CASE WHEN range % 2 = 0 THEN (range % 97) + 1 ELSE (range % 97) END" : "(range % 97)"}::DOUBLE AS v, 'x' || range AS s FROM range(${a}, ${b})`;
    const step = (t: Target, runId: string, a: number, b: number, changed: boolean, now: string) => t.tx(async (tx) => {
      await tx.exec(`CREATE TEMP TABLE bb AS SELECT *, row_number() OVER () AS _croft_seq FROM (${select(a, b, changed)})`);
      const batch = await tableBatch(tx, { temp: "bb", asset: "t" });
      const res = await writeBatch(tx, { batch, target: { asset: "t", write: "merge", key: ["id"], runId }, kind: "ingest", now });
      await tx.exec(`DROP TABLE bb`);
      return res.rows;
    });
    const seen: unknown[] = [];
    for (const t of targets) {
      const first = await step(t, "r1", 0, 2000, false, T0);
      const second = await step(t, "r2", 1000, 3000, true, T1);
      expect(first, t.name).toEqual({ in: 2000, added: 2000, updated: 0, unchanged: 0, deleted: 0, total: 2000 });
      // 1000 existing keys, half of them changed; 1000 new.
      expect(second, t.name).toEqual({ in: 2000, added: 1000, updated: 500, unchanged: 500, deleted: 0, total: 3000 });
      seen.push(await snapshot(t));
    }
    for (const other of seen.slice(1)) expect(other).toEqual(seen[0]!);
    expect(seen[0]).toMatchObject({ assets: [{ name: "t", row_count: 3000 }], writes: [{ run_id: "r1", added: 2000 }, { run_id: "r2", added: 1000, updated: 500, unchanged: 500 }] });
  });
});

describe("the log switch", () => {
  test("a user's CROFT_BOOKKEEPING=log makes no log warehouse: a real croft without the harness mark writes the file's tables", async () => {
    const root = makeProject({ "assets/t.sql": "-- key: x\nselect 1 as x\n" });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NO_COLOR: "1", CROFT_BOOKKEEPING: "log" };
    const r = await cli(root, ["run", "--json"], env);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const db = await DuckDBInstance.create(join(root, "warehouse.duckdb"), { access_mode: "READ_ONLY" });
    const c = await db.connect();
    try {
      const names = (await c.runAndReadAll(`SELECT table_name FROM duckdb_tables() WHERE schema_name = '_croft' ORDER BY 1`)).getRowsJS().map((x) => x[0]);
      expect(names).toEqual(["assets", "columns", "files", "inputs", "meta", "writes"]);
      expect((await c.runAndReadAll(`SELECT value FROM _croft.meta WHERE key = 'format_version'`)).getRowsJS()).toEqual([["3"]]);
    } finally {
      c.disconnectSync();
      db.closeSync();
    }
    // With the mark the same switch gives a log, in format 4.
    const root2 = makeProject({ "assets/t.sql": "-- key: x\nselect 1 as x\n" });
    const r2 = await cli(root2, ["run", "--json"], { ...env, CROFT_TEST_HARNESS: "1" });
    expect(r2.code, r2.stdout + r2.stderr).toBe(0);
    const db2 = await DuckDBInstance.create(join(root2, "warehouse.duckdb"), { access_mode: "READ_ONLY" });
    const c2 = await db2.connect();
    try {
      expect((await c2.runAndReadAll(`SELECT value FROM _croft.meta WHERE key = 'format_version'`)).getRowsJS()).toEqual([["4"]]);
      expect((await c2.runAndReadAll(`SELECT count(*) FROM duckdb_tables() WHERE schema_name = '_croft' AND table_name = 'assets_log'`)).getRowsJS()).toEqual([[1n]]);
    } finally {
      c2.disconnectSync();
      db2.closeSync();
    }
  }, 120_000);
});

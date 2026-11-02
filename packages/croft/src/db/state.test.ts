import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { bookkeepingOf, defaultBookkeeping, STATE_TABLE_NAMES } from "./bookkeeping.ts";
import { assertFormat, checkFormat, CROFT_VERSION, ensureState, FORMAT_VERSION, hasState, LOG_FORMAT_VERSION, MAX_FORMAT_VERSION, readMeta } from "./state.ts";
import { closeAllWarehouses, openWarehouse } from "./warehouse.ts";
import { seedState } from "./bookkeeping-testkit.ts";

afterAll(() => closeAllWarehouses());

function warehouse() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-state-")));
  mkdirSync(join(root, ".croft"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

// DESIGN.md §5 "Where state lives", column by column.
const EXPECTED: Record<string, [string, string][]> = {
  meta: [["key", "VARCHAR"], ["value", "VARCHAR"]],
  assets: [["name", "VARCHAR"], ["kind", "VARCHAR"], ["write_mode", "VARCHAR"], ["key_columns", "VARCHAR[]"],
    ["code_hash", "VARCHAR"], ["behavior_hash", "VARCHAR"], ["cursor_value", "VARCHAR"], ["cursor_type", "VARCHAR"],
    ["cursor_unit", "VARCHAR"], ["last_loaded_at", "TIMESTAMP WITH TIME ZONE"], ["last_replaced_at", "TIMESTAMP WITH TIME ZONE"],
    ["row_count", "BIGINT"], ["max_loaded_at", "TIMESTAMP WITH TIME ZONE"], ["updated_at", "TIMESTAMP WITH TIME ZONE"]],
  columns: [["asset", "VARCHAR"], ["name", "VARCHAR"], ["type", "VARCHAR"], ["source_name", "VARCHAR"], ["format", "VARCHAR"],
    ["pinned", "BOOLEAN"], ["pending", "BOOLEAN"], ["kinds", "VARCHAR[]"], ["present_last_batch", "BOOLEAN"],
    ["added_at", "TIMESTAMP WITH TIME ZONE"]],
  inputs: [["asset", "VARCHAR"], ["input", "VARCHAR"], ["seen_loaded_at", "TIMESTAMP WITH TIME ZONE"], ["seen_key", "JSON"],
    ["input_last_loaded_at", "TIMESTAMP WITH TIME ZONE"]],
  files: [["asset", "VARCHAR"], ["path", "VARCHAR"], ["size", "BIGINT"], ["mtime", "TIMESTAMP WITH TIME ZONE"], ["etag", "VARCHAR"],
    ["sha256", "VARCHAR"], ["loaded_at", "TIMESTAMP WITH TIME ZONE"]],
  writes: [["asset", "VARCHAR"], ["loaded_at", "TIMESTAMP WITH TIME ZONE"], ["run_id", "VARCHAR"], ["mode", "VARCHAR"],
    ["rows_in", "BIGINT"], ["added", "BIGINT"], ["updated", "BIGINT"], ["unchanged", "BIGINT"], ["deleted", "BIGINT"],
    ["cursor_before", "VARCHAR"], ["cursor_after", "VARCHAR"], ["since_used", "VARCHAR"], ["inputs", "JSON"],
    ["schema_changes", "JSON"], ["code_hash", "VARCHAR"], ["attempt", "INTEGER"]],
};
// The format-1 schema (croft before _croft.writes.attempt), for the migration test.
const FORMAT_1_DDL = [
  `CREATE SCHEMA _croft`,
  `CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)`,
  `CREATE TABLE _croft.writes (asset VARCHAR, loaded_at TIMESTAMPTZ, run_id VARCHAR, mode VARCHAR,
    rows_in BIGINT, added BIGINT, updated BIGINT, unchanged BIGINT, deleted BIGINT,
    cursor_before VARCHAR, cursor_after VARCHAR, since_used VARCHAR, inputs JSON,
    schema_changes JSON, code_hash VARCHAR, PRIMARY KEY (asset, loaded_at))`,
];
const PRIMARY_KEYS: Record<string, string[]> = {
  meta: ["key"], assets: ["name"], columns: ["asset", "name"], inputs: ["asset", "input"], files: ["asset", "path"], writes: ["asset", "loaded_at"],
};

// What a log adapter's _croft looks like to duckdb_columns(): meta as the file has it, each keyed table as its log (its
// columns, then seq and closed) and as the view over it (its columns).
const LOG_EXPECTED: Record<string, [string, string][]> = {
  ...EXPECTED,
  ...Object.fromEntries(Object.entries(EXPECTED).filter(([t]) => t !== "meta").map(([t, cols]) => [`${t}_log`, [...cols, ["seq", "BIGINT"], ["closed", "BOOLEAN"]] as [string, string][]])),
};

describe.each(["file", "log"] as const)("ensureState (%s adapter)", (kind) => {
  const ensure = (tx: Parameters<typeof ensureState>[0], o: { croftVersion?: string } = {}) => ensureState(tx, { ...o, bookkeeping: kind });

  test("creates the _croft schema exactly as designed", async () => {
    const w = warehouse();
    expect(await w.read((db) => hasState(db), { purpose: "t" })).toBe(false);
    await w.write("state", (tx) => ensure(tx), { runId: "r" });
    const cols = await w.read((db) => db.all<{ t: string; c: string; ty: string }>(
      `SELECT table_name t, column_name c, data_type ty FROM duckdb_columns() WHERE schema_name = '_croft' ORDER BY table_name, column_index`), { purpose: "t" });
    const byTable: Record<string, [string, string][]> = {};
    for (const r of cols) (byTable[r.t] ??= []).push([r.c, r.ty]);
    expect(byTable).toEqual(kind === "file" ? EXPECTED : LOG_EXPECTED);
    expect(Object.keys(byTable).filter((t) => !t.endsWith("_log")).sort()).toEqual([...STATE_TABLE_NAMES].sort());
    const pks = await w.read((db) => db.all<{ t: string; cols: string[] }>(
      `SELECT table_name t, constraint_column_names cols FROM duckdb_constraints() WHERE schema_name = '_croft' AND constraint_type = 'PRIMARY KEY'`), { purpose: "t" });
    // A lake refuses primary keys: the log adapter has none.
    expect(Object.fromEntries(pks.map((r) => [r.t, r.cols]))).toEqual(kind === "file" ? PRIMARY_KEYS : {});
  });

  test("records format_version, duckdb_version and croft_version", async () => {
    const w = warehouse();
    const meta = await w.write("state", (tx) => ensure(tx), { runId: "r" });
    expect(meta).toEqual({
      format_version: String(kind === "log" ? LOG_FORMAT_VERSION : FORMAT_VERSION), duckdb_version: expect.stringMatching(/^v2\.0\.0/), croft_version: CROFT_VERSION,
      ...(kind === "log" ? { bookkeeping: "log" } : {}),
    });
    expect(await w.read((db) => readMeta(db), { purpose: "t" })).toEqual(meta);
    expect(CROFT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("is idempotent: twice in one transaction, and again later", async () => {
    const w = warehouse();
    await w.write("state", async (tx) => {
      await ensure(tx);
      await ensure(tx);
    }, { runId: "r" });
    await w.write("row", async (tx) => (await bookkeepingOf(tx)).upsert("assets", { name: "'a'", kind: "'ingest'" }), { runId: "r" });
    const again = await w.write("state", (tx) => ensure(tx, { croftVersion: "0.2.0" }), { runId: "r" });
    expect(again.croft_version).toBe("0.2.0");
    expect(await w.read((db) => db.all(`SELECT name, kind FROM _croft.assets`), { purpose: "t" })).toEqual([{ name: "a", kind: "ingest" }]);
    expect(await w.read((db) => db.all(`SELECT count(*)::INTEGER n FROM _croft.meta`), { purpose: "t" })).toEqual([{ n: kind === "log" ? 4 : 3 }]);
  });

  test("a database that has bookkeeping keeps its adapter whatever is asked for", async () => {
    const w = warehouse();
    await w.write("state", (tx) => ensure(tx), { runId: "r" });
    const other = kind === "file" ? "log" : "file";
    await w.write("again", (tx) => ensureState(tx, { bookkeeping: other }), { runId: "r" });
    const names = await w.read((db) => db.all<{ n: string }>(`SELECT table_name n FROM duckdb_tables() WHERE schema_name = '_croft'`), { purpose: "t" });
    expect(names.some((r) => r.n === "assets_log")).toBe(kind === "log");
  });
});

describe("ensureState", () => {
  test("refuses a database from a newer croft with DB_NEWER_FORMAT", async () => {
    const w = warehouse();
    await w.write("state", (tx) => ensureState(tx), { runId: "r" });
    await w.write("future", (tx) => tx.exec(`UPDATE _croft.meta SET value = '99' WHERE key = 'format_version'`), { runId: "r" });
    for (const attempt of [
      () => w.write("state", (tx) => ensureState(tx), { runId: "r" }),
      () => w.read((db) => checkFormat(db), { purpose: "t" }),
    ]) {
      let caught: unknown;
      try {
        await attempt();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CroftError);
      expect((caught as CroftError).code).toBe("DB_NEWER_FORMAT");
      expect((caught as CroftError).exit).toBe(2);
    }
  });

  test("format 3: _croft.writes records the step attempt (2), _croft.inputs what a transform last read in full (3)", () => {
    expect(FORMAT_VERSION).toBe(3);
  });

  test("format 4 is the log's: a log warehouse is stamped with it from its first write, and a croft that reads up to 3 refuses it", async () => {
    expect(LOG_FORMAT_VERSION).toBe(4);
    expect(MAX_FORMAT_VERSION).toBe(4);
    const w = warehouse();
    const meta = await w.write("state", (tx) => ensureState(tx, { bookkeeping: "log" }), { runId: "r" });
    expect(meta.format_version).toBe("4");
    expect(await w.read((db) => readMeta(db), { purpose: "t" })).toMatchObject({ format_version: "4", bookkeeping: "log" });
    // A croft before the log reads up to 3: the same check, with its newest format, refuses the log's.
    const old = () => assertFormat({ format_version: "4", croft_version: "9.9.9" }, FORMAT_VERSION);
    expect(old).toThrow(CroftError);
    try { old(); } catch (e) { expect((e as CroftError).code).toBe("DB_NEWER_FORMAT"); }
    // This croft reads both, and a file warehouse stays at 3 whatever else is asked for later.
    expect(() => assertFormat({ format_version: "4" })).not.toThrow();
    expect(() => assertFormat({ format_version: "3" }, FORMAT_VERSION)).not.toThrow();
    expect(() => assertFormat({ format_version: "5" })).toThrow(CroftError);
    const file = warehouse();
    expect((await file.write("state", (tx) => ensureState(tx, { bookkeeping: "file" }), { runId: "r" })).format_version).toBe("3");
  });

  test("CROFT_BOOKKEEPING=log is a test switch: it does nothing without the harness mark", () => {
    expect(defaultBookkeeping({})).toBe("file");
    expect(defaultBookkeeping({ CROFT_BOOKKEEPING: "log" })).toBe("file");
    expect(defaultBookkeeping({ CROFT_TEST_HARNESS: "1" })).toBe("file");
    expect(defaultBookkeeping({ CROFT_BOOKKEEPING: "file", CROFT_TEST_HARNESS: "1" })).toBe("file");
    expect(defaultBookkeeping({ CROFT_BOOKKEEPING: "log", CROFT_TEST_HARNESS: "1" })).toBe("log");
  });

  test("migrates a format-1 database: adds _croft.writes.attempt, keeps its rows, records the current format", async () => {
    const w = warehouse();
    await w.write("v1", async (tx) => {
      for (const ddl of FORMAT_1_DDL) await tx.exec(ddl);
      await tx.exec(`INSERT INTO _croft.meta VALUES ('format_version', '1')`);
      await seedState(tx, `INSERT INTO _croft.writes (asset, loaded_at, run_id, rows_in) VALUES ('orders', '2026-09-22T10:00:00Z', 'r_old', 5)`);
    }, { runId: "r" });
    // Twice in one transaction, around a write to _croft.writes: the second call must not ALTER it again.
    const meta = await w.write("state", async (tx) => {
      await ensureState(tx);
      await seedState(tx, `INSERT INTO _croft.writes (asset, loaded_at, run_id, rows_in, attempt) VALUES ('orders', '2026-09-22T11:00:00Z', 'r_new', 7, 2)`);
      return ensureState(tx);
    }, { runId: "r" });
    expect(meta.format_version).toBe("3");
    expect(await w.read((db) => readMeta(db), { purpose: "t" })).toMatchObject({ format_version: "3" });
    const cols = await w.read((db) => db.all<{ c: string; ty: string }>(
      `SELECT column_name c, data_type ty FROM duckdb_columns() WHERE schema_name = '_croft' AND table_name = 'writes' ORDER BY column_index`), { purpose: "t" });
    expect(cols.map((r) => [r.c, r.ty])).toEqual(EXPECTED.writes!);
    expect(await w.read((db) => db.all(`SELECT run_id, rows_in, attempt FROM _croft.writes ORDER BY loaded_at`), { purpose: "t" })).toEqual([
      { run_id: "r_old", rows_in: 5, attempt: null }, { run_id: "r_new", rows_in: 7, attempt: 2 },
    ]);
  });

  test("migrates a format-2 database: adds _croft.inputs.input_last_loaded_at, keeps its rows, records format 3", async () => {
    const w = warehouse();
    await w.write("v2", async (tx) => {
      await tx.exec(`CREATE SCHEMA _croft`);
      await tx.exec(`CREATE TABLE _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)`);
      await tx.exec(`CREATE TABLE _croft.inputs (asset VARCHAR, input VARCHAR, seen_loaded_at TIMESTAMPTZ, seen_key JSON, PRIMARY KEY (asset, input))`);
      await tx.exec(`INSERT INTO _croft.meta VALUES ('format_version', '2')`);
      await seedState(tx, `INSERT INTO _croft.inputs VALUES ('triage', 'issues', '2026-09-22T10:00:00Z', '[7]')`);
    }, { runId: "r" });
    const meta = await w.write("state", (tx) => ensureState(tx), { runId: "r" });
    expect(meta.format_version).toBe("3");
    const cols = await w.read((db) => db.all<{ c: string; ty: string }>(
      `SELECT column_name c, data_type ty FROM duckdb_columns() WHERE schema_name = '_croft' AND table_name = 'inputs' ORDER BY column_index`), { purpose: "t" });
    expect(cols.map((r) => [r.c, r.ty])).toEqual(EXPECTED.inputs!);
    expect(await w.read((db) => db.all(`SELECT asset, input, seen_key, input_last_loaded_at FROM _croft.inputs`), { purpose: "t" })).toEqual([
      { asset: "triage", input: "issues", seen_key: [7], input_last_loaded_at: null },
    ]);
  });

  test("checkFormat on a database without state is a no-op", async () => {
    const w = warehouse();
    expect(await w.read((db) => checkFormat(db), { purpose: "t" })).toEqual({});
  });
});

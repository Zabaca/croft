import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { checkFormat, CROFT_VERSION, ensureState, FORMAT_VERSION, hasState, readMeta, STATE_TABLES } from "./state.ts";
import { closeAllWarehouses, openWarehouse } from "./warehouse.ts";

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
  inputs: [["asset", "VARCHAR"], ["input", "VARCHAR"], ["seen_loaded_at", "TIMESTAMP WITH TIME ZONE"], ["seen_key", "JSON"]],
  files: [["asset", "VARCHAR"], ["path", "VARCHAR"], ["size", "BIGINT"], ["mtime", "TIMESTAMP WITH TIME ZONE"], ["etag", "VARCHAR"],
    ["sha256", "VARCHAR"], ["loaded_at", "TIMESTAMP WITH TIME ZONE"]],
  writes: [["asset", "VARCHAR"], ["loaded_at", "TIMESTAMP WITH TIME ZONE"], ["run_id", "VARCHAR"], ["mode", "VARCHAR"],
    ["rows_in", "BIGINT"], ["added", "BIGINT"], ["updated", "BIGINT"], ["unchanged", "BIGINT"], ["deleted", "BIGINT"],
    ["cursor_before", "VARCHAR"], ["cursor_after", "VARCHAR"], ["since_used", "VARCHAR"], ["inputs", "JSON"],
    ["schema_changes", "JSON"], ["code_hash", "VARCHAR"]],
};
const PRIMARY_KEYS: Record<string, string[]> = {
  meta: ["key"], assets: ["name"], columns: ["asset", "name"], inputs: ["asset", "input"], files: ["asset", "path"], writes: ["asset", "loaded_at"],
};

describe("ensureState", () => {
  test("creates the _croft schema exactly as designed", async () => {
    const w = warehouse();
    expect(await w.read((db) => hasState(db), { purpose: "t" })).toBe(false);
    await w.write("state", (tx) => ensureState(tx), { runId: "r" });
    const cols = await w.read((db) => db.all<{ t: string; c: string; ty: string }>(
      `SELECT table_name t, column_name c, data_type ty FROM duckdb_columns() WHERE schema_name = '_croft' ORDER BY table_name, column_index`), { purpose: "t" });
    const byTable: Record<string, [string, string][]> = {};
    for (const r of cols) (byTable[r.t] ??= []).push([r.c, r.ty]);
    expect(byTable).toEqual(EXPECTED);
    expect(Object.keys(byTable).sort()).toEqual([...STATE_TABLES].sort());
    const pks = await w.read((db) => db.all<{ t: string; cols: string[] }>(
      `SELECT table_name t, constraint_column_names cols FROM duckdb_constraints() WHERE schema_name = '_croft' AND constraint_type = 'PRIMARY KEY'`), { purpose: "t" });
    expect(Object.fromEntries(pks.map((r) => [r.t, r.cols]))).toEqual(PRIMARY_KEYS);
  });

  test("records format_version, duckdb_version and croft_version", async () => {
    const w = warehouse();
    const meta = await w.write("state", (tx) => ensureState(tx), { runId: "r" });
    expect(meta).toEqual({ format_version: String(FORMAT_VERSION), duckdb_version: expect.stringMatching(/^v1\.5\.5/), croft_version: CROFT_VERSION });
    expect(await w.read((db) => readMeta(db), { purpose: "t" })).toEqual(meta);
    expect(CROFT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("is idempotent: twice in one transaction, and again later", async () => {
    const w = warehouse();
    await w.write("state", async (tx) => {
      await ensureState(tx);
      await ensureState(tx);
    }, { runId: "r" });
    await w.write("row", (tx) => tx.exec(`INSERT INTO _croft.assets (name, kind) VALUES ('a', 'ingest')`), { runId: "r" });
    const again = await w.write("state", (tx) => ensureState(tx, { croftVersion: "0.2.0" }), { runId: "r" });
    expect(again.croft_version).toBe("0.2.0");
    expect(await w.read((db) => db.all(`SELECT name, kind FROM _croft.assets`), { purpose: "t" })).toEqual([{ name: "a", kind: "ingest" }]);
    expect(await w.read((db) => db.all(`SELECT count(*)::INTEGER n FROM _croft.meta`), { purpose: "t" })).toEqual([{ n: 3 }]);
  });

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

  test("checkFormat on a database without state is a no-op", async () => {
    const w = warehouse();
    expect(await w.read((db) => checkFormat(db), { purpose: "t" })).toEqual({});
  });
});

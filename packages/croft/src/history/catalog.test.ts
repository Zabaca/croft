import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { baseFrom, readCatalogEntry } from "./catalog.ts";

afterAll(() => closeAllWarehouses());

function warehouse(): DuckWarehouse {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-catalog-")));
  mkdirSync(join(root, ".croft"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

const TRIAGE = `INSERT INTO _croft.assets (name, kind, write_mode, key_columns, row_count, last_loaded_at)
  VALUES ('triage', 'ts', 'merge', ['issue_id'], 2, '2026-09-22T10:00:00Z')`;

describe("readCatalogEntry: what a transform has seen of its inputs", () => {
  test("inputsSeen comes from _croft.inputs; reads from the definition", async () => {
    const w = warehouse();
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(`CREATE TABLE triage (issue_id BIGINT, priority VARCHAR, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(TRIAGE);
      await tx.exec(`INSERT INTO _croft.inputs VALUES ('triage', 'issues', '2026-09-22T09:00:00.000001Z', '[18446744073709551621]', NULL),
        ('triage', 'labels', '2026-09-22T08:00:00Z', NULL, '2026-09-22T08:00:00Z'), ('other', 'issues', '2026-09-22T07:00:00Z', NULL, NULL)`);
    }, { runId: "r" });
    const entry = await w.read((sql) => readCatalogEntry(sql, { asset: "triage", kind: "ts", behavior: "b", cursorField: null, lastRunId: "r", reads: ["issues", "labels"] }), { purpose: "t" });
    expect(entry!.inputsSeen).toEqual({
      issues: { seenLoadedAt: "2026-09-22T09:00:00.000001Z", seenKey: [18446744073709551621n], inputLastLoadedAt: null },
      labels: { seenLoadedAt: "2026-09-22T08:00:00.000000Z", seenKey: null, inputLastLoadedAt: "2026-09-22T08:00:00.000000Z" },
    });
    expect(entry!.reads).toEqual(["issues", "labels"]);
    // A refresh from a previous entry keeps what only the definition knows.
    expect(baseFrom(entry, "triage", "r2").reads).toEqual(["issues", "labels"]);
  });

  test("an asset that recorded no inputs has no inputsSeen", async () => {
    const w = warehouse();
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(TRIAGE);
    }, { runId: "r" });
    const entry = await w.read((sql) => readCatalogEntry(sql, { asset: "triage", behavior: "b", cursorField: null, lastRunId: null }), { purpose: "t" });
    expect(entry).not.toBeNull();
    expect("inputsSeen" in entry!).toBe(false);
    expect("reads" in entry!).toBe(false);
  });

  test("a format-2 database (no input_last_loaded_at yet) reads under a read lease, as not read in full", async () => {
    const w = warehouse();
    await w.write("seed", async (tx) => {
      await ensureState(tx);
      await tx.exec(`DROP TABLE _croft.inputs`);
      await tx.exec(`CREATE TABLE _croft.inputs (asset VARCHAR, input VARCHAR, seen_loaded_at TIMESTAMPTZ, seen_key JSON, PRIMARY KEY (asset, input))`);
      await tx.exec(TRIAGE);
      await tx.exec(`INSERT INTO _croft.inputs VALUES ('triage', 'issues', '2026-09-22T09:00:00Z', NULL)`);
    }, { runId: "r" });
    const entry = await w.read((sql) => readCatalogEntry(sql, { asset: "triage", behavior: "b", cursorField: null, lastRunId: null }), { purpose: "t" });
    expect(entry!.inputsSeen).toEqual({ issues: { seenLoadedAt: "2026-09-22T09:00:00.000000Z", seenKey: null, inputLastLoadedAt: null } });
  });
});

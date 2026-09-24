// Out-of-band changes (safety/out-of-band.ts, DESIGN.md §5 "Out-of-band changes"): what changed, in words; the write
// lease's check (the step warns once, and what reads the table rebuilds); and doctor's read-only scan, which also
// surfaces TABLE_MODIFIED_OUTSIDE_CROFT.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureState } from "../db/state.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { loadProject } from "../project/root.ts";
import { cleanupProjects, makeProject, runIn } from "../run/testkit.ts";
import { changeWords, checkOutOfBand, outOfBandProblem, scanTables } from "./out-of-band.ts";

afterEach(() => closeAllWarehouses());
afterAll(() => cleanupProjects());

function warehouse(): DuckWarehouse {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-oob-")));
  mkdirSync(join(root, ".croft"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

const T = "2026-09-22T10:00:00.000000Z";
const T2 = "2026-09-23T00:00:00.000000Z";

/** Tables t (2 rows), u (1 row) and v (1 row) as croft left them, and w that croft has no record of. */
async function setup(w: DuckWarehouse): Promise<void> {
  await w.write("setup", async (tx) => {
    await ensureState(tx);
    for (const [name, rows] of [["t", 2], ["u", 1], ["v", 1]] as const) {
      await tx.exec(`CREATE TABLE ${name} (id BIGINT, _loaded_at TIMESTAMPTZ)`);
      await tx.exec(`INSERT INTO ${name} SELECT range + 1, '${T}'::TIMESTAMPTZ FROM range(${rows})`);
      await tx.exec(`INSERT INTO _croft.assets (name, row_count, max_loaded_at) VALUES ('${name}', ${rows}, '${T}')`);
      await tx.exec(`INSERT INTO _croft.columns (asset, name, type) VALUES ('${name}', 'id', 'BIGINT'), ('${name}', '_loaded_at', 'TIMESTAMPTZ')`);
    }
    await tx.exec(`CREATE TABLE w AS SELECT 1 AS a`);
  }, { runId: "setup" });
}

describe("changeWords", () => {
  const e = { rowCount: 3, maxLoadedAt: T };
  test("rows removed or added, with the counts", () => {
    expect(changeWords(e, { exists: true, rowCount: 2, maxLoadedAt: T })).toBe("1 row removed (3 → 2)");
    expect(changeWords(e, { exists: true, rowCount: 1203, maxLoadedAt: T })).toBe("1,200 rows added (3 → 1,203)");
  });
  test("stamps: newer than croft's, older (croft's newest rows gone), none left, and with a count change", () => {
    expect(changeWords(e, { exists: true, rowCount: 3, maxLoadedAt: T2 }))
      .toBe(`the same 3 rows, but rows stamped after croft's last write (newest _loaded_at ${T2}, croft's ${T})`);
    expect(changeWords(e, { exists: true, rowCount: 3, maxLoadedAt: "2026-09-01T00:00:00.000000Z" }))
      .toBe(`the same 3 rows, but the rows croft wrote last are gone or restamped (newest _loaded_at 2026-09-01T00:00:00.000000Z, croft's ${T})`);
    expect(changeWords(e, { exists: true, rowCount: 0, maxLoadedAt: null })).toBe(`3 rows removed (3 → 0); no row has a _loaded_at any more (croft's newest was ${T})`);
    expect(changeWords({ rowCount: 0, maxLoadedAt: null }, { exists: true, rowCount: 1, maxLoadedAt: T2 }))
      .toBe(`1 row added (0 → 1); rows stamped after croft's last write (newest _loaded_at ${T2})`);
  });
  test("a dropped table", () => {
    expect(changeWords(e, { exists: false, rowCount: 0, maxLoadedAt: null })).toBe("the table was dropped (croft left 3 rows)");
  });
});

describe("outOfBandProblem", () => {
  test("a warning with what changed, a hint, a fix that is no command, and the numbers; worded for a write or for doctor", () => {
    const expected = { rowCount: 3, maxLoadedAt: T };
    const actual = { exists: true, rowCount: 2, maxLoadedAt: T };
    const w = outOfBandProblem("orders", expected, actual, "write");
    expect(w).toMatchObject({
      code: "OUT_OF_BAND_CHANGE", severity: "warning", asset: "orders", message: "orders was changed outside croft: 1 row removed (3 → 2)",
      effect: "croft went on from the table as it was; assets that read it are rebuilt on their next run",
      fix: { kind: "manual" }, details: { expected, actual },
    });
    expect(w.hint).toBe("tell the user something other than croft (the duckdb CLI, a GUI, a script) wrote orders; croft preview orders --rebuild compares it with a fresh build");
    expect(w.fix!.description).toBe("tell the user orders was changed outside croft (1 row removed (3 → 2)), and change tables only through croft");
    const d = outOfBandProblem("orders", expected, actual, "doctor");
    expect(d.effect).toBe("the next run of orders goes on from the table as it is then, and assets that read it are rebuilt after that");
  });
});

describe("checkOutOfBand (the write lease)", () => {
  test("null without a record or when the numbers agree; worded otherwise, with detectOutOfBand's numbers", async () => {
    const w = warehouse();
    expect(await w.read((db) => checkOutOfBand(db, "t"), { purpose: "t" })).toBeNull();
    await setup(w);
    expect(await w.read((db) => checkOutOfBand(db, "t"), { purpose: "t" })).toBeNull();
    await w.write("outside", (tx) => tx.exec(`DELETE FROM t WHERE id = 2`), { runId: "x" });
    const found = await w.read((db) => checkOutOfBand(db, "t"), { purpose: "t" });
    expect(found?.expected).toEqual({ rowCount: 2, maxLoadedAt: T });
    expect(found?.actual).toEqual({ exists: true, rowCount: 1, maxLoadedAt: T });
    expect(found?.problem.message).toBe("t was changed outside croft: 1 row removed (2 → 1)");
  });
});

describe("scanTables (doctor)", () => {
  test("a warehouse without croft state has nothing to compare", async () => {
    const w = warehouse();
    await w.write("x", (tx) => tx.exec(`CREATE TABLE a AS SELECT 1 AS n`), { runId: "x" });
    expect(await w.read((db) => scanTables(db), { purpose: "t" })).toEqual({ checked: 0, skipped: 0, findings: [] });
  });

  test("a time budget stops it starting new tables; the rest are counted as skipped", async () => {
    const w = warehouse();
    await setup(w);
    expect(await w.read((db) => scanTables(db, { budgetMs: 0 }), { purpose: "t" })).toEqual({ checked: 0, skipped: 3, findings: [] });
    expect(await w.read((db) => scanTables(db, { budgetMs: 60_000 }), { purpose: "t" })).toEqual({ checked: 3, skipped: 0, findings: [] });
  });

  test("every recorded table is compared: rows, stamps, columns and a dropped table; tables croft has no record of are not", async () => {
    const w = warehouse();
    await setup(w);
    expect(await w.read((db) => scanTables(db), { purpose: "t" })).toEqual({ checked: 3, skipped: 0, findings: [] });
    await w.write("outside", async (tx) => {
      await tx.exec(`INSERT INTO t VALUES (3, '${T2}')`);
      await tx.exec(`ALTER TABLE u ADD COLUMN note VARCHAR`);
      await tx.exec(`DROP TABLE v`);
      await tx.exec(`INSERT INTO w VALUES (2)`);
    }, { runId: "x" });
    const scan = await w.read((db) => scanTables(db), { purpose: "t" });
    expect(scan.checked).toBe(3);
    expect(scan.findings.map((f) => [f.asset, f.outOfBand?.problem.code ?? null, f.schema?.code ?? null])).toEqual([
      ["t", "OUT_OF_BAND_CHANGE", null],
      ["u", null, "TABLE_MODIFIED_OUTSIDE_CROFT"],
      ["v", "OUT_OF_BAND_CHANGE", null],   // dropped: one problem, not a second TABLE_MODIFIED_OUTSIDE_CROFT
    ]);
    expect(scan.findings[0]!.outOfBand!.problem.message)
      .toBe(`t was changed outside croft: 1 row added (2 → 3); rows stamped after croft's last write (newest _loaded_at ${T2}, croft's ${T})`);
    expect(scan.findings[0]!.outOfBand!.problem.effect).toContain("the next run of t");
    expect(scan.findings[1]!.schema!.message).toBe("u's columns were changed outside croft: added note VARCHAR");
    expect(scan.findings[2]!.outOfBand!.problem.message).toBe("v was changed outside croft: the table was dropped (croft left 1 row)");
  });
});

describe("at the next run", () => {
  const items = `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows() {
    yield [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }];
  },
});
`;

  test("the run warns once, naming the asset and what changed; the next run is quiet", async () => {
    const root = makeProject({ "assets/items.ts": items });
    const first = await runIn(root, ["items"]);
    expect(first.data.steps.map((s) => s.status)).toEqual(["ok"]);
    const p = loadProject({ root });
    const w = openWarehouse({ path: p.paths.database, mode: "read_write", timezone: p.timezone, root, stateDir: p.paths.stateDir, isTTY: false });
    await w.write("outside croft", (tx) => tx.exec(`DELETE FROM items WHERE id = 2`), { runId: "r_outside" });

    const second = await runIn(root, ["items"]);
    const oob = second.problems.filter((x) => x.code === "OUT_OF_BAND_CHANGE");
    expect(oob).toHaveLength(1);
    expect(oob[0]).toMatchObject({ severity: "warning", asset: "items", runId: second.data.runId, message: "items was changed outside croft: 1 row removed (3 → 2)" });
    expect(second.exit).toBe(0);

    const third = await runIn(root, ["items"]);
    expect(third.problems.map((x) => x.code)).not.toContain("OUT_OF_BAND_CHANGE");
  });
});

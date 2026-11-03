// croft's bookkeeping that an older pass moved into files of the store is brought back into the catalog (db/lake-maintenance.ts pruneBookkeeping,
// DESIGN.md D-T5; the second real-lake trial). croft before D162 flushed every schema in its pass, `_croft` included, and each read of those tables
// then cost the store a listing and a range read or two for ever: a run with nothing new took 9 s on R2 and nothing said why. doctor now says,
// and `croft maintain` mends it, on a local lake and on a Postgres lake with its store. What a person reads (the views `_croft.<t>`) must be the same
// before and after, and the bookkeeping must go on from where it was.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bookkeepingInFiles, runPass } from "../../db/lake-maintenance.ts";
import { lakeOption, MAINTENANCE_LOCK_LABEL } from "../../db/lake.ts";
import { lakeRigReady, type LakeRig, startLakeRig } from "../../db/lake-testkit.ts";
import { closeAllWarehouses, openWarehouse } from "../../db/warehouse.ts";
import { ProjectEnv } from "../../project/env.ts";
import { cleanup, cli } from "./inspect-testkit.ts";
import { lakeProject, type LakeProject, ORDERS_SQL } from "./lake-project-testkit.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-reinline.test] SKIPPING: ${ready.skipReason}`);

let rig: LakeRig;
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  await closeAllWarehouses();
  await rig?.stop();
  await cleanup();
});

const TABLES = ["meta", "assets", "columns", "inputs", "files", "writes"] as const;

/** A warehouse on the project's lake, as the writer; the caller closes it. */
function writer(l: LakeProject) {
  return openWarehouse({
    path: l.project.paths.database, mode: "read_write", timezone: l.project.timezone, root: l.project.root, stateDir: l.project.paths.stateDir,
    ...lakeOption(l.project, ProjectEnv.load(l.project.root, l.env)), isTTY: false, register: false,
  });
}

for (const kind of ["local", "postgres"] as const) {
  (ready.ready ? test : test.skip)(`on a ${kind} lake: bookkeeping left in files by an older pass is found by doctor and brought back by croft maintain, and nothing a person reads changes`, async () => {
    const l = await lakeProject(kind, { extensionDir: ready.dir, ...(kind === "postgres" ? { rig } : {}) });
    const ok = async (args: string[]) => {
      const r = await cli([...args, "--json"], { cwd: l.p.root, env: l.env });
      await closeAllWarehouses();
      expect(r.exit, `${args.join(" ")}\n${r.stdout}${r.stderr}`).toBe(0);
      return r;
    };
    const rows = async (sql: string) => (await ok(["query", sql, "--limit", "100000", "--full-values"])).json.data.rows as Record<string, unknown>[];
    const views = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await rows(`select * from _croft.${t}`)).map((r) => JSON.stringify(r)).sort()] as const)));
    const doctorLine = async () => {
      const d = await ok(["doctor"]);
      return (d.json.data.checks as { id: string; status: string; text: string; code?: string }[]).find((c) => c.id === "lake.bookkeeping");
    };
    const inFiles = async () => {
      const w = writer(l);
      try {
        return await w.read((db) => bookkeepingInFiles(db), { purpose: "test" });
      } finally {
        await w.close();
        await closeAllWarehouses();
      }
    };

    // A history with every kind of bookkeeping row: runs that change the table.
    for (const m of [5, 4, 3]) {
      writeFileSync(join(l.p.root, "assets", "orders.sql"), ORDERS_SQL.replace("range % 7", `range % ${m}`));
      await ok(["run", "--foreground"]);
    }
    expect(await inFiles()).toEqual([]);
    expect(await doctorLine()).toBeUndefined(); // a lake nothing flushed has none, and doctor says nothing

    // What croft's pass did before D162: DuckLake's flush of every schema, the bookkeeping's included.
    const old = writer(l);
    try {
      await old.write("flush every schema", async (sql) => { await sql.all("CALL ducklake_flush_inlined_data('lake')"); }, { runId: "old", transaction: false, touchesLake: false });
    } finally {
      await old.close();
      await closeAllWarehouses();
    }
    const flushed = await inFiles();
    expect(flushed.map((t) => t.table)).toEqual(expect.arrayContaining(["assets_log", "columns_log", "meta"]));
    const line = await doctorLine();
    expect(line).toMatchObject({ status: "warn", code: "LAKE_BOOKKEEPING_IN_FILES" });
    expect(line!.text).toContain("_croft.assets_log");
    expect(line!.text).toContain("croft's own bookkeeping is in");

    // The pass brings it back. The views read the same; the first step says what it moved.
    const before = await views();
    const pass = (await ok(["maintain"])).json.data.report;
    expect(pass.ok, JSON.stringify(pass.steps)).toBe(true);
    expect(pass.steps[0]).toMatchObject({ step: "prune", status: "ok" });
    expect(pass.steps[0].did.reinlined).toBeGreaterThanOrEqual(3);
    expect(pass.steps[0].did.reinlinedRows).toBeGreaterThan(0);
    expect(pass.steps[0].did.leftInFiles).toBe(0);
    expect(await views()).toEqual(before);
    // The files are gone (the pass's own rewrite and cleanup steps), doctor stops warning, and a second pass has nothing to move.
    expect(await inFiles()).toEqual([]);
    expect(await doctorLine()).toBeUndefined();
    expect((await ok(["maintain"])).json.data.report.steps[0].did.reinlined).toBe(0);

    // And the bookkeeping goes on from where it was: a run that changes the table, a run that does not, the numbers still ordered.
    writeFileSync(join(l.p.root, "assets", "orders.sql"), ORDERS_SQL.replace("range % 7", "range % 2"));
    const changed = await ok(["run", "--foreground"]);
    expect(changed.json.data.steps.map((s: { asset: string; status: string }) => `${s.asset}:${s.status}`)).toEqual(["orders:ok"]);
    expect((await rows("select name, row_count::INT as n from _croft.assets order by name"))).toEqual([{ name: "orders", n: 20 }]);
    expect(await inFiles()).toEqual([]);
  }, 600_000);
}

(ready.ready ? test : test.skip)("a table of more rows than the pass will rewrite is left in its file, and said so", async () => {
  const l = await lakeProject("local", { extensionDir: ready.dir });
  const flush = writer(l);
  try {
    await flush.write("flush every schema", async (sql) => { await sql.all("CALL ducklake_flush_inlined_data('lake')"); }, { runId: "old", transaction: false, touchesLake: false });
  } finally {
    await flush.close();
    await closeAllWarehouses();
  }
  const w = writer(l);
  try {
    // Two rows is more than this pass will rewrite of any table: every table with a file stays where it is.
    const report = await w.write(MAINTENANCE_LOCK_LABEL, (sql) => runPass(sql, { now: new Date(), pins: [], reinlineMaxRows: 1, retry: { attempts: 1, baseMs: 1, sleep: async () => {} } }), { runId: "maintenance", transaction: false, touchesLake: false });
    expect(report.steps[0]!.did.leftInFiles).toBeGreaterThan(0);
    const left = await w.read((db) => bookkeepingInFiles(db), { purpose: "test" });
    expect(left.length).toBeGreaterThan(0);
  } finally {
    await w.close();
    await closeAllWarehouses();
  }
}, 240_000);

describe("the words", () => {
  test("a pass that brought bookkeeping back into the catalog, or left a table, says so", async () => {
    const { STEP_WORDS } = await import("./maintain.ts");
    const step = (did: Record<string, number>) => ({ step: "prune" as const, status: "ok" as const, tookMs: 1, attempts: 1, did });
    expect(STEP_WORDS.prune!(step({ rows: 3, tables: 2 }))).toBe("3 superseded bookkeeping rows removed from 2 logs");
    expect(STEP_WORDS.prune!(step({ rows: 0, tables: 0, reinlined: 3, reinlinedRows: 41 }))).toContain("41 rows of 3 bookkeeping tables brought back into the catalog from files");
    expect(STEP_WORDS.prune!(step({ rows: 0, tables: 0, leftInFiles: 1 }))).toContain("1 bookkeeping table left in files (too many rows to rewrite)");
  });
});

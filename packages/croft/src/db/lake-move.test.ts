// The pieces of moving a file warehouse into a lake (db/lake-move.ts; DESIGN.md D167 to D173; option 07, slice 4), against a real lake: a local one (a
// SQLite catalog and a folder) and a Postgres catalog with an S3-compatible store, started as children of this test. What is under test is the copy, the
// proof and the undo, and what DuckLake changes on the way in, with no project and no CLI; the command is cli/commands/move-to-lake.test.ts and the
// journey tests/e2e/j39-lake-move.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { seed, makeProject, cleanup } from "../cli/commands/inspect-testkit.ts";
import { ISSUES_SEED } from "../cli/commands/inspect-testkit.ts";
import { loadProject } from "../project/root.ts";
import { withTrashFile } from "../safety/trash.ts";
import {
  copyIntoLake, fingerprints, inexactColumns, inspectLake, inventoryOf, type MoveMarker, newMoveTag, refuseInexact, refuseMoveTypes, switchLakeOn,
  undoCopy, verifyLake,
} from "./lake-move.ts";
import { lakeRigReady, type LakeRig, openTestLake, startLakeRig, type TestLake, type TestLakeKind } from "./lake-testkit.ts";
import { closeAllWarehouses, openWarehouse } from "./warehouse.ts";

const ready = lakeRigReady();
if (!ready.ready) console.warn(`[lake-move.test] SKIPPING the real-lake tests: ${ready.skipReason}`);
const maybe = ready.ready ? test : test.skip;

let rig: LakeRig | undefined;
const opened: TestLake[] = [];
beforeAll(async () => {
  if (ready.ready) rig = await startLakeRig();
}, 120_000);
afterAll(async () => {
  for (const l of opened) await l.close();
  await closeAllWarehouses();
  await rig?.stop();
  await cleanup();
});

async function fresh(kind: TestLakeKind): Promise<TestLake & { reader: ReturnType<typeof openWarehouse> }> {
  const l = await openTestLake(kind, { extensionDir: ready.dir, ...(rig ? { rig } : {}) });
  opened.push(l);
  // The proof reads with a warehouse of its own (the read-only login and key), allowed the state folder where the backup is.
  const reader = openWarehouse({ path: join(l.root, "reader.duckdb"), mode: "read_only", timezone: "UTC", root: l.root, stateDir: l.stateDir, lake: l.conn, isTTY: false, register: false });
  return Object.assign(l, { reader });
}

/** A file warehouse in the lake's state folder: the issues seed (croft's own records and a table with JSON), and more tables of 400 rows so that a lake
 *  writes Parquet files, with a view, a macro, a sequence, an index, a type and a table of another schema that cannot move. */
async function sourceFile(l: TestLake, extra: string[] = []): Promise<string> {
  const path = join(l.stateDir, "backups", "src", "warehouse.duckdb");
  mkdirSync(join(path, ".."), { recursive: true });
  await seed(path, [
    ...ISSUES_SEED,
    `CREATE TABLE numbers AS SELECT range AS id, range::HUGEINT * 1000003 AS h, (range * 12345678901234567890123)::DECIMAL(38, 0) AS d, 'v' || range AS s,
       {'a': range, 'b': [range, NULL]} AS st, map {'k': range} AS m, ('{"n": ' || range || '}')::JSON AS j, TIMESTAMPTZ '2026-01-02 03:04:05.123456+00' + INTERVAL (range) MINUTE AS ts FROM range(400)`,
    `CREATE VIEW a_view AS SELECT 1 AS x`, `CREATE MACRO a_macro(x) AS x + 1`, `CREATE SEQUENCE a_seq`, `CREATE INDEX numbers_by_s ON numbers (s)`,
    `CREATE TYPE mood AS ENUM ('a', 'b')`, `CREATE SCHEMA other`, `CREATE TABLE other.stray (x INTEGER)`,
    ...extra,
  ]);
  return path;
}

const marker = (tables: { name: string; rows: number }[], sha = "f".repeat(64)): MoveMarker => ({
  v: 1, tag: newMoveTag(), at: "2026-11-02T00:00:00.000Z", croftVersion: "test", fileSha256: sha, fileBytes: 1, tables, bookkeeping: [],
});

for (const kind of ["local", "postgres"] as const) {
  describe(`moving a file into a ${kind} lake`, () => {
    maybe("the inventory of a file: its tables, rows and columns, croft's records, and what cannot move", async () => {
      const l = await fresh(kind);
      const file = await sourceFile(l);
      const inv = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inventoryOf(sql, alias)), { purpose: "test" });
      expect(inv.tables.map((t) => [t.name, t.rows])).toEqual([["github_issues", 3], ["numbers", 400]]);
      expect(inv.tables[0]!.columns.map((c) => c.name)).toEqual(["id", "title", "state", "labels", "user", "updated_at", "_loaded_at"]);
      expect(inv.tables[1]!.columns.find((c) => c.name === "d")!.type).toBe("DECIMAL(38,0)");
      expect(inv.bookkeeping).toEqual([{ table: "assets", rows: 1 }, { table: "columns", rows: 6 }, { table: "inputs", rows: 0 }, { table: "files", rows: 0 }, { table: "writes", rows: 2 }]);
      expect(inv.notMoved.map((n) => n.kind).sort()).toEqual(["index", "macro", "sequence", "table in schema other", "type", "view"]);
      expect(inv.formatVersion).not.toBeNull();
      // A different count is a different generation (what a confirmation is for).
      await seed(file, [`INSERT INTO numbers SELECT 1000, 1, 1, 'x', {'a': 1, 'b': [1]}, map {'k': 1}, '{}'::JSON, now()`]);
      const later = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inventoryOf(sql, alias)), { purpose: "test" });
      expect(later.generation).not.toBe(inv.generation);
    }, 120_000);

    maybe("values a lake would store inexactly are found by value, and the message names the table, the column, the count and the cast", async () => {
      const l = await fresh(kind);
      const file = await sourceFile(l, [
        `CREATE TABLE risky AS SELECT range AS id, range::HUGEINT * 9007199254740993 AS big, range::HUGEINT * 1000 AS fine, (range * 1.0000003)::DOUBLE AS d,
           INTERVAL (range * 1000003) MICROSECOND AS iv, INTERVAL (range) DAY AS days, TIMETZ '10:11:12+02' AS tz, TIMETZ '10:11:12+00' AS utc,
           '340282366920938463463374607431768211455'::UHUGEINT - range::UHUGEINT AS ubig FROM range(5)`,
      ]);
      const found = await l.w.read((sql) => withTrashFile(sql, file, async (alias) => inexactColumns(sql, await inventoryOf(sql, alias), alias)), { purpose: "test" });
      // By the column's type (a lake write refuses it whatever the values), with the values that would change now: none for `fine`, `days` and `utc`.
      expect(found.map((c) => `${c.table}.${c.column}:${c.kind}:${c.values}`)).toEqual([
        "numbers.h:HUGEINT:0", "risky.big:HUGEINT:4", "risky.fine:HUGEINT:0", "risky.iv:INTERVAL:4", "risky.days:INTERVAL:0", "risky.tz:TIMETZ:5", "risky.utc:TIMETZ:0", "risky.ubig:UHUGEINT:5",
      ]);
      let caught: unknown;
      try {
        refuseInexact(found, new Map([["risky", "assets/risky.sql"]]));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CroftError);
      const p = (caught as CroftError).problem;
      expect(p.code).toBe("LAKE_VALUES_INEXACT");
      expect(p.message).toContain("risky.big (HUGEINT): 4 values would change, such as");
      expect(p.message).toContain("numbers.h (HUGEINT)");
      expect(p.hint).toContain("CAST(big AS DECIMAL(38,0)) AS big");
      expect(p.hint).toContain("assets/risky.sql");
      expect(p.hint).toContain("CAST(tz AS VARCHAR) AS tz");
      expect(p.effect).toContain("nothing was changed");
      expect(() => refuseInexact([], new Map())).not.toThrow();
    }, 120_000);

    maybe("every table that has a column a lake cannot store is named at once, with the cast for each", async () => {
      const l = await fresh(kind);
      const file = await sourceFile(l, [
        `CREATE TABLE odd AS SELECT 1 AS id, 'a'::mood AS e, [1, 2]::INTEGER[2] AS pair, '101'::BIT AS bits`,
        `CREATE TABLE odder AS SELECT 1 AS id, union_value(n := 1) AS u`,
      ]);
      const inv = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inventoryOf(sql, alias)), { purpose: "test" });
      let caught: unknown;
      try {
        refuseMoveTypes(inv, new Map([["odd", "assets/odd.sql"]]));
      } catch (e) {
        caught = e;
      }
      const p = (caught as CroftError).problem;
      expect(p.code).toBe("LAKE_TYPE_UNSUPPORTED");
      expect(p.details!.tables).toEqual([
        expect.objectContaining({ table: "odd", file: "assets/odd.sql", columns: expect.arrayContaining([expect.objectContaining({ name: "e", kind: "ENUM" }), expect.objectContaining({ name: "pair", kind: "ARRAY" }), expect.objectContaining({ name: "bits", kind: "BIT" })]) }),
        expect.objectContaining({ table: "odder", columns: [expect.objectContaining({ name: "u", kind: "UNION" })] }),
      ]);
      expect(p.hint).toContain("CAST(pair AS INTEGER[]) AS pair");
    }, 120_000);

    maybe("the copy is one lake transaction; the proof holds it equal row for row; the lake then reads as the file did", async () => {
      const l = await fresh(kind);
      expect((await inspectLake(l.reader)).state).toBe("absent"); // before anything attaches it with the writer, which makes it
      const file = await sourceFile(l);
      const inv = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inventoryOf(sql, alias)), { purpose: "test" });
      const m = marker(inv.tables.map((t) => ({ name: t.name, rows: t.rows })));
      const copied = await copyIntoLake(l.w, file, inv, m, { runId: "r_move", label: "the lake" });
      expect(copied).toMatchObject({ tables: 2, rows: 403, bookkeepingRows: 9 });
      const seen = await inspectLake(l.reader);
      expect(seen).toMatchObject({ state: "marked", unchanged: true, tables: ["github_issues", "numbers"] });
      expect(seen.marker!.tag).toBe(m.tag);
      const proof = await verifyLake(l.reader, file, inv);
      expect(proof).toMatchObject({ differences: [], tables: 2, rows: 403, bookkeepingRows: 9 });
      // The lake's own view of croft's records: the latest rows, in the log adapter's shape.
      const lake = await l.reader.read(async (sql) => ({
        assets: await sql.all<{ name: string }>("SELECT name FROM _croft.assets"),
        meta: Object.fromEntries((await sql.all<{ key: string; value: string }>("SELECT key, value FROM _croft.meta")).map((r) => [r.key, r.value])),
        n: (await sql.all<{ n: number | bigint }>("SELECT count(*) AS n FROM _croft.writes"))[0]!.n,
      }), { purpose: "test" });
      expect(lake.assets).toEqual([{ name: "github_issues" }]);
      expect(Number(lake.n)).toBe(2);
      expect(lake.meta).toMatchObject({ format_version: "4", bookkeeping: "log" });
      expect(JSON.parse(lake.meta.moved_into_lake!)).toMatchObject({ tag: m.tag, fileSha256: m.fileSha256 });
      // A lake that holds a copy is not filled again.
      await expect(copyIntoLake(l.w, file, inv, marker([]), { runId: "r_again", label: "the lake" })).rejects.toMatchObject({ problem: { code: "MOVE_LAKE_NOT_EMPTY" } });
    }, 180_000);

    maybe("a difference is found and named, and the undo takes the copy out only while nothing has written the lake since", async () => {
      const l = await fresh(kind);
      const file = await sourceFile(l);
      const inv = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inventoryOf(sql, alias)), { purpose: "test" });
      const m = marker(inv.tables.map((t) => ({ name: t.name, rows: t.rows })));
      await copyIntoLake(l.w, file, inv, m, { runId: "r_move", label: "the lake" });
      // Someone changes a value in the lake, and the proof says which column of which table.
      await l.w.write("tamper", (tx) => tx.exec("UPDATE numbers SET s = 'changed' WHERE id = 7"), { runId: "r_tamper" });
      const proof = await verifyLake(l.reader, file, inv);
      expect(proof.differences).toEqual([expect.stringContaining("numbers: 1 rows of the file are not in the lake as they were: s (VARCHAR) holds 1 value")]);
      expect(proof.columns).toEqual([{ table: "numbers", column: "s", type: "VARCHAR" }]);
      // The lake was written since the copy: the undo does nothing.
      expect(await undoCopy(l.w, m, { runId: "r_undo" })).toBe(false);
      expect((await inspectLake(l.reader)).state).toBe("marked");

      // A copy nobody wrote over is taken out whole, and the lake is empty again for the next try.
      const l2 = await fresh(kind);
      const file2 = await sourceFile(l2);
      await copyIntoLake(l2.w, file2, inv, m, { runId: "r_move", label: "the lake" });
      expect(await undoCopy(l2.w, m, { runId: "r_undo" })).toBe(true);
      expect(await inspectLake(l2.reader)).toMatchObject({ state: "empty", tables: [], bookkeepingRows: 0, marker: null });
      const again = marker(inv.tables.map((t) => ({ name: t.name, rows: t.rows })));
      await copyIntoLake(l2.w, file2, inv, again, { runId: "r_move2", label: "the lake" });
      expect((await verifyLake(l2.reader, file2, inv)).differences).toEqual([]);
    }, 240_000);

    maybe("what a lake changes on the way in is caught by the proof, also inside a STRUCT, a LIST or a MAP, and names the column", async () => {
      const l = await fresh(kind);
      const file = await sourceFile(l, [
        `CREATE TABLE nested AS SELECT range AS id, {'h': range::HUGEINT * 9007199254740993} AS st, [range::HUGEINT * 9007199254740993] AS lst, {'t': TIMETZ '10:11:12+02'} AS tz FROM range(400)`,
      ]);
      const inv = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inventoryOf(sql, alias)), { purpose: "test" });
      // Found by their type, nested or not (their values are not counted), and, were the move to go on, by the proof.
      const found = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inexactColumns(sql, inv, alias)), { purpose: "test" });
      expect(found.filter((c) => c.table === "nested").map((c) => [c.column, c.kind, c.nested, c.values])).toEqual([["st", "HUGEINT", true, null], ["lst", "HUGEINT", true, null], ["tz", "TIMETZ", true, null]]);
      await copyIntoLake(l.w, file, inv, marker(inv.tables.map((t) => ({ name: t.name, rows: t.rows }))), { runId: "r_move", label: "the lake" });
      const proof = await verifyLake(l.reader, file, inv).catch((e: unknown) => e);
      // A HUGEINT near the top of the range cannot even be read back; these are inside the range, so they read, changed.
      expect(proof).not.toBeInstanceOf(Error);
      const v = proof as Awaited<ReturnType<typeof verifyLake>>;
      expect(v.columns.map((c) => `${c.table}.${c.column}`)).toEqual(["nested.st", "nested.lst", "nested.tz"]);
    }, 240_000);

    maybe("the proof is bit-exact for floating-point columns: a -0.0 that became 0.0 is a difference, a -0.0 that stayed is not", async () => {
      const l = await fresh(kind);
      const file = await sourceFile(l, [
        `CREATE TABLE floaty AS SELECT range AS id, CASE WHEN range = 3 THEN CAST('-0.0' AS DOUBLE) WHEN range = 4 THEN CAST('0.0' AS DOUBLE) WHEN range = 5 THEN CAST('NaN' AS DOUBLE) ELSE range / 7.0 END AS d, CAST(range AS FLOAT) / 3 AS f FROM range(20)`,
      ]);
      const inv = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inventoryOf(sql, alias)), { purpose: "test" });
      await copyIntoLake(l.w, file, inv, marker(inv.tables.map((t) => ({ name: t.name, rows: t.rows }))), { runId: "r_move", label: "the lake" });
      // As copied (the sign of the zero and the NaN included) the lake is the file's.
      expect((await verifyLake(l.reader, file, inv)).differences).toEqual([]);
      // 0.0 where the file has -0.0: equal by value (DuckDB takes them for the same number), not the same bits.
      await l.w.write("tamper", (tx) => tx.exec("UPDATE floaty SET d = CAST('0.0' AS DOUBLE) WHERE id = 3"), { runId: "r_tamper" });
      const proof = await verifyLake(l.reader, file, inv);
      expect(proof.differences).toEqual([expect.stringContaining("floaty: 1 rows hold a floating-point value that is not the file's bits: d (DOUBLE) holds 1 value")]);
      expect(proof.columns).toEqual([{ table: "floaty", column: "d", type: "DOUBLE" }]);
    }, 240_000);

    maybe("the lake reports what it holds: absent, empty, marked, used", async () => {
      const l = await fresh(kind);
      expect((await inspectLake(l.reader)).state).toBe("absent");
      await l.w.write("make", async (tx) => {
        await tx.exec("CREATE TABLE someone_elses (a INTEGER)");
      }, { runId: "r" });
      const used = await inspectLake(l.reader);
      expect(used).toMatchObject({ state: "used", tables: ["someone_elses"], marker: null });
      const file = await sourceFile(l);
      const inv = await l.w.read((sql) => withTrashFile(sql, file, (alias) => inventoryOf(sql, alias)), { purpose: "test" });
      await expect(copyIntoLake(l.w, file, inv, marker([]), { runId: "r", label: "the lake" })).rejects.toMatchObject({ problem: { code: "MOVE_LAKE_NOT_EMPTY", details: { state: "used", tables: ["someone_elses"] } } });
    }, 120_000);
  });
}

describe("fingerprints", () => {
  test("a child process hashes the files, a missing one is null", async () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `croft-fp-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a"), "hello");
    try {
      const [a, b] = await fingerprints([join(dir, "a"), join(dir, "missing")]);
      expect(a).toEqual({ sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", bytes: 5 });
      expect(b).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the switch", () => {
  const project = (text: string) => {
    const p = makeProject({});
    writeFileSync(p.project.paths.config, text);
    return loadProject({ root: p.root });
  };
  const lake = { catalog: { kind: "sqlite", path: "lake/catalog.sqlite" }, dataPath: "lake/data" };

  test("replaces the one token and keeps the rest of the text as it was", () => {
    const text = `{\n  "database": "warehouse.duckdb",\n  "timezone": "America/Los_Angeles",\n  "lake": {\n    "enabled":   false,\n    "catalog": { "kind": "sqlite", "path": "lake/catalog.sqlite" },\n    "dataPath": "lake/data"\n  },\n  "notify": { "desktop": false }\n}\n`;
    const p = project(text);
    expect(p.config.idleLake).not.toBeNull();
    switchLakeOn(p);
    expect(readFileSync(p.paths.config, "utf8")).toBe(text.replace('"enabled":   false', '"enabled":   true'));
    expect(loadProject({ root: p.root }).config.lake).not.toBeNull();
  });

  test("works on compact JSON, and does not touch another key named enabled", () => {
    const text = JSON.stringify({ database: "warehouse.duckdb", timezone: "America/Los_Angeles", serverMode: { enabled: false }, lake: { enabled: false, ...lake, maintenance: { enabled: false } } });
    const p = project(text);
    switchLakeOn(p);
    expect(JSON.parse(readFileSync(p.paths.config, "utf8"))).toEqual({
      database: "warehouse.duckdb", timezone: "America/Los_Angeles", serverMode: { enabled: false }, lake: { enabled: true, ...lake, maintenance: { enabled: false } },
    });
  });

  test("refuses, and changes nothing, when the lake block does not say \"enabled\": false", () => {
    const text = JSON.stringify({ database: "warehouse.duckdb", timezone: "America/Los_Angeles", lake });
    const p = makeProject({});
    writeFileSync(p.project.paths.config, text);
    const project = loadProject({ root: p.root });
    expect(project.config.lake).not.toBeNull(); // on already: no "enabled": false to switch
    expect(() => switchLakeOn(project)).toThrow(/no "enabled": false/);
    expect(readFileSync(project.paths.config, "utf8")).toBe(text);
  });
});

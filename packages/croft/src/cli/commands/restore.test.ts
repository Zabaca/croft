import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { closeAllWarehouses, openWarehouse } from "../../db/warehouse.ts";
import { type CatalogAsset, getCatalog, putCatalog } from "../../history/catalog.ts";
import { listTrash, type TrashEntry, trashTable } from "../../safety/trash.ts";
import { prompter } from "./delete.ts";
import { cleanup, cli, makeProject, runsDb, seed, STATE, type TestProject } from "./inspect-testkit.ts";
import { localTime, pickVersion } from "./restore.ts";

const NOW = "2026-09-22T18:40:00.000Z";
const env = { CROFT_NOW: NOW };
const TZ = "America/Los_Angeles";
const realAsk = prompter.ask;

afterEach(async () => {
  prompter.ask = realAsk;
  await closeAllWarehouses();
});
afterAll(cleanup);

const ORDERS: CatalogAsset = {
  asset: "orders", kind: "ingest", behavior: "updates rows by id", write: "merge", key: ["id"], rows: 5, columns: [],
  cursor: { field: "id", value: "4", type: "integer", unit: null }, lastLoadedAt: "2026-09-20T14:00:00.000000Z", lastReplacedAt: null,
  lastRunId: "r_0920_0700_aaaa", codeHash: "hash-1",
};

/** orders (5 rows, id 0-4), read by daily. */
async function project(): Promise<TestProject> {
  const p = makeProject({ files: { "assets/orders.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ key: "id", async *rows() { yield []; } });\n` } });
  await seed(p.database, [
    ...STATE,
    `CREATE TABLE orders AS SELECT range AS id, range * 10 AS amount, TIMESTAMPTZ '2026-09-20 10:00:00+00' + range * INTERVAL 1 HOUR AS _loaded_at FROM range(5)`,
    `CREATE TABLE daily AS SELECT 1 AS n`,
    `INSERT INTO _croft.assets (name, kind, write_mode, key_columns, cursor_value, row_count, last_loaded_at, max_loaded_at)
       VALUES ('orders', 'ingest', 'merge', ['id'], '4', 5, '2026-09-20 14:00:00+00', '2026-09-20 14:00:00+00')`,
    `INSERT INTO _croft.inputs (asset, input, seen_loaded_at, input_last_loaded_at) VALUES ('daily', 'orders', '2026-09-20 14:00:00+00', '2026-09-20 14:00:00+00')`,
  ]);
  const db = runsDb(p.stateDir);
  putCatalog(db, ORDERS);
  db.close();
  return p;
}

/** Trash orders as it is now, at `at`, as a run would, with croft's own warehouse (then closed). */
async function trashAt(p: TestProject, at: string, reason = "run --allow-shrink (r_0922_1140_a1b2)", asset = "orders"): Promise<TrashEntry> {
  const w = openWarehouse({ path: p.database, mode: "read_write", timezone: TZ, root: p.root, stateDir: p.stateDir, isTTY: false });
  const e = (await trashTable(w, asset, reason, { now: new Date(at) }))!;
  await closeAllWarehouses();
  return e;
}

async function q(database: string, sql: string): Promise<Record<string, unknown>[]> {
  await closeAllWarehouses();
  const db = await DuckDBInstance.create(database, { access_mode: "READ_ONLY" });
  const c = await db.connect();
  try {
    return (await c.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
  } finally {
    c.disconnectSync();
    db.closeSync();
  }
}

const ids = async (p: TestProject) => (await q(p.database, `SELECT id::INT id FROM orders ORDER BY id`)).map((r) => r.id);

describe("croft restore: the trash", () => {
  test("empty", async () => {
    const p = await project();
    const r = await cli(["restore", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(0);
    expect(r.json.data).toEqual({ versions: [], retention: { days: 30, versions: 5 } });
    expect(r.json.next).toEqual([]);
    const human = await cli(["restore"], { cwd: p.root, env });
    expect(human.stdout).toContain("the trash is empty (it keeps versions 30 days, and the 5 newest of each table)");
  });

  test("newest first, times in the project zone, rows, size and why", async () => {
    const p = await project();
    await trashAt(p, "2026-09-20T16:02:00.000Z", "delete (r_0920_0902_dddd)", "daily");
    await trashAt(p, "2026-09-22T18:40:00.123Z");
    const r = await cli(["restore", "--json"], { cwd: p.root, env });
    expect(r.json.data.versions.map((v: { asset: string }) => v.asset)).toEqual(["orders", "daily"]);
    expect(r.json.data.versions[0]).toMatchObject({
      asset: "orders", trashedAt: "2026-09-22T11:40:00.123-07:00", reason: "run --allow-shrink (r_0922_1140_a1b2)", rows: 5, kind: "table", where: null,
    });
    expect(r.json.data.versions[0].bytes).toBeGreaterThan(0);
    const human = await cli(["restore"], { cwd: p.root, env });
    const lines = human.stdout.split("\n");
    expect(lines[0]).toMatch(/^TABLE\s+TRASHED\s+ROWS\s+SIZE\s+WHY$/);
    expect(lines[1]).toMatch(/^orders\s+2026-09-22 11:40\s+5\s+[\d.]+ [KM]B\s+run --allow-shrink \(r_0922_1140_a1b2\)$/);
    expect(lines[2]).toMatch(/^daily\s+2026-09-20 09:02\s+1\s+[\d.]+ [KM]B\s+delete \(r_0920_0902_dddd\)$/);
    expect(human.stdout).toContain("croft restore <table> [--at <time>] brings one back, after confirmation");
  });
});

describe("croft restore <asset>", () => {
  test("off a terminal: a token that names the version exactly; croft confirm restores it and the replaced table goes to the trash", async () => {
    const p = await project();
    const v = await trashAt(p, "2026-09-21T17:00:00.000Z");
    await seed(p.database, [`DELETE FROM orders WHERE id >= 2`, `UPDATE _croft.assets SET row_count = 2 WHERE name = 'orders'`]);
    const r = await cli(["restore", "orders", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(5);
    expect(r.json.data).toMatchObject({ asset: "orders", status: "needs_confirmation", rows: 5, replacedRows: 2, downstream: ["daily"], trashed: null });
    expect(r.json.data.version).toMatchObject({ trashedAt: "2026-09-21T10:00:00.000-07:00", path: v.path });
    expect(r.json.confirmation).toMatchObject({
      command: "croft restore orders --at 2026-09-21T10:00:00.000-07:00",
      impact: { asset: "orders", action: "restore its version of 2026-09-21 10:00:00 (5 rows)", rows: 2, downstream: ["daily"] },
    });
    expect(r.json.problems.map((x: { code: string }) => x.code)).toEqual(["CONFIRMATION_REQUIRED"]);
    expect(r.json.next).toEqual([]);
    expect(await ids(p)).toEqual([0, 1]);

    const done = await cli(["confirm", r.json.confirmation.token, "--json"], { cwd: p.root, env });
    expect(done.exit).toBe(0);
    expect(done.json.data.outcome).toBe("used");
    expect(done.json.data.result).toMatchObject({ status: "restored", rows: 5, replacedRows: 2, rowsAfter: 5, trashed: { rows: 2 } });
    expect(done.json.next).toEqual([{ command: "croft run daily", reason: "they read orders, which was restored" }]);
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
    expect(listTrash(p.stateDir, "orders").map((e) => e.reason)).toEqual([`replaced by restore (${done.json.data.result.runId})`, "run --allow-shrink (r_0922_1140_a1b2)"]);
    const db = runsDb(p.stateDir);
    try {
      const entry = getCatalog(db, "orders")!;
      expect(entry).toMatchObject({ rows: 5, behavior: "updates rows by id", lastRunId: done.json.data.result.runId });
      expect(entry.lastReplacedAt).not.toBeNull();
      expect(db.latestStep("orders")).toMatchObject({ status: "ok", reason: "restored" });
      expect(db.getRun(done.json.data.result.runId)).toMatchObject({ trigger: "confirm", argv: ["restore", "orders", "--at", "2026-09-21T10:00:00.000-07:00"] });
    } finally {
      db.close();
    }
  });

  test("delete, then restore: the table and its state come back, and so does its catalog entry", async () => {
    const p = await project();
    const del = await cli(["delete", "orders", "--json"], { cwd: p.root, env });
    expect((await cli(["confirm", del.json.confirmation.token, "--json"], { cwd: p.root, env })).exit).toBe(0);
    const r = await cli(["restore", "orders", "--json"], { cwd: p.root, env });
    expect(r.json.data).toMatchObject({ rows: 5, replacedRows: null });
    expect(r.json.confirmation.impact).toMatchObject({ rows: 0 });
    expect(r.json.confirmation.impact.trashPath).toBeUndefined();
    const done = await cli(["confirm", r.json.confirmation.token, "--json"], { cwd: p.root, env });
    expect(done.exit).toBe(0);
    expect(done.json.data.result).toMatchObject({ status: "restored", trashed: null, rowsAfter: 5 });
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
    expect(await q(p.database, `SELECT cursor_value FROM _croft.assets WHERE name = 'orders'`)).toEqual([{ cursor_value: "4" }]);
    const db = runsDb(p.stateDir);
    try {
      expect(getCatalog(db, "orders")).toMatchObject({ rows: 5, behavior: "updates rows by id", cursor: { field: "id", value: "4" } });
    } finally {
      db.close();
    }
  });

  test("the rows of a delete --where go back into the table", async () => {
    const p = await project();
    const del = await cli(["delete", "orders", "--where", "amount >= 30", "--json"], { cwd: p.root, env });
    await cli(["confirm", del.json.confirmation.token, "--json"], { cwd: p.root, env });
    expect(await ids(p)).toEqual([0, 1, 2]);
    const r = await cli(["restore", "orders", "--json"], { cwd: p.root, env });
    expect(r.json.data).toMatchObject({ rows: 2, skipped: 0, replacedRows: 3 });
    expect(r.json.data.version).toMatchObject({ kind: "rows", where: "amount >= 30" });
    expect(r.json.confirmation.impact.action).toMatch(/^put back the rows deleted from it at 2026-09-22 11:40:00$/);
    const human = await cli(["restore", "orders"], { cwd: p.root, env });
    expect(human.exit).toBe(5);
    expect(human.stdout).toContain("needs confirmation: restore orders: put back the 2 rows deleted from it at 2026-09-22 11:40:00\n  first: the current 3 rows of orders go to the trash");
    const done = await cli(["confirm", r.json.confirmation.token], { cwd: p.root, env });
    expect(done.exit).toBe(0);
    expect(done.stdout).toContain("ok    orders   put back 2 rows deleted at 2026-09-22 11:40:00; 5 rows now");
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
  });

  test("the version is pinned: a newer version trashed after the token does not change what it restores", async () => {
    const p = await project();
    await trashAt(p, "2026-09-21T17:00:00.000Z");
    await seed(p.database, [`DELETE FROM orders WHERE id >= 3`, `UPDATE _croft.assets SET row_count = 3 WHERE name = 'orders'`]);
    const r = await cli(["restore", "orders", "--json"], { cwd: p.root, env });
    // Another version, newer, of the same table as it is now (3 rows).
    await trashAt(p, "2026-09-22T17:00:00.000Z", "a newer one");
    const done = await cli(["confirm", r.json.confirmation.token, "--json"], { cwd: p.root, env });
    expect(done.exit).toBe(0);
    expect(done.json.data.result.version.trashedAt).toBe("2026-09-21T10:00:00.000-07:00");
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
  });

  test("on a terminal it asks y/N", async () => {
    const p = await project();
    await trashAt(p, "2026-09-21T17:00:00.000Z");
    await seed(p.database, [`DELETE FROM orders WHERE id >= 2`, `UPDATE _croft.assets SET row_count = 2 WHERE name = 'orders'`]);
    const asked: string[] = [];
    prompter.ask = async (question) => {
      asked.push(question);
      return false;
    };
    const no = await cli(["restore", "orders"], { cwd: p.root, env, stdinTTY: true, stdoutTTY: true });
    expect(no.exit).toBe(1);
    expect(asked[0]).toBe("restore orders to its version of 2026-09-21 10:00:00: 5 rows\n  first: the current 2 rows of orders go to the trash\n"
      + "  then:  daily go stale: the next croft run rebuilds them\nProceed? [y/N] ");
    expect(await ids(p)).toEqual([0, 1]);
    prompter.ask = async () => true;
    const yes = await cli(["restore", "orders"], { cwd: p.root, env, stdinTTY: true, stdoutTTY: true });
    expect(yes.exit).toBe(0);
    expect(yes.stdout).toContain("ok    orders   restored the version of 2026-09-21 10:00:00: 5 rows");
    expect(yes.stdout).toMatch(/the table it replaced \(2 rows\) is in the trash: \.croft\/trash\/orders\/20260922T184000\.000Z\.duckdb/);
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
  });

  test("refusals: nothing in the trash, --at without an asset, a pattern, a time that picks nothing or several", async () => {
    const p = await project();
    await trashAt(p, "2026-09-22T18:40:05.000Z");
    await trashAt(p, "2026-09-22T18:40:30.000Z");
    for (const [argv, text] of [
      [["restore", "order"], "the trash holds nothing of order"],
      [["restore", "--at", "2026-09-22 11:40"], "name the asset too"],
      [["restore", "ord*"], "not a pattern"],
      [["restore", "orders", "--at", "2026-09-22 11:40"], "2 versions of orders match"],
      [["restore", "orders", "--at", "2026-09-21"], "no version of orders from 2026-09-21"],
      [["restore", "orders", "--at", "yesterday"], "is not a time"],
    ] as const) {
      const r = await cli([...argv, "--json"], { cwd: p.root, env });
      expect(r.exit, argv.join(" ")).toBe(2);
      expect(r.json.problems[0].code, argv.join(" ")).toBe("USAGE_ERROR");
      expect(r.json.problems[0].message, argv.join(" ")).toContain(text);
      expect(r.json.problems[0].fix, argv.join(" ")).toBeDefined();
    }
    expect((await cli(["restore", "order", "--json"], { cwd: p.root, env })).json.problems[0].hint).toContain("did you mean orders?");
    const several = await cli(["restore", "orders", "--at", "2026-09-22 11:40", "--json"], { cwd: p.root, env });
    expect(several.json.problems[0].hint).toContain(`--at "2026-09-22 11:40:30.000"`);
    const one = await cli(["restore", "orders", "--at", "2026-09-22 11:40:05", "--json"], { cwd: p.root, env });
    expect(one.exit).toBe(5);
    expect(one.json.data.version.trashedAt).toBe("2026-09-22T11:40:05.000-07:00");
  });
});

describe("pickVersion", () => {
  const v = (asset: string, trashedAt: string, stamp: string): TrashEntry => ({
    asset, path: `/s/trash/${asset}/${stamp}.duckdb`, trashedAt, reason: "x", runId: null, rows: 1, bytes: 1, croftVersion: "t", kind: "table", where: null,
  });
  const list = [
    v("a", "2026-09-22T18:40:30.000Z", "20260922T184030.000Z"),
    v("a", "2026-09-22T18:40:05.000Z", "20260922T184005.000Z-2"),
    v("a", "2026-09-22T18:40:05.000Z", "20260922T184005.000Z"),
    v("a", "2026-09-20T16:02:00.000Z", "20260920T160200.000Z"),
  ];

  test("the latest without --at; the list's minute, a second, an ISO time with an offset, or the file name", () => {
    expect(pickVersion(list, "a", undefined, TZ)).toBe(list[0]!);
    expect(pickVersion(list, "a", "2026-09-20 09:02", TZ)).toBe(list[3]!);
    expect(pickVersion(list, "a", "2026-09-20T09:02", TZ)).toBe(list[3]!);
    expect(pickVersion(list, "a", "2026-09-22 11:40:30", TZ)).toBe(list[0]!);
    expect(pickVersion(list, "a", "2026-09-22T18:40:30Z", TZ)).toBe(list[0]!);
    expect(pickVersion(list, "a", "2026-09-22T11:40:30.000-07:00", TZ)).toBe(list[0]!);
    expect(pickVersion(list, "a", "20260922T184005.000Z-2", TZ)).toBe(list[1]!);
    expect(() => pickVersion(list, "a", "2026-09-22 11:40:05", TZ)).toThrow("2 versions of a match");
    expect(localTime("2026-09-22T18:40:05.007Z", TZ)).toBe("2026-09-22 11:40:05.007");
  });
});

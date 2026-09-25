import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { type CatalogAsset, getCatalog, putCatalog } from "../../history/catalog.ts";
import { listLeases, tryAcquire } from "../../history/leases.ts";
import { cliEnv, cli as spawnCli } from "../../run/testkit.ts";
import { listTrash, versionNote } from "../../safety/trash.ts";
import { deleteCommand, MAINTAIN_WAITS, prompter } from "./delete.ts";
import { cleanup, cli, DEAD, makeProject, runsDb, seed, STATE, type TestProject, writeFiles } from "./inspect-testkit.ts";

const NOW = "2026-09-22T18:40:00.000Z";
const env = { CROFT_NOW: NOW };
const realAsk = prompter.ask;
const waits = { ...MAINTAIN_WAITS };

afterEach(async () => {
  prompter.ask = realAsk;
  Object.assign(MAINTAIN_WAITS, waits);
  await closeAllWarehouses();
});
afterAll(cleanup);

const ORDERS: CatalogAsset = {
  asset: "orders", kind: "ingest", behavior: "updates rows by id", write: "merge", key: ["id"], rows: 5, columns: [],
  cursor: { field: "id", value: "4", type: "integer", unit: null }, lastLoadedAt: "2026-09-20T14:00:00.000000Z", lastReplacedAt: null,
  lastRunId: "r_0920_0700_aaaa", codeHash: "hash-1",
};

/** orders (5 rows, id 0-4, amount = 10 × id) as croft built it, read by daily. */
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

/** Read the warehouse with a private instance, after croft's own are closed. */
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

describe("croft delete <asset>", () => {
  test("off a terminal it changes nothing: exit 5 with a token, the impact, and no destructive next", async () => {
    const p = await project();
    const r = await cli(["delete", "orders", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(5);
    expect(r.json.ok).toBe(false);
    expect(r.json.data).toMatchObject({ asset: "orders", where: null, status: "needs_confirmation", rows: 5, rowsBefore: 5, downstream: ["daily"], trashed: null, runId: null });
    expect(r.json.confirmation).toMatchObject({ command: "croft delete orders", impact: { asset: "orders", action: "delete the whole table", rows: 5, downstream: ["daily"] } });
    expect(r.json.confirmation.token).toMatch(/^c_[0-9a-f]{6}$/);
    expect(r.json.confirmation.impact.trashPath).toContain(".croft/trash/orders/");
    expect(r.json.problems.map((x: { code: string }) => x.code)).toEqual(["CONFIRMATION_REQUIRED"]);
    expect(r.json.problems[0].fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(r.json.next).toEqual([]);
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
    expect(listTrash(p.stateDir)).toEqual([]);
    const db = runsDb(p.stateDir);
    expect(db.listRuns()).toEqual([]);
    db.close();
  });

  test("croft confirm carries it out: the table and its state go to the trash, the catalog entry goes, the run is recorded", async () => {
    const p = await project();
    const token = (await cli(["delete", "orders", "--json"], { cwd: p.root, env })).json.confirmation.token as string;
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(0);
    expect(r.json.data.outcome).toBe("used");
    expect(r.json.data.result).toMatchObject({ asset: "orders", status: "deleted", rows: 5, rowsAfter: 0, downstream: ["daily"], trashed: { rows: 5 } });
    expect(r.json.next).toEqual([{ command: "croft status", reason: "see daily, which read orders" }]);
    const tables = await q(p.database, `SELECT table_name t FROM duckdb_tables() WHERE schema_name = 'main' ORDER BY 1`);
    expect(tables).toEqual([{ t: "daily" }]);
    expect(await q(p.database, `SELECT count(*)::INT n FROM _croft.assets WHERE name = 'orders'`)).toEqual([{ n: 0 }]);
    const [v] = listTrash(p.stateDir, "orders");
    expect(v).toMatchObject({ rows: 5, kind: "table", path: r.json.data.result.trashed.path });
    // The asset is never built now; its mirror entry waits with the trashed version.
    const db = runsDb(p.stateDir);
    try {
      expect(getCatalog(db, "orders")).toBeNull();
      expect(versionNote(v!.path, "catalog")).toMatchObject({ asset: "orders", behavior: "updates rows by id" });
      const run = db.getRun(r.json.data.result.runId)!;
      expect(run).toMatchObject({ trigger: "confirm", human: true, argv: ["delete", "orders"], status: "succeeded" });
      const step = db.latestStep("orders")!;
      expect(step).toMatchObject({ runId: run.id, status: "ok", reason: "deleted" });
      expect(readFileSync(step.logPath!, "utf8")).toContain("deleted orders, the whole table (5 rows)");
      expect(listLeases(db).some((l) => l.asset === "orders")).toBe(false);
    } finally {
      db.close();
    }
    // The token is spent.
    const again = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(again.exit).toBe(5);
    expect(again.json.problems[0].code).toBe("CONFIRMATION_STALE");
  });

  test("the impact is counted again at confirmation: a table that changed meanwhile is CONFIRMATION_STALE, and nothing is deleted", async () => {
    const p = await project();
    const token = (await cli(["delete", "orders", "--json"], { cwd: p.root, env })).json.confirmation.token as string;
    await closeAllWarehouses();
    await seed(p.database, [`INSERT INTO orders VALUES (5, 50, now())`]);
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(5);
    expect(r.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "impact_changed" } });
    expect(r.json.problems[0].message).toContain("6 rows");
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(listTrash(p.stateDir)).toEqual([]);
  });

  test("human output: the impact, the trash first, what reads it, and the confirm line", async () => {
    const p = await project();
    const r = await cli(["delete", "orders"], { cwd: p.root, env });
    expect(r.exit).toBe(5);
    const token = /croft confirm (c_[0-9a-f]{6})/.exec(r.stdout)![1]!;
    expect(r.stdout).toContain([
      "needs confirmation: delete orders, the whole table: 5 rows",
      "  first: the 5 rows go to the trash (croft restore orders brings them back)",
      "  then:  daily read it: they keep their tables, and croft run skips them until orders is built again",
      "         the scheduler leaves orders alone from now on: only croft run orders, by hand, builds it again, fetching its whole history from the source",
      `  ask the user; if they agree: croft confirm ${token}    (valid 15 min)`,
    ].join("\n"));
    expect(r.stdout).toContain(`error CONFIRMATION_REQUIRED  orders\n      needs confirmation: delete orders, the whole table: 5 rows\n`
      + `      fix: first the 5 rows go to the trash (croft restore orders brings them back); then the scheduler leaves orders alone from now on: `
      + `only croft run orders, by hand, builds it again, fetching its whole history from the source; ask the user, and only if they agree: croft confirm ${token} (valid 15 min)`);
    const done = await cli(["confirm", token], { cwd: p.root, env });
    expect(done.exit).toBe(0);
    expect(done.stdout).toContain("ok    orders   deleted the whole table (5 rows)");
    expect(done.stdout).toMatch(/in the trash: \.croft\/trash\/orders\/20260922T184000\.000Z\.duckdb \(croft restore orders brings it back\)/);
    expect(done.stdout).toContain("      the scheduler leaves orders alone from now on: only croft run orders, by hand, builds it again");
  });

  test("on a terminal it asks y/N: yes deletes at once, no changes nothing", async () => {
    const p = await project();
    const asked: string[] = [];
    prompter.ask = async (question) => {
      asked.push(question);
      return false;
    };
    const no = await cli(["delete", "orders"], { cwd: p.root, env, stdinTTY: true, stdoutTTY: true });
    expect(no.exit).toBe(1);
    expect(no.stdout).toContain("not deleted: delete orders, the whole table: 5 rows was not confirmed; nothing was changed");
    expect(asked[0]).toBe("delete orders, the whole table: 5 rows\n  first: the 5 rows go to the trash (croft restore orders brings them back)\n"
      + "  then:  daily read it: they keep their tables, and croft run skips them until orders is built again\n"
      + "         the scheduler leaves orders alone from now on: only croft run orders, by hand, builds it again, fetching its whole history from the source\nProceed? [y/N] ");
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);

    prompter.ask = async () => true;
    const yes = await cli(["delete", "orders", "--where", "id = 0"], { cwd: p.root, env, stdinTTY: true, stdoutTTY: true });
    expect(yes.exit).toBe(0);
    expect(yes.stdout).toContain("ok    orders   deleted 1 row where id = 0; 4 rows left");
    expect(await ids(p)).toEqual([1, 2, 3, 4]);
    const db = runsDb(p.stateDir);
    expect(db.listRuns()[0]).toMatchObject({ trigger: "manual", argv: ["delete", "orders", "--where", "id = 0"] });
    db.close();
    // --json never asks: it issues a token.
    prompter.ask = async () => {
      throw new Error("asked");
    };
    const json = await cli(["delete", "orders", "--json"], { cwd: p.root, env, stdinTTY: true, stdoutTTY: true });
    expect(json.exit).toBe(5);
  });
});

describe("croft delete <asset> --where", () => {
  test("the rows it matches: a token, then the rows go to the trash and are deleted; the mirror follows", async () => {
    const p = await project();
    const r = await cli(["delete", "orders", "--where", "amount >= 30", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(5);
    expect(r.json.confirmation.command).toBe("croft delete orders --where 'amount >= 30'");
    expect(r.json.confirmation.impact).toMatchObject({ action: "delete the rows where amount >= 30", rows: 2 });
    expect(r.json.data).toMatchObject({ where: "amount >= 30", rows: 2, rowsBefore: 5 });
    const done = await cli(["confirm", r.json.confirmation.token, "--json"], { cwd: p.root, env });
    expect(done.exit).toBe(0);
    expect(done.json.data.result).toMatchObject({ status: "deleted", rows: 2, rowsAfter: 3, trashed: { rows: 2 } });
    expect(await ids(p)).toEqual([0, 1, 2]);
    expect(listTrash(p.stateDir, "orders")[0]).toMatchObject({ kind: "rows", where: "amount >= 30", rows: 2 });
    const db = runsDb(p.stateDir);
    try {
      const entry = getCatalog(db, "orders")!;
      expect(entry).toMatchObject({ rows: 3, behavior: "updates rows by id", cursor: { field: "id", value: "4" }, lastRunId: done.json.data.result.runId });
      expect(entry.lastReplacedAt).not.toBeNull();
      expect(db.latestStep("orders")).toMatchObject({ status: "ok", reason: "deleted rows" });
    } finally {
      db.close();
    }
  });

  test("quotes in the condition survive the round trip through croft confirm", async () => {
    const p = await project();
    await seed(p.database, [`ALTER TABLE orders ADD COLUMN state VARCHAR`, `UPDATE orders SET state = CASE WHEN id < 2 THEN 'it''s open' ELSE 'closed' END`]);
    const where = `state = 'it''s open'`;
    expect(deleteCommand("orders", where)).toBe(`croft delete orders --where 'state = '\\''it'\\'''\\''s open'\\'''`);
    const r = await cli(["delete", "orders", "--where", where, "--json"], { cwd: p.root, env });
    expect(r.json.data.rows).toBe(2);
    const done = await cli(["confirm", r.json.confirmation.token, "--json"], { cwd: p.root, env });
    expect(done.json.data.result).toMatchObject({ status: "deleted", where, rows: 2 });
    expect(await ids(p)).toEqual([2, 3, 4]);
  });

  test("a condition that matches nothing has nothing to confirm", async () => {
    const p = await project();
    const r = await cli(["delete", "orders", "--where", "amount > 1000", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(0);
    expect(r.json.data).toMatchObject({ status: "nothing_matched", rows: 0, rowsBefore: 5 });
    expect(r.json.confirmation).toBeUndefined();
    const human = await cli(["delete", "orders", "--where", "amount > 1000"], { cwd: p.root, env });
    expect(human.stdout).toContain("nothing to delete: --where amount > 1000 matches none of the 5 rows of orders; nothing was changed");
  });

  test("a condition that is not one SQL expression over the table is refused, with the columns", async () => {
    const p = await project();
    const semi = await cli(["delete", "orders", "--where", "id > 1; DROP TABLE daily", "--json"], { cwd: p.root, env });
    expect(semi.exit).toBe(2);
    expect(semi.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", effect: "nothing was changed" });
    const col = await cli(["delete", "orders", "--where", "amont > 1", "--json"], { cwd: p.root, env });
    expect(col.exit).toBe(2);
    expect(col.json.problems[0].code).toBe("UNKNOWN_COLUMN");
    expect(col.json.problems[0].hint).toContain("did you mean amount?");
    const empty = await cli(["delete", "orders", "--where", "  ", "--json"], { cwd: p.root, env });
    expect(empty.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", message: "--where is empty" });
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("croft delete: the scheduler, readers and tokens (R41-06, R41-11)", () => {
  test("a whole-table delete holds the asset from the scheduler: its approved code goes to the trash with it, and a restore brings it back", async () => {
    const p = await project();
    let db = runsDb(p.stateDir);
    db.approveCode("orders", "hash-1");
    db.close();
    const r = await cli(["delete", "orders"], { cwd: p.root, env });
    expect(r.stdout).toContain("  then:  daily read it: they keep their tables, and croft run skips them until orders is built again\n"
      + "         the scheduler leaves orders alone from now on: only croft run orders, by hand, builds it again, fetching its whole history from the source");
    const token = /croft confirm (c_[0-9a-f]{6})/.exec(r.stdout)![1]!;
    const json = await cli(["delete", "orders", "--json"], { cwd: p.root, env });
    expect(json.json.problems[0].hint).toContain("then the scheduler leaves orders alone from now on");
    const done = await cli(["confirm", json.json.confirmation.token, "--json"], { cwd: p.root, env });
    expect(done.exit).toBe(0);
    expect(done.json.data.result).toMatchObject({ status: "deleted", held: true });
    // The other token for the same command no longer applies.
    const other = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(other.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "superseded" } });
    db = runsDb(p.stateDir);
    try {
      expect(db.approvedCode("orders")).toBeNull();
      const [v] = listTrash(p.stateDir, "orders");
      expect(versionNote(v!.path, "approvedCodeHash")).toBe("hash-1");
    } finally {
      db.close();
    }
    const human = await cli(["restore", "orders", "--json"], { cwd: p.root, env });
    expect((await cli(["confirm", human.json.confirmation.token, "--json"], { cwd: p.root, env })).exit).toBe(0);
    db = runsDb(p.stateDir);
    try {
      expect(db.approvedCode("orders")).toBe("hash-1");
    } finally {
      db.close();
    }
  });

  test("a delete confirmed on a terminal spends the open tokens for the same command", async () => {
    const p = await project();
    const token = (await cli(["delete", "orders", "--where", "id = 0", "--json"], { cwd: p.root, env })).json.confirmation.token as string;
    prompter.ask = async () => true;
    expect((await cli(["delete", "orders", "--where", "id = 0"], { cwd: p.root, env, stdinTTY: true, stdoutTTY: true })).exit).toBe(0);
    const stale = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(stale.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "superseded" } });
    expect(await ids(p)).toEqual([1, 2, 3, 4]);
  });

  test("a token minted before the table was written is stale, although the rows it would delete are as many", async () => {
    const p = await project();
    const token = (await cli(["delete", "orders", "--where", "id < 2", "--json"], { cwd: p.root, env })).json.confirmation.token as string;
    await closeAllWarehouses();
    await seed(p.database, [`UPDATE orders SET amount = amount + 1`, `UPDATE _croft.assets SET last_loaded_at = '2026-09-21 00:00:00+00' WHERE name = 'orders'`]);
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(r.json.problems[0]).toMatchObject({ code: "CONFIRMATION_STALE", details: { reason: "impact_changed" } });
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
  });

  test("a change made outside croft is reported by the delete that takes it in", async () => {
    const p = await project();
    await seed(p.database, [`INSERT INTO orders VALUES (9, 90, TIMESTAMPTZ '2026-09-20 12:00:00+00')`]);
    const token = (await cli(["delete", "orders", "--where", "id = 0", "--json"], { cwd: p.root, env })).json.confirmation.token as string;
    const r = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(0);
    expect(r.json.problems.map((x: { code: string }) => x.code)).toEqual(["OUT_OF_BAND_CHANGE"]);
  });

  test("an incremental TS transform that read the rows is named with --rebuild in the text, never in next", async () => {
    const p = await project();
    writeFiles(p.root, {
      "assets/triage.ts": `import { transform } from "@zabaca/croft";\nexport default transform({ inputs: ["orders"], key: "id", incremental: true, async *rows() { yield []; } });\n`,
    });
    await seed(p.database, [`INSERT INTO _croft.inputs (asset, input, seen_loaded_at) VALUES ('triage', 'orders', '2026-09-20 14:00:00+00')`]);
    const r = await cli(["delete", "orders", "--where", "id = 0"], { cwd: p.root, env });
    expect(r.stdout).toContain("  then:  daily go stale: the next croft run rebuilds them\n"
      + "         triage keeps what it made from the deleted rows: croft run triage --rebuild redoes it (it asks first)");
    const token = /croft confirm (c_[0-9a-f]{6})/.exec(r.stdout)![1]!;
    const done = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(done.json.next.map((n: { command: string }) => n.command)).toEqual(["croft status"]);
    expect(JSON.stringify(done.json.next)).not.toContain("--rebuild\"");
  });
});

describe("croft delete: names and leases", () => {
  test("exact names only: a pattern, a bad name and no name are USAGE_ERROR; a table that is not there is UNKNOWN_TABLE", async () => {
    const p = await project();
    for (const [argv, code, text] of [
      [["delete", "orders*"], "USAGE_ERROR", "not a pattern"],
      [["delete", "ord?rs"], "USAGE_ERROR", "not a pattern"],
      [["delete", "Orders"], "USAGE_ERROR", "not an asset name"],
      [["delete", "_croft"], "USAGE_ERROR", "not an asset name"],
      [["delete"], "USAGE_ERROR", "needs the name of one asset"],
      [["delete", "order"], "UNKNOWN_TABLE", "no table named order"],
    ] as const) {
      const r = await cli([...argv, "--json"], { cwd: p.root, env });
      expect(r.exit, argv.join(" ")).toBe(2);
      expect(r.json.problems[0].code, argv.join(" ")).toBe(code);
      expect(r.json.problems[0].message, argv.join(" ")).toContain(text);
      expect(r.json.problems[0].fix, argv.join(" ")).toBeDefined();
    }
    const guess = await cli(["delete", "order", "--json"], { cwd: p.root, env });
    expect(guess.json.problems[0].hint).toContain("did you mean orders?");
    const extra = await cli(["delete", "orders", "daily", "--json"], { cwd: p.root, env });
    expect(extra.exit).toBe(2);
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
  });

  test("a project with no warehouse yet has no table to delete", async () => {
    const p = makeProject();
    const r = await cli(["delete", "orders", "--json"], { cwd: p.root, env });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({ code: "UNKNOWN_TABLE" });
    expect(existsSync(p.database)).toBe(false);
  });

  test("a run that holds the asset makes it wait, then ASSET_BUSY; the token stays unused. A dead holder's lease is taken over", async () => {
    const p = await project();
    MAINTAIN_WAITS.offTtyMs = 50;
    const token = (await cli(["delete", "orders", "--json"], { cwd: p.root, env })).json.confirmation.token as string;
    let db = runsDb(p.stateDir);
    expect(tryAcquire(db, "orders", "r_0922_1100_live").ok).toBe(true);
    db.close();
    const busy = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(busy.exit).toBe(4);
    expect(busy.json.problems[0]).toMatchObject({ code: "ASSET_BUSY", runId: "r_0922_1100_live" });
    expect(busy.json.data.outcome).toBe("unused");
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);

    db = runsDb(p.stateDir);
    db.sqlite.query("DELETE FROM leases").run();
    expect(tryAcquire(db, "orders", "r_0922_1100_dead", DEAD).ok).toBe(true);
    db.close();
    const done = await cli(["confirm", token, "--json"], { cwd: p.root, env });
    expect(done.exit).toBe(0);
    expect(done.json.data.outcome).toBe("used");
  });

  test("kill -9 between the trash and the drop: the table is as it was, plus a copy in the trash; the next command reconciles", async () => {
    const p = await project();
    const token = (await cli(["delete", "orders", "--json"], { cwd: p.root, env })).json.confirmation.token as string;
    await closeAllWarehouses();
    const killed = await spawnCli(p.root, ["confirm", token, "--json"], cliEnv({ CROFT_FAULT: "between_trash_and_drop" }));
    expect(killed.signal).toBe("SIGKILL");
    expect(await ids(p)).toEqual([0, 1, 2, 3, 4]);
    expect(listTrash(p.stateDir, "orders")).toHaveLength(1);
    let db = runsDb(p.stateDir);
    const dead = db.listRuns()[0]!;
    expect(dead).toMatchObject({ status: "running", argv: ["delete", "orders"] });
    db.close();
    // The spent token is refused; a new one goes through, after reconcile marked the dead run crashed.
    expect((await cli(["confirm", token, "--json"], { cwd: p.root, env })).json.problems[0].code).toBe("CONFIRMATION_STALE");
    const again = (await cli(["delete", "orders", "--json"], { cwd: p.root, env })).json.confirmation.token as string;
    expect((await cli(["confirm", again, "--json"], { cwd: p.root, env })).exit).toBe(0);
    expect(listTrash(p.stateDir, "orders")).toHaveLength(2);
    db = runsDb(p.stateDir);
    try {
      expect(db.getRun(dead.id)!.status).toBe("crashed");
      expect(listLeases(db)).toEqual([]);
    } finally {
      db.close();
    }
  }, 30_000);
});

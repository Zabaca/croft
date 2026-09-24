import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Check, ColumnPlan, Sql, ValueKind } from "../core/types.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import type { TypedBatch } from "../load/contract.ts";
import { quoteIdent, readTableSchema } from "../load/evolve.ts";
import { type WriteBatchInput, type WriteResult, writeBatch } from "../load/write.ts";
import { parseChecks } from "./parse.ts";
import { checksHook, renderRow, runWarnings, SAMPLE_ROWS } from "./run.ts";

afterAll(() => closeAllWarehouses());

const T0 = "2026-09-22T10:00:00Z";
const T1 = "2026-09-22T11:00:00Z";
const T2 = "2026-09-22T12:00:00Z";
const FILE = "assets/orders.sql";

function warehouse(): DuckWarehouse {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-checks-")));
  mkdirSync(join(root, ".croft"));
  mkdirSync(join(root, "files"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone: "UTC", root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

type Rows = Record<string, unknown>[];
const COLUMNS: Record<string, string> = { id: "BIGINT", email: "VARCHAR", amount: "BIGINT", author: "VARCHAR", updated_at: "TIMESTAMPTZ" };

function kindOf(v: unknown): ValueKind {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "float";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return "iso_instant";
  return "string";
}

let seq = 0;
/** A typed batch the way cast.ts leaves it: a TEMP table with the given columns (typed as COLUMNS), plus plans. */
async function makeBatch(tx: Sql, asset: string, rows: Rows, o: { columns?: string[]; cursor?: boolean } = {}): Promise<TypedBatch> {
  const temp = `checks_batch_${++seq}`;
  const names = o.columns ?? ["id", "email", "amount", "author"];
  const defs = [...names.map((n) => `${quoteIdent(n)} ${COLUMNS[n]}`), ...(o.cursor ? [`"__raw" VARCHAR`] : []), `"_croft_seq" BIGINT`];
  await tx.exec(`CREATE TEMP TABLE ${quoteIdent(temp)} (${defs.join(", ")})`);
  for (const [i, row] of rows.entries()) {
    const values = [...names.map((n) => row[n] ?? null), ...(o.cursor ? [row.updated_at === undefined ? null : String(row.updated_at)] : []), i + 1];
    await tx.exec(`INSERT INTO temp.main.${quoteIdent(temp)} VALUES (${values.map((_, j) => `$${j + 1}`).join(", ")})`, values);
  }
  const real = (await readTableSchema(tx, asset)) ?? [];
  const plans: ColumnPlan[] = names.map((n) => {
    const had = real.find((c) => c.name.toLowerCase() === n.toLowerCase());
    return { column: n, sourceName: n, existing: had?.type ?? null, incoming: [...new Set(rows.map((r) => kindOf(r[n])))], decision: had ? "keep" : "add", target: COLUMNS[n] };
  });
  return {
    temp, columns: plans, rows: rows.length, warnings: [],
    cursor: o.cursor ? { field: "updated_at", type: "timestamp", rawTextColumn: "__raw" } : undefined,
  };
}

interface Load extends Omit<WriteBatchInput, "batch" | "target"> {
  write?: "replace" | "append" | "merge";
  key?: string[];
  columns?: string[];
  cursor?: boolean;
}

function load(w: DuckWarehouse, asset: string, rows: Rows, o: Load = {}): Promise<WriteResult> {
  const { write = "replace", key = [], columns, cursor, ...rest } = o;
  const runId = `r_${seq + 1}`;
  return w.write(asset, async (tx) => {
    const batch = await makeBatch(tx, asset, rows, { columns, cursor });
    return writeBatch(tx, { batch, target: { asset, write, key, runId }, kind: "sql", ...rest });
  }, { runId });
}

const read = <T = Record<string, unknown>>(w: DuckWarehouse, sql: string, params?: unknown[]) => w.read((db) => db.all<T>(sql, params), { purpose: "test" });

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const checksOf = (o: { key?: string[]; checks?: string[]; warnings?: string[] }) => {
  const r = parseChecks({ asset: "orders", file: FILE, key: o.key ?? [], checks: o.checks ?? [], warnings: o.warnings ?? [] });
  expect(r.problems).toEqual([]);
  return r.checks;
};
const hook = (checks: Check[], previous?: readonly string[] | null) => checksHook(checks, { file: FILE, previous });
const people = (n: number, f: (i: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, email: `p${i + 1}@x.io`, amount: 10 * (i + 1), author: `a${i + 1}`, ...f(i + 1) }));

describe("checksHook: blocking checks in the write transaction", () => {
  test("passing checks commit, with one result per blocking check; warnings are left to runWarnings", async () => {
    const w = warehouse();
    const checks = checksOf({ key: ["id"], checks: ["amount >= 0", "min_rows(2)"], warnings: ["amount > 1000"] });
    const r = await load(w, "orders", people(3), { key: ["id"], checks: hook(checks) });
    expect(r.checks).toEqual([
      { check: "unique(id)", ok: true, failing: 0 },
      { check: "not_null(id)", ok: true, failing: 0 },
      { check: "amount >= 0", ok: true, failing: 0 },
      { check: "min_rows(2)", ok: true, failing: 0 },
    ]);
    expect((await read(w, "SELECT count(*)::INTEGER AS n FROM orders"))[0]).toEqual({ n: 3 });
  });

  test("a failure rolls back rows, schema change, cursor and bookkeeping (a real writeBatch)", async () => {
    const w = warehouse();
    const checks = checksOf({ key: ["id"], checks: ["not_null(author)"] });
    const base = ["id", "email", "amount", "author", "updated_at"];
    await load(w, "orders", people(4, () => ({ updated_at: T0 })), { key: ["id"], write: "merge", columns: base, cursor: true, now: T0, checks: hook(checks) });
    const snapshot = async () => ({
      rows: await read(w, "SELECT * EXCLUDE (_loaded_at) FROM orders ORDER BY id"),
      cols: await read(w, "SELECT column_name FROM duckdb_columns() WHERE table_name = 'orders' ORDER BY column_index"),
      assets: await read(w, "SELECT * FROM _croft.assets"),
      columns: await read(w, "SELECT * FROM _croft.columns ORDER BY name"),
      writes: await read(w, "SELECT * FROM _croft.writes"),
    });
    const before = await snapshot();
    COLUMNS.note = "VARCHAR";
    const rows = [
      { id: 2, email: "p2@x.io", amount: 20, author: null, updated_at: T1, note: "x" },
      { id: 9, email: "p9@x.io", amount: 90, author: "a9", updated_at: T1, note: "y" },
    ];
    const e = await rejection(load(w, "orders", rows, { key: ["id"], write: "merge", columns: [...base, "note"], cursor: true, now: T1, checks: hook(checks, ["unique(id)", "not_null(id)", "not_null(author)"]) }));
    expect(e.code).toBe("CHECK_FAILED");
    expect(e.problem).toMatchObject({
      severity: "error", asset: "orders", file: FILE, retryable: false,
      hint: `correct ${FILE} or the data, then: croft run orders`,
      fix: { kind: "manual", description: `correct ${FILE} or the data, then: croft run orders` },
      effect: "nothing was written; orders keeps its previous 4 rows",
      details: { check: "not_null(author)", failing: 1, checked: 2, scope: "batch", sample: [{ id: 2, email: "p2@x.io", amount: 20, author: null, updated_at: "2026-09-22T11:00:00.000000Z", note: "x" }] },
    });
    expect(e.problem.message.split("\n")).toEqual([
      "not_null(author): 1 of 2 rows",
      // The line has room for these; note would not fit.
      '  id=2  email="p2@x.io"  amount=20  author=NULL  updated_at="2026-09-22T11:00:00.000000Z"',
    ]);
    expect(e.problem.details?.results).toEqual([
      { check: "unique(id)", ok: true, failing: 0 },
      { check: "not_null(id)", ok: true, failing: 0 },
      { check: "not_null(author)", ok: false, failing: 1, sample: [expect.objectContaining({ id: 2 })] },
    ]);
    expect(await snapshot()).toEqual(before);
    delete COLUMNS.note;
  });

  test("20 samples collected, 3 rendered; every failing check is reported", async () => {
    const w = warehouse();
    const checks = checksOf({ checks: ["amount >= 0", "not_null(email)"] });
    const rows = people(30, (i) => ({ amount: -i, email: i <= 2 ? null : `p${i}@x.io` }));
    const e = await rejection(load(w, "orders", rows, { checks: hook(checks) }));
    expect(e.problem.details).toMatchObject({ check: "amount >= 0", failing: 30, checked: 30 });
    expect((e.problem.details!.sample as unknown[]).length).toBe(SAMPLE_ROWS);
    const lines = e.problem.message.split("\n");
    expect(lines[0]).toBe("amount >= 0: 30 of 30 rows");
    expect(lines.slice(1, 4).every((l) => /^ {2}id=\d+ .*amount=-\d+/.test(l))).toBe(true);
    expect(lines.slice(4)).toEqual(["also failing: not_null(email): 2 of 30 rows"]);
    expect(e.problem.effect).toBe("nothing was written");
    expect(await read(w, "SELECT table_name FROM duckdb_tables() WHERE table_name = 'orders'")).toEqual([]);
  });

  test("NULL passes a rule; not_null is how to refuse it", async () => {
    const w = warehouse();
    const rows = people(3, (i) => ({ amount: i === 2 ? null : 5 }));
    expect((await load(w, "orders", rows, { checks: hook(checksOf({ checks: ["amount >= 0"] })) })).checks).toEqual([{ check: "amount >= 0", ok: true, failing: 0 }]);
    const e = await rejection(load(w, "other", rows, { checks: hook(checksOf({ checks: ["amount >= 0", "not_null(amount)"] })) }));
    expect(e.problem.message.split("\n")[0]).toBe("not_null(amount): 1 of 3 rows");
  });

  test("batch scope: rows this write changed; a new or edited check covers the whole table once", async () => {
    const w = warehouse();
    // The first write has a negative amount and no check.
    await load(w, "orders", people(3, (i) => ({ amount: i === 1 ? -5 : 10 })), { key: ["id"], write: "merge", now: T0 });
    const rule = checksOf({ checks: ["amount >= 0"] });
    const change = [{ id: 3, email: "p3@x.io", amount: 99, author: "a3" }];
    // Known check: only the changed row (id 3) is checked.
    const ok = await load(w, "orders", change, { key: ["id"], write: "merge", now: T1, checks: hook(rule, ["  amount >= 0 "]) });
    expect(ok.checks).toEqual([{ check: "amount >= 0", ok: true, failing: 0 }]);
    // New (not in previous) or no record at all: the whole table, which has the old bad row.
    for (const previous of [["amount >= 1"], [], null, undefined]) {
      const e = await rejection(load(w, "orders", [{ ...change[0], amount: 100 + (previous?.length ?? 7) }], { key: ["id"], write: "merge", now: T2, checks: hook(rule, previous) }));
      expect(e.problem.message.split("\n")[0]).toBe("amount >= 0: 1 of 3 rows (the whole table: a new or edited check)");
      expect(e.problem.details).toMatchObject({ scope: "table", checked: 3 });
    }
  });

  test("a write that changed nothing checks nothing in batch scope", async () => {
    const w = warehouse();
    const rows = people(2, (i) => ({ amount: i === 1 ? -1 : 1 }));
    await load(w, "orders", rows, { key: ["id"], now: T0 });
    const r = await load(w, "orders", rows, { key: ["id"], now: T1, checks: hook(checksOf({ checks: ["amount >= 0"] }), ["amount >= 0"]) });
    expect(r.rows).toMatchObject({ unchanged: 2, added: 0, updated: 0 });
    expect(r.checks).toEqual([{ check: "amount >= 0", ok: true, failing: 0 }]);
  });

  test("unique covers the whole table after the write; duplicates are sampled together", async () => {
    const w = warehouse();
    const checks = checksOf({ checks: ["unique(email)"] });
    await load(w, "orders", people(3), { write: "append", now: T0, checks: hook(checks) });
    const e = await rejection(load(w, "orders", [{ id: 7, email: "p2@x.io", amount: 1, author: "z" }, { id: 8, email: null, amount: 1, author: "z" }, { id: 9, email: null, amount: 2, author: "y" }],
      { write: "append", now: T1, checks: hook(checks, ["unique(email)"]) }));
    expect(e.problem.message.split("\n")).toEqual([
      "unique(email): 1 value appears more than once (2 of 6 rows)",
      '  id=2  email="p2@x.io"  amount=20  author="a2"',
      '  id=7  email="p2@x.io"  amount=1  author="z"',
    ]);
    expect(e.problem.details).toMatchObject({ check: "unique(email)", failing: 2, checked: 6, scope: "table" });
    expect((await read(w, "SELECT count(*)::INTEGER AS n FROM orders"))[0]).toEqual({ n: 3 });
  });

  test("min_rows counts the whole table", async () => {
    const w = warehouse();
    const e = await rejection(load(w, "orders", people(3), { checks: hook(checksOf({ checks: ["min_rows(5)"] })) }));
    expect(e.problem.message).toBe("min_rows(5): the table has 3 rows");
    expect(e.problem.details).toMatchObject({ check: "min_rows(5)", failing: 2, sample: [] });
    const r = await load(w, "orders", people(5), { checks: hook(checksOf({ checks: ["min_rows(5)"] })) });
    expect(r.checks).toEqual([{ check: "min_rows(5)", ok: true, failing: 0 }]);
  });

  test("a rule may read other tables in a subquery", async () => {
    const w = warehouse();
    await load(w, "allowed", [{ id: 1 }, { id: 2 }], { columns: ["id"] });
    const checks = checksOf({ checks: ["id IN (SELECT id FROM allowed)"] });
    expect(checks[0]!.reads).toEqual(["allowed"]);
    const e = await rejection(load(w, "orders", people(3), { checks: hook(checks) }));
    expect(e.problem.message.split("\n")[0]).toBe("id IN (SELECT id FROM allowed): 1 of 3 rows");
  });

  test("a check that cannot run is CHECK_INVALID and rolls back, with a did-you-mean edit", async () => {
    const w = warehouse();
    await load(w, "orders", people(2), { now: T0 });
    const e = await rejection(load(w, "orders", people(3), { now: T1, checks: hook(checksOf({ checks: ["amout >= 0"] })) }));
    expect(e.code).toBe("CHECK_INVALID");
    expect(e.problem).toMatchObject({
      asset: "orders", file: FILE, details: { check: "amout >= 0", blocking: true },
      fix: { kind: "edit", file: FILE, replace: { from: "amout", to: "amount" } },
    });
    expect(e.problem.message).toContain('could not run: Referenced column "amout" not found');
    expect(e.problem.message).toContain("(did you mean amount?)");
    const typo = await rejection(load(w, "orders", people(3), { now: T1, checks: hook(checksOf({ checks: ["not_null(autor)"] })) }));
    expect(typo.problem.fix).toMatchObject({ replace: { from: "autor", to: "author" } });
    // A type error on this data is the check's too.
    const cast = await rejection(load(w, "orders", people(3), { now: T1, checks: hook(checksOf({ checks: ["CAST(email AS INTEGER) > 0"] })) }));
    expect(cast.code).toBe("CHECK_INVALID");
    expect((await read(w, "SELECT count(*)::INTEGER AS n FROM orders"))[0]).toEqual({ n: 2 });
  });

  test("injection: a check is never concatenated into more than one statement", async () => {
    const w = warehouse();
    await load(w, "orders", people(2), { now: T0 });
    await load(w, "victim", [{ id: 1 }], { columns: ["id"], now: T0 });
    // Hand-built checks that skipped parseChecks and validate: the hook vets them on the transaction itself.
    const evil = (sql: string, kind: Check["kind"] = "rule"): Check => ({ source: sql, kind, blocking: true, scope: kind === "unique" ? "table" : "batch", sql, reads: [] });
    for (const c of [
      evil("true) FROM orders; DROP TABLE victim; SELECT (1"),
      evil("amount > 0; DROP TABLE victim"),
      evil("true\n) OR (true"),
      evil('"id"); DROP TABLE victim; --', "not_null"),
      evil('"id" FROM orders; DROP TABLE victim; --', "unique"),
      evil("1; DROP TABLE victim", "min_rows"),
      evil("id IN (SELECT 1 FROM query('DROP TABLE victim'))"),
    ]) {
      const e = await rejection(load(w, "orders", people(3), { now: T1, checks: hook([c]) }));
      expect([e.code, c.sql]).toEqual(["CHECK_INVALID", c.sql]);
    }
    // Ones that are one expression after all (a comment is a comment, a string a string) run as checks.
    const passed = await load(w, "orders", people(3), { now: T1, checks: hook([evil("amount > 0 /* ) OR true; DROP TABLE victim; -- */")]) });
    expect(passed.checks).toEqual([{ check: "amount > 0 /* ) OR true; DROP TABLE victim; -- */", ok: true, failing: 0 }]);
    const e = await rejection(load(w, "orders", people(4), { now: T2, checks: hook([evil("'; DROP TABLE victim; --' = email")]) }));
    expect(e.code).toBe("CHECK_FAILED");
    expect(await read(w, "SELECT count(*)::INTEGER AS n FROM victim")).toEqual([{ n: 1 }]);
    expect((await read(w, "SELECT count(*)::INTEGER AS n FROM orders"))[0]).toEqual({ n: 3 });
  });
});

describe("runWarnings: non-blocking checks after the commit", () => {
  test("a failing warning is a warning-severity problem and a result; blocking checks are skipped", async () => {
    const w = warehouse();
    const checks = checksOf({ key: ["id"], checks: ["amount >= 0"], warnings: ["amount < 25", "not_null(author)", "min_rows(10)"] });
    const r = await load(w, "orders", people(3), { key: ["id"], now: T0, checks: hook(checks) });
    const out = await w.read((sql) => runWarnings(sql, { asset: "orders", table: '"warehouse"."main"."orders"', loadedAt: r.loadedAt, rows: r.rows }, checks, { file: FILE }), { purpose: "test" });
    expect(out.results).toEqual([
      { check: "amount < 25", ok: false, failing: 1, sample: [{ id: 3, email: "p3@x.io", amount: 30, author: "a3" }] },
      { check: "not_null(author)", ok: true, failing: 0 },
      { check: "min_rows(10)", ok: false, failing: 7, sample: [] },
    ]);
    expect(out.problems.map((p) => [p.severity, p.code, p.message.split("\n")[0]])).toEqual([
      ["warning", "CHECK_FAILED", "warning amount < 25: 1 of 3 rows"],
      ["warning", "CHECK_FAILED", "warning min_rows(10): the table has 3 rows"],
    ]);
    expect(out.problems[0]).toMatchObject({ asset: "orders", file: FILE, details: { check: "amount < 25", failing: 1 } });
    expect(out.problems[0]!.hint).toContain("a warning does not block the write");
  });

  test("warnings look at the rows the write changed; a known-new warning at the whole table", async () => {
    const w = warehouse();
    await load(w, "orders", people(3, (i) => ({ amount: i === 1 ? 500 : 5 })), { key: ["id"], write: "merge", now: T0 });
    const r = await load(w, "orders", [{ id: 2, email: "p2@x.io", amount: 6, author: "a2" }], { key: ["id"], write: "merge", now: T1 });
    const checks = checksOf({ warnings: ["amount < 100"] });
    const ctx = { asset: "orders", table: '"warehouse"."main"."orders"', loadedAt: r.loadedAt, rows: r.rows };
    const batch = await w.read((sql) => runWarnings(sql, ctx, checks), { purpose: "test" });
    expect(batch).toEqual({ problems: [], results: [{ check: "amount < 100", ok: true, failing: 0 }] });
    const whole = await w.read((sql) => runWarnings(sql, ctx, checks, { previous: [] }), { purpose: "test" });
    expect(whole.problems.map((p) => p.message.split("\n")[0])).toEqual(["warning amount < 100: 1 of 3 rows (the whole table: a new or edited check)"]);
  });

  test("a warning that cannot run is a warning, never an error", async () => {
    const w = warehouse();
    const r = await load(w, "orders", people(2), { now: T0 });
    const checks = checksOf({ warnings: ["nope > 1", "amount > 0"] });
    const out = await w.read((sql) => runWarnings(sql, { asset: "orders", table: '"warehouse"."main"."orders"', loadedAt: r.loadedAt, rows: r.rows }, checks, { file: FILE }), { purpose: "test" });
    expect(out.results).toEqual([{ check: "nope > 1", ok: false }, { check: "amount > 0", ok: true, failing: 0 }]);
    expect(out.problems.map((p) => [p.severity, p.code])).toEqual([["warning", "CHECK_INVALID"]]);
    expect(out.problems[0]!.message).toContain('the warning "nope > 1" could not run');
  });
});

describe("renderRow", () => {
  test("focus columns always, others while they fit, in table order", () => {
    const row = { id: 2291, number: 12, title: "Crash on Windows when opening a file", author: null, labels: ["bug", "p0"], body: "x".repeat(80) };
    expect(renderRow(row, ["id", "author"])).toBe('id=2291  number=12  title="Crash on Windows when o…"  author=NULL  labels=["bug","p0"]');
    expect(renderRow({ a: 1n, b: true, c: { k: "v" } })).toBe('a=1  b=true  c={"k":"v"}');
    expect(renderRow({ at: "2026-09-22T11:00:00.000000Z", day: "2026-09-22", t: "2026-09-22 11:00:00.123456+00" }))
      .toBe('at="2026-09-22T11:00:00.000000Z"  day="2026-09-22"  t="2026-09-22 11:00:00.123456+00"');
  });
});

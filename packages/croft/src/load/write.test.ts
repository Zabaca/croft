import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { ColumnPlan, Problem, Sql, ValueKind } from "../core/types.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import type { BatchCursor, TypedBatch, WriteTarget } from "./contract.ts";
import { quoteIdent, readTableSchema } from "./evolve.ts";
import { type WriteBatchInput, type WriteResult, writeBatch } from "./write.ts";

afterAll(() => closeAllWarehouses());

function warehouse(timezone = "UTC"): DuckWarehouse {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-write-")));
  mkdirSync(join(root, ".croft"));
  mkdirSync(join(root, "files"));
  return openWarehouse({ path: join(root, "warehouse.duckdb"), mode: "read_write", timezone, root, stateDir: join(root, ".croft"), register: false, isTTY: false });
}

type Rows = Record<string, unknown>[];

function kindOf(v: unknown): ValueKind {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "bigint") return "bigint";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "float";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) return "iso_instant";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return "iso_naive";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return "iso_date";
  return "string";
}

let batchSeq = 0;

interface BatchSpec {
  /** Column → SQL type of the typed batch. */
  columns: Record<string, string>;
  /** Rows; a missing key is SQL NULL (and a column no row has is absent from the batch). */
  rows: Rows;
  cursor?: Omit<BatchCursor, "rawTextColumn"> & { rawTextColumn?: string };
  /** Per-column overrides of the plan (decision, target, existing, incoming). */
  plans?: Record<string, Partial<ColumnPlan>>;
  /** Columns known to the table that the batch does not carry at all. */
  known?: string[];
  warnings?: Problem[];
  /** Raw text of the cursor per row, when it differs from the typed value's text. */
  raw?: (string | null)[];
  /** Columns of the TEMP table that are not data columns and get no plan (files.ts's _croft_fallback). */
  unplanned?: string[];
}

/** Build a typed batch the way cast.ts leaves it: a TEMP table plus plans. */
async function makeBatch(tx: Sql, asset: string, spec: BatchSpec): Promise<TypedBatch> {
  const temp = `batch_${++batchSeq}`;
  const names = Object.keys(spec.columns);
  const rawCol = spec.cursor ? spec.cursor.rawTextColumn ?? "__cursor_raw" : null;
  const defs = names.map((n) => `${quoteIdent(n)} ${spec.columns[n]}`);
  if (rawCol && !names.includes(rawCol)) defs.push(`${quoteIdent(rawCol)} VARCHAR`);
  defs.push(`"_croft_seq" BIGINT`);
  await tx.exec(`CREATE TEMP TABLE ${quoteIdent(temp)} (${defs.join(", ")})`);
  for (const [i, row] of spec.rows.entries()) {
    const values: unknown[] = names.map((n) => {
      const v = row[n];
      if (v === null || v === undefined) return null;
      return typeof v === "object" || spec.columns[n] === "JSON" ? JSON.stringify(v) : v;
    });
    if (rawCol && !names.includes(rawCol)) {
      const typed = row[spec.cursor!.field];
      values.push(spec.raw ? spec.raw[i] ?? null : typed === undefined || typed === null ? null : String(typed));
    }
    values.push(i + 1);
    await tx.exec(`INSERT INTO temp.main.${quoteIdent(temp)} VALUES (${values.map((_, j) => `$${j + 1}`).join(", ")})`, values);
  }
  const real = (await readTableSchema(tx, asset)) ?? [];
  const plans: ColumnPlan[] = names.filter((n) => !spec.unplanned?.includes(n)).map((n) => {
    const had = real.find((c) => c.name.toLowerCase() === n.toLowerCase());
    const incoming = [...new Set(spec.rows.filter((r) => n in r).map((r) => kindOf(r[n])))];
    return { column: n, sourceName: n, existing: had?.type ?? null, incoming, decision: had ? "keep" : "add", target: spec.columns[n], ...spec.plans?.[n] };
  });
  for (const n of spec.known ?? []) {
    const had = real.find((c) => c.name.toLowerCase() === n.toLowerCase());
    plans.push({ column: n, sourceName: n, existing: had?.type ?? null, incoming: [], decision: "keep" });
  }
  return {
    temp, columns: plans, rows: spec.rows.length, warnings: spec.warnings ?? [],
    cursor: spec.cursor ? { ...spec.cursor, rawTextColumn: rawCol! } : undefined,
  };
}

interface LoadOptions extends Omit<WriteBatchInput, "batch" | "target"> {
  write?: WriteTarget["write"];
  key?: string[];
  replaceFiles?: string[];
  allowShrink?: boolean;
  runId?: string;
}

function load(w: DuckWarehouse, asset: string, spec: BatchSpec, o: LoadOptions = {}): Promise<WriteResult> {
  const { write = "replace", key = [], replaceFiles, allowShrink, runId = `r_${batchSeq + 1}`, ...rest } = o;
  return w.write(asset, async (tx) => {
    const batch = await makeBatch(tx, asset, spec);
    return writeBatch(tx, { batch, target: { asset, write, key, runId, replaceFiles, allowShrink }, ...rest });
  }, { runId });
}

const read = <T = Record<string, unknown>>(w: DuckWarehouse, sql: string, params?: unknown[]) => w.read((db) => db.all<T>(sql, params), { purpose: "test" });
const table = (w: DuckWarehouse, name: string, order = "id") =>
  read(w, `SELECT * EXCLUDE (_loaded_at), _loaded_at::VARCHAR AS _loaded_at FROM ${quoteIdent(name)} ORDER BY ${order}`);
const stamps = async (w: DuckWarehouse, name: string, key = "id") =>
  Object.fromEntries((await read<{ k: unknown; s: string }>(w, `SELECT ${quoteIdent(key)} AS k, strftime(_loaded_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ') AS s FROM ${quoteIdent(name)}`)).map((r) => [String(r.k), r.s]));
const assetRow = async (w: DuckWarehouse, name: string) => (await read(w, `SELECT * FROM _croft.assets WHERE name = $1`, [name]))[0];
const writesRows = (w: DuckWarehouse, name: string) => read(w, `SELECT * FROM _croft.writes WHERE asset = $1 ORDER BY loaded_at`, [name]);

async function rejection(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

const T0 = "2026-09-22T10:00:00Z";
const T1 = "2026-09-22T11:00:00Z";
const T2 = "2026-09-22T12:00:00Z";
const T3 = "2026-09-22T13:00:00Z";

const zones = { columns: { id: "BIGINT", zone: "VARCHAR", borough: "VARCHAR" } };
const zoneRows = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, zone: change[i + 1] ?? `zone ${i + 1}`, borough: i % 2 ? "Queens" : "Bronx" }));

describe("first load", () => {
  test("creates the table from the plans, with _loaded_at last, and records state", async () => {
    const w = warehouse();
    const r = await load(w, "zones", { ...zones, rows: zoneRows(3) }, { key: ["id"], now: T0, codeHash: "c1", behaviorHash: "b1" });
    expect(r.created).toBe(true);
    expect(r.schemaChanges).toEqual([]);
    expect(r.rows).toEqual({ in: 3, added: 3, updated: 0, unchanged: 0, deleted: 0, total: 3 });
    expect(r.loadedAt).toBe("2026-09-22T10:00:00.000000Z");
    expect(r.changed).toBe(true);
    expect(await read(w, `SELECT column_name AS c, data_type AS t FROM duckdb_columns() WHERE table_name = 'zones' ORDER BY column_index`)).toEqual([
      { c: "id", t: "BIGINT" }, { c: "zone", t: "VARCHAR" }, { c: "borough", t: "VARCHAR" }, { c: "_loaded_at", t: "TIMESTAMP WITH TIME ZONE" },
    ]);
    expect(Object.values(await stamps(w, "zones"))).toEqual(Array(3).fill("2026-09-22T10:00:00.000000Z"));
    expect(await assetRow(w, "zones")).toMatchObject({
      name: "zones", kind: "ingest", write_mode: "replace", key_columns: ["id"], code_hash: "c1", behavior_hash: "b1",
      last_loaded_at: "2026-09-22T10:00:00.000000Z", last_replaced_at: null, row_count: 3, max_loaded_at: "2026-09-22T10:00:00.000000Z",
      updated_at: "2026-09-22T10:00:00.000000Z", cursor_value: null,
    });
    expect(await read(w, `SELECT name, type, source_name, pinned, pending, kinds, present_last_batch, added_at FROM _croft.columns WHERE asset = 'zones' ORDER BY name`)).toEqual([
      { name: "borough", type: "VARCHAR", source_name: "borough", pinned: false, pending: false, kinds: ["string"], present_last_batch: true, added_at: "2026-09-22T10:00:00.000000Z" },
      { name: "id", type: "BIGINT", source_name: "id", pinned: false, pending: false, kinds: ["integer"], present_last_batch: true, added_at: "2026-09-22T10:00:00.000000Z" },
      { name: "zone", type: "VARCHAR", source_name: "zone", pinned: false, pending: false, kinds: ["string"], present_last_batch: true, added_at: "2026-09-22T10:00:00.000000Z" },
    ]);
    expect(await writesRows(w, "zones")).toEqual([expect.objectContaining({
      asset: "zones", loaded_at: "2026-09-22T10:00:00.000000Z", mode: "replace", rows_in: 3, added: 3, updated: 0, unchanged: 0, deleted: 0,
      schema_changes: [], code_hash: "c1", cursor_before: null, cursor_after: null,
    })]);
  });

  test("_croft.writes records the step attempt, so reconcile() can tell a retry from an earlier attempt", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(2) }, { key: ["id"], now: T0, runId: "r_a", attempt: 3 });
    await load(w, "zones", { ...zones, rows: zoneRows(3) }, { key: ["id"], now: T1, runId: "r_b" });
    expect((await writesRows(w, "zones")).map((x) => [x.run_id, x.attempt])).toEqual([["r_a", 3], ["r_b", null]]);
  });

  test("an empty first batch still creates the table, with only _loaded_at when nothing is known", async () => {
    const w = warehouse();
    const r = await load(w, "empty", { columns: {}, rows: [] }, { now: T0 });
    expect(r.created).toBe(true);
    expect(r.rows).toEqual({ in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total: 0 });
    expect(r.changed).toBe(false);
    expect(await read(w, `SELECT column_name AS c FROM duckdb_columns() WHERE table_name = 'empty'`)).toEqual([{ c: "_loaded_at" }]);
    expect(await assetRow(w, "empty")).toMatchObject({ row_count: 0, max_loaded_at: null, last_loaded_at: null });
  });
});

describe("replace", () => {
  test("keyed replace is a diff: unchanged rows keep their stamp, changed rows get the new one", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(265) }, { key: ["id"], now: T0 });
    // 2 of 265 changed, 1 removed (265), 1 new (266): the refresh must not restamp the other 262.
    const next = zoneRows(264, { 7: "Midtown North", 100: "Harlem" });
    next.push({ id: 266, zone: "Governors Island", borough: "Manhattan" });
    const r = await load(w, "zones", { ...zones, rows: next }, { key: ["id"], now: T1 });
    expect(r.rows).toEqual({ in: 265, added: 1, updated: 2, unchanged: 262, deleted: 1, total: 265 });
    const s = await stamps(w, "zones");
    expect(s["7"]).toBe("2026-09-22T11:00:00.000000Z");
    expect(s["100"]).toBe("2026-09-22T11:00:00.000000Z");
    expect(s["266"]).toBe("2026-09-22T11:00:00.000000Z");
    expect(s["1"]).toBe("2026-09-22T10:00:00.000000Z");
    expect(s["265"]).toBeUndefined();
    expect(Object.values(s).filter((v) => v.startsWith("2026-09-22T10")).length).toBe(262);
    expect((await table(w, "zones")).find((r) => r.id === 7)).toMatchObject({ zone: "Midtown North" });
  });

  test("an identical replace changes nothing and keeps last_loaded_at", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(4) }, { key: ["id"], now: T0 });
    const r = await load(w, "zones", { ...zones, rows: zoneRows(4) }, { key: ["id"], now: T1 });
    expect(r.rows).toEqual({ in: 4, added: 0, updated: 0, unchanged: 4, deleted: 0, total: 4 });
    expect(r.changed).toBe(false);
    expect(r.loadedAt).toBe("2026-09-22T11:00:00.000000Z");
    expect(await assetRow(w, "zones")).toMatchObject({ last_loaded_at: "2026-09-22T10:00:00.000000Z", updated_at: "2026-09-22T11:00:00.000000Z" });
    expect((await writesRows(w, "zones")).map((x) => [x.loaded_at, x.unchanged])).toEqual([
      ["2026-09-22T10:00:00.000000Z", 0], ["2026-09-22T11:00:00.000000Z", 4],
    ]);
  });

  test("a column absent from a replace batch becomes NULL, and that counts as a change", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(2) }, { key: ["id"], now: T0 });
    const rows = [{ id: 1, zone: "zone 1" }, { id: 2, zone: "zone 2" }];
    const r = await load(w, "zones", { columns: { id: "BIGINT", zone: "VARCHAR" }, rows, known: ["borough"] }, { key: ["id"], now: T1 });
    expect(r.rows).toMatchObject({ updated: 2, unchanged: 0 });
    expect((await table(w, "zones")).map((x) => x.borough)).toEqual([null, null]);
  });

  test("JSON values compare by canonical text, so an equal object is unchanged", async () => {
    const w = warehouse();
    const spec = (meta: unknown) => ({ columns: { id: "BIGINT", meta: "JSON" }, rows: [{ id: 1, meta }, { id: 2, meta: { a: [1, 2] } }] });
    await load(w, "j", spec({ a: 1, b: "x" }), { key: ["id"], now: T0 });
    const r = await load(w, "j", spec({ a: 1, b: "x" }), { key: ["id"], now: T1 });
    expect(r.rows).toMatchObject({ unchanged: 2, updated: 0 });
    const r2 = await load(w, "j", spec({ a: 2, b: "x" }), { key: ["id"], now: T2 });
    expect(r2.rows).toMatchObject({ unchanged: 1, updated: 1 });
  });

  test("keyless replace matches rows by content with multiplicity", async () => {
    const w = warehouse();
    const spec = (rows: Rows) => ({ columns: { name: "VARCHAR", n: "BIGINT" }, rows });
    await load(w, "tags", spec([{ name: "a", n: 1 }, { name: "a", n: 1 }, { name: "b", n: 2 }, { name: "z", n: null }]), { now: T0 });
    // Table {a, a, b, z(NULL)}; batch {a, b, b, c, z(NULL)}: one a and b and z pair up, one a goes, b and c arrive.
    const r = await load(w, "tags", spec([{ name: "b", n: 2 }, { name: "a", n: 1 }, { name: "b", n: 2 }, { name: "c", n: 3 }, { name: "z", n: null }]), { now: T1 });
    expect(r.rows).toEqual({ in: 5, added: 2, updated: 0, unchanged: 3, deleted: 1, total: 5 });
    const rows = await read<{ name: string; n: number | null; s: string }>(w,
      `SELECT name, n, strftime(_loaded_at AT TIME ZONE 'UTC', '%H') AS s FROM tags ORDER BY name, s`);
    expect(rows).toEqual([
      { name: "a", n: 1, s: "10" }, { name: "b", n: 2, s: "10" }, { name: "b", n: 2, s: "11" }, { name: "c", n: 3, s: "11" }, { name: "z", n: null, s: "10" },
    ]);
    const again = await load(w, "tags", spec([{ name: "b", n: 2 }, { name: "a", n: 1 }, { name: "b", n: 2 }, { name: "c", n: 3 }, { name: "z", n: null }]), { now: T2 });
    expect(again.rows).toMatchObject({ added: 0, deleted: 0, unchanged: 5 });
  });

  test("a SQL transform's replace is not shrink-guarded", async () => {
    const w = warehouse();
    await load(w, "agg", { ...zones, rows: zoneRows(10) }, { key: ["id"], now: T0, kind: "sql" });
    const r = await load(w, "agg", { ...zones, rows: zoneRows(1) }, { key: ["id"], now: T1, kind: "sql" });
    expect(r.rows).toMatchObject({ deleted: 9, total: 1 });
    expect(await assetRow(w, "agg")).toMatchObject({ kind: "sql" });
  });
});

describe("append", () => {
  test("INSERT BY NAME: every row is added, absent columns are NULL, earlier rows are untouched", async () => {
    const w = warehouse();
    const spec = (rows: Rows) => ({ columns: { event: "VARCHAR", at: "TIMESTAMPTZ", detail: "VARCHAR" }, rows });
    await load(w, "events", spec([{ event: "a", at: T0, detail: "x" }]), { write: "append", now: T0 });
    const r = await load(w, "events", { columns: { at: "TIMESTAMPTZ", event: "VARCHAR" }, rows: [{ event: "a", at: T0 }, { event: "b", at: T1 }], known: ["detail"] },
      { write: "append", now: T1 });
    expect(r.rows).toEqual({ in: 2, added: 2, updated: 0, unchanged: 0, deleted: 0, total: 3 });
    expect(await read(w, `SELECT event, detail, strftime(_loaded_at AT TIME ZONE 'UTC', '%H') AS h FROM events ORDER BY h, event`)).toEqual([
      { event: "a", detail: "x", h: "10" }, { event: "a", detail: null, h: "11" }, { event: "b", detail: null, h: "11" },
    ]);
    expect(await assetRow(w, "events")).toMatchObject({ write_mode: "append", key_columns: [] });
  });
});

describe("merge", () => {
  const issues = { columns: { id: "BIGINT", title: "VARCHAR", state: "VARCHAR", updated_at: "TIMESTAMPTZ" } };

  test("updates changed rows, adds new ones, skips unchanged ones and never deletes", async () => {
    const w = warehouse();
    await load(w, "issues", { ...issues, rows: [
      { id: 1, title: "a", state: "open", updated_at: T0 }, { id: 2, title: "b", state: "open", updated_at: T0 }, { id: 3, title: "c", state: "open", updated_at: T0 },
    ] }, { write: "merge", key: ["id"], now: T0 });
    const r = await load(w, "issues", { ...issues, rows: [
      { id: 1, title: "a", state: "open", updated_at: T0 }, { id: 2, title: "b", state: "closed", updated_at: T1 }, { id: 4, title: "d", state: "open", updated_at: T1 },
    ] }, { write: "merge", key: ["id"], now: T1 });
    expect(r.rows).toEqual({ in: 3, added: 1, updated: 1, unchanged: 1, deleted: 0, total: 4 });
    const s = await stamps(w, "issues");
    expect(s).toEqual({
      1: "2026-09-22T10:00:00.000000Z", 2: "2026-09-22T11:00:00.000000Z", 3: "2026-09-22T10:00:00.000000Z", 4: "2026-09-22T11:00:00.000000Z",
    });
  });

  test("a column absent from the whole batch keeps its stored values; a present NULL overwrites", async () => {
    const w = warehouse();
    await load(w, "issues", { ...issues, rows: [
      { id: 1, title: "a", state: "open", updated_at: T0 }, { id: 2, title: "b", state: "open", updated_at: T0 },
    ] }, { write: "merge", key: ["id"], now: T0 });
    // `state` is missing from every row; `title` is present, and NULL for id 2.
    const r = await load(w, "issues", {
      columns: { id: "BIGINT", title: "VARCHAR", updated_at: "TIMESTAMPTZ" }, known: ["state"],
      rows: [{ id: 1, title: "a2", updated_at: T1 }, { id: 2, title: null, updated_at: T1 }, { id: 3, title: "c", updated_at: T1 }],
    }, { write: "merge", key: ["id"], now: T1 });
    expect(r.rows).toMatchObject({ added: 1, updated: 2 });
    expect((await table(w, "issues")).map((x) => [x.id, x.title, x.state])).toEqual([[1, "a2", "open"], [2, null, "open"], [3, "c", null]]);
    const cols = await read<{ name: string; present_last_batch: boolean }>(w, `SELECT name, present_last_batch FROM _croft.columns WHERE asset = 'issues' ORDER BY name`);
    expect(cols).toEqual([
      { name: "id", present_last_batch: true }, { name: "state", present_last_batch: false }, { name: "title", present_last_batch: true }, { name: "updated_at", present_last_batch: true },
    ]);
  });

  test("a row that differs only in an absent column is unchanged", async () => {
    const w = warehouse();
    await load(w, "issues", { ...issues, rows: [{ id: 1, title: "a", state: "open", updated_at: T0 }] }, { write: "merge", key: ["id"], now: T0 });
    const r = await load(w, "issues", { columns: { id: "BIGINT", title: "VARCHAR" }, known: ["state", "updated_at"], rows: [{ id: 1, title: "a" }] },
      { write: "merge", key: ["id"], now: T1 });
    expect(r.rows).toMatchObject({ unchanged: 1, updated: 0 });
    expect(await stamps(w, "issues")).toEqual({ 1: "2026-09-22T10:00:00.000000Z" });
  });

  test("duplicate keys in a batch: the highest typed cursor wins, then the last row yielded", async () => {
    const w = warehouse();
    const r = await load(w, "issues", { ...issues, cursor: { field: "updated_at", type: "timestamp" }, rows: [
      { id: 1, title: "newest (offset)", state: "open", updated_at: "2026-09-22T13:00:00+02:00" }, // 11:00Z
      { id: 1, title: "older", state: "open", updated_at: "2026-09-22T10:30:00Z" },
      { id: 2, title: "first", state: "open", updated_at: T1 },
      { id: 2, title: "last yielded", state: "open", updated_at: T1 },
      { id: 3, title: "null cursor", state: "open", updated_at: null },
      { id: 3, title: "has cursor", state: "open", updated_at: T0 },
    ] }, { write: "merge", key: ["id"], now: T2 });
    expect(r.rows).toEqual({ in: 6, added: 3, updated: 0, unchanged: 0, deleted: 0, total: 3 });
    expect((await table(w, "issues")).map((x) => x.title)).toEqual(["newest (offset)", "last yielded", "has cursor"]);
    // The same batch merged again finds nothing to do: dedupe runs before the MERGE.
    const again = await load(w, "issues", { ...issues, cursor: { field: "updated_at", type: "timestamp" }, rows: [
      { id: 2, title: "first", state: "open", updated_at: T1 }, { id: 2, title: "last yielded", state: "open", updated_at: T1 },
    ] }, { write: "merge", key: ["id"], now: T3 });
    expect(again.rows).toMatchObject({ in: 2, unchanged: 1, updated: 0, added: 0 });
  });

  test("duplicate keys in a keyed replace are deduplicated too", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(2) }, { key: ["id"], now: T0 });
    const r = await load(w, "zones", { ...zones, rows: [...zoneRows(2), { id: 2, zone: "renamed", borough: "Bronx" }] }, { key: ["id"], now: T1 });
    expect(r.rows).toEqual({ in: 3, added: 0, updated: 1, unchanged: 1, deleted: 0, total: 2 });
    expect((await table(w, "zones")).map((x) => x.zone)).toEqual(["zone 1", "renamed"]);
  });

  test("composite keys", async () => {
    const w = warehouse();
    const spec = (rows: Rows) => ({ columns: { day: "DATE", currency: "VARCHAR", net: "DOUBLE" }, rows });
    await load(w, "rev", spec([{ day: "2026-09-01", currency: "usd", net: 1.5 }, { day: "2026-09-01", currency: "eur", net: 2 }]), { write: "merge", key: ["day", "currency"], now: T0 });
    const r = await load(w, "rev", spec([{ day: "2026-09-01", currency: "usd", net: 1.75 }, { day: "2026-09-02", currency: "usd", net: 3 }]), { write: "merge", key: ["day", "currency"], now: T1 });
    expect(r.rows).toEqual({ in: 2, added: 1, updated: 1, unchanged: 0, deleted: 0, total: 3 });
  });
});

describe("KEY_NULL", () => {
  test("a NULL key fails before anything is written", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(2) }, { key: ["id"], now: T0 });
    const e = await rejection(load(w, "zones", { ...zones, rows: [{ id: 1, zone: "x" }, { zone: "no id" }, { id: null, zone: "null id" }] }, { key: ["id"], now: T1 }));
    expect(e.code).toBe("KEY_NULL");
    expect(e.problem.details).toMatchObject({ key: ["id"], rows: 2, samples: [{ _croft_seq: 2, id: null }, { _croft_seq: 3, id: null }] });
    expect((await table(w, "zones")).map((x) => x.zone)).toEqual(["zone 1", "zone 2"]);
  });

  test("a key missing from the batch entirely is KEY_NULL", async () => {
    const w = warehouse();
    const e = await rejection(load(w, "things", { columns: { name: "VARCHAR" }, rows: [{ name: "a" }] }, { key: ["id"], write: "merge", now: T0 }));
    expect(e.code).toBe("KEY_NULL");
    expect(e.problem.details).toMatchObject({ missing: ["id"] });
  });
});

describe("replace of files", () => {
  const sales = { columns: { order_id: "BIGINT", amount: "DOUBLE", _file: "VARCHAR" } };

  test("keyless: only the reloaded file's rows are diffed; other files are untouched", async () => {
    const w = warehouse();
    await load(w, "sales", { ...sales, rows: [
      { order_id: 1, amount: 10, _file: "a.csv" }, { order_id: 2, amount: 20, _file: "a.csv" }, { order_id: 3, amount: 30, _file: "b.csv" },
    ] }, { write: "append", now: T0 });
    // a.csv changed: row 2's amount was corrected and row 4 was added. b.csv also has a row equal to a.csv's
    // row 1 content, except _file, so it must not pair with it.
    const r = await load(w, "sales", { ...sales, rows: [
      { order_id: 1, amount: 10, _file: "a.csv" }, { order_id: 2, amount: 25, _file: "a.csv" }, { order_id: 4, amount: 40, _file: "a.csv" },
    ] }, { write: "append", replaceFiles: ["a.csv"], now: T1 });
    expect(r.rows).toEqual({ in: 3, added: 2, updated: 0, unchanged: 1, deleted: 1, total: 4 });
    expect(await read(w, `SELECT order_id, amount, _file, strftime(_loaded_at AT TIME ZONE 'UTC', '%H') AS h FROM sales ORDER BY order_id`)).toEqual([
      { order_id: 1, amount: 10, _file: "a.csv", h: "10" }, { order_id: 2, amount: 25, _file: "a.csv", h: "11" },
      { order_id: 3, amount: 30, _file: "b.csv", h: "10" }, { order_id: 4, amount: 40, _file: "a.csv", h: "11" },
    ]);
  });

  test("keyed merge: rows of the reloaded file that disappeared are deleted, other files keep theirs", async () => {
    const w = warehouse();
    await load(w, "sales", { ...sales, rows: [
      { order_id: 1, amount: 10, _file: "a.csv" }, { order_id: 2, amount: 20, _file: "a.csv" }, { order_id: 3, amount: 30, _file: "b.csv" },
    ] }, { write: "merge", key: ["order_id"], now: T0 });
    const r = await load(w, "sales", { ...sales, rows: [{ order_id: 1, amount: 11, _file: "a.csv" }] },
      { write: "merge", key: ["order_id"], replaceFiles: ["a.csv"], now: T1 });
    expect(r.rows).toEqual({ in: 1, added: 0, updated: 1, unchanged: 0, deleted: 1, total: 2 });
    expect((await read(w, `SELECT order_id, amount FROM sales ORDER BY order_id`))).toEqual([{ order_id: 1, amount: 11 }, { order_id: 3, amount: 30 }]);
  });

  test("a reloaded file that is now empty loses its rows, and only its rows", async () => {
    const w = warehouse();
    await load(w, "sales", { ...sales, rows: [
      { order_id: 1, amount: 10, _file: "a.csv" }, { order_id: 2, amount: 20, _file: "b.csv" },
    ] }, { write: "merge", key: ["order_id"], now: T0 });
    const r = await load(w, "sales", { columns: {}, rows: [], known: ["order_id", "amount"] }, { write: "merge", key: ["order_id"], replaceFiles: ["a.csv"], now: T1 });
    expect(r.rows).toEqual({ in: 0, added: 0, updated: 0, unchanged: 0, deleted: 1, total: 1 });
    expect(r.changed).toBe(true);
    expect(await assetRow(w, "sales")).toMatchObject({ last_loaded_at: "2026-09-22T11:00:00.000000Z", row_count: 1 });
  });

  test("keyed: fallback rows fill only keys a reloaded file dropped, from the most recently loaded file, in full", async () => {
    const w = warehouse();
    const merge = { write: "merge" as const, key: ["order_id"] };
    // b.csv first; then a.csv takes order 2 (loaded later); then c.csv takes it (with a note).
    await load(w, "sales", { ...sales, rows: [{ order_id: 2, amount: 22, _file: "b.csv" }, { order_id: 3, amount: 30, _file: "b.csv" }] }, { ...merge, now: T0 });
    await load(w, "sales", { ...sales, rows: [{ order_id: 1, amount: 10, _file: "a.csv" }, { order_id: 2, amount: 20, _file: "a.csv" }] },
      { ...merge, replaceFiles: ["a.csv"], now: T1 });
    await load(w, "sales", { columns: { ...sales.columns, note: "VARCHAR" }, rows: [{ order_id: 2, amount: 25, note: "c", _file: "c.csv" }] },
      { ...merge, replaceFiles: ["c.csv"], now: T2 });
    await w.write("files", async (tx) => {
      for (const [path, at] of [["b.csv", T0], ["a.csv", T1], ["c.csv", T2]]) {
        await tx.exec(`INSERT INTO _croft.files (asset, path, size, mtime, etag, sha256, loaded_at) VALUES ('sales', $1, 1, NULL, NULL, 'x', $2::TIMESTAMPTZ)`, [path, at]);
      }
    });
    // c.csv is re-exported with order 6 only. a.csv and b.csv are read along (fallback rows, in read order): order 2
    // falls back to a.csv, loaded after b.csv although b.csv is read later; order 1 and 3 are not c.csv's and stay.
    const fb = { columns: { ...sales.columns, _croft_fallback: "BOOLEAN" }, unplanned: ["_croft_fallback"] };
    const r = await load(w, "sales", { ...fb, rows: [
      { order_id: 1, amount: 10, _file: "a.csv", _croft_fallback: true }, { order_id: 2, amount: 20, _file: "a.csv", _croft_fallback: true },
      { order_id: 2, amount: 22, _file: "b.csv", _croft_fallback: true }, { order_id: 3, amount: 99, _file: "b.csv", _croft_fallback: true },
      { order_id: 6, amount: 60, _file: "c.csv", _croft_fallback: false },
    ] }, { ...merge, replaceFiles: ["c.csv"], now: T3 });
    expect(r.rows).toEqual({ in: 1, added: 1, updated: 1, unchanged: 0, deleted: 0, total: 4 });
    // The fallback row is a.csv's row in full: note is absent from the batch, yet c.csv's note does not stay.
    expect(await read(w, `SELECT order_id, amount, note, _file FROM sales ORDER BY order_id`)).toEqual([
      { order_id: 1, amount: 10, note: null, _file: "a.csv" }, { order_id: 2, amount: 20, note: null, _file: "a.csv" },
      { order_id: 3, amount: 30, note: null, _file: "b.csv" }, { order_id: 6, amount: 60, note: null, _file: "c.csv" },
    ]);
    expect((await writesRows(w, "sales")).at(-1)).toMatchObject({ rows_in: 1, added: 1, updated: 1, deleted: 0 });
    // Without a key-scoped file reload, fallback rows are never written.
    const r2 = await load(w, "sales", { ...fb, rows: [
      { order_id: 7, amount: 70, _file: "a.csv", _croft_fallback: true }, { order_id: 6, amount: 61, _file: "c.csv", _croft_fallback: false },
    ] }, { ...merge, now: T3 });
    expect(r2.rows).toEqual({ in: 1, added: 0, updated: 1, unchanged: 0, deleted: 0, total: 4 });
    expect(await read(w, `SELECT count(*)::INTEGER AS n FROM sales WHERE order_id = 7`)).toEqual([{ n: 0 }]);
    expect((await read<{ column_name: string }>(w, `DESCRIBE sales`)).map((c) => c.column_name)).not.toContain("_croft_fallback");
  });

  test("a reload of a new file with an empty file list deletes nothing", async () => {
    const w = warehouse();
    await load(w, "sales", { ...sales, rows: [{ order_id: 1, amount: 10, _file: "a.csv" }] }, { write: "append", now: T0 });
    const r = await load(w, "sales", { ...sales, rows: [{ order_id: 5, amount: 50, _file: "c.csv" }] }, { write: "append", replaceFiles: [], now: T1 });
    expect(r.rows).toMatchObject({ added: 1, deleted: 0, total: 2 });
  });
});

describe("SHRINK_GUARD", () => {
  test("a replace that would lose more than half of its rows fails and writes nothing", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(10) }, { key: ["id"], now: T0 });
    const e = await rejection(load(w, "zones", { ...zones, rows: zoneRows(4) }, { key: ["id"], now: T1, extract: { requests: 1, lastStatus: 200, bodyPreview: "[]" } }));
    expect(e.code).toBe("SHRINK_GUARD");
    expect(e.problem.details).toEqual({ rowsBefore: 10, rowsAfter: 4, requests: 1, lastStatus: 200, bodyPreview: "[]" });
    expect(e.problem.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect((await table(w, "zones")).length).toBe(10);
    expect(await writesRows(w, "zones")).toHaveLength(1);
  });

  test("an empty batch (an expired token returning []) fails", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(265) }, { key: ["id"], now: T0 });
    const e = await rejection(load(w, "zones", { columns: {}, rows: [], known: ["id", "zone", "borough"] }, { key: ["id"], now: T1 }));
    expect(e.code).toBe("SHRINK_GUARD");
    expect(e.problem.details).toMatchObject({ rowsBefore: 265, rowsAfter: 0 });
    expect((await table(w, "zones")).length).toBe(265);
  });

  test("losing exactly half is allowed; allowShrink lets a shrink through with a warning", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(10) }, { key: ["id"], now: T0 });
    const half = await load(w, "zones", { ...zones, rows: zoneRows(5) }, { key: ["id"], now: T1 });
    expect(half.rows.total).toBe(5);
    expect(half.warnings.map((p) => p.code)).not.toContain("SHRINK_GUARD_DISABLED");
    const r = await load(w, "zones", { ...zones, rows: zoneRows(1) }, { key: ["id"], now: T2, allowShrink: true });
    expect(r.rows).toMatchObject({ deleted: 4, total: 1 });
    expect(r.warnings.find((p) => p.code === "SHRINK_GUARD_DISABLED")?.details).toEqual({ rowsBefore: 5, rowsAfter: 1 });
  });

  test("an empty batch without even the key columns, allowed to shrink, empties the table", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(3) }, { key: ["id"], now: T0 });
    const r = await load(w, "zones", { columns: {}, rows: [] }, { key: ["id"], now: T1, allowShrink: true });
    expect(r.rows).toEqual({ in: 0, added: 0, updated: 0, unchanged: 0, deleted: 3, total: 0 });
    expect(await assetRow(w, "zones")).toMatchObject({ row_count: 0, max_loaded_at: null, last_loaded_at: "2026-09-22T11:00:00.000000Z" });
  });

  test("an empty first batch of a keyed merge creates the table", async () => {
    const w = warehouse();
    const r = await load(w, "later", { columns: {}, rows: [] }, { key: ["id"], write: "merge", now: T0 });
    expect(r.rows.total).toBe(0);
    const again = await load(w, "later", { columns: {}, rows: [] }, { key: ["id"], write: "merge", now: T1 });
    expect(again.rows.total).toBe(0);
    const first = await load(w, "later", { columns: { id: "BIGINT" }, rows: [{ id: 1 }] }, { key: ["id"], write: "merge", now: T2 });
    expect(first.schemaChanges).toEqual([{ kind: "add_column", column: "id", type: "BIGINT" }]);
    expect(first.rows).toMatchObject({ added: 1, total: 1 });
  });

  test("merges and appends are never shrink-guarded", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(10) }, { key: ["id"], write: "merge", now: T0 });
    const r = await load(w, "zones", { ...zones, rows: [] }, { key: ["id"], write: "merge", now: T1 });
    expect(r.rows.total).toBe(10);
  });
});

describe("atomicity", () => {
  test("a failing check rolls back the rows, the schema change, the cursor and all bookkeeping", async () => {
    const w = warehouse();
    const spec = (rows: Rows, extra = false) => ({
      columns: { id: "BIGINT", amount: "BIGINT", updated_at: "TIMESTAMPTZ", ...(extra ? { note: "VARCHAR" } : {}) },
      cursor: { field: "updated_at", type: "timestamp" as const }, rows,
    });
    await load(w, "charges", spec([{ id: 1, amount: 5, updated_at: T0 }]), { write: "merge", key: ["id"], now: T0 });
    const snapshot = async () => ({
      rows: await table(w, "charges"),
      cols: await read(w, `SELECT column_name FROM duckdb_columns() WHERE table_name = 'charges' ORDER BY column_index`),
      assets: await read(w, `SELECT * FROM _croft.assets`),
      columns: await read(w, `SELECT * FROM _croft.columns ORDER BY name`),
      writes: await read(w, `SELECT * FROM _croft.writes`),
      temps: await read(w, `SELECT table_name FROM duckdb_tables() WHERE database_name = 'temp'`),
    });
    const before = await snapshot();
    const e = await rejection(load(w, "charges", spec([{ id: 1, amount: -1, updated_at: T1, note: "refund" }, { id: 2, amount: 3, updated_at: T1, note: "x" }], true), {
      write: "merge", key: ["id"], now: T1,
      checks: async (tx, ctx) => {
        const [bad] = await tx.all<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM ${ctx.table} WHERE amount < 0`);
        if (bad!.n > 0) throw new CroftError("CHECK_FAILED", { message: `amount >= 0 failed for ${bad!.n} rows`, hint: "fix the rows" });
      },
    }));
    expect(e.code).toBe("CHECK_FAILED");
    expect(await snapshot()).toEqual(before);
  });

  test("checks see the written table and the stamp; their warnings pass through", async () => {
    const w = warehouse();
    let seen: unknown;
    const r = await load(w, "zones", { ...zones, rows: zoneRows(3) }, {
      key: ["id"], now: T0,
      checks: async (tx, ctx) => {
        seen = { rows: ctx.rows, loadedAt: ctx.loadedAt, n: (await tx.all(`SELECT * FROM ${ctx.table}`)).length, batch: (await tx.all(`SELECT * FROM temp.main.${quoteIdent(ctx.batch)}`)).length };
        return [{ severity: "warning", code: "CHECK_FAILED", message: "warn: 1 row", hint: "", docs: "" }];
      },
    });
    expect(seen).toEqual({ rows: { in: 3, added: 3, updated: 0, unchanged: 0, deleted: 0, total: 3 }, loadedAt: "2026-09-22T10:00:00.000000Z", n: 3, batch: 3 });
    expect(r.warnings.map((p) => p.message)).toContain("warn: 1 row");
  });
});

describe("_loaded_at stamps", () => {
  test("strictly increase per table even when the clock steps back or stands still", async () => {
    const w = warehouse();
    const spec = (v: string) => ({ ...zones, rows: [{ id: 1, zone: v, borough: "x" }] });
    const a = await load(w, "zones", spec("a"), { key: ["id"], now: T2 });
    const b = await load(w, "zones", spec("b"), { key: ["id"], now: T0 });       // clock stepped back 2 h
    const c = await load(w, "zones", spec("c"), { key: ["id"], now: T0 });       // and stands still
    const d = await load(w, "zones", spec("c"), { key: ["id"], now: T0 });       // nothing changes
    const e = await load(w, "zones", spec("e"), { key: ["id"], now: T0 });
    expect([a.loadedAt, b.loadedAt, c.loadedAt, d.loadedAt, e.loadedAt]).toEqual([
      "2026-09-22T12:00:00.000000Z", "2026-09-22T12:00:00.000001Z", "2026-09-22T12:00:00.000002Z", "2026-09-22T12:00:00.000003Z", "2026-09-22T12:00:00.000004Z",
    ]);
    expect(await stamps(w, "zones")).toEqual({ 1: "2026-09-22T12:00:00.000004Z" });
    expect(await assetRow(w, "zones")).toMatchObject({ last_loaded_at: "2026-09-22T12:00:00.000004Z", max_loaded_at: "2026-09-22T12:00:00.000004Z" });
    expect((await writesRows(w, "zones")).length).toBe(5);
  });

  test("the default clock is core/time's now()", async () => {
    const w = warehouse();
    const before = Date.now();
    const r = await load(w, "zones", { ...zones, rows: zoneRows(1) }, { key: ["id"] });
    expect(Date.parse(r.loadedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(r.loadedAt)).toBeLessThanOrEqual(Date.now() + 1);
  });
});

describe("schema evolution through writeBatch", () => {
  test("add, widen and retype a pending column in one write, before any DML, and report them", async () => {
    const w = warehouse();
    await load(w, "charges", {
      columns: { id: "BIGINT", amount: "BIGINT", refunded_at: "TIMESTAMPTZ", day: "DATE" },
      rows: [{ id: 1, amount: 5, refunded_at: null, day: "2026-09-01" }],
    }, { write: "merge", key: ["id"], now: T0 });
    expect(await read(w, `SELECT name, pending FROM _croft.columns WHERE asset = 'charges' ORDER BY name`)).toEqual([
      { name: "amount", pending: false }, { name: "day", pending: false }, { name: "id", pending: false }, { name: "refunded_at", pending: true },
    ]);
    const log: string[] = [];
    const r = await w.write("charges", async (tx) => {
      const batch = await makeBatch(tx, "charges", {
        columns: { id: "BIGINT", amount: "HUGEINT", refunded_at: "VARCHAR", day: "TIMESTAMPTZ", note: "VARCHAR" },
        rows: [{ id: 1, amount: 5, refunded_at: "soon", day: "2026-09-01T10:00:00Z", note: "n" }, { id: 2, amount: "99999999999999999999", refunded_at: "x", day: T1, note: null }],
        plans: {
          amount: { decision: "widen", target: "HUGEINT", incoming: ["integer", "bigint"] }, refunded_at: { decision: "retype_pending", target: "VARCHAR" },
          day: { decision: "widen", target: "TIMESTAMPTZ" },
        },
        warnings: [{ severity: "warning", code: "TYPE_WIDENED", message: "from cast.ts", hint: "", docs: "", details: { column: "day" } }],
      });
      const spy: Sql = {
        all: (sql, p) => (log.push(sql), tx.all(sql, p)),
        exec: (sql, p) => (log.push(sql), tx.exec(sql, p)),
      };
      return writeBatch(spy, { batch, target: { asset: "charges", write: "merge", key: ["id"], runId: "r" }, now: T1 });
    }, { runId: "r" });
    expect(r.schemaChanges).toEqual([
      { kind: "widen", column: "amount", from: "BIGINT", to: "HUGEINT" },
      { kind: "retype_pending", column: "refunded_at", to: "VARCHAR" },
      { kind: "widen", column: "day", from: "DATE", to: "TIMESTAMPTZ" },
      { kind: "add_column", column: "note", type: "VARCHAR" },
    ]);
    // TYPE_WIDENED once per column: cast.ts already reported day.
    expect(r.warnings.filter((p) => p.code === "TYPE_WIDENED").map((p) => [p.details?.column, p.message])).toEqual([
      ["day", "from cast.ts"], ["amount", "column amount widened from BIGINT to HUGEINT"],
    ]);
    const onTable = (s: string) => /"charges"/.test(s);
    const firstDml = log.findIndex((s) => onTable(s) && /^\s*(MERGE|INSERT|DELETE|UPDATE)/i.test(s));
    const lastDdl = log.findLastIndex((s) => onTable(s) && /^\s*ALTER/i.test(s));
    expect(lastDdl).toBeGreaterThan(-1);
    expect(firstDml).toBeGreaterThan(lastDdl);
    expect(await table(w, "charges")).toEqual([
      { id: 1, amount: 5n, refunded_at: "soon", day: "2026-09-01T10:00:00.000000Z", note: "n", _loaded_at: expect.any(String) },
      { id: 2, amount: 99999999999999999999n, refunded_at: "x", day: "2026-09-22T11:00:00.000000Z", note: null, _loaded_at: expect.any(String) },
    ]);
    expect(await read(w, `SELECT name, type, pending FROM _croft.columns WHERE asset = 'charges' ORDER BY name`)).toEqual([
      { name: "amount", type: "HUGEINT", pending: false }, { name: "day", type: "TIMESTAMPTZ", pending: false }, { name: "id", type: "BIGINT", pending: false },
      { name: "note", type: "VARCHAR", pending: false }, { name: "refunded_at", type: "VARCHAR", pending: false },
    ]);
    expect((await writesRows(w, "charges"))[1]!.schema_changes).toEqual(r.schemaChanges);
  });

  test("a DATE widened to TIMESTAMPTZ reads old dates as midnight in the project time zone", async () => {
    const w = warehouse("America/Los_Angeles");
    await load(w, "d", { columns: { id: "BIGINT", day: "DATE" }, rows: [{ id: 1, day: "2026-01-01" }] }, { write: "merge", key: ["id"], now: T0 });
    await load(w, "d", { columns: { id: "BIGINT", day: "TIMESTAMPTZ" }, rows: [{ id: 2, day: T1 }], plans: { day: { decision: "widen", target: "TIMESTAMPTZ" } } },
      { write: "merge", key: ["id"], now: T1 });
    expect(await read(w, `SELECT id, epoch(day)::BIGINT AS e FROM d ORDER BY id`)).toEqual([{ id: 1, e: 1767254400 }, { id: 2, e: 1790074800 }]);
  });

  test("pins and formats land in _croft.columns", async () => {
    const w = warehouse();
    await load(w, "p", { columns: { id: "BIGINT", zip: "VARCHAR", day: "DATE" }, rows: [{ id: 1, zip: "02134", day: "2026-03-25" }] }, {
      key: ["id"], now: T0, pins: { zip: { type: "VARCHAR" } }, formats: { day: "%m/%d/%Y" },
    });
    expect(await read(w, `SELECT name, pinned, format FROM _croft.columns WHERE asset = 'p' ORDER BY name`)).toEqual([
      { name: "day", pinned: false, format: "%m/%d/%Y" }, { name: "id", pinned: false, format: null }, { name: "zip", pinned: true, format: null },
    ]);
  });

  test("a batch column that does not match the table's type is refused rather than cast lossily", async () => {
    const w = warehouse();
    await load(w, "n", { columns: { id: "BIGINT", v: "BIGINT" }, rows: [{ id: 1, v: 1 }] }, { key: ["id"], now: T0 });
    const e = await rejection(load(w, "n", { columns: { id: "BIGINT", v: "DOUBLE" }, rows: [{ id: 1, v: 1.7 }], plans: { v: { decision: "keep", target: undefined } } }, { key: ["id"], now: T1 }));
    expect(e.code).toBe("INTERNAL_ERROR");
    expect((await table(w, "n"))[0]).toMatchObject({ v: 1 });
  });
});

describe("drift warnings", () => {
  test("COLUMN_STOPPED_ARRIVING: a column set in ≥95% of earlier rows, missing from a batch of ≥100 rows", async () => {
    const w = warehouse();
    const rows = (n: number, withEmail: boolean) => Array.from({ length: n }, (_, i) => ({ id: i + 1, email: withEmail ? `u${i}@x` : undefined }));
    await load(w, "users", { columns: { id: "BIGINT", email: "VARCHAR" }, rows: rows(120, true) }, { write: "merge", key: ["id"], now: T0 });
    const r = await load(w, "users", { columns: { id: "BIGINT" }, known: ["email"], rows: rows(100, false) }, {
      write: "merge", key: ["id"], now: T1, readBy: { email: ["contacts"] },
    });
    const p = r.warnings.find((x) => x.code === "COLUMN_STOPPED_ARRIVING");
    expect(p?.details).toEqual({ column: "email", nonNullShare: 1, batchRows: 100, readBy: ["contacts"] });
    expect(await read(w, `SELECT count(email)::INTEGER AS n FROM users`)).toEqual([{ n: 120 }]);
    // A batch under 100 rows is not enough evidence.
    const small = await load(w, "users", { columns: { id: "BIGINT" }, known: ["email"], rows: rows(99, false) }, { write: "merge", key: ["id"], now: T2 });
    expect(small.warnings.map((x) => x.code)).not.toContain("COLUMN_STOPPED_ARRIVING");
  });

  test("JSON_KIND_CHANGED: a JSON column gains a new kind of value", async () => {
    const w = warehouse();
    await load(w, "gh", { columns: { id: "BIGINT", user: "JSON" }, rows: [{ id: 1, user: { login: "a" } }] }, { write: "merge", key: ["id"], now: T0 });
    const same = await load(w, "gh", { columns: { id: "BIGINT", user: "JSON" }, rows: [{ id: 2, user: { login: "b" } }] }, { write: "merge", key: ["id"], now: T1 });
    expect(same.warnings.map((x) => x.code)).not.toContain("JSON_KIND_CHANGED");
    const r = await load(w, "gh", { columns: { id: "BIGINT", user: "JSON" }, rows: [{ id: 3, user: "ghost" }, { id: 4, user: null }] }, { write: "merge", key: ["id"], now: T2 });
    expect(r.warnings.find((x) => x.code === "JSON_KIND_CHANGED")?.details).toEqual({ column: "user", before: ["object"], added: ["string"] });
    expect(await read(w, `SELECT kinds FROM _croft.columns WHERE asset = 'gh' AND name = 'user'`)).toEqual([{ kinds: ["object", "string"] }]);
  });
});

describe("cursor bookkeeping", () => {
  const spec = (rows: Rows, raw?: (string | null)[]) => ({
    columns: { id: "BIGINT", updated_at: "TIMESTAMPTZ" }, cursor: { field: "updated_at", type: "timestamp" as const }, rows, raw,
  });

  test("saves the original text of the typed maximum, compares offsets as instants, never regresses", async () => {
    const w = warehouse();
    const r1 = await load(w, "gh", spec([{ id: 1, updated_at: "2026-09-22T17:58:03Z" }, { id: 2, updated_at: "2026-09-22T19:00:00+02:00" }]),
      { write: "merge", key: ["id"], now: T0 });
    expect(r1.cursor).toEqual({ before: undefined, after: "2026-09-22T17:58:03Z", sinceUsed: undefined });
    expect(await assetRow(w, "gh")).toMatchObject({ cursor_value: "2026-09-22T17:58:03Z", cursor_type: "timestamp", cursor_unit: null });
    // 20:00+02:00 is 18:00Z: newer, although it sorts lower as text.
    const r2 = await load(w, "gh", spec([{ id: 3, updated_at: "2026-09-22T20:00:00+02:00" }]), { write: "merge", key: ["id"], now: T1, sinceUsed: "2026-09-22T17:58:02Z" });
    expect(r2.cursor).toEqual({ before: "2026-09-22T17:58:03Z", after: "2026-09-22T20:00:00+02:00", sinceUsed: "2026-09-22T17:58:02Z" });
    // Older rows (a lookback window) and an empty batch never move it back.
    const r3 = await load(w, "gh", spec([{ id: 1, updated_at: "2026-09-22T17:58:03Z" }]), { write: "merge", key: ["id"], now: T2 });
    expect(r3.cursor?.after).toBe("2026-09-22T20:00:00+02:00");
    const r4 = await load(w, "gh", spec([]), { write: "merge", key: ["id"], now: T3 });
    expect(r4.cursor).toEqual({ before: "2026-09-22T20:00:00+02:00", after: "2026-09-22T20:00:00+02:00", sinceUsed: undefined });
    expect((await writesRows(w, "gh")).map((x) => [x.cursor_before, x.cursor_after, x.since_used])).toEqual([
      [null, "2026-09-22T17:58:03Z", null],
      ["2026-09-22T17:58:03Z", "2026-09-22T20:00:00+02:00", "2026-09-22T17:58:02Z"],
      ["2026-09-22T20:00:00+02:00", "2026-09-22T20:00:00+02:00", null],
      ["2026-09-22T20:00:00+02:00", "2026-09-22T20:00:00+02:00", null],
    ]);
  });

  test("a cursor that fails with the batch does not move", async () => {
    const w = warehouse();
    await load(w, "gh", spec([{ id: 1, updated_at: T0 }]), { write: "merge", key: ["id"], now: T0 });
    await rejection(load(w, "gh", spec([{ id: null, updated_at: T3 }]), { write: "merge", key: ["id"], now: T1 }));
    expect(await assetRow(w, "gh")).toMatchObject({ cursor_value: T0 });
  });

  test("epoch cursors keep their unit and compare as integers", async () => {
    const w = warehouse();
    const s = (rows: Rows) => ({ columns: { id: "VARCHAR", created: "BIGINT" }, cursor: { field: "created", type: "integer" as const, unit: "s" as const }, rows });
    await load(w, "ch", s([{ id: "a", created: 999 }, { id: "b", created: 1000 }]), { write: "merge", key: ["id"], now: T0 });
    expect(await assetRow(w, "ch")).toMatchObject({ cursor_value: "1000", cursor_type: "integer", cursor_unit: "s" });
    await load(w, "ch", s([{ id: "c", created: 10000 }]), { write: "merge", key: ["id"], now: T1 });
    expect(await assetRow(w, "ch")).toMatchObject({ cursor_value: "10000" });
  });

  test("an all-NULL cursor column (a name-typed placeholder) fixes no type until real values arrive", async () => {
    const w = warehouse();
    const s = (type: string, rows: Rows, plans?: BatchSpec["plans"]) =>
      ({ columns: { id: "VARCHAR", created: type }, cursor: { field: "created", type: "integer" as const, unit: "s" as const }, rows, plans });
    const r1 = await load(w, "ch", s("VARCHAR", [{ id: "a", created: null }]), { write: "merge", key: ["id"], now: T0 });
    expect(r1.cursor).toEqual({ before: undefined, after: undefined, sinceUsed: undefined });
    expect(await assetRow(w, "ch")).toMatchObject({ cursor_value: null, cursor_type: null });
    const r2 = await load(w, "ch", s("BIGINT", [{ id: "b", created: 1726000000 }], { created: { decision: "retype_pending", target: "BIGINT" } }),
      { write: "merge", key: ["id"], now: T1 });
    expect(r2.schemaChanges).toEqual([{ kind: "retype_pending", column: "created", to: "BIGINT" }]);
    expect(await assetRow(w, "ch")).toMatchObject({ cursor_value: "1726000000", cursor_type: "integer", cursor_unit: "s" });
  });

  test("a cursor column whose type changed after the first load is CURSOR_TYPE_MISMATCH", async () => {
    const w = warehouse();
    await load(w, "ch", { columns: { id: "VARCHAR", created: "BIGINT" }, cursor: { field: "created", type: "integer" }, rows: [{ id: "a", created: 5 }] },
      { write: "merge", key: ["id"], now: T0 });
    const e = await rejection(load(w, "ch2", { columns: { id: "VARCHAR", created: "DOUBLE" }, cursor: { field: "created", type: "integer" }, rows: [{ id: "a", created: 5.5 }] },
      { write: "merge", key: ["id"], now: T0 }));
    expect(e.code).toBe("CURSOR_TYPE_MISMATCH");
  });

  test("SINCE_IGNORED when most rows are older than the since the code received", async () => {
    const w = warehouse();
    const old = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, updated_at: `2026-01-0${(i % 9) + 1}T00:00:00Z` }));
    await load(w, "gh", spec(old), { write: "merge", key: ["id"], now: T0 });
    const r = await load(w, "gh", spec([...old, { id: 11, updated_at: T1 }]), { write: "merge", key: ["id"], now: T1, sinceUsed: "2026-09-01T00:00:00Z" });
    expect(r.warnings.find((p) => p.code === "SINCE_IGNORED")?.details).toEqual({ field: "updated_at", since: "2026-09-01T00:00:00Z", older: 10, rows: 11 });
    const ok = await load(w, "gh", spec([{ id: 12, updated_at: T2 }]), { write: "merge", key: ["id"], now: T2, sinceUsed: "2026-09-22T11:00:00Z" });
    expect(ok.warnings.map((p) => p.code)).not.toContain("SINCE_IGNORED");
  });
});

describe("out-of-band changes", () => {
  test("a write outside croft is reported at the next write and bumps last_replaced_at once", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(3) }, { key: ["id"], now: T0 });
    await w.write("outside", (tx) => tx.exec(`DELETE FROM zones WHERE id = 3`), { runId: "x" });
    const r = await load(w, "zones", { ...zones, rows: zoneRows(3) }, { key: ["id"], now: T1 });
    const p = r.warnings.find((x) => x.code === "OUT_OF_BAND_CHANGE");
    expect(p?.details).toEqual({
      expected: { rowCount: 3, maxLoadedAt: "2026-09-22T10:00:00.000000Z" },
      actual: { exists: true, rowCount: 2, maxLoadedAt: "2026-09-22T10:00:00.000000Z" },
    });
    expect(r.rows).toMatchObject({ added: 1, unchanged: 2 });
    expect(await assetRow(w, "zones")).toMatchObject({ last_replaced_at: "2026-09-22T11:00:00.000000Z", row_count: 3 });
    const next = await load(w, "zones", { ...zones, rows: zoneRows(3) }, { key: ["id"], now: T2 });
    expect(next.warnings.map((x) => x.code)).not.toContain("OUT_OF_BAND_CHANGE");
    expect(await assetRow(w, "zones")).toMatchObject({ last_replaced_at: "2026-09-22T11:00:00.000000Z" });
  });

  test("a stamp written outside croft still keeps croft's stamps increasing", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(1) }, { key: ["id"], now: T0 });
    await w.write("outside", (tx) => tx.exec(`UPDATE zones SET _loaded_at = '2026-09-23T00:00:00Z'`), { runId: "x" });
    const r = await load(w, "zones", { ...zones, rows: zoneRows(1, { 1: "changed" }) }, { key: ["id"], now: T1 });
    expect(r.loadedAt).toBe("2026-09-23T00:00:00.000001Z");
    expect(r.warnings.map((x) => x.code)).toContain("OUT_OF_BAND_CHANGE");
  });

  test("a column added outside croft is TABLE_MODIFIED_OUTSIDE_CROFT, and state catches up", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(2) }, { key: ["id"], now: T0 });
    await w.write("outside", (tx) => tx.exec(`ALTER TABLE zones ADD COLUMN notes VARCHAR`), { runId: "x" });
    const r = await load(w, "zones", { ...zones, rows: zoneRows(2) }, { key: ["id"], now: T1 });
    expect(r.warnings.find((x) => x.code === "TABLE_MODIFIED_OUTSIDE_CROFT")?.details).toMatchObject({ added: [{ name: "notes", type: "VARCHAR" }] });
    expect(await read(w, `SELECT name, present_last_batch FROM _croft.columns WHERE asset = 'zones' AND name = 'notes'`)).toEqual([{ name: "notes", present_last_batch: false }]);
    const again = await load(w, "zones", { ...zones, rows: zoneRows(2) }, { key: ["id"], now: T2 });
    expect(again.warnings.map((x) => x.code)).not.toContain("TABLE_MODIFIED_OUTSIDE_CROFT");
  });
});

describe("identifiers", () => {
  test("reserved words, mixed case and quotes in names are quoted everywhere", async () => {
    const w = warehouse();
    const spec = (rows: Rows) => ({ columns: { order: "BIGINT", 'we"ird': "VARCHAR", Group: "VARCHAR" }, rows });
    await load(w, "orders", spec([{ order: 1, 'we"ird': "a", Group: "g" }]), { write: "merge", key: ["order"], now: T0 });
    const r = await load(w, "orders", spec([{ order: 1, 'we"ird': "b", Group: "g" }, { order: 2, 'we"ird': "c", Group: "h" }]), { write: "replace", key: ["order"], now: T1 });
    expect(r.rows).toMatchObject({ added: 1, updated: 1 });
    expect(await read(w, `SELECT "order", "we""ird" AS w, "group" AS g FROM orders ORDER BY 1`)).toEqual([{ order: 1, w: "b", g: "g" }, { order: 2, w: "c", g: "h" }]);
  });

  test("a TEMP table named like the asset does not shadow the real table", async () => {
    const w = warehouse();
    await load(w, "zones", { ...zones, rows: zoneRows(2) }, { key: ["id"], now: T0 });
    const r = await w.write("zones", async (tx) => {
      await tx.exec(`CREATE TEMP TABLE zones (x INTEGER)`);
      const batch = await makeBatch(tx, "zones", { ...zones, rows: zoneRows(3) });
      return writeBatch(tx, { batch, target: { asset: "zones", write: "replace", key: ["id"], runId: "r" }, now: T1 });
    }, { runId: "r" });
    expect(r.rows).toMatchObject({ added: 1, unchanged: 2, total: 3 });
  });
});

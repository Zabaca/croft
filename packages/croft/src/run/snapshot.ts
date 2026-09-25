// Parquet snapshots of warehouse tables, so asset code never touches the warehouse (DESIGN.md §5 "Owning the
// DuckDB file"): croft copies what the code may read under one short read lease, and the code reads the copy
// through a private in-memory DuckDB (the "memory" sandbox profile) while croft holds no lock at all.
//
// - ctx.query for ingests (§3a "ctx.query(sql)"): one read-only SELECT against a snapshot of the ingest's OWN
//   table, as it was before this run. On the first ctx.query of a step, croft copies the table to
//   <staging>/snapshot.parquet and answers every query from a private DuckDB where the asset's name is a view
//   over that file. The one-SELECT gate runs on every query, with the whole state folder protected, so user
//   SQL can read neither runs.sqlite nor the staging of other assets.
// - The inputs of a TS transform (§3e "User code never holds the warehouse lock"): snapshotInput copies one
//   input to <staging>/<asset>/in/<input>/, ordered by (_loaded_at, key), in full (all.parquet: rows() and
//   query()) or only the rows after the transform's composite position in that input (new.parquet:
//   newRows()). run/inputs.ts streams them.
//
// Parquet has no HUGEINT: DuckDB writes it as DOUBLE, which rounds 170141183460469231731687303715884105727 [V,
// run/snapshot.test.ts]. HUGEINT columns are therefore written as text and cast back in the view. (DESIGN.md
// §3e says DECIMAL(38,0), which cannot hold HUGEINT's 39-digit extremes: the COPY would fail on them.)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";
import type { Row } from "../types.ts";
import { canonicalPath, openMemory } from "../db/connect.ts";
import { hasState } from "../db/state.ts";
import { LeaseSql, type DuckWarehouse } from "../db/warehouse.ts";
import { RESERVED } from "../load/contract.ts";
import { quoteIdent, quoteLiteral, readTableSchema, type RealColumn } from "../load/evolve.ts";
import { isoMicros } from "../safety/guards.ts";
import { assertOneSelect } from "../sql/gate.ts";

export const SNAPSHOT_FILE = "snapshot.parquet";

const AS_TEXT = new Set(["HUGEINT", "UHUGEINT"]);

export interface SnapshotResult {
  /** The Parquet file, or null when the table does not exist yet (the asset's first run). */
  path: string | null;
  columns: RealColumn[];
}

/**
 * Copy `table` to `<dir>/snapshot.parquet` under one short read lease. The directory must be inside the
 * warehouse sandbox (the state folder). HUGEINT columns are stored as text.
 */
export async function snapshotTable(warehouse: DuckWarehouse, table: string, dir: string, signal?: AbortSignal): Promise<SnapshotResult> {
  mkdirSync(dir, { recursive: true });
  const path = join(canonicalPath(dir), SNAPSHOT_FILE);
  return warehouse.read(async (db) => {
    const columns = await readTableSchema(db, table);
    if (!columns) return { path: null, columns: [] };
    const select = columns.map((c) => AS_TEXT.has(c.type) ? `CAST(${quoteIdent(c.name)} AS VARCHAR) AS ${quoteIdent(c.name)}` : quoteIdent(c.name));
    await db.exec(`COPY (SELECT ${select.join(", ")} FROM main.${quoteIdent(table)}) TO ${quoteLiteral(path)} (FORMAT parquet)`);
    return { path, columns };
  }, { purpose: `snapshot ${table} for ctx.query`, ...(signal ? { signal } : {}) });
}

/** The view that puts a snapshot back under the table's name, with HUGEINT columns cast back. */
export function snapshotViewSql(table: string, path: string, columns: readonly RealColumn[]): string {
  const casts = columns.filter((c) => AS_TEXT.has(c.type)).map((c) => `CAST(${quoteIdent(c.name)} AS ${c.type}) AS ${quoteIdent(c.name)}`);
  const replace = casts.length ? ` REPLACE (${casts.join(", ")})` : "";
  return `CREATE OR REPLACE VIEW ${quoteIdent(table)} AS SELECT *${replace} FROM read_parquet(${quoteLiteral(path)})`;
}

export interface OwnTableOptions {
  warehouse: DuckWarehouse;
  asset: string;
  /** The step's staging folder (under the state folder). */
  dir: string;
  stateDir: string;
  timezone: string;
  /** The step's signal: Ctrl-C ends the wait for the snapshot's read lease. */
  signal?: AbortSignal;
  /** --rebuild: the step builds the table from scratch, so ctx.query sees none of its own, as on a first load (its
   *  old table stays in the warehouse until the step's first write replaces it). */
  absent?: boolean;
}

/** ctx.query for one ingest step. Lazy: nothing is copied unless the asset calls ctx.query. */
export class OwnTableQuery {
  #init: Promise<{ conn: DuckDBConnection; exists: boolean }> | null = null;
  #db: Awaited<ReturnType<typeof openMemory>> | null = null;
  #closed = false;

  constructor(private readonly o: OwnTableOptions) {}

  /** One SELECT over the asset's own table as it was before this run. Rows come back in "ts" form. */
  async query<T extends Row = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
    if (typeof sql !== "string") {
      throw new CroftError("QUERY_NOT_SELECT", { message: "ctx.query takes one SELECT as a string", hint: 'ctx.query("select max(id) as id from ' + this.o.asset + '")', asset: this.o.asset });
    }
    const { conn, exists } = await this.open();
    await assertOneSelect(conn, sql, { profile: "memory", protect: [this.o.stateDir] });
    try {
      return await new LeaseSql(conn, { mode: "ts", timezone: this.o.timezone }, null).all<T>(sql, params);
    } catch (e) {
      if (e instanceof CroftError) throw e;
      const message = (e as Error).message ?? String(e);
      const missing = !exists && new RegExp(`Table with name ${this.o.asset} does not exist`, "i").test(message);
      throw new CroftError("QUERY_FAILED", {
        asset: this.o.asset,
        message: missing
          ? `${this.o.asset} has no table yet (this is its first load), so ctx.query has nothing to read`
          : `ctx.query failed: ${message.split("\n")[0]}`,
        hint: missing
          ? "on the first run there is nothing saved yet; handle it, e.g. `const known = since === undefined ? [] : await query(...)`"
          : `ctx.query reads ${this.o.asset} as it was before this run; check the SQL`,
        details: { sql: sql.slice(0, 500), duckdb: message.split("\n")[0] },
      });
    }
  }

  private open(): Promise<{ conn: DuckDBConnection; exists: boolean }> {
    if (this.#closed) {
      return Promise.reject(new CroftError("QUERY_FAILED", {
        message: "ctx.query was called after the step finished", hint: "await every ctx.query inside rows()", asset: this.o.asset,
      }));
    }
    this.#init ??= (async () => {
      const snap: SnapshotResult = this.o.absent ? { path: null, columns: [] } : await snapshotTable(this.o.warehouse, this.o.asset, this.o.dir, this.o.signal);
      const db = await openMemory({ timezone: this.o.timezone, stateDir: this.o.stateDir });
      this.#db = db;
      const conn = await db.connect();
      if (snap.path) await conn.run(snapshotViewSql(this.o.asset, snap.path, snap.columns));
      return { conn, exists: snap.path !== null };
    })();
    this.#init.catch(() => { this.#init = null; });
    return this.#init;
  }

  close(): void {
    this.#closed = true;
    try {
      this.#db?.close();
    } catch {}
    this.#db = null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The inputs of a TS transform (DESIGN.md §3e)

/** A transform's input snapshots, under <staging>/<asset>/in/<input>/. */
export const INPUT_FILES = { all: "all.parquet", new: "new.parquet" } as const;

/**
 * newRows()'s composite position in one input (§3e "Positions never skip rows"): the last input row the
 * transform fully processed, as its `_loaded_at` stamp (ISO-8601 UTC with microseconds) and its key, each key
 * value as DuckDB's own text for it (CAST(k AS VARCHAR)), which casts back to exactly that value. Never a
 * JavaScript Date, which keeps milliseconds while stamps differ by microseconds. The rows after it are
 * `_loaded_at > stamp OR (_loaded_at = stamp AND key > key)`, the key compared column by column; a null key
 * means every row stamped `stamp` was processed.
 */
export interface SeenPosition { stamp: string; key: string[] | null }

/** What croft knows about an input table. */
export interface InputFacts {
  columns: RealColumn[];
  /** The input's key columns (_croft.assets.key_columns) as the table spells them; [] without a key. */
  key: RealColumn[];
  /** _croft.assets.last_loaded_at, when the input's rows last changed; null when croft recorded no write. */
  lastLoadedAt: string | null;
  /**
   * The input's version: the newer of last_loaded_at and last_replaced_at. An out-of-band change that no write
   * followed (doctor, or a write that found one and changed no row) moves last_replaced_at alone, past
   * last_loaded_at. A transform that read all of the input records this as InputPosition.inputLastLoadedAt,
   * which staleness compares last_replaced_at with (input_replaced), so the reason clears once it has re-read
   * the input. Null when croft recorded no write.
   */
  version: string | null;
  /** _croft.assets.row_count. */
  rows: number | null;
}

/** An input's facts, or null when it has no table. Run inside a lease. */
export async function readInputFacts(db: Sql, input: string): Promise<InputFacts | null> {
  const columns = await readTableSchema(db, input);
  if (!columns) return null;
  if (!(await hasState(db))) return { columns, key: [], lastLoadedAt: null, version: null, rows: null };
  // greatest() skips NULLs: an input with no out-of-band change has its last_loaded_at as its version.
  const [a] = await db.all<{ key_columns: unknown; ll: number | bigint | null; v: number | bigint | null; row_count: number | bigint | null }>(
    `SELECT key_columns, epoch_us(last_loaded_at) AS ll, epoch_us(greatest(last_loaded_at, last_replaced_at)) AS v, row_count
       FROM _croft.assets WHERE name = $1`, [input]);
  const declared = Array.isArray(a?.key_columns) ? a.key_columns.map(String) : [];
  const key = declared.map((k) => columns.find((c) => c.name.toLowerCase() === k.toLowerCase()));
  const us = (v: number | bigint | null | undefined) => (v === null || v === undefined ? null : isoMicros(BigInt(v)));
  return {
    columns,
    // A key column the table no longer has cannot order positions: without it every read is in full.
    key: key.every((c): c is RealColumn => c !== undefined) ? key : [],
    lastLoadedAt: us(a?.ll),
    version: us(a?.v),
    rows: a?.row_count === null || a?.row_count === undefined ? null : Number(a.row_count),
  };
}

/** Whether a position can be compared with an input's rows by its key (same number of key columns). */
export function keyedPosition(pos: SeenPosition, key: readonly RealColumn[]): boolean {
  return pos.key !== null && key.length > 0 && pos.key.length === key.length;
}

/**
 * The rows after a position, as SQL over the input's columns with parameters $first, $first+1, ...: the stamp,
 * then each key value, cast to its column's type. A position whose key does not fit the input's key (the key
 * changed) compares by stamp alone, which re-reads the rows of that one stamp rather than skip any.
 */
export function afterPosition(pos: SeenPosition, key: readonly RealColumn[], first = 1): { sql: string; params: string[] } {
  const stamp = quoteIdent(RESERVED.loadedAt);
  const s = `CAST($${first} AS TIMESTAMPTZ)`;
  if (!keyedPosition(pos, key)) return { sql: `${stamp} > ${s}`, params: [pos.stamp] };
  const col = (i: number) => quoteIdent(key[i]!.name);
  const val = (i: number) => `CAST($${first + 1 + i} AS ${key[i]!.type})`;
  let expr = `${col(key.length - 1)} > ${val(key.length - 1)}`;
  for (let i = key.length - 2; i >= 0; i--) expr = `${col(i)} > ${val(i)} OR (${col(i)} = ${val(i)} AND (${expr}))`;
  return { sql: `${stamp} > ${s} OR (${stamp} = ${s} AND (${expr}))`, params: [pos.stamp, ...pos.key!] };
}

/** The alias of the input table in a snapshot's COPY: ORDER BY names its columns through it. */
const SOURCE = "__croft_src";

/**
 * The order of an input snapshot, which is the order positions advance in (§3e): (_loaded_at, key), by the
 * input's own column values. The columns are qualified with the table's alias because an ORDER BY name binds a
 * SELECT alias first, and the COPY's SELECT writes HUGEINT keys as text under their own names: unqualified,
 * keys 2, 9, 10, 100 would be ordered "10" < "100" < "2" < "9", while positions compare them as numbers.
 */
export function positionOrder(columns: readonly RealColumn[], key: readonly RealColumn[], source = SOURCE): string {
  const stamp = columns.find((c) => c.name === RESERVED.loadedAt);
  const cols = [...(stamp ? [stamp] : []), ...key].map((c) => `${source}.${quoteIdent(c.name)}`);
  return cols.length ? ` ORDER BY ${cols.join(", ")}` : "";
}

/** How many rows of an input come after a position (all of them for null): the cost guard's count. */
export async function countAfter(db: Sql, input: string, facts: InputFacts, pos: SeenPosition | null): Promise<number> {
  const hasStamp = facts.columns.some((c) => c.name === RESERVED.loadedAt);
  const where = pos && hasStamp ? afterPosition(pos, facts.key) : null;
  const [row] = await db.all<{ n: number | bigint }>(
    `SELECT count(*) AS n FROM main.${quoteIdent(input)}${where ? ` WHERE ${where.sql}` : ""}`, where?.params ?? []);
  return Number(row?.n ?? 0);
}

/** One input snapshot of a TS transform. */
export interface InputSnapshot {
  input: string;
  kind: keyof typeof INPUT_FILES;
  path: string;
  facts: InputFacts;
  /** Rows in the file. */
  rows: number;
  /** A row cap (preview) cut the copy short: the file is not all there was. */
  capped: boolean;
  /** Where a "new" snapshot starts (null: from the first row). */
  after: SeenPosition | null;
}

export interface InputSnapshotOptions {
  input: string;
  /** <staging>/<asset>/in/<input>/, inside the state folder (the warehouse sandbox allows it). */
  dir: string;
  /** all: every row (rows(), query()); new: the rows after `after` (newRows()). */
  kind: keyof typeof INPUT_FILES;
  after?: SeenPosition | null;
  /** At most this many rows, the first in position order (croft's preview row cap). */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Copy one input of a TS transform to Parquet under one short read lease, ordered by (_loaded_at, key), with
 * HUGEINT columns as text (snapshotColumnsSql casts them back). null when the input has no table.
 */
export async function snapshotInput(warehouse: DuckWarehouse, o: InputSnapshotOptions): Promise<InputSnapshot | null> {
  mkdirSync(o.dir, { recursive: true });
  const path = join(canonicalPath(o.dir), INPUT_FILES[o.kind]);
  return warehouse.read(async (db) => {
    const facts = await readInputFacts(db, o.input);
    if (!facts) return null;
    const hasStamp = facts.columns.some((c) => c.name === RESERVED.loadedAt);
    const after = o.kind === "new" && o.after && hasStamp ? o.after : null;
    const where = after ? afterPosition(after, facts.key) : null;
    const col = (c: RealColumn) => `${SOURCE}.${quoteIdent(c.name)}`;
    const select = facts.columns.map((c) => AS_TEXT.has(c.type) ? `CAST(${col(c)} AS VARCHAR) AS ${quoteIdent(c.name)}` : `${col(c)} AS ${quoteIdent(c.name)}`);
    // One row past the cap tells a capped copy from an input with exactly `limit` rows; readers stop at the cap.
    const limit = o.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(o.limit)) + 1}` : "";
    // WHERE binds the table's own (typed) columns; ORDER BY names them through the alias (positionOrder).
    const [row] = await db.all<{ Count: number | bigint }>(
      `COPY (SELECT ${select.join(", ")} FROM main.${quoteIdent(o.input)} AS ${SOURCE}${where ? ` WHERE ${where.sql}` : ""}${positionOrder(facts.columns, facts.key)}${limit})
       TO ${quoteLiteral(path)} (FORMAT parquet)`, where?.params ?? []);
    const copied = Number(row?.Count ?? 0);
    const capped = o.limit !== undefined && copied > o.limit;
    return { input: o.input, kind: o.kind, path, facts, rows: capped ? Math.floor(o.limit!) : copied, capped, after };
  }, { purpose: `snapshot ${o.input} for a transform`, ...(o.signal ? { signal: o.signal } : {}) });
}

/** The SELECT list that reads an input snapshot back with the input's own types (HUGEINT cast back). */
export function snapshotColumnsSql(columns: readonly RealColumn[]): string {
  const casts = columns.filter((c) => AS_TEXT.has(c.type)).map((c) => `CAST(${quoteIdent(c.name)} AS ${c.type}) AS ${quoteIdent(c.name)}`);
  return `*${casts.length ? ` REPLACE (${casts.join(", ")})` : ""}`;
}

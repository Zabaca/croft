// ctx.query for ingests (DESIGN.md §3a "ctx.query(sql)", §5 "Owning the DuckDB file"): one read-only SELECT
// against a snapshot of the ingest's OWN table, as it was before this run.
//
// Asset code runs while croft holds no database lock, so it never touches the warehouse. On the first
// ctx.query of a step, croft copies the table to <staging>/snapshot.parquet under one short read lease and
// then answers every query from a private in-memory DuckDB (the "memory" sandbox profile) where the asset's
// name is a view over that file. The one-SELECT gate runs on every query, with the whole state folder
// protected, so user SQL can read neither runs.sqlite nor the staging of other assets.
//
// Parquet has no HUGEINT: DuckDB writes it as DOUBLE, which rounds 170141183460469231731687303715884105727 [V,
// run/snapshot.test.ts]. HUGEINT columns are therefore written as text and cast back in the view.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { Row } from "../types.ts";
import { canonicalPath, openMemory } from "../db/connect.ts";
import { LeaseSql, type DuckWarehouse } from "../db/warehouse.ts";
import { quoteIdent, quoteLiteral, readTableSchema, type RealColumn } from "../load/evolve.ts";
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
export async function snapshotTable(warehouse: DuckWarehouse, table: string, dir: string): Promise<SnapshotResult> {
  mkdirSync(dir, { recursive: true });
  const path = join(canonicalPath(dir), SNAPSHOT_FILE);
  return warehouse.read(async (db) => {
    const columns = await readTableSchema(db, table);
    if (!columns) return { path: null, columns: [] };
    const select = columns.map((c) => AS_TEXT.has(c.type) ? `CAST(${quoteIdent(c.name)} AS VARCHAR) AS ${quoteIdent(c.name)}` : quoteIdent(c.name));
    await db.exec(`COPY (SELECT ${select.join(", ")} FROM main.${quoteIdent(table)}) TO ${quoteLiteral(path)} (FORMAT parquet)`);
    return { path, columns };
  }, { purpose: `snapshot ${table} for ctx.query` });
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
      const snap = await snapshotTable(this.o.warehouse, this.o.asset, this.o.dir);
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

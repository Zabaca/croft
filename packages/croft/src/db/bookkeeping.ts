// croft's bookkeeping tables behind one interface, with two adapters (DESIGN.md §5 "Where state lives", D132).
//
// - file: today's tables in schema _croft, primary keys and upserts, exactly as every existing warehouse has them.
// - log: what a DuckLake can hold. DuckLake refuses primary keys, unique and check constraints, INSERT OR REPLACE and
//   RETURNING on MERGE, UPDATE and DELETE. Each keyed table becomes an append-only log `_croft.<t>_log` (the table's
//   columns, then `seq` and `closed`), and `_croft.<t>` is a VIEW over it that keeps the newest row of each key and
//   leaves out a key whose newest row is a closing row. So every read of `_croft.<t>` is the same SQL in both adapters;
//   only the writes differ, and they all go through this module. `_croft.meta` stays a plain table in both and is
//   upserted by a MERGE that returns nothing.
//
// The log's order is `seq`, which croft assigns as one more than the highest in the log inside the writing transaction.
// A timestamp cannot order it (now() is fixed for a whole transaction), and a row id would not survive the trash
// and restore copying rows out and back (option 07's lake spike, follow-up f2). `seq` and `closed` may be NULL for a row
// somebody inserted by hand: NULL sorts last, so any row croft writes is newer.
//
// In a file a statement of the log adapter that writes reads the highest `seq` in a subquery of its own. In a lake it reads it once per
// transaction and table, into a variable of the connection (`croft_seq_<table>`), and numbers the rows from that: a lake's catalog is a
// network away, and the subquery was four or five round trips for each of the dozen bookkeeping rows of a write (D145). Two writers could
// pick the same number only for different keys, because writes to one asset are already one at a time (the asset leases), and a variable
// belongs to the connection, so every wrapper around the transaction's `Sql` sees the same one; the write path resets them as it begins.
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";
import { LAKE_ALIAS } from "./modes.ts";

export type BookkeepingKind = "file" | "log";

/** Whether the connection's current database is a DuckLake: the warehouse of a lake project (db/modes.ts attaches it as `lake` and
 *  every connection works in it). Asked of the database itself, so it holds through any wrapper around the connection. */
export async function inLake(db: Sql): Promise<boolean> {
  const rows = await db.all<{ t: string }>(`SELECT type AS t FROM duckdb_databases() WHERE database_name = current_database()`);
  return rows[0]?.t === "ducklake";
}

/** A column list ("name VARCHAR, ...") and the columns that make a row's identity, per bookkeeping table. */
export const STATE_SPECS = {
  meta: { columns: "key VARCHAR, value VARCHAR", key: ["key"] },
  assets: {
    columns: `name VARCHAR, kind VARCHAR, write_mode VARCHAR, key_columns VARCHAR[], code_hash VARCHAR, behavior_hash VARCHAR,
    cursor_value VARCHAR, cursor_type VARCHAR, cursor_unit VARCHAR,
    last_loaded_at TIMESTAMPTZ, last_replaced_at TIMESTAMPTZ,
    row_count BIGINT, max_loaded_at TIMESTAMPTZ, updated_at TIMESTAMPTZ`,
    key: ["name"],
  },
  columns: {
    columns: `asset VARCHAR, name VARCHAR, type VARCHAR, source_name VARCHAR, format VARCHAR,
    pinned BOOLEAN, pending BOOLEAN, kinds VARCHAR[], present_last_batch BOOLEAN, added_at TIMESTAMPTZ`,
    key: ["asset", "name"],
  },
  inputs: {
    columns: `asset VARCHAR, input VARCHAR, seen_loaded_at TIMESTAMPTZ, seen_key JSON, input_last_loaded_at TIMESTAMPTZ`,
    key: ["asset", "input"],
  },
  files: {
    columns: `asset VARCHAR, path VARCHAR, size BIGINT, mtime TIMESTAMPTZ, etag VARCHAR, sha256 VARCHAR, loaded_at TIMESTAMPTZ`,
    key: ["asset", "path"],
  },
  writes: {
    columns: `asset VARCHAR, loaded_at TIMESTAMPTZ, run_id VARCHAR, mode VARCHAR,
    rows_in BIGINT, added BIGINT, updated BIGINT, unchanged BIGINT, deleted BIGINT,
    cursor_before VARCHAR, cursor_after VARCHAR, since_used VARCHAR, inputs JSON,
    schema_changes JSON, code_hash VARCHAR, attempt INTEGER`,
    key: ["asset", "loaded_at"],
  },
} as const satisfies Record<string, { columns: string; key: readonly string[] }>;

export type StateTableName = keyof typeof STATE_SPECS;
export const STATE_TABLE_NAMES = Object.keys(STATE_SPECS) as StateTableName[];
/** The five tables of an asset's state (everything but meta): the ones keyed by asset, which the trash copies out and a
 *  restore copies back, and the ones that keep a log in the log adapter. The one list of them. */
export const ASSET_TABLES = ["assets", "columns", "inputs", "files", "writes"] as const satisfies readonly Exclude<StateTableName, "meta">[];
/** The asset-keyed tables' column that names the asset: `name` in assets, `asset` in the others. */
export const assetColumn = (t: (typeof ASSET_TABLES)[number]): string => (t === "assets" ? "name" : "asset");

const keyOf = (t: StateTableName): readonly string[] => STATE_SPECS[t].key;
const logOf = (t: StateTableName): string => `_croft.${t}_log`;

/** The kind a new warehouse gets when nothing says otherwise: always the file, outside croft's own test harness.
 *
 *  The log adapter exists for lake mode (option 07). Until a lake can be attached (slice 2) the only way to get one is
 *  CROFT_BOOKKEEPING=log, a switch for the test suite alone, so that the whole suite can run on the log with no Postgres. It is
 *  honoured only when CROFT_TEST_HARNESS=1 is set as well, which tests/preload.ts sets for the test process and
 *  bookkeepingEnv() (db/bookkeeping-testkit.ts) gives every croft a test spawns; the variable alone, in a user's shell, does
 *  nothing, so no user can make a log warehouse before a lake gives them a path to one. It decides only for a warehouse with no
 *  bookkeeping yet: a warehouse that has some keeps its kind. */
export function defaultBookkeeping(env: NodeJS.ProcessEnv = process.env): BookkeepingKind {
  return env.CROFT_BOOKKEEPING === "log" && env.CROFT_TEST_HARNESS === "1" ? "log" : "file";
}

/** CREATE statements of the file adapter: the tables as every warehouse has had them since format 1. */
export function fileDdl(): string[] {
  return STATE_TABLE_NAMES.map((t) => `CREATE TABLE IF NOT EXISTS _croft.${t} (${STATE_SPECS[t].columns}, PRIMARY KEY (${keyOf(t).join(", ")}))`);
}

/** The log adapter's tables and views, one statement each, by the name of the object it creates. */
export function logDdl(): { name: string; ddl: string }[] {
  const out: { name: string; ddl: string }[] = [{ name: "meta", ddl: `CREATE TABLE IF NOT EXISTS _croft.meta (${STATE_SPECS.meta.columns})` }];
  for (const t of ASSET_TABLES) {
    out.push({ name: `${t}_log`, ddl: `CREATE TABLE IF NOT EXISTS ${logOf(t)} (${STATE_SPECS[t].columns}, seq BIGINT, closed BOOLEAN)` });
  }
  for (const t of ASSET_TABLES) {
    out.push({
      name: t,
      ddl: `CREATE VIEW IF NOT EXISTS _croft.${t} AS SELECT * EXCLUDE (seq, closed) FROM ${logOf(t)}
    QUALIFY row_number() OVER (PARTITION BY ${keyOf(t).join(", ")} ORDER BY seq DESC NULLS LAST, rowid DESC) = 1 AND NOT coalesce(closed, false)`,
    });
  }
  return out;
}

/** The names of the tables and views in the _croft schema of the current database. */
export async function stateObjects(sql: Sql): Promise<Set<string>> {
  const rows = await sql.all<{ n: string }>(
    `SELECT table_name AS n FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = '_croft'
     UNION ALL
     SELECT view_name AS n FROM duckdb_views() WHERE database_name = current_database() AND schema_name = '_croft' AND NOT internal`);
  return new Set(rows.map((r) => r.n));
}

/** Which adapter a database's bookkeeping belongs to, from the objects in it: `assets_log` makes it a log; the plain
 *  tables make it a file; nothing (or only meta) is neither. */
export function kindOfObjects(names: ReadonlySet<string>): BookkeepingKind | null {
  if (names.has("assets_log")) return "log";
  if (ASSET_TABLES.some((t) => names.has(t))) return "file";
  return null;
}

/** Writes to the bookkeeping tables. Values are SQL expressions (`$1`, `CAST($4::JSON AS VARCHAR[])`, `now()`), and the
 *  statement's parameters are shared, so a caller writes the same text for either adapter. */
export interface Bookkeeping {
  readonly kind: BookkeepingKind;
  /** Insert a row, replacing the one with the same key (INSERT OR REPLACE). Name every column of the table: the file's
   *  INSERT OR REPLACE sets only the columns it names, the log's new row has NULL in the others. */
  upsert(table: StateTableName, row: Record<string, string>, params?: unknown[]): Promise<void>;
  /** Insert a row whose key is new. A key that is already there is refused (the file's primary key, the log's duplicate-key check). */
  insert(table: StateTableName, row: Record<string, string>, params?: unknown[]): Promise<void>;
  /** Set columns of the rows where `where` holds. A column of the key is changed with rekey(), never here. */
  update(table: StateTableName, set: Record<string, string>, where: string, params?: unknown[]): Promise<void>;
  /** Delete the rows where `where` holds. */
  remove(table: StateTableName, where: string, params?: unknown[]): Promise<void>;
  /** Move rows whose `column` is `from` to `to`: a changed key. In a log that is a new row and a closing row per key. */
  rekey(table: StateTableName, column: string, from: string, to: string): Promise<void>;
  /** Insert the rows of a SELECT, by column name (a trash file's rows, a preview's copy). */
  insertSelect(table: StateTableName, select: string, params?: unknown[]): Promise<void>;
}

const cols = (row: Record<string, string>) => Object.keys(row).join(", ");
const vals = (row: Record<string, string>) => Object.values(row).join(", ");

class FileBookkeeping implements Bookkeeping {
  readonly kind = "file" as const;
  constructor(private readonly tx: Sql) {}

  async upsert(table: StateTableName, row: Record<string, string>, params: unknown[] = []): Promise<void> {
    await this.tx.exec(`INSERT OR REPLACE INTO _croft.${table} (${cols(row)}) VALUES (${vals(row)})`, params);
  }
  async insert(table: StateTableName, row: Record<string, string>, params: unknown[] = []): Promise<void> {
    await this.tx.exec(`INSERT INTO _croft.${table} (${cols(row)}) VALUES (${vals(row)})`, params);
  }
  async update(table: StateTableName, set: Record<string, string>, where: string, params: unknown[] = []): Promise<void> {
    await this.tx.exec(`UPDATE _croft.${table} SET ${Object.entries(set).map(([c, e]) => `${c} = ${e}`).join(", ")} WHERE ${where}`, params);
  }
  async remove(table: StateTableName, where: string, params: unknown[] = []): Promise<void> {
    await this.tx.exec(`DELETE FROM _croft.${table} WHERE ${where}`, params);
  }
  async rekey(table: StateTableName, column: string, from: string, to: string): Promise<void> {
    await this.tx.exec(`UPDATE _croft.${table} SET ${column} = $2 WHERE ${column} = $1`, [from, to]);
  }
  async insertSelect(table: StateTableName, select: string, params: unknown[] = []): Promise<void> {
    await this.tx.exec(`INSERT INTO _croft.${table} BY NAME ${select}`, params);
  }
}

/** The statement text uses `$n` for parameter n; keep only the parameters `texts` use, renumbered from $1. */
function onlyUsed(texts: string[], params: unknown[]): { texts: string[]; params: unknown[] } {
  const order: number[] = [];
  const renumber = (s: string) => s.replace(/\$(\d+)/g, (_m, d: string) => {
    const n = Number(d);
    let at = order.indexOf(n);
    if (at < 0) at = order.push(n) - 1;
    return `$${at + 1}`;
  });
  const out = texts.map(renumber);
  return { texts: out, params: order.map((n) => params[n - 1]) };
}

/** The most rows of one bookkeeping table that croft writes in inserts small enough to stay in the catalog in one go: at DuckLake's 10 rows an
 *  insert, a hundred statements, which a transaction can carry at a distance (D179, D197). More than that is one insert, which a lake puts in a file. */
export const INLINE_MAX_ROWS = 1000;

/** How many rows one insert may have and still stay in the catalog: the lake's own option when it has one, else DuckLake's default (10). 0: none. */
export async function inliningLimit(sql: Sql): Promise<number> {
  const stored = (await sql.all<{ option_name: string; value: string }>(`SELECT option_name, value FROM ducklake_options('${LAKE_ALIAS}')`))
    .find((r) => r.option_name === "data_inlining_row_limit");
  if (stored) return Math.max(0, Math.trunc(Number(stored.value)) || 0);
  try {
    const [r] = await sql.all<{ v: unknown }>(`SELECT current_setting('ducklake_default_data_inlining_row_limit') AS v`);
    const n = Math.trunc(Number(r?.v));
    return Number.isFinite(n) && n >= 0 ? n : 10;
  } catch {
    return 10;
  }
}

/** The connection variable that holds the highest `seq` of a log table inside a lake transaction. */
const seqVariable = (table: StateTableName) => `croft_seq_${table}`;

/** The statements that forget the numbers a lake transaction kept: run on a connection as a write transaction begins, since a variable
 *  outlives the transaction (and a rolled-back one), and another process may have written the log since. Local to the connection. */
export function seqResetSql(): string[] {
  return ASSET_TABLES.map((t) => `RESET VARIABLE ${seqVariable(t)}`);
}

class LogBookkeeping implements Bookkeeping {
  readonly kind = "log" as const;
  private perTx: boolean | undefined;
  constructor(private readonly tx: Sql) {}

  /** The highest number in the log, as an expression: the subquery in a file; in a lake the connection's variable, read from the log once
   *  per transaction. Plus 1 for one row, plus row_number() OVER () for a statement's several. */
  private async high(table: StateTableName): Promise<string> {
    this.perTx ??= await inLake(this.tx);
    if (!this.perTx) return `(SELECT coalesce(max(seq), 0) FROM ${logOf(table)})`;
    const v = seqVariable(table);
    const [kept] = await this.tx.all<{ v: number | bigint | null }>(`SELECT getvariable('${v}') AS v`);
    if (kept?.v === null || kept?.v === undefined) await this.tx.exec(`SET VARIABLE ${v} = (SELECT coalesce(max(seq), 0) FROM ${logOf(table)})`);
    return `getvariable('${v}')`;
  }

  /** Write the rows of one INSERT, numbered from `high`; in a lake the variable moves on by the rows written. */
  private async append(table: StateTableName, text: (high: string) => string, params: unknown[]): Promise<void> {
    const high = await this.high(table);
    if (!this.perTx) {
      await this.tx.exec(text(high), params);
      return;
    }
    const [done] = await this.tx.all<{ Count: number | bigint }>(text(high), params);
    await this.tx.exec(`SET VARIABLE ${seqVariable(table)} = getvariable('${seqVariable(table)}') + ${Number(done?.Count ?? 0)}`);
  }

  async upsert(table: StateTableName, row: Record<string, string>, params: unknown[] = []): Promise<void> {
    if (table === "meta") {
      // The one plain table: a MERGE that returns nothing (DuckLake refuses RETURNING on MERGE, and INSERT OR REPLACE).
      const set = Object.keys(row).filter((c) => c !== "key");
      await this.tx.exec(
        `MERGE INTO _croft.meta AS t USING (SELECT ${Object.entries(row).map(([c, e]) => `${e} AS ${c}`).join(", ")}) AS s ON t.key = s.key
         WHEN MATCHED THEN UPDATE SET ${set.map((c) => `${c} = s.${c}`).join(", ")}
         WHEN NOT MATCHED THEN INSERT (${cols(row)}) VALUES (${Object.keys(row).map((c) => `s.${c}`).join(", ")})`, params);
      return;
    }
    await this.append(table, (high) => `INSERT INTO ${logOf(table)} (${cols(row)}, seq, closed) VALUES (${vals(row)}, ${high} + 1, false)`, params);
  }

  /** What a primary key would have said. The checks are made before the write, because the view over a log shows one row
   *  per key whatever the log holds, so a duplicate could not be found afterwards. */
  private duplicate(table: StateTableName, what: string): CroftError {
    const key = keyOf(table);
    return new CroftError("INTERNAL_ERROR", {
      message: `_croft.${table} ${what} (${key.join(", ")}); a primary key would have refused it`,
      hint: "report this croft bug",
      details: { table, key: [...key] },
    });
  }

  async insert(table: StateTableName, row: Record<string, string>, params: unknown[] = []): Promise<void> {
    // The duplicate-key check that stands in for the primary key. NULL key parts compare as equal, as they never
    // do in a primary key, which is the stricter reading and one croft's keys never reach (none is nullable in use).
    const key = keyOf(table);
    const used = onlyUsed(key.map((k) => row[k] ?? "NULL"), params);
    const where = key.map((k, i) => `${k} IS NOT DISTINCT FROM ${used.texts[i]}`).join(" AND ");
    const dup = await this.tx.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM _croft.${table} WHERE ${where}`, used.params);
    if (Number(dup[0]?.n ?? 0) > 0) throw this.duplicate(table, "already has a row for this key");
    await this.upsert(table, row, params);
  }

  async update(table: StateTableName, set: Record<string, string>, where: string, params: unknown[] = []): Promise<void> {
    const changed = Object.entries(set).map(([c, e]) => `${e} AS ${c}`).join(", ");
    await this.appendRows(table, `SELECT * REPLACE (${changed}) FROM _croft.${table} WHERE ${where}`, params, false);
  }

  async remove(table: StateTableName, where: string, params: unknown[] = []): Promise<void> {
    await this.appendRows(table, `SELECT * FROM _croft.${table} WHERE ${where}`, params, true);
  }

  async rekey(table: StateTableName, column: string, from: string, to: string): Promise<void> {
    // A row that would take a key the table has already: the rows under `from` against the rows under `to`, the rest of the key equal.
    const rest = keyOf(table).filter((k) => k !== column).map((k) => `a.${k} IS NOT DISTINCT FROM b.${k}`);
    const [clash] = await this.tx.all<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM _croft.${table} AS a JOIN _croft.${table} AS b ON ${["true", ...rest].join(" AND ")} WHERE a.${column} = $1 AND b.${column} = $2`, [from, to]);
    if (Number(clash?.n ?? 0) > 0) throw this.duplicate(table, "already has a row for a key this rename would give another");
    // The rows under the new key first, then a closing row for each old key (the old rows still read as they were).
    await this.update(table, { [column]: "$2" }, `${column} = $1`, [from, to]);
    await this.remove(table, `${column} = $1`, [from]);
  }

  async insertSelect(table: StateTableName, select: string, params: unknown[] = []): Promise<void> {
    // Keys the table has already, and keys the SELECT has twice (which row would survive is arbitrary): both refused.
    const key = keyOf(table);
    const [there] = await this.tx.all<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM (${select}) AS s JOIN _croft.${table} AS v ON ${key.map((k) => `s.${k} IS NOT DISTINCT FROM v.${k}`).join(" AND ")}`, params);
    if (Number(there?.n ?? 0) > 0) throw this.duplicate(table, "already has a row for a key being inserted");
    const [twice] = await this.tx.all<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM (${select}) AS s GROUP BY ${key.map((k) => `s.${k}`).join(", ")} HAVING count(*) > 1)`, params);
    if (Number(twice?.n ?? 0) > 0) throw this.duplicate(table, "was given a key twice");
    await this.appendRows(table, select, params, false);
  }

  /** Append the rows of a SELECT to the log, numbered in order from its highest `seq`, each a closing row or none. In a lake an insert of more rows
   *  than its inlining limit is written as a Parquet file, and every read of the table then goes to the store (D179): the rows are kept aside
   *  and go in a limit's worth at a time, up to INLINE_MAX_ROWS of them; any more is one insert (D197, and for remove, update and rekey D198). */
  private async appendRows(table: StateTableName, select: string, params: unknown[], closed: boolean): Promise<void> {
    const limit = (this.perTx ??= await inLake(this.tx)) ? await inliningLimit(this.tx) : 0;
    if (limit <= 0) {
      await this.append(table, (high) =>
        `INSERT INTO ${logOf(table)} BY NAME SELECT s.*, ${high} + row_number() OVER () AS seq, ${closed} AS closed FROM (${select}) AS s`, params);
      return;
    }
    const kept = `__croft_insert_${table}`;
    await this.tx.exec(`CREATE OR REPLACE TEMP TABLE ${kept} AS SELECT row_number() OVER () AS __n, s.* FROM (${select}) AS s`, params);
    let failed = true;
    try {
      const [all] = await this.tx.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${kept}`);
      const total = Number(all?.n ?? 0);
      const small = Math.min(total, INLINE_MAX_ROWS);
      const write = (from: number, to: number) => this.append(table, (high) =>
        `INSERT INTO ${logOf(table)} BY NAME SELECT * EXCLUDE (__n), ${high} + row_number() OVER (ORDER BY __n) AS seq, ${closed} AS closed FROM ${kept} WHERE __n > ${from} AND __n <= ${to}`, []);
      for (let from = 0; from < small; from += limit) await write(from, Math.min(from + limit, small));
      if (total > small) await write(small, total);
      failed = false;
    } finally {
      // After a failure the transaction is aborted and the drop would throw over the error that aborted it (D198); the rollback takes the table too.
      try {
        await this.tx.exec(`DROP TABLE IF EXISTS ${kept}`);
      } catch (e) {
        if (!failed) throw e;
      }
    }
  }
}

const cache = new WeakMap<Sql, Bookkeeping>();

/**
 * The adapter for the warehouse `sql` is in, found from the bookkeeping that is there. Before ensureState has made any
 * the file adapter answers (its statements fail on a missing table as they always did) and the answer is not kept.
 */
export async function bookkeepingOf(sql: Sql): Promise<Bookkeeping> {
  const hit = cache.get(sql);
  if (hit) return hit;
  const kind = kindOfObjects(await stateObjects(sql));
  if (kind === null) return new FileBookkeeping(sql);
  return remember(sql, kind);
}

/** The adapter of `kind` for `sql`, kept for later calls; ensureState uses it once it has made the tables. */
export function remember(sql: Sql, kind: BookkeepingKind): Bookkeeping {
  const bk = kind === "log" ? new LogBookkeeping(sql) : new FileBookkeeping(sql);
  cache.set(sql, bk);
  return bk;
}

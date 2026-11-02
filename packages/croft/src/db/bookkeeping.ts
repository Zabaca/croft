// croft's bookkeeping tables behind one interface, with two adapters (DESIGN.md §5 "Where state lives", D-L1).
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
// A statement of the log adapter that writes reads the highest `seq` in a subquery of its own. Two writers could pick
// the same number only for different keys, because writes to one asset are already one at a time (the asset leases).
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";

export type BookkeepingKind = "file" | "log";

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
/** The tables that keep a log in the log adapter; meta is a plain table in both. */
export const LOGGED_TABLES = STATE_TABLE_NAMES.filter((t) => t !== "meta");

const keyOf = (t: StateTableName): readonly string[] => STATE_SPECS[t].key;
const logOf = (t: StateTableName): string => `_croft.${t}_log`;

/** The kind a new warehouse gets when nothing says otherwise. The log adapter exists for lake mode (option 07); until a
 *  lake can be attached (slice 2) this variable is the only way to ask for it, so the whole test suite can run on it.
 *  It decides only for a warehouse with no bookkeeping yet: a warehouse that has some keeps its kind. */
export function defaultBookkeeping(env: NodeJS.ProcessEnv = process.env): BookkeepingKind {
  return env.CROFT_BOOKKEEPING === "log" ? "log" : "file";
}

/** CREATE statements of the file adapter: the tables as every warehouse has had them since format 1. */
export function fileDdl(): string[] {
  return STATE_TABLE_NAMES.map((t) => `CREATE TABLE IF NOT EXISTS _croft.${t} (${STATE_SPECS[t].columns}, PRIMARY KEY (${keyOf(t).join(", ")}))`);
}

/** The log adapter's tables and views, one statement each, by the name of the object it creates. */
export function logDdl(): { name: string; ddl: string }[] {
  const out: { name: string; ddl: string }[] = [{ name: "meta", ddl: `CREATE TABLE IF NOT EXISTS _croft.meta (${STATE_SPECS.meta.columns})` }];
  for (const t of LOGGED_TABLES) {
    out.push({ name: `${t}_log`, ddl: `CREATE TABLE IF NOT EXISTS ${logOf(t)} (${STATE_SPECS[t].columns}, seq BIGINT, closed BOOLEAN)` });
  }
  for (const t of LOGGED_TABLES) {
    out.push({
      name: t,
      ddl: `CREATE VIEW IF NOT EXISTS _croft.${t} AS SELECT * EXCLUDE (seq, closed) FROM ${logOf(t)}
    QUALIFY row_number() OVER (PARTITION BY ${keyOf(t).join(", ")} ORDER BY seq DESC NULLS LAST) = 1 AND NOT coalesce(closed, false)`,
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
  if (LOGGED_TABLES.some((t) => names.has(t))) return "file";
  return null;
}

/** One duplicate the log adapter's check found: the same key (and, in a log, the same number) twice. */
export interface DuplicateKey { table: StateTableName; key: Record<string, unknown>; rows: number }

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
  /** Keys that appear twice where one is allowed. Always empty for a file, whose primary keys refuse them. */
  duplicateKeys(): Promise<DuplicateKey[]>;
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
  async duplicateKeys(): Promise<DuplicateKey[]> {
    return [];
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

class LogBookkeeping implements Bookkeeping {
  readonly kind = "log" as const;
  constructor(private readonly tx: Sql) {}

  /** The number after the highest one in the log, for one row; plus row_number() OVER () for a statement's several. */
  private next(table: StateTableName): string {
    return `(SELECT coalesce(max(seq), 0) FROM ${logOf(table)})`;
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
    await this.tx.exec(
      `INSERT INTO ${logOf(table)} (${cols(row)}, seq, closed) VALUES (${vals(row)}, ${this.next(table)} + 1, false)`, params);
  }

  async insert(table: StateTableName, row: Record<string, string>, params: unknown[] = []): Promise<void> {
    // The duplicate-key check that stands in for the primary key. NULL key parts compare as equal, as they never
    // do in a primary key, which is the stricter reading and one croft's keys never reach (none is nullable in use).
    const key = keyOf(table);
    const used = onlyUsed(key.map((k) => row[k] ?? "NULL"), params);
    const where = key.map((k, i) => `${k} IS NOT DISTINCT FROM ${used.texts[i]}`).join(" AND ");
    const dup = await this.tx.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM _croft.${table} WHERE ${where}`, used.params);
    if (Number(dup[0]?.n ?? 0) > 0) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `_croft.${table} already has a row for this key (${key.join(", ")}); a primary key would have refused it`,
        hint: "report this croft bug",
        details: { table, key: [...key] },
      });
    }
    await this.upsert(table, row, params);
  }

  async update(table: StateTableName, set: Record<string, string>, where: string, params: unknown[] = []): Promise<void> {
    await this.tx.exec(
      `INSERT INTO ${logOf(table)} BY NAME SELECT * REPLACE (${Object.entries(set).map(([c, e]) => `${e} AS ${c}`).join(", ")}),
         ${this.next(table)} + row_number() OVER () AS seq, false AS closed
       FROM _croft.${table} WHERE ${where}`, params);
  }

  async remove(table: StateTableName, where: string, params: unknown[] = []): Promise<void> {
    await this.tx.exec(
      `INSERT INTO ${logOf(table)} BY NAME SELECT *, ${this.next(table)} + row_number() OVER () AS seq, true AS closed
       FROM _croft.${table} WHERE ${where}`, params);
  }

  async rekey(table: StateTableName, column: string, from: string, to: string): Promise<void> {
    // The rows under the new key first, then a closing row for each old key (the old rows still read as they were).
    await this.update(table, { [column]: "$2" }, `${column} = $1`, [from, to]);
    await this.remove(table, `${column} = $1`, [from]);
  }

  async insertSelect(table: StateTableName, select: string, params: unknown[] = []): Promise<void> {
    await this.tx.exec(
      `INSERT INTO ${logOf(table)} BY NAME SELECT s.*, ${this.next(table)} + row_number() OVER () AS seq, false AS closed FROM (${select}) AS s`, params);
  }

  async duplicateKeys(): Promise<DuplicateKey[]> {
    const out: DuplicateKey[] = [];
    const meta = await this.tx.all<{ key: string; n: number | bigint }>(`SELECT key, count(*) AS n FROM _croft.meta GROUP BY key HAVING count(*) > 1`);
    for (const r of meta) out.push({ table: "meta", key: { key: r.key }, rows: Number(r.n) });
    for (const t of LOGGED_TABLES) {
      const key = keyOf(t);
      const rows = await this.tx.all<Record<string, unknown>>(
        `SELECT ${key.join(", ")}, count(*) AS n FROM ${logOf(t)} WHERE seq IS NOT NULL GROUP BY ${key.join(", ")}, seq HAVING count(*) > 1`);
      for (const r of rows) out.push({ table: t, key: Object.fromEntries(key.map((k) => [k, r[k]])), rows: Number(r.n) });
    }
    return out;
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

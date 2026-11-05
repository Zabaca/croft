// Data-coupled state inside warehouse.duckdb (DESIGN.md §5 "Where state lives"). It commits atomically
// with the data it describes and is the source of truth; runs.sqlite only mirrors it.
import pkg from "../../package.json" with { type: "json" };
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";
import { type BookkeepingKind, defaultBookkeeping, fileDdl, inLake, kindOfObjects, logDdl, remember, stateObjects } from "./bookkeeping.ts";

/** Version of the _croft schema. A database with a larger number was written by a newer croft.
 *  2: _croft.writes.attempt (the step attempt that committed, so reconcile() can tell retries apart).
 *  3: _croft.inputs.input_last_loaded_at (the input's last_loaded_at when a transform last read all of it,
 *     which staleness compares with; seen_loaded_at and seen_key stay newRows()'s composite position).
 *  A file warehouse is at most 3. **4 is taken by the log** (below), so the next file format is 5: a file warehouse at 4
 *  is refused (assertFormat), which keeps a future croft's format 4 from being read as the log's. */
export const FORMAT_VERSION = 3;
/** The format of a warehouse whose bookkeeping is a log (db/bookkeeping.ts, D132). It is a number of its own because a croft
 *  that predates the log cannot use one: it makes `_croft.assets` a table and fails on the view. Stamped on a log warehouse
 *  from its first write, so that croft refuses it with DB_NEWER_FORMAT instead. Everything else about the format is 3's. */
export const LOG_FORMAT_VERSION = 4;
export const CROFT_VERSION: string = pkg.version;

// The file adapter's DDL (db/bookkeeping.ts holds the table specs, shared with the log adapter), each entry one
// statement (the Sql wrapper prepares one statement per call).
export const STATE_DDL: readonly string[] = [`CREATE SCHEMA IF NOT EXISTS _croft`, ...fileDdl()];

/** Columns added after format 1, for databases created before them. STATE_DDL already has them, last, so a
 *  migrated table has the same column order as a new one. */
export const STATE_COLUMNS_ADDED: readonly { table: string; column: string; ddl: string }[] = [
  { table: "writes", column: "attempt", ddl: `ALTER TABLE _croft.writes ADD COLUMN attempt INTEGER` },
  { table: "inputs", column: "input_last_loaded_at", ddl: `ALTER TABLE _croft.inputs ADD COLUMN input_last_loaded_at TIMESTAMPTZ` },
];

export interface Meta { format_version?: string; duckdb_version?: string; croft_version?: string; [key: string]: string | undefined }

/** Whether the _croft schema exists (usable from a read lease). */
export async function hasState(db: Sql): Promise<boolean> {
  const rows = await db.all<{ n: number }>(
    `SELECT count(*)::INTEGER n FROM duckdb_tables() WHERE schema_name = '_croft' AND table_name = 'meta' AND database_name = current_database()`,
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function readMeta(db: Sql): Promise<Meta> {
  if (!(await hasState(db))) return {};
  const rows = await db.all<{ key: string; value: string | null }>(`SELECT key, value FROM _croft.meta`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value ?? undefined]));
}

/** The newest format a croft reads, per kind of bookkeeping: null for a kind it does not know. The numbers of the two kinds are
 *  separate, so a file warehouse at the log's 4 is a newer file format, not a log. */
export interface FormatsRead { file: number; log: number | null }

/** Refuse a database written by a newer croft rather than risk a downgrade (DB_NEWER_FORMAT). `reads` is what the croft
 *  checking reads (this one by default); a test gives it an older croft's. */
export function assertFormat(meta: Meta, reads: FormatsRead = { file: FORMAT_VERSION, log: LOG_FORMAT_VERSION }): void {
  const v = meta.format_version === undefined ? undefined : Number(meta.format_version);
  const newest = meta.bookkeeping === "log" ? reads.log : reads.file;
  if (v !== undefined && (newest === null || !(v <= newest))) {
    throw new CroftError("DB_NEWER_FORMAT", {
      message: `this warehouse has croft format ${meta.format_version}${meta.bookkeeping === "log" ? " (a log)" : ""} (written by croft ${meta.croft_version ?? "?"}); this croft ${CROFT_VERSION} reads ${newest === null ? "no such warehouse" : `format ${newest} and older`}`,
      hint: "upgrade croft in this project (bun add @zabaca/croft@latest) instead of opening the database with an older version",
      retryable: false,
      details: { formatVersion: meta.format_version, croftVersion: meta.croft_version, duckdbVersion: meta.duckdb_version },
    });
  }
}

const STAMP = /^croft format (\d+)$/;

/** The format a lake's `_croft.meta` table is stamped with (D199): a comment on the table, written in the transaction that writes `format_version`.
 *  The catalog a connection loads as it begins holds the comment, so reading it costs no round trip, where reading the rows of `_croft.meta`
 *  costs 6 and, when the table's inlined rows are of an older schema version than the lake's now, 22 more (D176). Null: not a lake, no state,
 *  or a lake no croft that stamps has written yet. */
export async function lakeStamp(db: Sql): Promise<number | null> {
  if (!(await inLake(db))) return null;
  const [r] = await db.all<{ c: string | null }>(
    `SELECT comment AS c FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = '_croft' AND table_name = 'meta'`);
  const m = STAMP.exec(r?.c ?? "");
  return m ? Number(m[1]) : null;
}

/** Check the format from a read lease (query, describe, doctor). No-op on a database without _croft. A lake stamped with a format this croft reads
 *  is answered from the stamp; any other (no stamp, or a newer format, whose refusal names the croft that wrote it) from the rows of `_croft.meta`,
 *  and then the answer is the same as before the stamp (D144). */
export async function checkFormat(db: Sql): Promise<Meta> {
  const stamp = await lakeStamp(db);
  if (stamp !== null && stamp <= LOG_FORMAT_VERSION) return { format_version: String(stamp), bookkeeping: "log" };
  const meta = await readMeta(db);
  assertFormat(meta);
  return meta;
}

/**
 * Create the _croft schema and tables when missing, add the columns an older database lacks, and record
 * format_version, duckdb_version and croft_version. Idempotent; run it inside a write lease. DDL runs before
 * the meta upsert (DML), and an ALTER runs only while its column is missing, so it respects the DDL-before-DML
 * rule even when called twice in one transaction around writes to _croft.
 *
 * Which adapter the tables follow (db/bookkeeping.ts) is decided by what is already there; only a database with no
 * bookkeeping yet takes `o.bookkeeping`, else defaultBookkeeping(). The log adapter records `bookkeeping = log` in meta.
 */
export async function ensureState(tx: Sql, o: { croftVersion?: string; bookkeeping?: BookkeepingKind } = {}): Promise<Meta> {
  const before = await readMeta(tx);
  assertFormat(before);
  const names = await stateObjects(tx);
  // A lake refuses primary keys and the rest of what the file's tables use, so its bookkeeping is the log, whatever else was asked.
  const lake = await inLake(tx);
  const kind = kindOfObjects(names) ?? (lake ? "log" : o.bookkeeping ?? defaultBookkeeping());
  if (kind === "log") {
    // Only what is missing: an existing lake pays no catalog write for CREATE ... IF NOT EXISTS.
    if (!names.size) await tx.exec(`CREATE SCHEMA IF NOT EXISTS _croft`);
    for (const { name, ddl } of logDdl()) if (!names.has(name)) await tx.exec(ddl);
  } else {
    for (const ddl of STATE_DDL) await tx.exec(ddl);
    const have = new Set((await tx.all<{ t: string; c: string }>(
      `SELECT table_name t, column_name c FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = '_croft'`,
    )).map((r) => `${r.t}.${r.c}`));
    for (const add of STATE_COLUMNS_ADDED) if (!have.has(`${add.table}.${add.column}`)) await tx.exec(add.ddl);
  }
  const bk = remember(tx, kind);
  const [{ v } = { v: "" }] = await tx.all<{ v: string }>(`SELECT version() v`);
  const want: Meta = {
    format_version: String(Math.max(kind === "log" ? LOG_FORMAT_VERSION : FORMAT_VERSION, Number(before.format_version ?? 0))),
    duckdb_version: v,
    croft_version: o.croftVersion ?? CROFT_VERSION,
    ...(kind === "log" ? { bookkeeping: "log" } : {}),
  };
  // A lake's format is also stamped on the meta table (D199): DDL, so before the upserts below, and only when it differs (a comment is a catalog change).
  if (lake && kind === "log" && (await lakeStamp(tx)) !== Number(want.format_version)) await tx.exec(`COMMENT ON TABLE _croft.meta IS 'croft format ${Number(want.format_version)}'`);
  for (const [key, value] of Object.entries(want)) {
    if (before[key] === value) continue;
    await bk.upsert("meta", { key: "$1", value: "$2" }, [key, value]);
  }
  return { ...before, ...want };
}

// Data-coupled state inside warehouse.duckdb (DESIGN.md §5 "Where state lives"). It commits atomically
// with the data it describes and is the source of truth; runs.sqlite only mirrors it.
import pkg from "../../package.json" with { type: "json" };
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";

/** Version of the _croft schema. A database with a larger number was written by a newer croft.
 *  2: _croft.writes.attempt (the step attempt that committed, so reconcile() can tell retries apart).
 *  3: _croft.inputs.input_last_loaded_at (the input's last_loaded_at when a transform last read all of it,
 *     which staleness compares with; seen_loaded_at and seen_key stay newRows()'s composite position). */
export const FORMAT_VERSION = 3;
export const CROFT_VERSION: string = pkg.version;

// Exactly the DDL of DESIGN.md §5, made idempotent. Each entry is one statement (the Sql wrapper
// prepares one statement per call).
export const STATE_DDL: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS _croft`,
  `CREATE TABLE IF NOT EXISTS _croft.meta (key VARCHAR PRIMARY KEY, value VARCHAR)`,
  `CREATE TABLE IF NOT EXISTS _croft.assets (name VARCHAR PRIMARY KEY, kind VARCHAR,
    write_mode VARCHAR, key_columns VARCHAR[], code_hash VARCHAR, behavior_hash VARCHAR,
    cursor_value VARCHAR, cursor_type VARCHAR, cursor_unit VARCHAR,
    last_loaded_at TIMESTAMPTZ, last_replaced_at TIMESTAMPTZ,
    row_count BIGINT, max_loaded_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS _croft.columns (asset VARCHAR, name VARCHAR, type VARCHAR, source_name VARCHAR, format VARCHAR,
    pinned BOOLEAN, pending BOOLEAN, kinds VARCHAR[], present_last_batch BOOLEAN, added_at TIMESTAMPTZ,
    PRIMARY KEY (asset, name))`,
  `CREATE TABLE IF NOT EXISTS _croft.inputs (asset VARCHAR, input VARCHAR, seen_loaded_at TIMESTAMPTZ, seen_key JSON,
    input_last_loaded_at TIMESTAMPTZ, PRIMARY KEY (asset, input))`,
  `CREATE TABLE IF NOT EXISTS _croft.files (asset VARCHAR, path VARCHAR, size BIGINT, mtime TIMESTAMPTZ, etag VARCHAR,
    sha256 VARCHAR, loaded_at TIMESTAMPTZ, PRIMARY KEY (asset, path))`,
  `CREATE TABLE IF NOT EXISTS _croft.writes (asset VARCHAR, loaded_at TIMESTAMPTZ, run_id VARCHAR, mode VARCHAR,
    rows_in BIGINT, added BIGINT, updated BIGINT, unchanged BIGINT, deleted BIGINT,
    cursor_before VARCHAR, cursor_after VARCHAR, since_used VARCHAR, inputs JSON,
    schema_changes JSON, code_hash VARCHAR, attempt INTEGER, PRIMARY KEY (asset, loaded_at))`,
];

/** Columns added after format 1, for databases created before them. STATE_DDL already has them, last, so a
 *  migrated table has the same column order as a new one. */
export const STATE_COLUMNS_ADDED: readonly { table: string; column: string; ddl: string }[] = [
  { table: "writes", column: "attempt", ddl: `ALTER TABLE _croft.writes ADD COLUMN attempt INTEGER` },
  { table: "inputs", column: "input_last_loaded_at", ddl: `ALTER TABLE _croft.inputs ADD COLUMN input_last_loaded_at TIMESTAMPTZ` },
];

export const STATE_TABLES = ["meta", "assets", "columns", "inputs", "files", "writes"] as const;

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

/** Refuse a database written by a newer croft rather than risk a downgrade (DB_NEWER_FORMAT). */
export function assertFormat(meta: Meta): void {
  const v = meta.format_version === undefined ? undefined : Number(meta.format_version);
  if (v !== undefined && !(v <= FORMAT_VERSION)) {
    throw new CroftError("DB_NEWER_FORMAT", {
      message: `this warehouse has croft format ${meta.format_version} (written by croft ${meta.croft_version ?? "?"}); this croft ${CROFT_VERSION} reads format ${FORMAT_VERSION}`,
      hint: "upgrade croft in this project (bun add @zabaca/croft@latest) instead of opening the database with an older version",
      retryable: false,
      details: { formatVersion: meta.format_version, croftVersion: meta.croft_version, duckdbVersion: meta.duckdb_version },
    });
  }
}

/** Check the format from a read lease (query, describe, doctor). No-op on a database without _croft. */
export async function checkFormat(db: Sql): Promise<Meta> {
  const meta = await readMeta(db);
  assertFormat(meta);
  return meta;
}

/**
 * Create the _croft schema and tables when missing, add the columns an older database lacks, and record
 * format_version, duckdb_version and croft_version. Idempotent; run it inside a write lease. DDL runs before
 * the meta upsert (DML), and an ALTER runs only while its column is missing, so it respects the DDL-before-DML
 * rule even when called twice in one transaction around writes to _croft.
 */
export async function ensureState(tx: Sql, o: { croftVersion?: string } = {}): Promise<Meta> {
  const before = await readMeta(tx);
  assertFormat(before);
  for (const ddl of STATE_DDL) await tx.exec(ddl);
  const have = new Set((await tx.all<{ t: string; c: string }>(
    `SELECT table_name t, column_name c FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = '_croft'`,
  )).map((r) => `${r.t}.${r.c}`));
  for (const add of STATE_COLUMNS_ADDED) if (!have.has(`${add.table}.${add.column}`)) await tx.exec(add.ddl);
  const [{ v } = { v: "" }] = await tx.all<{ v: string }>(`SELECT version() v`);
  const want: Meta = {
    format_version: String(Math.max(FORMAT_VERSION, Number(before.format_version ?? 0))),
    duckdb_version: v,
    croft_version: o.croftVersion ?? CROFT_VERSION,
  };
  for (const [key, value] of Object.entries(want)) {
    if (before[key] === value) continue;
    await tx.exec(`INSERT OR REPLACE INTO _croft.meta (key, value) VALUES ($1, $2)`, [key, value]);
  }
  return { ...before, ...want };
}

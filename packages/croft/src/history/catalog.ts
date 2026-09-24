// The catalog mirror: a copy of each asset's _croft state kept in runs.sqlite, so `status`, `context` and
// `validate` never wait on the DuckDB lock (DESIGN.md §5 "How commands behave while a run is writing").
// The run engine writes an entry after every committed step; readers treat DuckDB as the source of truth
// when they can open it, and the mirror otherwise. `source` records where the entry came from.
import type { CursorType, Sql } from "../core/types.ts";
import { hasState } from "../db/state.ts";
import { readTableSchema } from "../load/evolve.ts";
import { isoMicros, readStoredColumns } from "../safety/guards.ts";
import type { RunsDb } from "./runs-db.ts";

export interface CatalogColumn {
  name: string;
  type: string;
  sourceName: string | null;
  pinned: boolean;
  pending: boolean;
  format: string | null;
  /** Keys seen inside a JSON column (for `describe` and the bind check), capped at 50. */
  jsonKeys?: string[];
}

/**
 * What a transform has seen of one input: its _croft.inputs row (DESIGN.md §5 "Versions, staleness and
 * atomicity", §3e "Positions never skip rows"). Instants are ISO-8601 UTC with microseconds.
 *
 * - `seenLoadedAt` and `seenKey` are newRows()'s composite position: every input row stamped before
 *   seenLoadedAt was processed, and so were the rows stamped exactly seenLoadedAt whose key is at most
 *   seenKey (all of them when seenKey is null). SQL steps and full-refresh transforms, which read inputs in
 *   full, record the input's last_loaded_at and no key.
 * - `inputLastLoadedAt` is what staleness compares with: the input's last_loaded_at when the transform last
 *   read all of it (the snapshot a TS step finished, the input an SQL step read in its transaction). It is
 *   null while that has not happened, e.g. after an incremental transform committed part of a snapshot. So
 *   an input with rows makes the transform stale (input_changed) when it has no entry here, or its
 *   inputLastLoadedAt is null or older than the input's lastLoadedAt. It is not `describe`'s field of the same
 *   name, which shows the input's current last_loaded_at.
 */
export interface InputSeen {
  seenLoadedAt: string | null;
  /** JSON: the key of the last input row processed at seenLoadedAt, in the shape the TS step wrote it. */
  seenKey: unknown;
  inputLastLoadedAt: string | null;
}

export interface CatalogAsset {
  asset: string;
  kind: "ingest" | "sql" | "ts";
  /** Behavior in plain words, e.g. "updates rows by id; fetches updated_at newer than …". */
  behavior: string;
  write: "replace" | "append" | "merge";
  key: string[];
  rows: number;
  columns: CatalogColumn[];
  cursor: { field: string; value: string | null; type: CursorType | null; unit: "s" | "ms" | null } | null;
  /** ISO-8601 UTC with microseconds, from _croft.assets. */
  lastLoadedAt: string | null;
  lastReplacedAt: string | null;
  lastRunId: string | null;
  codeHash: string | null;
  /** Incremental file ingests: files whose rows are kept although the file is gone. */
  filesGone?: string[];
  /** Transforms: what the asset has seen of each input, by input name (_croft.inputs); absent when it has
   *  recorded nothing yet. */
  inputsSeen?: Record<string, InputSeen>;
  /** Transforms: the assets it reads (PlannedStep.inputs), from the definition. */
  reads?: string[];
}

export type CatalogSource = "run" | "preview" | "pins";

export function putCatalog(db: RunsDb, entry: CatalogAsset, source: CatalogSource = "run"): void {
  db.catalogPut(entry.asset, entry, source);
}

export function getCatalog(db: RunsDb, asset: string): CatalogAsset | null {
  return db.catalogGet<CatalogAsset>(asset)?.value ?? null;
}

export function allCatalog(db: RunsDb): CatalogAsset[] {
  return db.catalogAll<CatalogAsset>().map((e) => e.value);
}

/** What an entry needs besides the warehouse: the asset definition's side (or a previous entry's). */
export interface CatalogBase {
  asset: string;
  kind?: CatalogAsset["kind"];
  /** Behavior in plain words. */
  behavior: string;
  /** Default: _croft.assets.write_mode and key_columns. */
  write?: CatalogAsset["write"];
  key?: string[];
  /** The cursor field (the definition names it; _croft.assets does not), or null for no cursor. */
  cursorField: string | null;
  unit?: "s" | "ms" | null;
  codeHash?: string | null;
  lastRunId: string | null;
  /** Keys seen per JSON column. */
  jsonKeys?: Record<string, string[]>;
  filesGone?: string[];
  /** Transforms: the assets it reads. */
  reads?: string[];
}

/**
 * An asset's catalog entry as the warehouse has it: _croft.assets (rows, cursor, load times), the real columns
 * with _croft.columns' record of them, _croft.inputs (inputsSeen), and `base` for what only the definition
 * knows. null when croft has no record of the asset. Read-only; inside a write transaction it sees what is
 * about to commit.
 */
export async function readCatalogEntry(sql: Sql, b: CatalogBase): Promise<CatalogAsset | null> {
  if (!(await hasState(sql))) return null;
  const [a] = await sql.all<Record<string, unknown>>(
    `SELECT kind, write_mode, key_columns, cursor_value, cursor_type, cursor_unit, epoch_us(last_loaded_at) AS ll,
       epoch_us(last_replaced_at) AS lr, row_count, code_hash FROM _croft.assets WHERE name = $1`, [b.asset]);
  if (!a) return null;
  const stored = await readStoredColumns(sql, b.asset);
  const real = (await readTableSchema(sql, b.asset)) ?? [];
  const columns: CatalogColumn[] = real.map((c) => {
    const s = stored.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
    const col: CatalogColumn = {
      name: c.name, type: c.type, sourceName: s?.source_name ?? null, pinned: s?.pinned === true, pending: s?.pending === true,
      format: s?.format ?? null,
    };
    const keys = b.jsonKeys?.[c.name];
    if (keys) col.jsonKeys = keys;
    return col;
  });
  const us = (v: unknown) => (v === null || v === undefined ? null : isoMicros(BigInt(v as number | bigint)));
  const kinds = ["ingest", "sql", "ts"] as const;
  const writes = ["replace", "append", "merge"] as const;
  const kind = b.kind ?? kinds.find((k) => k === a.kind) ?? "ingest";
  const write = b.write ?? writes.find((w) => w === a.write_mode) ?? "replace";
  const key = b.key ?? (Array.isArray(a.key_columns) ? a.key_columns.map(String) : []);
  const entry: CatalogAsset = {
    asset: b.asset, kind, behavior: b.behavior, write, key,
    rows: Number(a.row_count ?? 0), columns,
    cursor: b.cursorField !== null
      ? {
        field: b.cursorField, value: (a.cursor_value as string | null) ?? null, type: (a.cursor_type as CursorType | null) ?? null,
        unit: (a.cursor_unit as "s" | "ms" | null) ?? b.unit ?? null,
      }
      : null,
    lastLoadedAt: us(a.ll), lastReplacedAt: us(a.lr), lastRunId: b.lastRunId, codeHash: (a.code_hash as string | null) ?? b.codeHash ?? null,
  };
  if (b.filesGone?.length) entry.filesGone = b.filesGone;
  const seen = await readInputsSeen(sql, b.asset);
  if (Object.keys(seen).length) entry.inputsSeen = seen;
  if (b.reads) entry.reads = [...b.reads];
  return entry;
}

/** An asset's _croft.inputs rows by input. A read lease may see a format-2 database, which has no
 *  input_last_loaded_at yet (the next write adds it): those rows read as not yet read in full. */
export async function readInputsSeen(sql: Sql, asset: string): Promise<Record<string, InputSeen>> {
  const [col] = await sql.all<{ n: number | bigint }>(
    `SELECT count(*) AS n FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = '_croft'
       AND table_name = 'inputs' AND column_name = 'input_last_loaded_at'`);
  const last = Number(col?.n ?? 0) > 0 ? "epoch_us(input_last_loaded_at)" : "NULL::BIGINT";
  const rows = await sql.all<{ input: string; s: number | bigint | null; k: unknown; l: number | bigint | null }>(
    `SELECT input, epoch_us(seen_loaded_at) AS s, seen_key AS k, ${last} AS l FROM _croft.inputs WHERE asset = $1 ORDER BY input`, [asset]);
  const us = (v: number | bigint | null) => (v === null || v === undefined ? null : isoMicros(BigInt(v)));
  const out: Record<string, InputSeen> = {};
  for (const r of rows) out[r.input] = { seenLoadedAt: us(r.s), seenKey: r.k ?? null, inputLastLoadedAt: us(r.l) };
  return out;
}

/** The base for refreshing an entry from the warehouse when only a previous entry knows the definition. */
export function baseFrom(prev: CatalogAsset | null, asset: string, lastRunId: string | null): CatalogBase {
  const jsonKeys: Record<string, string[]> = {};
  for (const c of prev?.columns ?? []) if (c.jsonKeys) jsonKeys[c.name] = c.jsonKeys;
  return {
    asset, behavior: prev?.behavior ?? "", cursorField: prev?.cursor?.field ?? null, unit: prev?.cursor?.unit ?? null,
    ...(prev ? { kind: prev.kind, write: prev.write, key: prev.key, codeHash: prev.codeHash } : {}),
    lastRunId, jsonKeys, ...(prev?.filesGone ? { filesGone: prev.filesGone } : {}), ...(prev?.reads ? { reads: prev.reads } : {}),
  };
}

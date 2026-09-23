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
}

/**
 * An asset's catalog entry as the warehouse has it: _croft.assets (rows, cursor, load times), the real columns
 * with _croft.columns' record of them, and `base` for what only the definition knows. null when croft has no
 * record of the asset. Read-only; inside a write transaction it sees what is about to commit.
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
  return entry;
}

/** The base for refreshing an entry from the warehouse when only a previous entry knows the definition. */
export function baseFrom(prev: CatalogAsset | null, asset: string, lastRunId: string | null): CatalogBase {
  const jsonKeys: Record<string, string[]> = {};
  for (const c of prev?.columns ?? []) if (c.jsonKeys) jsonKeys[c.name] = c.jsonKeys;
  return {
    asset, behavior: prev?.behavior ?? "", cursorField: prev?.cursor?.field ?? null, unit: prev?.cursor?.unit ?? null,
    ...(prev ? { kind: prev.kind, write: prev.write, key: prev.key, codeHash: prev.codeHash } : {}),
    lastRunId, jsonKeys, ...(prev?.filesGone ? { filesGone: prev.filesGone } : {}),
  };
}

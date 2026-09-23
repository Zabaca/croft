// The catalog mirror: a copy of each asset's _croft state kept in runs.sqlite, so `status`, `context` and
// `validate` never wait on the DuckDB lock (DESIGN.md §5 "How commands behave while a run is writing").
// The run engine writes an entry after every committed step; readers treat DuckDB as the source of truth
// when they can open it, and the mirror otherwise. `source` records where the entry came from.
import type { CursorType } from "../core/types.ts";
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

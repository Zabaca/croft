// Pre-upgrade backups (DESIGN.md §6 "Trash, restore and delete"): before the first open with a newer DuckDB,
// warehouse.duckdb (and its .wal) is copied whole to .croft/backups/. "Newer" is decided from the engine version
// recorded in runs.sqlite, because a file written by a newer format cannot be opened to read _croft.meta.
// Phase 4 contract stub (OOB wave).
import { phaseStub } from "../core/phase.ts";

export interface BackupResult {
  /** The backup file, or null when none was needed. */
  path: string | null;
  from: string | null;
  to: string;
}

/** Back the warehouse up when the running engine is newer than the one recorded; record the running one. */
export async function backupBeforeUpgrade(stateDir: string, database: string, engineVersion: string): Promise<BackupResult> {
  return phaseStub(`backupBeforeUpgrade(${stateDir}, ${database}, ${engineVersion})`);
}

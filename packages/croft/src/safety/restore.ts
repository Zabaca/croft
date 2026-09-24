// Restore (DESIGN.md §6 "Trash, restore and delete"): bring a trashed version of an asset back. The current
// table goes to the trash first (its own commit), then one transaction writes the table and its _croft rows from
// the trash file (ATTACHed read-only) and bumps last_replaced_at, so downstream rebuilds. Needs confirmation.
// Phase 4 contract stub: its builder (TR) replaces this.
import { phaseStub } from "../core/phase.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import type { TrashEntry } from "./trash.ts";

/** The trash, newest first, for one asset or all. */
export function listVersions(stateDir: string, asset?: string): TrashEntry[] {
  return phaseStub(`listVersions(${stateDir}, ${asset ?? "*"})`);
}

export interface RestoreResult {
  asset: string;
  /** The version brought back. */
  restored: TrashEntry;
  /** Where the table it replaced went (null when there was none). */
  trashed: TrashEntry | null;
  rows: number;
}

/** Restore `version` of its asset. The caller has confirmed. */
export async function restoreVersion(warehouse: DuckWarehouse, version: TrashEntry, o: { runId?: string; now?: Date } = {}): Promise<RestoreResult> {
  return phaseStub(`restoreVersion(${version.asset}, ${o.runId ?? ""}, ${warehouse ? "w" : ""})`);
}

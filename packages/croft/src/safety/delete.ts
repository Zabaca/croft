// Delete (DESIGN.md §6 "Trash, restore and delete"): move a whole table, or the rows matching a predicate, to
// the trash, then remove them and bump last_replaced_at. The predicate is one SELECT expression over the table's
// columns. Needs confirmation. Phase 4 contract stub: its builder (TR) replaces this.
import { phaseStub } from "../core/phase.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import type { TrashEntry } from "./trash.ts";

export interface DeleteImpact {
  asset: string;
  /** The rows that would go to the trash. */
  rows: number;
  /** null for the whole table. */
  where: string | null;
  downstream: string[];
}

export interface DeleteResult extends DeleteImpact {
  trashed: TrashEntry;
}

/** Count what a delete would remove (the confirmation's impact). Read-only. */
export async function deleteImpact(warehouse: DuckWarehouse, asset: string, where: string | null): Promise<DeleteImpact> {
  return phaseStub(`deleteImpact(${asset}, ${where ?? "*"}, ${warehouse ? "w" : ""})`);
}

/** Move the whole table and its _croft state to the trash, then drop it. The caller has confirmed. */
export async function deleteTable(warehouse: DuckWarehouse, asset: string, o: { runId?: string; now?: Date } = {}): Promise<DeleteResult> {
  return phaseStub(`deleteTable(${asset}, ${o.runId ?? ""}, ${warehouse ? "w" : ""})`);
}

/** Move the rows matching `where` to the trash, then delete them. The caller has confirmed. */
export async function deleteWhere(warehouse: DuckWarehouse, asset: string, where: string, o: { runId?: string; now?: Date } = {}): Promise<DeleteResult> {
  return phaseStub(`deleteWhere(${asset}, ${where}, ${o.runId ?? ""}, ${warehouse ? "w" : ""})`);
}

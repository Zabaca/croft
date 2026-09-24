// Rename (DESIGN.md §4.1, §6 "Nothing implicit destroys ingested data"): an asset's file, table and state move
// together, and croft lists the references in other assets to update (it never edits user code). ASSET_RENAMED
// is the other half: a file renamed outside croft is a new, never-built asset whose code hash matches an orphan
// table's, and the fix is `croft rename <orphan> <new>`, which adopts the table instead of refetching history.
// Phase 4 contract stub: its builder (RN) replaces this.
import { phaseStub } from "../core/phase.ts";

/** A place in another asset that names the old asset. */
export interface RenameReference {
  file: string;
  line: number;
  /** The line's text. */
  text: string;
  kind: "sql" | "ts_input" | "check";
}

export interface RenamePlan {
  from: string;
  to: string;
  /** The asset file before and after (same extension). */
  fileFrom: string;
  fileTo: string;
  /** Whether a table and _croft state exist to move. */
  hasTable: boolean;
  references: RenameReference[];
}

/** Check a rename and list what it touches. Throws USAGE_ERROR/NAME_INVALID/NAME_CONFLICT when it cannot happen. */
export async function planRename(root: string, from: string, to: string): Promise<RenamePlan> {
  return phaseStub(`planRename(${root}, ${from}, ${to})`);
}

/** A never-built asset whose code matches an orphan table's recorded code hash (ASSET_RENAMED). */
export interface RenamedAsset {
  /** The orphan table (the old name). */
  from: string;
  /** The new asset file's name. */
  to: string;
}

/** The assets renamed outside croft, from the catalog mirror and the asset files. Cheap; imports no asset code
 *  beyond what resolving the never-built candidates needs. */
export async function findRenamed(root: string): Promise<RenamedAsset[]> {
  return phaseStub(`findRenamed(${root})`);
}

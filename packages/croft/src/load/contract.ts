// The hand-off between the two halves of an ingest write step (DESIGN.md §5 "One ingest step").
//
//   stage.ts  (extraction, no database lock)   rows → NDJSON parts + StageManifest
//   cast.ts   (inside the write transaction)   parts → classified, typed TEMP table → TypedBatch
//   write.ts  (inside the same transaction)    TypedBatch → evolve, dedupe, write, guards, state
//
// Both halves import only this file from each other, so they can be built and tested separately.
import type { ColumnPlan, CursorType, Problem } from "../core/types.ts";

/** Reserved column names croft adds to user tables. Source columns with these names are renamed. */
export const RESERVED = { loadedAt: "_loaded_at", file: "_file", seq: "_croft_seq" } as const;

/** What cast.ts leaves behind for write.ts: a typed TEMP table plus the decisions that shaped it. */
export interface TypedBatch {
  /** TEMP table in the current write transaction. Holds one column per ColumnPlan.column
   *  (already cast to plan.target, or to the existing type), plus RESERVED.seq (BIGINT, yield
   *  order) and, for file ingests, RESERVED.file. */
  temp: string;
  /** One entry per column seen in the batch or known from earlier loads. */
  columns: ColumnPlan[];
  /** Row count of `temp`. */
  rows: number;
  /** Present for cursor ingests. */
  cursor?: BatchCursor;
  /** Non-blocking findings from staging and typing (MIXED_TYPES, NULL_ONLY_COLUMN, TYPE_WIDENED, ...). */
  warnings: Problem[];
}

export interface BatchCursor {
  field: string;
  type: CursorType;
  unit?: "s" | "ms";
  /** Column in `temp` holding the cursor's original text exactly as the source sent it, so the
   *  saved cursor can hand the API back what it sent (DESIGN.md §3a "Typed maximum"). */
  rawTextColumn: string;
}

/** Everything write.ts needs to know about the target asset. */
export interface WriteTarget {
  asset: string;
  write: "replace" | "append" | "merge";
  key: string[];
  /** Run id stamped into _croft.writes. */
  runId: string;
  /** For file ingests: only rows of these files are replaced (changed-file reload). */
  replaceFiles?: string[];
  allowShrink?: boolean;
}

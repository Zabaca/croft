// Internal types shared by every module. Source of truth: DESIGN.md §10.
import type { Row } from "../types.ts";

export type AssetKind = "ingest" | "sql" | "ts";
export type WriteMode = "replace" | "append" | "merge";
export type CursorType = "timestamp" | "date" | "integer" | "string";
export type Incremental =
  | { kind: "none" }
  | { kind: "cursor"; field: string; unit?: "s" | "ms"; lookbackMs: number }
  | { kind: "files" }
  | { kind: "new-rows"; inputs: string[] };                  // TS newRows()
export interface Check { source: string; kind: "unique" | "not_null" | "min_rows" | "rule";
  blocking: boolean; scope: "batch" | "table"; sql: string; reads: string[] }
// ResolvedAsset (§10) is project/resolve.ts's: it carries the loaded TS and SQL modules, whose types core/ does
// not import (src/read.ts's declarations are type-checked against this file without them).
export type Reason = "requested" | "schedule_due" | "never_built" | "code_changed" | "input_changed"
  | "input_replaced" | "rebuild" | "backfill";
export type Hold = "code_not_run_by_hand" | "large_reprocess" | "paused" | "leased";
export interface PlanStep { asset: string; action: "fetch" | "rebuild" | "update" | "skip";
  reasons: Reason[]; hold?: Hold; window?: { sinceValue: string | number; sinceType: CursorType };
  confirmation?: Impact }
export type SchemaChange =
  | { kind: "add_column"; column: string; type: string }
  | { kind: "widen"; column: string; from: string; to: string }
  | { kind: "retype_pending"; column: string; to: string }
  | { kind: "recreate"; reason: "shape_changed" };
export type ValueKind = "null" | "boolean" | "integer" | "bigint" | "float" | "iso_instant" | "iso_naive"
  | "iso_date" | "string" | "object" | "array";
export interface ColumnPlan { column: string; sourceName: string; existing: string | null; incoming: ValueKind[];
  decision: "keep" | "add" | "widen" | "cast" | "retype_pending" | "conflict"; target?: string;
  badRows?: number; samples?: unknown[] }
export interface StageManifest { runId: string; asset: string; parts: { path: string; rows: number }[];
  topLevelKeys: string[]; rows: number; sinceUsed?: string | number; complete: true }
export interface StepResult {
  asset: string; status: "ok" | "failed" | "skipped" | "unchanged"; reason: string; skippedBecause?: string;
  behavior: string; attempt: number; maxAttempts: number; nextRetryAt?: string;
  rows: { in: number; added: number; updated: number; unchanged: number; deleted: number; total: number };
  schemaChanges: SchemaChange[]; cursor?: { before?: string; after?: string; sinceUsed?: string };
  inputs?: { input: string; seenBefore: string | null; seenAfter: string; rows: number }[];
  requests?: number; checks: { check: string; ok: boolean; failing?: number; sample?: Row[] }[];
  trashed?: { path: string; rows: number }; logsCommand: string; durationMs: number; error?: Problem;
  /** Present when this step created the table ("new table, 31 columns (7 JSON)", §4.2): its columns
   *  without croft's _loaded_at, and how many of them are JSON. */
  created?: { columns: number; jsonColumns: number };
  /** CSV/TSV ingests on their first load: how the header was decided (§3b "the first run prints the header it
   *  used"), so a header-less export that lost its first row is noticed at once. */
  csvHeader?: { header: boolean; from: "declared" | "sniffed" | "known"; columns: string[] };
}
export type Fix =
  | { kind: "edit"; description: string; file: string; line?: number; replace?: { from: string; to: string }; insert?: string }
  | { kind: "command"; description: string; command: string; requiresHuman?: boolean }
  | { kind: "manual"; description: string; requiresHuman?: boolean };
export interface Problem {
  severity: "error" | "warning" | "info"; code: string; message: string; hint: string; docs: string;
  asset?: string; file?: string; line?: number; column?: number; runId?: string;
  fix?: Fix; effect?: string; retryable?: boolean; details?: Record<string, unknown>;
}
export interface Impact { asset: string; action: string; rows: number; bytes?: number; trashPath?: string;
  downstream: string[]; estimatedRequests?: number }
export interface Confirmation { token: string; expiresAt: string; command: string; impact: Impact }
export interface Envelope<T> { schemaVersion: 1; ok: boolean; command: string; croftVersion: string;
  database: string; timezone: string; durationMs: number; data: T; problems: Problem[];
  next: { command: string; reason: string }[]; confirmation?: Confirmation }
export interface LockHolder { pid: number | null; program: string | null; runId?: string; asset?: string;
  action?: string; since?: string }
export interface Sql { all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void> }   // always prepare(): one statement per call
export interface Warehouse {
  read<T>(fn: (db: Sql) => Promise<T>, o?: { waitMs?: number; purpose: string }): Promise<T>;
  write<T>(label: string, fn: (tx: Sql) => Promise<T>, o?: { waitMs?: number; runId: string; asset?: string }): Promise<T>;
  holder(): Promise<LockHolder | null>;
}


// ---------------------------------------------------------------------------------------------------------
// Phase-2 command data (§4.3): validate, preview, run --dry-run

/** One asset `croft validate` checked. */
export interface ValidateAsset {
  name: string;
  kind: AssetKind | null;
  /** The assets it reads (ResolvedAsset.inputs, plus the plan scans the bind check found). */
  inputs: string[];
  /** SQL assets: the columns prepare() gives (the bind check), which the next asset can use. null for TS assets
   *  and when the bind was skipped (an input not built, an error before the bind). */
  outputColumns: { name: string; type: string }[] | null;
  /** The behavior label: "replace; key id", "merge by id". */
  behavior: string;
  /** Its code differs from the code its table was last built with (the catalog's codeHash). false when it was
   *  never built, or its code does not load: there is nothing to compare. */
  codeChanged: boolean;
  /** Scheduled ingests (§8): the schedule as written, its cron form, and its next three fire times in the project
   *  time zone. Absent for transforms and for ingests without a schedule. */
  schedule?: { text: string; cron: string; next: string[] };
}

/** `croft validate [asset…] [--types]`: `{order, assets}` (§4.3). Every finding is a problem of the envelope. */
export interface ValidateData {
  /** Every asset of the project in run order (project/graph.ts order). */
  order: string[];
  /** The assets checked (every asset, or those named), in `order`. */
  assets: ValidateAsset[];
  /** --types only: the project's own `tsc --noEmit`. skipped: no tsc in the project's node_modules (an info
   *  problem says so; croft never installs it). */
  types?: { status: "ok" | "failed" | "skipped"; errors: number };
}

/** A column that differs between the preview table and the live table. */
export interface PreviewColumnChange {
  column: string;
  change: "added" | "removed" | "retyped";
  /** The preview's type (added, retyped), or the live type (removed). */
  type: string;
  /** retyped: the live type. */
  from?: string;
  /** "no values yet; typed from its name", and the like. */
  note?: string;
}

/** One asset of `croft preview`. */
export interface PreviewAsset {
  asset: string;
  kind: AssetKind | null;
  /** skipped: not built (downstream of an ingest preview, or an input failed); `reason` says why. */
  status: "ok" | "failed" | "skipped";
  /** How it was built, or why not, in words ("downstream of an ingest preview: not built from a partial sample"). */
  reason: string;
  /** Rows the preview built (an ingest: fetched); null when it did not build. */
  rows: number | null;
  /** Rows of the live table; null when it was never built. */
  liveRows: number | null;
  /** Only part of the table was built: an input or a fetch stopped at --rows, or an incremental TS transform
   *  processed its pending rows only. The diff then covers only the keys the preview produced. */
  partial: boolean;
  /** An ingest's fetch, or a TS transform's input, stopped at --rows. */
  capped: boolean;
  /** Ingests: HTTP requests made. */
  requests?: number;
  /** Ingests: the saved position the preview fetched from (ISO with the project offset, or the cursor's own
   *  value); it does not move. */
  since?: string;
  /** Against the live table, by key (`by`), or by whole rows when the asset has no key. A partial preview counts
   *  only the keys it produced and never reports the others as removed. null when it did not build. */
  diff: { by: string[]; added: number; removed: number; changed: number; unchanged: number } | null;
  columns: PreviewColumnChange[];
  /** Every check and warning evaluated on the preview table (StepResult.checks). */
  checks: StepResult["checks"];
  /** A few rows of the preview table, redacted and cut like query output. */
  sample: Row[];
  /** Ingests: the assets that would update downstream (not built in an ingest preview). */
  downstream: string[];
  durationMs: number;
  error?: Problem;
}

/** `croft preview <asset…> [--rows N] [--rebuild]` (§6 "Ways to try a change" 2): built in .croft/preview.duckdb
 *  from snapshots of the live inputs; nothing real changes. */
export interface PreviewData {
  /** The named assets, then the SQL built downstream of them, in run order. */
  assets: PreviewAsset[];
  /** Any asset is partial. */
  partial: boolean;
  /** When the live inputs were copied to .croft/preview/ (ISO with the project offset); null when no input was
   *  snapshotted. `croft query --preview` reads the same snapshot. */
  inputsSnapshotAt: string | null;
  /** --rebuild: each asset was built from scratch and compared with the live table (drift, out-of-band edits). */
  rebuild: boolean;
  /** --rows N (default 1,000): the input rows a TS transform receives, the rows an ingest fetches. */
  rowCap: number;
}

/** The window of a cursor ingest in a dry run: what ctx.since would be (§8, "echoes the conversion"). */
export interface DryRunWindow {
  /** The value ctx.since gets, in the cursor's own JSON type. */
  sinceValue: string | number;
  sinceType: CursorType;
  /** sinceValue as an instant with the project offset, when it is a time (an epoch cursor included). */
  sinceAt?: string;
  /** saved: the saved position minus the lookback; from: --from. */
  source: "saved" | "from";
  /** The saved position, before the lookback. */
  saved?: string | number;
  /** The lookback subtracted, in words ("30 days"). */
  lookback?: string;
}

/**
 * What a confirmation is for (§6 "Destructive operations need confirmation"): allow_shrink (a replace ingest's
 * --allow-shrink), large_reprocess (the cost guard), rebuild (run --rebuild of an ingest or an incremental TS
 * transform), delete (a table or rows), restore (overwrites the current table), convert_key (an append ingest
 * gaining a key, deduplicated in place), pin_change (a lossy pin retypes stored values).
 */
export type ConfirmAction = "allow_shrink" | "large_reprocess" | "rebuild" | "delete" | "restore" | "convert_key" | "pin_change";

/** A confirmation a real run would stop for. A dry run never issues a token. */
export interface DryRunConfirmation {
  action: ConfirmAction;
  /** What `croft confirm` would carry out: "croft run taxi_zones --allow-shrink". */
  command: string;
  /** allow_shrink: the rows that would go to the trash. large_reprocess: the pending input rows, and the
   *  requests they would cost, estimated from the catalog mirror. */
  impact: Impact;
}

/** One asset of `croft run --dry-run`: PlanStep (§10) with what the run line shows (§4.2). */
export interface DryRunStep {
  asset: string;
  file: string;
  kind: "rows" | "file" | "transform" | "sql";
  action: "fetch" | "rebuild" | "update" | "skip";
  reasons: Reason[];
  /** The line's words: "merge by id, since 2026-09-22T17:58:03Z", "SQL changed (assets/open_issues.sql)",
   *  "input github_issues will have new rows (TS code unchanged)". */
  reason: string;
  behavior: string;
  hold?: Hold;
  /** skip: the failed or held asset it depends on. */
  skippedBecause?: string;
  /** Cursor ingests that have loaded before, or run with --from. Absent: a full fetch. */
  window?: DryRunWindow;
  confirmation?: DryRunConfirmation;
  /** Static errors that would fail this step before it runs (a load error, CHECK_INVALID, a bind error). */
  problems: Problem[];
}

/** `croft run --dry-run`: what would run and why, from runs.sqlite alone; never waits on the database. */
export interface DryRunData {
  dryRun: true;
  /** The steps' assets in the order they would run. */
  order: string[];
  steps: DryRunStep[];
}

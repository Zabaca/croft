// Internal types shared by every module. Source of truth: DESIGN.md §10.
import type { AssetDefinition, Row } from "../types.ts";

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
export interface ResolvedAsset {
  name: string; file: string; kind: AssetKind;
  inputs: string[];                                          // from the AST or `inputs`
  orderAfter: string[];                                      // inputs + tables read by its checks
  write: WriteMode; key: string[]; incremental: Incremental;
  schedule?: { text: string; cron: string };                 // ingests only
  checks: Check[]; pins: Record<string, { type: string; format?: string }>;
  codeHash: string; behaviorHash: string;                    // codeHash includes the project time zone
  sql?: { body: string; headerLines: number };
  usesHttp?: boolean;                                        // TS: for TRANSFORM_MAKES_REQUESTS / cost guard
  definition?: AssetDefinition;
}
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


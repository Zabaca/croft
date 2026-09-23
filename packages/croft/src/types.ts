// Public types for asset authors. Source of truth: DESIGN.md §10.
export type Row = Record<string, unknown>;
export type ColumnType = "BOOLEAN" | "BIGINT" | "HUGEINT" | "DOUBLE" | "VARCHAR" | "DATE" | "TIMESTAMP"
  | "TIMESTAMPTZ" | "JSON" | `DECIMAL(${number},${number})` | (string & {});
export type ColumnPin = ColumnType | { type: ColumnType; format?: string };   // format: strptime pattern
export type RowSource = AsyncIterable<Row | Row[]> | Iterable<Row | Row[]> | Promise<Row[]>;
export type FileFormat = "csv" | "tsv" | "json" | "ndjson" | "parquet";

export interface Common {
  description?: string;
  key?: string | string[];
  write?: "replace" | "append" | "merge";    // override the inferred behavior
  checks?: string[];                         // blocking: "unique(id)", "not_null(a, b)", "min_rows(10)", "amount >= 0"
  warnings?: string[];                       // non-blocking, same language
  columns?: Record<string, ColumnPin>;
  secrets?: string[];
  retries?: number;                          // default 2 for TS code
  timeout?: string;                          // no-progress timeout, default "10m"
}
export interface CursorSpec {
  field: string;
  unit?: "s" | "ms";                         // integer cursors holding epoch time
  lookback?: string;                         // "10 minutes", "30 days"
}
export interface IngestBase extends Common {
  schedule?: string;                         // "every hour" | "daily at 06:00" | 5-field cron (ingests only)
  allowShrink?: boolean;
}
export interface RowsIngest extends IngestBase {
  rows(ctx: IngestContext): RowSource;
  incremental?: string | CursorSpec;
  file?: never; map?: never;
}
export interface FileIngest extends IngestBase {
  file: string | string[];                   // path, glob or URL
  format?: FileFormat;
  csv?: { delimiter?: string; header?: boolean; skip?: number; encoding?: "utf-8" | "latin-1" | "utf-16" };
  incremental?: boolean;                     // only new or changed files
  map?(row: Row): Row | null;                // clean values; null drops the row
  rows?: never;
}
export interface TransformConfig extends Common {
  inputs: string[];                          // assets this code reads
  incremental?: boolean;                     // newRows() + merge instead of replace; chunked commits (§3e)
  confirmAbove?: number;                     // cost guard threshold, default 1000 input rows (§5)
  rows(ctx: TransformContext): RowSource;
}

export interface BaseContext {
  readonly asset: string;
  readonly runId: string;
  readonly preview: boolean;                 // true under `croft preview` (rows capped, nothing saved)
  readonly signal: AbortSignal;              // timeout, Ctrl-C/SIGTERM, preview row cap
  readonly http: Http;
  secret(name: string): string;              // declared names only; throws SECRET_MISSING
  log(...args: unknown[]): void;
}
export interface IngestContext extends BaseContext {
  readonly since?: string | number;          // saved cursor (minus lookback) in its own JSON type, or --from
  query<T extends Row = Row>(sql: string, ...params: unknown[]): Promise<T[]>;   // one SELECT over its own table
}
export interface TransformContext extends BaseContext {
  rows<T extends Row = Row>(input: string): AsyncIterable<T>;      // rows are Proxy-guarded (§3e)
  newRows<T extends Row = Row>(input: string): AsyncIterable<T>;
  query<T extends Row = Row>(sql: string, ...params: unknown[]): Promise<T[]>;   // one SELECT over inputs
}
export interface HttpInit {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;   // null/undefined omitted
  retries?: number; timeoutMs?: number;
}
export interface HttpResponse {
  status: number; url: string; headers: Headers; text: string;
  json<T = unknown>(): T;                    // lossless: unsafe integers → bigint
  next?: string;                             // rel="next" from the Link header
}
export interface Http {
  get(url: string, init?: HttpInit): Promise<HttpResponse>;
  post(url: string, body: unknown, init?: HttpInit): Promise<HttpResponse>;
}
export interface AssetDefinition { readonly __croft: "ingest" | "transform"; readonly config: RowsIngest | FileIngest | TransformConfig }

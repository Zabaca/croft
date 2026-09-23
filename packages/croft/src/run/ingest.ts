// One ingest step, end to end (DESIGN.md §5 "One ingest step", §3a ctx, §6 shrink guard, §8 backfills).
//
//   state     short read lease: the saved cursor, the stored columns (and files); nothing else
//   since     the saved cursor minus the lookback (cursor.ts), or --from converted to the cursor's type
//   extract   NO database lock: rows(ctx) → NDJSON parts (stage.ts); ctx.http, ctx.secret, ctx.log, and
//             ctx.query over a Parquet snapshot of the asset's own table (snapshot.ts)
//   write     one write lease (write intent, RW open, in-process write mutex), one transaction:
//             buildTypedBatch (cast.ts) → writeBatch (write.ts, with the step attempt) → catalog read-back
//   after     the catalog mirror in runs.sqlite, staging deleted
//
// File ingests use load/files.ts for the extract and the typed batch, and the same writeBatch.
// A SHRINK_GUARD with --allow-shrink asks the caller's decider: granted → the table goes to the trash (its own
// commit), then the write runs again with the guard off; pending → a confirmation token, nothing written.
// CROFT_FAULT=after_stage|before_commit|after_commit_before_sqlite|between_trash_and_drop kills the process at
// that point (crash tests, DESIGN.md §10 "Crash tests").
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CODES, CroftError, isCode, problem } from "../core/errors.ts";
import type { Confirmation, CursorType, Impact, Problem, SchemaChange, Sql, StepResult } from "../core/types.ts";
import { now as clockNow } from "../core/time.ts";
import type { FileIngest, IngestContext, Row, RowSource, RowsIngest } from "../types.ts";
import { canonicalPath } from "../db/connect.ts";
import { hasState } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { type CatalogAsset, type CatalogBase, getCatalog, putCatalog, readCatalogEntry } from "../history/catalog.ts";
import type { LogWriter } from "../history/logs.ts";
import type { RunsDb } from "../history/runs-db.ts";
import { createHttp, displayUrl, excerpt, type HttpClient, type HttpOptions } from "../http/http.ts";
import { buildTypedBatch } from "../load/cast.ts";
import { RESERVED, type TypedBatch } from "../load/contract.ts";
import { parseFrom, renderSince } from "../load/cursor.ts";
import { isReservedColumn, quoteIdent, readTableSchema, tempRef } from "../load/evolve.ts";
import { buildFileBatch, extractFiles, type FileExtract, type KnownFile, recordFiles } from "../load/files.ts";
import { writeStage } from "../load/stage.ts";
import type { KnownColumn } from "../load/types.ts";
import { writeBatch, type WriteBatchInput, type WriteResult } from "../load/write.ts";
import type { Project } from "../project/root.ts";
import type { ProjectEnv } from "../project/env.ts";
import { cursorTypeOfPin, trimStack } from "../project/ts-asset.ts";
import { type ExtractInfo, isoMicros, readStoredColumns } from "../safety/guards.ts";
import { plannedTrashPath, trashFailed, trashTable, type TrashEntry } from "../safety/trash.ts";
import { backfillUnsupported, backfillWouldDuplicate, type PlannedStep } from "./plan.ts";
import { OwnTableQuery } from "./snapshot.ts";

export type Phase = "extract" | "write" | "checks";

/** A writer that sees another process waiting for the file yields this long before its next write (§5). */
export const FAIRNESS_YIELD_MS = 200;

export interface ProgressSnapshot {
  asset: string;
  phase: Phase;
  rowsFetched: number;
  requests: number;
  elapsedMs: number;
}

/** Progress snapshots (events.ndjson, runs.summary.progress) are reported at most this often per step. */
export const PROGRESS_THROTTLE_MS = 500;

/**
 * What a step has done so far: rows yielded, requests completed, the phase. The runner's no-progress
 * watchdog reads lastAt; the run's --events, `croft wait`, and `status` (through runs.summary) show snapshots.
 * Reports are throttled, and a change inside a throttle window is reported at the window's end, so the last
 * snapshot is never more than one window behind. close() drops a pending report.
 */
export class StepProgress {
  phase: Phase = "extract";
  rows = 0;
  requests = 0;
  readonly startedAt = Date.now();
  lastAt = Date.now();
  /** The watchdog does not count time spent inside DuckDB (the write phase). */
  paused = false;
  lastStatus?: number;
  bodyPreview?: string;
  lastRequest?: string;
  #emittedAt = 0;
  #pending: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(readonly asset: string, private readonly onChange?: (p: ProgressSnapshot) => void,
    private readonly throttleMs = PROGRESS_THROTTLE_MS) {}

  touch(): void {
    this.lastAt = Date.now();
    this.emit(false);
  }

  addRows(n: number): void {
    this.rows += n;
    this.touch();
  }

  request(o: { status?: number; body?: string; label: string }): void {
    this.requests++;
    this.lastRequest = o.label;
    if (o.status !== undefined) this.lastStatus = o.status;
    if (o.body !== undefined) this.bodyPreview = o.body;
    this.touch();
  }

  setPhase(phase: Phase): void {
    this.phase = phase;
    this.paused = phase !== "extract";
    this.lastAt = Date.now();
    this.emit(true);
  }

  snapshot(): ProgressSnapshot {
    return { asset: this.asset, phase: this.phase, rowsFetched: this.rows, requests: this.requests, elapsedMs: Date.now() - this.startedAt };
  }

  extractInfo(): ExtractInfo {
    return {
      requests: this.requests,
      ...(this.lastStatus !== undefined ? { lastStatus: this.lastStatus } : {}),
      ...(this.bodyPreview !== undefined ? { bodyPreview: this.bodyPreview } : {}),
    };
  }

  /** The step ended: no further reports. */
  close(): void {
    this.#closed = true;
    if (this.#pending) clearTimeout(this.#pending);
    this.#pending = null;
  }

  private emit(force: boolean): void {
    if (!this.onChange || this.#closed) return;
    const wait = this.throttleMs - (Date.now() - this.#emittedAt);
    if (!force && wait > 0) {
      // Report the latest state when the window ends.
      if (!this.#pending) {
        this.#pending = setTimeout(() => {
          this.#pending = null;
          this.emit(true);
        }, wait);
        (this.#pending as { unref?: () => void }).unref?.();
      }
      return;
    }
    if (this.#pending) clearTimeout(this.#pending);
    this.#pending = null;
    this.#emittedAt = Date.now();
    this.onChange(this.snapshot());
  }
}

// ---------------------------------------------------------------------------------------------------------
// --allow-shrink

export interface ShrinkRequest {
  asset: string;
  rowsBefore: number;
  rowsAfter: number;
  impact: Impact;
  error: CroftError;
}
export type ShrinkDecision = { kind: "granted" } | { kind: "pending"; confirmation: Confirmation } | { kind: "declined" };
export type ShrinkDecider = (r: ShrinkRequest) => Promise<ShrinkDecision>;

export const SHRINK_ACTION = "replace ingest; SHRINK_GUARD override";

/** The impact of overriding the shrink guard: every current row goes to the trash first. Its hash covers the
 *  asset, the action and the rows at stake, so a table that changed since the token was made is stale. */
export function shrinkImpact(stateDir: string, asset: string, rowsBefore: number): Impact {
  return { asset, action: SHRINK_ACTION, rows: rowsBefore, trashPath: plannedTrashPath(stateDir, asset), downstream: [] };
}

// ---------------------------------------------------------------------------------------------------------

export interface IngestInput {
  step: PlannedStep;
  project: Project;
  env: ProjectEnv;
  warehouse: DuckWarehouse;
  runs: RunsDb;
  runId: string;
  attempt: number;
  maxAttempts: number;
  /** The run's signal combined with the step's no-progress timeout. */
  signal: AbortSignal;
  progress: StepProgress;
  log: LogWriter;
  /** --from, as typed. */
  from?: string;
  /** Present with --allow-shrink: decides whether a SHRINK_GUARD may be overridden. */
  shrink?: ShrinkDecider;
  http?: Partial<Omit<HttpOptions, "signal" | "redact" | "log">>;
  /** Blocking checks inside the write transaction (phase 2 fills this in). */
  checks?: WriteBatchInput["checks"];
  fault?: string;
  now?: () => Date;
}

export interface IngestOutcome {
  result: StepResult;
  /** Warnings from staging, typing and writing. */
  warnings: Problem[];
  /** Errors that are not the step's own failure (CONFIRMATION_REQUIRED). */
  problems: Problem[];
  confirmation?: Confirmation;
  /** The table's state after the write, as mirrored into runs.sqlite. */
  catalog?: CatalogAsset;
}

interface IngestState {
  exists: boolean;
  cursorValue: string | null;
  cursorType: CursorType | null;
  rowCount: number | null;
  known: KnownColumn[];
  files: KnownFile[];
}

/** CROFT_FAULT: kill this process at a named point, as a crash would. */
export function fault(at: string, want: string | undefined): void {
  if (want && want === at) process.kill(process.pid, "SIGKILL");
}

/** Whether a thrown value is a CroftError, including one from another copy of croft (a project's pinned
 *  copy imported by asset code): instanceof fails across copies, so the shape decides. */
export function croftError(e: unknown): CroftError | null {
  if (e instanceof CroftError) return e;
  const p = (e as { problem?: Problem } | null)?.problem;
  if (e && typeof e === "object" && (e as { name?: unknown }).name === "CroftError" && p && typeof p.code === "string") {
    const { severity: _s, code, docs: _d, ...init } = p;
    return isCode(code) ? new CroftError(code, init) : new CroftError("ASSET_CODE_ERROR", { ...init, details: { ...init.details, requestedCode: code } });
  }
  return null;
}

/** An error thrown by asset code: a CroftError as is, anything else ASSET_CODE_ERROR with the project frames. */
export function codeError(e: unknown, step: PlannedStep, root: string): CroftError {
  const c = croftError(e);
  if (c) return c;
  const err = e instanceof Error ? e : new Error(typeof e === "string" ? e : JSON.stringify(e) ?? String(e));
  return new CroftError("ASSET_CODE_ERROR", {
    asset: step.asset, file: step.file,
    message: `${step.asset} failed in its own code: ${err.name}: ${err.message}`,
    hint: "fix the error in the asset (the stack shows where), then run it again; nothing was written",
    effect: "nothing was written; the cursor did not move",
    details: { stack: trimStack(err.stack ?? `${err.name}: ${err.message}`, root) },
  });
}

/** The reason a signal was aborted with, when it is croft's (INTERRUPTED, TIMEOUT). */
function abortReason(signal: AbortSignal, asset: string): CroftError {
  const r = croftError(signal.reason);
  if (r) return r;
  return new CroftError("INTERRUPTED", { asset, message: `${asset} was interrupted`, hint: "nothing was saved from this step; run it again" });
}

/** An Sql that refuses every statement once the step is aborted, so Ctrl-C discards a running transaction. */
function abortable(sql: Sql, signal: AbortSignal, asset: string): Sql {
  const check = () => {
    if (signal.aborted) throw abortReason(signal, asset);
  };
  return {
    all: async (text, params) => {
      check();
      return sql.all(text, params);
    },
    exec: async (text, params) => {
      check();
      return sql.exec(text, params);
    },
  };
}

function rowCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 1;
}

/** Pass rows through while counting them for progress. Anything that is not rows goes to writeStage as is,
 *  which reports it (ROW_NOT_OBJECT). */
function counted(source: unknown, progress: StepProgress): unknown {
  if (source && typeof (source as PromiseLike<unknown>).then === "function") {
    return (async function* () {
      const v = await (source as PromiseLike<unknown>);
      progress.addRows(rowCount(v));
      yield v;
    })();
  }
  if (source && typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    return (async function* () {
      for await (const v of source as AsyncIterable<unknown>) {
        progress.addRows(rowCount(v));
        yield v;
      }
    })();
  }
  if (source && typeof (source as Iterable<unknown>)[Symbol.iterator] === "function" && typeof source !== "string") {
    return (function* () {
      for (const v of source as Iterable<unknown>) {
        progress.addRows(rowCount(v));
        yield v;
      }
    })();
  }
  return source;
}

/** ctx.http with the step's counters: requests, the last status and body excerpt (SHRINK_GUARD details),
 *  all redacted, since they end up in problems. */
function trackedHttp(http: HttpClient, progress: StepProgress, redact: (text: string) => string): HttpClient {
  const wrap = <A extends unknown[]>(method: string, fn: (url: string, ...a: A) => ReturnType<HttpClient["get"]>) =>
    async (url: string, ...a: A) => {
      try {
        const res = await fn(url, ...a);
        progress.request({ status: res.status, body: redact(excerpt(res.text)), label: redact(`${method} ${displayUrl(res.url)}`) });
        return res;
      } catch (e) {
        const d = croftError(e)?.problem.details;
        progress.request({ ...(typeof d?.status === "number" ? { status: d.status } : {}), label: redact(`${method} ${String(d?.url ?? url)}`) });
        throw e;
      }
    };
  return {
    get: wrap("GET", (url, init) => http.get(url, init)),
    post: wrap("POST", (url, body, init) => http.post(url, body, init)),
    // File downloads: counted like any request, but the body (a whole file, maybe binary) is not previewed.
    getBytes: async (url, init) => {
      try {
        const res = await http.getBytes(url, init);
        progress.request({ status: res.status, label: redact(`GET ${displayUrl(res.url)}`) });
        return res;
      } catch (e) {
        const d = croftError(e)?.problem.details;
        progress.request({ ...(typeof d?.status === "number" ? { status: d.status } : {}), label: redact(`GET ${String(d?.url ?? url)}`) });
        throw e;
      }
    },
    get requests() { return http.requests; },
    get attempts() { return http.attempts; },
  };
}

async function readState(warehouse: DuckWarehouse, asset: string, withFiles: boolean, signal: AbortSignal): Promise<IngestState> {
  return warehouse.read(async (db) => {
    const exists = (await readTableSchema(db, asset)) !== null;
    if (!(await hasState(db))) return { exists, cursorValue: null, cursorType: null, rowCount: null, known: [], files: [] };
    const [a] = await db.all<{ cursor_value: string | null; cursor_type: string | null; row_count: number | bigint | null }>(
      `SELECT cursor_value, cursor_type, row_count FROM _croft.assets WHERE name = $1`, [asset]);
    const known = toKnown(await readStoredColumns(db, asset));
    const files = withFiles
      ? (await db.all<{ path: string; size: number | bigint | null; mtime_us: number | bigint | null; etag: string | null; sha256: string | null }>(
        `SELECT path, size, epoch_us(mtime) AS mtime_us, etag, sha256 FROM _croft.files WHERE asset = $1 ORDER BY path`, [asset]))
        .map((f) => ({ path: f.path, size: Number(f.size ?? 0), mtime: f.mtime_us === null ? "" : isoMicros(BigInt(f.mtime_us)), etag: f.etag, sha256: f.sha256 ?? "" }))
      : [];
    return {
      exists, cursorValue: a?.cursor_value ?? null, cursorType: (a?.cursor_type as CursorType | null) ?? null,
      rowCount: a?.row_count === null || a?.row_count === undefined ? null : Number(a.row_count), known, files,
    };
  }, { purpose: `read the state of ${asset}`, signal });
}

function toKnown(stored: Awaited<ReturnType<typeof readStoredColumns>>): KnownColumn[] {
  return stored.map((c) => ({
    name: c.name, type: c.type, sourceName: c.source_name, format: c.format, pinned: c.pinned, pending: c.pending, kinds: c.kinds,
  }));
}

interface Since { value?: string | number; echo?: string }

/** The cursor type for converting --from before the first load fixed it: a pin, else the unit, else a timestamp. */
function guessCursorType(step: PlannedStep, field: string, unit: "s" | "ms" | undefined): CursorType {
  const pin = step.spec?.pins[field];
  const pinned = pin ? cursorTypeOfPin(pin.type) : undefined;
  if (pinned) return pinned;
  return unit ? "integer" : "timestamp";
}

function compareCursor(a: string | number, b: string, type: CursorType): number {
  if (type === "integer") {
    const x = BigInt(String(a).trim()), y = BigInt(b.trim());
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = String(a);
  return x < b ? -1 : x > b ? 1 : 0;
}

function sinceFor(i: IngestInput, state: IngestState): Since {
  const { step } = i;
  const inc = step.incremental;
  if (i.from !== undefined) {
    const unsupported = backfillUnsupported(step);
    if (unsupported) throw unsupported;
  }
  if (inc.kind !== "cursor") return {};
  if (i.from !== undefined) {
    const type = state.cursorType ?? guessCursorType(step, inc.field, inc.unit);
    const conv = parseFrom(i.from, {
      type, ...(inc.unit ? { unit: inc.unit } : {}), timezone: i.project.timezone, now: (i.now ?? clockNow)(),
      template: state.cursorValue, asset: step.asset,
    });
    if (step.write === "append" && state.cursorValue !== null && compareCursor(conv.since, state.cursorValue, type) <= 0) {
      throw backfillWouldDuplicate(step, conv.since, state.cursorValue);
    }
    const echo = `since: ${conv.since}${conv.instant && String(conv.since) !== conv.instant ? ` (${conv.instant})` : ""}`;
    return { value: conv.since, echo };
  }
  if (state.cursorValue === null || state.cursorType === null) return {};
  return {
    value: renderSince(state.cursorValue, {
      type: state.cursorType, ...(inc.unit ? { unit: inc.unit } : {}), lookbackMs: inc.lookbackMs, keyed: step.key.length > 0,
      asset: step.asset, field: inc.field,
    }),
  };
}

/** Keys seen in the batch's JSON columns, merged with the ones already known, capped at 50. */
async function jsonKeys(tx: Sql, batch: TypedBatch, previous: CatalogAsset | null): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const cols = (await readTableSchema(tx, batch.temp, "temp")) ?? [];
  for (const c of cols) {
    if (c.type !== "JSON" || isReservedColumn(c.name)) continue;
    const rows = await tx.all<{ k: string }>(
      `SELECT DISTINCT k FROM (SELECT unnest(json_keys(${quoteIdent(c.name)})) AS k FROM ${tempRef(batch.temp)}
       WHERE json_type(${quoteIdent(c.name)}) = 'OBJECT') ORDER BY k LIMIT 50`);
    const before = previous?.columns.find((x) => x.name === c.name)?.jsonKeys ?? [];
    out[c.name] = [...new Set([...before, ...rows.map((r) => r.k)])].slice(0, 50);
  }
  return out;
}

/** The catalog base of a planned ingest: what its definition says. */
function catalogBase(step: PlannedStep, o: { runId: string | null; keys?: Record<string, string[]>; filesGone?: string[] }): CatalogBase {
  const inc = step.incremental;
  return {
    asset: step.asset, kind: "ingest", behavior: step.words, write: step.write, key: step.key,
    cursorField: inc.kind === "cursor" ? inc.field : null, unit: inc.kind === "cursor" ? inc.unit ?? null : null,
    codeHash: step.codeHash ?? null, lastRunId: o.runId, ...(o.keys ? { jsonKeys: o.keys } : {}),
    ...(o.filesGone?.length ? { filesGone: o.filesGone } : {}),
  };
}

/** The catalog mirror entry, read inside the write transaction so it matches what commits. */
async function readCatalog(tx: Sql, step: PlannedStep, o: { runId: string; keys: Record<string, string[]>; filesGone?: string[] }): Promise<CatalogAsset> {
  const entry = await readCatalogEntry(tx, catalogBase(step, o));
  if (!entry) throw new CroftError("INTERNAL_ERROR", { asset: step.asset, message: `${step.asset} has no _croft record after its write`, hint: "report this croft bug" });
  return entry;
}

/**
 * An unchanged file step still has news for the mirror: which files are gone (§3b: status says "1 file gone").
 * The previous entry gets the current list; without one, the entry is rebuilt from the warehouse.
 */
async function refreshFilesGone(i: IngestInput, gone: string[]): Promise<CatalogAsset | undefined> {
  const { runs, step } = i;
  const prev = getCatalog(runs, step.asset);
  let next: CatalogAsset | null;
  if (prev) {
    next = { ...prev };
    if (gone.length) next.filesGone = gone;
    else delete next.filesGone;
    if (JSON.stringify(prev.filesGone ?? []) === JSON.stringify(gone)) return prev;
  } else {
    next = await i.warehouse.read((sql) => readCatalogEntry(sql, catalogBase(step, { runId: null, filesGone: gone })),
      { purpose: `read the state of ${step.asset}`, signal: i.signal });
  }
  if (next) putCatalog(runs, next, "run");
  return next ?? undefined;
}

/** StepResult.created for a table this step created: its columns (croft's _loaded_at aside) and JSON ones. */
export function createdTable(columns: readonly { name: string; type: string }[]): NonNullable<StepResult["created"]> {
  const own = columns.filter((c) => c.name.toLowerCase() !== RESERVED.loadedAt);
  return { columns: own.length, jsonColumns: own.filter((c) => c.type.toUpperCase() === "JSON").length };
}

function emptyRows(total = 0): StepResult["rows"] {
  return { in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total };
}

/**
 * Run one attempt of an ingest step. Throws the step's failure as a CroftError (the runner records it and
 * decides about retries); returns the StepResult otherwise.
 */
export async function runIngest(i: IngestInput): Promise<IngestOutcome> {
  const { step, warehouse, runs, runId, progress, log, signal, project } = i;
  const asset = step.asset;
  const spec = step.spec;
  const config = step.loaded?.definition?.config as RowsIngest | FileIngest | undefined;
  if (!spec || !config) {
    throw new CroftError("INTERNAL_ERROR", { asset, message: `${asset} was planned without a loaded definition`, hint: "report this croft bug" });
  }
  const started = Date.now();
  const stateDir = canonicalPath(project.paths.stateDir);
  const stageDir = join(stateDir, "staging", runId, asset);
  rmSync(stageDir, { recursive: true, force: true });
  const isFile = step.kind === "file";

  // 1. State, under a short read lease.
  const state = await readState(warehouse, asset, isFile, signal);
  // 2. since.
  const since = sinceFor(i, state);
  if (since.echo) log.write(`--from ${i.from}: ${since.echo}`);
  else if (since.value !== undefined) log.write(`since: ${since.value}`);

  // 3. Extract, with no database lock.
  const http = trackedHttp(createHttp({
    ...i.http, signal, redact: (t) => i.env.redact(t), log: (line) => log.write(line),
  }), progress, (t) => i.env.redact(t));
  const own = new OwnTableQuery({ warehouse, asset, dir: stageDir, stateDir, timezone: project.timezone, signal });
  let manifest: Awaited<ReturnType<typeof writeStage>> | null = null;
  let files: FileExtract | null = null;
  try {
    if (isFile) {
      files = await extractFiles({
        asset, config: config as FileIngest, root: project.root, stateDir, runId, known: state.files, http, signal,
        log: (...args: unknown[]) => log.log(...args),
      });
    } else {
      const ctx: IngestContext = Object.freeze({
        asset, runId, preview: false, signal, http,
        ...(since.value !== undefined ? { since: since.value } : {}),
        secret: (name: string) => i.env.secret(name, spec.secrets, asset),
        log: (...args: unknown[]) => log.log(...args),
        query: <T extends Row = Row>(sql: string, ...params: unknown[]) => own.query<T>(sql, ...params),
      });
      let source: RowSource;
      try {
        source = (config as RowsIngest).rows(ctx);
      } catch (e) {
        throw codeError(e, step, project.root);
      }
      manifest = await writeStage({
        dir: stageDir, asset, runId, source: counted(source, progress) as RowSource,
        knownColumns: state.known.map((c) => ({ name: c.name, sourceName: c.sourceName ?? null })),
        signal, ...(since.value !== undefined ? { sinceUsed: since.value } : {}),
      });
    }
  } catch (e) {
    if (signal.aborted) throw abortReason(signal, asset);
    const err = codeError(e, step, project.root);
    if (err.code === "HTTP_ERROR") err.problem.details = { ...err.problem.details, rowsBeforeError: progress.rows };
    throw err;
  } finally {
    own.close();
  }
  if (signal.aborted) throw abortReason(signal, asset);
  log.write(isFile ? `extracted ${files!.load.length} file(s)` : `extracted ${manifest!.rows} rows in ${manifest!.parts.length} part(s), ${progress.requests} request(s)`);
  fault("after_stage", i.fault);

  const warnings: Problem[] = [...(files?.warnings ?? [])];
  const base = {
    asset, reason: [step.reason, since.echo].filter(Boolean).join("; "), behavior: step.behavior,
    attempt: i.attempt, maxAttempts: i.maxAttempts, schemaChanges: [] as SchemaChange[], checks: [],
    logsCommand: `croft logs ${asset}`, requests: progress.requests,
  };
  if (files?.unchanged) {
    rmSync(stageDir, { recursive: true, force: true });
    const catalog = await refreshFilesGone(i, files.gone);
    return {
      result: { ...base, status: "unchanged", reason: `${base.reason}; files unchanged`, rows: emptyRows(state.rowCount ?? 0), durationMs: Date.now() - started },
      warnings, problems: [], ...(catalog ? { catalog } : {}),
    };
  }

  // 4. Write: one lease, one transaction. Another process waiting for the file gets a turn first (§5 "Fairness").
  progress.setPhase("write");
  if (runs.hasOtherWaiters()) await new Promise((r) => setTimeout(r, FAIRNESS_YIELD_MS));
  const previous = getCatalog(runs, asset);
  const write = (allowShrink: boolean) => warehouse.write(`ingest ${asset}`, async (raw) => {
    // Who holds the file, for other processes' lock messages; set only once this lease has it.
    runs.setLockHolder({ runId, asset, action: "write" });
    try {
      const tx = abortable(raw, signal, asset);
      const known = toKnown(await readStoredColumns(tx, asset));
      let batch: TypedBatch;
      let replaceFiles: string[] | undefined;
      let formats: Record<string, string> | undefined;
      if (files) {
        const fb = await buildFileBatch(tx, { extract: files, knownColumns: known, pins: spec.pins, timezone: project.timezone, readBy: [] });
        batch = fb;
        replaceFiles = fb.replaceFiles;
        formats = fb.formats;
      } else {
        const inc = step.incremental;
        batch = await buildTypedBatch(tx, {
          manifest: manifest!, knownColumns: known, pins: spec.pins,
          ...(inc.kind === "cursor" ? { cursor: { field: inc.field, ...(inc.unit ? { unit: inc.unit } : {}), ...(state.cursorType ? { type: state.cursorType } : {}) } } : {}),
        });
      }
      const res = await writeBatch(tx, {
        batch,
        target: { asset, write: step.write, key: step.key, runId, allowShrink, ...(replaceFiles ? { replaceFiles } : {}) },
        kind: "ingest", ...(step.codeHash ? { codeHash: step.codeHash } : {}), behaviorHash: step.behaviorHash, pins: spec.pins,
        ...(formats ? { formats } : {}), ...(since.value !== undefined ? { sinceUsed: since.value } : {}),
        attempt: i.attempt, extract: progress.extractInfo(), ...(i.checks ? { checks: i.checks } : {}),
        ...(i.now ? { now: i.now() } : {}),
      });
      if (files) await recordFiles(tx, asset, files, res.loadedAt);
      // Read-only, but inside the transaction: a failed statement would abort it, so these stay simple.
      const keys = await jsonKeys(tx, batch, previous);
      const catalog = await readCatalog(tx, step, { runId, keys, ...(files?.gone.length ? { filesGone: files.gone } : {}) });
      fault("before_commit", i.fault);
      return { res, catalog };
    } finally {
      runs.clearLockHolder();
    }
  }, { runId, asset, signal });

  let out: { res: WriteResult; catalog: CatalogAsset };
  let trashed: TrashEntry | null = null;
  try {
    out = await write(false);
  } catch (e) {
    const err = croftError(e);
    if (!err || err.code !== "SHRINK_GUARD" || !i.shrink) throw e;
    const rowsBefore = Number(err.problem.details?.rowsBefore ?? 0);
    const rowsAfter = Number(err.problem.details?.rowsAfter ?? 0);
    const decision = await i.shrink({ asset, rowsBefore, rowsAfter, impact: shrinkImpact(stateDir, asset, rowsBefore), error: err });
    if (decision.kind === "declined") throw err;
    if (decision.kind === "pending") {
      rmSync(stageDir, { recursive: true, force: true });
      const c = decision.confirmation;
      log.write(`needs confirmation ${c.token}: ${asset} would go from ${rowsBefore} rows to ${rowsAfter}`);
      return {
        result: {
          ...base, status: "skipped", reason: "needs confirmation", requests: progress.requests,
          skippedBecause: `${asset} would go from ${rowsBefore} rows to ${rowsAfter}; confirmation ${c.token} is waiting for a human`,
          rows: { ...emptyRows(rowsBefore), in: rowsAfter }, durationMs: Date.now() - started,
        },
        warnings,
        problems: [confirmationProblem(c, rowsBefore, rowsAfter)],
        confirmation: c,
      };
    }
    log.write(`--allow-shrink confirmed: moving the current ${rowsBefore} rows of ${asset} to the trash first`);
    try {
      trashed = await trashTable(warehouse, asset, `run --allow-shrink (${runId})`, { runId, signal });
    } catch (te) {
      // A busy database is worth a retry (the grant holds for this run); anything else stops here.
      const busy = croftError(te);
      if (busy && (busy.code === "DB_BUSY" || busy.code === "DB_HELD_BY_OTHER_PROGRAM")) throw busy;
      throw trashFailed(asset, te);
    }
    fault("between_trash_and_drop", i.fault);
    out = await write(true);
  }
  fault("after_commit_before_sqlite", i.fault);

  putCatalog(runs, out.catalog, "run");
  rmSync(stageDir, { recursive: true, force: true });
  const r = out.res;
  warnings.push(...r.warnings.map((w) => ({ ...w, asset: w.asset ?? asset, runId })));
  log.write(`wrote ${asset}: ${r.rows.added} added, ${r.rows.updated} updated, ${r.rows.unchanged} unchanged, ${r.rows.deleted} deleted; ${r.rows.total} rows`);
  const result: StepResult = {
    ...base, status: "ok", requests: progress.requests, rows: r.rows, schemaChanges: r.schemaChanges,
    ...(r.cursor ? { cursor: r.cursor } : {}),
    ...(trashed ? { trashed: { path: trashed.path, rows: trashed.rows } } : {}),
    ...(r.created ? { created: createdTable(out.catalog.columns) } : {}),
    durationMs: Date.now() - started,
  };
  return { result, warnings, problems: [], catalog: out.catalog };
}

/** CONFIRMATION_REQUIRED for a pending --allow-shrink: nothing was written. */
export function confirmationProblem(c: Confirmation, rowsBefore: number, rowsAfter: number): Problem {
  return problem("CONFIRMATION_REQUIRED", {
    asset: c.impact.asset,
    message: `needs confirmation: ${c.impact.asset} would go from ${rowsBefore} rows to ${rowsAfter} (${SHRINK_ACTION})`,
    hint: `first the current ${rowsBefore} rows go to the trash (croft restore ${c.impact.asset}); ask the user, and only if they agree: croft confirm ${c.token} (valid 15 min)`,
    effect: "nothing was changed",
    fix: { kind: "manual", requiresHuman: true, description: `show the user this impact; only after an explicit yes: croft confirm ${c.token}` },
    details: { token: c.token, expiresAt: c.expiresAt, rowsBefore, rowsAfter, trashPath: c.impact.trashPath ?? null },
  });
}

/** Whether a failure is worth another attempt (§8 "Retries"): what the error itself says, never the
 *  deterministic ones. */
export function isRetryable(p: Problem): boolean {
  if (!isCode(p.code)) return false;
  if (["INTERRUPTED", "ASSET_BUSY", "SHRINK_GUARD", "CONFIRMATION_STALE", "CONFIRMATION_REQUIRED"].includes(p.code)) return false;
  if (CODES[p.code].category === "project") return false;
  return p.retryable === true;
}


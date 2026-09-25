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
// A SHRINK_GUARD with --allow-shrink asks the caller's ConfirmDecider (StepInput.confirm, action "allow_shrink";
// the runner passes one only with --allow-shrink): granted → the table goes to the trash (its own commit), then the
// write runs again with the guard off; pending → a confirmation token, nothing written; declined → SHRINK_GUARD. An
// asset with allowShrink: true skips the question (the user decided in code) but not the trash.
// A changed key, write mode, incremental field or pin is settled before anything is fetched (load/config-change.ts):
// INGEST_CONFIG_CHANGED, or a confirmation (IngestInput.confirmChange, actions "convert_key" and "pin_change") that
// trashes the table first and then converts or retypes it.
// A --rebuild (run/rebuild.ts) starts from no state at all, while the old table stays in the warehouse: the step's
// first write drops it and its state in the transaction that writes the new rows (IngestInput.fresh), so a refetch
// that fails before it commits keeps the old table (the trash holds a copy too). That write also has the rebuild's
// shrink guard (FreshStart.replaced): a refetch with fewer than half of the old rows rolls it back.
// A cursor ingest saves its parts as they come while its cursor values arrive in order (monotone partial commits,
// DESIGN.md §8 "Large first loads", load/partial.ts): each part goes through the same write, and a kill resumes
// from the cursor the last part saved (PartialRun below), which is below every row not saved yet. The saved cursor
// never goes back: when the order breaks after parts committed, the rest is one commit. An empty answer where the
// lookback window held rows is EMPTY_EXTRACT (§3a).
// CROFT_FAULT=after_stage|before_commit|after_commit_before_sqlite|between_trash_and_drop|after_partial_commit
// (the first part; after_partial_commit_<n>: the n-th) kills the process at that point (crash tests, DESIGN.md §10
// "Crash tests").
import { rmSync } from "node:fs";
import { join } from "node:path";
import { unfinishedChunk } from "../checks/run.ts";
import { CODES, CroftError, isCode, problem } from "../core/errors.ts";
import { captureOutput, type OutputSink, writeStderr } from "../core/output.ts";
import type { Confirmation, CursorType, Impact, Problem, SchemaChange, Sql, StepResult } from "../core/types.ts";
import { now as clockNow } from "../core/time.ts";
import type { FileIngest, IngestContext, Row, RowSource, RowsIngest } from "../types.ts";
import { canonicalPath } from "../db/connect.ts";
import { hasState } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { type CatalogAsset, type CatalogBase, getCatalog, putCatalog, readCatalogEntry } from "../history/catalog.ts";
import { createHttp, displayUrl, excerpt, type HttpClient } from "../http/http.ts";
import { buildTypedBatch } from "../load/cast.ts";
import { settleConfig } from "../load/config-change.ts";
import { RESERVED, type TypedBatch } from "../load/contract.ts";
import { cursorTypeFor, parseFrom, renderSince } from "../load/cursor.ts";
import { detectEmptyExtract } from "../load/empty-extract.ts";
import { isReservedColumn, quoteIdent, readTableSchema, tempRef } from "../load/evolve.ts";
import { buildFileBatch, extractFiles, type FileExtract, type KnownFile, recordFiles } from "../load/files.ts";
import { type MonotoneTracker, monotoneTracker, PartialCommitFailed, stageInParts, type StagedInParts,
  type StageInPartsOptions } from "../load/partial.ts";
import { type KnownName, type StageManifestFile, writeStage } from "../load/stage.ts";
import type { KnownColumn } from "../load/types.ts";
import { writeBatch, type WriteResult } from "../load/write.ts";
import { cursorTypeOfPin, trimStack } from "../project/ts-asset.ts";
import { type ExtractInfo, isoMicros, readStoredColumns } from "../safety/guards.ts";
import { plannedTrashPath, trashFailed, trashTable, type TrashEntry } from "../safety/trash.ts";
import { backfillUnsupported, backfillWouldDuplicate, behaviorHash, type PlannedStep } from "./plan.ts";
import { OwnTableQuery } from "./snapshot.ts";
import type { ConfirmDecider, StepInput } from "./step.ts";

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

export const SHRINK_ACTION = "replace ingest; SHRINK_GUARD override";

/** The confirmation command for --allow-shrink on one asset; `croft confirm` re-runs exactly this. */
export function shrinkCommand(asset: string): string {
  return `croft run ${asset} --allow-shrink`;
}

/** The impact of overriding the shrink guard: every current row goes to the trash first. Its hash covers the
 *  asset, the action and the rows at stake, so a table that changed since the token was made is stale. */
export function shrinkImpact(stateDir: string, asset: string, rowsBefore: number): Impact {
  return { asset, action: SHRINK_ACTION, rows: rowsBefore, trashPath: plannedTrashPath(stateDir, asset), downstream: [] };
}

// ---------------------------------------------------------------------------------------------------------

/** An ingest step's input: the step contract (step.ts) plus --from. `confirm`, when present, decides a SHRINK_GUARD
 *  override (action "allow_shrink"): the runner passes it with --allow-shrink only, so without the flag the guard
 *  fails the step. Ingests do not use `preview` until `croft preview` lands. */
export interface IngestInput extends StepInput {
  /** --from, as typed. */
  from?: string;
  /** Asks whether a changed key or pin may rewrite stored rows (actions "convert_key", "pin_change";
   *  load/config-change.ts). The runner passes one when a person started the run; without it such a change fails the
   *  step (INGEST_CONFIG_CHANGED, PIN_CHANGES_DATA). */
  confirmChange?: ConfirmDecider;
  /** --rebuild: the table is rebuilt from scratch, so a changed behavior or pin needs no check of its own. */
  rebuild?: boolean;
  /** --rebuild, after its table went to the trash (run/rebuild.ts): the table and its state stay in the warehouse,
   *  unread, until the step's first write replaces them in its own transaction (swap at commit). */
  fresh?: FreshStart;
}

/**
 * An ingest rebuilt from scratch whose old table stays until the rebuild commits (run/rebuild.ts Rebuilds). Until
 * `done`, the step reads none of the stored state (no cursor, no file list, no stored columns, no table of its own for
 * ctx.query), and its first write drops the table and its state (`reset`) in the transaction that writes the new
 * rows. So a refetch that fails before it commits leaves the old table as it was. Once a write carrying the reset has
 * committed (a monotone part, say), `done` is true and a retry goes on from what it saved.
 */
export interface FreshStart {
  readonly done: boolean;
  /** No monotone part commits before the refetch holds this many rows: its first commit replaces the old table,
   *  which the shrink guard keeps from falling below half of its rows (0: nothing held back). */
  readonly holdRows: number;
  /** Drop the table and its _croft state, inside the write's transaction, before anything else in it. */
  reset(tx: Sql): Promise<void>;
  /** In the same transaction, after the write: the rebuild's shrink guard (SHRINK_GUARD, which rolls the whole swap
   *  back, when the new table holds fewer than half of the old one's rows), and the replacement stamp. Returns the
   *  warning of a shrink that was allowed, or null. */
  replaced(tx: Sql, o: { rows: number; unfinished: boolean; extract: ExtractInfo; now: Date }): Promise<Problem | null>;
  /** The write that carried the reset committed. */
  committed(): void;
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
  /** The stamp of the rows the step's (one) write changed, when it wrote: the runner's warnings after the commit
   *  cover the rows stamped with it. Absent when nothing was written, or the step committed more than once. */
  loadedAt?: string;
}

interface IngestState {
  exists: boolean;
  cursorValue: string | null;
  cursorType: CursorType | null;
  rowCount: number | null;
  known: KnownColumn[];
  files: KnownFile[];
}

/** The state of an asset never built: what a --rebuild starts from (FreshStart). */
const NO_STATE: IngestState = { exists: false, cursorValue: null, cursorType: null, rowCount: null, known: [], files: [] };

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
export function abortReason(signal: AbortSignal, asset: string): CroftError {
  const r = croftError(signal.reason);
  if (r) return r;
  return new CroftError("INTERRUPTED", { asset, message: `${asset} was interrupted`, hint: "nothing was saved from this step; run it again" });
}

/** An Sql that refuses every statement once the step is aborted, so Ctrl-C discards a running transaction. */
export function abortable(sql: Sql, signal: AbortSignal, asset: string): Sql {
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
export function trackedHttp(http: HttpClient, progress: StepProgress, redact: (text: string) => string): HttpClient {
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

/** Saved cursors of these assets, under one short read lease (the --from check before a run starts). */
export async function savedCursors(warehouse: DuckWarehouse, assets: readonly string[], signal?: AbortSignal): Promise<Map<string, SavedCursor>> {
  const out = new Map<string, SavedCursor>();
  if (assets.length === 0) return out;
  await warehouse.read(async (db) => {
    if (!(await hasState(db))) return;
    const rows = await db.all<{ name: string; cursor_value: string | null; cursor_type: string | null }>(
      `SELECT name, cursor_value, cursor_type FROM _croft.assets WHERE name IN (${assets.map((_, n) => `$${n + 1}`).join(", ")})`, [...assets]);
    for (const r of rows) out.set(r.name, { value: r.cursor_value, type: r.cursor_type as CursorType | null });
  }, { purpose: "read saved cursors for --from", ...(signal ? { signal } : {}) });
  return out;
}

export function toKnown(stored: Awaited<ReturnType<typeof readStoredColumns>>): KnownColumn[] {
  return stored.map((c) => ({
    name: c.name, type: c.type, sourceName: c.source_name, format: c.format, pinned: c.pinned, pending: c.pending, kinds: c.kinds,
  }));
}

interface Since {
  value?: string | number;
  echo?: string;
  /** --from after the saved cursor (merge ingests): the write keeps the cursor here, so the rows between it and
   *  --from are fetched by the next run instead of skipped (§8). */
  holdCursor?: string;
}

/** A saved cursor, as _croft.assets has it. */
export interface SavedCursor { value: string | null; type: CursorType | null }

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

/**
 * What `--from` means for one step (§8 "Backfills"), given its saved cursor. Throws what makes it refuse:
 * BACKFILL_UNSUPPORTED (not a cursor ingest), BACKFILL_WOULD_DUPLICATE (an append ingest with a saved position:
 * a --from at or before it stores rows twice, one after it skips the rows in between), USAGE_ERROR (a --from that
 * does not parse), or CURSOR_TYPE_MISMATCH (a --from the cursor's type cannot take: a date for plain integers,
 * a relative value or a date for a text cursor that does not hold dates, cursor.ts). A merge ingest's --from
 * after its saved cursor holds the cursor where it is.
 * The runner calls this before the run starts, so a refusal is never a failed step.
 */
export function fromSince(step: PlannedStep, from: string, saved: SavedCursor, o: { timezone: string; now: Date }): Since {
  const unsupported = backfillUnsupported(step);
  if (unsupported) throw unsupported;
  const inc = step.incremental;
  if (inc.kind !== "cursor") return {};
  const type = saved.type ?? guessCursorType(step, inc.field, inc.unit);
  const conv = parseFrom(from, {
    type, ...(inc.unit ? { unit: inc.unit } : {}), timezone: o.timezone, now: o.now, template: saved.value, asset: step.asset, field: inc.field,
  });
  const echo = `since: ${conv.since}${conv.instant && String(conv.since) !== conv.instant ? ` (${conv.instant})` : ""}`;
  if (saved.value === null) return { value: conv.since, echo };
  const after = compareCursor(conv.since, saved.value, type) > 0;
  if (step.write === "append") {
    throw after ? backfillWouldSkip(step, conv.since, saved.value) : backfillWouldDuplicate(step, conv.since, saved.value);
  }
  return { value: conv.since, echo, ...(after ? { holdCursor: saved.value } : {}) };
}

/** BACKFILL_WOULD_DUPLICATE for an append ingest's --from after its saved cursor: moving the cursor past the
 *  rows in between would lose them, and keeping it would append the rows after --from a second time. */
export function backfillWouldSkip(step: PlannedStep, since: string | number, saved: string): CroftError {
  return new CroftError("BACKFILL_WOULD_DUPLICATE", {
    asset: step.asset, file: step.file,
    message: `${step.asset} appends rows; --from ${since} is after its saved position ${saved}, so the rows in between would never be fetched, and keeping the saved position would store the rows after ${since} twice`,
    hint: `run it without --from, which continues from the saved position (croft run ${step.asset}); to re-read a window, add a key so re-read rows replace their old versions`,
    fix: { kind: "command", description: "continue from the saved position", command: `croft run ${step.asset}` },
    details: { since, saved },
  });
}

function sinceFor(i: IngestInput, state: IngestState): Since {
  const { step } = i;
  const inc = step.incremental;
  if (i.from !== undefined) {
    return fromSince(step, i.from, { value: state.cursorValue, type: state.cursorType }, { timezone: i.project.timezone, now: (i.now ?? clockNow)() });
  }
  if (inc.kind !== "cursor") return {};
  if (state.cursorValue === null || state.cursorType === null) return {};
  return {
    value: renderSince(state.cursorValue, {
      type: state.cursorType, ...(inc.unit ? { unit: inc.unit } : {}), lookbackMs: inc.lookbackMs, keyed: step.key.length > 0,
      asset: step.asset, field: inc.field,
    }),
  };
}

/** Keys seen in the batch's JSON columns, merged with the ones already known, capped at 50. */
export async function jsonKeys(tx: Sql, batch: TypedBatch, previous: CatalogAsset | null): Promise<Record<string, string[]>> {
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

/** StepResult.csvHeader on a CSV ingest's first load: the header decision of its first loaded file. */
function csvHeaderOf(files: FileExtract, columns: readonly { name: string }[]): Pick<StepResult, "csvHeader"> {
  const d = files.files.find((f) => f.csv)?.csv;
  if (!d) return {};
  const names = columns.map((c) => c.name).filter((n) => !n.startsWith("_"));
  return { csvHeader: { header: d.header, from: d.headerFrom, columns: names } };
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

  // 0. A changed behavior or pin, before anything is fetched (load/config-change.ts).
  const settled = await settleConfig(i, { started, hashWith: (w, k) => behaviorHash(w, k, step.incremental) });
  if ("outcome" in settled) return settled.outcome;
  // --rebuild: from scratch, with the old table left in place until the first write replaces it (FreshStart).
  const fresh = i.fresh && !i.fresh.done ? i.fresh : null;
  // 1. State, under a short read lease.
  const state = fresh ? NO_STATE : await readState(warehouse, asset, isFile, signal);
  // 2. since.
  const since = sinceFor(i, state);
  const held = since.holdCursor !== undefined
    ? `the saved position stays at ${since.holdCursor} (--from is after it), so the next run also fetches the rows in between`
    : undefined;
  if (since.echo) log.write(`--from ${i.from}: ${since.echo}${held ? `; ${held}` : ""}`);
  else if (since.value !== undefined) log.write(`since: ${since.value}`);

  // 3. Extract, with no database lock.
  const http = trackedHttp(createHttp({
    ...i.http, signal, redact: (t) => i.env.redact(t), log: (line) => log.write(line),
  }), progress, (t) => i.env.redact(t));
  const own = new OwnTableQuery({ warehouse, asset, dir: stageDir, stateDir, timezone: project.timezone, signal, ...(fresh ? { absent: true } : {}) });
  let manifest: Awaited<ReturnType<typeof writeStage>> | null = null;
  let files: FileExtract | null = null;
  // rows() and map() print to the step log (redacted), never to croft's stdout (core/output.ts); a callback
  // that outlives the step goes to stderr, redacted.
  const output: OutputSink = { write: (text) => (log.closed ? writeStderr(i.env.redact(text)) : log.write(text)) };

  // The write (step 4): one lease, one transaction. A cursor ingest also saves its parts through it while they
  // arrive in cursor order (`part`, PartialRun below); its last write then carries the rest of the rows.
  let previous = fresh ? null : getCatalog(runs, asset);
  /** --rebuild: the old table is still there, and the next write drops it with its state before its own rows. */
  let swap = fresh !== null;
  const write: WriteStep = (allowShrink, part) => warehouse.write(`ingest ${asset}`, async (raw) => {
    // Who holds the file, for other processes' lock messages; set only once this lease has it.
    runs.setLockHolder({ runId, asset, action: "write" });
    try {
      const tx = abortable(raw, signal, asset);
      if (swap) await fresh!.reset(tx);
      const known = toKnown(await readStoredColumns(tx, asset));
      let batch: TypedBatch;
      let replaceFiles: string[] | undefined;
      let formats: Record<string, string> | undefined;
      if (files) {
        const fb = await buildFileBatch(tx, { extract: files, knownColumns: known, pins: spec.pins, timezone: project.timezone, readBy: [...step.readBy] });
        batch = fb;
        replaceFiles = fb.replaceFiles;
        formats = fb.formats;
      } else {
        const inc = step.incremental;
        batch = await buildTypedBatch(tx, {
          manifest: part?.manifest ?? manifest!, knownColumns: known, pins: spec.pins, readBy: [...step.readBy],
          ...(inc.kind === "cursor" ? { cursor: { field: inc.field, ...(inc.unit ? { unit: inc.unit } : {}), ...(state.cursorType ? { type: state.cursorType } : {}) } } : {}),
        });
      }
      const res = await writeBatch(tx, {
        batch,
        target: { asset, write: step.write, key: step.key, runId, allowShrink, ...(replaceFiles ? { replaceFiles } : {}) },
        kind: "ingest", ...(step.codeHash ? { codeHash: step.codeHash } : {}), behaviorHash: step.behaviorHash, pins: spec.pins,
        ...(formats ? { formats } : {}), ...(since.value !== undefined ? { sinceUsed: since.value } : {}),
        attempt: i.attempt, extract: progress.extractInfo(), ...(i.checks ? { checks: partChecks(i.checks, part) } : {}),
        ...(i.readBy ? { readBy: i.readBy } : {}),
        ...(i.now ? { now: i.now() } : {}),
      });
      // --rebuild: the old table went in this transaction; a refetch with fewer than half of its rows rolls it back.
      if (swap) {
        const shrank = await fresh!.replaced(tx, { rows: res.rows.total, unfinished: part?.unfinished === true, extract: progress.extractInfo(), now: i.now?.() ?? clockNow() });
        if (shrank) res.warnings.push(shrank);
      }
      // writeBatch saved greatest(saved, loaded). After a --from beyond the saved cursor that would jump over the
      // rows in between, so the cursor goes back to where it was, in the same transaction (§8).
      if (since.holdCursor !== undefined && res.cursor && res.cursor.after !== since.holdCursor) {
        await tx.exec(`UPDATE _croft.assets SET cursor_value = $1 WHERE name = $2`, [since.holdCursor, asset]);
        await tx.exec(`UPDATE _croft.writes SET cursor_after = $1 WHERE asset = $2 AND loaded_at = $3::TIMESTAMPTZ`, [since.holdCursor, asset, res.loadedAt]);
        res.cursor = { ...res.cursor, after: since.holdCursor };
      }
      if (files) await recordFiles(tx, asset, files, res.loadedAt);
      // Read-only, but inside the transaction: a failed statement would abort it, so these stay simple.
      const keys = await jsonKeys(tx, batch, previous);
      const catalog = await readCatalog(tx, step, { runId, keys, ...(files?.gone.length ? { filesGone: files.gone } : {}) });
      fault("before_commit", i.fault);
      return { res, catalog };
    } finally {
      runs.clearLockHolder();
    }
  }, { runId, asset, signal }).then((out) => {
    // The old table went with this commit: from now on the step (and a retry) goes on from what it saved.
    if (swap) {
      swap = false;
      fresh!.committed();
    }
    return out;
  });
  const parts = partialCommits(i, state, write, (c) => (previous = c), fresh?.holdRows ?? 0);

  try {
    ({ manifest, files } = await captureOutput(output, async (): Promise<{ manifest: typeof manifest; files: typeof files }> => {
      if (isFile) {
        return {
          manifest: null,
          files: await extractFiles({
            asset, config: config as FileIngest, root: project.root, stateDir, runId, known: state.files, http, signal,
            log: (...args: unknown[]) => log.log(...args),
            // The stored columns are the asset's header decision for later CSV files (§3b), and the stored
            // spellings for staged rows.
            knownColumns: state.known.map((c) => ({ name: c.name, sourceName: c.sourceName ?? null })),
          }),
        };
      }
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
      const stage = {
        dir: stageDir, asset, runId, source: counted(source, progress) as RowSource,
        knownColumns: state.known.map((c) => ({ name: c.name, sourceName: c.sourceName ?? null })),
        signal, ...(since.value !== undefined ? { sinceUsed: since.value } : {}),
      };
      return { files: null, manifest: parts ? await parts.stage(stage) : await writeStage(stage) };
    }));
  } catch (e) {
    const err = signal.aborted ? abortReason(signal, asset) : stageFailure(e, step, project.root);
    if (err.code === "HTTP_ERROR") err.problem.details = { ...err.problem.details, rowsBeforeError: progress.rows };
    throw parts?.saved(err) ?? err;
  } finally {
    own.close();
  }
  if (signal.aborted) throw parts?.saved(abortReason(signal, asset)) ?? abortReason(signal, asset);
  log.write(isFile ? `extracted ${files!.load.length} file(s)` : `extracted ${manifest!.rows} rows in ${manifest!.parts.length} part(s), ${progress.requests} request(s)`);
  fault("after_stage", i.fault);

  const warnings: Problem[] = [...settled.warnings, ...(files?.warnings ?? [])];
  const base = {
    asset, reason: [step.reason, since.echo, held, settled.note, parts?.note()].filter(Boolean).join("; "), behavior: step.behavior,
    attempt: i.attempt, maxAttempts: i.maxAttempts, schemaChanges: [...settled.schemaChanges] as SchemaChange[], checks: [],
    logsCommand: `croft logs ${asset}`, requests: progress.requests,
    ...(settled.trashed ? { trashed: { path: settled.trashed.path, rows: settled.trashed.rows } } : {}),
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

  let out: { res: WriteResult; catalog: CatalogAsset };
  let trashed: TrashEntry | null = null;
  // allowShrink: true in the asset (§6) is the user's decision, made in code: a shrink needs no confirmation (the
  // load warning SHRINK_GUARD_DISABLED reports it on every run), but the table still goes to the trash first, so
  // the rows a shrink removes stay recoverable. It wins over --allow-shrink, which would only ask again.
  const standing = spec.allowShrink === true;
  try {
    out = await write(false);
  } catch (e) {
    const err = croftError(e);
    // A --rebuild's own shrink guard is settled by its confirmation (--allow-shrink) or allowShrink: true, never here.
    if (!err || err.code !== "SHRINK_GUARD" || fresh || (!standing && !i.confirm)) throw err && parts ? parts.saved(err) : e;
    const rowsBefore = Number(err.problem.details?.rowsBefore ?? 0);
    const rowsAfter = Number(err.problem.details?.rowsAfter ?? 0);
    let why: string;
    if (standing) {
      log.write(`allowShrink: true: moving the current ${rowsBefore} rows of ${asset} to the trash first; it will have ${rowsAfter}`);
      why = `allowShrink: true (${runId})`;
    } else {
      const decision = await i.confirm!({
        asset, action: "allow_shrink", command: shrinkCommand(asset), impact: shrinkImpact(stateDir, asset, rowsBefore), problem: err.problem,
      });
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
      why = `run --allow-shrink (${runId})`;
    }
    try {
      trashed = await trashTable(warehouse, asset, why, { runId, signal });
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
  const r = parts?.total(out.res) ?? out.res;
  warnings.push(...r.warnings.map((w) => {
    const x = { ...w, asset: w.asset ?? asset, runId };
    return trashed && w.code === "SHRINK_GUARD_DISABLED" ? shrankIntoTrash(x, trashed) : x;
  }));
  const empty = await emptyExtract(i, since, (parts?.committedRows ?? 0) + (manifest?.rows ?? 0));
  if (empty) warnings.push({ ...empty, runId });
  log.write(`wrote ${asset}: ${r.rows.added} added, ${r.rows.updated} updated, ${r.rows.unchanged} unchanged, ${r.rows.deleted} deleted; ${r.rows.total} rows`);
  const result: StepResult = {
    ...base, status: "ok", requests: progress.requests, rows: r.rows, schemaChanges: [...base.schemaChanges, ...r.schemaChanges], checks: r.checks,
    ...(r.cursor ? { cursor: r.cursor } : {}),
    ...(trashed ? { trashed: { path: trashed.path, rows: trashed.rows } } : {}),
    ...(r.created ? { created: createdTable(out.catalog.columns) } : {}),
    ...(r.created && files ? csvHeaderOf(files, out.catalog.columns) : {}),
    durationMs: Date.now() - started,
  };
  return { result, warnings, problems: [], catalog: out.catalog, ...(parts?.committed ? {} : { loadedAt: r.loadedAt }) };
}

/** The write's SHRINK_GUARD_DISABLED after a shrink, with where the rows it removed went. */
function shrankIntoTrash(w: Problem, t: TrashEntry): Problem {
  return {
    ...w,
    message: `${w.message}; the previous ${t.rows} rows went to the trash first: ${t.path}`,
    details: { ...w.details, trashPath: t.path, trashedRows: t.rows },
  };
}

/** CONFIRMATION_REQUIRED for a pending --allow-shrink: nothing was written. */
export function confirmationProblem(c: Confirmation, rowsBefore: number, rowsAfter: number): Problem {
  return problem("CONFIRMATION_REQUIRED", {
    asset: c.impact.asset,
    message: `needs confirmation: ${c.impact.asset} would go from ${rowsBefore} rows to ${rowsAfter} (${SHRINK_ACTION})`,
    hint: `first the current ${rowsBefore} rows go to the trash (.croft/trash/${c.impact.asset}/); ask the user, and only if they agree: croft confirm ${c.token} (valid 15 min)`,
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

// ---------------------------------------------------------------------------------------------------------
// Monotone partial commits (DESIGN.md §8 "Large first loads"; the order check and the cut are load/partial.ts)

/** What a write commits besides the step's whole load: a part of it, or the rest after parts committed. */
interface CommitPart {
  /** The rows staged since the last commit; absent: the step's own manifest (the rest of the load). */
  manifest?: StageManifestFile;
  /** Not the load's last commit: checks on the finished table's row count wait (checks/run.ts ChunkCheckContext). */
  unfinished?: boolean;
}

type WriteStep = (allowShrink: boolean, part?: CommitPart) => Promise<{ res: WriteResult; catalog: CatalogAsset }>;

/** The checks hook for a part that is not the load's last: min_rows waits for the finished table, as it does for
 *  a TS transform's chunk. */
function partChecks(checks: NonNullable<StepInput["checks"]>, part: CommitPart | undefined): NonNullable<StepInput["checks"]> {
  return part?.unfinished ? (sql, ctx) => checks(sql, unfinishedChunk(ctx)) : checks;
}

/** A failure while staging: a part's commit fails with its own error (a non-croft one goes to the runner as is),
 *  anything else came from the asset's code. */
function stageFailure(e: unknown, step: PlannedStep, root: string): CroftError {
  if (!(e instanceof PartialCommitFailed)) return codeError(e, step, root);
  const err = croftError(e.cause);
  if (!err) throw e.cause;
  return err;
}

/** How the cursor's values compare before this load: a pin, the saved cursor type, the stored column's type (not
 *  a pending placeholder), else unknown until the first value (load/partial.ts). */
function cursorTypeKnown(step: PlannedStep, state: IngestState, field: string): CursorType | null {
  const pin = step.spec?.pins[field];
  const pinned = pin ? cursorTypeOfPin(pin.type) : undefined;
  if (pinned) return pinned;
  if (state.cursorType) return state.cursorType;
  const col = state.known.find((c) => c.name.toLowerCase() === field.toLowerCase() || c.sourceName === field);
  return col && !col.pending ? cursorTypeFor(col.type) : null;
}

/** The step's partial commits: a rows ingest with a cursor, outside a preview (which never saves anything real);
 *  null for every other step, which keeps one transaction. */
function partialCommits(i: IngestInput, state: IngestState, write: WriteStep, onCatalog: (c: CatalogAsset) => void, holdRows: number): PartialRun | null {
  const inc = i.step.incremental;
  if (i.step.kind !== "rows" || inc.kind !== "cursor" || i.preview) return null;
  return new PartialRun(i, { field: inc.field, type: cursorTypeKnown(i.step, state, inc.field), unit: inc.unit ?? null, write, onCatalog, holdRows });
}

/**
 * A cursor ingest's commits on its way (load/partial.ts stageInParts): each part goes through the step's own write
 * with the checks of an unfinished load, its catalog entry is mirrored at once, and the step's result, reason and
 * failures account for every commit. The cursor a part saved is never moved back (R41-04): after the order breaks,
 * a failure names the rows at or below it that came late and were not saved, with their backfill.
 */
class PartialRun {
  /** What each part's commit wrote, in order. */
  readonly results: WriteResult[] = [];
  #staged: StagedInParts | null = null;
  readonly #tracker: MonotoneTracker;

  constructor(private readonly i: IngestInput, private readonly o: {
    field: string; type: CursorType | null; unit: "s" | "ms" | null;
    write: WriteStep;
    onCatalog: (c: CatalogAsset) => void;
    /** No part commits before the load holds this many rows (a --rebuild's first commit replaces the old table). */
    holdRows: number;
  }) {
    this.#tracker = monotoneTracker(o.type, o.unit);
  }

  /** Parts committed so far. */
  get committed(): number {
    return this.results.length;
  }

  get committedRows(): number {
    return this.results.reduce((n, r) => n + r.rows.in, 0);
  }

  /** Stage the rows, committing parts on the way; resolves to the part left for the step's last write. */
  async stage(stage: Omit<StageInPartsOptions, "field" | "tracker" | "commit" | "broke" | "holdRows">): Promise<StageManifestFile> {
    this.#staged = await stageInParts({
      ...stage, field: this.o.field, tracker: this.#tracker, holdRows: this.o.holdRows,
      commit: (m, n) => this.#commit(m, n), broke: (b, commits) => this.#broke(b, commits),
    });
    const s = this.#staged;
    if (s.broken && (s.commits > 0 || s.large)) {
      this.i.log.write(`${this.o.field} arrived out of order at row ${s.broken.row} (${outOfOrder(s.broken)}), so ${s.commits ? "the rest" : "the load"} is saved in one commit`);
    }
    if (s.commits) this.i.log.write(`saved ${s.committedRows} rows in ${s.commits} commit(s) on the way; the last commit has ${s.manifest.rows} more`);
    return s.manifest;
  }

  async #commit(manifest: StageManifestFile, n: number): Promise<KnownName[]> {
    const { progress, runs, log, fault: want } = this.i;
    progress.setPhase("write");
    try {
      if (runs.hasOtherWaiters()) await new Promise((r) => setTimeout(r, FAIRNESS_YIELD_MS));
      const out = await this.o.write(false, { manifest, unfinished: true });
      this.results.push(out.res);
      putCatalog(runs, out.catalog, "run");
      this.o.onCatalog(out.catalog);
      log.write(`commit ${n}: saved ${manifest.rows} rows as ${this.o.field} arrived in order; the saved position is ${out.res.cursor?.after ?? "(none)"}`);
      fault("after_partial_commit", want);
      fault(`after_partial_commit_${n}`, want);
      return out.catalog.columns.map((c) => ({ name: c.name, sourceName: c.sourceName }));
    } finally {
      progress.setPhase("extract");
    }
  }

  /** The order broke. After commits, nothing commits any more and the saved cursor stays where they put it, never
   *  lower: a rewind would make the next run fetch again (and an append ingest store twice) what they saved. */
  #broke(b: NonNullable<StagedInParts["broken"]>, commits: number): void {
    if (!commits) return;
    const cursor = this.results.at(-1)?.cursor?.after ?? null;
    this.i.log.write(`${this.o.field} stopped arriving in order after ${commits} commit(s), at row ${b.row} (${outOfOrder(b)}): the rest is saved in one commit, and the saved position stays at ${cursor ?? "none"}; rows at or below it that come now are saved only if the load finishes`);
  }

  /** The step's reason, when parts committed or a large load could not commit in parts. */
  note(): string | undefined {
    const s = this.#staged;
    if (!s) return undefined;
    const f = this.o.field;
    if (s.commits > 0) {
      return s.broken
        ? `saved in ${s.commits + 1} commits: ${f} stopped arriving in order at row ${s.broken.row} (${outOfOrder(s.broken)}), so the rest was saved in one`
        : `saved in ${s.commits + 1} commits as ${f} arrived in order`;
    }
    if (s.broken && s.large) {
      return `saved in one commit: ${f} arrived out of order (${outOfOrder(s.broken)}), as newest-first APIs send it, so a failure before the end fetches the whole load again`;
    }
    return undefined;
  }

  /** The step's WriteResult over every commit: rows added up, the last total, every schema change, check and
   *  warning (each once), and the cursor from where the step began to where it ended. */
  total(last: WriteResult): WriteResult {
    if (!this.committed) return last;
    const all = [...this.results, last];
    const sum = (k: "in" | "added" | "updated" | "unchanged" | "deleted") => all.reduce((n, r) => n + r.rows[k], 0);
    const checks: StepResult["checks"] = [];
    for (const c of all.flatMap((r) => r.checks)) {
      const had = checks.find((x) => x.check === c.check);
      if (!had) checks.push({ ...c });
      else {
        had.ok &&= c.ok;
        if (c.failing !== undefined) had.failing = (had.failing ?? 0) + c.failing;
        if (c.sample && !had.sample) had.sample = c.sample;
      }
    }
    const first = all[0]!;
    const cursor = first.cursor || last.cursor ? { before: first.cursor?.before, after: last.cursor?.after, sinceUsed: first.cursor?.sinceUsed } : undefined;
    return {
      rows: { in: sum("in"), added: sum("added"), updated: sum("updated"), unchanged: sum("unchanged"), deleted: sum("deleted"), total: last.rows.total },
      schemaChanges: all.flatMap((r) => r.schemaChanges), ...(cursor ? { cursor } : {}),
      loadedAt: last.loadedAt, changed: all.some((r) => r.changed), created: all.some((r) => r.created),
      warnings: oncePerSubject(all.flatMap((r) => r.warnings)), checks,
    };
  }

  /**
   * A failure after parts committed: they stay, and the problem says so and where the next run starts: the cursor
   * they saved. Rows that came after the order broke at or below it (`late`) were in the rest, which this failure
   * undid, and a run from the saved cursor never fetches them again: the problem names them and the backfill, and is
   * not retried (a retry would continue from the saved cursor too, and lose them without a word).
   */
  saved(err: CroftError): CroftError {
    const k = this.committed;
    if (!k) return err;
    const rows = this.committedRows;
    const f = this.o.field;
    const asset = this.i.step.asset;
    const cursor = this.results.at(-1)!.cursor?.after ?? null;
    const lead = `${rows} row${rows === 1 ? "" : "s"} from ${k} earlier commit${k === 1 ? "" : "s"} ${rows === 1 ? "was" : "were"} saved, with ${f} up to ${cursor}`;
    const late = this.#tracker.late;
    const b = this.#tracker.broken;
    if (!late || !b) {
      err.problem.effect = `${lead}; the next run continues from there`;
      err.problem.details = { ...err.problem.details, savedRows: rows, savedCommits: k, cursor };
      return err;
    }
    const merge = this.i.step.write === "merge";
    const backfill = `croft run ${asset} --from ${late.lowest}`;
    const them = late.rows === 1 ? "it" : "them";
    const remedy = merge
      ? `${backfill} fetches ${them} again (an upsert)`
      : `An append ingest cannot fetch ${them} again without storing the rows after ${them} twice; with a key it becomes a merge, and then ${backfill} fetches ${them}`;
    err.problem.effect = `${lead}; then ${f} stopped arriving in order (${outOfOrder({ ...b, row: b.index + 1 })}), and ${late.rows} row${late.rows === 1 ? "" : "s"} `
      + `with ${f} at or below ${cursor} (the lowest ${late.lowest}) came after them and ${late.rows === 1 ? "was" : "were"} not saved: the next run continues from ${cursor}, `
      + `so it does not fetch ${them} again. ${remedy}`;
    err.problem.retryable = false;
    err.problem.details = {
      ...err.problem.details, savedRows: rows, savedCommits: k, cursor, lateRows: late.rows, lateLowest: late.lowest, ...(merge ? { backfill } : {}),
    };
    return err;
  }
}

/** Where the order broke, in words: "2026-09-01T00:00:06Z after 2026-09-01T00:00:07Z". */
function outOfOrder(b: NonNullable<StagedInParts["broken"]>): string {
  return b.after === null ? b.value : `${b.value} after ${b.after}`;
}

/** Warnings of several commits, one per code and subject (the column or field it is about). */
function oncePerSubject(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const subject = p.details?.column ?? p.details?.field ?? p.message;
    const k = `${p.code}\u0000${String(subject)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * EMPTY_EXTRACT (§3a): a cursor ingest with a lookback got no rows from its window, although its table has rows in
 * it, so the window held rows last time. Read after the (empty) write, under a short read lease; a failure to read
 * never fails the step.
 */
async function emptyExtract(i: IngestInput, since: Since, rows: number): Promise<Problem | null> {
  const inc = i.step.incremental;
  if (rows > 0 || i.step.kind !== "rows" || inc.kind !== "cursor" || inc.lookbackMs <= 0 || i.from !== undefined || since.value === undefined) return null;
  const value = since.value;
  try {
    return await i.warehouse.read((db) => detectEmptyExtract(db, { asset: i.step.asset, field: inc.field, since: value, extract: i.progress.extractInfo() }),
      { purpose: `check the lookback window of ${i.step.asset}`, signal: i.signal });
  } catch (e) {
    i.log.write(`EMPTY_EXTRACT was not checked: ${(croftError(e)?.problem.message ?? String(e)).split("\n")[0]}`);
    return null;
  }
}


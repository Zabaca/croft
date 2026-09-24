// One TS transform step (DESIGN.md §3e, §5 "Transforms", "Cost guard"), on the step contract (step.ts).
//
//   state       short read lease: the asset's stored columns, each input's facts (columns, key, last_loaded_at),
//               and the positions committed so far (_croft.inputs)
//   reuse       a chunk an earlier attempt staged but could not commit (a failed check, a busy database, a crash
//               before COMMIT), made by the same code from the same positions, is committed first, so the calls
//               that produced its rows are not made (or paid for) again
//   cost guard  an incremental transform that makes requests and would process more than confirmAbove input
//               rows (default 1000) asks StepInput.confirm before any of its code runs (LARGE_REPROCESS); the
//               count is every keyed input's rows after its position, since which inputs the code reads with
//               newRows() is known only once it runs
//   extract     NO database lock: rows(ctx) → NDJSON parts (load/stage.ts); ctx.rows/newRows/query read Parquet
//               snapshots of the inputs through a private DuckDB (run/inputs.ts); ctx.http, ctx.secret, ctx.log;
//               console output and fds 1 and 2 go to the step log (core/output.ts)
//   write       the load pipeline of an ingest: buildTypedBatch → writeBatch (kind "ts", the step attempt, the
//               checks, the input positions in the same transaction) → catalog read-back → runs.sqlite mirror
//
// Full-refresh transforms commit once, when the code has finished; their newRows() is rows(). Incremental
// transforms commit in chunks: once a chunk holds 500 rows or has been open 60 s, the next time the code asks
// newRows() for a row, everything it yielded so far commits with the positions reached (every output of the
// rows up to there has been yielded by then, inputs.ts), in one transaction with its checks, and the code gets
// its next row only after that commit. A failure, a timeout or Ctrl-C loses at most the current chunk, and the
// next run resumes after the last committed position.
//
// CROFT_FAULT kills the process at a named point (crash tests): after_stage, before_commit and
// after_commit_before_sqlite as for ingests, and mid_chunk halfway through filling the chunk after the first
// commit of an incremental transform.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import { captureOutput, type OutputSink, writeStderr } from "../core/output.ts";
import type { Confirmation, Impact, Problem, SchemaChange, Sql, StepResult } from "../core/types.ts";
import type { Row, TransformConfig, TransformContext } from "../types.ts";
import { canonicalPath } from "../db/connect.ts";
import { hasState } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { type CatalogAsset, type CatalogBase, getCatalog, putCatalog, readCatalogEntry, readInputsSeen } from "../history/catalog.ts";
import { createHttp, displayUrl, excerpt, type HttpClient } from "../http/http.ts";
import { buildTypedBatch } from "../load/cast.ts";
import type { TypedBatch } from "../load/contract.ts";
import { isReservedColumn, quoteIdent, readTableSchema, tempRef } from "../load/evolve.ts";
import { MANIFEST_FILE, readStageManifest, type StageManifestFile, writeStage } from "../load/stage.ts";
import type { KnownColumn } from "../load/types.ts";
import { type InputPosition, writeBatch, type WriteResult } from "../load/write.ts";
import { readStoredColumns } from "../safety/guards.ts";
import { codeError, createdTable, croftError, FAIRNESS_YIELD_MS, fault, type StepProgress } from "./ingest.ts";
import { stepAborted, TransformInputs } from "./inputs.ts";
import type { PlannedStep } from "./plan.ts";
import { countAfter, type InputFacts, readInputFacts, type SeenPosition } from "./snapshot.ts";
import type { StepInput, StepOutcome } from "./step.ts";

/** When an incremental transform commits a chunk (§3e): at the first newRows() request after the chunk holds
 *  `rows` rows or has been open `ms` milliseconds. Tests shrink it. */
export const CHUNK = { rows: 500, ms: 60_000 };

/** The cost guard's threshold when the asset sets no confirmAbove (§5). */
export const DEFAULT_CONFIRM_ABOVE = 1000;

/** The Impact action of a LARGE_REPROCESS confirmation. */
export const REPROCESS_ACTION = "incremental transform; LARGE_REPROCESS override";

/** Where an incremental transform's chunk waits between staging and commit: <state>/staging/_chunks/<asset>/.
 *  It is kept when the commit fails, for the next attempt to commit without running the code again. */
export function pendingChunkDir(stateDir: string, asset: string): string {
  return join(stateDir, "staging", "_chunks", asset);
}

const META_FILE = "chunk.json";

/** A staged chunk's record, written next to its manifest once it is complete. */
export interface ChunkMeta {
  version: 1;
  asset: string;
  runId: string;
  attempt: number;
  codeHash: string;
  /** The positions committed when the chunk began, by declared input: it is valid only on top of them. */
  before: Record<string, SeenPosition | null>;
  /** The positions that commit with it. */
  positions: InputPosition[];
  /** _croft.writes.inputs. */
  inputs: { input: string; seenBefore: string | null; seenAfter: string; rows: number }[];
  rows: number;
  /** The code had finished: the last chunk of its run. */
  final: boolean;
}

interface TransformState {
  /** The asset's _croft.columns rows. */
  known: KnownColumn[];
  /** The asset's rows now (_croft.assets.row_count). */
  rowCount: number;
  facts: Map<string, InputFacts | null>;
  /** Committed positions (_croft.inputs) by declared input. */
  saved: Map<string, SeenPosition | null>;
}

type Counts = StepResult["rows"];

const DONE = { done: true, value: undefined } as const;

/** Run one attempt of a TS transform step (step.kind "transform"). Throws the step's failure as a CroftError. */
export async function runTransform(i: StepInput): Promise<StepOutcome> {
  const { step, warehouse, runs, runId, progress, log, signal, project } = i;
  const asset = step.asset;
  const spec = step.spec;
  const config = step.loaded?.definition?.config as TransformConfig | undefined;
  if (!spec || !config || spec.role !== "transform" || typeof config.rows !== "function") {
    throw new CroftError("INTERNAL_ERROR", { asset, message: `${asset} was planned as a transform without a loaded definition`, hint: "report this croft bug" });
  }
  const started = Date.now();
  const stateDir = canonicalPath(project.paths.stateDir);
  const stageDir = join(stateDir, "staging", runId, asset);
  rmSync(stageDir, { recursive: true, force: true });
  const inputNames = step.inputs.length ? step.inputs : spec.inputs;
  const incremental = step.incremental.kind === "new-rows";
  const chunked = incremental && !i.preview;
  const pendingDir = pendingChunkDir(stateDir, asset);

  // 1. State, under a short read lease.
  const state = await readState(warehouse, asset, inputNames, signal);
  const committed = new Map(state.saved);

  // 2. A chunk an earlier attempt staged and did not commit.
  const reusable = chunked ? stagedChunk(pendingDir, step, committed, inputNames) : null;
  if (chunked && !reusable) rmSync(pendingDir, { recursive: true, force: true });
  const afterReuse = new Map(committed);
  if (reusable) for (const p of reusable.meta.positions) afterReuse.set(p.input, positionOf(p));

  // 3. The cost guard, before any code runs.
  const usesHttp = step.usesHttp ?? step.loaded?.usesHttp ?? false;
  if (incremental && usesHttp && !i.preview) {
    const limit = step.confirmAbove ?? spec.confirmAbove ?? DEFAULT_CONFIRM_ABOVE;
    const counts = await pendingCounts(warehouse, inputNames, afterReuse, signal);
    const pending = Object.values(counts).reduce((a, b) => a + b, 0);
    if (pending > limit) {
      const err = largeReprocess(step, pending, limit, counts, !i.confirm);
      if (!i.confirm) throw err;
      const impact: Impact = { asset, action: REPROCESS_ACTION, rows: pending, downstream: [...step.readBy], estimatedRequests: pending };
      const decision = await i.confirm({ asset, action: "large_reprocess", command: `croft run ${asset}`, impact, problem: err.problem });
      if (decision.kind === "declined") throw err;
      if (decision.kind === "pending") {
        const c = decision.confirmation;
        log.write(`needs confirmation ${c.token}: ${asset} would process ${pending} input rows and make requests for them`);
        return {
          result: {
            asset, status: "skipped", reason: "needs confirmation", behavior: step.behavior, attempt: i.attempt, maxAttempts: i.maxAttempts,
            skippedBecause: `${asset} would process ${pending} input rows and make requests for them; confirmation ${c.token} is waiting for a human`,
            rows: emptyRows(state.rowCount), schemaChanges: [], checks: [], logsCommand: `croft logs ${asset}`, durationMs: Date.now() - started,
          },
          warnings: [], problems: [reprocessConfirmation(c, pending)], confirmation: c,
        };
      }
      log.write(`confirmed: ${asset} processes ${pending} input rows (more than confirmAbove ${limit}) and makes requests for them`);
    }
  }

  const totals = new Totals();
  let previous = getCatalog(runs, asset);
  let known = state.known;
  let lastCatalog: CatalogAsset | undefined;
  const commit = async (manifest: StageManifestFile, positions: InputPosition[], inputs: ChunkMeta["inputs"]) => {
    const out = await commitChunk(i, { manifest, positions, inputs, previous, reads: inputNames });
    previous = out.catalog;
    lastCatalog = out.catalog;
    known = out.known;
    for (const p of positions) committed.set(p.input, positionOf(p));
    totals.add(out.res);
    return out;
  };

  if (reusable) {
    log.write(`saving the chunk that ${reusable.meta.runId} (attempt ${reusable.meta.attempt}) staged and could not commit: ${reusable.meta.rows} rows, computed once already`);
    await commit(reusable.manifest, reusable.meta.positions, reusable.meta.inputs);
    rmSync(pendingDir, { recursive: true, force: true });
    totals.reused = reusable.meta.rows;
  }

  // 4. Run the code, with no database lock, committing chunk by chunk.
  const internal = new AbortController();
  const ctxSignal = AbortSignal.any([signal, internal.signal]);
  const chunk = new ChunkState();
  const inputs: TransformInputs = new TransformInputs({
    warehouse, asset, file: step.file, root: project.root, stageDir, stateDir, timezone: project.timezone, signal: ctxSignal,
    inputs: inputNames, facts: state.facts, saved: new Map(committed), incremental,
    ...(i.preview ? { limit: i.preview.rows } : {}),
    onRow: () => progress.touch(),
    ...(chunked ? { onRequest: (): Promise<void> => chunk.request(() => inputs.chunkPositions()) } : {}),
  });
  const http = trackedHttp(createHttp({ ...i.http, signal: ctxSignal, redact: (t) => i.env.redact(t), log: (line) => log.write(line) }),
    progress, (t) => i.env.redact(t));
  const output: OutputSink = { write: (text) => (log.closed ? writeStderr(i.env.redact(text)) : log.write(text)) };
  const ctx: TransformContext = Object.freeze({
    asset, runId, preview: i.preview !== undefined, signal: ctxSignal, http,
    secret: (name: string) => i.env.secret(name, spec.secrets, asset),
    log: (...args: unknown[]) => log.log(...args),
    rows: <T extends Row = Row>(input: string) => inputs.rows(input) as AsyncIterable<T>,
    newRows: <T extends Row = Row>(input: string) => inputs.newRows(input) as AsyncIterable<T>,
    query: <T extends Row = Row>(sql: string, ...params: unknown[]) => inputs.query(sql, params) as Promise<T[]>,
  });

  let user: SourceIterator | null = null;
  let finalInputs: ChunkMeta["inputs"] = [];
  const readBefore: Record<string, number> = {};
  const beforeRun = totals.rows.in;
  try {
    await captureOutput(output, async () => {
      let source: unknown;
      try {
        source = config.rows(ctx);
      } catch (e) {
        throw codeError(e, step, project.root);
      }
      user = iterateSource(source);
      const pull = new Pull(user, chunk, progress, () => {
        if (chunked && totals.chunks >= 1 && chunk.rows >= Math.max(1, Math.floor(CHUNK.rows / 2))) fault("mid_chunk", i.fault);
      });
      for (;;) {
        chunk.reset();
        const dir = chunked ? pendingDir : join(stageDir, "out");
        rmSync(dir, { recursive: true, force: true });
        let manifest: StageManifestFile;
        try {
          manifest = await writeStage({
            dir, asset, runId, source: pull.chunk(), signal: ctxSignal,
            knownColumns: known.map((c) => ({ name: c.name, sourceName: c.sourceName ?? null })),
          });
        } catch (e) {
          throw shiftRow(e, totals.rows.in - beforeRun);
        }
        if (signal.aborted) throw stepAborted(signal, asset);
        const final = pull.done;
        const positions = final ? inputs.finalPositions() : chunk.cut!;
        const read = inputs.summary(positions);
        if (final) finalInputs = read;
        // _croft.writes.inputs: what this chunk covers, from the positions committed before it.
        const summary = read.map((s) => ({ ...s, seenBefore: committed.get(s.input)?.stamp ?? null, rows: s.rows - (readBefore[s.input] ?? 0) }));
        for (const s of read) readBefore[s.input] = s.rows;
        if (chunked) {
          writeMeta(dir, {
            version: 1, asset, runId, attempt: i.attempt, codeHash: step.codeHash ?? "", before: Object.fromEntries(inputNames.map((n) => [n, committed.get(n) ?? null])),
            positions, inputs: summary, rows: manifest.rows, final,
          });
        }
        fault("after_stage", i.fault);
        log.write(final
          ? `extracted ${manifest.rows} rows${totals.chunks ? ` (the last chunk)` : ""}, ${progress.requests} request(s)`
          : `chunk ${totals.chunks + 1}: ${manifest.rows} rows; saving them with the input positions reached`);
        try {
          await commit(manifest, positions, summary);
          if (chunked) rmSync(dir, { recursive: true, force: true });
          chunk.committed();
        } catch (e) {
          chunk.failed(e);
          throw new WriteFailure(e);
        }
        if (final) break;
      }
    });
  } catch (e) {
    internal.abort(croftError(e instanceof WriteFailure ? e.cause : e) ?? undefined);
    if (signal.aborted) throw withSaved(stepAborted(signal, asset), totals);
    // A failed write is croft's (or the checks'), reported as is; anything else came from the asset's code.
    if (e instanceof WriteFailure) throw croftError(e.cause) ? withSaved(croftError(e.cause)!, totals) : e.cause;
    throw withSaved(codeError(e, step, project.root), totals);
  } finally {
    if (!ctxSignal.aborted) internal.abort();
    // A generator stopped by a failure gets its finally blocks run; one waiting on the network is not awaited.
    Promise.resolve((user as SourceIterator | null)?.return?.()).catch(() => {});
    inputs.close();
  }
  rmSync(stageDir, { recursive: true, force: true });

  const catalog = lastCatalog!;
  const warnings = dedupe(totals.warnings).map((w) => ({ ...w, asset: w.asset ?? asset, runId }));
  const r = totals.rows;
  log.write(`wrote ${asset}: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.deleted} deleted; ${r.total} rows`
    + (totals.chunks > 1 ? ` (${totals.chunks} commits)` : ""));
  const read = inputs.newRowsRead();
  const notes = [
    step.reason,
    incremental ? `${read} new input row${read === 1 ? "" : "s"}` : undefined,
    totals.chunks > 1 ? `${totals.chunks} commits` : undefined,
    totals.reused ? `${totals.reused} rows from a chunk staged earlier` : undefined,
    i.preview && inputs.capped() ? `inputs capped at ${i.preview.rows} rows` : undefined,
  ];
  const result: StepResult = {
    asset, status: "ok", reason: notes.filter(Boolean).join("; "), behavior: step.behavior, attempt: i.attempt, maxAttempts: i.maxAttempts,
    rows: r, schemaChanges: totals.schemaChanges, checks: totals.checks, requests: progress.requests, inputs: finalInputs,
    ...(totals.created ? { created: createdTable(catalog.columns) } : {}),
    logsCommand: `croft logs ${asset}`, durationMs: Date.now() - started,
  };
  return { result, warnings, problems: [], catalog };
}

// ---------------------------------------------------------------------------------------------------------
// State

async function readState(warehouse: DuckWarehouse, asset: string, inputs: readonly string[], signal: AbortSignal): Promise<TransformState> {
  return warehouse.read(async (db) => {
    const facts = new Map<string, InputFacts | null>();
    for (const input of inputs) facts.set(input, await readInputFacts(db, input));
    const saved = new Map<string, SeenPosition | null>();
    if (!(await hasState(db))) return { known: [], rowCount: 0, facts, saved };
    const known = toKnown(await readStoredColumns(db, asset));
    const [a] = await db.all<{ row_count: number | bigint | null }>(`SELECT row_count FROM _croft.assets WHERE name = $1`, [asset]);
    const seen = await readInputsSeen(db, asset);
    for (const input of inputs) {
      const s = seen[input];
      saved.set(input, s ? positionOf({ seenLoadedAt: s.seenLoadedAt, seenKey: s.seenKey }) : null);
    }
    return { known, rowCount: Number(a?.row_count ?? 0), facts, saved };
  }, { purpose: `read the state of ${asset}`, signal });
}

function toKnown(stored: Awaited<ReturnType<typeof readStoredColumns>>): KnownColumn[] {
  return stored.map((c) => ({
    name: c.name, type: c.type, sourceName: c.source_name, format: c.format, pinned: c.pinned, pending: c.pending, kinds: c.kinds,
  }));
}

/** A committed position as newRows() compares it (a key is DuckDB's text of each key value). */
function positionOf(p: { seenLoadedAt: string | null; seenKey?: unknown }): SeenPosition | null {
  if (!p.seenLoadedAt) return null;
  return { stamp: p.seenLoadedAt, key: Array.isArray(p.seenKey) ? p.seenKey.map(String) : null };
}

/** Input rows after the positions, per keyed input (the rows newRows() can hand over). */
async function pendingCounts(warehouse: DuckWarehouse, inputs: readonly string[], positions: ReadonlyMap<string, SeenPosition | null>,
  signal: AbortSignal): Promise<Record<string, number>> {
  return warehouse.read(async (db) => {
    const out: Record<string, number> = {};
    for (const input of inputs) {
      const facts = await readInputFacts(db, input);
      // Without a key an input cannot be read with newRows() (INPUT_NEEDS_KEY), so it adds nothing to pay for.
      if (!facts || facts.key.length === 0) continue;
      out[input] = await countAfter(db, input, facts, positions.get(input) ?? null);
    }
    return out;
  }, { purpose: "count the input rows a transform would process", signal });
}

// ---------------------------------------------------------------------------------------------------------
// Staged chunks

function writeMeta(dir: string, meta: ChunkMeta): void {
  const tmp = join(dir, `${META_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(meta, null, 1));
  renameSync(tmp, join(dir, META_FILE));
}

const samePosition = (a: SeenPosition | null | undefined, b: SeenPosition | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A complete staged chunk the step may commit as is: same code, staged on top of the positions committed now. */
function stagedChunk(dir: string, step: PlannedStep, committed: ReadonlyMap<string, SeenPosition | null>, inputs: readonly string[]):
  { meta: ChunkMeta; manifest: StageManifestFile } | null {
  if (!existsSync(join(dir, META_FILE)) || !existsSync(join(dir, MANIFEST_FILE))) return null;
  let meta: ChunkMeta;
  try {
    meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8")) as ChunkMeta;
  } catch {
    return null;
  }
  if (meta.version !== 1 || meta.asset !== step.asset || !step.codeHash || meta.codeHash !== step.codeHash) return null;
  const names = Object.keys(meta.before ?? {}).sort();
  if (JSON.stringify(names) !== JSON.stringify([...inputs].sort())) return null;
  if (!names.every((n) => samePosition(meta.before[n], committed.get(n)))) return null;
  try {
    return { meta, manifest: readStageManifest(dir) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Pulling the code's rows, one chunk at a time

type SourceIterator = { next(): Promise<IteratorResult<unknown>>; return?(): unknown };

/** One async iterator over every RowSource shape rows() may return. */
function iterateSource(source: unknown): SourceIterator {
  if (source && typeof (source as PromiseLike<unknown>).then === "function") {
    let done = false;
    return {
      async next() {
        if (done) return DONE;
        done = true;
        return { done: false, value: await (source as PromiseLike<unknown>) };
      },
    };
  }
  let inner: { next(): unknown; return?(v?: unknown): unknown };
  if (source && typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    inner = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]() as typeof inner;
  } else if (source && typeof source !== "string" && typeof (source as Iterable<unknown>)[Symbol.iterator] === "function") {
    inner = (source as Iterable<unknown>)[Symbol.iterator]() as typeof inner;
  } else {
    throw new CroftError("ROW_NOT_OBJECT", {
      message: `rows() returned ${source === null ? "null" : typeof source}, not rows`,
      hint: "rows() must be an async generator (async *rows({ newRows }) { yield … }), or return an array of objects",
      details: { type: source === null ? "null" : typeof source },
    });
  }
  return {
    next: async () => (await inner.next()) as IteratorResult<unknown>,
    ...(inner.return ? { return: () => inner.return!() } : {}),
  };
}

function rowCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 1;
}

/** The state of the chunk being filled, shared by the pull of the code's rows, the commit, and the code asking
 *  newRows() for input rows. */
class ChunkState {
  rows = 0;
  openedAt = Date.now();
  /** Set when the chunk is cut: the positions it commits with. */
  cut: InputPosition[] | null = null;
  /** Ends the pull's wait for the code's next row when the chunk is cut (set while the pull waits). */
  wake: (() => void) | null = null;
  #commit: { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } | null = null;

  reset(): void {
    this.rows = 0;
    this.openedAt = Date.now();
    this.cut = null;
    this.#commit = null;
  }

  /**
   * The code asks newRows() for a row: when the chunk is due, cut it here with the positions reached, and hold
   * the row back until the chunk has committed (a failed commit reaches the code as the error).
   */
  request(positions: () => InputPosition[]): Promise<void> {
    if (this.#commit) return this.#commit.promise;
    const due = this.rows >= CHUNK.rows || (this.rows > 0 && Date.now() - this.openedAt >= CHUNK.ms);
    if (!due) return Promise.resolve();
    this.cut = positions();
    let resolve!: () => void, reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {}); // the step reports the failure; the code may never ask again
    this.#commit = { promise, resolve, reject };
    this.wake?.();
    return promise;
  }

  committed(): void {
    this.#commit?.resolve();
  }

  failed(e: unknown): void {
    this.#commit?.reject(e);
  }
}

const CUT = Symbol("cut");

/**
 * Hands the code's rows to writeStage one chunk at a time. A chunk ends when it is cut (the code is then inside
 * newRows(), and its pending step carries over to the next chunk) or when the code has finished.
 */
class Pull {
  done = false;
  #carry: Promise<IteratorResult<unknown>> | null = null;

  constructor(private readonly user: SourceIterator, private readonly state: ChunkState, private readonly progress: StepProgress,
    private readonly onRow: () => void) {}

  chunk(): AsyncIterableIterator<unknown> {
    const it: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]: () => it,
      next: async () => {
        if (this.state.cut || this.done) return DONE;
        if (!this.#carry) {
          this.#carry = this.user.next();
          this.#carry.catch(() => {}); // awaited below, or by the next chunk
        }
        const carry = this.#carry;
        const r = await new Promise<IteratorResult<unknown> | typeof CUT>((resolve, reject) => {
          // Calling the code's next() runs it up to its first await, which may already have cut the chunk.
          if (this.state.cut) return resolve(CUT);
          this.state.wake = () => resolve(CUT);
          carry.then(resolve, reject);
        }).finally(() => { this.state.wake = null; });
        if (r === CUT) return DONE;
        this.#carry = null;
        const step = r;
        if (step.done) {
          this.done = true;
          return DONE;
        }
        const n = rowCount(step.value);
        this.state.rows += n;
        this.progress.addRows(n);
        this.onRow();
        return { done: false, value: step.value };
      },
      // writeStage gives up on the source (an unserializable row, an abort): stop the code too.
      return: async () => {
        Promise.resolve(this.user.return?.()).catch(() => {});
        return DONE;
      },
    };
    return it;
  }
}

/** writeStage numbers rows from 1 in every chunk; the problem should name the row of the whole run. */
function shiftRow(e: unknown, offset: number): unknown {
  const err = croftError(e);
  if (!err || offset === 0 || typeof err.problem.details?.row !== "number") return e;
  const row = err.problem.details.row as number;
  err.problem.details = { ...err.problem.details, row: row + offset };
  err.problem.message = err.problem.message.replace(`row ${row} of`, `row ${row + offset} of`);
  return err;
}

// ---------------------------------------------------------------------------------------------------------
// The write

interface CommitInput {
  manifest: StageManifestFile;
  positions: InputPosition[];
  inputs: ChunkMeta["inputs"];
  previous: CatalogAsset | null;
  reads: readonly string[];
}

/** One chunk (or the whole output) through the load pipeline, in one write transaction. */
async function commitChunk(i: StepInput, c: CommitInput): Promise<{ res: WriteResult; catalog: CatalogAsset; known: KnownColumn[] }> {
  const { step, warehouse, runs, runId, progress, signal } = i;
  const asset = step.asset;
  const spec = step.spec!;
  progress.setPhase("write");
  try {
    if (runs.hasOtherWaiters()) await new Promise((r) => setTimeout(r, FAIRNESS_YIELD_MS));
    const out = await warehouse.write(`transform ${asset}`, async (raw) => {
      runs.setLockHolder({ runId, asset, action: "write" });
      try {
        const tx = abortable(raw, signal, asset);
        const known = toKnown(await readStoredColumns(tx, asset));
        const batch = await buildTypedBatch(tx, { manifest: c.manifest, knownColumns: known, pins: spec.pins, readBy: [...step.readBy] });
        const res = await writeBatch(tx, {
          batch, target: { asset, write: step.write, key: step.key, runId }, kind: "ts",
          ...(step.codeHash ? { codeHash: step.codeHash } : {}), behaviorHash: step.behaviorHash, pins: spec.pins,
          attempt: i.attempt, inputs: c.inputs, positions: c.positions,
          ...(i.checks ? { checks: i.checks } : {}), ...(i.readBy ? { readBy: i.readBy } : {}), ...(i.now ? { now: i.now() } : {}),
        });
        // Read-only, but inside the transaction: a failed statement would abort it, so these stay simple.
        const keys = await jsonKeys(tx, batch, c.previous);
        const catalog = await readCatalogEntry(tx, catalogBase(step, { runId, keys, reads: c.reads }));
        if (!catalog) throw new CroftError("INTERNAL_ERROR", { asset, message: `${asset} has no _croft record after its write`, hint: "report this croft bug" });
        const after = toKnown(await readStoredColumns(tx, asset));
        fault("before_commit", i.fault);
        return { res, catalog, known: after };
      } finally {
        runs.clearLockHolder();
      }
    }, { runId, asset, signal });
    fault("after_commit_before_sqlite", i.fault);
    putCatalog(runs, out.catalog, i.preview ? "preview" : "run");
    return out;
  } finally {
    progress.setPhase("extract");
  }
}

/** The catalog base of a TS transform: what its definition says. */
function catalogBase(step: PlannedStep, o: { runId: string; keys: Record<string, string[]>; reads: readonly string[] }): CatalogBase {
  return {
    asset: step.asset, kind: "ts", behavior: step.words, write: step.write, key: step.key, cursorField: null,
    codeHash: step.codeHash ?? null, lastRunId: o.runId, jsonKeys: o.keys, reads: [...o.reads],
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

/** An Sql that refuses every statement once the step is aborted, so Ctrl-C discards a running transaction. */
function abortable(sql: Sql, signal: AbortSignal, asset: string): Sql {
  const check = () => {
    if (signal.aborted) throw stepAborted(signal, asset);
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

/** ctx.http with the step's counters (the no-progress watchdog, StepResult.requests), redacted. */
function trackedHttp(http: HttpClient, progress: StepProgress, redact: (text: string) => string): TransformContext["http"] {
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
  return { get: wrap("GET", (url, init) => http.get(url, init)), post: wrap("POST", (url, body, init) => http.post(url, body, init)) };
}

// ---------------------------------------------------------------------------------------------------------
// Results and problems

/** A write that failed, told apart from a failure of the asset's code on its way out of the extraction. */
class WriteFailure extends Error {
  constructor(override readonly cause: unknown) {
    super("the write failed");
  }
}

class Totals {
  rows: Counts = { in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total: 0 };
  schemaChanges: SchemaChange[] = [];
  checks: StepResult["checks"] = [];
  warnings: Problem[] = [];
  created = false;
  chunks = 0;
  reused = 0;

  add(r: WriteResult): void {
    this.chunks++;
    this.rows = {
      in: this.rows.in + r.rows.in, added: this.rows.added + r.rows.added, updated: this.rows.updated + r.rows.updated,
      unchanged: this.rows.unchanged + r.rows.unchanged, deleted: this.rows.deleted + r.rows.deleted, total: r.rows.total,
    };
    this.schemaChanges.push(...r.schemaChanges);
    this.warnings.push(...r.warnings);
    this.created ||= r.created;
    for (const c of r.checks) {
      const had = this.checks.find((x) => x.check === c.check);
      if (!had) this.checks.push({ ...c });
      else {
        had.ok &&= c.ok;
        if (c.failing !== undefined) had.failing = (had.failing ?? 0) + c.failing;
        if (c.sample && !had.sample) had.sample = c.sample;
      }
    }
  }
}

function emptyRows(total = 0): Counts {
  return { in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total };
}

function dedupe(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const k = `${p.code}\u0000${p.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A failure after some chunks committed: they stay, and the next run continues after them. */
function withSaved(err: CroftError, totals: Totals): CroftError {
  if (totals.chunks === 0) return err;
  const saved = `${totals.rows.in} row${totals.rows.in === 1 ? "" : "s"} from ${totals.chunks} earlier chunk${totals.chunks === 1 ? " were" : "s were"} saved`;
  err.problem.effect = `${saved}; the next run continues after them`;
  err.problem.details = { ...err.problem.details, savedRows: totals.rows.in, savedChunks: totals.chunks };
  return err;
}

/** LARGE_REPROCESS: the cost guard (§5). */
function largeReprocess(step: PlannedStep, pending: number, limit: number, counts: Record<string, number>, noDecider: boolean): CroftError {
  const asset = step.asset;
  const per = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ");
  return new CroftError("LARGE_REPROCESS", {
    asset, file: step.file,
    message: `${asset} would process ${pending} input rows (${per}), more than its confirmAbove of ${limit}, and its code makes requests (an API or an LLM) for them`,
    hint: noDecider
      ? `a person has to approve this: croft run ${asset} shows the impact and asks first; to allow more rows without asking, raise confirmAbove in ${step.file}`
      : `ask the user before spending on ${pending} rows; to allow more rows without asking, raise confirmAbove in ${step.file}`,
    effect: "nothing was processed or written",
    fix: {
      kind: "manual", requiresHuman: true,
      description: `show the user that ${asset} would process ${pending} input rows and make requests for each; only after an explicit yes: croft run ${asset}`,
    },
    details: { pending, confirmAbove: limit, inputs: counts },
  });
}

/** CONFIRMATION_REQUIRED for a pending LARGE_REPROCESS confirmation: nothing was processed. */
function reprocessConfirmation(c: Confirmation, pending: number): Problem {
  return problem("CONFIRMATION_REQUIRED", {
    asset: c.impact.asset,
    message: `needs confirmation: ${c.impact.asset} would process ${pending} input rows and make requests for them (${REPROCESS_ACTION})`,
    hint: `ask the user, and only if they agree: croft confirm ${c.token} (valid 15 min)`,
    effect: "nothing was changed",
    fix: { kind: "manual", requiresHuman: true, description: `show the user this impact; only after an explicit yes: croft confirm ${c.token}` },
    details: { token: c.token, expiresAt: c.expiresAt, rows: pending },
  });
}

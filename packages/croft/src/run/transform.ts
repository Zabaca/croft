// One TS transform step (DESIGN.md §3e, §5 "Transforms", "Cost guard"), on the step contract (step.ts).
//
//   state       short read lease: the asset's stored columns, each input's facts (columns, key, last_loaded_at,
//               version), and the positions committed so far (_croft.inputs)
//   reuse       a chunk an earlier attempt staged but could not commit (a failed check, a busy database, a crash
//               before COMMIT), made by the same code with the same checks from the same positions, is committed
//               first, so the calls that produced its rows are not made (or paid for) again. A chunk its commit
//               refused for what it holds (CHECK_FAILED, KEY_NULL, …) is reused only while every input is still
//               at the version it was staged from: once the user corrects the data, the code runs on it again
//   cost guard  an incremental transform that makes requests and would process more than confirmAbove input
//               rows (default 1000) asks StepInput.confirm before any of its code runs (LARGE_REPROCESS). It
//               counts the rows after the position of each keyed input the code reads with newRows() (the scan
//               of ts-asset.ts detectNewRows; every keyed input when the scan cannot tell); a lookup read with
//               rows() is not processed row by row. An input the scan missed is counted when newRows() first
//               reads it, before its first row is handed over. A preview (StepInput.preview) counts at most its
//               --rows of each input and, with nobody to ask, refuses a count over confirmAbove; croft preview
//               without --rows first lowers its cap to one that fits (previewGuard)
//   extract     NO database lock: rows(ctx) → NDJSON parts (load/stage.ts); ctx.rows/newRows/query read Parquet
//               snapshots of the inputs through a private DuckDB (run/inputs.ts); ctx.http, ctx.secret, ctx.log;
//               console output and fds 1 and 2 go to the step log (core/output.ts)
//   write       the load pipeline of an ingest: buildTypedBatch → writeBatch (kind "ts", the asset's file, the
//               step attempt, the checks, the input positions in the same transaction) → catalog read-back →
//               runs.sqlite mirror
//
// Full-refresh transforms commit once, when the code has finished; their newRows() is rows(). Incremental
// transforms commit in chunks: once a chunk holds 500 rows or has been open 60 s, the next time the code asks
// newRows() for a row, everything it yielded so far commits with the positions of the input rows that count as
// processed (inputs.ts "Positions": never past a row whose outputs may still be pending), in one transaction with
// its checks, and the code gets its next row only after that commit. min_rows waits for the last chunk, when the
// table holds the whole run (checks/run.ts ChunkCheckContext). A failure, a timeout or Ctrl-C loses at most the
// current chunk, and the next run resumes after the last committed position.
//
// CROFT_FAULT kills the process at a named point (crash tests): after_stage, before_commit and
// after_commit_before_sqlite as for ingests, and mid_chunk halfway through filling the chunk after the first
// commit of an incremental transform.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unfinishedChunk } from "../checks/run.ts";
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
import { MANIFEST_FILE, readStageManifest, type StageManifestFile, writeStage } from "../load/stage.ts";
import type { KnownColumn } from "../load/types.ts";
import { type CheckContext, type InputPosition, writeBatch, type WriteResult } from "../load/write.ts";
import { readStoredColumns } from "../safety/guards.ts";
import { codeError, createdTable, croftError, FAIRNESS_YIELD_MS, fault, jsonKeys, type StepProgress, toKnown } from "./ingest.ts";
import { stepAborted, TransformInputs } from "./inputs.ts";
import type { PlannedStep } from "./plan.ts";
import { countAfter, type InputFacts, type InputSnapshot, readInputFacts, type SeenPosition } from "./snapshot.ts";
import { inputsInZone } from "./sql.ts";
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
  version: 2;
  asset: string;
  runId: string;
  attempt: number;
  codeHash: string;
  /** The blocking checks the chunk was staged under (checksHash): other checks discard it. */
  checkHash: string;
  /** The positions committed when the chunk began, by declared input: it is valid only on top of them. */
  before: Record<string, SeenPosition | null>;
  /** Each declared input's version (InputFacts.version) when the step that staged the chunk began. */
  basis: Record<string, string | null>;
  /** The positions that commit with it. */
  positions: InputPosition[];
  /** _croft.writes.inputs. */
  inputs: { input: string; seenBefore: string | null; seenAfter: string; rows: number }[];
  rows: number;
  /** The code had finished: the last chunk of its run. */
  final: boolean;
  /** Set when a commit refused the chunk for what it holds (CHECK_FAILED, KEY_NULL, …), to the code it failed
   *  with. Such a chunk is reused only while every input is at its `basis` version. */
  refused?: string;
}

/** Failures that say nothing about a chunk's rows: a chunk they stopped is committed again as it is. Any other
 *  croft code from its commit refuses the rows themselves (ChunkMeta.refused). */
const NOT_ABOUT_THE_ROWS = new Set<string>([
  "DB_BUSY", "DB_HELD_BY_OTHER_PROGRAM", "ASSET_BUSY", "DB_UNREADABLE", "INTERRUPTED", "TIMEOUT", "RUN_CRASHED", "INTERNAL_ERROR",
]);

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
  const checkHash = checksHash(step);
  const staged = chunked ? stagedChunk(pendingDir, step, { committed, inputs: inputNames, facts: state.facts, checkHash }) : null;
  const reusable = staged && "meta" in staged ? staged : null;
  if (staged && "why" in staged) log.write(`discarded the chunk staged earlier: ${staged.why}`);
  if (chunked && !reusable) rmSync(pendingDir, { recursive: true, force: true });
  const afterReuse = new Map(committed);
  if (reusable) for (const p of reusable.meta.positions) afterReuse.set(p.input, positionOf(p));

  // 3. The cost guard, before any code runs. A preview hands the code at most --rows rows of each input, so the
  //    cap bounds its count; a preview has nobody to ask, so a count over confirmAbove refuses it.
  let guard: Guard | null = null;
  if (costGuarded(step)) {
    const g = await guardCount(step, warehouse, afterReuse, signal, i.preview?.rows);
    guard = { ...g, counted: new Set(g.counted), confirmed: false };
    const { limit, counts, pending } = g;
    if (pending > limit && i.preview) throw previewReprocess(step, g, i.preview.rows);
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
      guard.confirmed = true;
    }
  }

  const totals = new Totals();
  let previous = getCatalog(runs, asset);
  let known = state.known;
  let lastCatalog: CatalogAsset | undefined;
  const commit = async (manifest: StageManifestFile, positions: InputPosition[], inputs: ChunkMeta["inputs"], unfinished: boolean) => {
    const out = await commitChunk(i, { manifest, positions, inputs, previous, reads: inputNames, unfinished });
    previous = out.catalog;
    lastCatalog = out.catalog;
    known = out.known;
    for (const p of positions) committed.set(p.input, positionOf(p));
    totals.add(out.res);
    return out;
  };

  if (reusable) {
    const m = reusable.meta;
    log.write(`saving the chunk that ${m.runId} (attempt ${m.attempt}) staged and could not commit: ${m.rows} rows, computed once already`);
    try {
      await commit(reusable.manifest, m.positions, m.inputs, !m.final);
    } catch (e) {
      refuse(pendingDir, e);
      throw reusedChunkFailed(e, m);
    }
    rmSync(pendingDir, { recursive: true, force: true });
    totals.reused = m.rows;
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
    ...(guard ? { onNewInput: (input: string, snap: InputSnapshot) => countLate(guard!, step, input, snap, !i.confirm) } : {}),
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
      const pull = new Pull(user, chunk, progress, (n) => {
        // The outputs count toward the input rows that are processed (inputs.ts "Positions").
        inputs.yielded(n);
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
            version: 2, asset, runId, attempt: i.attempt, codeHash: step.codeHash ?? "", checkHash,
            before: Object.fromEntries(inputNames.map((n) => [n, committed.get(n) ?? null])),
            basis: Object.fromEntries(inputNames.map((n) => [n, state.facts.get(n)?.version ?? null])),
            positions, inputs: summary, rows: manifest.rows, final,
          });
        }
        fault("after_stage", i.fault);
        log.write(final
          ? `extracted ${manifest.rows} rows${totals.chunks ? ` (the last chunk)` : ""}, ${progress.requests} request(s)`
          : `chunk ${totals.chunks + 1}: ${manifest.rows} rows; saving them with the input positions reached`);
        try {
          await commit(manifest, positions, summary, chunked && !final);
          if (chunked) rmSync(dir, { recursive: true, force: true });
          chunk.committed();
        } catch (e) {
          if (chunked) refuse(dir, e);
          chunk.failed(e);
          throw new WriteFailure(e);
        }
        if (final) break;
      }
    });
  } catch (e) {
    internal.abort(croftError(e instanceof WriteFailure ? e.cause : e) ?? undefined);
    const saved = savedPositions(state, committed);
    if (signal.aborted) throw withSaved(stepAborted(signal, asset), totals, saved);
    // A failed write is croft's (or the checks'), reported as is; anything else came from the asset's code.
    if (e instanceof WriteFailure) throw croftError(e.cause) ? withSaved(croftError(e.cause)!, totals, saved) : e.cause;
    throw withSaved(codeError(e, step, project.root), totals, saved);
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
    rows: r, schemaChanges: totals.schemaChanges, checks: totals.checks, requests: progress.requests, inputs: inputsInZone(finalInputs, project.timezone),
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

/** A committed position as newRows() compares it (a key is DuckDB's text of each key value). */
function positionOf(p: { seenLoadedAt: string | null; seenKey?: unknown }): SeenPosition | null {
  if (!p.seenLoadedAt) return null;
  return { stamp: p.seenLoadedAt, key: Array.isArray(p.seenKey) ? p.seenKey.map(String) : null };
}

/** The cost guard applies (§5): an incremental transform whose code makes requests (an API, an LLM). */
function costGuarded(step: PlannedStep): boolean {
  return step.incremental.kind === "new-rows" && (step.usesHttp ?? step.loaded?.usesHttp ?? false);
}

/** The declared inputs of a transform step. */
function inputsOf(step: PlannedStep): readonly string[] {
  return step.inputs.length ? step.inputs : step.spec?.inputs ?? [];
}

/** The cost guard's count of a step before its code runs. */
export interface GuardCount {
  /** confirmAbove. */
  limit: number;
  /** Input rows the code would be handed, per counted keyed input. */
  counts: Record<string, number>;
  pending: number;
  /** The inputs counted: those the code reads with newRows() when the scan of its code could tell, otherwise
   *  every input. */
  counted: string[];
}

/**
 * The rows after the position of each keyed input the code reads with newRows() (a lookup read with rows() is not
 * processed row by row). `cap`: croft preview's --rows, the most newRows() hands over of each input.
 */
async function guardCount(step: PlannedStep, warehouse: DuckWarehouse, positions: ReadonlyMap<string, SeenPosition | null>,
  signal: AbortSignal, cap?: number): Promise<GuardCount> {
  const inputs = inputsOf(step);
  const limit = step.confirmAbove ?? step.spec?.confirmAbove ?? DEFAULT_CONFIRM_ABOVE;
  const reads = step.loaded?.readsNewRows;
  const counted = reads ? inputs.filter((n) => reads.includes(n)) : [...inputs];
  const all = counted.length ? await pendingCounts(warehouse, counted, positions, signal) : {};
  const counts = Object.fromEntries(Object.entries(all).map(([k, n]) => [k, cap === undefined ? n : Math.min(n, cap)]));
  return { limit, counts, pending: Object.values(counts).reduce((a, b) => a + b, 0), counted };
}

/** The largest per-input row cap, at most `cap`, whose rows (each input's count, capped) stay within `limit`;
 *  0 when not even one row of each counted input does. */
export function rowsWithin(counts: readonly number[], limit: number, cap: number): number {
  const total = (c: number) => counts.reduce((a, n) => a + Math.min(n, c), 0);
  if (total(cap) <= limit) return cap;
  let lo = 0;
  let hi = cap;                                            // total(lo) <= limit < total(hi)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (total(mid) <= limit) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * croft preview's cost guard, before the step runs: what a preview of `step` with at most `cap` rows of each
 * input would hand its code, and the largest cap that stays within confirmAbove (`fits`: 0 when none does). null
 * when the guard does not apply (a full-refresh transform, or code that makes no requests). Reads the positions
 * the step's table has in `warehouse` (the preview database).
 */
export async function previewGuard(step: PlannedStep, warehouse: DuckWarehouse, cap: number, signal: AbortSignal): Promise<(GuardCount & { fits: number }) | null> {
  if (!costGuarded(step)) return null;
  const state = await readState(warehouse, step.asset, inputsOf(step), signal);
  const g = await guardCount(step, warehouse, state.saved, signal, cap);
  return { ...g, fits: rowsWithin(Object.values(g.counts), g.limit, cap) };
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

function readMeta(dir: string): ChunkMeta | null {
  try {
    return JSON.parse(readFileSync(join(dir, META_FILE), "utf8")) as ChunkMeta;
  } catch {
    return null;
  }
}

const samePosition = (a: SeenPosition | null | undefined, b: SeenPosition | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The checks a chunk is staged under: the sources of the blocking ones, in order. Warnings run after the commit
 *  and never refuse a chunk, so editing one keeps it. */
export function checksHash(step: Pick<PlannedStep, "checks">): string {
  const list = (step.checks ?? []).filter((c) => c.blocking).map((c) => c.source.trim());
  return createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 16);
}

interface StagedContext {
  committed: ReadonlyMap<string, SeenPosition | null>;
  inputs: readonly string[];
  /** The inputs' facts now (their versions). */
  facts: ReadonlyMap<string, InputFacts | null>;
  checkHash: string;
}

/**
 * A complete staged chunk the step may commit as is: the same code and checks, staged on top of the positions
 * committed now, and, when a commit refused it for what it holds, every input still at the version it was
 * staged from (the user has not corrected the data since). `why` when there is a chunk that does not fit; null
 * when there is none.
 */
function stagedChunk(dir: string, step: PlannedStep, s: StagedContext): { meta: ChunkMeta; manifest: StageManifestFile } | { why: string } | null {
  if (!existsSync(join(dir, META_FILE)) || !existsSync(join(dir, MANIFEST_FILE))) return null;
  const meta = readMeta(dir);
  if (!meta || meta.version !== 2 || meta.asset !== step.asset) return { why: "it was staged by another version of croft" };
  if (!step.codeHash || meta.codeHash !== step.codeHash) return { why: `${step.file} changed since` };
  if (meta.checkHash !== s.checkHash) return { why: "the checks changed since" };
  const names = Object.keys(meta.before ?? {}).sort();
  if (JSON.stringify(names) !== JSON.stringify([...s.inputs].sort())) return { why: "the inputs changed since" };
  if (!names.every((n) => samePosition(meta.before[n], s.committed.get(n)))) return { why: "other rows were saved since" };
  if (meta.refused) {
    const changed = names.find((n) => (meta.basis?.[n] ?? null) !== (s.facts.get(n)?.version ?? null));
    if (changed) return { why: `${meta.refused} refused it, and ${changed} changed since; its rows are computed again` };
  }
  try {
    return { meta, manifest: readStageManifest(dir) };
  } catch {
    return { why: "its files are incomplete" };
  }
}

/** A commit of the chunk staged in `dir` failed: when the failure is about its rows, mark it refused. */
function refuse(dir: string, e: unknown): void {
  const code = croftError(e)?.code;
  if (!code || NOT_ABOUT_THE_ROWS.has(code)) return;
  const meta = readMeta(dir);
  if (!meta) return;
  try {
    writeMeta(dir, { ...meta, refused: code });
  } catch {}
}

/** A reused chunk's commit failed: its rows were computed by an earlier run, and are committed again (without
 *  running the code) until the code, a check or an input changes. */
function reusedChunkFailed(e: unknown, meta: ChunkMeta): unknown {
  const err = croftError(e);
  if (!err || NOT_ABOUT_THE_ROWS.has(err.code)) return e;
  const note = `these ${meta.rows} rows were computed by an earlier run (${meta.runId}) and staged; croft saves them without running the code again until the code, a check or an input changes`;
  err.problem.hint = err.problem.hint ? `${err.problem.hint} (${note})` : note;
  err.problem.details = { ...err.problem.details, stagedBy: meta.runId };
  return err;
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

  /** `onRow(n)`: the code yielded a value of n rows. */
  constructor(private readonly user: SourceIterator, private readonly state: ChunkState, private readonly progress: StepProgress,
    private readonly onRow: (n: number) => void) {}

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
        this.onRow(n);
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
  /** A chunk that is not its run's last: min_rows waits (checks/run.ts ChunkCheckContext). */
  unfinished: boolean;
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
        const checks = i.checks;
        const res = await writeBatch(tx, {
          batch, target: { asset, write: step.write, key: step.key, runId }, kind: "ts", file: step.file,
          ...(step.codeHash ? { codeHash: step.codeHash } : {}), behaviorHash: step.behaviorHash, pins: spec.pins,
          attempt: i.attempt, inputs: c.inputs, positions: c.positions,
          ...(checks ? { checks: c.unfinished ? (sql: Sql, ctx: CheckContext) => checks(sql, unfinishedChunk(ctx)) : checks } : {}),
          ...(i.readBy ? { readBy: i.readBy } : {}), ...(i.now ? { now: i.now() } : {}),
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

/** The input positions this run committed (they moved from where the step began), in words and as details. */
function savedPositions(state: TransformState, committed: ReadonlyMap<string, SeenPosition | null>): { text: string; positions: { input: string; seenLoadedAt: string; seenKey: string[] | null }[] } {
  const positions: { input: string; seenLoadedAt: string; seenKey: string[] | null }[] = [];
  const words: string[] = [];
  for (const [input, p] of committed) {
    if (!p || samePosition(p, state.saved.get(input))) continue;
    positions.push({ input, seenLoadedAt: p.stamp, seenKey: p.key });
    const key = state.facts.get(input)?.key ?? [];
    words.push(p.key && p.key.length === key.length
      ? `${input}: ${key.map((k, n) => `${k.name}=${p.key![n]}`).join(", ")} at ${p.stamp}`
      : `${input}: every row stamped up to ${p.stamp}`);
  }
  return { text: words.join("; "), positions };
}

/** A failure after some chunks committed: they stay, with the input positions saved with them, and the next run
 *  continues after those positions (which never pass a row whose output was not saved, inputs.ts). */
function withSaved(err: CroftError, totals: Totals, saved: ReturnType<typeof savedPositions>): CroftError {
  if (totals.chunks === 0) return err;
  const rows = `${totals.rows.in} row${totals.rows.in === 1 ? "" : "s"} from ${totals.chunks} earlier chunk${totals.chunks === 1 ? " were" : "s were"} saved`;
  err.problem.effect = saved.text
    ? `${rows}; the next run continues after the input position${saved.positions.length === 1 ? "" : "s"} saved with them (${saved.text})`
    : `${rows}; the next run continues after the input positions saved with them`;
  err.problem.details = { ...err.problem.details, savedRows: totals.rows.in, savedChunks: totals.chunks, positions: saved.positions };
  return err;
}

/** The cost guard's count of one step (§5). */
interface Guard {
  limit: number;
  /** Pending input rows per counted input. */
  counts: Record<string, number>;
  pending: number;
  /** The inputs counted so far. */
  counted: Set<string>;
  /** A person approved the step's count before the code ran. */
  confirmed: boolean;
}

/**
 * newRows() is about to hand over the first row of an input the guard did not count before the code ran (the
 * scan of the code could not tell it reads the input with newRows()): count it now, and refuse the input when
 * the step's count goes over confirmAbove and no one approved the count.
 */
async function countLate(g: Guard, step: PlannedStep, input: string, snap: InputSnapshot, noDecider: boolean): Promise<void> {
  if (g.counted.has(input)) return;
  g.counted.add(input);
  if (snap.facts.key.length === 0) return;
  g.counts[input] = snap.rows;
  g.pending += snap.rows;
  if (g.confirmed || g.pending <= g.limit) return;
  throw largeReprocess(step, g.pending, g.limit, g.counts, noDecider, input);
}

/** LARGE_REPROCESS: the cost guard (§5). `late`: an input counted only when newRows() first read it. */
function largeReprocess(step: PlannedStep, pending: number, limit: number, counts: Record<string, number>, noDecider: boolean, late?: string): CroftError {
  const asset = step.asset;
  const per = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ");
  const message = `${asset} would process ${pending} input rows (${per}), more than its confirmAbove of ${limit}, and its code makes requests (an API or an LLM) for them`;
  const details = { pending, confirmAbove: limit, inputs: counts };
  if (late) {
    // Asking now would come after the code started: croft asks only before it runs, so the code has to show it.
    const read = `newRows(${JSON.stringify(late)})`;
    return new CroftError("LARGE_REPROCESS", {
      asset, file: step.file, message,
      hint: `croft could not tell from ${step.file} that it reads ${late} with newRows(), so it could not ask before the code ran; write ${read} with the input's name as a string, and croft asks first; or raise confirmAbove in ${step.file}`,
      effect: `no row of ${late} was processed`,
      fix: { kind: "edit", file: step.file, description: `read ${late} with ${read}, its name written as a string, so croft counts its rows and asks before the code runs` },
      details: { ...details, uncounted: late },
    });
  }
  return new CroftError("LARGE_REPROCESS", {
    asset, file: step.file, message,
    hint: noDecider
      ? `a person has to approve this: croft run ${asset} shows the impact and asks first; to allow more rows without asking, raise confirmAbove in ${step.file}`
      : `ask the user before spending on ${pending} rows; to allow more rows without asking, raise confirmAbove in ${step.file}`,
    effect: "nothing was processed or written",
    fix: {
      kind: "manual", requiresHuman: true,
      description: `show the user that ${asset} would process ${pending} input rows and make requests for each; only after an explicit yes: croft run ${asset}`,
    },
    details,
  });
}

/**
 * LARGE_REPROCESS in croft preview: with --rows `rows`, the preview would hand the code more input rows than its
 * confirmAbove, and a preview cannot ask. The fix previews at most as many rows as confirmAbove allows.
 */
export function previewReprocess(step: PlannedStep, g: Pick<GuardCount, "limit" | "counts" | "pending">, rows: number, o: { rebuild?: boolean } = {}): CroftError {
  const asset = step.asset;
  const per = Object.entries(g.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ");
  const fits = rowsWithin(Object.values(g.counts), g.limit, rows);
  const command = `croft preview ${asset}${o.rebuild ? " --rebuild" : ""} --rows ${fits}`;
  return new CroftError("LARGE_REPROCESS", {
    asset, file: step.file,
    message: `a preview of ${asset} with up to ${rows} rows of each input would process ${g.pending} input rows (${per}), more than its confirmAbove of ${g.limit}, and its code makes requests (an API or an LLM) for them`,
    hint: fits >= 1
      ? `preview fewer rows, within confirmAbove: ${command}; to allow more without asking, raise confirmAbove in ${step.file}`
      : `not even one row of each input fits within its confirmAbove of ${g.limit}; raise confirmAbove in ${step.file}`,
    effect: "nothing was processed; nothing real changed",
    fix: fits >= 1
      ? { kind: "command", description: `preview at most ${fits} row${fits === 1 ? "" : "s"} of each input`, command }
      : { kind: "manual", requiresHuman: true, description: `ask the user whether ${asset} may make ${g.pending} paid requests without asking; only after a yes, raise confirmAbove in ${step.file}` },
    details: { pending: g.pending, confirmAbove: g.limit, inputs: g.counts, rows, ...(fits >= 1 ? { fits } : {}) },
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

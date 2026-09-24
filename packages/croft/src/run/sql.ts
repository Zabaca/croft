// One SQL transform step (DESIGN.md §3c "How the body is executed", §5 "Transforms", "Versions, staleness and
// atomicity"). One write lease, one transaction; nothing is visible until all of it commits:
//
//   inputs    each input's last_loaded_at and row count, read in this transaction: what the SELECT sees
//   describe  DESCRIBE <body>: the output names as the SELECT wrote them. A view (and any subquery) renames
//             a repeated name, so `SELECT *` over a join of two assets yields _loaded_at and _loaded_at_1; the
//             names as written say which columns are croft's (left out) and which repeat (DUPLICATE_OUTPUT_COLUMN)
//   view      CREATE OR REPLACE TEMP VIEW __body AS <body>, verbatim: a trailing `;` or `--` comment is fine
//   next      CREATE TEMP TABLE __croft_next AS SELECT *, row_number() OVER () AS _croft_seq
//               FROM (SELECT COLUMNS(c -> lower(c) NOT IN ('_loaded_at', '_file', …)) FROM __body)
//             (named apart from `next`, an asset name a TEMP table would shadow)
//   write     load/table-batch.ts → writeBatch kind "sql": a diff like a replace ingest, so unchanged rows keep
//             their stamps; a changed shape recreates the table; a duplicate key is CHECK_FAILED unique(key); then
//             the blocking checks (StepInput.checks) and _croft.inputs, every input at the last_loaded_at it read
//   after     the temp objects dropped and the catalog entry read back, in the transaction; after the commit,
//             the catalog mirror and the non-blocking checks (checks/run.ts runWarnings, on a read lease)
//
// A DuckDB error in the user's SQL is located in the asset's file (sql/bind.ts mapAssetError: the header's
// lines are added, the caret becomes the column). An error while the rows are computed (a failed cast, say) has
// no position, but still names the file.
// CROFT_FAULT=before_commit|after_commit_before_sqlite kills the process at that point (crash tests).
import { runWarnings } from "../checks/run.ts";
import { CroftError, isCode } from "../core/errors.ts";
import type { Problem, Sql, StepResult } from "../core/types.ts";
import { hasState } from "../db/state.ts";
import { putCatalog, readCatalogEntry } from "../history/catalog.ts";
import { RESERVED } from "../load/contract.ts";
import { currentDatabase, quoteIdent, quoteLiteral, readTableSchema, tableRef, tempRef } from "../load/evolve.ts";
import { tableBatch } from "../load/table-batch.ts";
import { type CheckHookResult, type InputPosition, writeBatch, type WriteBatchInput, type WriteResult } from "../load/write.ts";
import { isoMicros } from "../safety/guards.ts";
import { type AssetErrorOptions, mapAssetError } from "../sql/bind.ts";
import { createdTable, croftError, FAIRNESS_YIELD_MS, fault } from "./ingest.ts";
import { behaviorWords, type PlannedStep } from "./plan.ts";
import type { StepInput, StepOutcome } from "./step.ts";

/** The TEMP view the body becomes, and the TEMP table its rows are materialized in. */
export const BODY_VIEW = "__body";
export const NEXT_TABLE = "__croft_next";

/** Output names croft owns: an upstream's _loaded_at and _file are never copied, and _croft_seq is added here. */
const RESERVED_OUTPUT: readonly string[] = [RESERVED.loadedAt, RESERVED.file, RESERVED.seq];

/** What the step read of one input, in its transaction. */
interface InputRead {
  /** The input's name as _croft.assets spells it (as listed, when croft has no record of it). */
  input: string;
  /** Its last_loaded_at (ISO-8601 UTC, microseconds); null when croft has never written a row to it. */
  lastLoadedAt: string | null;
  rows: number;
  /** The position this asset recorded for it before (seen_loaded_at), null on the first read. */
  seenBefore: string | null;
}

/** Run one attempt of an SQL transform step (step.kind "sql", step.sql loaded). Throws the step's failure as a
 *  CroftError. */
export async function runSqlStep(i: StepInput): Promise<StepOutcome> {
  const { step, warehouse, runs, runId, progress, log, signal } = i;
  const asset = step.asset;
  const sql = step.sql;
  if (step.kind !== "sql" || !sql) {
    throw new CroftError("INTERNAL_ERROR", { asset, message: `${asset} was planned as an SQL step without its loaded SQL file`, hint: "report this croft bug" });
  }
  // The plan fails a step with load errors before it runs; this keeps unchecked SQL out of the warehouse anyway.
  const broken = sql.problems.find((p) => p.severity === "error");
  if (!sql.ok || broken) throw loadError(step, broken);
  if (signal.aborted) throw abortReason(signal, asset);
  const started = Date.now();
  const listed = [...new Set([...step.inputs, ...sql.astInputs])].sort();
  const codeHash = step.codeHash ?? sql.codeHash;
  const where: AssetErrorOptions = { file: step.file, lineOffset: sql.headerLines, body: sql.body };
  log.write(`rebuilding ${asset} from ${listed.length ? listed.join(", ") : "no inputs"}`);

  // No extraction: all of it is DuckDB's work (the no-progress watchdog does not count it). Another process
  // waiting for the file gets a turn first (§5 "Fairness").
  progress.setPhase("write");
  if (runs.hasOtherWaiters()) await new Promise((r) => setTimeout(r, FAIRNESS_YIELD_MS));
  const checks: WriteBatchInput["checks"] = i.checks
    ? (tx, ctx) => {
      progress.setPhase("checks");
      return i.checks!(tx, ctx);
    }
    : undefined;

  const out = await warehouse.write(`rebuild ${asset}`, async (raw) => {
    runs.setLockHolder({ runId, asset, action: "write" });
    try {
      const tx = abortable(raw, signal, asset);
      const inputs = await readInputs(tx, asset, listed);
      await materialize(tx, step, where);
      const batch = await tableBatch(tx, { temp: NEXT_TABLE, asset });
      const res = await writeBatch(tx, {
        batch, target: { asset, write: "replace", key: step.key, runId },
        kind: "sql", file: step.file, ...(codeHash ? { codeHash } : {}), behaviorHash: step.behaviorHash, attempt: i.attempt,
        inputs: inputs.map((r) => ({ input: r.input, seenBefore: r.seenBefore, seenAfter: r.lastLoadedAt, rows: r.rows })),
        positions: inputs.map((r): InputPosition => ({ input: r.input, seenLoadedAt: r.lastLoadedAt, seenKey: null, inputLastLoadedAt: r.lastLoadedAt })),
        ...(checks ? { checks } : {}), ...(i.readBy ? { readBy: i.readBy } : {}), ...(i.now ? { now: i.now() } : {}),
      });
      // An input the SQL no longer reads is no input any more: staleness must not wait for it.
      await tx.exec(`DELETE FROM _croft.inputs WHERE asset = $1 AND NOT list_contains(CAST($2::JSON AS VARCHAR[]), input)`,
        [asset, JSON.stringify(inputs.map((r) => r.input))]);
      const keys = await jsonKeys(tx, NEXT_TABLE);
      await tx.exec(`DROP VIEW IF EXISTS ${tempRef(BODY_VIEW)}`);
      await tx.exec(`DROP TABLE IF EXISTS ${tempRef(NEXT_TABLE)}`);
      const catalog = await readCatalogEntry(tx, {
        asset, kind: "sql", behavior: step.words || behaviorWords("replace", step.key, { kind: "none" }), write: "replace", key: step.key,
        cursorField: null, codeHash: codeHash ?? null, lastRunId: runId, jsonKeys: keys, reads: inputs.map((r) => r.input),
      });
      if (!catalog) throw new CroftError("INTERNAL_ERROR", { asset, message: `${asset} has no _croft record after its write`, hint: "report this croft bug" });
      fault("before_commit", i.fault);
      return { res, catalog, inputs };
    } finally {
      runs.clearLockHolder();
    }
  }, { runId, asset, signal });
  fault("after_commit_before_sqlite", i.fault);

  putCatalog(runs, out.catalog, "run");
  const r: WriteResult = out.res;
  const shape = r.schemaChanges.some((c) => c.kind === "recreate") ? "; the SELECT's shape changed, so the table was recreated" : "";
  log.write(`wrote ${asset}: ${r.rows.added} added, ${r.rows.updated} updated, ${r.rows.unchanged} unchanged, ${r.rows.deleted} deleted; ${r.rows.total} rows${shape}`);

  // Non-blocking checks, after the commit (§3f): a failing one is a warning and a result, never a failure.
  const late = await warnings(i, r);
  const read: NonNullable<StepResult["inputs"]> = out.inputs.flatMap((x) => (x.lastLoadedAt === null ? [] : [{
    input: x.input, seenBefore: x.seenBefore, seenAfter: x.lastLoadedAt, rows: x.rows,
  }]));
  const result: StepResult = {
    asset, status: "ok", reason: step.reason, behavior: step.behavior, attempt: i.attempt, maxAttempts: i.maxAttempts,
    rows: r.rows, schemaChanges: r.schemaChanges, checks: [...r.checks, ...late.results],
    ...(read.length ? { inputs: read } : {}),
    ...(r.created ? { created: createdTable(out.catalog.columns) } : {}),
    logsCommand: `croft logs ${asset}`, durationMs: Date.now() - started,
  };
  const found = [...r.warnings, ...late.problems].map((w) => ({ ...w, asset: w.asset ?? asset, runId }));
  return { result, warnings: found, problems: [], catalog: out.catalog };
}

// ---------------------------------------------------------------------------------------------------------

/** The error a step whose SQL did not load fails with: its first load error. */
function loadError(step: PlannedStep, p: Problem | undefined): CroftError {
  if (!p) {
    return new CroftError("ASSET_INVALID", {
      asset: step.asset, file: step.file, message: `${step.file} did not load`, hint: "fix the problems listed for it, then run it again",
    });
  }
  const { severity: _s, code, docs: _d, ...init } = p;
  return new CroftError(isCode(code) ? code : "ASSET_INVALID", { ...init, asset: init.asset ?? step.asset, file: init.file ?? step.file });
}

/** The reason a signal was aborted with, when it is croft's (INTERRUPTED, TIMEOUT). */
function abortReason(signal: AbortSignal, asset: string): CroftError {
  return croftError(signal.reason)
    ?? new CroftError("INTERRUPTED", { asset, message: `${asset} was interrupted`, hint: "nothing was saved from this step; run it again" });
}

/** An Sql that refuses every statement once the step is aborted, so Ctrl-C discards the transaction. */
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

const us = (v: number | bigint | null | undefined) => (v === null || v === undefined ? null : isoMicros(BigInt(v)));

/** Each input's last_loaded_at and rows as this transaction sees them, and the position recorded before. */
async function readInputs(tx: Sql, asset: string, inputs: readonly string[]): Promise<InputRead[]> {
  if (inputs.length === 0) return [];
  if (!(await hasState(tx))) return inputs.map((input) => ({ input, lastLoadedAt: null, rows: 0, seenBefore: null }));
  const known = await tx.all<{ name: string; ll: number | bigint | null; n: number | bigint | null }>(
    `SELECT name, epoch_us(last_loaded_at) AS ll, row_count AS n FROM _croft.assets
     WHERE list_contains(CAST($1::JSON AS VARCHAR[]), lower(name))`, [JSON.stringify(inputs.map((n) => n.toLowerCase()))]);
  const seen = await tx.all<{ input: string; s: number | bigint | null }>(
    `SELECT input, epoch_us(seen_loaded_at) AS s FROM _croft.inputs WHERE asset = $1`, [asset]);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return inputs.map((listed) => {
    const a = known.find((k) => same(k.name, listed));
    const input = a?.name ?? listed;
    return { input, lastLoadedAt: us(a?.ll), rows: Number(a?.n ?? 0), seenBefore: us(seen.find((s) => same(s.input, input))?.s) };
  });
}

/**
 * The SELECT's rows in NEXT_TABLE, with _croft_seq and without croft's reserved columns. Refuses, before any
 * write, a SELECT that repeats an output name (DUPLICATE_OUTPUT_COLUMN) or returns only reserved columns.
 */
async function materialize(tx: Sql, step: PlannedStep, where: AssetErrorOptions): Promise<void> {
  const body = where.body;
  let written: string[];
  try {
    written = (await tx.all<{ column_name: string }>(`DESCRIBE ${body}`)).map((c) => c.column_name);
    await tx.exec(`CREATE OR REPLACE TEMP VIEW ${quoteIdent(BODY_VIEW)} AS ${body}`);
  } catch (e) {
    throw located(e, step, where, true);
  }
  const reserved = written.map((n) => RESERVED_OUTPUT.includes(n.toLowerCase()));
  if (reserved.every(Boolean)) {
    throw new CroftError("ASSET_INVALID", {
      asset: step.asset, file: step.file,
      message: `${step.asset}: its SELECT returns only columns croft keeps for itself (${[...new Set(written)].join(", ") || "none"})`,
      hint: `select at least one column of your own; croft adds ${RESERVED.loadedAt} to every table`,
      effect: "nothing was written",
    });
  }
  const first = new Map<string, string>();
  const repeated = new Set<string>();
  written.forEach((n, k) => {
    if (reserved[k]) return;
    const lower = n.toLowerCase();
    if (first.has(lower)) repeated.add(first.get(lower)!);
    else first.set(lower, n);
  });
  if (repeated.size) {
    const names = [...repeated];
    throw new CroftError("DUPLICATE_OUTPUT_COLUMN", {
      asset: step.asset, file: step.file,
      message: `${step.asset}: its SELECT returns ${names.join(", ")} more than once (names are case-insensitive)`,
      hint: "give every output column its own name (… AS other_name); for SELECT * over a join, list the columns or join with USING (…)",
      effect: "nothing was written",
      details: { columns: names },
    });
  }
  // The view's own names, position by position: a repeated reserved name was renamed (_loaded_at_1), and goes too.
  const viewCols = (await tx.all<{ name: string }>(
    `SELECT column_name AS name FROM duckdb_columns() WHERE database_name = 'temp' AND schema_name = 'main' AND table_name = $1
     ORDER BY column_index`, [BODY_VIEW])).map((c) => c.name);
  const drop = new Set<string>(RESERVED_OUTPUT);
  if (viewCols.length === written.length) viewCols.forEach((n, k) => reserved[k] && drop.add(n.toLowerCase()));
  try {
    await tx.exec(`CREATE OR REPLACE TEMP TABLE ${quoteIdent(NEXT_TABLE)} AS
      SELECT *, row_number() OVER () AS ${quoteIdent(RESERVED.seq)}
      FROM (SELECT COLUMNS(c -> lower(c) NOT IN (${[...drop].map(quoteLiteral).join(", ")})) FROM ${quoteIdent(BODY_VIEW)})`);
  } catch (e) {
    throw located(e, step, where, false);
  }
}

/**
 * A failure of the user's SQL as croft reports it, in the asset's file. `position`: the statement had the body
 * verbatim after a one-line prefix, so DuckDB's "LINE n" and caret point into it; otherwise (the statement that
 * computes the rows) a position would point into croft's own statement, and is left out.
 */
function located(e: unknown, step: PlannedStep, where: AssetErrorOptions, position: boolean): unknown {
  const own = croftError(e);
  // prepare() takes one statement: more than one in the body (the load gate refuses that first).
  if (own?.code === "SQL_NOT_ONE_STATEMENT") {
    return new CroftError("SQL_NOT_ONE_STATEMENT", {
      asset: step.asset, file: step.file, message: `${step.file} holds more than one SQL statement`,
      hint: "an SQL asset is exactly one SELECT (CTEs are fine); remove the other statements",
    });
  }
  if (own) return own;
  const mapped = mapAssetError(e, where);
  if (!(mapped instanceof CroftError)) return mapped;
  const { severity: _s, code: _c, docs: _d, line, column, ...init } = mapped.problem;
  return new CroftError(mapped.code, {
    ...init, asset: step.asset, file: step.file,
    ...(position && line !== undefined ? { line, ...(column !== undefined ? { column } : {}) } : {}),
    effect: init.effect ?? "nothing was written",
  });
}

/** Keys seen in the result's JSON columns (describe, the bind check), capped at 50 per column. */
async function jsonKeys(tx: Sql, temp: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const c of (await readTableSchema(tx, temp, "temp")) ?? []) {
    if (c.type !== "JSON") continue;
    const rows = await tx.all<{ k: string }>(
      `SELECT DISTINCT k FROM (SELECT unnest(json_keys(${quoteIdent(c.name)})) AS k FROM ${tempRef(temp)}
       WHERE json_type(${quoteIdent(c.name)}) = 'OBJECT') ORDER BY k LIMIT 50`);
    out[c.name] = rows.map((r) => r.k);
  }
  return out;
}

/**
 * The asset's non-blocking checks (step.checks with blocking false), on a read lease after the commit. They
 * cannot undo it, so warnings that could not run at all are a warning too, never the step's failure.
 */
async function warnings(i: StepInput, r: WriteResult): Promise<CheckHookResult> {
  const list = i.step.checks.filter((c) => !c.blocking);
  if (list.length === 0) return { problems: [], results: [] };
  i.progress.setPhase("checks");
  const asset = i.step.asset;
  try {
    return await i.warehouse.read(async (db) =>
      runWarnings(db, { asset, table: tableRef(await currentDatabase(db), asset), loadedAt: r.loadedAt, rows: r.rows }, list),
    { purpose: `check the warnings of ${asset}`, signal: i.signal });
  } catch (e) {
    const p = (croftError(e) ?? new CroftError("INTERNAL_ERROR", { message: e instanceof Error ? e.message : String(e), hint: "report this croft bug" })).problem;
    i.log.write(`the warnings of ${asset} did not run: ${p.code}: ${p.message}`);
    return {
      problems: [{ ...p, severity: "warning", asset, file: p.file ?? i.step.file, message: `the warnings of ${asset} did not run (its rows are written): ${p.message}` }],
      results: [],
    };
  }
}


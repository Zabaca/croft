// Running checks (DESIGN.md §3f): blocking ones inside the write transaction, after the write and before
// commit, where a failure rolls back data, schema changes and cursor together [V]; warnings after commit,
// recorded. Scope: `not_null` and row rules cover the rows this write changed (the batch), `unique` and
// `min_rows` the whole table; a check whose text changed since the last run covers the whole table once. An
// incremental TS transform commits in chunks: min_rows applies once its run has finished, at the last chunk
// (ChunkCheckContext).
// CHECK_FAILED details are {check, failing, sample}: 20 sample rows collected, 3 rendered. A sample shows a
// TIMESTAMPTZ with the project offset, as `croft query` does (instantsInZone).
//
// Also in the details: `checked` (the rows in scope) and `scope` ("batch" or "table"); a blocking failure adds
// `results`, every blocking check's result, since the hook throws instead of returning them. Every blocking
// check runs, so one failure does not hide the next; the message names the first with its samples and lists the
// others ("also failing: …"). `failing` counts rows: for not_null and rules the rows that fail, for unique the
// rows that share their values with another row (rows with a NULL in the columns are left out, as in SQL), for
// min_rows how many rows are missing.
//
// "The rows this write changed" are the table's rows stamped with the write's _loaded_at (CheckContext.loadedAt):
// added and updated rows, as the table has them after the write (a merge keeps columns the batch lacked), and
// never deleted or unchanged ones. The same definition serves warnings after commit, when the batch table is
// gone. Unchanged rows passed the same check when they were written; a new or edited check has not seen them,
// so it covers the whole table.
//
// Every statement goes through the Sql wrapper's prepare(), one statement per call. A rule is vetted again on
// the same connection before it is evaluated (checks/parse.ts vetCheck: exactly `SELECT (<expr>) FROM <asset>`,
// tables only), so a check that never went through validate still cannot smuggle anything in. The write's stamp
// is inlined as a literal croft made, never a parameter a rule could reference.
//
// A blocking check that cannot run (an unknown column, a type error on this data) is CHECK_INVALID and rolls the
// write back like a failure: data a check cannot vouch for is not committed. A warning that cannot run is a
// warning-severity CHECK_INVALID; a failing warning a warning-severity CHECK_FAILED. Neither is ever an error.
import { CroftError, problem } from "../core/errors.ts";
import { formatInstant } from "../core/time.ts";
import type { Check, Problem, Sql } from "../core/types.ts";
import type { CheckContext, CheckHookResult, WriteBatchInput } from "../load/write.ts";
import { quoteIdent, quoteLiteral } from "../load/evolve.ts";
import type { Row } from "../types.ts";
import { checkColumns, minRowsOf, tokenize, vetCheck } from "./parse.ts";

export interface ChecksHookOptions {
  /** Root-relative, for CHECK_FAILED's location and fix. */
  file: string;
  /** Sources of the checks the asset's last successful write ran. A check not among them is new or edited, and
   *  covers the whole table this time. Omitted or null: every check covers the whole table. */
  previous?: readonly string[] | null;
}

/** Sample rows collected per failing check (CHECK_FAILED details.sample, StepResult.checks[].sample). */
export const SAMPLE_ROWS = 20;
/** Sample rows rendered in a CHECK_FAILED message. */
export const RENDERED_ROWS = 3;

type CheckResult = { check: string; ok: boolean; failing?: number; sample?: Row[] };

/** One check's outcome: its result, how many rows it looked at, and what a message needs. */
interface Outcome {
  check: Check;
  result: CheckResult;
  /** Rows in scope (the batch, or the whole table). */
  checked: number;
  whole: boolean;
  /** unique: how many values appear more than once. min_rows: the table's rows. */
  groups?: number;
  /** A batch-scoped check covered the whole table (new or edited), and that was more than the batch. */
  widened?: boolean;
}

/**
 * The CheckContext of one chunk of an incremental TS transform (run/transform.ts). A chunk that is not its run's
 * last is `unfinished`: the table does not hold the run's rows yet, so a check on how many rows the finished
 * table has (min_rows) waits for the last chunk, and a first build of more rows than one chunk is not refused at
 * its first chunk. Every other check runs on every chunk, unique included: a chunk that breaks it is refused
 * before it commits, which a later chunk could not undo.
 */
export interface ChunkCheckContext extends CheckContext {
  unfinished?: boolean;
}

/** `ctx` for a chunk that is not the last of its run (ChunkCheckContext). */
export function unfinishedChunk(ctx: CheckContext): ChunkCheckContext {
  return { ...ctx, unfinished: true };
}

/** Checks on the finished table's row count, which an unfinished chunk skips. */
const COUNTS_FINISHED_TABLE = new Set<Check["kind"]>(["min_rows"]);

/** The writeBatch hook (WriteBatchInput.checks, StepInput.checks) for an asset's blocking checks. It throws
 *  CHECK_FAILED, rolling the write back, when one fails, and otherwise returns one result per check it ran.
 *  Non-blocking checks in `checks` are skipped here (runWarnings runs them), and so is min_rows on an unfinished
 *  chunk (ChunkCheckContext). */
export function checksHook(checks: readonly Check[], o: ChecksHookOptions): NonNullable<WriteBatchInput["checks"]> {
  const blocking = checks.filter((c) => c.blocking);
  const identity = identityColumns(checks);
  return async (tx: Sql, ctx: CheckContext): Promise<CheckHookResult> => {
    const unfinished = (ctx as ChunkCheckContext).unfinished === true;
    const due = unfinished ? blocking.filter((c) => !COUNTS_FINISHED_TABLE.has(c.kind)) : blocking;
    if (!due.length) return { problems: [], results: [] };
    const counts = await scopeCounts(tx, ctx.table, ctx.loadedAt);
    const outcomes: Outcome[] = [];
    for (const c of due) {
      const whole = c.scope === "table" || isNew(c, o.previous);
      outcomes.push(await evaluate(tx, { asset: ctx.asset, table: ctx.table, loadedAt: ctx.loadedAt, file: o.file }, c, whole, counts));
    }
    const failed = outcomes.filter((x) => !x.result.ok);
    if (failed.length) throw checkFailed(ctx, o.file, failed, outcomes.map((x) => x.result), identity);
    return { problems: [], results: outcomes.map((x) => x.result) };
  };
}

/** A write that has committed: CheckContext without its batch table, which is gone. The rows it changed are
 *  those stamped `loadedAt`. */
export type WarningContext = Omit<CheckContext, "batch">;

/** Run the non-blocking checks in `checks` after a commit, on `sql` (a read lease); blocking ones are skipped.
 *  A failing warning is a problem and a result, never an error.
 *  @param o.file root-relative, for the problems' location.
 *  @param o.previous as ChecksHookOptions.previous, except that leaving it out keeps every warning on the rows
 *  this write changed (a warning never re-reports the whole table unless it is known to be new or edited). */
export async function runWarnings(sql: Sql, ctx: WarningContext, checks: readonly Check[], o: { file?: string; previous?: readonly string[] | null } = {}): Promise<CheckHookResult> {
  const warnings = checks.filter((c) => !c.blocking);
  const out: CheckHookResult = { problems: [], results: [] };
  if (!warnings.length) return out;
  const identity = identityColumns(checks);
  const counts = await scopeCounts(sql, ctx.table, ctx.loadedAt);
  for (const c of warnings) {
    const whole = c.scope === "table" || (o.previous !== undefined && isNew(c, o.previous));
    let x: Outcome;
    try {
      x = await evaluate(sql, { asset: ctx.asset, table: ctx.table, loadedAt: ctx.loadedAt, file: o.file }, c, whole, counts);
    } catch (e) {
      if (!(e instanceof CroftError) || e.code !== "CHECK_INVALID") throw e;
      out.problems.push({ ...e.problem, severity: "warning" });
      out.results.push({ check: c.source, ok: false });
      continue;
    }
    out.results.push(x.result);
    if (x.result.ok) continue;
    const { severity: _s, code: _c, docs: _d, ...init } = failureProblem(ctx.asset, o.file, x, identity);
    out.problems.push({
      ...problem("CHECK_FAILED", {
        ...init,
        message: `warning ${init.message}`,
        hint: `a warning does not block the write; correct the data${o.file ? `, or the warning in ${o.file}` : ""}, if the rows are wrong`,
      }),
      severity: "warning",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Evaluating one check

interface Target { asset: string; table: string; loadedAt: string; file?: string }
interface Counts { batch: number; total: number }

const STAMP = quoteIdent("_loaded_at");
const stampLiteral = (loadedAt: string) => `${quoteLiteral(loadedAt)}::TIMESTAMPTZ`;
const num = (v: unknown) => Number(v ?? 0);

function isNew(c: Check, previous: readonly string[] | null | undefined): boolean {
  if (!previous) return true;
  const src = c.source.trim();
  return !previous.some((p) => p.trim() === src);
}

async function scopeCounts(sql: Sql, table: string, loadedAt: string): Promise<Counts> {
  const [r] = await sql.all<{ batch: unknown; total: unknown }>(
    `SELECT count(*) FILTER (WHERE ${STAMP} = ${stampLiteral(loadedAt)}) AS batch, count(*) AS total FROM ${table}`);
  return { batch: num(r?.batch), total: num(r?.total) };
}

async function evaluate(sql: Sql, t: Target, c: Check, whole: boolean, counts: Counts): Promise<Outcome> {
  const checked = whole ? counts.total : counts.batch;
  const widened = whole && c.scope === "batch" && counts.total > counts.batch;
  const ok = (extra: Partial<Outcome> = {}): Outcome => ({ check: c, result: { check: c.source, ok: true, failing: 0 }, checked, whole, widened, ...extra });
  const scope = whole ? "" : `${STAMP} = ${stampLiteral(t.loadedAt)} AND `;
  try {
    if (c.kind === "min_rows") {
      const n = minRowsOf(c);
      if (n === null) throw invalid(t, c, "needs a whole number of rows");
      if (counts.total >= n) return ok({ groups: counts.total });
      return { check: c, result: { check: c.source, ok: false, failing: n - counts.total, sample: [] }, checked: counts.total, whole: true, groups: counts.total };
    }
    if (checked === 0) return ok();
    if (c.kind === "unique") {
      const cols = checkColumns(c);
      if (!cols) throw invalid(t, c, "names no columns croft can read");
      const list = cols.map(quoteIdent).join(", ");
      const set = cols.map((k) => `${quoteIdent(k)} IS NOT NULL`).join(" AND ");
      const [r] = await sql.all<{ groups: unknown; n: unknown }>(
        `SELECT count(*) AS groups, coalesce(sum(n), 0) AS n FROM (SELECT count(*) AS n FROM ${t.table} WHERE ${set} GROUP BY ${list} HAVING count(*) > 1)`);
      const failing = num(r?.n);
      if (failing === 0) return ok();
      const sample = await sampleRows(sql,
        `SELECT * EXCLUDE (${STAMP}) FROM ${t.table} WHERE ${set} QUALIFY count(*) OVER (PARTITION BY ${list}) > 1 ORDER BY ${list} LIMIT ${SAMPLE_ROWS}`);
      return { check: c, result: { check: c.source, ok: false, failing, sample }, checked: counts.total, whole: true, groups: num(r?.groups) };
    }
    let fails: string;
    if (c.kind === "not_null") {
      const cols = checkColumns(c);
      if (!cols) throw invalid(t, c, "names no columns croft can read");
      fails = `(${cols.map((k) => `${quoteIdent(k)} IS NULL`).join(" OR ")})`;
    } else if (c.kind === "rule") {
      const v = await vetCheck((text) => serializeOn(sql, text), t.asset, c);
      if (!v.ok) throw invalid(t, c, v.why, v.hint);
      // NULL passes: NOT (NULL) is NULL, which WHERE drops.
      fails = `NOT (\n${c.sql}\n)`;
    } else {
      throw invalid(t, c, `has an unknown kind ${JSON.stringify((c as Check).kind)}`);
    }
    const [r] = await sql.all<{ n: unknown }>(`SELECT count(*) AS n FROM ${t.table} WHERE ${scope}${fails}`);
    const failing = num(r?.n);
    if (failing === 0) return ok();
    const sample = await sampleRows(sql, `SELECT * EXCLUDE (${STAMP}) FROM ${t.table} WHERE ${scope}${fails} LIMIT ${SAMPLE_ROWS}`);
    return { check: c, result: { check: c.source, ok: false, failing, sample }, checked, whole, widened };
  } catch (e) {
    throw asCheckError(e, t, c);
  }
}

async function serializeOn(sql: Sql, text: string): Promise<string> {
  const [r] = await sql.all<{ j: unknown }>("SELECT json_serialize_sql($1::VARCHAR)::VARCHAR AS j", [text]);
  return String(r?.j ?? "{}");
}

function invalid(t: Target, c: Check, why: string, hint?: string, fix?: { from: string; to: string }): CroftError {
  const label = c.blocking ? "check" : "warning";
  return new CroftError("CHECK_INVALID", {
    asset: t.asset, file: t.file,
    message: `${t.asset}: the ${label} ${JSON.stringify(c.source)} ${why}`,
    hint: hint ?? `correct the ${label}${t.file ? ` in ${t.file}` : ""}`,
    ...(fix && t.file ? { fix: { kind: "edit" as const, description: `replace ${fix.from} with ${fix.to}`, file: t.file, replace: fix } } : {}),
    details: { check: c.source, blocking: c.blocking },
  });
}

// DuckDB errors that are the check's fault (it does not bind, or cannot run on this data). Interrupts, I/O,
// memory and internal errors are not, and pass through unchanged.
const CHECK_FAULTS = /^(Binder|Parser|Syntax|Catalog|Conversion|Invalid Input|Invalid|Not implemented|Out of Range|Mismatch Type|Invalid type|Divide by Zero|Parameter Not Resolved|Parameter Not Allowed|Permission|Expression) Error: /;

/** A DuckDB error raised while a check ran, as CHECK_INVALID (with a did-you-mean edit for an unknown column);
 *  anything else unchanged. */
function asCheckError(e: unknown, t: Target, c: Check): unknown {
  if (e instanceof CroftError) {
    if (e.code === "CHECK_INVALID") return e;
    if (e.code === "SQL_NOT_ONE_STATEMENT") return invalid(t, c, "is not one expression");
    return e;
  }
  if (!(e instanceof Error)) return e;
  const lines = e.message.split("\n");
  const first = lines[0]!.replace(/^Failed to bind value: /, "");
  if (!CHECK_FAULTS.test(first)) return e;
  const said = first.replace(/^[A-Za-z ]+ Error: /, "");
  const unknown = said.match(/Referenced column "?(.+?)"? not found/)?.[1];
  const candidates = lines.find((l) => l.startsWith("Candidate bindings:"));
  const guess = candidates?.match(/"([^"]+)"/)?.[1]?.split(".").pop();
  const fix = unknown && guess && mentions(c, unknown) ? { from: unknown, to: guess } : undefined;
  const why = `could not run: ${said}${guess ? ` (did you mean ${guess}?)` : ""}`;
  return invalid(t, c, why, undefined, fix);
}

/** Whether the check's own text names `column` (so an edit can replace it there). */
function mentions(c: Check, column: string): boolean {
  const toks = tokenize(c.source);
  return !("error" in toks) && toks.tokens.some((x) => x.kind === "ident" && x.name === column);
}

// ---------------------------------------------------------------------------------------------------------
// CHECK_FAILED

function checkFailed(ctx: CheckContext, file: string, failed: Outcome[], results: CheckResult[], identity: string[]): CroftError {
  const first = failed[0]!;
  const { severity: _s, code: _c, docs: _d, ...init } = failureProblem(ctx.asset, file, first, identity);
  const also = failed.slice(1).map((x) => `also failing: ${summary(x)}`);
  const before = ctx.rows.total - ctx.rows.added + ctx.rows.deleted;
  return new CroftError("CHECK_FAILED", {
    ...init,
    message: [init.message, ...also].join("\n"),
    effect: before > 0 ? `nothing was written; ${ctx.asset} keeps its previous ${count(before)} row${before === 1 ? "" : "s"}` : "nothing was written",
    details: { ...init.details, results },
  });
}

/** The problem for one failing check (CHECK_FAILED's fields; warnings reuse them). */
function failureProblem(asset: string, file: string | undefined, x: Outcome, identity: string[]): Problem {
  const sample = x.result.sample ?? [];
  const focus = [...identity, ...focusColumns(x.check, sample[0])];
  const lines = sample.slice(0, RENDERED_ROWS).map((r) => `  ${renderRow(r, focus)}`);
  const fix = `correct ${file ?? `the asset ${asset}`} or the data, then: croft run ${asset}`;
  return problem("CHECK_FAILED", {
    asset, file,
    message: [summary(x), ...lines].join("\n"),
    hint: fix,
    fix: { kind: "manual", description: fix },
    retryable: false,
    details: { check: x.check.source, failing: x.result.failing ?? 0, sample, checked: x.checked, scope: x.whole ? "table" : "batch" },
  });
}

const count = (n: number) => n.toLocaleString("en-US");

/** "not_null(author): 3 of 4,211 rows", with the scope when a new check widened it. */
function summary(x: Outcome): string {
  const failing = x.result.failing ?? 0;
  if (x.check.kind === "min_rows") return `${x.check.source}: the table has ${count(x.groups ?? 0)} row${x.groups === 1 ? "" : "s"}`;
  const widened = x.widened ? " (the whole table: a new or edited check)" : "";
  if (x.check.kind === "unique") {
    const values = x.groups ?? 0;
    return `${x.check.source}: ${count(values)} value${values === 1 ? "" : "s"} appear${values === 1 ? "s" : ""} more than once (${count(failing)} of ${count(x.checked)} rows)`;
  }
  return `${x.check.source}: ${count(failing)} of ${count(x.checked)} row${x.checked === 1 ? "" : "s"}${widened}`;
}

// ---------------------------------------------------------------------------------------------------------
// Samples

const MAX_TEXT = 200;
const SHOWN_TEXT = 24;
const LINE_WIDTH = 96;

/** The rows of `select`, a sample query, as a sample shows them: safe for JSON (plainRow), instants in the project
 *  zone (instantsInZone). */
async function sampleRows(sql: Sql, select: string): Promise<Row[]> {
  const rows = await sql.all<Row>(select);
  return (await instantsInZone(sql, select, rows)).map(plainRow);
}

/**
 * `rows`, read by `select` on `sql`, with each TIMESTAMPTZ as JSON shows it: in the project zone with its offset,
 * as `croft query` does, so it agrees with ::DATE (§4 Conventions). A lease reads a TIMESTAMPTZ as UTC with Z
 * (its "ts" mode). The columns are the ones `select` returns as TIMESTAMPTZ (DESCRIBE, which only binds it), so text
 * that looks like an instant is never touched; the zone is DuckDB's session TimeZone, the project's
 * (db/connect.ts). Top-level columns only. For any sample of rows a problem carries (load/write.ts has one too).
 */
export async function instantsInZone(sql: Sql, select: string, rows: Row[]): Promise<Row[]> {
  if (!rows.length) return rows;
  let z: { tz: unknown; cols: unknown } | undefined;
  try {
    [z] = await sql.all<{ tz: unknown; cols: unknown }>(
      `SELECT current_setting('TimeZone') AS tz, list(column_name) FILTER (WHERE column_type = 'TIMESTAMP WITH TIME ZONE') AS cols
       FROM (DESCRIBE ${select})`);
  } catch {
    return rows;   // `select` just ran, so its DESCRIBE binds; should it not, the sample keeps UTC rather than fail
  }
  const zoned = Array.isArray(z?.cols) ? z.cols.map(String) : [];
  if (!zoned.length) return rows;
  const tz = typeof z?.tz === "string" && z.tz ? z.tz : "UTC";
  const inZone = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    try {
      return formatInstant(v, tz);
    } catch {
      return v;   // "infinity", "-infinity"
    }
  };
  return rows.map((r) => {
    const out: Row = { ...r };
    for (const k of zoned) if (Object.hasOwn(out, k)) out[k] = inZone(out[k]);
    return out;
  });
}

/** A sample row safe for JSON: bigints as numbers when exact (else their digits), long strings cut. */
function plainRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = plainValue(v);
  return out;
}

function plainValue(v: unknown): unknown {
  if (typeof v === "bigint") return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (typeof v === "string") return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  if (Array.isArray(v)) return v.map(plainValue);
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = plainValue(x);
    return o;
  }
  return v;
}

/** The key-like columns rows are shown by: those of the first unique check (a key's implied one comes first). */
function identityColumns(checks: readonly Check[]): string[] {
  const u = checks.find((c) => c.kind === "unique");
  return u ? checkColumns(u) ?? [] : [];
}

/** Columns a check names: unique/not_null's list, or the row's columns a rule mentions. */
function focusColumns(c: Check, row: Row | undefined): string[] {
  if (c.kind === "unique" || c.kind === "not_null") return checkColumns(c) ?? [];
  if (c.kind !== "rule" || !row) return [];
  const toks = tokenize(c.sql);
  if ("error" in toks) return [];
  const cols = Object.keys(row);
  const out: string[] = [];
  for (const x of toks.tokens) {
    if (x.kind !== "ident") continue;
    const hit = cols.find((k) => (x.quoted ? k === x.name : k.toLowerCase() === x.name.toLowerCase()));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** One sample row on one line, `id=2291  title="Crash on Windows when …"  author=NULL`: the focus columns always,
 *  then the others in table order while the line has room, shown in table order. */
export function renderRow(row: Row, focus: readonly string[] = []): string {
  const cols = Object.keys(row);
  const lowerFocus = focus.map((f) => f.toLowerCase());
  const isFocus = (k: string) => lowerFocus.includes(k.toLowerCase());
  const part = (k: string) => `${k}=${renderValue(row[k])}`;
  const chosen = new Set(cols.filter(isFocus));
  let width = [...chosen].reduce((w, k) => w + part(k).length + 2, 0);
  for (const k of cols) {
    if (chosen.has(k)) continue;
    const w = part(k).length + 2;
    if (width + w > LINE_WIDTH) continue;
    chosen.add(k);
    width += w;
  }
  return cols.filter((k) => chosen.has(k)).map(part).join("  ");
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  // Dates and instants are shown whole; other text is cut.
  if (typeof v === "string") return JSON.stringify(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-][\d:]+)?)?$/.test(v) ? v : cut(v));
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  return cut(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v));
}

function cut(s: string): string {
  const chars = Array.from(s);
  return chars.length > SHOWN_TEXT ? `${chars.slice(0, SHOWN_TEXT - 1).join("")}…` : s;
}

// A lake's maintenance (DESIGN.md D149 to D152; option 07, slice 3): the steps DuckLake needs to stay small, run one at a time by
// croft, under croft's lock on the lake's writes, and never deleting a version the trash promises to keep.
//
// What DuckLake does not do by itself: it never deletes an old data file until a snapshot expiry and a cleanup say so, it keeps the
// rows of small inserts inside the catalog, and every commit is a snapshot. A simulated week of hourly runs over five assets left 849
// snapshots, 841 files, 176 inlined-data tables and a 12 MB catalog (the lake spike); one pass of the steps below took about 1.6 s.
//
// croft never calls CHECKPOINT on a lake and never sets an expiry option on it (a test reads the source for both). CHECKPOINT runs all of
// DuckLake's maintenance from the lake's stored options, so an age-based expiry set by anyone expires a snapshot the trash pinned (the
// follow-up spike recorded in option 07, item 1 of "What the follow-ups settled"), and it deletes any file in the data folder the lake does not
// own. Each step is run by name instead, in this order:
//   0. prune    croft's own bookkeeping log loses the rows a newer row of the same key has superseded (D154);
//   1. flush    the rows DuckLake held inside the catalog become files;
//   2. expire   the snapshots outside the promise, by an explicit list of ids croft computes (planExpiry);
//   3. merge    small files become fewer, larger ones (time travel is kept: the merged file remembers each row's snapshot);
//   4. rewrite  files dominated by deleted rows are rewritten;
//   5. cleanup  the files nothing refers to are deleted at once (`cleanup_all`; DuckLake waits 2 days by default).
// Deleting files that are not the lake's own (`orphans`) is a step of its own, never part of a pass: a person confirms the list first.
//
// The promise (safety/trash.ts TRASH_RETENTION): every version is kept for 30 days, and each asset's 5 newest versions however old. A
// version of an asset is a snapshot in which its table changed. So a snapshot is kept when it is in the last 30 days, or is the newest
// before them (the state at the start of the window), or is among the 5 newest versions of any asset, or is one the trash pins (the
// snapshot a trashed version was taken from), or is the newest snapshot. Everything else is expired.
import type { Sql } from "../core/types.ts";
import { TRASH_RETENTION } from "../safety/trash.ts";
import { ASSET_TABLES, kindOfObjects, STATE_SPECS, stateObjects } from "./bookkeeping.ts";
import { isConnectionError } from "./lake.ts";
import { LAKE_ALIAS } from "./modes.ts";

/** The name DuckLake gives the catalog's own tables once the lake is attached (`__ducklake_metadata_<alias>`). */
export const METADATA_ALIAS = `__ducklake_metadata_${LAKE_ALIAS}`;

const DAY_MS = 86_400_000;
/** The margin on the edge of the 30 days: croft's clock and the catalog's (a Postgres on another machine stamps the snapshots) may differ, and
 *  the promise is "30 days", so a snapshot a clock's skew away from the edge stays. */
export const WINDOW_SKEW_MS = 3_600_000;

// ---- The plan: which snapshots the promise lets go ---------------------------------------------------------------

/** A snapshot of the lake: its id, its time (epoch milliseconds), and what it changed (`ducklake_snapshots()`'s `changes`, as JSON). */
export interface SnapshotInfo { id: number; ms: number; changes: string }
/** A table of the lake, as the catalog names it (including tables dropped since). */
export interface LakeTable { id: number; schema: string; name: string }

/** The kinds of change that leave a table as it was. They are not versions of it (and not worth a place among its 5 newest). */
const NOT_A_VERSION = /^(?:schemas_|views_|tables_dropped$|flushed_inlined$|merge_adjacent$|compacted|rewrite|partial_)/;

/** `ducklake_snapshots()`'s `changes` as it comes from `to_json`: an object of change kinds, each with the ids or names it touched. */
export function parseChanges(json: string | null | undefined): Record<string, string[]> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v)) {
      // A list of {key, value} pairs, the other way DuckDB prints a MAP.
      return Object.fromEntries(v.flatMap((e) => (e && typeof e === "object" && typeof (e as { key?: unknown }).key === "string"
        ? [[(e as { key: string }).key, ((e as { value?: unknown[] }).value ?? []).map(String)] as const] : [])));
    }
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, Array.isArray(x) ? x.map(String) : []]));
  } catch {
    return {};
  }
}

/**
 * The tables of the schema `main` (croft's assets) that a snapshot changed, by name: a table created, written to, deleted from or altered. A
 * drop is not a change of the table's contents. A table is named by its id in most kinds of change and by "schema.name" in the one that
 * creates it. An id the catalog no longer names (its table and every snapshot that saw it are gone) is no asset of the lake's.
 */
export function assetsChanged(changes: Record<string, string[]>, tables: ReadonlyMap<number, LakeTable>): string[] {
  const out = new Set<string>();
  for (const [kind, values] of Object.entries(changes)) {
    if (NOT_A_VERSION.test(kind)) continue;
    for (const v of values) {
      if (kind === "tables_created") {
        const dot = v.indexOf(".");
        if (dot > 0 && v.slice(0, dot) === "main") out.add(v.slice(dot + 1));
        continue;
      }
      const id = Number(v);
      const t = Number.isInteger(id) ? tables.get(id) : undefined;
      if (t && t.schema === "main") out.add(t.name);
    }
  }
  return [...out];
}

export interface ExpiryPlan {
  /** The snapshots to expire, oldest first. */
  expire: number[];
  /** How many snapshots the lake has, and how many stay. */
  total: number;
  kept: number;
  /** Why the kept ones stay (a snapshot can have several reasons): the last 30 days, the state at their start, an asset's newest
   *  versions, a snapshot the trash pins, the newest snapshot. */
  because: { window: number; windowStart: number; versions: number; pinned: number; latest: number };
  /** The assets that have versions, and how many versions each keeps. */
  assets: Record<string, number>;
}

export interface PlanInput {
  /** The time the promise is measured from (CROFT_NOW-aware). */
  now: Date;
  /** Snapshots the trash pins (safety/trash.ts: the snapshot each trashed version was taken from). */
  pins?: readonly number[];
  days?: number;
  versions?: number;
}

/**
 * Which snapshots the promise lets go. Pure: the lake's snapshots (`ducklake_snapshots()`), the lake's tables, the trash's pins and the
 * time, nothing else, so the promise is tested with literal rows.
 */
export function planExpiry(snapshots: readonly SnapshotInfo[], tables: readonly LakeTable[], o: PlanInput): ExpiryPlan {
  const days = o.days ?? TRASH_RETENTION.days;
  const perAsset = o.versions ?? TRASH_RETENTION.versions;
  const byId = new Map(tables.map((t) => [t.id, t]));
  const sorted = [...snapshots].sort((a, b) => a.id - b.id);
  const cutoff = o.now.getTime() - days * DAY_MS - WINDOW_SKEW_MS;
  const keep = new Map<number, Set<"window" | "windowStart" | "versions" | "pinned" | "latest">>();
  const mark = (id: number, why: "window" | "windowStart" | "versions" | "pinned" | "latest") => {
    const s = keep.get(id) ?? new Set();
    s.add(why);
    keep.set(id, s);
  };
  const latest = sorted[sorted.length - 1];
  if (latest) mark(latest.id, "latest");
  let before: SnapshotInfo | undefined;
  for (const s of sorted) {
    if (s.ms >= cutoff) mark(s.id, "window");
    else before = s;
  }
  // The newest snapshot before the window is the state of every table when the window began: time travel to "30 days ago" lands on it.
  if (before) mark(before.id, "windowStart");
  const versionsOf = new Map<string, number[]>();
  for (const s of sorted) {
    for (const a of assetsChanged(parseChanges(s.changes), byId)) versionsOf.set(a, [...(versionsOf.get(a) ?? []), s.id]);
  }
  const assets: Record<string, number> = {};
  for (const [asset, ids] of versionsOf) {
    const newest = ids.slice(-perAsset);
    assets[asset] = newest.length;
    for (const id of newest) mark(id, "versions");
  }
  const present = new Set(sorted.map((s) => s.id));
  for (const id of o.pins ?? []) if (present.has(id)) mark(id, "pinned");
  const count = (why: "window" | "windowStart" | "versions" | "pinned" | "latest") => [...keep.values()].filter((s) => s.has(why)).length;
  return {
    expire: sorted.filter((s) => !keep.has(s.id)).map((s) => s.id),
    total: sorted.length,
    kept: keep.size,
    because: { window: count("window"), windowStart: count("windowStart"), versions: count("versions"), pinned: count("pinned"), latest: count("latest") },
    assets,
  };
}

// ---- Reading the lake ---------------------------------------------------------------------------------------------

/** What the catalog holds, for `croft doctor`, `croft status` and a pass's before and after. */
export interface LakeStats {
  /** Snapshots the catalog holds. */
  snapshots: number;
  /** Data files the catalog tracks (including those no snapshot reads any more, until a cleanup), and those a current table reads. */
  dataFiles: number;
  liveFiles: number;
  /** The bytes of the live data files. */
  liveBytes: number;
  deleteFiles: number;
  /** The tables DuckLake made to hold the rows of small inserts inside the catalog. */
  inlinedTables: number;
  /** Files freed and waiting for a cleanup to delete them. */
  pendingDeletion: number;
  /** The oldest and newest snapshot's time (ISO), or null for a lake with none. */
  oldestSnapshotAt: string | null;
  newestSnapshotAt: string | null;
}

const M = METADATA_ALIAS;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** The lake's counts, read through the catalog's own tables (the writer's or the read-only login both read them). */
export async function lakeStats(sql: Sql): Promise<LakeStats> {
  const [r] = await sql.all<Record<string, unknown>>(`SELECT
    (SELECT count(*) FROM ${M}.ducklake_snapshot) AS snapshots,
    (SELECT count(*) FROM ${M}.ducklake_data_file) AS data_files,
    (SELECT count(*) FROM ${M}.ducklake_data_file WHERE end_snapshot IS NULL) AS live_files,
    (SELECT coalesce(sum(file_size_bytes), 0) FROM ${M}.ducklake_data_file WHERE end_snapshot IS NULL) AS live_bytes,
    (SELECT count(*) FROM ${M}.ducklake_delete_file) AS delete_files,
    (SELECT count(*) FROM ${M}.ducklake_inlined_data_tables) AS inlined_tables,
    (SELECT count(*) FROM ${M}.ducklake_files_scheduled_for_deletion) AS pending,
    (SELECT min(snapshot_time)::TIMESTAMPTZ::VARCHAR FROM ducklake_snapshots('${LAKE_ALIAS}')) AS oldest,
    (SELECT max(snapshot_time)::TIMESTAMPTZ::VARCHAR FROM ducklake_snapshots('${LAKE_ALIAS}')) AS newest`);
  const iso = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? v : new Date(t).toISOString();
  };
  return {
    snapshots: num(r?.snapshots), dataFiles: num(r?.data_files), liveFiles: num(r?.live_files), liveBytes: num(r?.live_bytes),
    deleteFiles: num(r?.delete_files), inlinedTables: num(r?.inlined_tables), pendingDeletion: num(r?.pending),
    oldestSnapshotAt: iso(r?.oldest), newestSnapshotAt: iso(r?.newest),
  };
}

/**
 * The name each table id goes by. A table that was renamed has a row of `ducklake_table` for each name it had, under one id, and the table is
 * the asset of the name it has now: the row that begins last wins. (A `CREATE OR REPLACE` or a new table of an old name has an id of its own.)
 */
export function tablesByLatestName(rows: readonly (LakeTable & { begin: number })[]): LakeTable[] {
  const byId = new Map<number, LakeTable & { begin: number }>();
  for (const r of rows) {
    const seen = byId.get(r.id);
    if (!seen || r.begin >= seen.begin) byId.set(r.id, r);
  }
  return [...byId.values()].map(({ id, schema, name }) => ({ id, schema, name }));
}

/** The lake's snapshots and tables, as planExpiry reads them. */
export async function readPlanInput(sql: Sql): Promise<{ snapshots: SnapshotInfo[]; tables: LakeTable[] }> {
  const snaps = await sql.all<{ id: unknown; ms: unknown; changes: unknown }>(
    `SELECT snapshot_id AS id, epoch_ms(snapshot_time::TIMESTAMPTZ) AS ms, to_json(changes)::VARCHAR AS changes FROM ducklake_snapshots('${LAKE_ALIAS}') ORDER BY snapshot_id`);
  const tables = await sql.all<{ id: unknown; name: unknown; schema: unknown; begin: unknown }>(
    `SELECT t.table_id AS id, t.table_name AS name, s.schema_name AS schema, t.begin_snapshot AS begin
     FROM ${M}.ducklake_table t JOIN ${M}.ducklake_schema s ON s.schema_id = t.schema_id`);
  return {
    snapshots: snaps.map((s) => ({ id: num(s.id), ms: num(s.ms), changes: typeof s.changes === "string" ? s.changes : "" })),
    tables: tablesByLatestName(tables.map((t) => ({ id: num(t.id), name: String(t.name), schema: String(t.schema), begin: num(t.begin) }))),
  };
}

// ---- croft's bookkeeping log ----------------------------------------------------------------------------------------

/**
 * The statement that selects the rows of a bookkeeping log a pass may delete: every row a strictly newer row of its key has superseded, and
 * every row of a key whose newest rows are all closing rows (the view over the log shows neither). "Newest" is the view's own order, `seq`
 * descending with NULL last; the view breaks a tie by the row id (a log made before that was added breaks it as DuckDB happens to), and
 * croft never writes two rows of a key with one number, but a row somebody inserted by hand might tie: the rows that tie for newest are all
 * kept, whichever of them the view shows, and a key is removed whole only when every one of them is a closing row.
 */
function supersededRows(t: (typeof ASSET_TABLES)[number]): string {
  const key = STATE_SPECS[t].key.join(", ");
  return `SELECT rowid AS rid FROM (
    SELECT rowid, rk, bool_and(coalesce(closed, false)) FILTER (WHERE rk = 1) OVER (PARTITION BY ${key}) AS dead FROM (
      SELECT rowid, closed, ${key}, rank() OVER (PARTITION BY ${key} ORDER BY seq DESC NULLS LAST) AS rk FROM _croft.${t}_log
    )
  ) WHERE rk > 1 OR dead`;
}

/** Whether the lake's bookkeeping is the log (a lake nobody has written, or a file's tables, has nothing to prune). */
async function hasLog(sql: Sql): Promise<boolean> {
  return kindOfObjects(await stateObjects(sql)) === "log";
}

/** How many rows of croft's bookkeeping log a pass would remove. */
export async function countSuperseded(sql: Sql): Promise<number> {
  if (!(await hasLog(sql))) return 0;
  let n = 0;
  for (const t of ASSET_TABLES) n += num((await sql.all<{ n: unknown }>(`SELECT count(*) AS n FROM (${supersededRows(t)})`))[0]?.n);
  return n;
}

/**
 * Remove the rows of croft's bookkeeping log that nothing reads (D154). Every run appends a row per asset to `_croft.assets_log` and its
 * kin; the view `_croft.<t>` shows the newest row of each key, so a superseded row is read by nothing, yet every read of the view and every
 * numbering of a write scans the whole log, which only grows. Nothing is lost that a person can ask for: the view's rows are the same before
 * and after (a test compares them), the trash holds copies of the view's rows and a restore numbers the rows it puts back above the rest, and
 * the lake's snapshots inside the window still hold the old rows for time travel. The log's `seq` stays ordered: a surviving row of a key is
 * its newest, so a new row, numbered above the highest left, is newer than it; a key whose newest row was a closing row is removed whole, so
 * no older row of it is left to come back; and a log emptied that way numbers from 1 with no row of any key before it. One DELETE per log,
 * each atomic by itself; the pass holds croft's lock, so no croft write runs meanwhile.
 */
export async function pruneBookkeeping(sql: Sql): Promise<{ tables: number; rows: number }> {
  if (!(await hasLog(sql))) return { tables: 0, rows: 0 };
  let rows = 0;
  let tables = 0;
  for (const t of ASSET_TABLES) {
    const done = await sql.all<{ Count: unknown }>(`DELETE FROM _croft.${t}_log WHERE rowid IN (${supersededRows(t)})`);
    const n = num(done[0]?.Count);
    if (n > 0) tables++;
    rows += n;
  }
  return { tables, rows };
}

/** Options another tool stored on the lake that would make a CHECKPOINT expire what the trash promises: an expiry by age. */
export interface ExpiryOption { name: string; value: string }
export async function ageBasedExpiryOptions(sql: Sql): Promise<ExpiryOption[]> {
  const rows = await sql.all<{ option_name: string; value: string }>(`SELECT option_name, value FROM ducklake_options('${LAKE_ALIAS}')`);
  return rows.filter((r) => r.option_name === "expire_older_than").map((r) => ({ name: r.option_name, value: String(r.value) }));
}

// ---- Retrying a step ----------------------------------------------------------------------------------------------

/**
 * A failure worth trying again: the catalog's connection dropped, or the store answered with a server error or asked to slow down. R2
 * answered HTTP 500 to three bulk deletes in five days on a lake that was in use, and a retry succeeded. A refused login or key, a missing
 * file the catalog names and a bad request are not transient: they would fail the same way.
 */
export function isTransientStorage(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  // DuckDB's httpfs says "HTTP Error: Request returned HTTP 500 for HTTP POST to '<url>'" [V: 2.0.0, the test store].
  if (/\bHTTP (?:429|5\d\d)\b|SlowDown|InternalError|ServiceUnavailable|RequestTimeout|Please try again/i.test(text)) return true;
  if (/timed? ?out|timeout|connection (?:reset|closed|refused)|temporarily unavailable|broken pipe|EOF/i.test(text) && !/denied|forbidden|invalid access|signature/i.test(text)) return true;
  return isConnectionError(e);
}

export interface RetryPolicy {
  /** How many times a step is tried in all. */
  attempts: number;
  /** The wait after the first failure; it doubles, with jitter. */
  baseMs: number;
  /** For tests: replaces the wait. */
  sleep?: (ms: number) => Promise<void>;
}
export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseMs: 750 };

async function withRetry<T>(policy: RetryPolicy, fn: (attempt: number) => Promise<T>): Promise<{ value: T; attempts: number }> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (e) {
      if (attempt >= policy.attempts || !isTransientStorage(e)) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { attempts: attempt });
      const base = policy.baseMs * 2 ** (attempt - 1);
      await sleep(Math.round(base / 2 + Math.random() * (base / 2)));
    }
  }
}

// ---- The pass -----------------------------------------------------------------------------------------------------

export type StepName = "prune" | "flush" | "expire" | "merge" | "rewrite" | "cleanup";
export const STEPS: readonly StepName[] = ["prune", "flush", "expire", "merge", "rewrite", "cleanup"];

export interface StepReport {
  step: StepName;
  /** "ok", "failed" (after its retries), or "skipped" (an earlier step failed). */
  status: "ok" | "failed" | "skipped";
  tookMs: number;
  /** How many times it was tried. */
  attempts: number;
  /** What it did: rows flushed, snapshots expired, files merged / rewritten / deleted. */
  did: Record<string, number>;
  /** The error that ended a failed step, redacted by the caller. */
  error?: string;
}

export interface PassReport {
  startedAt: string;
  tookMs: number;
  ok: boolean;
  steps: StepReport[];
  before: LakeStats;
  after: LakeStats;
  /** What the promise kept, and what it let go. */
  plan: Omit<ExpiryPlan, "expire"> & { expired: number };
}

export interface PassOptions {
  now: Date;
  pins?: readonly number[];
  retry?: RetryPolicy;
  /** Called as each step starts (progress for a person waiting). */
  onStep?: (step: StepName) => void | Promise<void>;
  /** Chunk size of the expiry's list of ids. */
  expireChunk?: number;
}

/**
 * Run the steps of a pass on a writer's connection. The caller holds croft's lock on the lake's writes for the whole pass
 * (warehouse.write with `transaction: false`), so no write of this machine runs meanwhile. A step that still fails after its retries ends
 * the pass: the steps after it are `skipped`, the lake is as the step left it (every step is safe to run again, and none is half done in
 * a way the next pass cannot finish), and the pass is reported as not ok. Throws nothing a step threw: the report says it.
 */
export async function runPass(sql: Sql, o: PassOptions): Promise<PassReport> {
  const t0 = performance.now();
  const retry = o.retry ?? DEFAULT_RETRY;
  const before = await lakeStats(sql);
  const steps: StepReport[] = [];
  let failed = false;
  let plan: ExpiryPlan = { expire: [], total: before.snapshots, kept: before.snapshots, because: { window: 0, windowStart: 0, versions: 0, pinned: 0, latest: 0 }, assets: {} };
  let expired = 0;
  const step = async (name: StepName, fn: (attempt: number) => Promise<Record<string, number>>): Promise<void> => {
    if (failed) {
      steps.push({ step: name, status: "skipped", tookMs: 0, attempts: 0, did: {} });
      return;
    }
    await o.onStep?.(name);
    const s0 = performance.now();
    try {
      const { value, attempts } = await withRetry(retry, fn);
      steps.push({ step: name, status: "ok", tookMs: Math.round(performance.now() - s0), attempts, did: value });
    } catch (e) {
      failed = true;
      steps.push({
        step: name, status: "failed", tookMs: Math.round(performance.now() - s0), attempts: (e as { attempts?: number }).attempts ?? 1, did: {},
        error: ((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "").slice(0, 400),
      });
    }
  };
  await step("prune", async () => pruneBookkeeping(sql));
  await step("flush", async () => {
    const rows = await sql.all<{ rows_flushed: unknown }>(`CALL ducklake_flush_inlined_data('${LAKE_ALIAS}')`);
    return { tables: rows.length, rows: rows.reduce((n, r) => n + num(r.rows_flushed), 0) };
  });
  await step("expire", async () => {
    // Planned again on every try: a try that failed halfway may have expired some, and the list must name snapshots that exist.
    const { snapshots, tables } = await readPlanInput(sql);
    plan = planExpiry(snapshots, tables, { now: o.now, ...(o.pins ? { pins: o.pins } : {}) });
    let n = 0;
    const chunk = o.expireChunk ?? 2000;
    for (let i = 0; i < plan.expire.length; i += chunk) {
      const ids = plan.expire.slice(i, i + chunk);
      n += (await sql.all(`CALL ducklake_expire_snapshots('${LAKE_ALIAS}', versions => [${ids.join(", ")}])`)).length;
    }
    expired = n;
    return { snapshots: n };
  });
  await step("merge", async () => {
    const rows = await sql.all<{ files_processed: unknown; files_created: unknown }>(`CALL ducklake_merge_adjacent_files('${LAKE_ALIAS}')`);
    return { tables: rows.length, merged: rows.reduce((n, r) => n + num(r.files_processed), 0), created: rows.reduce((n, r) => n + num(r.files_created), 0) };
  });
  await step("rewrite", async () => {
    const rows = await sql.all(`CALL ducklake_rewrite_data_files('${LAKE_ALIAS}')`);
    return { tables: rows.length };
  });
  await step("cleanup", async () => {
    // cleanup_all: the files nothing refers to go now, not after DuckLake's delay of 2 days. A bulk delete the store refuses leaves the
    // files listed as freed, and the next try (this one's, or the next pass's) deletes them.
    const rows = await sql.all(`CALL ducklake_cleanup_old_files('${LAKE_ALIAS}', cleanup_all => true)`);
    return { files: rows.length };
  });
  let after = before;
  try {
    after = await lakeStats(sql);
  } catch {
    // The counts are for the report; a pass that did its work is not undone by failing to count.
  }
  return {
    startedAt: new Date(Date.now() - Math.round(performance.now() - t0)).toISOString(),
    tookMs: Math.round(performance.now() - t0),
    ok: !failed,
    steps,
    before,
    after,
    plan: { total: plan.total, kept: plan.kept, because: plan.because, assets: plan.assets, expired },
  };
}

// ---- Files that are not the lake's own -----------------------------------------------------------------------------

/** How old a stray file must be to be listed: a write in flight on a machine that is not this one has made files its commit has not yet
 *  named, and a day is longer than any write. */
export const ORPHAN_MIN_AGE_MS = DAY_MS;

/** The instant a stray file must be older than to be listed, fixed when the list is made (to the second) and carried by the confirmation
 *  that deletes them, so the delete is for the files that were shown. */
export function orphanCutoff(now: Date): Date {
  return new Date(Math.floor((now.getTime() - ORPHAN_MIN_AGE_MS) / 1000) * 1000);
}

export interface Orphans { files: string[] }

const olderThan = (cutoff: Date): string => `'${cutoff.toISOString()}'::TIMESTAMPTZ`;

/** The files in the lake's folder that the catalog does not name and that are older than `cutoff`, without deleting any (a dry run). */
export async function listOrphans(sql: Sql, cutoff: Date, retry: RetryPolicy = DEFAULT_RETRY): Promise<Orphans> {
  const { value } = await withRetry(retry, () => sql.all<{ path: string }>(
    `CALL ducklake_delete_orphaned_files('${LAKE_ALIAS}', dry_run => true, older_than => ${olderThan(cutoff)})`));
  return { files: value.map((r) => String(r.path)).sort() };
}

/** Delete those files. The caller has shown the list from listOrphans() with this `cutoff` and been told yes; this deletes nothing when the
 *  files found now, with the same cutoff, are not exactly that list (returns null). */
export async function deleteOrphans(sql: Sql, shown: readonly string[], cutoff: Date, retry: RetryPolicy = DEFAULT_RETRY): Promise<Orphans | null> {
  const now = await listOrphans(sql, cutoff, retry);
  if (now.files.length !== shown.length || now.files.some((f, i) => f !== shown[i])) return null;
  const { value } = await withRetry(retry, () => sql.all<{ path: string }>(
    `CALL ducklake_delete_orphaned_files('${LAKE_ALIAS}', older_than => ${olderThan(cutoff)})`));
  return { files: value.map((r) => String(r.path)).sort() };
}

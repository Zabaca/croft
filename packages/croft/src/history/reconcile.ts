// reconcile() (DESIGN.md §5 "Crash recovery"). Every command that writes, and every tick, starts
// here. Runs whose process died become `crashed`; DuckDB, which is authoritative, says which of
// their steps committed before the crash; their leases are released; their staging is handed back
// for deletion; write intents of dead processes are deleted. Cursors move only on commit, so a lost
// step is simply extracted again next run.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import { isAlive } from "../core/proc.ts";
import type { Problem, Sql, Warehouse } from "../core/types.ts";
import { purgeDead } from "../db/intent.ts";
import { reclaimDead, release } from "./leases.ts";
import type { RunRecord, RunsDb, StepRecord } from "./runs-db.ts";

export interface ReconcileOptions {
  db: RunsDb;
  warehouse: Warehouse;
  waitMs?: number;   // for the short read lease; default 2 s, since every command pays for it
}
export interface StepRef { runId: string; asset: string; attempt: number }
export interface ReconcileResult {
  crashed: string[];                              // runs newly marked crashed
  recovered: (StepRef & { commits: number })[];   // their commit landed: now `ok (recovered)`
  lost: StepRef[];                                // died before committing: now `crashed`
  unresolved: StepRef[];                          // warehouse unreadable: still running, retried next time
  releasedLeases: string[];
  stagingDirs: string[];                          // existing .croft/staging/<run> folders to delete
  purgedIntents: string[];                        // write-intent files of dead processes, now deleted
  problems: Problem[];
}

interface CommitRow { run_id: string; asset: string; attempt: unknown; loaded_us: unknown; rows_in: unknown; added: unknown; updated: unknown }
interface Commit { commits: number; rowsIn: number; added: number; updated: number }

const DEFAULT_WAIT_MS = 2000;

function runAlive(r: RunRecord): boolean {
  if (r.pid === null || !r.procStart || !r.bootId) return false;
  return isAlive({ pid: r.pid, procStart: r.procStart, bootId: r.bootId });
}

/** lock_holder and lock_waiters record only a PID, so the best check is whether it exists. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";   // exists, owned by someone else
  }
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** The _croft.writes rows of these runs, one per commit. A format-1 table has no attempt column. */
async function writesOf(sql: Sql, runIds: string[]): Promise<CommitRow[]> {
  const [t] = await sql.all<{ n: unknown; attempt: unknown }>(
    `SELECT count(*)::INTEGER AS n, count(*) FILTER (WHERE column_name = 'attempt')::INTEGER AS attempt FROM duckdb_columns()
     WHERE database_name = current_database() AND schema_name = '_croft' AND table_name = 'writes'`,
  );
  if (num(t?.n) === 0) return [];   // no write ever committed to this warehouse
  return sql.all<CommitRow>(
    `SELECT run_id, asset, ${num(t?.attempt) > 0 ? "attempt" : "NULL::INTEGER AS attempt"}, epoch_us(loaded_at) AS loaded_us,
            rows_in, added, updated
     FROM _croft.writes WHERE run_id IN (${runIds.map(() => "?").join(", ")})`,
    runIds,
  );
}

/**
 * The commits a dangling step made, or null when it made none. A step is retried under the same run id,
 * and chunked TS transforms commit several times per step, so a row counts when it carries the step's
 * attempt; a row without one (written before format 2) counts when it was stamped at or after the step
 * started, which excludes the chunks of an earlier attempt. Rows are summed.
 */
function commitOf(rows: CommitRow[], s: StepRecord): Commit | null {
  const startedUs = Date.parse(s.startedAt) * 1000;
  let c: Commit | null = null;
  for (const r of rows) {
    if (r.run_id !== s.runId || r.asset !== s.asset) continue;
    const mine = r.attempt === null || r.attempt === undefined
      ? Number.isNaN(startedUs) || num(r.loaded_us) >= startedUs
      : num(r.attempt) === s.attempt;
    if (!mine) continue;
    c ??= { commits: 0, rowsIn: 0, added: 0, updated: 0 };
    c.commits++;
    c.rowsIn += num(r.rows_in);
    c.added += num(r.added);
    c.updated += num(r.updated);
  }
  return c;
}

function lostProblem(s: StepRecord, run: RunRecord | null): Problem {
  return problem("RUN_CRASHED", {
    message: `the process running ${s.asset} (pid ${run?.pid ?? "?"}) died before its write committed; nothing from this step was saved`,
    hint: `croft run ${s.asset} fetches it again; cursors move only on commit, so no data is skipped`,
    asset: s.asset, runId: s.runId, retryable: true,
    fix: { kind: "command", description: "run the asset again", command: `croft run ${s.asset}` },
  });
}

function asWarning(e: unknown, pending: number): Problem {
  const base = e instanceof CroftError
    ? e.problem
    : problem("INTERNAL_ERROR", { message: String((e as Error)?.message ?? e), hint: "report this with `croft doctor` output" });
  return {
    ...base, severity: "warning",
    message: `could not check which steps of crashed runs committed: ${base.message}`,
    effect: `${pending} step(s) stay marked running until the next command checks again`,
  };
}

export async function reconcile(o: ReconcileOptions): Promise<ReconcileResult> {
  const { db } = o;
  const out: ReconcileResult = { crashed: [], recovered: [], lost: [], unresolved: [], releasedLeases: [], stagingDirs: [], purgedIntents: [], problems: [] };

  // 1. Runs marked running whose process is gone become crashed.
  for (const run of db.runningRuns()) {
    if (!runAlive(run) && db.markCrashed(run.id)) out.crashed.push(run.id);
  }

  // 3 (early). Their leases are released, along with any other lease whose holder died; this
  //    needs no warehouse, so it happens even when DuckDB is busy.
  const released = new Set<string>();
  for (const id of out.crashed) for (const a of release(db, id)) released.add(a);
  for (const l of reclaimDead(db)) released.add(l.asset);
  out.releasedLeases = [...released].sort();
  for (const id of out.crashed) {
    const dir = join(db.stateDir, "staging", id);
    if (existsSync(dir)) out.stagingDirs.push(dir);
  }
  const holder = db.getLockHolder();
  if (holder?.pid != null && ((holder.runId && out.crashed.includes(holder.runId)) || !pidExists(holder.pid))) {
    db.clearLockHolder(holder.pid);
  }
  for (const w of db.listWaiters()) if (!pidExists(w.pid)) db.unregisterWaiter(w.pid);
  // Write intents of dead processes would keep croft serve closed and cost a liveness check on
  // every poll; liveness compares pid, start time and boot id, so a live holder's intent stays.
  // A folder that cannot be cleaned (permissions) is left for the next command, not an error.
  try {
    out.purgedIntents = purgeDead(db.stateDir).map((i) => i.file).sort();
  } catch {}

  // 2. Steps left running by ended runs (these and any a busy warehouse left unresolved before)
  //    are matched against _croft.writes (run id, asset and attempt) under a short read lease.
  const dangling = db.danglingSteps();
  if (dangling.length === 0) return out;
  let writes: CommitRow[];
  try {
    const runIds = [...new Set(dangling.map((s) => s.runId))];
    writes = await o.warehouse.read((sql) => writesOf(sql, runIds), { purpose: "reconcile", waitMs: o.waitMs ?? DEFAULT_WAIT_MS });
  } catch (e) {
    out.unresolved = dangling.map(({ runId, asset, attempt }) => ({ runId, asset, attempt }));
    out.problems.push(asWarning(e, dangling.length));
    return out;
  }
  for (const s of dangling) {
    const ref = { runId: s.runId, asset: s.asset, attempt: s.attempt };
    const c = commitOf(writes, s);
    if (c) {
      const reason = s.reason ? `${s.reason} (recovered)` : "recovered";
      if (db.finishStep(s.runId, s.asset, s.attempt, { status: "ok", reason, rows: { in: c.rowsIn, added: c.added, updated: c.updated } })) {
        out.recovered.push({ ...ref, commits: c.commits });
      }
    } else if (db.finishStep(s.runId, s.asset, s.attempt, { status: "crashed", error: lostProblem(s, db.getRun(s.runId)) })) {
      out.lost.push(ref);
    }
  }
  return out;
}

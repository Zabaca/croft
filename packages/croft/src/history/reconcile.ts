// reconcile() (DESIGN.md §5 "Crash recovery"). Every command that writes, and every tick, starts
// here. Runs whose process died become `crashed`; DuckDB, which is authoritative, says which of
// their steps committed before the crash; their leases are released; their staging is handed back
// for deletion. Cursors move only on commit, so a lost step is simply extracted again next run.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import { isAlive } from "../core/proc.ts";
import type { Problem, Sql, Warehouse } from "../core/types.ts";
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
  problems: Problem[];
}

interface CommitRow { run_id: string; asset: string; commits: unknown; rows_in: unknown; added: unknown; updated: unknown }
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

/** Commits recorded in _croft.writes for these runs, keyed by run id + asset. Chunked TS
 *  transforms commit several times per step, so rows are summed. */
async function commitsFor(sql: Sql, runIds: string[]): Promise<Map<string, Commit>> {
  const found = new Map<string, Commit>();
  const [t] = await sql.all<{ n: unknown }>(
    `SELECT count(*)::INTEGER AS n FROM duckdb_tables()
     WHERE database_name = current_database() AND schema_name = '_croft' AND table_name = 'writes'`,
  );
  if (num(t?.n) === 0) return found;   // no write ever committed to this warehouse
  const rows = await sql.all<CommitRow>(
    `SELECT run_id, asset, count(*)::BIGINT AS commits, sum(rows_in)::BIGINT AS rows_in,
            sum(added)::BIGINT AS added, sum(updated)::BIGINT AS updated
     FROM _croft.writes WHERE run_id IN (${runIds.map(() => "?").join(", ")}) GROUP BY run_id, asset`,
    runIds,
  );
  for (const r of rows) {
    found.set(key(r.run_id, r.asset), { commits: num(r.commits), rowsIn: num(r.rows_in), added: num(r.added), updated: num(r.updated) });
  }
  return found;
}

const key = (runId: string, asset: string) => `${runId}\u0000${asset}`;

function lostProblem(s: StepRecord, run: RunRecord | null): Problem {
  return problem("INTERRUPTED", {
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
  const out: ReconcileResult = { crashed: [], recovered: [], lost: [], unresolved: [], releasedLeases: [], stagingDirs: [], problems: [] };

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

  // 2. Steps left running by ended runs (these and any a busy warehouse left unresolved before)
  //    are matched against _croft.writes.run_id under a short read lease.
  const dangling = db.danglingSteps();
  if (dangling.length === 0) return out;
  let commits: Map<string, Commit>;
  try {
    const runIds = [...new Set(dangling.map((s) => s.runId))];
    commits = await o.warehouse.read((sql) => commitsFor(sql, runIds), { purpose: "reconcile", waitMs: o.waitMs ?? DEFAULT_WAIT_MS });
  } catch (e) {
    out.unresolved = dangling.map(({ runId, asset, attempt }) => ({ runId, asset, attempt }));
    out.problems.push(asWarning(e, dangling.length));
    return out;
  }
  for (const s of dangling) {
    const ref = { runId: s.runId, asset: s.asset, attempt: s.attempt };
    const c = commits.get(key(s.runId, s.asset));
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

// Detached runs (DESIGN.md §5 "Processes" 2, §8 "Large first loads").
//
// Off a TTY, `croft run` executes in a detached child (`detached` + `unref`, env passed explicitly), so the
// agent's shell timeout can never kill a long extraction. The invoking process follows the child's events
// for --follow (default 100 s): when the run ends in time it prints the run's own result; otherwise it
// returns exit 6 with the run id and `croft wait <id> --timeout 100s`.
//
// The parent picks the run id and hands it to the child (--run-id); the child creates the run record, does
// the work in the foreground, and stores its whole result in runs.summary. Following reads only
// runs.sqlite and <state>/logs/<run>/events.ndjson, never the warehouse, which the child needs.
//
// The run folder also gets, before the run record exists (names start with "_", which no asset's can):
//   _process.log        the child's stdout and stderr (mode 0600): croft's own envelope and messages, and what asset
//                       code prints past its step log (a subprocess that outlives its step, output while several
//                       steps run), which reaches it only through croft's fd capture (core/output.ts); all redacted
//   _process.json       the spawn handshake: the child's {pid, procStart, bootId}, written by the parent, so
//                       `croft wait` can tell a child that died before recording its run from one still starting
//   _not_started.json   the problem of a child that refused to start (a --from that cannot apply, say)
//
// Run as a program (the child's entry point) this file calls the CLI's main() directly: the parent already
// runs the project's croft, so the launcher has nothing to decide.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CroftError, problem } from "../core/errors.ts";
import { defaultOutputRedactor, keepFdsCaptured } from "../core/output.ts";
import { bootId, procStart, type ProcessIdentity, recordAlive, UNKNOWN_START } from "../core/proc.ts";
import type { Problem, StepResult } from "../core/types.ts";
import {
  follow, logDir, NOT_STARTED_RECORD, PROCESS_RECORD, processLogPath, readRunRecord, tail, writeRunRecord,
} from "../history/logs.ts";
import { isRunId, newRunId, RunsDb, type RunRecord, type StepRecord } from "../history/runs-db.ts";
import { ProjectEnv } from "../project/env.ts";
import type { ProgressSnapshot } from "./ingest.ts";
import { eventsPath, type RunData, type RunSummary } from "./runner.ts";

/** Hidden flags the parent adds for its child. --detached implies the foreground: the child does the work. */
export const CHILD_FLAGS = { runId: "--run-id", detached: "--detached" } as const;
/** How long a non-TTY `croft run` follows its child, and how long `croft wait` waits, by default. */
export const DEFAULT_FOLLOW_MS = 100_000;

export const ENTRY = fileURLToPath(import.meta.url);

/** "100s", "2m", "90" (seconds), "1.5h" → milliseconds. USAGE_ERROR otherwise. */
export function parseWait(text: string, flag: string): number {
  const t = text.trim();
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/i.exec(t);
  if (!m) {
    throw new CroftError("USAGE_ERROR", {
      message: `${flag} ${JSON.stringify(text)} is not a duration`,
      hint: `write it like 100s, 2m or 1h (a bare number is seconds)`,
      details: { flag, value: text },
    });
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "ms" ? 1 : unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000;
  return Math.round(n * mult);
}

export interface SpawnInput {
  root: string;
  stateDir: string;
  /** The run command's arguments after "run", as the user gave them. */
  args: readonly string[];
  runId: string;
  /** The child's whole environment; nothing is inherited implicitly. */
  env: Record<string, string | undefined>;
  execPath?: string;
  entry?: string;
}

export interface Spawned {
  child: ChildProcess;
  pid: number;
  /** The child's stdout and stderr, for a crash that happens before the run record exists. */
  output: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** The spawn handshake (_process.json). */
export interface ChildRecord extends ProcessIdentity { startedAt: string }

export function writeChildRecord(stateDir: string, runId: string, id: ProcessIdentity): void {
  const rec: ChildRecord = { pid: id.pid, procStart: id.procStart, bootId: id.bootId, startedAt: new Date().toISOString() };
  writeRunRecord(stateDir, runId, PROCESS_RECORD, rec);
}

export function readChildRecord(stateDir: string, runId: string): ChildRecord | null {
  const r = readRunRecord<Partial<ChildRecord>>(stateDir, runId, PROCESS_RECORD);
  if (!r || typeof r.pid !== "number" || typeof r.procStart !== "string") return null;
  return { pid: r.pid, procStart: r.procStart, bootId: typeof r.bootId === "string" ? r.bootId : "", startedAt: String(r.startedAt ?? "") };
}

/** A detached child that refused to start records why, for its parent and for `croft wait`. */
export function writeNotStarted(stateDir: string, runId: string, p: Problem): void {
  writeRunRecord(stateDir, runId, NOT_STARTED_RECORD, { ...p, runId });
}

export function readNotStarted(stateDir: string, runId: string): Problem | null {
  const p = readRunRecord<Problem>(stateDir, runId, NOT_STARTED_RECORD);
  return p && typeof p.code === "string" && typeof p.message === "string" ? p : null;
}

/** Start `croft run … --run-id <id> --detached` in its own session, detached and unref'd. */
export function spawnDetachedRun(i: SpawnInput): Spawned {
  const dir = logDir(i.stateDir, i.runId);
  mkdirSync(dir, { recursive: true });
  const output = processLogPath(i.stateDir, i.runId);
  const fd = openSync(output, "a", 0o600);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.env)) if (v !== undefined) env[k] = v;
  let child: ChildProcess;
  try {
    child = spawn(i.execPath ?? process.execPath, [
      "--no-env-file", i.entry ?? ENTRY, "run", ...i.args, CHILD_FLAGS.runId, i.runId, CHILD_FLAGS.detached,
    ], { cwd: i.root, env, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  child.unref();
  if (child.pid !== undefined) {
    try {
      writeChildRecord(i.stateDir, i.runId, { pid: child.pid, procStart: procStart(child.pid) ?? UNKNOWN_START, bootId: bootId() });
    } catch {
      // Without the handshake `croft wait` still follows the run once it records itself.
    }
  }
  return { child, pid: child.pid ?? -1, output, exited };
}

export function pickRunId(timezone: string, now: Date = new Date()): string {
  return newRunId(now, timezone);
}

// ---------------------------------------------------------------------------------------------------------
// Reading a run back

/** The newest progress event of a run, from events.ndjson (only the tail is read). */
export function lastProgress(stateDir: string, runId: string): ProgressSnapshot | undefined {
  const t = tail(eventsPath(stateDir, runId), 50);
  for (let i = t.lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(t.lines[i]!) as { type?: string } & ProgressSnapshot;
      if (e.type === "progress") return { asset: e.asset, phase: e.phase, rowsFetched: e.rowsFetched, requests: e.requests, elapsedMs: e.elapsedMs };
    } catch {}
  }
  return undefined;
}

/** Finished steps of a run so far, from events.ndjson (the last result per asset). */
export function finishedSteps(stateDir: string, runId: string): StepResult[] {
  const t = tail(eventsPath(stateDir, runId), 10_000);
  const out = new Map<string, StepResult>();
  for (const line of t.lines) {
    try {
      const e = JSON.parse(line) as { type?: string; result?: StepResult };
      if (e.type === "step" && e.result) out.set(e.result.asset, e.result);
    } catch {}
  }
  return [...out.values()];
}

function stepFromRecord(s: StepRecord, attempts: number, runEnd: string | null): StepResult {
  const status: StepResult["status"] = s.status === "ok" || s.status === "skipped" || s.status === "unchanged" ? s.status : "failed";
  const started = Date.parse(s.startedAt);
  // A step crashed before reconcile checked it has no finish time yet: it ended when its run did.
  const end = s.finishedAt ?? runEnd;
  const finished = end ? Date.parse(end) : Date.now();
  return {
    asset: s.asset, status, reason: s.reason ?? "", behavior: "", attempt: s.attempt, maxAttempts: attempts,
    rows: { in: s.rowsIn ?? 0, added: s.added ?? 0, updated: s.updated ?? 0, unchanged: 0, deleted: 0, total: 0 },
    schemaChanges: [], checks: [], logsCommand: `croft logs ${s.asset}${status === "failed" ? " --failed" : ""}`,
    durationMs: Number.isNaN(started) ? 0 : Math.max(0, finished - started), ...(s.error ? { error: s.error } : {}),
  };
}

/** A run's result when it has no stored summary (it crashed): rebuilt from its step records. */
export function summaryFromRecords(run: RunRecord, steps: StepRecord[]): RunSummary {
  const last = new Map<string, StepRecord>();
  for (const s of steps) {
    const had = last.get(s.asset);
    if (!had || s.attempt > had.attempt) last.set(s.asset, s);
  }
  const results = [...last.values()].map((s) => stepFromRecord(s, s.attempt, run.finishedAt));
  const problems: Problem[] = results.flatMap((r) => (r.error ? [{ ...r.error, runId: run.id }] : []));
  if (run.status === "crashed" && !problems.some((p) => p.code === "RUN_CRASHED")) {
    problems.push(problem("RUN_CRASHED", {
      runId: run.id, message: `run ${run.id} (pid ${run.pid ?? "?"}) stopped before it finished`,
      hint: "what a step committed before the crash stays; steps that had not committed saved nothing; run the assets again",
      retryable: true,
    }));
  }
  const exit = run.status === "succeeded" ? 0 : run.status === "interrupted" ? 130 : 1;
  const next = run.status === "succeeded" ? [] : results.filter((r) => r.status === "failed").map((r) => ({ command: `croft logs ${r.asset} --failed`, reason: `see why ${r.asset} failed` }));
  return { data: { runId: run.id, status: run.status, steps: results }, problems, next, exit, ok: run.status === "succeeded" };
}

/** A finished run's stored result (or one rebuilt from its steps). */
export function finishedSummary(db: RunsDb, run: RunRecord): RunSummary {
  const s = run.summary as Partial<RunSummary> | null;
  if (s && typeof s === "object" && s.data && Array.isArray(s.problems) && typeof s.exit === "number") return s as RunSummary;
  return summaryFromRecords(run, db.stepsFor(run.id));
}

/** The "still running" result: exit 6, what the run is doing, and the command to keep waiting. */
export function runningSummary(stateDir: string, runId: string): RunSummary {
  const progress = lastProgress(stateDir, runId);
  const data: RunData = { runId, status: "running", ...(progress ? { progress } : {}), steps: finishedSteps(stateDir, runId) };
  return {
    data, problems: [], next: [{ command: `croft wait ${runId} --timeout 100s`, reason: "still running" }], exit: 6, ok: true,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Following

export interface FollowInput {
  stateDir: string;
  runId: string;
  timeoutMs: number;
  /** Each events.ndjson line as it arrives (--events). */
  onEvent?: (line: string) => void;
  /** The detached child, when this process started it: its exit ends the wait. */
  spawned?: Spawned;
  pollMs?: number;
  signal?: AbortSignal;
  /** How long to let a spawned child that recorded its finished run exit (it closes the warehouse). Default 3000. */
  exitGraceMs?: number;
}

export type FollowResult =
  | { kind: "finished"; summary: RunSummary }
  | { kind: "running"; summary: RunSummary }
  | { kind: "not_started"; problem: Problem };

/** A run whose detached child died before it recorded the run (kill -9, OOM, a reboot during a slow import):
 *  crashed, with nothing run. */
export function crashedBeforeStart(stateDir: string, runId: string, child: ChildRecord): RunSummary {
  const out = tail(processLogPath(stateDir, runId), 20).lines;
  const last = out.filter((l) => l.trim()).at(-1);
  const p = problem("RUN_CRASHED", {
    runId,
    message: `run ${runId} (pid ${child.pid}) stopped before it recorded anything${last ? `: ${last}` : ""}; nothing was run`,
    hint: "run the command again; croft run <asset> --foreground shows any error as it happens",
    retryable: true,
    fix: { kind: "manual", description: "run the same croft run command again" },
    details: { pid: child.pid, output: out },
  });
  return { data: { runId, status: "crashed", steps: [] }, problems: [p], next: [], exit: 1, ok: false };
}

/**
 * Follow a run until it ends or `timeoutMs` passes. A run whose process died is marked crashed, with its running
 * steps (RunsDb.markCrashed), so status shows the crash at once; the next reconcile() still checks those steps
 * against the warehouse, which may turn one into `ok (recovered)`. A child that
 * exits before it created the run record is reported with the problem it recorded, or the tail of its output;
 * without `spawned` (croft wait), a child whose recorded process is gone before it created the run record is
 * crashed, never "running" forever.
 */
export async function followRun(i: FollowInput): Promise<FollowResult> {
  const db = RunsDb.open(i.stateDir);
  try {
    const deadline = Date.now() + i.timeoutMs;
    const child: { exit: { code: number | null; signal: NodeJS.Signals | null } | null } = { exit: null };
    void i.spawned?.exited.then((x) => { child.exit = x; });
    let lastAliveCheck = 0;
    const gone: { rec: ChildRecord | null } = { rec: null };
    const settled = (): boolean => {
      const run = db.getRun(i.runId);
      if (run && run.status !== "running") return true;
      if (child.exit) return true;
      if (!run && readNotStarted(i.stateDir, i.runId)) return true;
      if (!i.spawned && Date.now() - lastAliveCheck > 1000) {
        lastAliveCheck = Date.now();
        // An empty or unknown boot id is unknown, not dead (core/proc.ts).
        if (run && !recordAlive(run)) {
          db.markCrashed(run.id);
          return true;
        }
        if (!run) {
          const rec = readChildRecord(i.stateDir, i.runId);
          if (rec && !recordAlive(rec)) {
            gone.rec = rec;
            return true;
          }
        }
      }
      return Date.now() >= deadline;
    };
    const path = eventsPath(i.stateDir, i.runId);
    for await (const line of follow(path, { from: 0, pollMs: i.pollMs ?? 100, until: settled, ...(i.signal ? { signal: i.signal } : {}) })) {
      if (line.trim()) i.onEvent?.(line);
    }
    let final = db.getRun(i.runId);
    // A finished run is recorded before its process exits, and the process still closes the warehouse after
    // (a checkpoint writes the file). Let it exit, briefly, so the next command neither waits on the lock nor sees
    // the file change after this one returned.
    if (final && final.status !== "running" && i.spawned && !child.exit) {
      // The grace's timer is cleared once the child exits: a pending timer would hold this process (and `croft run`)
      // for the rest of the grace after returning.
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([i.spawned.exited, new Promise<void>((r) => (grace = setTimeout(r, i.exitGraceMs ?? 3000)))]);
      clearTimeout(grace);
    } else if (final && final.status !== "running" && !i.spawned && final.pid !== null && final.pid !== process.pid) {
      // croft wait, which did not start the run: the same grace, watching the recorded process instead.
      const until = Date.now() + (i.exitGraceMs ?? 3000);
      const pid = final.pid;
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "EPERM";
        }
      };
      // The PID alone: within a few seconds of the run's end it cannot have been reused.
      while (Date.now() < until && alive()) await Bun.sleep(25);
    }
    // The child exited while its run still says running: it died (a finished run is recorded before exit).
    if (final && final.status === "running" && (child.exit || gone.rec)) {
      db.markCrashed(final.id);
      final = db.getRun(i.runId);
    }
    if (!final) {
      const refused = readNotStarted(i.stateDir, i.runId);
      if (refused) return { kind: "not_started", problem: { ...refused, runId: i.runId } };
      if (child.exit) {
        const out = existsSync(i.spawned!.output) ? tail(i.spawned!.output, 20).lines : [];
        const how = child.exit.code !== null ? `exited with ${child.exit.code}` : `was killed (${child.exit.signal ?? "unknown"})`;
        return { kind: "not_started", problem: problem("INTERNAL_ERROR", {
          runId: i.runId,
          message: `the run process ${how} before it recorded run ${i.runId}${out.length ? `: ${out.at(-1)}` : ""}`,
          hint: "run it in the foreground to see the whole error: croft run <asset> --foreground",
          details: { output: out },
        }) };
      }
      if (gone.rec) return { kind: "finished", summary: crashedBeforeStart(i.stateDir, i.runId, gone.rec) };
      if (i.spawned || detachedRunExists(i.stateDir, i.runId)) return { kind: "running", summary: runningSummary(i.stateDir, i.runId) };
      return { kind: "not_started", problem: unknownRun(i.runId).problem };
    }
    if (final.status === "running") return { kind: "running", summary: runningSummary(i.stateDir, i.runId) };
    return { kind: "finished", summary: finishedSummary(db, final) };
  } finally {
    db.close();
  }
}

/** Whether a detached run was started under this id, even if it has not recorded itself yet. */
export function detachedRunExists(stateDir: string, runId: string): boolean {
  return existsSync(processLogPath(stateDir, runId)) || readChildRecord(stateDir, runId) !== null;
}

/** RUN_NOT_FOUND-style usage error for `croft wait` with an unknown id. */
export function unknownRun(runId: string): CroftError {
  return new CroftError("USAGE_ERROR", {
    message: isRunId(runId) ? `there is no run ${runId} in this project` : `${JSON.stringify(runId)} is not a run id (they look like r_0922_1130_x1c8)`,
    hint: "croft logs --runs lists recent runs",
    fix: { kind: "command", description: "list recent runs", command: "croft logs --runs" },
    details: { runId },
  });
}

if (import.meta.main) {
  // This process is the detached run; its stdout and stderr are _process.log. From the first asset code on, fds 1
  // and 2 stay captured until exit, so what a subprocess prints is redacted before it gets there: with the
  // project's .env (the cwd is the project root) until the run sets its own redactor (core/output.ts).
  keepFdsCaptured();
  defaultOutputRedactor(() => {
    const env = ProjectEnv.load(process.cwd(), {});
    return (text) => env.redact(text);
  });
  const { main } = await import("../cli/main.ts");
  const code = await main(process.argv.slice(2));
  // The run is recorded and its after-run work done: exit now, with every warehouse closed first. Asset code may leave
  // a timer or a socket open (a client's keep-alive pool), which would keep this process alive with nothing to do and
  // its parent waiting out the grace for its exit. Nothing is cut off: stdout and stderr are _process.log, a file,
  // written synchronously, and the fd capture's last pump runs on exit. A lease asset code left open cannot hold the
  // close for long: the exit hook closes what is left synchronously (db/warehouse.ts).
  const { closeAllWarehouses } = await import("../db/warehouse.ts");
  await Promise.race([closeAllWarehouses().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
  process.exit(code);
}

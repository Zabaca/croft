// croft logs [asset|run-id] [--failed] [--runs] [--follow] [--lines N] (DESIGN.md §4.1, §9.6): the console
// output and errors of a step, from <state>/logs/<run>/<asset>.log (history/logs.ts) and runs.sqlite. It never
// touches DuckDB, so it answers while a run writes.
//
// - `croft logs x` shows the last step of asset x; `croft logs r_…` every step of that run; bare `croft logs`
//   the latest run. --failed narrows each to failed, crashed and interrupted steps.
// - Logs are cut to their last 200 lines (--lines N shows more) and every .env value is redacted (§9).
// - --runs lists runs and their steps instead of log text.
// - --follow keeps printing a running step's new lines (and, for a run, each step it starts) until it ends.
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { CroftError } from "../../core/errors.ts";
import type { Problem } from "../../core/types.ts";
import { DEFAULT_TAIL_LINES, follow, logPath, tail } from "../../history/logs.ts";
import { FAILED_STATUSES, isRunId, type RunRecord, type RunsDb, type StepRecord } from "../../history/runs-db.ts";
import { NAME_PATTERN } from "../../project/discover.ts";
import type { Project } from "../../project/root.ts";
import type { CommandImpl, Ctx } from "../command.ts";
import { formatCount, formatDuration, formatProblem } from "../render.ts";
import { effectiveStatus, openRunsDb, runAlive, runningEntries, zoned } from "./status.ts";

export interface StepLog {
  runId: string;
  asset: string;
  attempt: number;
  status: string;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
  log: string | null;               // the log file, relative to the project root when inside it
  lines: string[];
  truncated: boolean;               // earlier lines exist
  error: Problem | null;
}

export interface RunEntry {
  runId: string;
  trigger: string;
  human: boolean;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  argv: string[];
  steps: {
    asset: string; attempt: number; status: string; reason: string | null; startedAt: string; finishedAt: string | null;
    durationMs: number | null; rows: { in: number | null; added: number | null; updated: number | null };
    error: { code: string; message: string } | null; logsCommand: string;
  }[];
}

export type LogsData =
  | { mode: "logs"; target: { kind: "asset" | "run" | "latest"; value: string | null }; steps: StepLog[]; followed: boolean }
  | { mode: "runs"; target: { kind: "asset" | "run" | "latest"; value: string | null }; runs: RunEntry[]; limit: number };

export const RUNS_LIMIT = 20;
const FAILED = new Set<string>(FAILED_STATUSES);

function parseLines(v: unknown): number {
  if (v === undefined) return DEFAULT_TAIL_LINES;
  const text = String(v).trim();
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new CroftError("USAGE_ERROR", {
      message: `--lines needs a whole number of lines; got ${JSON.stringify(String(v))}`,
      hint: "for example --lines 1000",
      fix: { kind: "manual", description: "pass --lines with a whole number, such as --lines 1000" },
    });
  }
  return Number(text);
}

type Target = { kind: "asset" | "run" | "latest"; value: string | null };

function targetOf(arg: string | undefined): Target {
  if (arg === undefined) return { kind: "latest", value: null };
  if (isRunId(arg)) return { kind: "run", value: arg };
  if (NAME_PATTERN.test(arg)) return { kind: "asset", value: arg };
  throw new CroftError("USAGE_ERROR", {
    message: `${JSON.stringify(arg)} is neither an asset name nor a run id`,
    hint: "pass an asset name (github_issues) or a run id (r_0922_1015_k3f9); croft logs --runs lists runs",
    fix: { kind: "command", description: "list recent runs", command: "croft logs --runs" },
  });
}

function missingRun(id: string): CroftError {
  return new CroftError("USAGE_ERROR", {
    message: `there is no run ${id} in this project`,
    hint: "croft logs --runs lists recent runs",
    fix: { kind: "command", description: "list recent runs", command: "croft logs --runs" },
  });
}

const durationOf = (start: string, end: string | null) => (end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null);

/** Where a step's log is: the path the run recorded, or the standard one. */
function stepLogPath(project: Project, s: StepRecord): string {
  const std = logPath(project.paths.stateDir, s.runId, s.asset);
  if (!s.logPath) return std;
  const p = isAbsolute(s.logPath) ? s.logPath : join(project.root, s.logPath);
  return existsSync(p) || !existsSync(std) ? p : std;
}

function shown(project: Project, path: string): string {
  const rel = relative(project.root, path);
  return rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/** The steps a logs call is about. */
function stepsFor(db: RunsDb, target: Target, failed: boolean, dead: Set<string>): { steps: StepRecord[]; run: RunRecord | null } {
  const isFailed = (s: StepRecord) => FAILED.has(effectiveStatus(s, dead));
  if (target.kind === "asset") {
    const step = failed ? latestFailed(db, target.value!, dead) : db.latestStep(target.value!);
    return { steps: step ? [step] : [], run: step ? db.getRun(step.runId) : null };
  }
  let run: RunRecord | null;
  if (target.kind === "run") {
    run = db.getRun(target.value!);
    if (!run) throw missingRun(target.value!);
  } else {
    run = failed
      ? db.listRuns({ limit: 50 }).find((r) => FAILED.has(r.status) || dead.has(r.id) || db.stepsFor(r.id).some(isFailed)) ?? null
      : db.listRuns({ limit: 1 })[0] ?? null;
  }
  if (!run) return { steps: [], run: null };
  const steps = db.stepsFor(run.id);
  return { steps: failed ? steps.filter(isFailed) : steps, run };
}

/** The asset's latest failed step; a step still marked running in a dead run counts as crashed. */
function latestFailed(db: RunsDb, asset: string, dead: Set<string>): StepRecord | null {
  const recorded = db.latestStep(asset, { failed: true });
  const latest = db.latestStep(asset);
  if (latest && latest.status === "running" && dead.has(latest.runId)) return latest;
  return recorded;
}

function stepLog(ctx: Ctx, project: Project, s: StepRecord, dead: Set<string>, lines: number): StepLog & { size: number; path: string } {
  const path = stepLogPath(project, s);
  const t = tail(path, lines, { redact: (x) => ctx.env.redact(x) });
  const tz = project.timezone;
  return {
    runId: s.runId, asset: s.asset, attempt: s.attempt, status: effectiveStatus(s, dead), reason: s.reason,
    startedAt: zoned(s.startedAt, tz)!, finishedAt: zoned(s.finishedAt, tz), log: t.exists ? shown(project, path) : null,
    lines: t.lines, truncated: t.truncated, error: s.error ? ctx.env.redactDeep(s.error) : null, size: t.size, path,
  };
}

function strip(s: StepLog & { size?: number; path?: string }): StepLog {
  const { size: _size, path: _path, ...rest } = s;
  return rest;
}

export const logs: CommandImpl<LogsData> = {
  async run(ctx) {
    const project = ctx.project;
    const target = targetOf(ctx.positionals[0]);
    const failed = ctx.values.failed === true;
    const lines = parseLines(ctx.values.lines);
    const db = openRunsDb(project.paths.stateDir);
    if (!db) {
      if (target.kind === "run") throw missingRun(target.value!);
      const data: LogsData = ctx.values.runs === true
        ? { mode: "runs", target, runs: [], limit: RUNS_LIMIT }
        : { mode: "logs", target, steps: [], followed: false };
      return { data, problems: [], next: [{ command: target.kind === "asset" ? `croft run ${target.value}` : "croft run", reason: "nothing has run yet" }] };
    }
    try {
      const { dead } = runningEntries(db, project.timezone);
      if (ctx.values.runs === true) return { data: listRuns(ctx, db, target, failed, dead), problems: [], next: [] };

      const { steps } = stepsFor(db, target, failed, dead);
      const logsOut = steps.map((s) => stepLog(ctx, project, s, dead, lines));
      const next: { command: string; reason: string }[] = [];
      if (steps.length === 0 && target.kind === "asset") {
        next.push(failed
          ? { command: `croft logs ${target.value}`, reason: `no failed step of ${target.value}; this shows its last step` }
          : { command: `croft run ${target.value}`, reason: `${target.value} has not run yet` });
      }
      if (logsOut.some((l) => l.truncated) && lines === DEFAULT_TAIL_LINES) {
        next.push({ command: `croft logs ${[ctx.positionals[0], failed ? "--failed" : ""].filter(Boolean).join(" ")} --lines 1000`.replace(/\s+/g, " "), reason: "earlier log lines were cut" });
      }
      if (ctx.values.follow === true) {
        await followSteps(ctx, db, project, target, failed, logsOut, lines);
        return { data: { mode: "logs", target, steps: logsOut.map(strip), followed: true }, problems: [], next };
      }
      return { data: { mode: "logs", target, steps: logsOut.map(strip), followed: false }, problems: [], next };
    } finally {
      db.close();
    }
  },
  human(result) {
    const d = result.data;
    if (d.mode === "runs") return formatRuns(d.runs);
    if (d.followed) return undefined;   // already printed as it arrived
    return formatLogs(d);
  },
};

function listRuns(ctx: Ctx, db: RunsDb, target: Target, failed: boolean, dead: Set<string>): LogsData {
  const tz = ctx.project.timezone;
  let runs: RunRecord[];
  if (target.kind === "run") {
    const r = db.getRun(target.value!);
    if (!r) throw missingRun(target.value!);
    runs = [r];
  } else {
    runs = db.listRuns({ ...(target.kind === "asset" ? { asset: target.value! } : {}), failed, limit: RUNS_LIMIT });
  }
  const entries: RunEntry[] = runs.map((r) => {
    let steps = db.stepsFor(r.id);
    if (target.kind === "asset") steps = steps.filter((s) => s.asset === target.value);
    const status = r.status === "running" && dead.has(r.id) ? "crashed" : r.status;
    return {
      runId: r.id, trigger: r.trigger, human: r.human, status, startedAt: zoned(r.startedAt, tz)!, finishedAt: zoned(r.finishedAt, tz),
      durationMs: durationOf(r.startedAt, r.finishedAt), argv: r.argv,
      steps: steps.map((s) => ({
        asset: s.asset, attempt: s.attempt, status: effectiveStatus(s, dead), reason: s.reason, startedAt: zoned(s.startedAt, tz)!,
        finishedAt: zoned(s.finishedAt, tz), durationMs: durationOf(s.startedAt, s.finishedAt),
        rows: { in: s.rowsIn, added: s.added, updated: s.updated },
        error: s.error ? { code: s.error.code, message: ctx.env.redact(s.error.message) } : null,
        logsCommand: `croft logs ${s.runId}`,
      })),
    };
  });
  return { mode: "runs", target, runs: entries, limit: RUNS_LIMIT };
}

/** --follow: print what is there, then new lines of every running step (and, for a run, of steps it starts
 *  later) until they end. Lines go through render.out: stdout for people, stderr under --json. */
async function followSteps(ctx: Ctx, db: RunsDb, project: Project, target: Target, failed: boolean,
  out: (StepLog & { size: number; path: string })[], lines: number): Promise<void> {
  for (const s of out) ctx.render.out(formatStep(strip(s)));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    const followed = new Set<string>();
    const keyOf = (s: { runId: string; asset: string; attempt: number }) => `${s.runId}\0${s.asset}\0${s.attempt}`;
    for (;;) {
      const { dead } = runningEntries(db, project.timezone);
      const current = stepsFor(db, target, failed, dead).steps;
      const pending = current.filter((s) => s.status === "running" && !dead.has(s.runId) && !followed.has(keyOf(s)));
      for (const s of pending) {
        followed.add(keyOf(s));
        let entry = out.find((e) => keyOf(e) === keyOf(s));
        if (!entry) {
          entry = stepLog(ctx, project, s, dead, lines);
          out.push(entry);
          ctx.render.out(formatStep(strip(entry)));
        }
        // runs.sqlite is cheap to poll; whether the run's process is alive costs a `ps`, so once a second.
        let aliveAt = 0;
        const done = () => {
          const now = db.getStep(s.runId, s.asset, s.attempt);
          const run = db.getRun(s.runId);
          if (!now || now.status !== "running" || !run || run.status !== "running") return true;
          if (Date.now() - aliveAt < 1000) return false;
          aliveAt = Date.now();
          return !runAlive(run);
        };
        for await (const line of follow(entry.path, { from: entry.size, until: done, signal: controller.signal, redact: (x) => ctx.env.redact(x), pollMs: 100 })) {
          entry.lines.push(line);
          if (entry.lines.length > lines) {
            entry.lines.shift();
            entry.truncated = true;
          }
          ctx.render.out(line);
        }
        const finished = db.getStep(s.runId, s.asset, s.attempt);
        if (finished) {
          entry.status = effectiveStatus(finished, runningEntries(db, project.timezone).dead);
          entry.finishedAt = zoned(finished.finishedAt, project.timezone);
          entry.error = finished.error ? ctx.env.redactDeep(finished.error) : null;
          ctx.render.out(`── ${entry.asset} ${entry.status}${entry.error ? ` (${entry.error.code})` : ""}`);
        }
        if (controller.signal.aborted) return;
      }
      if (controller.signal.aborted) return;
      // A run that is still going may start more steps; an asset's step, once followed, is all there is.
      const runId = target.kind === "run" ? target.value : target.kind === "latest" ? current[0]?.runId ?? null : null;
      const run = runId ? db.getRun(runId) : null;
      if (!run || run.status !== "running" || !runAlive(run)) return;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    process.removeListener("SIGINT", stop);
  }
}

function formatStep(s: StepLog): string {
  const head = `── ${s.asset} · ${s.runId} · attempt ${s.attempt} · ${s.status}${s.error ? ` (${s.error.code})` : ""} · ${s.startedAt}`;
  const lines = [head];
  if (s.truncated) lines.push(`(earlier lines not shown; --lines N shows more)`);
  if (s.lines.length) lines.push(...s.lines);
  else lines.push(s.log ? "(the log is empty)" : "(no log output)");
  if (s.error) lines.push(formatProblem(s.error));
  return lines.join("\n");
}

export function formatLogs(d: Extract<LogsData, { mode: "logs" }>): string {
  if (d.steps.length === 0) {
    if (d.target.kind === "asset") return `${d.target.value} has no step to show yet`;
    return "no runs to show yet";
  }
  return d.steps.map(formatStep).join("\n\n");
}

export function formatRuns(runs: RunEntry[]): string {
  if (runs.length === 0) return "no runs yet";
  const lines: string[] = [];
  for (const r of runs) {
    lines.push(`${r.runId}  ${r.status}  ${r.trigger}${r.human ? "" : " (scheduled)"}  ${r.startedAt}${r.durationMs !== null ? `  ${formatDuration(r.durationMs)}` : ""}`);
    for (const s of r.steps) {
      const rows = s.rows.in !== null ? `  ${formatCount(s.rows.in)} in, +${formatCount(s.rows.added ?? 0)} added, ${formatCount(s.rows.updated ?? 0)} updated` : "";
      const err = s.error ? `  ${s.error.code}: ${s.error.message}` : "";
      lines.push(`  ${s.status.padEnd(11)} ${s.asset}${s.attempt > 1 ? ` (attempt ${s.attempt})` : ""}${s.durationMs !== null ? `  ${formatDuration(s.durationMs)}` : ""}${rows}${err}`);
    }
  }
  return lines.join("\n");
}

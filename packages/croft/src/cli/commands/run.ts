// croft run [selector…] (DESIGN.md §4.1 "run flags", §4.3 run/wait shapes, §5 "Processes", §6 confirmation,
// §8 backfills). Its spec (usage, options) is in commands/index.ts.
//
// On a TTY (or with --foreground) the run executes in this process: SIGINT/SIGTERM interrupt it (exit 130).
// Off a TTY it executes in a detached child (run/detach.ts); this process follows it for --follow (100 s)
// and prints its result, or exits 6 with `croft wait <id>`. Hidden flags: --run-id and --detached (set by the
// parent for its child), --confirm-token (set by `croft confirm`).
import { createInterface } from "node:readline/promises";
import { CroftError, isCode } from "../../core/errors.ts";
import type { Problem, StepResult } from "../../core/types.ts";
import { isRunId, RunsDb } from "../../history/runs-db.ts";
import { Confirmations } from "../../safety/confirm.ts";
import { DEFAULT_FOLLOW_MS, followRun, parseWait, pickRunId, spawnDetachedRun } from "../../run/detach.ts";
import { loadErrors, planRun } from "../../run/plan.ts";
import { checkRunFlags, executeRun, type RunData, type RunEvent, type RunSummary } from "../../run/runner.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { formatCount, formatDuration } from "../render.ts";

const HIDDEN_WITH_VALUE = new Set(["--run-id", "--confirm-token"]);
const HIDDEN_BOOLEAN = new Set(["--detached"]);

/** The user's own arguments: without the flags croft adds for itself. */
export function userArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const name = a.split("=")[0]!;
    if (HIDDEN_BOOLEAN.has(a)) continue;
    if (HIDDEN_WITH_VALUE.has(name)) {
      if (!a.includes("=")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Test knob: CROFT_RETRY_DELAYS="10,20" (milliseconds) replaces the 30 s and 2 min retry delays. */
function retryDelays(env: Record<string, string | undefined>): number[] | undefined {
  const raw = env.CROFT_RETRY_DELAYS?.trim();
  if (!raw) return undefined;
  const list = raw.split(",").map((x) => Number(x.trim()));
  return list.every((n) => Number.isFinite(n) && n >= 0) ? list : undefined;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^\s*y(es)?\s*$/i.test(await rl.question(question));
  } finally {
    rl.close();
  }
}

export function toResult(s: RunSummary): CommandResult<RunData> {
  return {
    data: s.data, problems: s.problems, next: s.next, exit: s.exit, ok: s.ok,
    ...(s.confirmation ? { confirmation: s.confirmation } : {}),
  };
}

function croftFrom(p: Problem): CroftError {
  const { severity: _s, docs: _d, code, ...init } = p;
  return new CroftError(isCode(code) ? code : "INTERNAL_ERROR", init);
}

export const run: CommandImpl<RunData> = {
  async run(ctx) {
    const project = ctx.project;
    const v = ctx.values;
    const selectors = [...ctx.positionals];
    const from = str(v.from);
    const allowShrink = v["allow-shrink"] === true;
    const confirmToken = str(v["confirm-token"]);
    const runIdFlag = str(v["run-id"]);
    const detachedChild = v.detached === true;
    const events = v.events === true;
    if (runIdFlag !== undefined && !isRunId(runIdFlag)) {
      throw new CroftError("USAGE_ERROR", { message: `--run-id ${JSON.stringify(runIdFlag)} is not a run id`, hint: "--run-id is set by croft for a detached run; leave it out" });
    }
    const followMs = str(v.follow) !== undefined ? parseWait(str(v.follow)!, "--follow") : DEFAULT_FOLLOW_MS;
    const interactive = ctx.isTTY.stdin && ctx.isTTY.stdout && !detachedChild;
    const foreground = v.foreground === true || interactive || detachedChild;
    const args = userArgs(ctx.argv);
    const argv = ["run", ...args];

    if (confirmToken !== undefined) {
      const db = RunsDb.open(project.paths.stateDir);
      try {
        if (!new Confirmations(db).get(confirmToken)) {
          throw new CroftError("USAGE_ERROR", {
            message: `no confirmation ${JSON.stringify(confirmToken)} exists in this project`,
            hint: "run the destructive command again to get a token; tokens look like c_7f3a9e",
          });
        }
      } finally {
        db.close();
      }
    }

    if (!foreground) {
      // Report usage problems here, at once, rather than from a child nobody is watching.
      const plan = await planRun({ root: project.root, timezone: project.timezone, selectors });
      checkRunFlags(plan, { selectors, ...(from !== undefined ? { from } : {}), allowShrink, ...(confirmToken !== undefined ? { confirmToken } : {}) });
      const willRun = plan.steps.some((s) => s.action === "fetch" && loadErrors(s).length === 0);
      if (willRun) {
        const runId = pickRunId(project.timezone, ctx.now());
        const childArgs = args.filter((a) => a !== "--events");
        if (confirmToken !== undefined) childArgs.push("--confirm-token", confirmToken);
        const spawned = spawnDetachedRun({ root: project.root, stateDir: project.paths.stateDir, args: childArgs, runId, env: ctx.processEnv });
        const res = await followRun({
          stateDir: project.paths.stateDir, runId, timeoutMs: followMs, spawned,
          ...(events ? { onEvent: (line: string) => ctx.render.progress(line) } : {}),
        });
        if (res.kind === "not_started") throw croftFrom(res.problem);
        return toResult(res.summary);
      }
    }

    const ac = new AbortController();
    let signals = 0;
    const onSignal = (sig: NodeJS.Signals) => {
      if (++signals > 1) process.exit(130); // a second Ctrl-C does not wait for cleanup
      ac.abort(new CroftError("INTERRUPTED", {
        message: `the run was stopped by ${sig}`,
        hint: "steps that had not committed saved nothing and their cursors did not move; run again to finish",
      }));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const delays = retryDelays(ctx.processEnv);
      const out = await executeRun({
        project, env: ctx.env, selectors, argv, trigger: confirmToken !== undefined ? "confirm" : "manual", human: true, interactive,
        ...(runIdFlag ? { runId: runIdFlag } : {}), ...(from !== undefined ? { from } : {}), allowShrink,
        ...(confirmToken !== undefined ? { confirmToken } : {}),
        ...(interactive && !ctx.json ? { prompt: askYesNo } : {}),
        noWait: v["no-wait"] === true, signal: ac.signal,
        ...(events ? { onEvent: (line: string) => ctx.render.progress(line) } : interactive && !ctx.json ? { onEvent: (_line: string, e: RunEvent) => {
          const text = progressLine(e);
          if (text) ctx.render.progress(text);
        } } : {}),
        ...(delays ? { retryDelaysMs: delays } : {}),
        ...(ctx.processEnv.CROFT_FAULT ? { fault: ctx.processEnv.CROFT_FAULT } : {}),
      });
      return toResult(out);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  },
  human(result, ctx) {
    return formatRun(result.data, ctx);
  },
};

/** What a person at a terminal sees on stderr while a run works (the result follows on stdout). */
export function progressLine(e: RunEvent): string | null {
  const assets = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));
  if (e.type === "step" && e.status === "running") return `${String(e.asset)}: fetching${Number(e.attempt) > 1 ? ` (attempt ${String(e.attempt)})` : ""}…`;
  if (e.type === "retry") return `${String(e.asset)}: ${String(e.code)}; trying again at ${String(e.nextRetryAt)}`;
  if (e.type === "waiting") return `waiting for ${assets(e.assets)}: held by run ${assets(e.heldBy)}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Human output (§4.2)

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

function stepLines(s: StepResult): string[] {
  const head = (label: string, text: string) => `${label.padEnd(8)} ${s.asset.padEnd(18)} ${text}`;
  const pad = " ".repeat(28);
  if (s.status === "failed") {
    const e = s.error;
    const attempt = s.attempt > 1 ? ` (attempt ${s.attempt} of ${s.maxAttempts})` : "";
    const retry = s.nextRetryAt ? ` · retry planned ${s.nextRetryAt}` : "";
    return [head("failed", `${e ? `${e.code}: ${e.message}` : "failed"}${attempt}${retry}`), `${pad}${s.logsCommand}`];
  }
  if (s.status === "skipped") return [head("skipped", s.skippedBecause ?? s.reason)];
  if (s.status === "unchanged") return [head("ok", `unchanged · ${s.reason}`)];
  const r = s.rows;
  const first: string[] = [];
  if (s.requests !== undefined && s.requests > 0) first.push(`${plural(s.requests, "request")}, ${plural(r.in, "row")} (${formatDuration(s.durationMs)})`);
  else first.push(`${plural(r.in, "row")} (${formatDuration(s.durationMs)})`);
  const added = s.schemaChanges.filter((c) => c.kind === "add_column").length;
  const widened = s.schemaChanges.filter((c) => c.kind === "widen").length;
  if (added) first.push(`+${plural(added, "column")}`);
  if (widened) first.push(`${plural(widened, "column")} widened`);
  const second = [`added ${formatCount(r.added)}`, `updated ${formatCount(r.updated)}`, `unchanged ${formatCount(r.unchanged)}`];
  if (r.deleted) second.push(`deleted ${formatCount(r.deleted)}`);
  second.push(`${plural(r.total, "row")} now`);
  if (s.cursor?.after !== undefined && s.cursor.after !== s.cursor.before) second.push(`since → ${s.cursor.after}`);
  if (s.trashed) second.push(`previous ${plural(s.trashed.rows, "row")} in the trash`);
  const lines = [head("ok", first.join(" · ")), `${pad}${second.join(" · ")}`];
  if (s.reason && s.reason !== "requested") lines.push(`${pad}${s.reason.replace(/^requested; /, "")}`);
  return lines;
}

export function formatRun(d: RunData, ctx?: Pick<Ctx, "render">): string {
  const bold = ctx?.render.style.bold ?? ((x: string) => x);
  const lines: string[] = [];
  if (d.status === "running") {
    const p = d.progress;
    const doing = p ? ` (${p.asset}: ${p.phase}, ${plural(p.rowsFetched, "row")}, ${plural(p.requests, "request")}, ${formatDuration(p.elapsedMs)})` : "";
    lines.push(`run ${d.runId} is still running${doing}`);
    for (const s of d.steps) lines.push(...stepLines(s));
    return lines.join("\n");
  }
  lines.push(bold(`run ${d.runId} · ${plural(d.steps.length, "asset")}`));
  for (const s of d.steps) lines.push(...stepLines(s));
  const took = d.steps.reduce((m, s) => Math.max(m, s.durationMs), 0);
  const updated = d.steps.filter((s) => s.status === "ok" && s.rows.added + s.rows.updated + s.rows.deleted > 0).length;
  const failed = d.steps.filter((s) => s.status === "failed").length;
  lines.push(`${d.status === "interrupted" ? "interrupted" : "done"} ${formatDuration(took)} · ${formatCount(updated)} updated · ${formatCount(failed)} failed`);
  return lines.join("\n");
}


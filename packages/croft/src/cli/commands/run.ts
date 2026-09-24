// croft run [selector…] (DESIGN.md §4.1 "run flags", §4.3 run/wait shapes, §5 "Processes", §6 confirmation,
// §8 backfills). Its spec (usage, options) is in commands/index.ts.
//
// The plan (run/plan.ts) is made here, with the catalog mirror and --only, --upstream and --from, and handed to
// the engine; --dry-run describes it (run/dry-run.ts) and stops, in this process, without opening the warehouse.
//
// On a TTY (or with --foreground) the run executes in this process: SIGINT/SIGTERM interrupt it (exit 130).
// Off a TTY it executes in a detached child (run/detach.ts); this process follows it for --follow (100 s)
// and prints its result, or exits 6 with `croft wait <id>`. Hidden flags: --run-id and --detached (set by the
// parent for its child).
//
// --due (hidden) is the scheduler's run (§8): `croft tick` starts one detached per group of due assets, named on the
// command line (without names it runs what is due now). Its trigger is "schedule" and it is not a person's run
// (human false): it never asks, never approves code, and its plan holds what the scheduler must not run
// (schedule/due.ts duePlanning, run/plan.ts). It goes with no other run flag.
//
// No flag carries a confirmation (§6): a destructive action runs only through `croft confirm <token>`, the one
// prefix the Claude Code "ask" rule gates. confirm runs this command in its own process and hands it the token
// through the CLI's Dispatch; when the run detaches, the child gets it through a one-time grant
// (safety/confirm.ts). A token the run never reached because nothing needed consent is spent when the run ends.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CroftError, isCode } from "../../core/errors.ts";
import type { DryRunData, Problem, StepResult } from "../../core/types.ts";
import { logDir } from "../../history/logs.ts";
import { allCatalog } from "../../history/catalog.ts";
import { isRunId, RunsDb } from "../../history/runs-db.ts";
import { discoverAssets } from "../../project/discover.ts";
import type { Project } from "../../project/root.ts";
import { CONFIRM_GRANT_ENV, Confirmations, grantDetached, redeemGrant } from "../../safety/confirm.ts";
import { DEFAULT_FOLLOW_MS, followRun, parseWait, pickRunId, spawnDetachedRun, writeNotStarted } from "../../run/detach.ts";
import { dryRun, formatDryRun, refuseToken } from "../../run/dry-run.ts";
import { croftError } from "../../run/ingest.ts";
import { cursorTypesOf, loadErrors, type PlannedStep, planRun, readMirror, type RunPlan } from "../../run/plan.ts";
import { checkRunFlags, executeRun, jsonSafe, redactValue, type RunData, type RunEvent, type RunSummary } from "../../run/runner.ts";
import { duePlanning, dueWork } from "../../schedule/due.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { dispatchOf } from "../main.ts";
import { formatCount, formatDuration } from "../render.ts";

const HIDDEN_WITH_VALUE = new Set(["--run-id"]);
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

/** What the flags ask of the plan. */
interface PlanFlags { selectors: readonly string[]; only: boolean; upstream: boolean; from?: string; due?: { now: Date } }

/** The run's plan, from the catalog mirror in runs.sqlite (never the warehouse). */
async function planFor(project: Project, f: PlanFlags): Promise<RunPlan> {
  if (f.due) return duePlan(project, f.selectors, f.due.now);
  const catalog = readMirror(project.paths.stateDir);
  return planRun({
    root: project.root, timezone: project.timezone, selectors: f.selectors, catalog, cursorTypes: cursorTypesOf(catalog),
    only: f.only, upstream: f.upstream, ...(f.from !== undefined ? { from: f.from } : {}),
  });
}

/**
 * --due: the plan of the assets the tick named (or, with none, of what is due now), with the scheduler's holds and
 * the fire each due ingest handles. A named asset whose file is gone since the tick is left out; with nothing left
 * the plan is empty.
 */
export async function duePlan(project: Project, named: readonly string[], now: Date): Promise<RunPlan> {
  const empty: RunPlan = { steps: [], order: [], problems: [], fileDirs: [] };
  const runs = RunsDb.open(project.paths.stateDir, { now: () => now });
  try {
    let assets: string[];
    let fires: Map<string, string> | undefined;
    if (named.length === 0) {
      const work = await dueWork({ project, runs, now, store: true });
      assets = work.groups.flat();
      fires = work.fires;
    } else {
      const exists = new Set((await discoverAssets(project.root, { assetsDir: project.paths.assetsDir })).assets.map((a) => a.name));
      assets = named.filter((n) => exists.has(n));
    }
    if (assets.length === 0) return empty;
    const catalog = allCatalog(runs);
    return await planRun({
      root: project.root, timezone: project.timezone, selectors: assets, catalog, cursorTypes: cursorTypesOf(catalog),
      due: duePlanning({ project, runs, now, ...(fires ? { fires } : {}) }),
    });
  } finally {
    runs.close();
  }
}

/** --due goes with no other run flag: it runs what the scheduler would, as the scheduler would. */
function checkDueFlags(v: Ctx["values"]): void {
  const other = ["dry-run", "only", "upstream", "from", "allow-shrink"].find((f) => v[f] !== undefined && v[f] !== false);
  if (other) {
    throw new CroftError("USAGE_ERROR", {
      message: `--due runs what the scheduler would; it does not go with --${other}`,
      hint: "leave --due out: croft tick starts it by itself; to run assets by hand, name them: croft run <asset>",
    });
  }
}

/** In a confirmed run's log directory: the token that run ended without reaching (settleConfirmation). */
const UNREACHED_FILE = "confirm-unreached";

/**
 * A confirmed run that ended without reaching its confirmation: the shrink guard did not trip (the source
 * recovered, say), or the cost guard found no more rows than confirmAbove, so nothing needed consent and it ran as
 * a normal run. Its token is spent anyway, so it cannot run the command a second time, and croft confirm is told
 * so (outcome "not_needed"). A run that did reach it spent the token in consume() (then trashed, or processed its
 * backlog), and croft confirm says "used" (§6). A failed run leaves an unreached token valid for another try; a
 * run still going is settled by its detached child when it ends.
 *
 * A detached run is settled twice, by its child when the run ends and by the parent following it, in either
 * order. Whoever finds the token unspent first notes that in the run's log directory before spending it, so the
 * other still tells an unreached token from one the run spent.
 */
function settleConfirmation(ctx: Ctx, token: string, s: RunSummary): void {
  if (s.data.status === "running" || !s.ok || s.data.steps.some((step) => step.trashed)) return;
  const stateDir = ctx.project.paths.stateDir;
  const note = join(logDir(stateDir, s.data.runId), UNREACHED_FILE);
  const db = RunsDb.open(stateDir);
  let unreached: boolean;
  try {
    const confirmations = new Confirmations(db);
    if (confirmations.get(token)?.usedAt === null) {
      mkdirSync(dirname(note), { recursive: true });
      writeFileSync(note, token);
    }
    unreached = confirmations.spendUnused(token) || noted(note, token);
  } finally {
    db.close();
  }
  const dispatch = dispatchOf(ctx);
  if (dispatch && unreached) dispatch.confirmationNotNeeded = true;
}

function noted(path: string, token: string): boolean {
  try {
    return readFileSync(path, "utf8") === token;
  } catch {
    return false;
  }
}

function croftFrom(p: Problem): CroftError {
  const { severity: _s, docs: _d, code, ...init } = p;
  return new CroftError(isCode(code) ? code : "INTERNAL_ERROR", init);
}

export const run: CommandImpl<RunData | DryRunData> = {
  async run(ctx): Promise<CommandResult<RunData | DryRunData>> {
    const v = ctx.values;
    const project = ctx.project;
    const selectors = [...ctx.positionals];
    const from = str(v.from);
    const allowShrink = v["allow-shrink"] === true;
    const due = v.due === true;
    if (due) checkDueFlags(v);
    const flags: PlanFlags = {
      selectors, only: v.only === true, upstream: v.upstream === true, ...(from !== undefined ? { from } : {}), ...(due ? { due: { now: ctx.now() } } : {}),
    };
    if (v["dry-run"] === true) {
      // Always in this process: it reads runs.sqlite and the asset files, and never waits.
      if (dispatchOf(ctx)?.confirmToken !== undefined) refuseToken();
      const out = await dryRun({ project, ...flags, allowShrink, now: ctx.now() });
      return { data: out.data, problems: out.problems, next: out.next, exit: out.exit, ok: out.exit === 0 };
    }
    const runIdFlag = str(v["run-id"]);
    const detachedChild = v.detached === true;
    const events = v.events === true;
    if (runIdFlag !== undefined && !isRunId(runIdFlag)) {
      throw new CroftError("USAGE_ERROR", { message: `--run-id ${JSON.stringify(runIdFlag)} is not a run id`, hint: "--run-id is set by croft for a detached run; leave it out" });
    }
    // The confirmation being carried out, if any: from croft confirm in this process, or, in the detached child
    // of a confirmed run, from the grant croft confirm wrote for this run id. Never from argv; the grant
    // variable means nothing to any other run and is never passed on. A scheduled run carries none.
    let confirmToken = due ? undefined : dispatchOf(ctx)?.confirmToken;
    const grantSecret = ctx.processEnv[CONFIRM_GRANT_ENV];
    if (!due && detachedChild && runIdFlag !== undefined && grantSecret !== undefined) {
      confirmToken = redeemGrant(project.paths.stateDir, runIdFlag, grantSecret);
    }
    const followMs = str(v.follow) !== undefined ? parseWait(str(v.follow)!, "--follow") : DEFAULT_FOLLOW_MS;
    // A scheduled run never asks: it holds what needs a person instead.
    const interactive = ctx.isTTY.stdin && ctx.isTTY.stdout && !detachedChild && !due;
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

    let planned: RunPlan | undefined;
    if (!foreground) {
      // Report usage problems here, at once, rather than from a child nobody is watching.
      const plan = planned = await planFor(project, flags);
      checkRunFlags(plan, { selectors, ...(from !== undefined ? { from } : {}), allowShrink, ...(confirmToken !== undefined ? { confirmToken } : {}) });
      const willRun = plan.steps.some((s) => s.action !== "skip" && loadErrors(s).length === 0);
      if (willRun) {
        const runId = pickRunId(project.timezone, ctx.now());
        const childArgs = args.filter((a) => a !== "--events");
        const env: Record<string, string | undefined> = { ...ctx.processEnv, [CONFIRM_GRANT_ENV]: undefined };
        if (confirmToken !== undefined) env[CONFIRM_GRANT_ENV] = grantDetached(project.paths.stateDir, runId, confirmToken);
        const spawned = spawnDetachedRun({ root: project.root, stateDir: project.paths.stateDir, args: childArgs, runId, env });
        const res = await followRun({
          stateDir: project.paths.stateDir, runId, timeoutMs: followMs, spawned,
          ...(events ? { onEvent: (line: string) => ctx.render.progress(line) } : {}),
        });
        if (res.kind === "not_started") throw croftFrom(res.problem);
        if (confirmToken !== undefined) settleConfirmation(ctx, confirmToken, res.summary);
        return toResult(res.summary);
      }
    }

    // Nothing to detach for: the plan above runs here. A detached child plans again (the files may have changed
    // meanwhile); its refusal before the run exists is recorded for the parent and `croft wait`, as the engine
    // records its own.
    let plan: RunPlan;
    try {
      plan = planned ?? await planFor(project, flags);
    } catch (e) {
      if (detachedChild && runIdFlag !== undefined) {
        const err = croftError(e) ?? new CroftError("INTERNAL_ERROR", { message: String(e), hint: "report this croft bug" });
        writeNotStarted(project.paths.stateDir, runIdFlag, redactValue(jsonSafe(err.problem), ctx.env));
      }
      throw e;
    }
    const kinds = new Map(plan.steps.map((s) => [s.asset, s.kind]));

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
        project, env: ctx.env, selectors, argv, trigger: due ? "schedule" : confirmToken !== undefined ? "confirm" : "manual", human: !due, interactive, plan,
        ...(runIdFlag ? { runId: runIdFlag } : {}), ...(from !== undefined ? { from } : {}), allowShrink,
        ...(confirmToken !== undefined ? { confirmToken } : {}),
        ...(interactive && !ctx.json ? { prompt: askYesNo } : {}),
        noWait: v["no-wait"] === true, signal: ac.signal,
        ...(events ? { onEvent: (line: string) => ctx.render.progress(line) } : interactive && !ctx.json ? { onEvent: (_line: string, e: RunEvent) => {
          const text = progressLine(e, kinds);
          if (text) ctx.render.progress(text);
        } } : {}),
        ...(delays ? { retryDelaysMs: delays } : {}),
        ...(ctx.processEnv.CROFT_FAULT ? { fault: ctx.processEnv.CROFT_FAULT } : {}),
      });
      if (confirmToken !== undefined) settleConfirmation(ctx, confirmToken, out);
      // Nothing due is not an empty project: the template hint of an empty run does not apply.
      if (due && out.data.steps.length === 0) out.next = out.next.filter((n) => n.command !== "croft docs ingest");
      return toResult(out);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  },
  human(result, ctx) {
    const d = result.data;
    return "dryRun" in d ? formatDryRun(d) : formatRun(d, ctx);
  },
};

const DOING: Record<PlannedStep["kind"], string> = { rows: "fetching", file: "loading files", sql: "rebuilding", transform: "running" };

/** What a person at a terminal sees on stderr while a run works (the result follows on stdout). `kinds` names
 *  what each step does (an ingest fetches, an SQL transform rebuilds); without it every step is fetching. */
export function progressLine(e: RunEvent, kinds?: ReadonlyMap<string, PlannedStep["kind"]>): string | null {
  const assets = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));
  if (e.type === "step" && e.status === "running") {
    const doing = DOING[kinds?.get(String(e.asset)) ?? "rows"];
    return `${String(e.asset)}: ${doing}${Number(e.attempt) > 1 ? ` (attempt ${String(e.attempt)})` : ""}…`;
  }
  if (e.type === "retry") return `${String(e.asset)}: ${String(e.code)}; trying again at ${String(e.nextRetryAt)}`;
  if (e.type === "waiting") return `waiting for ${assets(e.assets)}: held by run ${assets(e.heldBy)}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Human output (§4.2)

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

function stepLines(s: StepResult): string[] {
  const head = (label: string, text: string) => `${label.padEnd(8)} ${s.asset.padEnd(18)} ${text}`;
  // The step's text column: 28, or further right after a name longer than its column.
  const pad = " ".repeat(head("", "").length);
  if (s.status === "failed") {
    const e = s.error;
    const attempt = s.attempt > 1 ? ` (attempt ${s.attempt} of ${s.maxAttempts})` : "";
    const retry = s.nextRetryAt ? ` · retry planned ${s.nextRetryAt}` : "";
    // A multi-line error (CHECK_FAILED's sample rows, "also failing: …") keeps its lines under the step's text,
    // as §3f shows it; the attempt goes with its first line.
    const [first, ...more] = (e ? `${e.code}: ${e.message}` : "failed").split("\n");
    return [head("failed", `${first}${attempt}${retry}`), ...more.map((l) => `${pad}${l}`), `${pad}${s.logsCommand}`];
  }
  if (s.status === "skipped") return [head("skipped", s.skippedBecause ?? s.reason)];
  if (s.status === "unchanged") return [head("ok", `unchanged · ${s.reason}`)];
  const r = s.rows;
  const first: string[] = [];
  if (s.requests !== undefined && s.requests > 0) first.push(`${plural(s.requests, "request")}, ${plural(r.in, "row")} (${formatDuration(s.durationMs)})`);
  else first.push(`${plural(r.in, "row")} (${formatDuration(s.durationMs)})`);
  const added = s.schemaChanges.filter((c) => c.kind === "add_column").length;
  const widened = s.schemaChanges.filter((c) => c.kind === "widen").length;
  if (s.created) first.push(`new table, ${plural(s.created.columns, "column")}${s.created.jsonColumns ? ` (${formatCount(s.created.jsonColumns)} JSON)` : ""}`);
  if (added) first.push(`+${plural(added, "column")}`);
  if (widened) first.push(`${plural(widened, "column")} widened`);
  const second = [`added ${formatCount(r.added)}`, `updated ${formatCount(r.updated)}`, `unchanged ${formatCount(r.unchanged)}`];
  if (r.deleted) second.push(`deleted ${formatCount(r.deleted)}`);
  second.push(`${plural(r.total, "row")} now`);
  // Blocking checks and warnings apart (§4.2 "checks 3/3 ok · 1 warning"). A blocking check that fails fails its
  // step, so on an ok step a failing entry is a warning (one that failed, or could not run).
  const passed = s.checks.filter((c) => c.ok).length;
  const warned = s.checks.length - passed;
  if (passed) second.push(`checks ${formatCount(passed)}/${formatCount(passed)} ok`);
  if (warned) second.push(plural(warned, "warning"));
  if (s.cursor?.after !== undefined && s.cursor.after !== s.cursor.before) second.push(`since → ${s.cursor.after}`);
  if (s.trashed) second.push(`previous ${plural(s.trashed.rows, "row")} in the trash`);
  const lines = [head("ok", first.join(" · ")), `${pad}${second.join(" · ")}`];
  if (s.csvHeader) {
    const how = { declared: "as declared", sniffed: "detected", known: "matches the stored columns" }[s.csvHeader.from];
    const shown = s.csvHeader.columns.slice(0, 6).join(", ") + (s.csvHeader.columns.length > 6 ? ", …" : "");
    lines.push(s.csvHeader.header
      ? `${pad}CSV header: first line (${how}): ${shown}`
      : `${pad}CSV header: none (${how}); the first line is data, columns named ${shown}`);
  }
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


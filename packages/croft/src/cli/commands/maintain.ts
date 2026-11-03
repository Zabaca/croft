// croft maintain [--dry-run] [--orphans] (DESIGN.md §4.1, §6 "Maintenance of a lake", D149 to D152; option 07, slice 3): the lake's housekeeping
// by hand. Its spec (usage, options) is in commands/index.ts; the work is db/lake-pass.ts and db/lake-maintenance.ts.
//
// A project whose warehouse is a lake gets its maintenance from croft itself, after a run and from the scheduler once the last pass is
// `lake.maintenance.everyHours` old. This is the same pass on demand: flush the rows the catalog holds into files, expire the snapshots
// outside the trash's promise (30 days or 5 versions per asset, and the snapshots the trash pins), merge small files, rewrite files
// dominated by deletes, and delete the files nothing refers to. It runs under croft's lock on the lake's writes, so it never runs while a
// write holds the lock and a write waits for it. It removes nothing the promise keeps, so it needs no confirmation (an agent may run it).
//
// - `--dry-run` reads the lake with the read-only login and says what a pass would do: no lock, no write, nothing deleted.
// - `--orphans` is the one part that deletes what croft cannot vouch for: files in the lake's folder, older than a day, that the catalog
//   does not name. It lists them first (the dry run), and deleting them needs `croft confirm <token>` like every destructive step. The
//   token is tied to the list: a different list is CONFIRMATION_STALE. A pass never does it.
// - `--due` (hidden) is the scheduler's: a pass only if one is due, as the one after a run is.
//
// The lake's own maintenance is never CHECKPOINT and never an option set on the lake (db/warehouse.ts refuseOnLake).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CroftError, problem } from "../../core/errors.ts";
import type { LockHolder, Problem } from "../../core/types.ts";
import { RunsDb, RUNS_DB_FILE } from "../../history/runs-db.ts";
import { deleteOrphansOf, listOrphansOf, type MaintenancePlan, maintainIfDue, maintainProject, type PassOutcome, planProject, retryKnob } from "../../db/lake-pass.ts";
import { orphanCutoff } from "../../db/lake-maintenance.ts";
import { type MaintenanceView, maintenanceView, readState } from "../../db/lake-maintenance-state.ts";
import type { LakeStats, PassReport, StepReport } from "../../db/lake-maintenance.ts";
import { Confirmations, type HashedImpact } from "../../safety/confirm.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { dispatchOf } from "../main.ts";
import { formatCount, formatDuration } from "../render.ts";
import { confirmationProblem, plural, prompter } from "./delete.ts";
import { formatBytes } from "./doctor.ts";

/** `croft maintain --json`'s data. */
export interface MaintainData {
  /** Where the lake is, with no credential. */
  lake: string;
  /** ran / failed: a pass was made, and every step worked or one still failed after its retries. planned: --dry-run. not_due: --due, and none is.
   *  no_lake: nobody has written the lake yet. busy / backup_running / running: nothing was done, the lake is in use. orphans: the files listed
   *  (nothing deleted). needs_confirmation: a token was issued (exit 5). declined: the person said no. orphans_deleted: done. */
  status: "ran" | "failed" | "planned" | "not_due" | "no_lake" | "busy" | "backup_running" | "running" | "orphans" | "needs_confirmation" | "declined" | "orphans_deleted";
  /** The pass made: its steps, the lake's counts before and after, and what the promise kept. */
  report: PassReport | null;
  /** --dry-run: what a pass would expire and keep, and the lake's counts now. */
  plan: MaintenancePlan | null;
  /** --orphans: the files that are not the lake's own and older than `olderThan` (a day before the list was made), and how many were deleted. */
  orphans: { files: string[]; deleted: number; olderThan: string } | null;
  /** Whether croft runs passes by itself, when the last worked and when the next is due. */
  auto: MaintenanceView;
}

const COMMAND = "croft maintain --orphans";

function autoOf(ctx: Ctx): MaintenanceView {
  let state = null;
  if (existsSync(join(ctx.project.paths.stateDir, RUNS_DB_FILE))) {
    const runs = RunsDb.open(ctx.project.paths.stateDir);
    try {
      state = readState(runs);
    } finally {
      runs.close();
    }
  }
  return maintenanceView(state, ctx.project.config.lake!.maintenance, ctx.now());
}

function data(ctx: Ctx, status: MaintainData["status"], o: Partial<Pick<MaintainData, "report" | "plan" | "orphans">> = {}): MaintainData {
  return { lake: ctx.project.databaseLabel, status, report: o.report ?? null, plan: o.plan ?? null, orphans: o.orphans ?? null, auto: autoOf(ctx) };
}

export const maintain: CommandImpl<MaintainData> = {
  async run(ctx): Promise<CommandResult<MaintainData>> {
    const project = ctx.project;
    if (!project.config.lake) {
      throw new CroftError("MAINTAIN_NEEDS_LAKE", {
        message: "croft maintain is for a project whose warehouse is a lake; this project keeps its warehouse in a file",
        hint: "a file needs no maintenance of this kind (croft keeps its trash and backups short itself); a lake is named in croft.json (croft docs lake)",
        fix: { kind: "command", description: "read how lake mode works", command: "croft docs lake" },
        effect: "nothing was changed",
      });
    }
    if (ctx.values.orphans === true) return orphans(ctx);
    if (ctx.values["dry-run"] === true) {
      const plan = await planProject(project, ctx.env, { now: ctx.now() });
      return { data: data(ctx, plan ? "planned" : "no_lake", { plan }), problems: expiryProblems(plan), next: plan && plan.expire > 0 ? [{ command: "croft maintain", reason: "run the pass the plan describes" }] : [] };
    }
    const input = {
      now: ctx.now(), isTTY: ctx.isTTY.stdin && ctx.isTTY.stdout, ...retryKnob(ctx.processEnv),
      onStep: (step: string) => ctx.render.progress(`lake maintenance: ${step}`),
      onWait: (h: LockHolder, ms: number) => ctx.render.progress(`waiting for the lake: ${h.action === "maintenance" ? "another pass" : `croft run ${h.runId ?? h.pid}`} holds it (${Math.round(ms / 1000)} s so far)`),
    };
    const outcome = ctx.values.due === true ? await maintainIfDue(project, ctx.env, input) : await maintainProject(project, ctx.env, input);
    if (outcome === null) return { data: data(ctx, "not_due"), problems: [], next: [] };
    return fromOutcome(ctx, outcome);
  },

  human(result) {
    return format(result.data);
  },
};

function fromOutcome(ctx: Ctx, o: PassOutcome): CommandResult<MaintainData> {
  const d = data(ctx, o.status, { report: o.report ?? null });
  switch (o.status) {
    case "ran":
      return { data: d, problems: [], next: [] };
    case "failed":
      return { data: d, problems: o.problem ? [o.problem] : [], next: [{ command: "croft doctor", reason: "see the lake and its maintenance" }], ok: false, exit: 1 };
    case "no_lake":
      return { data: d, problems: [], next: [{ command: "croft run", reason: "the first run creates the lake" }] };
    case "busy":
      return { data: d, problems: o.problem ? [o.problem] : [], next: [], ok: false, exit: 4 };
    case "backup_running":
    case "running": {
      const p: Problem = problem("DB_BUSY", {
        message: o.status === "running" ? "another lake maintenance pass is running" : "a backup of the lake is copying its bucket; a pass would delete files it needs",
        hint: "run croft maintain again when it has finished", retryable: true,
      });
      return { data: d, problems: [p], next: [], ok: false, exit: 4 };
    }
    default:
      return { data: d, problems: [], next: [] };
  }
}

/** Another tool's age-based expiry on the lake: a warning, with what to do. */
function expiryProblems(plan: MaintenancePlan | null): Problem[] {
  if (!plan || plan.expiryOptions.length === 0) return [];
  return [expiryOptionProblem(plan.expiryOptions)];
}

export function expiryOptionProblem(options: readonly { name: string; value: string }[]): Problem {
  return problem("LAKE_EXPIRY_OPTION", {
    message: `the lake has an age-based expiry set by another tool (${options.map((o) => `${o.name} = ${o.value}`).join(", ")}): a CHECKPOINT by anyone would expire versions the trash promises to keep`,
    hint: "croft never runs CHECKPOINT and its maintenance expires by an explicit list, so croft keeps its promise; ask the user whether the setting can be removed, and tell whoever runs other tools on this lake never to run CHECKPOINT on it (croft docs LAKE_EXPIRY_OPTION)",
    fix: { kind: "manual", description: "ask the user: remove the lake's expire_older_than option, and keep CHECKPOINT away from the lake", requiresHuman: true },
    details: { options: options.map((o) => ({ name: o.name, value: o.value })) },
  });
}

// ---- Files that are not the lake's own ---------------------------------------------------------------------------

const hashFiles = (files: readonly string[]): string => createHash("sha256").update(JSON.stringify(files)).digest("hex");

function orphanImpact(files: readonly string[], cutoff: Date): HashedImpact {
  return {
    asset: "the lake's folder", action: "delete files the lake does not own from", rows: 0, files: files.length, asOf: cutoff.toISOString(), downstream: [],
    generation: hashFiles([cutoff.toISOString(), ...files]),
  };
}

async function orphans(ctx: Ctx): Promise<CommandResult<MaintainData>> {
  const project = ctx.project;
  const stateDir = project.paths.stateDir;
  const token = dispatchOf(ctx)?.confirmToken;
  // The age a file must be older than is fixed when the list is made, and the confirmation carries it: confirming lists and deletes with the
  // cutoff the person was shown, not with a clock that has moved on.
  let cutoff = orphanCutoff(ctx.now());
  if (token !== undefined && existsSync(join(stateDir, RUNS_DB_FILE))) {
    const peek = RunsDb.open(stateDir);
    try {
      const asOf = new Confirmations(peek).get(token)?.impact.asOf;
      if (asOf !== undefined && !Number.isNaN(Date.parse(asOf))) cutoff = new Date(asOf);
    } finally {
      peek.close();
    }
  }
  const found = await listOrphansOf(project, ctx.env, cutoff);
  if (found === null) return { data: data(ctx, "no_lake"), problems: [], next: [{ command: "croft run", reason: "the first run creates the lake" }] };
  const listed = { files: found, deleted: 0, olderThan: cutoff.toISOString() };
  if (found.length === 0 || ctx.values["dry-run"] === true) return { data: data(ctx, "orphans", { orphans: listed }), problems: [], next: [] };
  const runs = RunsDb.open(stateDir);
  try {
    const confirmations = new Confirmations(runs);
    const token = dispatchOf(ctx)?.confirmToken;
    const ask = ctx.isTTY.stdin && ctx.isTTY.stdout && !ctx.json;
    const head = `delete ${plural(found.length, "file")} from the lake's folder that the lake does not own (older than a day)`;
    if (token === undefined) {
      if (!ask) {
        const c = confirmations.create({ command: COMMAND, impact: orphanImpact(found, cutoff) });
        return {
          data: data(ctx, "needs_confirmation", { orphans: listed }),
          problems: [confirmationProblem(c, head, null, "they are gone for good: they are not in the trash, and not in any snapshot")],
          next: [], confirmation: c,
        };
      }
      const question = `${[head, ...found.slice(0, 20).map((f) => `  ${f}`), ...(found.length > 20 ? [`  and ${found.length - 20} more`] : [])].join("\n")}\nProceed? [y/N] `;
      if (!(await prompter.ask(question))) return { data: data(ctx, "declined", { orphans: listed }), problems: [], next: [], ok: false, exit: 1 };
    } else {
      // The list as it is now, against the one the person was shown: a different list is CONFIRMATION_STALE and nothing is deleted.
      await confirmations.consume(token, async () => orphanImpact((await listOrphansOf(project, ctx.env, cutoff)) ?? [], cutoff));
    }
    const done = await deleteOrphansOf(project, ctx.env, found, cutoff, { isTTY: ctx.isTTY.stdin && ctx.isTTY.stdout });
    if (done === null) {
      throw new CroftError("CONFIRMATION_STALE", {
        message: "the files in the lake's folder changed while you were answering; nothing was deleted",
        hint: "run croft maintain --orphans again to see the files now", effect: "nothing was changed",
        fix: { kind: "command", description: "list the files now", command: "croft maintain --orphans" },
      });
    }
    if (token === undefined) {
      try {
        confirmations.supersede(COMMAND, null);
      } catch {
        // The files are gone; a token left open meets a changed list.
      }
    }
    return { data: data(ctx, "orphans_deleted", { orphans: { files: done, deleted: done.length, olderThan: cutoff.toISOString() } }), problems: [], next: [] };
  } finally {
    runs.close();
  }
}

// ---- Words --------------------------------------------------------------------------------------------------------

const STEP_WORDS: Record<string, (s: StepReport) => string> = {
  prune: (s) => `${plural(s.did.rows ?? 0, "superseded bookkeeping row")} removed from ${plural(s.did.tables ?? 0, "log")}`,
  flush: (s) => `${plural(s.did.rows ?? 0, "row")} of ${plural(s.did.tables ?? 0, "table")} moved out of the catalog into files`,
  expire: (s) => `${plural(s.did.snapshots ?? 0, "snapshot")} expired`,
  merge: (s) => `${plural(s.did.merged ?? 0, "file")} merged into ${s.did.created ?? 0}`,
  rewrite: (s) => `${plural(s.did.tables ?? 0, "table")} rewritten`,
  cleanup: (s) => `${plural(s.did.files ?? 0, "file")} deleted`,
};

function statsLine(a: LakeStats, b: LakeStats): string {
  return [
    `snapshots ${formatCount(a.snapshots)} → ${formatCount(b.snapshots)}`, `files ${formatCount(a.dataFiles)} → ${formatCount(b.dataFiles)}`,
    `inlined tables ${formatCount(a.inlinedTables)} → ${formatCount(b.inlinedTables)}`, `waiting for deletion ${formatCount(a.pendingDeletion)} → ${formatCount(b.pendingDeletion)}`,
  ].join(" · ");
}

function format(d: MaintainData): string {
  const lines: string[] = [];
  const auto = d.auto.enabled
    ? `croft runs a pass by itself every ${plural(d.auto.everyHours, "hour")}${d.auto.lastOkAt ? `; the last that worked was at ${d.auto.lastOkAt}` : ""}`
    : "croft does not run passes by itself here (lake.maintenance.enabled is false)";
  switch (d.status) {
    case "ran":
    case "failed": {
      const r = d.report!;
      lines.push(d.status === "ran" ? `Lake maintenance done in ${formatDuration(r.tookMs)} (${d.lake})` : `Lake maintenance stopped at a failed step (${d.lake})`);
      for (const s of r.steps) {
        const detail = s.status === "ok" ? STEP_WORDS[s.step]!(s) : s.status === "failed" ? `failed after ${plural(s.attempts, "try")}: ${s.error ?? ""}` : "not run";
        lines.push(`  ${s.step.padEnd(8)} ${s.status.padEnd(7)} ${formatDuration(s.tookMs).padStart(8)}  ${detail}`);
      }
      lines.push(statsLine(r.before, r.after));
      lines.push(`kept ${formatCount(r.plan.kept)} of ${formatCount(r.plan.total)} snapshots: ${formatCount(r.plan.because.window)} from the last 30 days, ${formatCount(r.plan.because.versions)} as an asset's newest versions, ${formatCount(r.plan.because.pinned)} pinned by the trash`);
      lines.push(auto);
      break;
    }
    case "planned": {
      const p = d.plan!;
      lines.push(`A pass would expire ${plural(p.expire, "snapshot")} and keep ${formatCount(p.kept)} of ${formatCount(p.total)} (${d.lake})`);
      lines.push(`  kept: ${formatCount(p.because.window)} from the last 30 days, ${formatCount(p.because.windowStart)} as the state at the window's start, ${formatCount(p.because.versions)} as an asset's newest versions, ${formatCount(p.because.pinned)} pinned by the trash`);
      lines.push(`  now: ${formatCount(p.stats.snapshots)} snapshots · ${formatCount(p.stats.dataFiles)} files (${formatBytes(p.stats.liveBytes)} live) · ${formatCount(p.stats.inlinedTables)} inlined tables · ${formatCount(p.stats.pendingDeletion)} files waiting for deletion`);
      lines.push("Nothing was changed.", auto);
      break;
    }
    case "not_due":
      lines.push(`No pass is due yet (${auto}${d.auto.nextDueAt ? `; the next is due at ${d.auto.nextDueAt}` : ""})`);
      break;
    case "no_lake":
      lines.push(`Nothing to maintain: nobody has written ${d.lake} yet (the first croft run creates it)`);
      break;
    case "busy":
      lines.push(`The lake is in use; nothing was done (${d.lake})`);
      break;
    case "backup_running":
      lines.push("A backup of the lake is copying its bucket; a pass would delete files it needs. Nothing was done.");
      break;
    case "running":
      lines.push("Another lake maintenance pass is running. Nothing was done.");
      break;
    case "orphans":
      lines.push(d.orphans!.files.length === 0 ? `The lake's folder holds nothing the lake does not own (files a day old or more; ${d.lake})`
        : `${plural(d.orphans!.files.length, "file")} in the lake's folder that the lake does not own (a day old or more); nothing was deleted:`);
      for (const f of d.orphans!.files.slice(0, 50)) lines.push(`  ${f}`);
      if (d.orphans!.files.length > 50) lines.push(`  and ${d.orphans!.files.length - 50} more`);
      break;
    case "needs_confirmation": {
      lines.push(`needs confirmation: delete ${plural(d.orphans!.files.length, "file")} from the lake's folder that the lake does not own (older than a day); nothing was deleted yet`);
      for (const f of d.orphans!.files.slice(0, 20)) lines.push(`  ${f}`);
      if (d.orphans!.files.length > 20) lines.push(`  and ${d.orphans!.files.length - 20} more`);
      lines.push("  they are gone for good: not in the trash, not in any snapshot");
      break;
    }
    case "declined":
      lines.push("Nothing was deleted.");
      break;
    case "orphans_deleted":
      lines.push(`Deleted ${plural(d.orphans!.deleted, "file")} from the lake's folder that the lake did not own.`);
      break;
  }
  return lines.join("\n");
}

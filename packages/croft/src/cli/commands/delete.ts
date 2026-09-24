// croft delete <asset> [--where "<expr>"] (DESIGN.md §4.1, §6 "Destructive operations need confirmation", "Trash,
// restore and delete", "Guards aimed at agents"). Its spec (usage, --where) is in commands/index.ts; the work is
// safety/delete.ts.
//
// A destructive command, so:
// - It names one table exactly: a pattern (`orders_*`) or anything that is not an asset name is USAGE_ERROR.
// - It asks first. On a terminal (and without --json) it prints the impact and asks `Proceed? [y/N]`. Off a
//   terminal it changes nothing and exits 5 with `confirmation: {token, expiresAt, command, impact}`; the delete
//   then runs only through `croft confirm <token>`, which hands this command the token in-process (main.ts
//   Dispatch). Here the impact is counted again under the asset's lease and Confirmations.consume() spends the
//   token, or refuses it with CONFIRMATION_STALE when the impact changed (the scheduler added rows, say).
// - The rows go to the trash first (their own commit), then the delete commits. A whole table goes with its
//   _croft state and its catalog mirror entry, so `status` shows the asset as never built (its file stays); the
//   entry is kept in the trash version's sidecar for a restore.
// - Like a run, it starts with reconcile(), takes the asset's lease (waiting for a run that holds it) and records
//   itself in runs.sqlite: a run (trigger manual, or confirm) with one step whose reason is "deleted" (the whole
//   table) or "deleted rows", and a log for `croft logs <asset>`. A delete never appears in next[] (§4.3).
//
// The session and carryOut() below are shared with croft restore (restore.ts).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { CroftError, problem } from "../../core/errors.ts";
import type { Confirmation, Impact, LockHolder, Problem, StepResult } from "../../core/types.ts";
import { refreshReadCopy } from "../../db/readcopy.ts";
import { type DuckWarehouse, openWarehouse } from "../../db/warehouse.ts";
import { baseFrom, type CatalogAsset, getCatalog, putCatalog, readCatalogEntry } from "../../history/catalog.ts";
import { acquire, release } from "../../history/leases.ts";
import { logPath, openLog } from "../../history/logs.ts";
import { reconcile } from "../../history/reconcile.ts";
import { RunsDb } from "../../history/runs-db.ts";
import { NAME_PATTERN } from "../../project/discover.ts";
import type { Project } from "../../project/root.ts";
import { Confirmations, impactHash } from "../../safety/confirm.ts";
import { deleteImpact, deleteTable, deleteWhere, type DeleteImpact, type DeleteResult } from "../../safety/delete.ts";
import { annotateVersion, plannedTrashPath } from "../../safety/trash.ts";
import type { CommandImpl, CommandResult, Ctx, Next } from "../command.ts";
import { dispatchOf, shellQuote } from "../main.ts";
import { formatCount } from "../render.ts";

// ---------------------------------------------------------------------------------------------------------
// Shared with croft restore

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^\s*y(es)?\s*$/i.test(await rl.question(question));
  } finally {
    rl.close();
  }
}

/** How a terminal asks `Proceed? [y/N]` (tests replace it). */
export const prompter = { ask: askYesNo };

/** How long a delete or restore waits for a run that holds the asset (§5 "Default waits"); tests shorten it. */
export const MAINTAIN_WAITS = { ttyMs: 600_000, offTtyMs: 90_000 };

const PATTERN = /[*?[\]{}]/;

/** The one asset a destructive command names: an exact table name, never a pattern (§6 "Guards aimed at agents"). */
export function exactAsset(command: "delete" | "restore", name: string | undefined, usage: string): string {
  const fix = { kind: "command" as const, description: "list the assets and their tables", command: "croft status" };
  if (name === undefined || name.trim() === "") {
    throw new CroftError("USAGE_ERROR", { message: `croft ${command} needs the name of one asset`, hint: `usage: ${usage}`, fix });
  }
  if (PATTERN.test(name)) {
    throw new CroftError("USAGE_ERROR", {
      message: `croft ${command} takes one exact asset name, not a pattern: ${name}`,
      hint: `name one table exactly (croft status lists them); croft ${command} never takes patterns, so one command cannot touch several tables`,
      fix, details: { asset: name },
    });
  }
  if (!NAME_PATTERN.test(name)) {
    throw new CroftError("USAGE_ERROR", {
      message: `"${name}" is not an asset name: asset names are lowercase letters, digits and _, starting with a letter`,
      hint: "name the table exactly as croft status lists it",
      fix, details: { asset: name },
    });
  }
  return name;
}

/** A path as a person reads it: relative to the project when inside it. */
export function shownPath(project: Project, path: string): string {
  const rel = relative(project.root, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** "daily, report" (or "nothing"). */
export function names(list: readonly string[]): string {
  return list.length ? list.join(", ") : "nothing";
}

export const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

/** What a delete or restore works with: runs.sqlite, the warehouse (read-write, a writing command's), reconciled. */
export interface Session {
  project: Project;
  runs: RunsDb;
  warehouse: DuckWarehouse;
  /** A terminal on both ends and no --json: the command asks y/N instead of issuing a token. */
  ask: boolean;
  /** The token `croft confirm` carries, when it runs this command. */
  token: string | undefined;
  /** reconcile()'s own problems (a crashed run it could not check). */
  problems: Problem[];
}

function holderWords(h: LockHolder): string {
  if (h.runId) return `croft (${h.runId})`;
  return `${h.program ?? "another program"}${h.pid !== null ? ` (PID ${h.pid})` : ""}`;
}

/** Open the session: every command that writes starts with reconcile() (§5 "Crash recovery"). */
export async function openSession(ctx: Ctx, label: string): Promise<Session> {
  const project = ctx.project;
  const paths = project.paths;
  mkdirSync(paths.stateDir, { recursive: true });
  // runs.sqlite keeps its own clock, as croft confirm reads it: a token's 15 minutes are real minutes.
  const runs = RunsDb.open(paths.stateDir);
  const tty = ctx.isTTY.stdin && ctx.isTTY.stdout;
  let warehouse: DuckWarehouse | undefined;
  try {
    warehouse = openWarehouse({
      path: paths.database, mode: "read_write", timezone: project.timezone, root: project.root, stateDir: paths.stateDir, isTTY: tty,
      lookupHolder: (pid) => {
        const h = runs.getLockHolder();
        return h && h.pid === pid ? h : null;
      },
      onWait: (h, ms) => {
        runs.registerWaiter(label);
        ctx.render.progress(`waiting for the warehouse: ${holderWords(h)} holds it (${Math.round(ms / 1000)} s so far)`);
      },
    });
    const rec = await reconcile({ db: runs, warehouse });
    for (const dir of rec.stagingDirs) rmSync(dir, { recursive: true, force: true });
    return { project, runs, warehouse, ask: tty && !ctx.json, token: dispatchOf(ctx)?.confirmToken, problems: rec.problems };
  } catch (e) {
    runs.close();
    await warehouse?.close();
    throw e;
  }
}

export async function closeSession(s: Session): Promise<void> {
  try {
    s.runs.unregisterWaiter();
  } catch {
    // The next reconcile tidies it.
  }
  s.runs.close();
  await s.warehouse.close();
}

/** The confirmation of a pending destructive command (exit 5): nothing was changed. `first` says what goes to the
 *  trash first (null: nothing). */
export function confirmationProblem(c: Confirmation, message: string, first: string | null): Problem {
  return problem("CONFIRMATION_REQUIRED", {
    asset: c.impact.asset,
    message: `needs confirmation: ${message}`,
    hint: `${first ? `first ${first}; ` : ""}ask the user, and only if they agree: croft confirm ${c.token} (valid 15 min)`,
    effect: "nothing was changed",
    fix: { kind: "manual", requiresHuman: true, description: `show the user this impact; only after an explicit yes: croft confirm ${c.token}` },
    details: { token: c.token, expiresAt: c.expiresAt, command: c.command, impact: c.impact },
  });
}

function changedSinceAsked(shown: Impact, now: Impact, command: string): CroftError {
  return new CroftError("CONFIRMATION_STALE", {
    asset: shown.asset,
    message: `the impact changed while you were answering: now ${now.action} of ${now.asset}, ${plural(now.rows, "row")} (you said yes to ${plural(shown.rows, "row")})`,
    hint: `nothing was changed; run ${command} again to see the impact now`,
    effect: "nothing was changed",
    fix: { kind: "command", description: "see the impact now", command },
    details: { impact: now, previousImpact: shown },
  });
}

/** What the run record of a delete or restore says about its one step. */
export interface StepRecord {
  reason: string;
  behavior: string;
  rows: StepResult["rows"];
  trashed: { path: string; rows: number } | null;
  /** Lines for the step's log (croft logs <asset>). */
  lines: string[];
}

export interface CarryOut<T> {
  asset: string;
  /** The command a person runs again: shown in CONFIRMATION_STALE's fix. */
  command: string;
  /** runs.argv of the record: the command's own arguments. */
  argv: string[];
  /** The lock holder's action, for other processes that wait on the file. */
  action: string;
  /** The impact the person said yes to at the terminal; null with a token (consume() compares the stored one). */
  shown: Impact | null;
  /** The impact now, under the asset's lease. */
  impact(): Promise<Impact>;
  act(runId: string): Promise<T>;
  record(value: T): StepRecord;
}

/**
 * Carry out a confirmed delete or restore, like one step of a run: a run record, the asset's lease (waiting as a
 * run waits), the impact again, the consent (the token spent, or the terminal's yes checked against the impact
 * now), then the action, and the step and its log. A failure fails the run record and is rethrown.
 */
export async function carryOut<T>(ctx: Ctx, s: Session, a: CarryOut<T>): Promise<{ value: T; runId: string }> {
  const started = Date.now();
  const stateDir = s.project.paths.stateDir;
  const run = s.runs.createRun({ trigger: s.token !== undefined ? "confirm" : "manual", human: true, argv: a.argv, timeZone: s.project.timezone });
  const runId = run.id;
  try {
    await acquire(s.runs, [a.asset], runId, {
      waitMs: s.ask ? MAINTAIN_WAITS.ttyMs : MAINTAIN_WAITS.offTtyMs,
      onWait: (busy) => ctx.render.progress(`waiting for ${a.asset}: run ${busy.map((b) => b.runId).join(", ")} holds it`),
    });
    s.runs.setRunProgress(runId, { asset: a.asset, phase: "write", rowsFetched: 0, requests: 0, elapsedMs: 0 });
    const impact = await a.impact();
    if (s.token !== undefined) await new Confirmations(s.runs).consume(s.token, () => impact);
    else if (!a.shown || impactHash(impact) !== impactHash(a.shown)) throw changedSinceAsked(a.shown ?? impact, impact, a.command);
    s.runs.setLockHolder({ runId, asset: a.asset, action: a.action });
    let value: T;
    try {
      value = await a.act(runId);
    } finally {
      s.runs.clearLockHolder();
    }
    // It committed: from here on, bookkeeping trouble must not report the command as failed. A run left running
    // by a failure here is marked crashed by the next reconcile, which is all it would say.
    try {
      const rec = a.record(value);
      const log = openLog(stateDir, runId, a.asset, { redact: (t) => ctx.env.redact(t) });
      try {
        for (const line of rec.lines) log.write(line);
      } finally {
        log.close();
      }
      s.runs.startStep({ runId, asset: a.asset, attempt: 1, reason: rec.reason, logPath: logPath(stateDir, runId, a.asset) });
      const step: StepResult = {
        asset: a.asset, status: "ok", reason: rec.reason, behavior: rec.behavior, attempt: 1, maxAttempts: 1, rows: rec.rows,
        schemaChanges: [], checks: [], ...(rec.trashed ? { trashed: rec.trashed } : {}), logsCommand: `croft logs ${a.asset}`,
        durationMs: Date.now() - started,
      };
      s.runs.finishStep(runId, a.asset, 1, { status: "ok", reason: rec.reason, rows: { in: 0, added: rec.rows.added, updated: 0 } });
      s.runs.finishRun(runId, "succeeded", { data: { runId, status: "succeeded", steps: [step] }, problems: [], next: [], exit: 0, ok: true });
    } catch {
      // See above.
    }
    return { value, runId };
  } catch (e) {
    const p: Problem = e instanceof CroftError ? e.problem
      : problem("INTERNAL_ERROR", { message: String((e as Error)?.message ?? e), hint: "report this croft bug" });
    try {
      s.runs.finishRun(runId, "failed", { data: { runId, status: "failed", steps: [] }, problems: [{ ...p, runId }], next: [], exit: e instanceof CroftError ? e.exit : 1, ok: false });
    } catch {
      // The failure itself is what the person needs to see.
    }
    throw e;
  } finally {
    release(s.runs, runId);
  }
}

/** The asset's catalog mirror entry as the warehouse has it now (after a delete --where or a restore). `prev`
 *  supplies what only the definition knows (behavior words, the cursor field). The change has committed: a mirror
 *  that cannot be read now keeps its old entry until the asset's next run, rather than fail the command. */
export async function refreshCatalog(s: Session, asset: string, runId: string, prev: CatalogAsset | null): Promise<void> {
  try {
    const entry = await s.warehouse.read((sql) => readCatalogEntry(sql, baseFrom(prev, asset, runId)), { purpose: `catalog of ${asset}` });
    if (entry) putCatalog(s.runs, entry, "run");
    else s.runs.catalogDelete(asset);
  } catch {
    // See above.
  }
}

/** The read copy (readCopy: true) after a write, as the runner refreshes it; never fails the command. */
export async function afterWrite(project: Project): Promise<void> {
  try {
    await refreshReadCopy(project.root);
  } catch {
    // The command's result stands.
  }
}

// ---------------------------------------------------------------------------------------------------------
// croft delete

const USAGE = `croft delete <asset> [--where "<expr>"]`;

/** `croft delete --json`'s data. */
export interface DeleteData {
  asset: string;
  /** The predicate, as given; null for the whole table. */
  where: string | null;
  /** deleted: done. needs_confirmation: a token was issued (exit 5), nothing changed. declined: the person said no
   *  at the terminal. nothing_matched: --where matches no rows, so there was nothing to do. */
  status: "deleted" | "needs_confirmation" | "declined" | "nothing_matched";
  /** The rows deleted, or that would be. */
  rows: number;
  rowsBefore: number;
  rowsAfter: number;
  /** Every asset that has read it (they go stale, or have no input until it is built again). */
  downstream: string[];
  /** Where the rows went. */
  trashed: { path: string; rows: number } | null;
  /** The run record of a delete that ran. */
  runId: string | null;
}

/** The command `croft confirm` runs again. */
export function deleteCommand(asset: string, where: string | null): string {
  return ["croft", "delete", asset, ...(where !== null ? ["--where", where] : [])].map(shellQuote).join(" ");
}

function deleteAction(where: string | null): string {
  return where === null ? "delete the whole table" : `delete the rows where ${where}`;
}

function toImpact(project: Project, i: DeleteImpact, at: Date): Impact {
  return { asset: i.asset, action: deleteAction(i.where), rows: i.rows, trashPath: plannedTrashPath(project.paths.stateDir, i.asset, at), downstream: i.downstream };
}

/** The pending confirmation as §4.2 prints it: the impact, the trash first, what follows, and the confirm line. */
export function confirmationText(c: Confirmation | undefined, head: string, first: string | null, then: string | null): string {
  return [
    `needs confirmation: ${head}`, ...(first ? [`  first: ${first}`] : []), ...(then ? [`  then:  ${then}`] : []),
    ...(c ? [`  ask the user; if they agree: croft confirm ${c.token}    (valid 15 min)`] : []),
  ].join("\n");
}

/** The y/N question on a terminal: the impact, the trash first and what follows. */
export function questionText(head: string, first: string | null, then: string | null): string {
  return [head, ...(first ? [`  first: ${first}`] : []), ...(then ? [`  then:  ${then}`] : []), "Proceed? [y/N] "].join("\n");
}

/** The impact in words: the headline, then "first" (the trash) and "then" (downstream). */
function impactLines(i: DeleteImpact): { head: string; first: string; then: string | null } {
  const head = i.where === null
    ? `delete ${i.asset}, the whole table: ${plural(i.rows, "row")}`
    : `delete ${plural(i.rows, "row")} of ${i.asset} (of ${formatCount(i.rowsBefore)}) where ${i.where}`;
  const first = `the ${plural(i.rows, "row")} go to the trash (croft restore ${i.asset} brings them back)`;
  const then = !i.downstream.length ? null : i.where === null
    ? `${names(i.downstream)} read it: they keep their tables, and croft run skips them until ${i.asset} is built again`
    : `${names(i.downstream)} go stale: the next croft run rebuilds them`;
  return { head, first, then };
}

function question(i: DeleteImpact): string {
  const { head, first, then } = impactLines(i);
  return questionText(head, first, then);
}

function data(i: DeleteImpact, status: DeleteData["status"], o: { rowsAfter?: number; trashed?: DeleteData["trashed"]; runId?: string } = {}): DeleteData {
  return {
    asset: i.asset, where: i.where, status, rows: i.rows, rowsBefore: i.rowsBefore, rowsAfter: o.rowsAfter ?? i.rowsBefore,
    downstream: i.downstream, trashed: o.trashed ?? null, runId: o.runId ?? null,
  };
}

export const del: CommandImpl<DeleteData> = {
  async run(ctx): Promise<CommandResult<DeleteData>> {
    const asset = exactAsset("delete", ctx.positionals[0], USAGE);
    const raw = ctx.values.where;
    const where = typeof raw === "string" ? raw.trim() : null;
    if (where === "") {
      throw new CroftError("USAGE_ERROR", {
        asset, message: "--where is empty", hint: `--where takes one SQL condition over ${asset}'s columns: --where "created_at < '2024-01-01'"`,
        fix: { kind: "command", description: `see ${asset}'s columns`, command: `croft describe ${asset}` },
      });
    }
    const project = ctx.project;
    if (!existsSync(project.paths.database)) {
      throw new CroftError("UNKNOWN_TABLE", {
        asset, message: `there is no table named ${asset}: the warehouse has no tables yet`, hint: "croft status lists the assets; nothing was changed",
        effect: "nothing was changed", fix: { kind: "command", description: "list the assets", command: "croft status" },
      });
    }
    const command = deleteCommand(asset, where);
    const s = await openSession(ctx, `croft delete ${asset}`);
    let wrote = false;
    try {
      const problems = [...s.problems];
      let shown: Impact | null = null;
      if (s.token === undefined) {
        // Nothing is locked for the question: the impact is counted again under the lease, after the yes.
        const i = await deleteImpact(s.warehouse, asset, where);
        if (where !== null && i.rows === 0) return { data: data(i, "nothing_matched"), problems, next: [] };
        const impact = toImpact(project, i, ctx.now());
        if (!s.ask) {
          const c = new Confirmations(s.runs).create({ command, impact });
          const { head, first } = impactLines(i);
          problems.push(confirmationProblem(c, head, first));
          return { data: data(i, "needs_confirmation"), problems, next: [], confirmation: c };
        }
        if (!(await prompter.ask(question(i)))) return { data: data(i, "declined"), problems, next: [], ok: false, exit: 1 };
        shown = impact;
      }
      const prev = getCatalog(s.runs, asset);
      const { value: r, runId } = await carryOut<DeleteResult>(ctx, s, {
        asset, command, action: "delete", shown,
        argv: ["delete", ...ctx.argv.filter((a) => a !== "--json")],
        impact: async () => toImpact(project, await deleteImpact(s.warehouse, asset, where), ctx.now()),
        act: (id) => {
          const o = { runId: id, now: ctx.now(), ...(ctx.processEnv.CROFT_FAULT ? { fault: ctx.processEnv.CROFT_FAULT } : {}) };
          return where === null ? deleteTable(s.warehouse, asset, o) : deleteWhere(s.warehouse, asset, where, o);
        },
        record: (x) => ({
          reason: x.where === null ? "deleted" : "deleted rows",
          behavior: x.where === null ? "delete: the whole table went to the trash" : `delete: the rows where ${x.where} went to the trash`,
          rows: { in: 0, added: 0, updated: 0, unchanged: x.rowsAfter, deleted: x.rows, total: x.rowsAfter },
          trashed: { path: x.trashed.path, rows: x.trashed.rows },
          lines: [
            `${ctx.now().toISOString()} ${command}`,
            x.where === null ? `deleted ${x.asset}, the whole table (${plural(x.rows, "row")}), and its state` : `deleted ${plural(x.rows, "row")} of ${x.asset} where ${x.where}; ${plural(x.rowsAfter, "row")} left`,
            `trash: ${x.trashed.path}`,
            ...(x.downstream.length ? [`read by: ${names(x.downstream)}`] : []),
          ],
        }),
      });
      wrote = true;
      if (r.where === null) {
        // The asset is never built now; its entry stays with the trashed version, for a restore.
        if (prev) annotateVersion(r.trashed.path, { catalog: prev });
        s.runs.catalogDelete(asset);
      } else {
        await refreshCatalog(s, asset, runId, prev);
      }
      const next: Next[] = r.downstream.length ? [{ command: "croft status", reason: `see ${names(r.downstream)}, which read ${asset}` }] : [];
      return { data: data(r, "deleted", { rowsAfter: r.rowsAfter, trashed: { path: r.trashed.path, rows: r.trashed.rows }, runId }), problems, next };
    } finally {
      await closeSession(s);
      if (wrote) await afterWrite(project);
    }
  },
  human(result, ctx) {
    const d = result.data;
    const project = ctx.project;
    const i: DeleteImpact = { asset: d.asset, rows: d.rows, rowsBefore: d.rowsBefore, where: d.where, downstream: d.downstream };
    const { head, first, then } = impactLines(i);
    switch (d.status) {
      case "needs_confirmation":
        return confirmationText(result.confirmation, head, first, then);
      case "declined":
        return `not deleted: ${head} was not confirmed; nothing was changed`;
      case "nothing_matched":
        return `nothing to delete: --where ${d.where} matches none of the ${plural(d.rowsBefore, "row")} of ${d.asset}; nothing was changed`;
      case "deleted": {
        const what = d.where === null ? `deleted the whole table (${plural(d.rows, "row")})` : `deleted ${plural(d.rows, "row")} where ${d.where}; ${plural(d.rowsAfter, "row")} left`;
        const lines = [`ok    ${d.asset}   ${what}`];
        if (d.trashed) lines.push(`      in the trash: ${shownPath(project, d.trashed.path)} (croft restore ${d.asset} brings ${d.where === null ? "it" : "them"} back)`);
        if (then) lines.push(`      ${then}`);
        return lines.join("\n");
      }
    }
  },
};

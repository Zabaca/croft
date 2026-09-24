// `croft run <asset…> --rebuild` (DESIGN.md §4.1 "run flags", §6 "Destructive operations need confirmation",
// "Trash, restore and delete", §8 "Backfills", "What a code change does"): the named assets built from scratch.
//
// What a rebuild does, by kind (run/plan.ts marks the steps: PlannedStep.rebuild):
// - an SQL or full-refresh TS transform is recomputed in full, as every run of it is. It is recomputable, so it needs
//   no confirmation and nothing goes to the trash (§6): the runner runs it as it is;
// - an ingest refetches from scratch: no cursor, no file list. The history it holds may be gone at the source, so its
//   table goes to the trash first, after a confirmation (ConfirmAction "rebuild");
// - an incremental TS transform processes every input row again with the code as it is now: its positions reset. Its
//   code may pay for each row (an API, an LLM), so its table goes to the trash first, after a confirmation. The cost
//   guard's count (LARGE_REPROCESS, run/transform.ts rebuildGuard) is part of that confirmation (estimatedRequests,
//   and a count over confirmAbove asks even for an empty table): one token covers both, and the runner grants the
//   guard's own question for those rows.
//
// Rebuilds.prepare does it for one step, once per run, before the step's code runs (a retry after a busy database
// or a failed fetch goes on from where the step got to):
//   count     the table's rows (a read lease), and for a paid incremental transform every input row it would process
//   confirm   when the table has rows, or the guard's count is over confirmAbove: the run's ConfirmDecider (a y/N
//             question on a TTY, the token `croft confirm` carries, or a new token: the step is skipped with
//             CONFIRMATION_REQUIRED and nothing changes). A "no" fails the step with CONFIRMATION_REQUIRED
//   trash     the table and its _croft rows to .croft/trash/<asset>/ (safety/trash.ts), its own commit
//   reset     a second commit (one transaction cannot write two database files): the table dropped, and its state
//             deleted as for an asset never built: _croft.assets (the cursor), _croft.columns, _croft.files, and its
//             own positions in _croft.inputs. _croft.writes stays: the history of its writes, and stamps that keep
//             increasing. The catalog mirror's entry goes too, and a transform's staged chunk
// The step then runs as the asset's first build. A failure after the reset leaves the asset never built: its previous
// version is in the trash (Rebuilds.effect says where), and a plain `croft run <asset>` builds it again.
//
// CROFT_FAULT=between_trash_and_reset kills the process after the trash committed (crash tests): the table is as it
// was, with an extra trash file.
import { rmSync } from "node:fs";
import { CroftError, problem } from "../core/errors.ts";
import type { Confirmation, Impact, Problem, StepResult } from "../core/types.ts";
import { hasState } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import type { LogWriter } from "../history/logs.ts";
import type { RunsDb } from "../history/runs-db.ts";
import { currentDatabase, readTableSchema, tableRef } from "../load/evolve.ts";
import { plannedTrashPath, trashFailed, trashTable, type TrashEntry } from "../safety/trash.ts";
import { croftError, fault } from "./ingest.ts";
import { type PlannedStep, rebuildCommand, type StepKind } from "./plan.ts";
import type { ConfirmDecider, ConfirmRequest, StepOutcome } from "./step.ts";
import { type GuardCount, pendingChunkDir, rebuildGuard } from "./transform.ts";

/** The Impact actions of a rebuild's confirmation (hashed into its token with the rows at stake). */
export const REBUILD_ACTIONS = {
  rows: "ingest; --rebuild refetches from scratch",
  file: "file ingest; --rebuild loads every file again",
  transform: "incremental transform; --rebuild processes every input row again",
} as const;

/** Whether --rebuild of this step trashes its table and asks first: an ingest, or an incremental TS transform. An
 *  SQL or full-refresh TS transform is only recomputed. */
export function rebuildTrashes(step: Pick<PlannedStep, "kind" | "incremental">): boolean {
  return step.kind === "rows" || step.kind === "file" || (step.kind === "transform" && step.incremental.kind === "new-rows");
}

/** What the rebuild does after the trash, in words: "it is fetched from scratch", "every input row is processed again
 *  (about 4, and its code makes requests for them)". `would` for what has not happened yet. */
export function rebuildWords(kind: StepKind, o: { estimatedRequests?: number; would?: boolean } = {}): string {
  const be = o.would ? "would be" : "is";
  if (kind === "file") return `every file ${be} loaded again`;
  if (kind !== "transform") return `it ${be} fetched from scratch`;
  const paid = o.estimatedRequests !== undefined ? ` (about ${count(o.estimatedRequests)}, and its code makes requests for them)` : "";
  return `every input row ${be} processed again${paid}`;
}

/** The impact a rebuild's confirmation shows and hashes: the rows that go to the trash, what reads the asset, and for
 *  a paid transform the requests it would make. */
export function rebuildImpact(stateDir: string, step: Pick<PlannedStep, "asset" | "kind" | "readBy">, rows: number, estimatedRequests?: number): Impact {
  const action = step.kind === "file" ? REBUILD_ACTIONS.file : step.kind === "transform" ? REBUILD_ACTIONS.transform : REBUILD_ACTIONS.rows;
  return {
    asset: step.asset, action, rows, ...(rows > 0 ? { trashPath: plannedTrashPath(stateDir, step.asset) } : {}),
    downstream: [...step.readBy], ...(estimatedRequests !== undefined ? { estimatedRequests } : {}),
  };
}

/** The kind of step an impact's action is about (the words of a question or a dry run). */
export function rebuildKindOf(impact: Pick<Impact, "action">): StepKind {
  return impact.action === REBUILD_ACTIONS.file ? "file" : impact.action === REBUILD_ACTIONS.transform ? "transform" : "rows";
}

/** "the 3 rows of issues go to the trash, then it is fetched from scratch" ("its 3 rows" with `own`), or, with no
 *  rows, only what follows. */
function what(asset: string, impact: Impact, o: { would?: boolean; own?: boolean } = {}): string {
  const then = rebuildWords(rebuildKindOf(impact), { ...(impact.estimatedRequests !== undefined ? { estimatedRequests: impact.estimatedRequests } : {}), ...(o.would ? { would: true } : {}) });
  if (impact.rows === 0) return then;
  const rows = `${count(impact.rows)} row${impact.rows === 1 ? "" : "s"}`;
  return `${o.own ? `its ${rows}` : `the ${rows} of ${asset}`} ${o.would ? "would go" : "go"} to the trash, then ${then}`;
}

/** The y/N question on a TTY (runner.ts question): the impact, what reads the asset, then "Proceed? [y/N] ". */
export function rebuildQuestion(req: Pick<ConfirmRequest, "asset" | "impact">): string {
  const { asset, impact } = req;
  const first = impact.rows > 0
    ? `${asset}: its ${count(impact.rows)} row${impact.rows === 1 ? "" : "s"} go to the trash (.croft/trash/${asset}/), then ${rebuildWords(rebuildKindOf(impact), impact.estimatedRequests !== undefined ? { estimatedRequests: impact.estimatedRequests } : {})}`
    : `${asset}: ${what(asset, impact)}`;
  const down = impact.downstream.length ? [`  then: ${impact.downstream.join(", ")} update`] : [];
  return [first, ...down, "Proceed? [y/N] "].join("\n");
}

/** CONFIRMATION_REQUIRED for a pending rebuild: nothing was changed. */
export function rebuildConfirmation(c: Confirmation): Problem {
  const { asset } = c.impact;
  return problem("CONFIRMATION_REQUIRED", {
    asset,
    message: `needs confirmation (--rebuild): ${what(asset, c.impact)}`,
    hint: `${c.impact.rows > 0 ? `the old table stays in the trash (.croft/trash/${asset}/); ` : ""}ask the user, and only if they agree: croft confirm ${c.token} (valid 15 min)`,
    effect: "nothing was changed",
    fix: { kind: "manual", requiresHuman: true, description: `show the user this impact; only after an explicit yes: croft confirm ${c.token}` },
    details: {
      token: c.token, expiresAt: c.expiresAt, rows: c.impact.rows, trashPath: c.impact.trashPath ?? null,
      ...(c.impact.estimatedRequests !== undefined ? { estimatedRequests: c.impact.estimatedRequests } : {}),
    },
  });
}

/** A rebuild a person declined (on a TTY), or that nobody can confirm: the step fails and nothing changes. */
function declined(step: PlannedStep, impact: Impact): CroftError {
  const plain = step.kind === "transform" ? "to process only new input rows" : "to fetch only what is new";
  return new CroftError("CONFIRMATION_REQUIRED", {
    asset: step.asset, file: step.file,
    message: `${step.asset} was not rebuilt: ${what(step.asset, impact, { would: true, own: true })}, and that needs a yes`,
    hint: `nothing was changed; ${plain}, run it without --rebuild: croft run ${step.asset}`,
    effect: "nothing was changed",
    details: { rows: impact.rows, ...(impact.estimatedRequests !== undefined ? { estimatedRequests: impact.estimatedRequests } : {}) },
  });
}

export interface RebuildInput {
  step: PlannedStep;
  warehouse: DuckWarehouse;
  runs: RunsDb;
  runId: string;
  /** The state folder, canonical (the trash path in the impact). */
  stateDir: string;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
  log: LogWriter;
  /** The run's ConfirmDecider. Absent: nobody can say yes, so a rebuild that needs one fails. */
  confirm?: ConfirmDecider;
  /** CROFT_FAULT (crash tests). */
  fault?: string;
}

/** ready: the table is in the trash (when it had rows) and the asset is reset; run the step as its first build.
 *  pending: a token was issued (or deferred); the step is skipped with this outcome. */
export type RebuildPrep =
  | { kind: "ready"; trashed: TrashEntry | null; guard: GuardCount | null }
  | { kind: "pending"; outcome: StepOutcome };

interface Progress { rows: number; guard: GuardCount | null; trashed: TrashEntry | null; reset: boolean }

/** What --rebuild has done so far in one run, by asset: a retry of a step goes on from there, never trashing or
 *  asking twice. */
export class Rebuilds {
  readonly #steps = new Map<string, Progress>();

  /** The trash entry the rebuild of `asset` made in this run, if any. */
  trashed(asset: string): TrashEntry | null {
    return this.#steps.get(asset)?.trashed ?? null;
  }

  /** What a step that failed after its reset leaves: where the old rows are, and the run that builds the asset again
   *  (a cursor ingest or a chunked transform continues from what it saved). null when nothing was reset. */
  effect(asset: string): string | null {
    const p = this.#steps.get(asset);
    if (!p?.reset) return null;
    const old = p.trashed ? `its previous ${count(p.trashed.rows)} row${p.trashed.rows === 1 ? " is" : "s are"} in the trash (${p.trashed.path})` : "it had no rows to keep";
    return `${asset} was reset for --rebuild before this failure: ${old}; croft run ${asset} builds it again`;
  }

  /** Count, confirm, trash and reset, once per run (see the top of this file). Throws what fails the step. */
  async prepare(i: RebuildInput): Promise<RebuildPrep> {
    const { step, log } = i;
    const asset = step.asset;
    const started = Date.now();
    let p = this.#steps.get(asset);
    if (!p) {
      const rows = await tableRows(i.warehouse, asset, i.signal);
      const guard = step.kind === "transform" ? await rebuildGuard(step, i.warehouse, i.signal) : null;
      if (rows > 0 || (guard !== null && guard.pending > guard.limit)) {
        const impact = rebuildImpact(i.stateDir, step, rows, guard?.pending);
        const refused = declined(step, impact);
        if (!i.confirm) throw refused;
        const decision = await i.confirm({ asset, action: "rebuild", command: rebuildCommand(asset), impact, problem: refused.problem });
        if (decision.kind === "declined") throw refused;
        if (decision.kind === "pending") {
          const c = decision.confirmation;
          log.write(`needs confirmation ${c.token}: ${what(asset, impact)}`);
          const result: StepResult = {
            asset, status: "skipped", reason: "needs confirmation", behavior: step.behavior, attempt: i.attempt, maxAttempts: i.maxAttempts,
            skippedBecause: `${asset}: ${what(asset, impact, { would: true, own: true })}; confirmation ${c.token} is waiting for a human`,
            rows: { in: 0, added: 0, updated: 0, unchanged: 0, deleted: 0, total: rows }, schemaChanges: [], checks: [],
            logsCommand: `croft logs ${asset}`, durationMs: Date.now() - started,
          };
          return { kind: "pending", outcome: { result, warnings: [], problems: [rebuildConfirmation(c)], confirmation: c } };
        }
        log.write(`--rebuild confirmed: ${rows > 0 ? `moving the current ${count(rows)} rows of ${asset} to the trash first` : `${asset} has no rows to keep`}`);
      }
      p = { rows, guard, trashed: null, reset: false };
      this.#steps.set(asset, p);
      if (rows > 0) {
        try {
          p.trashed = await trashTable(i.warehouse, asset, `run --rebuild (${i.runId})`, { runId: i.runId, signal: i.signal });
        } catch (e) {
          this.#steps.delete(asset);
          // A busy database is worth a retry (the grant holds for this run), and Ctrl-C is the run's; anything else
          // stops here, before anything was changed.
          const known = croftError(e);
          if (known && (known.code === "DB_BUSY" || known.code === "DB_HELD_BY_OTHER_PROGRAM" || i.signal.aborted)) throw known;
          throw trashFailed(asset, e);
        }
        if (p.trashed) log.write(`moved ${count(p.trashed.rows)} rows of ${asset} to the trash: ${p.trashed.path}`);
        fault("between_trash_and_reset", i.fault);
      }
    }
    if (!p.reset) {
      await resetAsset(i.warehouse, asset, { runId: i.runId, signal: i.signal });
      p.reset = true;
      i.runs.catalogDelete(asset);
      if (step.kind === "transform") rmSync(pendingChunkDir(i.stateDir, asset), { recursive: true, force: true });
      log.write(`reset ${asset} for --rebuild: ${rebuildWords(step.kind, p.guard ? { estimatedRequests: p.guard.pending } : {})}`);
    }
    return { kind: "ready", trashed: p.trashed, guard: p.guard };
  }
}

/** The rows of the asset's table now; 0 when it has none (or no table). */
async function tableRows(warehouse: DuckWarehouse, asset: string, signal: AbortSignal): Promise<number> {
  return warehouse.read(async (db) => {
    const database = await currentDatabase(db);
    if (!(await readTableSchema(db, asset, database))) return 0;
    const [r] = await db.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${tableRef(database, asset)}`);
    return Number(r?.n ?? 0);
  }, { purpose: `count the rows of ${asset}`, signal });
}

/**
 * Make `asset` never built, in one transaction: drop its table, and delete its _croft state (assets, with the cursor;
 * columns; files; its own positions in inputs). _croft.writes stays: the write history, and the stamps that keep
 * the next one increasing. What other assets recorded about reading it (their positions) stays theirs.
 */
export async function resetAsset(warehouse: DuckWarehouse, asset: string, o: { runId: string; signal?: AbortSignal }): Promise<void> {
  await warehouse.write(`reset ${asset} for --rebuild`, async (tx) => {
    await tx.exec(`DROP TABLE IF EXISTS ${tableRef(await currentDatabase(tx), asset)}`);
    if (!(await hasState(tx))) return;
    await tx.exec(`DELETE FROM _croft.assets WHERE name = $1`, [asset]);
    for (const table of ["columns", "files", "inputs"]) await tx.exec(`DELETE FROM _croft.${table} WHERE asset = $1`, [asset]);
  }, { runId: o.runId, asset, ...(o.signal ? { signal: o.signal } : {}) });
}

const count = (n: number) => n.toLocaleString("en-US");

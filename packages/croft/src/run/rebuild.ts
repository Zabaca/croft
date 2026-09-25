// `croft run <asset…> --rebuild` (DESIGN.md §4.1 "run flags", §6 "Destructive operations need confirmation",
// "Trash, restore and delete", §8 "Backfills", "What a code change does"): the named assets built from scratch.
//
// What a rebuild does, by kind (run/plan.ts marks the steps: PlannedStep.rebuild):
// - an SQL or full-refresh TS transform is recomputed in full, as every run of it is. It is recomputable, so it needs
//   no confirmation and nothing goes to the trash (§6): the runner runs it as it is;
// - an ingest refetches from scratch: no cursor, no file list. The history it holds may be gone at the source, so its
//   table goes to the trash first, after a confirmation (ConfirmAction "rebuild"). What that confirmation's impact
//   names besides the rows (each a clause of Impact.action, rebuildNotes):
//   - the paid incremental transforms that read it with newRows() and have read it (PlannedStep.paidReaders): every
//     refetched row gets a new _loaded_at, so each processes every row again and pays for it. Impact.estimatedRequests
//     counts those rows, and the runner grants each one's cost guard for them (RebuildPrep.paid): one token, one yes;
//   - for a file ingest, the files gone from disk (or no longer matched) whose rows the table keeps (§3b): they do not
//     come back, and stay only in the trash;
//   - with --allow-shrink, that the refetch replaces the table even when it holds fewer than half of its rows.
// - an incremental TS transform processes every input row again with the code as it is now: its positions reset. Its
//   code may pay for each row (an API, an LLM), so its table goes to the trash first, after a confirmation. The cost
//   guard's count (LARGE_REPROCESS, run/transform.ts rebuildGuard) is part of that confirmation (estimatedRequests,
//   and a count over confirmAbove asks even for an empty table): one token covers both, and the runner grants the
//   guard's own question for those rows.
//
// Rebuilds.prepare does it for one step, once per run, before the step's code runs (a retry after a busy database
// or a failed fetch goes on from where the step got to):
//   count     the table's rows (a read lease), the readers that would pay again and the rows of gone files; for a paid
//             incremental transform every input row it would process
//   confirm   when the table has rows, or the guard's count is over confirmAbove: the run's ConfirmDecider (a y/N
//             question on a TTY, the token `croft confirm` carries, or a new token: the step is skipped with
//             CONFIRMATION_REQUIRED and nothing changes). A "no" fails the step with CONFIRMATION_REQUIRED
//   trash     the table and its _croft rows to .croft/trash/<asset>/ (safety/trash.ts), its own commit
//   reset     a later commit (one transaction cannot write two database files): the table dropped, and its state
//             deleted as for an asset never built: _croft.assets (the cursor), _croft.columns, _croft.files, and its
//             own positions in _croft.inputs. _croft.writes stays: the history of its writes, and stamps that keep
//             increasing.
//             - An ingest swaps at commit: the step reads no stored state (FreshStart), its first write resets the
//               asset in the transaction that writes the new rows, and the catalog mirror is then that write's. A
//               refetch that fails before it commits leaves the old table as it was (§5: a failed asset keeps its
//               old data), with a copy in the trash; one that fails after a monotone part committed keeps that part.
//               The swap has the shrink guard of §6: a refetch holding fewer than half of the old table's rows (an
//               expired token answering []) fails with SHRINK_GUARD and rolls the swap back, so the old table stays;
//               a monotone part never commits before the refetch holds half of them (FreshStart.holdRows). The
//               override is --allow-shrink, part of the rebuild's confirmation, or allowShrink: true in the code. The
//               swap stamps last_replaced_at past every version a reader recorded, so what read the old table is
//               stale even when the refetch wrote nothing.
//             - An incremental TS transform is reset in its own commit before its code runs (its chunks commit as
//               they go); the catalog mirror's entry goes too, and its staged chunk.
// The step then runs as the asset's first build. A failure after the reset leaves the asset without its old table
// (never built, or holding what the rebuild saved): its previous version is in the trash (Rebuilds.effect says where),
// a plain `croft run <asset>` builds it again, and `croft restore <asset>` brings the old version back.
//
// CROFT_FAULT=between_trash_and_reset kills the process after the trash committed (crash tests): the table is as it
// was, with an extra trash file.
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Confirmation, Impact, Problem, Sql, StepResult } from "../core/types.ts";
import { hasState } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import type { LogWriter } from "../history/logs.ts";
import type { RunsDb } from "../history/runs-db.ts";
import { RESERVED } from "../load/contract.ts";
import { currentDatabase, quoteIdent, readTableSchema, tableRef } from "../load/evolve.ts";
import type { HashedImpact } from "../safety/confirm.ts";
import { replacedStamp, tableGeneration } from "../safety/delete.ts";
import { type ExtractInfo, isoMicros, shrinkGuardDisabled, wouldShrink } from "../safety/guards.ts";
import { plannedTrashPath, trashFailed, trashTable, type TrashEntry } from "../safety/trash.ts";
import type { FileIngest } from "../types.ts";
import { croftError, fault, type FreshStart } from "./ingest.ts";
import { type PlannedStep, rebuildCommand, type StepKind } from "./plan.ts";
import type { ConfirmDecider, ConfirmRequest, StepOutcome } from "./step.ts";
import { type GuardCount, pendingChunkDir, rebuildGuard } from "./transform.ts";

/** The Impact actions of a rebuild's confirmation (hashed into its token with the rows at stake). What else the
 *  impact names follows as "; "-separated clauses (rebuildNotes). */
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

/** A paid incremental transform downstream of a rebuilt ingest: it would process `rows` input rows again. */
export interface PaidReader { asset: string; rows: number }

/** A file whose rows the table keeps although it is gone from disk (or no longer matched): a rebuild does not load
 *  it again. `rows` null when unknown (the dry run's mirror names the files only). */
export interface GoneFile { path: string; rows: number | null }

/** What a rebuild's impact names besides the rows that go to the trash (see the top of the file). */
export interface RebuildExtra {
  /** An incremental transform's cost guard count. */
  estimatedRequests?: number;
  paid?: readonly PaidReader[];
  gone?: readonly GoneFile[];
  allowShrink?: boolean;
  /** safety/delete.ts tableGeneration: hashed only, never shown. A token minted before the table was written, rebuilt,
   *  deleted or restored is stale afterwards (R41-11). */
  generation?: string | null;
}

/** The impact a rebuild's confirmation shows and hashes: the rows that go to the trash, what reads the asset, for a
 *  paid transform the requests it would make, and for an ingest the clauses of RebuildExtra. */
export function rebuildImpact(stateDir: string, step: Pick<PlannedStep, "asset" | "kind" | "readBy">, rows: number, extra: RebuildExtra = {}): HashedImpact {
  const base = step.kind === "file" ? REBUILD_ACTIONS.file : step.kind === "transform" ? REBUILD_ACTIONS.transform : REBUILD_ACTIONS.rows;
  const paid = step.kind === "transform" ? [] : extra.paid ?? [];
  const notes = step.kind === "transform" ? [] : [goneNote(extra.gone ?? []), paidNote(step.asset, paid), extra.allowShrink ? SHRINK_NOTE : null];
  const estimatedRequests = step.kind === "transform" ? extra.estimatedRequests : paid.length ? paid.reduce((n, p) => n + p.rows, 0) : undefined;
  return {
    asset: step.asset, action: [base, ...notes.filter((n): n is string => n !== null)].join("; "), rows,
    ...(rows > 0 ? { trashPath: plannedTrashPath(stateDir, step.asset) } : {}),
    downstream: [...step.readBy], ...(estimatedRequests !== undefined ? { estimatedRequests } : {}),
    ...(extra.generation !== undefined ? { generation: extra.generation } : {}),
  };
}

const SHRINK_NOTE = "--allow-shrink: the refetch replaces the table even with fewer than half of its rows";

/** "the 2 rows of 1 file no longer on disk (files/jan.csv) do not come back, and stay only in the trash". */
function goneNote(gone: readonly GoneFile[]): string | null {
  if (gone.length === 0) return null;
  const known = gone.every((g) => g.rows !== null);
  const rows = gone.reduce((n, g) => n + (g.rows ?? 0), 0);
  const shown = gone.slice(0, 3).map((g) => (known && gone.length > 1 ? `${g.path}: ${count(g.rows!)}` : g.path));
  const files = `${gone.length} file${gone.length === 1 ? "" : "s"} no longer on disk (${shown.join(", ")}${gone.length > 3 ? `, and ${gone.length - 3} more` : ""})`;
  return `${known ? `the ${count(rows)} row${rows === 1 ? "" : "s"}` : "the rows"} of ${files} do not come back, and stay only in the trash`;
}

/** "then labels processes all 10 rows of issues again, and its code makes requests for them (about 10)". */
function paidNote(asset: string, paid: readonly PaidReader[]): string | null {
  if (paid.length === 0) return null;
  const total = paid.reduce((n, p) => n + p.rows, 0);
  if (paid.length === 1) {
    const rows = paid[0]!.rows;
    return `then ${paid[0]!.asset} processes ${rows === 1 ? "the row" : `all ${count(rows)} rows`} of ${asset} again, and its code makes requests for ${rows === 1 ? "it" : "them"} (about ${count(total)})`;
  }
  const names = paid.map((p) => `${p.asset} (${count(p.rows)})`);
  return `then ${names.slice(0, -1).join(", ")} and ${names.at(-1)} process every row of ${asset} again, and their code makes requests for them (about ${count(total)})`;
}

/** The kind of step an impact's action is about (the words of a question or a dry run). */
export function rebuildKindOf(impact: Pick<Impact, "action">): StepKind {
  return impact.action.startsWith(REBUILD_ACTIONS.file) ? "file" : impact.action.startsWith(REBUILD_ACTIONS.transform) ? "transform" : "rows";
}

/** The clauses a rebuild's impact names besides its rows (gone files, readers that pay again, --allow-shrink). */
export function rebuildNotes(impact: Pick<Impact, "action">): string[] {
  const base = Object.values(REBUILD_ACTIONS).find((b) => impact.action.startsWith(b));
  return base ? impact.action.slice(base.length).split("; ").filter(Boolean) : [];
}

/** "the 3 rows of issues go to the trash, then it is fetched from scratch" ("its 3 rows" with `own`), or, with no
 *  rows, only what follows; then the impact's other clauses. */
function what(asset: string, impact: Impact, o: { would?: boolean; own?: boolean } = {}): string {
  const kind = rebuildKindOf(impact);
  const then = rebuildWords(kind, { ...(kind === "transform" && impact.estimatedRequests !== undefined ? { estimatedRequests: impact.estimatedRequests } : {}), ...(o.would ? { would: true } : {}) });
  const notes = rebuildNotes(impact).map((n) => `; ${n}`).join("");
  if (impact.rows === 0) return `${then}${notes}`;
  const rows = `${count(impact.rows)} row${impact.rows === 1 ? "" : "s"}`;
  return `${o.own ? `its ${rows}` : `the ${rows} of ${asset}`} ${o.would ? "would go" : "go"} to the trash, then ${then}${notes}`;
}

/** The y/N question on a TTY (runner.ts question): the impact, what else it names, what reads the asset, then
 *  "Proceed? [y/N] ". */
export function rebuildQuestion(req: Pick<ConfirmRequest, "asset" | "impact">): string {
  const { asset, impact } = req;
  const kind = rebuildKindOf(impact);
  const first = impact.rows > 0
    ? `${asset}: its ${count(impact.rows)} row${impact.rows === 1 ? "" : "s"} go to the trash (.croft/trash/${asset}/), then ${rebuildWords(kind, kind === "transform" && impact.estimatedRequests !== undefined ? { estimatedRequests: impact.estimatedRequests } : {})}`
    : `${asset}: ${rebuildWords(kind, kind === "transform" && impact.estimatedRequests !== undefined ? { estimatedRequests: impact.estimatedRequests } : {})}`;
  const notes = rebuildNotes(impact).map((n) => `  ${n}`);
  const down = impact.downstream.length ? [`  then: ${impact.downstream.join(", ")} update`] : [];
  return [first, ...notes, ...down, "Proceed? [y/N] "].join("\n");
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

/** SHRINK_GUARD for a rebuild's swap (§6): the refetch holds fewer than half of the rows it should bring back (the
 *  table's, less those of files gone from disk, which the confirmation named). The swap rolls back, so the old table
 *  stays (and a copy is in the trash). */
function rebuildShrink(asset: string, o: { rows: number; expected: number; rowsAfter: number; trashPath: string | null; extract: ExtractInfo; unfinished: boolean }): CroftError {
  const holds = `holds ${o.rowsAfter} row${o.rowsAfter === 1 ? "" : "s"}${o.unfinished ? " so far" : ""}`;
  const has = `its table has ${o.rows}${o.expected < o.rows ? ` (${o.expected} of them from files still there)` : ""}`;
  return new CroftError("SHRINK_GUARD", {
    asset,
    message: `the refetch of ${asset} for --rebuild ${holds}, and ${has}: croft does not replace a table with a refetch that has fewer than half of its rows`,
    hint: "an expired token or a changed filter often returns few or no rows; check what the source returned before overriding",
    effect: `nothing was written; ${asset} keeps its ${o.rows} rows${o.trashPath ? ` (a copy is in the trash too: ${o.trashPath})` : ""}`,
    fix: {
      kind: "manual", requiresHuman: true,
      description: `find out why the source returned ${o.rowsAfter} of ${o.expected} rows before overriding (${rebuildCommand(asset, { allowShrink: true })}, which asks first)`,
    },
    retryable: false,
    details: {
      rowsBefore: o.rows, rowsAfter: o.rowsAfter, ...(o.expected < o.rows ? { expected: o.expected } : {}), rebuild: true,
      ...(o.trashPath ? { trashPath: o.trashPath } : {}), ...o.extract,
    },
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
  /** --allow-shrink with --rebuild (an ingest): the refetch may replace the table even with fewer than half of its
   *  rows; the rebuild's confirmation says so. */
  allowShrink?: boolean;
  /** CROFT_FAULT (crash tests). */
  fault?: string;
}

/** ready: the table is in the trash (when it had rows); run the step as its first build. A transform is reset already;
 *  an ingest gets `fresh`, and its first write resets it in the same transaction (swap at commit). `paid`: the readers
 *  whose cost guard the confirmation covered, with the rows (the runner grants each). pending: a token was issued (or
 *  deferred); the step is skipped with this outcome. */
export type RebuildPrep =
  | { kind: "ready"; trashed: TrashEntry | null; guard: GuardCount | null; fresh?: FreshStart; paid?: PaidReader[] }
  | { kind: "pending"; outcome: StepOutcome };

interface Progress {
  rows: number;
  /** The rows an ingest's refetch should bring back: its rows, less those of files gone from disk. */
  expected: number;
  guard: GuardCount | null;
  paid: PaidReader[];
  trashed: TrashEntry | null;
  reset: boolean;
}

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
    const ingest = step.kind !== "transform";
    // allowShrink: true is a replace ingest's standing decision (§6); on a merge or append ingest it does nothing.
    const allowShrink = ingest && (i.allowShrink === true || (step.write === "replace" && step.spec?.allowShrink === true));
    let p = this.#steps.get(asset);
    if (!p) {
      const facts = await readFacts(i.warehouse, step, i.signal);
      const rows = facts.rows;
      const guard = step.kind === "transform" ? await rebuildGuard(step, i.warehouse, i.signal) : null;
      const paid = facts.readers.map((r) => ({ asset: r, rows }));
      if (rows > 0 || (guard !== null && guard.pending > guard.limit)) {
        const impact = rebuildImpact(i.stateDir, step, rows, {
          ...(guard ? { estimatedRequests: guard.pending } : {}), paid, gone: facts.gone, ...(ingest && i.allowShrink ? { allowShrink: true } : {}),
          generation: facts.generation,
        });
        const refused = declined(step, impact);
        if (!i.confirm) throw refused;
        const command = rebuildCommand(asset, { allowShrink: ingest && i.allowShrink === true });
        const decision = await i.confirm({ asset, action: "rebuild", command, impact, problem: refused.problem });
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
      const goneRows = facts.gone.reduce((n, g) => n + (g.rows ?? 0), 0);
      p = { rows, expected: rows - goneRows, guard, paid: rows > 0 ? paid : [], trashed: null, reset: false };
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
    if (!p.reset && ingest) {
      // An ingest keeps its old table until the refetch commits: its first write drops it (swap at commit).
      const progress = p;
      const { rows, expected } = p;
      const trashPath = p.trashed?.path ?? null;
      const fresh: FreshStart = {
        get done() {
          return progress.reset;
        },
        // A monotone part must hold half of the old rows before it may replace them.
        holdRows: allowShrink ? 0 : Math.ceil(expected / 2),
        reset: (tx) => resetInTx(tx, asset),
        replaced: async (tx, o) => {
          let warning: Problem | null = null;
          if (wouldShrink(expected, o.rows)) {
            if (!allowShrink) throw rebuildShrink(asset, { rows, expected, rowsAfter: o.rows, trashPath, extract: o.extract, unfinished: o.unfinished });
            const w = shrinkGuardDisabled(asset, { rowsBefore: rows, rowsAfter: o.rows });
            warning = {
              ...w, message: `${w.message}, rebuilt with --rebuild${trashPath ? `; the previous ${rows} rows are in the trash: ${trashPath}` : ""}`,
              details: { ...w.details, rebuild: true, ...(trashPath ? { trashPath, trashedRows: rows } : {}) },
            };
          }
          // What read the old table is stale now, even when the refetch wrote nothing (§5 input_replaced).
          const stamp = await replacedStamp(tx, asset, o.now);
          await tx.exec(`UPDATE _croft.assets SET last_replaced_at = $2::TIMESTAMPTZ WHERE name = $1`, [asset, isoMicros(stamp)]);
          return warning;
        },
        committed: () => {
          progress.reset = true;
          log.write(`reset ${asset} for --rebuild with its first commit: ${rebuildWords(step.kind)}`);
        },
      };
      return { kind: "ready", trashed: p.trashed, guard: p.guard, fresh, ...(p.paid.length ? { paid: p.paid } : {}) };
    }
    if (!p.reset) {
      await resetAsset(i.warehouse, asset, { runId: i.runId, signal: i.signal });
      p.reset = true;
      i.runs.catalogDelete(asset);
      rmSync(pendingChunkDir(i.stateDir, asset), { recursive: true, force: true });
      log.write(`reset ${asset} for --rebuild: ${rebuildWords(step.kind, p.guard ? { estimatedRequests: p.guard.pending } : {})}`);
    }
    return { kind: "ready", trashed: p.trashed, guard: p.guard, ...(p.paid.length ? { paid: p.paid } : {}) };
  }
}

/** What a rebuild's confirmation counts, under one read lease: the table's rows (0 when it has none, or no table),
 *  the paid readers (PlannedStep.paidReaders) that have read it, and for a file ingest the files gone from disk
 *  whose rows the table holds. */
async function readFacts(warehouse: DuckWarehouse, step: PlannedStep, signal: AbortSignal): Promise<{ rows: number; readers: string[]; gone: GoneFile[]; generation: string | null }> {
  const asset = step.asset;
  return warehouse.read(async (db) => {
    const database = await currentDatabase(db);
    const schema = await readTableSchema(db, asset, database);
    if (!schema) return { rows: 0, readers: [], gone: [], generation: null };
    const ref = tableRef(database, asset);
    const [r] = await db.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${ref}`);
    const rows = Number(r?.n ?? 0);
    let readers: string[] = [];
    const paid = step.paidReaders ?? [];
    if (rows > 0 && paid.length && (await hasState(db))) {
      // A reader that never read it processes every row in its first build anyway; only one that has, pays again.
      const seen = await db.all<{ asset: string }>(
        `SELECT DISTINCT asset FROM _croft.inputs WHERE input = $1 AND seen_loaded_at IS NOT NULL ORDER BY asset`, [asset]);
      readers = seen.map((s) => s.asset).filter((a) => paid.includes(a));
    }
    let gone: GoneFile[] = [];
    const fileCol = schema.find((c) => c.name.toLowerCase() === RESERVED.file);
    const config = step.loaded?.definition?.config as FileIngest | undefined;
    if (step.kind === "file" && rows > 0 && fileCol && config?.file !== undefined) {
      const files = await db.all<{ f: string | null; n: number | bigint }>(
        `SELECT ${quoteIdent(fileCol.name)} AS f, count(*) AS n FROM ${ref} GROUP BY 1 ORDER BY 1`);
      const specs = (Array.isArray(config.file) ? config.file : [config.file]).map((s) => String(s).trim()).filter(Boolean);
      const root = projectRoot(step);
      gone = files.filter((f) => f.f !== null && !stillThere(root, specs, f.f)).map((f) => ({ path: f.f!, rows: Number(f.n) }));
    }
    return { rows, readers, gone, generation: await tableGeneration(db, asset) };
  }, { purpose: `count the rows of ${asset}`, signal });
}

/** The project root, from a step's absolute path and its root-relative file. */
function projectRoot(step: Pick<PlannedStep, "path" | "file">): string {
  const up = step.file.split("/").length;
  let root = step.path;
  for (let n = 0; n < up; n++) root = resolve(root, "..");
  return root;
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Whether a file ingest's `_file` value is still loaded by a rebuild: a URL (fetched again), or a file on disk that one
 * of the ingest's specs names (literally, or through a glob), as load/files.ts identifies files: root-relative with
 * `/`, or absolute outside the root.
 */
function stillThere(root: string, specs: readonly string[], path: string): boolean {
  if (URL_LIKE.test(path)) return true;
  const abs = isAbsolute(path) ? path : join(root, ...path.split("/"));
  if (!existsSync(abs)) return false;
  return specs.some((spec) => {
    if (URL_LIKE.test(spec)) return false;
    if (resolve(root, spec) === abs) return true;
    if (!GLOB_CHARS.test(spec)) return false;
    const target = isAbsolute(spec) ? abs : relative(root, abs).split(sep).join("/");
    return new Bun.Glob(isAbsolute(spec) ? spec : spec.replace(/^(\.\/)+/, "")).match(target);
  });
}

/**
 * Make `asset` never built, in one transaction: drop its table, and delete its _croft state (assets, with the cursor;
 * columns; files; its own positions in inputs). _croft.writes stays: the write history, and the stamps that keep
 * the next one increasing. What other assets recorded about reading it (their positions) stays theirs.
 */
export async function resetAsset(warehouse: DuckWarehouse, asset: string, o: { runId: string; signal?: AbortSignal }): Promise<void> {
  await warehouse.write(`reset ${asset} for --rebuild`, (tx) => resetInTx(tx, asset), { runId: o.runId, asset, ...(o.signal ? { signal: o.signal } : {}) });
}

/** resetAsset's statements, inside a transaction the caller commits: an ingest's first write of a --rebuild. */
export async function resetInTx(tx: Sql, asset: string): Promise<void> {
  await tx.exec(`DROP TABLE IF EXISTS ${tableRef(await currentDatabase(tx), asset)}`);
  if (!(await hasState(tx))) return;
  await tx.exec(`DELETE FROM _croft.assets WHERE name = $1`, [asset]);
  for (const table of ["columns", "files", "inputs"]) await tx.exec(`DELETE FROM _croft.${table} WHERE asset = $1`, [asset]);
}

const count = (n: number) => n.toLocaleString("en-US");

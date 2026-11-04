// croft move-to-lake (DESIGN.md §4.1, §6 "Moving a project into a lake", D167 to D173; option 07, slice 4): copy the project's file
// warehouse, with croft's own records of it, into the lake named by the `lake` block of croft.json (the one with "enabled": false), prove
// the copy equal to the file, and switch the project to the lake. Its spec (usage) is in commands/index.ts; the work is db/lake-move.ts.
//
// A destructive-class step for croft's purposes, though it deletes nothing: from the switch on, the lake is where the project's data
// lives and is written, and the file is left behind (untouched, the way back). So it asks first, as every destructive command does:
// - On a terminal it prints the impact and asks `Proceed? [y/N]`. Off a terminal it changes nothing and exits 5 with
//   `confirmation: {token, expiresAt, command, impact}`; the move then runs only through `croft confirm <token>`, which hands this
//   command the token in-process (main.ts Dispatch). The impact is counted again under the project's leases, and Confirmations.consume()
//   spends the token or refuses it with CONFIRMATION_STALE when something was written meanwhile.
// - The question says what moves, what stays, what does not come along, and the way back.
// - Like a run it starts with reconcile(), takes the asset leases (of every asset, so no run starts, and none is running, while the file
//   is copied and proved), records itself in runs.sqlite and releases the leases at the end.
//
// A project the move cannot start on is refused before anything is touched: no lake block, a lake already on, a read copy asked for by name
// (server mode is not a reason, D183), a croft serve running (it would go on serving and scheduling for the file), a rename that did not
// finish, a croft.json that cannot be rewritten, columns a lake cannot store, a lake that holds anything. Each refusal names its fix.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CroftError } from "../../core/errors.ts";
import type { LockHolder, Problem } from "../../core/types.ts";
import { acquire, release } from "../../history/leases.ts";
import { type MoveRecord, MOVE_SETTING, readMoveRecord, stashMirror } from "../../history/mirror-home.ts";
import {
  configWritable, copyIntoLake, fingerprints, inexactColumns, inspectLake, inventoryOf, type LakeInspection, lakeHandles, lakeProjectOf, type LakeHandles,
  type MoveInventory, type MoveMarker, type NotMoved, newMoveTag, refuseInexact, refuseMoveTypes, switchLakeOn, undoCopy, verifyLake,
} from "../../db/lake-move.ts";
import { lakeInexactColumns, lakeRefusedColumns } from "../../db/lake.ts";
import { backupProject, type ProjectBackup } from "../../db/backup.ts";
import { CROFT_VERSION } from "../../db/state.ts";
import { discoverAssets } from "../../project/discover.ts";
import { readJournal } from "../../project/rename.ts";
import { isServeAlive, readServeRecord } from "../../read/locate.ts";
import { type Project } from "../../project/root.ts";
import { Confirmations, type HashedImpact, impactHash } from "../../safety/confirm.ts";
import { listTrash, withTrashFile } from "../../safety/trash.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { formatBytes } from "./doctor.ts";
import { holderFromRuns, holderText } from "./describe.ts";
import { closeSession, confirmationProblem, MAINTAIN_WAITS, names, openSession, plural, prompter, questionText, type Session } from "./delete.ts";

const COMMAND = "croft move-to-lake";

/** `croft move-to-lake --json`'s data. */
export interface MoveToLakeData {
  /** moved: done, and the project is in the lake. needs_confirmation: a token was issued (exit 5), nothing changed. declined: the person
   *  said no at the terminal. */
  status: "moved" | "needs_confirmation" | "declined";
  /** copy: the file is copied into a lake that holds nothing. finish: the lake already holds an equal copy from a move that stopped before
   *  the switch; it is proved again, and the project switches to it. */
  mode: "copy" | "finish";
  /** The lake the project moves into, with no credential. */
  lake: string;
  /** The tables of `main`, with their rows and column counts. */
  tables: { name: string; rows: number; columns: number }[];
  rows: number;
  /** croft's own records, which become the lake's logs: the latest rows of each `_croft` table. */
  bookkeeping: { table: string; rows: number }[];
  /** What the file holds that a lake project has no place for; it stays in the file. */
  notMoved: NotMoved[];
  /** The trash stays where it is, and restores into the lake; these versions hold columns a lake cannot store, or would store inexactly (D174), and would not restore as they are. */
  trash: { versions: number; cannotRestore: { asset: string; trashedAt: string; columns: string[] }[] };
  /** The backup made first (the file, run history and the trash), and what a move needs of it; null before the move runs. */
  backup: { path: string; bytes: number } | null;
  /** The file's bytes as the copy has them, and whether they are the bytes the file had before the backup: `unchanged` is what the move proved,
   *  `checkpointed` is true when the backup's checkpoint changed them (a move refuses a file with a pending write-ahead log, so this is a file that
   *  was written to by something else between the question and the backup). Null before the move runs. */
  file: { path: string; sha256: string; bytes: number; unchanged: boolean; checkpointed: boolean } | null;
  /** What the proof compared: tables, their rows, and the bookkeeping rows, all equal. Null before the move runs. */
  verified: { tables: number; rows: number; bookkeepingRows: number } | null;
  /** croft.json was changed: `lake.enabled` is now true. */
  switched: boolean;
  /** The run record of a move that ran. */
  runId: string | null;
}

// ---- Refusing before anything is touched ---------------------------------------------------------------------------

function blocked(reasons: { reason: string; fix: string }[], effect = "nothing was changed"): CroftError {
  return new CroftError("MOVE_BLOCKED", {
    message: reasons.length === 1 ? `the project cannot move into the lake yet: ${reasons[0]!.reason}` : `the project cannot move into the lake yet: ${reasons.map((r) => r.reason).join("; ")}`,
    hint: reasons.map((r) => r.fix).join("; "), effect,
    fix: { kind: "manual", requiresHuman: true, description: reasons.map((r) => r.fix).join("; then ") },
    details: { reasons: reasons.map((r) => r.reason) },
  });
}

/** The size of a DuckDB file's write-ahead log: 0 when there is none (a stat, not a read, so the file's lock is not touched). */
function walBytes(database: string): number {
  try {
    return statSync(`${database}.wal`).size;
  } catch {
    return 0;
  }
}

/** Whether croft.json says `"readCopy": true` itself (not only through server mode). */
function readCopyByName(root: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(root, "croft.json"), "utf8")) as { readCopy?: unknown }).readCopy === true;
  } catch {
    return false;
  }
}

/** What can be told from croft.json, the state folder and the disk alone: no DuckDB is opened for any of it. */
function refuseUnlessReady(project: Project): void {
  const config = project.config;
  if (config.lake) {
    throw new CroftError("MOVE_NEEDS_LAKE", {
      message: "the project already keeps its warehouse in a lake; there is nothing to move",
      hint: "croft move-to-lake moves a project that keeps its warehouse in a file; a lake block with \"enabled\": false names the lake it moves into",
      effect: "nothing was changed", details: { reason: "already_in_lake" },
    });
  }
  if (!config.idleLake) {
    throw new CroftError("MOVE_NEEDS_LAKE", {
      message: "croft.json names no lake to move into",
      hint: 'add a "lake" block with "enabled": false (the catalog, the bucket folder, the two logins and the two keys by secret name; croft docs lake), put the secrets in .env, install the lake add-on, then run croft move-to-lake',
      fix: { kind: "command", description: "read how a project moves into a lake", command: "croft docs lake" },
      effect: "nothing was changed", details: { reason: "no_lake" },
    });
  }
  const reasons: { reason: string; fix: string }[] = [];
  if (!existsSync(project.paths.database)) {
    reasons.push({
      reason: `there is no warehouse to move: ${project.databaseLabel} does not exist yet`,
      fix: 'a project that has built nothing has nothing to copy: set "enabled": true in the lake block of croft.json by hand, and the first croft run creates the lake',
    });
  }
  // Server mode goes with the project: over the lake it needs no copy (D183), and its keys and shared tables are the same. Only a read copy asked for
  // by name is a reason, because croft.json would be invalid with the lake on ("readCopy" does not apply to a lake). `config.readCopy` is also on
  // for server mode alone, so the file says which.
  if (readCopyByName(project.root)) {
    reasons.push({ reason: 'the read copy is on ("readCopy"), and a lake has no file to copy', fix: 'ask the user: remove "readCopy" from croft.json, and read through croft serve instead' });
  }
  // A process that stopped before it checkpointed leaves its writes in a write-ahead log, and the next program that opens the file for writing (the
  // backup that starts the move is one) folds them into it. Said before the question, so that "not one byte changed" is true of the file as shown.
  if (walBytes(project.paths.database) > 0) {
    reasons.push({
      reason: `${project.databaseLabel} has writes that are not yet folded into it (a write-ahead log, left by a croft that stopped before it checkpointed); the backup that starts the move would fold them in and change the file's bytes`,
      fix: "run croft backup (it checkpoints the file, and the backup is kept), then run croft move-to-lake again",
    });
  }
  const serve = readServeRecord(project.paths.stateDir);
  if (serve && isServeAlive(serve)) {
    reasons.push({ reason: `croft serve is running (pid ${serve.pid}); it would go on serving and scheduling for the file after the move`, fix: "stop croft serve, move, then start it again (it reads the lake without stepping aside)" });
  }
  const journal = readJournal(project.paths.stateDir);
  if (journal) {
    reasons.push({ reason: `a croft rename did not finish (${journal.from} to ${journal.to})`, fix: `finish it with croft rename ${journal.from} ${journal.to}` });
  }
  if (!configWritable(project)) {
    reasons.push({ reason: "croft cannot rewrite croft.json (the move sets \"lake.enabled\" in it as its last step)", fix: "make croft.json and its folder writable" });
  }
  if (reasons.length) throw blocked(reasons);
}

// ---- Words ---------------------------------------------------------------------------------------------------------

const tablesWord = (n: number) => plural(n, "table");

function notMovedWords(list: readonly NotMoved[]): string {
  const by = new Map<string, string[]>();
  for (const n of list) by.set(n.kind, [...(by.get(n.kind) ?? []), n.name]);
  return [...by].map(([kind, found]) => `${plural(found.length, kind.replace(/ in schema .*$/, ""))} (${found.slice(0, 4).join(", ")}${found.length > 4 ? ", ..." : ""})`).join(", ");
}

/** The question: the headline, what happens first, and what a person must hear before saying yes. */
function words(d: MoveToLakeData, backups: string): { head: string; first: string; then: string[] } {
  const head = `move the warehouse into the lake ${d.lake}: ${tablesWord(d.tables.length)}, ${plural(d.rows, "row")}, and croft's records of them (${plural(d.bookkeeping.reduce((n, b) => n + b.rows, 0), "row")})`;
  const first = d.mode === "finish"
    ? `the lake already holds an equal copy from a move that stopped before the switch; croft backs the file up (${backups}), proves the copy equal to the file again, and only then sets "lake.enabled": true in croft.json`
    : `croft backs the file up (${backups}), copies it into the lake in one step, proves every table and record equal to the file's from the lake's read-only login, and only then sets "lake.enabled": true in croft.json`;
  const then: string[] = [
    `the file stays exactly as it is, not one byte changed, and is the way back: set "lake.enabled" to false and the project is on the file again; what is written in the lake after the move is not carried back`,
    `stays where it is: the trash${d.trash.versions ? ` (${plural(d.trash.versions, "version")}, local files; croft restore works into the lake)` : ""}, run history, schedules and approvals (runs.sqlite), the asset files and .env`,
    `does not come along: time travel (a file keeps none, so the lake's history starts with the move) and the file's own earlier states${d.notMoved.length ? `; ${notMovedWords(d.notMoved)} stay${d.notMoved.length === 1 ? "s" : ""} in the file` : ""}`,
  ];
  if (d.trash.cannotRestore.length) {
    then.push(`${plural(d.trash.cannotRestore.length, "trashed version")} hold${d.trash.cannotRestore.length === 1 ? "s" : ""} columns a lake cannot store, or would store inexactly (${names(d.trash.cannotRestore.slice(0, 3).map((t) => `${t.asset}: ${t.columns.join(", ")}`))}${d.trash.cannotRestore.length > 3 ? ", ..." : ""}); restoring ${d.trash.cannotRestore.length === 1 ? "it" : "them"} into the lake fails until ${d.trash.cannotRestore.length === 1 ? "it is" : "they are"} restored on the file, before the move`);
  }
  then.push("from then on this machine is the one machine that writes the lake, and croft backup, croft serve and croft maintain work on the lake");
  return { head, first, then };
}

// ---- The impact ----------------------------------------------------------------------------------------------------

interface Preflight {
  inv: MoveInventory;
  lake: LakeInspection;
  mode: "copy" | "finish";
  trash: MoveToLakeData["trash"];
  /** Every name a run could hold a lease on: the asset files, and the tables. */
  names: string[];
}

function toImpact(project: Project, p: Preflight, rows: number): HashedImpact {
  return {
    asset: "the warehouse",
    action: `move into the lake ${lakeProjectOf(project).databaseLabel} (${p.mode === "finish" ? "the copy already there is proved again and switched to" : `${tablesWord(p.inv.tables.length)} and croft's records are copied`})`,
    rows, downstream: [],
    generation: createHashOf([p.inv.generation, p.mode, p.lake.state, p.lake.marker?.tag ?? null, p.lake.tables.length, p.lake.bookkeepingRows]),
  };
}

function createHashOf(parts: unknown[]): string {
  return impactHash({ asset: "", action: JSON.stringify(parts), rows: 0, downstream: [] });
}

/** Everything a person is asked about, read without changing anything: the file (a read lease), the lake (the read-only login), the trash. */
async function preflight(ctx: Ctx, s: Session, handles: LakeHandles): Promise<Preflight> {
  const project = ctx.project;
  const found = await discoverAssets(project.root);
  const files = new Map(found.assets.map((a) => [a.name, a.file]));
  const inv = await s.warehouse.read((sql) => inventoryOf(sql, null), { purpose: "move into the lake: what the file holds" });
  refuseMoveTypes(inv, files);
  refuseInexact(await s.warehouse.read((sql) => inexactColumns(sql, inv), { purpose: "move into the lake: values a lake would change" }), files);
  const lake = await inspectLake(handles.reader);
  const label = lakeProjectOf(project).databaseLabel;
  let mode: "copy" | "finish" = "copy";
  // An interrupted move left the copy in the lake: it is finished only if it is a copy of this file (the bytes the marker names).
  // Not one whose move finished: the project was switched back to the file since (the record of the move names the copy it made), and a lake
  // that a move filled and the project used is a lake that holds something (D173).
  const finished = lake.state === "marked" && lake.marker !== null && readMoveRecord(s.runs)?.tag === lake.marker.tag;
  const ofThisFile = lake.state === "marked" && lake.unchanged && !finished ? (await fingerprints([project.paths.database]))[0]?.sha256 === lake.marker!.fileSha256 : false;
  if (ofThisFile) mode = "finish";
  else if (lake.state === "marked" || lake.state === "used") {
    throw new CroftError("MOVE_LAKE_NOT_EMPTY", {
      message: lake.state === "marked"
        ? `${label} holds a copy that a move made on ${lake.marker?.at ?? "an earlier day"}, and ${finished ? "that move finished and the project was switched back to the file since" : lake.unchanged ? "it is a copy of a file that is not this one" : "it has been written since"}`
        : `${label} already holds ${lake.tables.length ? `${plural(lake.tables.length, "table")} (${lake.tables.slice(0, 5).join(", ")}${lake.tables.length > 5 ? ", ..." : ""})` : `${plural(lake.bookkeepingRows, "bookkeeping row")}`}; a move only fills a lake that holds nothing`,
      hint: lake.state === "marked"
        ? 'to use that lake again set "lake.enabled": true in croft.json by hand (what was written there since stays there); to move the file again, name a new catalog database and bucket folder in the lake block'
        : "name a new catalog database and bucket folder in the lake block (the folder holds nothing but one lake, croft docs lake); croft never writes into a lake that already holds tables",
      fix: { kind: "manual", requiresHuman: true, description: "ask the user which lake the project moves into: a new, empty catalog database and bucket folder" },
      effect: "nothing was changed",
      details: { state: lake.state, tables: lake.tables, bookkeepingRows: lake.bookkeepingRows, ...(lake.marker ? { marker: { at: lake.marker.at, tag: lake.marker.tag } } : {}) },
    });
  }
  const trash = await trashReport(s, project);
  return { inv, lake, mode, trash, names: [...new Set([...found.assets.map((a) => a.name), ...inv.tables.map((t) => t.name)])] };
}

/** The trash: how many versions, and which of them hold columns a lake cannot store (read from each file, attached read-only). */
async function trashReport(s: Session, project: Project): Promise<MoveToLakeData["trash"]> {
  const versions = listTrash(project.paths.stateDir);
  const cannotRestore: MoveToLakeData["trash"]["cannotRestore"] = [];
  for (const v of versions) {
    try {
      const bad = await s.warehouse.read((sql) => withTrashFile(sql, v.path, async (alias) => {
        const cols = await sql.all<{ name: string; type: string }>(
          `SELECT column_name AS name, data_type AS type FROM duckdb_columns() WHERE database_name = $1 AND schema_name = 'main' ORDER BY table_name, column_index`, [alias]);
        return [...lakeRefusedColumns(cols), ...lakeInexactColumns(cols)];
      }), { purpose: "move into the lake: the trash" });
      if (bad.length) cannotRestore.push({ asset: v.asset, trashedAt: v.trashedAt, columns: bad.map((c) => c.name) });
    } catch {
      // A trash file that cannot be read is no news for the move; croft restore says so when it is asked for.
    }
  }
  return { versions: versions.length, cannotRestore };
}

function dataOf(ctx: Ctx, p: Preflight, status: MoveToLakeData["status"], extra: Partial<Pick<MoveToLakeData, "backup" | "file" | "verified" | "switched" | "runId">> = {}): MoveToLakeData {
  return {
    status, mode: p.mode, lake: lakeProjectOf(ctx.project).databaseLabel,
    tables: p.inv.tables.map((t) => ({ name: t.name, rows: t.rows, columns: t.columns.length })),
    rows: p.inv.tables.reduce((n, t) => n + t.rows, 0),
    bookkeeping: p.inv.bookkeeping.filter((b) => b.table !== "meta").map((b) => ({ table: b.table, rows: b.rows })),
    notMoved: p.inv.notMoved, trash: p.trash,
    backup: extra.backup ?? null, file: extra.file ?? null, verified: extra.verified ?? null, switched: extra.switched ?? false, runId: extra.runId ?? null,
  };
}

// ---- The move ------------------------------------------------------------------------------------------------------

/** CROFT_FAULT stops, to test a kill -9 at each point of the move (db/lake-move.ts says what each leaves). */
function fault(at: string, want: string | undefined): void {
  if (want && want === at) process.kill(process.pid, "SIGKILL");
}

function changed(why: string, details: Record<string, unknown> = {}): CroftError {
  return new CroftError("MOVE_FILE_CHANGED", {
    message: `the file warehouse changed while it was being moved (${why}); nothing was switched`,
    hint: "something other than croft wrote the file, or a croft that was not stopped did; make sure nothing else writes the project, then run croft move-to-lake again (the file and the project are as they were; a copy in the lake was taken out again)",
    effect: "the project still keeps its warehouse in the file, unchanged by the move",
    details,
  });
}

interface MoveOutcome { backup: ProjectBackup; tag: string; file: { path: string; sha256: string; bytes: number; unchanged: boolean; checkpointed: boolean }; verified: { tables: number; rows: number; bookkeepingRows: number } }

async function move(ctx: Ctx, s: Session, handles: LakeHandles, p: Preflight, runId: string, onProgress: (text: string) => void): Promise<MoveOutcome> {
  const project = ctx.project;
  const database = project.paths.database;
  const wantFault = ctx.processEnv.CROFT_FAULT;
  // 0. The file as it is, with its write-ahead log, before the backup: the backup's checkpoint folds a pending log into the file, which changes the
  // file's bytes (not its values), and the move says so instead of calling it untouched.
  const [before, beforeLog] = await fingerprints([database, `${database}.wal`]);
  // 1. The backup: croft's own, the file checkpointed and cloned under its lock, with run history and the trash.
  onProgress("backing up the warehouse");
  const backup = await backupProject(project, {
    now: () => ctx.now(), isTTY: ctx.isTTY.stdin && ctx.isTTY.stdout,
    lookupHolder: (pid) => holderFromRuns(project.paths.stateDir, pid),
    onWait: (h: LockHolder, ms: number) => ctx.render.progress(`waiting for the warehouse: ${holderText(h)} holds it (${Math.round(ms / 1000)} s so far)`),
  });
  fault("move_after_backup", wantFault);
  const backupFile = join(backup.path, basename(database));
  // 2. The file and its backup are the same bytes: nothing wrote the file between the checkpoint and now, and the copy is of this file.
  const [orig, copy] = await fingerprints([database, backupFile]);
  if (!orig || !copy) throw changed("the file or its backup cannot be read");
  if (orig.sha256 !== copy.sha256) throw changed("the file is not the bytes the backup copied", { fileSha256: orig.sha256, backupSha256: copy.sha256 });
  const checkpointed = (beforeLog?.bytes ?? 0) > 0 || before?.sha256 !== orig.sha256;
  // The backup is what is copied, so it is what is counted: it must be what the person was asked about.
  const inv = await s.warehouse.read((sql) => withTrashFile(sql, backupFile, (alias) => inventoryOf(sql, alias)), { purpose: "move into the lake: what the backup holds" });
  if (inv.generation !== p.inv.generation) throw changed("the tables or their records differ from what was shown");

  // 3. The copy, in one lake transaction (or none, when the lake already holds an equal one from a move that stopped).
  let marker: MoveMarker;
  if (p.mode === "finish") {
    const there = await inspectLake(handles.reader);
    if (!(there.state === "marked" && there.unchanged && there.marker!.fileSha256 === orig.sha256)) {
      throw new CroftError("MOVE_LAKE_NOT_EMPTY", {
        message: "the lake holds the copy of an earlier move, but it is not a copy of this file as it is now",
        hint: "name a new catalog database and bucket folder in the lake block, and move again; the project and the file are as they were",
        effect: "nothing was changed", details: { state: there.state, expected: orig.sha256, found: there.marker?.fileSha256 ?? null },
      });
    }
    marker = there.marker!;
    onProgress("the lake already holds the copy; proving it equal");
  } else {
    marker = {
      v: 1, tag: newMoveTag(), at: ctx.now().toISOString(), croftVersion: CROFT_VERSION, fileSha256: orig.sha256, fileBytes: orig.bytes,
      tables: inv.tables.map((t) => ({ name: t.name, rows: t.rows })), bookkeeping: inv.bookkeeping.filter((b) => b.table !== "meta").map((b) => ({ table: b.table, rows: b.rows })),
    };
    onProgress(`copying ${tablesWord(inv.tables.length)} into the lake`);
    await copyIntoLake(handles.writer, backupFile, inv, marker, { runId, label: lakeProjectOf(project).databaseLabel });
  }
  fault("move_after_copy", wantFault);

  // 4. The proof, from the read-only login: the lake is what a reader will see.
  onProgress("proving the lake equal to the file");
  const proof = await verifyLake(handles.reader, backupFile, inv);
  if (proof.differences.length) {
    const undone = await undoCopy(handles.writer, marker, { runId }).catch(() => false);
    throw new CroftError("MOVE_NOT_EQUAL", {
      message: `the lake does not equal the file after the copy (${proof.differences.slice(0, 3).join("; ")}${proof.differences.length > 3 ? `; and ${proof.differences.length - 3} more` : ""}); the project was not switched`,
      hint: `${proof.columns.length
        ? `${proof.columns.map((c) => `${c.table}.${c.column} (${c.type})`).slice(0, 5).join(", ")}: a lake stores HUGEINT and UHUGEINT as DOUBLE, an INTERVAL to the millisecond and a TIMETZ at offset 0, also inside a STRUCT, LIST or MAP (croft docs LAKE_VALUES_INEXACT); cast ${proof.columns.length === 1 ? "it" : "them"} to a type a lake keeps exactly in the asset's SELECT, run the asset, and move again; `
        : ""}${undone
        ? "the copy was taken out of the lake again and the project still uses the file, which is untouched"
        : "the project still uses the file, which is untouched; the lake still holds the copy, which croft could not take out (croft docs MOVE_NOT_EQUAL)"}`,
      effect: "the project still keeps its warehouse in the file, unchanged by the move",
      details: { differences: proof.differences.slice(0, 50), columns: proof.columns.slice(0, 50), undone },
    });
  }

  // 5. The file again: it must be the bytes that were copied, or the copy is of an older file.
  // CROFT_FAULT=move_touch_file is another program writing the file now (a child process, so this one's locks are not touched).
  if (wantFault === "move_touch_file") Bun.spawnSync(["/bin/sh", "-c", 'printf x >> "$1"', "sh", database]);
  const [after] = await fingerprints([database]);
  if (!after || after.sha256 !== orig.sha256) {
    const undone = await undoCopy(handles.writer, marker, { runId }).catch(() => false);
    throw changed("its bytes differ from the bytes that were copied", { before: orig.sha256, after: after?.sha256 ?? null, undone });
  }
  fault("move_before_switch", wantFault);

  // 6. The switch: the last step, one rename of croft.json. The catalog mirror as of now is the file's, and is put back if the project goes back to it.
  onProgress('switching croft.json to the lake ("lake.enabled": true)');
  stashMirror(s.runs, project.databaseLabel);
  switchLakeOn(project);
  fault("move_after_switch", wantFault);
  return { backup, tag: marker.tag, file: { path: project.databaseLabel, sha256: orig.sha256, bytes: orig.bytes, unchanged: !checkpointed, checkpointed }, verified: { tables: proof.tables, rows: proof.rows, bookkeepingRows: proof.bookkeepingRows } };
}

export const moveToLake: CommandImpl<MoveToLakeData> = {
  async run(ctx): Promise<CommandResult<MoveToLakeData>> {
    const project = ctx.project;
    refuseUnlessReady(project);
    const lp = lakeProjectOf(project);
    const s = await openSession(ctx, COMMAND);
    const handles = lakeHandles(lp, ctx.env, {
      isTTY: s.ask,
      onWait: (h, ms) => ctx.render.progress(`waiting for the lake: ${holderText(h)} holds it (${Math.round(ms / 1000)} s so far)`),
    });
    try {
      const problems: Problem[] = [...s.problems];
      const p = await preflight(ctx, s, handles);
      const rows = p.inv.tables.reduce((n, t) => n + t.rows, 0);
      const impact = toImpact(project, p, rows);
      const backups = "in .croft/backups";
      let shown: HashedImpact | null = null;
      if (s.token === undefined) {
        const d = dataOf(ctx, p, "needs_confirmation");
        const w = words(d, backups);
        if (!s.ask) {
          const c = new Confirmations(s.runs).create({ command: COMMAND, impact });
          problems.push(confirmationProblem(c, w.head, w.first, w.then.join("; ")));
          return { data: d, problems, next: [], confirmation: c };
        }
        if (!(await prompter.ask(questionText(w.head, w.first, w.then)))) return { data: { ...d, status: "declined" }, problems, next: [], ok: false, exit: 1 };
        shown = impact;
      }
      const done = await carryOut(ctx, s, handles, p, shown);
      const d = dataOf(ctx, p, "moved", { backup: { path: done.out.backup.path, bytes: done.out.backup.bytes }, file: done.out.file, verified: done.out.verified, switched: true, runId: done.runId });
      return {
        data: d, problems,
        next: [{ command: "croft status", reason: "see the assets, now read from the lake" }, { command: "croft run --dry-run", reason: "see what the next run does: the same as it would have done on the file" }],
      };
    } finally {
      await handles.close();
      await closeSession(s);
    }
  },

  human(result, ctx) {
    const d = result.data;
    const w = words(d, "in .croft/backups");
    switch (d.status) {
      case "needs_confirmation":
        return [`needs confirmation: ${w.head}`, `  first: ${w.first}`, ...w.then.map((t, n) => (n === 0 ? `  then:  ${t}` : `         ${t}`)),
          ...(result.confirmation ? [`  ask the user; if they agree: croft confirm ${result.confirmation.token}    (valid 15 min)`] : [])].join("\n");
      case "declined":
        return "not moved: the move was not confirmed; nothing was changed";
      case "moved": {
        const lines = [`ok    moved into the lake ${d.lake}: ${tablesWord(d.tables.length)}, ${plural(d.rows, "row")}, and croft's records of them (${plural(d.bookkeeping.reduce((n, b) => n + b.rows, 0), "row")})`];
        if (d.verified) lines.push(`      proved equal to the file from the lake's read-only login: ${tablesWord(d.verified.tables)} row for row, ${plural(d.verified.bookkeepingRows, "record")}`);
        if (d.file) {
          lines.push(`      ${d.file.checkpointed
            ? "the file holds the same values, checkpointed by the backup (its pending write-ahead log was folded into it; its bytes are the ones now named, and are not changed again)"
            : "the file is untouched"} (sha256 ${d.file.sha256.slice(0, 16)}..., ${formatBytes(d.file.bytes)}): the way back is "lake.enabled": false in croft.json`);
        }
        if (d.backup) lines.push(`      backed up first: ${ctx.project.root && d.backup.path.startsWith(ctx.project.root) ? d.backup.path.slice(ctx.project.root.length + 1) : d.backup.path} (${formatBytes(d.backup.bytes)})`);
        lines.push('      croft.json now has "lake.enabled": true; commit it, and give the lake\'s secrets to whoever else runs this project');
        for (const t of w.then.slice(1)) lines.push(`      ${t}`);
        return lines.join("\n");
      }
    }
  },
};

/** A path as the project's folder names it when it is inside it. */
function shownIn(project: Project, path: string): string {
  return path.startsWith(`${project.root}/`) ? path.slice(project.root.length + 1) : path;
}

// ---- Carrying it out -----------------------------------------------------------------------------------------------

/**
 * The move as one command run, like a delete's step: a run record, a lease on every asset (waiting as a run waits), the impact counted
 * again under them, the consent (the token spent, or the terminal's yes checked against the impact now), then the move. A failure fails
 * the run record and is rethrown; the leases always go.
 */
async function carryOut(ctx: Ctx, s: Session, handles: LakeHandles, p: Preflight, shown: HashedImpact | null): Promise<{ out: MoveOutcome; runId: string }> {
  const project = ctx.project;
  const run = s.runs.createRun({ trigger: s.token !== undefined ? "confirm" : "manual", human: true, argv: ["move-to-lake", ...ctx.argv.filter((a) => a !== "--json")], timeZone: project.timezone });
  const runId = run.id;
  try {
    await acquire(s.runs, p.names, runId, {
      waitMs: s.ask ? MAINTAIN_WAITS.ttyMs : MAINTAIN_WAITS.offTtyMs,
      onWait: (busy) => ctx.render.progress(`waiting for ${busy.map((b) => b.asset).join(", ")}: run ${[...new Set(busy.map((b) => b.runId))].join(", ")} holds it`),
    });
    s.runs.setRunProgress(runId, { asset: "(all)", phase: "write", rowsFetched: 0, requests: 0, elapsedMs: 0 });
    // The impact again, with the project's leases held: nothing writes it from here on.
    const now = await preflight(ctx, s, handles);
    const impact = toImpact(project, now, now.inv.tables.reduce((n, t) => n + t.rows, 0));
    if (s.token !== undefined) await new Confirmations(s.runs).consume(s.token, () => impact);
    else if (!shown || impactHash(impact) !== impactHash(shown)) {
      throw new CroftError("CONFIRMATION_STALE", {
        message: "the warehouse or the lake changed while you were answering: now a different impact than the one you said yes to", hint: `nothing was changed; run ${COMMAND} again to see the impact now`,
        effect: "nothing was changed", fix: { kind: "command", description: "see the impact now", command: COMMAND },
      });
    }
    s.runs.setLockHolder({ runId, asset: "(all)", action: "move" });
    let out: MoveOutcome;
    try {
      out = await move(ctx, s, handles, now, runId, (t) => ctx.render.progress(t));
    } finally {
      s.runs.clearLockHolder();
    }
    if (s.token === undefined) {
      try {
        new Confirmations(s.runs).supersede(COMMAND, null);
      } catch {
        // The move is done; a token left open meets a changed impact.
      }
    }
    // It committed: from here on, bookkeeping trouble must not report the command as failed.
    try {
      const record: MoveRecord = {
        at: ctx.now().toISOString(), runId, tag: out.tag, lake: lakeProjectOf(project).databaseLabel, tables: now.inv.tables.length, rows: now.inv.tables.reduce((n, t) => n + t.rows, 0),
        fileSha256: out.file.sha256, fileBytes: out.file.bytes, backup: shownIn(project, out.backup.path),
      };
      s.runs.setSetting(MOVE_SETTING, record);
      s.runs.finishRun(runId, "succeeded", { data: { runId, status: "succeeded", steps: [] }, problems: [], next: [], exit: 0, ok: true });
    } catch {
      // See above.
    }
    return { out, runId };
  } catch (e) {
    const prob: Problem = e instanceof CroftError ? e.problem : { severity: "error", code: "INTERNAL_ERROR", docs: "croft docs INTERNAL_ERROR", message: String((e as Error)?.message ?? e), hint: "report this croft bug" };
    try {
      s.runs.finishRun(runId, "failed", { data: { runId, status: "failed", steps: [] }, problems: [{ ...prob, runId }], next: [], exit: e instanceof CroftError ? e.exit : 1, ok: false });
    } catch {
      // The failure itself is what the person needs to see.
    }
    throw e;
  } finally {
    release(s.runs, runId);
  }
}

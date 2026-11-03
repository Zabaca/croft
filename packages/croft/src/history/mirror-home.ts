// Which warehouse the catalog mirror describes (DESIGN.md §5 "Where state lives", D158; option 07, slice 4).
//
// The catalog mirror in runs.sqlite is a copy of each asset's `_croft` state, so `croft status`, `croft run --dry-run` and the run planner never
// open the warehouse. It describes ONE warehouse. A project that moves into a lake and is switched back to its file (`"lake.enabled": false`) has
// two: the file as the move left it, which nothing wrote since, and the lake, which runs have written. Left alone, the mirror would describe the
// lake's days over the file's data, and the planner would decide from it.
//
// So the mirror remembers where it is at home (`catalog.home`, the project's warehouse label), and when a command finds the project somewhere
// else it puts the mirror it saved for that place back (`catalog.stash`, the mirrors of the places the project is not at). The move saves the
// file's mirror as of the move, so going back restores exactly the state the untouched file is in. Nothing here opens a warehouse: it is a few
// rows of runs.sqlite, read when a command starts, and a project that has never named a lake and was never in one is not touched at all.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunsDb } from "./runs-db.ts";
import { RUNS_DB_FILE, RunsDb as RunsDbClass } from "./runs-db.ts";

const HOME = "catalog.home";
const STASH = "catalog.stash";

interface MirrorRow { asset: string; json: string; source: string; refreshed_at: string }
type Stash = Record<string, { rows: MirrorRow[]; at: string }>;

const rowsOf = (db: RunsDb): MirrorRow[] => db.sqlite.query("SELECT asset, json, source, refreshed_at FROM catalog ORDER BY asset").all() as MirrorRow[];

function replaceRows(db: RunsDb, rows: readonly MirrorRow[]): void {
  db.sqlite.query("DELETE FROM catalog").run();
  const put = db.sqlite.query("INSERT INTO catalog (asset, json, source, refreshed_at) VALUES (?, ?, ?, ?)");
  for (const r of rows) put.run(r.asset, r.json, r.source, r.refreshed_at);
}

/** Save the mirror as it is now under `label`, and say that the mirror is at home there. The move calls it for the file, just before the switch. */
export function stashMirror(db: RunsDb, label: string): void {
  db.transaction(() => {
    const stash = db.getSetting<Stash>(STASH) ?? {};
    stash[label] = { rows: rowsOf(db), at: db.nowIso() };
    db.setSetting(STASH, stash);
    db.setSetting(HOME, label);
  });
}

export type Settled = "same" | "recorded" | "restored" | "kept";

/**
 * The mirror at the start of a command: `home` is the label of the warehouse the project is on now. Same: nothing. Never recorded: recorded (the
 * mirror is taken to describe where the project is). Elsewhere: the mirror just left is saved under its label, and the one saved for `home`
 * is put back (restored), or, when none was saved, the mirror is kept as it is (kept: the next write of each asset refreshes its entry).
 */
export function settleMirror(db: RunsDb, home: string): Settled {
  const at = db.getSetting<string>(HOME);
  if (at === home) return "same";
  return db.transaction(() => {
    if (at === null) {
      db.setSetting(HOME, home);
      return "recorded" as const;
    }
    const stash = db.getSetting<Stash>(STASH) ?? {};
    stash[at] = { rows: rowsOf(db), at: db.nowIso() };
    const saved = stash[home];
    delete stash[home];
    if (saved) replaceRows(db, saved.rows);
    db.setSetting(STASH, stash);
    db.setSetting(HOME, home);
    return saved ? ("restored" as const) : ("kept" as const);
  });
}

/**
 * What a command does first in a project: settleMirror on runs.sqlite when there is one and the project has anything to do with a lake (a
 * `lake` block, on or off, or a mirror that was already at home somewhere). Never fails the command: a runs.sqlite that cannot be opened is
 * the command's own to report.
 */
export function settleMirrorFor(stateDir: string, home: string, hasLake: boolean): Settled | null {
  try {
    if (!existsSync(join(stateDir, RUNS_DB_FILE))) return null;
    const db = RunsDbClass.open(stateDir);
    try {
      if (!hasLake && db.getSetting<string>(HOME) === null) return null;
      return settleMirror(db, home);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The setting that remembers a move into a lake (runs.sqlite `lake.move`): when, which lake, how much, and the file's bytes. */
export const MOVE_SETTING = "lake.move";

export interface MoveRecord {
  at: string;
  runId: string;
  /** The tag of the copy the move made in the lake (its marker's): a lake that holds this copy was filled by a move that finished. */
  tag: string;
  /** The lake, with no credential. */
  lake: string;
  tables: number;
  rows: number;
  /** The sha256 and size of the file as the move left it, and where its backup is. */
  fileSha256: string;
  fileBytes: number;
  backup: string;
}

export function readMoveRecord(db: RunsDb): MoveRecord | null {
  const v = db.getSetting<Partial<MoveRecord>>(MOVE_SETTING);
  return v && typeof v.at === "string" && typeof v.fileSha256 === "string" && typeof v.tag === "string" ? (v as MoveRecord) : null;
}

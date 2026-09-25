// Rename (DESIGN.md §4.1, §6 "Nothing implicit destroys ingested data"): an asset's file, table and state move
// together, and croft lists the references in other code to update (it never edits user code). A rename is
// reversible, so it needs no confirmation (§6). ASSET_RENAMED is the other half: a file renamed outside croft is a
// new, never-built asset whose code hash matches an orphan table's, and the fix is `croft rename <orphan> <new>`,
// which adopts the table instead of refetching history.
//
// planRename checks the names and says what moves; applyRename moves it:
//
//   refuse     `to` must be a usable name (NAME_INVALID, NAME_RESERVED) that names no file and no table
//              (NAME_CONFLICT); `from` must be an asset file, a table croft built, or both (USAGE_ERROR with a
//              did-you-mean otherwise); a run that holds either name refuses the rename at once (ASSET_BUSY)
//   modes      file    `from` has its file: croft moves it next to itself, keeping its extension
//              adopt   the file was renamed outside croft (ASSET_RENAMED): only the table and state move
//              resume  a rename that stopped (its journal is still there): whatever is left moves
//   leases     the asset leases of both names (and of the name an earlier asset's versions are kept under), under
//              a run record (`croft logs --runs` shows it; a run that meets the leases names it), then the
//              warehouse's write lock (its write intent first)
//
// Crash safety. The stores are the asset file, the warehouse (table and _croft rows), runs.sqlite (catalog mirror,
// schedule_state with the approved code, steps), the trash folder and the preview. No transaction spans them, so
// the order is chosen so that every stop leaves a state a second `croft rename <from> <to>` finishes:
//
//   0. journal   <state>/rename.json {from, to, files, run}, written before anything moves, removed last. While
//                it exists, findRenamed reports ASSET_RENAMED ("did not finish") with the fix to run the rename
//                again, and a rename of another pair is refused until it is finished
//   1. warehouse ONE transaction: ALTER TABLE from RENAME TO to, the _croft rows (assets, columns, inputs as asset
//                and as input, files, writes), and, still inside it, the file's rename on disk. A stop before the
//                COMMIT leaves the table and state as they were (DuckDB discards the transaction) and at most the
//                file moved: the ASSET_RENAMED state, which findRenamed also finds by code hash
//   2. runs.sqlite one SQLite transaction: the catalog entry (and the readers' reads and positions), schedule_state
//                (the approved code travels: the fingerprint ignores the file name, §8), the steps (history)
//   3. trash     first the versions of an earlier asset named <to> (one deleted before: <to> has no table) that
//                trash/<to>/ still holds, which the journal lists: they go to trash/<to>_earlier/ and are renamed
//                inside their files, so `croft restore <to>` never offers another asset's versions as the renamed
//                one's, and `croft restore <to>_earlier` still brings them back. Then every trashed version of
//                <from> is renamed inside its file (so restore finds main.<to>) and moved to trash/<to>/, under a
//                name the earlier versions never had
//   4. preview   cleared when it built or read `from` (the next `croft preview` builds it again)
//   5. journal removed; the read copy is refreshed when it is on
//
// Each step reads what is there and does only what is left, so running them again after any stop is safe: a stop
// between 1 and 2 leaves the warehouse renamed and the mirror stale (a run of `to` reads its state from the
// warehouse, which is authoritative, and continues from the saved cursor), and the second rename moves the mirror.
// CROFT_FAULT (rename_before_commit, rename_after_commit, rename_after_state, rename_after_earlier,
// rename_after_trash) kills the process at those points, as a crash would.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError, isCode, problem } from "../core/errors.ts";
import { now as clockNow } from "../core/time.ts";
import type { LockHolder, Problem, Sql } from "../core/types.ts";
import type { DuckWarehouse, LeaseSql } from "../db/warehouse.ts";
import type { CatalogAsset } from "../history/catalog.ts";
import { newRunId, RUNS_DB_FILE, RunsDb } from "../history/runs-db.ts";
import { type DiscoveredAsset, discoverAssets, nameProblem, sqlKeywordNames } from "./discover.ts";
import { loadProject, type Project } from "./root.ts";
import { lexSql, parseSqlHeader } from "./sql-asset.ts";
import { didYouMean } from "./suggest.ts";

/** A place in the project's code that names the old asset. */
export interface RenameReference {
  /** Root-relative; the renamed file itself under its new name. */
  file: string;
  line: number;
  /** The line's text, trimmed (at most 160 characters). */
  text: string;
  /** sql: SQL that reads it (an SQL asset's FROM/JOIN, or SQL in a TS string); ts_input: a TS `inputs` entry or a
   *  rows("…")/newRows("…") call; check: a check or warning; import: a module path to its file. */
  kind: "sql" | "ts_input" | "check" | "import";
}

/** How the rename moves things: `file` moves the asset file too; `adopt` takes over the table of a file already
 *  renamed outside croft (ASSET_RENAMED); `resume` finishes a rename that stopped. */
export type RenameMode = "file" | "adopt" | "resume";

export interface RenamePlan {
  from: string;
  to: string;
  /** The asset file before and after (same folder, same extension), root-relative. In adopt mode both are the
   *  file's current path. */
  fileFrom: string;
  fileTo: string;
  /** Whether a table and _croft state exist to move (the catalog mirror's word; the warehouse decides). */
  hasTable: boolean;
  references: RenameReference[];
  mode: RenameMode;
  /** The table's rows as the catalog mirror has them; null when it has none. */
  rows: number | null;
  /** The versions of an earlier asset named `to` that the trash still holds, and where they are kept apart; null
   *  when trash/<to>/ holds none. */
  earlier: EarlierVersions | null;
}

/** Trashed versions of an earlier asset of the new name (one deleted before), found in trash/<to>/ before the
 *  rename: they move to trash/<name>/, so the renamed asset's versions and theirs are never mixed (R41-09). */
export interface EarlierVersions {
  /** The free name they are kept under: `<to>_earlier`, or `<to>_earlier_2`, … when that one is taken. */
  name: string;
  /** Their trash file names without .duckdb (the stamps), oldest first. */
  versions: string[];
}

/** A never-built asset whose code matches an orphan table's recorded code hash (ASSET_RENAMED), or a croft rename
 *  that did not finish. */
export interface RenamedAsset {
  /** The orphan table (the old name). */
  from: string;
  /** The new asset file's name. */
  to: string;
  /** The new asset file, root-relative. */
  file?: string;
  /** The orphan table's rows, as the catalog mirror has them. */
  rows?: number | null;
  /** A croft rename of from to to stopped before it finished (its journal is still there). */
  unfinished?: boolean;
}

export interface RenameResult {
  from: string;
  to: string;
  mode: RenameMode;
  /** The run record the rename took its leases under. */
  runId: string;
  file: { from: string; to: string; moved: boolean };
  /** renamed: the warehouse had a table to rename (false: never built). rows: its rows. */
  table: { renamed: boolean; rows: number | null };
  /** Trashed versions moved to the new name; `left`: versions that could not be rewritten and stay under the old
   *  name. `earlier`: the versions of an earlier asset of the new name, kept apart under `earlier.name` (its
   *  `left`: those whose table could not be renamed inside their file, which restore cannot read under that name);
   *  null when there were none. */
  trash: { versions: number; left: string[]; earlier: { name: string; versions: number; left: string[] } | null };
  /** cleared: the last preview built or read `from`, and was emptied; kept: it could not be (busy); none: it did
   *  not involve `from`. */
  preview: "cleared" | "kept" | "none";
  references: RenameReference[];
  /** What reconcile() reported before the rename (a busy warehouse, say). */
  problems: Problem[];
}

/** The points a stop is tested at (CROFT_FAULT, ApplyRenameOptions.onPoint). */
export type RenamePoint = "rename_before_commit" | "rename_after_commit" | "rename_after_state" | "rename_after_earlier" | "rename_after_trash";

export interface ApplyRenameOptions {
  /** The project, when the caller has it loaded. */
  project?: Project;
  /** The clock for runs.sqlite (CROFT_NOW). */
  now?: () => Date;
  /** stdin and stdout are a terminal: the longer lock waits. */
  interactive?: boolean;
  /** CROFT_FAULT: the process is killed (SIGKILL) at this point, as a crash would. */
  fault?: string;
  /** Tests: called at each point; a throw there is a failure at that point. */
  onPoint?: (at: RenamePoint) => void;
  /** The warehouse lock has been held by another process for a while. */
  onWait?: (holder: LockHolder, waitedMs: number) => void;
}

// ---------------------------------------------------------------------------------------------------------
// The journal

/** <state>/rename.json: a rename that has started and not finished. */
export const RENAME_JOURNAL = "rename.json";

export interface RenameJournal {
  from: string;
  to: string;
  fileFrom: string;
  fileTo: string;
  mode: RenameMode;
  /** ISO-8601 UTC. */
  startedAt: string;
  runId: string;
  /** The earlier versions of `to` the rename keeps apart (RenamePlan.earlier), listed before anything moved, so a
   *  second run tells them from the versions of `from` it moved into trash/<to>/. */
  earlier: EarlierVersions | null;
}

/** The journal of a rename that did not finish, or null. */
export function readJournal(stateDir: string): RenameJournal | null {
  try {
    const v = JSON.parse(readFileSync(join(stateDir, RENAME_JOURNAL), "utf8")) as Partial<RenameJournal>;
    const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
    if (!str(v.from) || !str(v.to) || !str(v.fileFrom) || !str(v.fileTo)) return null;
    const e = v.earlier as Partial<EarlierVersions> | null | undefined;
    const earlier = e && str(e.name) && Array.isArray(e.versions) && e.versions.every(str) ? { name: e.name, versions: [...e.versions] } : null;
    return {
      from: v.from, to: v.to, fileFrom: v.fileFrom, fileTo: v.fileTo, mode: v.mode === "adopt" ? "adopt" : "file",
      startedAt: str(v.startedAt) ? v.startedAt : "", runId: str(v.runId) ? v.runId : "", earlier,
    };
  } catch {
    return null;
  }
}

/** Write the journal: atomically, and, unless `replace`, only when no other rename wrote one first (link(2) fails
 *  when the name exists). A journal nobody can read is no rename (it is written before anything moves): it is
 *  replaced. A file system without hard links falls back to a plain check. */
function writeJournal(stateDir: string, j: RenameJournal, replace: boolean): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, RENAME_JOURNAL);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(j, null, 1));
  try {
    if (replace) {
      renameSync(tmp, path);
      return;
    }
    try {
      linkSync(tmp, path);
    } catch (e) {
      const other = existsSync(path) ? readJournal(stateDir) : null;
      if (other) throw otherRenamePending(other);
      if ((e as { code?: string }).code !== "EEXIST" && existsSync(path)) throw e;
      renameSync(tmp, path);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

function removeJournal(stateDir: string): void {
  rmSync(join(stateDir, RENAME_JOURNAL), { force: true });
}

function otherRenamePending(j: RenameJournal): CroftError {
  const command = `croft rename ${j.from} ${j.to}`;
  return new CroftError("USAGE_ERROR", {
    message: `a rename of ${j.from} to ${j.to} did not finish${j.startedAt ? ` (started ${j.startedAt})` : ""}; finish it before another rename`,
    hint: `${command} finishes it; then run this rename again`,
    fix: { kind: "command", description: `finish renaming ${j.from} to ${j.to}`, command },
    effect: "nothing was changed",
    details: { pending: { from: j.from, to: j.to, startedAt: j.startedAt || null } },
  });
}

// ---------------------------------------------------------------------------------------------------------
// Planning

/** runs.sqlite's catalog mirror; empty before the first run or when it cannot be read. */
function readCatalogMirror(stateDir: string): CatalogAsset[] {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return [];
  let db: RunsDb | undefined;
  try {
    db = RunsDb.open(stateDir);
    return db.catalogAll<CatalogAsset>().map((e) => e.value);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

const KIND_WORDS: Record<string, string> = { ingest: "an ingest", sql: "an SQL transform", ts: "a TS transform" };

/** The asset's kind from its file alone (resolve.ts sniffKind, without importing it here). */
function fileKind(a: Pick<DiscoveredAsset, "kind" | "path">): "ingest" | "sql" | "ts" | null {
  if (a.kind === "sql") return "sql";
  try {
    const text = readFileSync(a.path, "utf8");
    const t = /\btransform\s*\(/.test(text);
    const i = /\bingest\s*\(/.test(text);
    return t && !i ? "ts" : i && !t ? "ingest" : null;
  } catch {
    return null;
  }
}

/**
 * The versions trash/<to>/ holds before a rename to `to`: an earlier asset of that name (one deleted before, since
 * planRename refuses a `to` with a table), never the renamed asset's, whose versions are under trash/<from>/. They
 * are kept apart under the first free name of `<to>_earlier`, `<to>_earlier_2`, …: a name no asset file, table,
 * trash folder or refused file has. null when there are none (R41-09).
 */
function earlierVersions(stateDir: string, from: string, to: string, taken: (name: string) => boolean,
  keywords: ReadonlySet<string>): EarlierVersions | null {
  let versions: string[];
  try {
    versions = readdirSync(join(stateDir, "trash", to)).filter((f) => f.endsWith(".duckdb")).map((f) => f.slice(0, -".duckdb".length)).sort();
  } catch {
    return null;
  }
  if (versions.length === 0) return null;
  for (let k = 1; ; k++) {
    const name = k === 1 ? `${to}_earlier` : `${to}_earlier_${k}`;
    if (name === from || taken(name) || existsSync(join(stateDir, "trash", name)) || nameProblem(name, `assets/${name}.ts`, keywords)) continue;
    return { name, versions };
  }
}

/** The rows of a table, in words: " (1,234 rows)", or "" when unknown. */
function rowsWords(rows: number | null | undefined): string {
  return rows === null || rows === undefined ? "" : ` (${rows.toLocaleString("en-US")} row${rows === 1 ? "" : "s"})`;
}

/**
 * Check a rename and list what it touches. Throws NAME_INVALID or NAME_RESERVED (the new name), NAME_CONFLICT (the
 * new name has a file or a table), USAGE_ERROR (the old name is unknown, or another rename has not finished).
 * Reads the asset files and the catalog mirror only; applyRename checks the warehouse under its lock.
 */
export async function planRename(root: string, from: string, to: string, o: { project?: Project } = {}): Promise<RenamePlan> {
  const project = o.project ?? loadProject({ root });
  const { stateDir, assetsDir } = project.paths;
  if (from === to) {
    throw new CroftError("USAGE_ERROR", {
      message: `${from} is already called ${to}`, hint: "name the asset and its new name: croft rename <old> <new>",
      fix: { kind: "manual", description: "give a new name that differs from the old one" },
    });
  }
  const catalog = readCatalogMirror(stateDir);
  const built = new Map(catalog.map((c) => [c.asset, c]));
  const keywords = await sqlKeywordNames();
  const discovery = await discoverAssets(project.root, { assetsDir, keywords });
  const files = new Map(discovery.assets.map((a) => [a.name, a]));
  const journal = readJournal(stateDir);

  if (journal) {
    if (journal.from !== from || journal.to !== to) throw otherRenamePending(journal);
    const entry = built.get(from) ?? built.get(to) ?? null;
    return {
      from, to, fileFrom: journal.fileFrom, fileTo: journal.fileTo, hasTable: entry !== null, mode: "resume", rows: entry?.rows ?? null,
      earlier: journal.earlier,
      references: await findReferences(project, from, existsSync(join(project.root, journal.fileFrom)) ? { from: journal.fileFrom, to: journal.fileTo } : undefined),
    };
  }

  const conflictOf = (name: string) => discovery.problems.find((p) => p.code === "NAME_CONFLICT" && p.details?.name === name);
  const fromConflict = conflictOf(from);
  if (fromConflict) {
    throw new CroftError("NAME_CONFLICT", {
      message: fromConflict.message, hint: `keep one of the files first, then croft rename ${from} ${to}`,
      ...(fromConflict.file ? { file: fromConflict.file } : {}), ...(fromConflict.fix ? { fix: fromConflict.fix } : {}), details: fromConflict.details ?? {},
    });
  }
  // `from`'s file: an asset, or a file discovery refused for its name (renaming fixes a reserved or invalid name).
  const refused = discovery.problems.find((p) => p.code !== "NAME_CONFLICT" && p.details?.name === from && typeof p.file === "string");
  const fromFile = files.get(from)?.file ?? refused?.file ?? null;
  const entry = built.get(from) ?? null;
  if (!fromFile && !entry) {
    const names = [...new Set([...files.keys(), ...built.keys()])].sort();
    const guess = didYouMean(from, names);
    throw new CroftError("USAGE_ERROR", {
      message: `there is no asset or table named ${from}`,
      hint: guess ? `did you mean ${guess}? croft rename ${guess} ${to}` : "croft status lists the assets and their tables",
      fix: guess ? { kind: "command", description: `rename ${guess}`, command: `croft rename ${guess} ${to}` }
        : { kind: "command", description: "list the assets", command: "croft status" },
      effect: "nothing was changed",
      details: { asset: from, ...(guess ? { suggestion: guess } : {}) },
    });
  }

  // `to`: a usable table name, with no file and no table yet.
  const toGuess = fromFile ? join(dirname(fromFile), `${to}${extname(fromFile)}`).split(sep).join("/") : `assets/${to}.ts`;
  const bad = nameProblem(to, toGuess, keywords);
  if (bad) {
    const suggestion = typeof bad.details?.suggestion === "string" ? bad.details.suggestion : null;
    throw new CroftError(bad.code === "NAME_RESERVED" ? "NAME_RESERVED" : "NAME_INVALID", {
      message: bad.message,
      hint: suggestion ? `croft rename ${from} ${suggestion}` : "choose a name of lowercase letters, digits and _, starting with a letter",
      fix: suggestion ? { kind: "command", description: `rename ${from} to ${suggestion} instead`, command: `croft rename ${from} ${suggestion}` }
        : { kind: "manual", description: "choose a name of lowercase letters, digits and _, starting with a letter" },
      effect: "nothing was changed",
      details: { ...bad.details, name: to },
    });
  }
  const toConflict = conflictOf(to);
  if (toConflict) {
    throw new CroftError("NAME_CONFLICT", {
      message: `${to} is taken: ${toConflict.message}`, hint: `choose another name, or remove one of those files first`,
      ...(toConflict.file ? { file: toConflict.file } : {}),
      fix: { kind: "manual", description: `choose a name no file in assets/ has` }, effect: "nothing was changed", details: { name: to, ...toConflict.details },
    });
  }
  const toBuilt = built.get(to);
  if (toBuilt) {
    const hasFile = files.has(to);
    throw new CroftError("NAME_CONFLICT", {
      message: `${to} already names a table${rowsWords(toBuilt.rows)}${hasFile ? ` built from ${files.get(to)!.file}` : " whose asset file is gone"}; a rename never replaces a table`,
      hint: hasFile ? `choose another name: croft rename ${from} ${to}_2, say` : `choose another name, or ask the user what should become of the table ${to} first`,
      fix: { kind: "manual", description: `choose a name that no asset or table has (croft status lists them)`, ...(hasFile ? {} : { requiresHuman: true }) },
      effect: "nothing was changed",
      details: { name: to, rows: toBuilt.rows, file: files.get(to)?.file ?? null },
    });
  }

  const toFile = files.get(to)?.file ?? null;
  const taken = (name: string) => files.has(name) || built.has(name) || discovery.problems.some((p) => p.details?.name === name);
  const earlier = earlierVersions(stateDir, from, to, taken, keywords);
  if (fromFile) {
    if (toFile || existsSync(join(project.root, toGuess))) {
      const at = toFile ?? toGuess;
      throw new CroftError("NAME_CONFLICT", {
        message: `${at} already exists; a rename never replaces another asset's file`,
        hint: `choose another name, or remove ${at} first if it is not needed`, file: at,
        fix: { kind: "manual", description: `choose a name no file in assets/ has, or remove ${at}` },
        effect: "nothing was changed", details: { name: to, file: at },
      });
    }
    return {
      from, to, fileFrom: fromFile, fileTo: toGuess, hasTable: entry !== null, mode: "file", rows: entry?.rows ?? null, earlier,
      references: await findReferences(project, from, { from: fromFile, to: toGuess }),
    };
  }

  // No file for `from`: its table goes to the asset file that took over its code (ASSET_RENAMED's fix).
  if (!toFile) {
    throw new CroftError("USAGE_ERROR", {
      message: `${from} has no asset file, and there is no asset ${to} to take over its table${rowsWords(entry!.rows)}`,
      hint: `croft rename moves an asset: put its file back (assets/${from}.${entry!.kind === "sql" ? "sql" : "ts"}) and run croft rename ${from} ${to} again; or, when assets/ already has its new file, name that file's asset`,
      fix: { kind: "manual", description: `put the asset file of ${from} back, or name the asset that took it over` },
      effect: "nothing was changed",
      details: { asset: from, rows: entry!.rows },
    });
  }
  const toAsset = files.get(to)!;
  const kind = fileKind(toAsset);
  if (kind && entry!.kind && kind !== entry!.kind) {
    throw new CroftError("USAGE_ERROR", {
      message: `${from} was built by ${KIND_WORDS[entry!.kind]}, and ${toFile} is ${KIND_WORDS[kind]}: it cannot take over that table`,
      hint: `to adopt ${from}'s table, ${toFile} must be the same kind of asset as the one that built it; otherwise choose a name for ${to} that is not a rename`,
      file: toFile,
      fix: { kind: "manual", description: `make ${toFile} ${KIND_WORDS[entry!.kind]}, or do not adopt ${from}'s table` },
      effect: "nothing was changed",
      details: { from, to, fromKind: entry!.kind, toKind: kind },
    });
  }
  return {
    from, to, fileFrom: toFile, fileTo: toFile, hasTable: true, mode: "adopt", rows: entry!.rows, earlier,
    references: await findReferences(project, from),
  };
}

// ---------------------------------------------------------------------------------------------------------
// References (never edited: listed for the user or the agent to update)

const LINE_TEXT_MAX = 160;

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

/** The 1-based line of index `at`. */
function lineOf(starts: readonly number[], at: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lineText(text: string, starts: readonly number[], line: number): string {
  const from = starts[line - 1] ?? 0;
  const end = text.indexOf("\n", from);
  const s = text.slice(from, end < 0 ? text.length : end).replace(/\r$/, "").trim();
  return s.length > LINE_TEXT_MAX ? `${s.slice(0, LINE_TEXT_MAX - 1)}…` : s;
}

/** An SQL identifier as written (`x`, `"x"`), compared as DuckDB does: without regard to case. */
function identName(t: { kind: string; text: string }): string | null {
  if (t.kind === "word") return t.text.toLowerCase();
  if (t.kind === "name") return t.text.slice(1, -1).replaceAll('""', '"').toLowerCase();
  return null;
}

/** Lines of SQL text that name `name` as a relation or a qualifier (not as a function call). `offset`: the text's
 *  first line in its file, minus one. */
function sqlHits(sql: string, name: string, offset: number): number[] {
  const { tokens } = lexSql(sql);
  const starts = lineStarts(sql);
  const out: number[] = [];
  tokens.forEach((t, i) => {
    if (identName(t) !== name) return;
    if (tokens[i + 1]?.text === "(") return;
    out.push(offset + lineOf(starts, t.index));
  });
  return out;
}

/** The references in one SQL asset: its body's SQL, and its -- check: / -- warn: header lines. */
function sqlFileRefs(text: string, file: string, name: string): RenameReference[] {
  const { header, body } = parseSqlHeader(text, file);
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const starts = lineStarts(src);
  const out: RenameReference[] = [];
  const add = (line: number, kind: RenameReference["kind"]) => out.push({ file, line, kind, text: lineText(src, starts, line) });
  for (let line = 1; line <= header.lines; line++) {
    const m = /^\s*--\s*(check|warn)\s*:(.*)$/i.exec(lineText(src, starts, line));
    if (m && sqlHits(m[2]!, name, line - 1).length) add(line, "check");
  }
  for (const line of new Set(sqlHits(body, name, header.lines))) add(line, "sql");
  return out;
}

interface JsLiteral { start: number; text: string }

const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * The string literals of JS or TS code (template chunks each on their own; `${…}` stays code), and the code with
 * comments and literal contents blanked (lines kept), for looking at what surrounds a literal. A lexer, like
 * ts-asset.ts stripLiterals: good enough for asset code.
 */
export function jsLiterals(code: string): { literals: JsLiteral[]; blank: string } {
  const literals: JsLiteral[] = [];
  const blank = code.split("");
  const wipe = (a: number, b: number) => {
    for (let k = a; k < b && k < blank.length; k++) if (blank[k] !== "\n") blank[k] = " ";
  };
  const n = code.length;
  let i = 0;
  let depth = 0;
  const templates: number[] = [];
  let last = "";
  const template = () => {                      // i is just past "`" or the "}" closing a `${`
    const from = i;
    while (i < n) {
      const c = code[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === "`") {
        literals.push({ start: from, text: code.slice(from, i) });
        wipe(from, i);
        i++;
        last = "`";
        return;
      }
      if (c === "$" && code[i + 1] === "{") {
        literals.push({ start: from, text: code.slice(from, i) });
        wipe(from, i);
        i += 2;
        templates.push(depth);
        depth++;
        last = "{";
        return;
      }
      i++;
    }
    literals.push({ start: from, text: code.slice(from) });
    wipe(from, n);
  };
  const regexAllowed = () => last === "" || (/^[\w$]+$/.test(last) ? REGEX_AFTER_WORD.has(last) : "(,=:[!&|?{};+-*%<>~^".includes(last));
  while (i < n) {
    const c = code[i]!;
    const d = code[i + 1];
    if (c === "/" && d === "/") {
      const e = code.indexOf("\n", i);
      const end = e < 0 ? n : e;
      wipe(i, end);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = code.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      wipe(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const from = ++i;
      while (i < n && code[i] !== c && code[i] !== "\n") i += code[i] === "\\" ? 2 : 1;
      literals.push({ start: from, text: code.slice(from, Math.min(i, n)) });
      wipe(from, Math.min(i, n));
      i++;
      last = c;
      continue;
    }
    if (c === "`") {
      i++;
      template();
      continue;
    }
    if (c === "/" && regexAllowed()) {
      const from = i;
      i++;
      let inClass = false;
      while (i < n && code[i] !== "\n") {
        const ch = code[i]!;
        if (ch === "\\") { i += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(code[i]!)) i++;
      wipe(from + 1, i - 1);
      last = "/./";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        i++;
        template();
        continue;
      }
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(code[j]!)) j++;
      last = code.slice(i, j);
      i = j;
      continue;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return { literals, blank: blank.join("") };
}

/** Whether the literal at `start` sits inside `key: [ … ]` (an open bracket after the key, not closed yet). */
function insideArray(blank: string, start: number, keys: readonly string[]): boolean {
  const before = blank.slice(0, start);
  const re = new RegExp(`\\b(?:${keys.join("|")})\\s*:\\s*\\[`, "g");
  let at = -1;
  for (let m = re.exec(before); m; m = re.exec(before)) at = m.index + m[0].length;
  if (at < 0) return false;
  let open = 1;
  for (let k = at; k < before.length; k++) {
    if (before[k] === "[") open++;
    else if (before[k] === "]" && --open === 0) return false;
  }
  return true;
}

/** Where `name` occurs in a string as a whole identifier (not inside github_issues_2 or my_github_issues). */
function wordHits(text: string, name: string): number[] {
  const out: number[] = [];
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) {
    const before = lower[at - 1];
    const after = lower[at + name.length];
    if ((before === undefined || !/[a-z0-9_$]/.test(before)) && (after === undefined || !/[a-z0-9_$]/.test(after))) out.push(at);
  }
  return out;
}

/** The references in one TS or JS file: string literals that name the asset. */
function jsFileRefs(text: string, file: string, name: string): RenameReference[] {
  const { literals, blank } = jsLiterals(text);
  const starts = lineStarts(text);
  const seen = new Set<number>();
  const out: RenameReference[] = [];
  for (const lit of literals) {
    const hits = wordHits(lit.text, name);
    if (hits.length === 0) continue;
    const lead = blank.slice(Math.max(0, lit.start - 200), lit.start);
    // A description is prose, not a reference.
    if (/\bdescription\s*:\s*["'`]$/.test(lead)) continue;
    let kind: RenameReference["kind"];
    let at = hits;
    if (lit.text === name) kind = "ts_input";
    else if (/(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\bimport)\s*["'`]$/.test(lead) && /[/\\]/.test(lit.text)) kind = "import";
    else {
      // A URL or a file path names no table: "https://api.github.com/repos/x/issues", "files/sales/*.csv".
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(lit.text.trim())) continue;
      at = hits.filter((h) => lit.text[h - 1] !== "/" && lit.text[h + name.length] !== "/");
      kind = insideArray(blank, lit.start, ["checks", "warnings"]) ? "check" : "sql";
    }
    for (const h of at) {
      const line = lineOf(starts, lit.start + h);
      if (seen.has(line)) continue;
      seen.add(line);
      out.push({ file, line, kind, text: lineText(text, starts, line) });
    }
  }
  return out;
}

const CODE_FILES = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,mjs,cjs,sql}");

/**
 * Every place in the project's code that names `name`: the asset files in assets/ (SQL FROM/JOIN and checks; TS
 * `inputs`, rows("…")/newRows("…"), SQL strings and checks) and the shared code in lib/. `moved`: the renamed
 * file, reported under its new path. Read only: croft never edits user code.
 */
export async function findReferences(project: Pick<Project, "root" | "paths">, name: string, moved?: { from: string; to: string }): Promise<RenameReference[]> {
  const out: RenameReference[] = [];
  for (const dir of [project.paths.assetsDir, project.paths.libDir]) {
    if (!existsSync(dir)) continue;
    for (const rel of [...CODE_FILES.scanSync({ cwd: dir, onlyFiles: true })].sort()) {
      if (rel.endsWith(".d.ts") || rel.split("/").includes("node_modules")) continue;
      const path = join(dir, rel);
      const file = relative(project.root, path).split(sep).join("/");
      if (dir === project.paths.libDir && rel.endsWith(".sql")) continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(name)) continue;
      const shown = moved && file === moved.from ? moved.to : file;
      out.push(...(rel.endsWith(".sql") ? sqlFileRefs(text, shown, name) : jsFileRefs(text, shown, name)));
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

// ---------------------------------------------------------------------------------------------------------
// ASSET_RENAMED

export interface FindRenamedOptions {
  /** The project, when the caller has it loaded. */
  project?: Pick<Project, "root" | "timezone" | "paths">;
  /** The asset files, when the caller has discovered them. */
  discovered?: readonly DiscoveredAsset[];
  /** The catalog mirror, when the caller has read it. */
  catalog?: readonly CatalogAsset[];
  /** Code hashes the caller already knows (a resolved project): a string, null for an asset whose code has none
   *  (it does not parse or bundle), undefined when unknown, and then it is computed here (parsed or bundled,
   *  never imported). */
  codeHash?: (asset: string) => string | null | undefined;
}

/** Hashes never-built candidates the way resolve.ts does, without importing any code: an SQL file is parsed on a
 *  private in-memory DuckDB; a TS file is bundled. */
class CandidateHasher {
  private memory: { close(): void; connect(): Promise<DuckDBConnection> } | null = null;
  private conn: DuckDBConnection | null = null;

  constructor(private readonly project: Pick<Project, "root" | "timezone">, private readonly names: readonly string[]) {}

  async hash(a: DiscoveredAsset): Promise<string | null> {
    try {
      if (a.kind === "sql") {
        const { loadSqlAsset } = await import("./sql-asset.ts");
        if (!this.conn) {
          const { openMemory } = await import("../db/connect.ts");
          this.memory = await openMemory({ timezone: this.project.timezone });
          this.conn = await this.memory.connect();
        }
        const loaded = await loadSqlAsset(a, { root: this.project.root, timezone: this.project.timezone, conn: this.conn, assetNames: this.names });
        return loaded.codeHash ?? null;
      }
      const { tsFingerprint } = await import("./ts-asset.ts");
      return await tsFingerprint(a.path, { root: this.project.root, timezone: this.project.timezone });
    } catch {
      return null;
    }
  }

  close(): void {
    this.memory?.close();
    this.memory = null;
    this.conn = null;
  }
}

/**
 * The assets renamed outside croft: a never-built asset (no catalog entry) whose code hash equals the recorded code
 * hash of an orphan table (a catalog entry without an asset file). Also a croft rename that did not finish (its
 * journal), with `unfinished`. Cheap: the catalog mirror and the asset files; code is hashed only for never-built
 * candidates while an orphan exists, and never imported. Never throws for a project it can read.
 */
export async function findRenamed(root: string, o: FindRenamedOptions = {}): Promise<RenamedAsset[]> {
  const project = o.project ?? loadProject({ root });
  const { stateDir, assetsDir } = project.paths;
  const catalog = o.catalog ?? readCatalogMirror(stateDir);
  const discovered = o.discovered ?? (await discoverAssets(project.root, { assetsDir })).assets;
  const journal = readJournal(stateDir);
  const files = new Map(discovered.map((a) => [a.name, a]));
  const built = new Set(catalog.map((c) => c.asset));
  const out: RenamedAsset[] = [];

  const pending = (name: string) => journal !== null && (name === journal.from || name === journal.to);
  const orphans = catalog.filter((c) => !files.has(c.asset) && typeof c.codeHash === "string" && c.codeHash && !pending(c.asset));
  const candidates = discovered.filter((a) => !built.has(a.name) && !pending(a.name));
  if (orphans.length > 0 && candidates.length > 0) {
    const byHash = new Map<string, CatalogAsset[]>();
    for (const c of orphans) byHash.set(c.codeHash!, [...(byHash.get(c.codeHash!) ?? []), c]);
    const hasher = new CandidateHasher(project, discovered.map((a) => a.name));
    try {
      for (const a of candidates) {
        let hash = o.codeHash?.(a.name);
        if (hash === undefined) hash = await hasher.hash(a);
        if (!hash) continue;
        for (const c of byHash.get(hash) ?? []) out.push({ from: c.asset, to: a.name, file: a.file, rows: c.rows ?? null });
      }
    } finally {
      hasher.close();
    }
  }
  if (journal) {
    const entry = catalog.find((c) => c.asset === journal.from) ?? catalog.find((c) => c.asset === journal.to);
    out.push({ from: journal.from, to: journal.to, file: journal.fileTo, rows: entry?.rows ?? null, unfinished: true });
  }
  return out.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** ASSET_RENAMED for one renamed asset, as validate, status and describe report it: the fix adopts the table (or
 *  finishes the rename), never a refetch. */
export function renamedProblem(r: RenamedAsset): Problem {
  const command = `croft rename ${r.from} ${r.to}`;
  const details = { from: r.from, to: r.to, rows: r.rows ?? null, unfinished: r.unfinished === true };
  if (r.unfinished) {
    return problem("ASSET_RENAMED", {
      asset: r.to, ...(r.file ? { file: r.file } : {}),
      message: `croft rename ${r.from} ${r.to} did not finish: the table${rowsWords(r.rows)}, its state and the asset file may be under either name`,
      hint: `${command} finishes it; run neither ${r.from} nor ${r.to} before that`,
      fix: { kind: "command", description: `finish renaming ${r.from} to ${r.to}`, command },
      details,
    });
  }
  return problem("ASSET_RENAMED", {
    asset: r.to, ...(r.file ? { file: r.file } : {}),
    message: `${r.file ?? r.to} has never been built, and its code is the code that built ${r.from}${rowsWords(r.rows)}, whose asset file is gone: ${r.from} was renamed outside croft`,
    hint: `${command} adopts ${r.from}'s table, cursor and history; running ${r.to} first would fetch everything again into a new table`,
    fix: { kind: "command", description: `adopt ${r.from}'s table and state as ${r.to}`, command },
    details,
  });
}

/**
 * The error a command that would change `asset` throws (croft delete, croft restore) while a croft rename that did
 * not finish names it, either name: ASSET_RENAMED, whose fix finishes the rename first. null otherwise. A restore of
 * the old name meanwhile would bring back a table that the rename then refuses to replace, so it could never finish;
 * runs and previews refuse the same way (run/plan.ts). Reads only the journal.
 */
export function unfinishedRename(stateDir: string, asset: string): CroftError | null {
  const j = readJournal(stateDir);
  if (!j || (asset !== j.from && asset !== j.to)) return null;
  const p = renamedProblem({ from: j.from, to: j.to, file: j.fileTo, unfinished: true });
  return new CroftError("ASSET_RENAMED", {
    message: p.message, hint: p.hint, asset, ...(p.file ? { file: p.file } : {}), ...(p.fix ? { fix: p.fix } : {}),
    effect: "nothing was changed", ...(p.details ? { details: p.details } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------
// Applying

/** _croft tables and the column that names the asset. `inputs` also names it as an input (below). */
const STATE_MOVES: readonly [table: string, column: string][] = [
  ["assets", "name"], ["columns", "asset"], ["inputs", "asset"], ["files", "asset"], ["writes", "asset"],
];

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** What names `name` in a database's main schema: a table, a view, or nothing. Without regard to case, as DuckDB
 *  resolves names. */
async function relationOf(sql: Sql, database: string, name: string): Promise<"table" | "view" | null> {
  const rows = await sql.all<{ k: string }>(
    `SELECT 'table' AS k FROM duckdb_tables() WHERE database_name = $1 AND schema_name = 'main' AND lower(table_name) = $2
     UNION ALL SELECT 'view' FROM duckdb_views() WHERE database_name = $1 AND schema_name = 'main' AND lower(view_name) = $2 AND NOT internal`,
    [database, name]);
  return rows.some((r) => r.k === "table") ? "table" : rows.length ? "view" : null;
}

function nameTaken(to: string, what: string): CroftError {
  return new CroftError("NAME_CONFLICT", {
    message: `the warehouse already has ${what} named ${to}; a rename never replaces one`,
    hint: `choose another name; croft query "SELECT count(*) FROM ${to}" shows what is there`,
    fix: { kind: "manual", description: `choose a name no table in the warehouse has` },
    effect: "nothing was changed", details: { name: to },
  });
}

const HAS_STATE = `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE schema_name = '_croft' AND table_name = 'meta' AND database_name = current_database()`;

/**
 * Step 1: the table and its _croft rows, and (inside the same transaction) the asset file. Returns the rows of the
 * renamed table, or null when the warehouse has none.
 */
async function renameInWarehouse(w: DuckWarehouse, runs: RunsDb, plan: RenamePlan, runId: string, moveFile: () => void,
  point: (at: RenamePoint) => void): Promise<{ renamed: boolean; rows: number | null }> {
  const { from, to } = plan;
  const resume = plan.mode === "resume";
  return w.write(`rename ${from} to ${to}`, async (tx) => {
    // Who holds the file, for other processes' lock messages; set only once this lease has it.
    runs.setLockHolder({ runId, asset: from, action: "rename" });
    try {
      const [{ db } = { db: "" }] = await tx.all<{ db: string }>(`SELECT current_database() AS db`);
      const fromRel = await relationOf(tx, db, from);
      const toRel = await relationOf(tx, db, to);
      if (fromRel === "view") throw nameTaken(from, "a view (not a table croft built)");
      if (toRel && (fromRel || !resume || toRel === "view")) throw nameTaken(to, toRel === "view" ? "a view" : "a table");
      // DDL first, then the _croft rows (DDL after DML on one table fails at COMMIT; db/tx-guard.ts).
      if (fromRel === "table") await tx.exec(`ALTER TABLE ${quoteIdent(db)}.main.${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`);
      const [{ n = 0 } = {}] = await tx.all<{ n: number }>(HAS_STATE);
      if (n > 0) {
        const [s = { f: 0, t: 0 }] = await tx.all<{ f: number; t: number }>(
          `SELECT count(*) FILTER (WHERE name = $1)::INTEGER AS f, count(*) FILTER (WHERE name = $2)::INTEGER AS t FROM _croft.assets`, [from, to]);
        if (s.t > 0 && (s.f > 0 || !resume)) throw nameTaken(to, "croft state (a table recorded in _croft.assets)");
        for (const [table, column] of STATE_MOVES) {
          await tx.exec(`UPDATE _croft.${table} SET ${column} = $2 WHERE ${column} = $1`, [from, to]);
        }
        await tx.exec(`UPDATE _croft.inputs SET input = $2 WHERE input = $1`, [from, to]);
      }
      let rows: number | null = null;
      if (fromRel === "table" || toRel === "table") {
        const [c] = await tx.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${quoteIdent(db)}.main.${quoteIdent(to)}`);
        rows = Number(c?.n ?? 0);
      }
      // The file moves inside the transaction: a failure to move it rolls the warehouse back, and a stop before
      // the COMMIT leaves only the file moved (the state findRenamed reports, which a second rename finishes).
      moveFile();
      point("rename_before_commit");
      return { renamed: fromRel === "table", rows };
    } finally {
      runs.clearLockHolder();
    }
  }, { runId, asset: from });
}

/** Step 2: runs.sqlite, in one transaction. The catalog entry and every reader's record of it, schedule_state (the
 *  approved code travels with the asset), and the steps (the asset's history). */
function renameInRuns(runs: RunsDb, from: string, to: string): void {
  runs.transaction(() => {
    const entry = runs.catalogGet<CatalogAsset>(from);
    if (entry) {
      if (!runs.catalogGet(to)) runs.catalogPut(to, { ...entry.value, asset: to }, entry.source);
      runs.catalogDelete(from);
    }
    for (const e of runs.catalogAll<CatalogAsset>()) {
      const v = e.value;
      let changed = false;
      if (Array.isArray(v.reads) && v.reads.includes(from)) {
        v.reads = [...new Set(v.reads.map((r) => (r === from ? to : r)))];
        changed = true;
      }
      if (v.inputsSeen && Object.hasOwn(v.inputsSeen, from)) {
        const seen = { ...v.inputsSeen };
        if (!Object.hasOwn(seen, to)) seen[to] = seen[from]!;
        delete seen[from];
        v.inputsSeen = seen;
        changed = true;
      }
      if (changed) runs.catalogPut(e.asset, v, e.source);
    }
    const s = runs.scheduleState(from);
    if (s) {
      const t = runs.scheduleState(to);
      runs.putScheduleState(to, {
        approvedCodeHash: s.approvedCodeHash ?? t?.approvedCodeHash ?? null,
        lastFireAt: s.lastFireAt ?? t?.lastFireAt ?? null,
        lastAttemptAt: s.lastAttemptAt ?? t?.lastAttemptAt ?? null,
        phrase: t?.phrase ?? s.phrase, cron: t?.cron ?? s.cron,
        // The scheduler's facts are cached by name and file hash: it reads the renamed file once more.
        fileHash: t?.fileHash ?? null,
      });
      runs.deleteScheduleState(from);
    }
    runs.sqlite.query("UPDATE OR IGNORE steps SET asset = ? WHERE asset = ?").run(to, from);
  });
}

let attachSeq = 0;

/** Rename the table and _croft rows inside one trash file (so restore finds main.<to> in it). Idempotent. */
async function rewriteTrashFile(w: DuckWarehouse, path: string, from: string, to: string, runId: string): Promise<void> {
  const alias = `croft_rename_${process.pid}_${++attachSeq}`;
  await w.write(`rename ${from} in the trash`, async (sql: LeaseSql) => {
    await sql.exec(`ATTACH ${quoteLiteral(path)} AS ${quoteIdent(alias)}`);
    try {
      await sql.exec("BEGIN TRANSACTION");
      try {
        const t = quoteIdent(alias);
        const tables = await sql.all<{ s: string; n: string }>(
          `SELECT schema_name AS s, table_name AS n FROM duckdb_tables() WHERE database_name = $1`, [alias]);
        const has = (schema: string, name: string) => tables.some((x) => x.s === schema && x.n === name);
        if (has("main", from) && !has("main", to)) await sql.exec(`ALTER TABLE ${t}.main.${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`);
        for (const [table, column] of [...STATE_MOVES, ["trash", "asset"] as const]) {
          if (has("_croft", table)) await sql.exec(`UPDATE ${t}._croft.${table} SET ${column} = $2 WHERE ${column} = $1`, [from, to]);
        }
        if (has("_croft", "inputs")) await sql.exec(`UPDATE ${t}._croft.inputs SET input = $2 WHERE input = $1`, [from, to]);
        await sql.exec("COMMIT");
      } catch (e) {
        try {
          await sql.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    } finally {
      await sql.exec(`DETACH ${quoteIdent(alias)}`).catch(() => {});
    }
  }, { runId, asset: from, transaction: false });
}

function moveSidecar(src: string, dst: string, to: string, trashFile: string): void {
  if (!existsSync(src)) return;
  try {
    const meta = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
    writeFileSync(`${dst}.tmp`, JSON.stringify({ ...meta, asset: to, path: trashFile }, null, 1));
    renameSync(`${dst}.tmp`, dst);
    rmSync(src, { force: true });
  } catch {
    renameSync(src, dst);
  }
}

/**
 * Step 3a: the versions of an earlier asset named `to` (EarlierVersions, listed in the journal) from trash/<to>/ to
 * trash/<earlier.name>/: each file is moved first, so it is never under `to` again, and then renamed inside (its
 * table and _croft rows), so `croft restore <earlier.name>` finds main.<earlier.name> in it. Each step checks what
 * is there, so a second run does only what is left (renaming inside again is a no-op). A version whose table could
 * not be renamed inside stays apart all the same, in `left`: restore says it holds no such table.
 */
async function moveEarlier(w: DuckWarehouse | null, stateDir: string, to: string, earlier: EarlierVersions, runId: string):
  Promise<NonNullable<RenameResult["trash"]["earlier"]>> {
  const src = join(stateDir, "trash", to);
  const dst = join(stateDir, "trash", earlier.name);
  const out = { name: earlier.name, versions: 0, left: [] as string[] };
  for (const stamp of earlier.versions) {
    const file = join(src, `${stamp}.duckdb`);
    const moved = join(dst, `${stamp}.duckdb`);
    if (!existsSync(moved)) {
      if (!existsSync(file)) continue;     // gone since the rename started (a prune): nothing to keep apart
      mkdirSync(dst, { recursive: true });
      renameSync(file, moved);
    }
    if (existsSync(`${file}.wal`) && !existsSync(`${moved}.wal`)) renameSync(`${file}.wal`, `${moved}.wal`);
    if (existsSync(join(src, `${stamp}.json`)) && !existsSync(join(dst, `${stamp}.json`))) {
      moveSidecar(join(src, `${stamp}.json`), join(dst, `${stamp}.json`), earlier.name, moved);
    }
    try {
      if (!w) throw new Error("no warehouse to rename it with");
      await rewriteTrashFile(w, moved, to, earlier.name, runId);
      out.versions++;
    } catch {
      out.left.push(moved);
    }
  }
  try {
    rmdirSync(src);
  } catch {
    // Not empty (or gone): what else is there is not the earlier asset's.
  }
  return out;
}

/** Step 3b: trash/<from>/ to trash/<to>/, each version renamed inside its file first. `reserved`: the stamps of the
 *  earlier versions of `to` (moveEarlier), which a moved version never takes as its name. */
async function moveTrash(w: DuckWarehouse | null, stateDir: string, from: string, to: string, runId: string,
  reserved: ReadonlySet<string> = new Set()): Promise<{ versions: number; left: string[] }> {
  const src = join(stateDir, "trash", from);
  const dst = join(stateDir, "trash", to);
  const out = { versions: 0, left: [] as string[] };
  if (!existsSync(src) || !statSync(src).isDirectory()) return out;
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src).filter((x) => x.endsWith(".duckdb")).sort()) {
    const stamp = f.slice(0, -".duckdb".length);
    const file = join(src, f);
    try {
      if (w) await rewriteTrashFile(w, file, from, to, runId);
    } catch {
      out.left.push(file);
      continue;
    }
    let name = stamp;
    for (let k = 2; existsSync(join(dst, `${name}.duckdb`)) || reserved.has(name); k++) name = `${stamp}-${k}`;
    const moved = join(dst, `${name}.duckdb`);
    renameSync(file, moved);
    if (existsSync(`${file}.wal`)) renameSync(`${file}.wal`, `${moved}.wal`);
    moveSidecar(join(src, `${stamp}.json`), join(dst, `${name}.json`), to, moved);
    out.versions++;
  }
  // A sidecar whose version moved before a stop.
  for (const f of readdirSync(src).filter((x) => x.endsWith(".json"))) {
    const moved = join(dst, `${f.slice(0, -".json".length)}.duckdb`);
    if (existsSync(moved) && !existsSync(join(dst, f))) moveSidecar(join(src, f), join(dst, f), to, moved);
  }
  try {
    rmdirSync(src);
  } catch {
    // Not empty: versions that could not be rewritten stay under the old name.
  }
  try {
    rmdirSync(dst);
  } catch {}
  return out;
}

/** Whether the last preview built or read `name`: its catalog (.croft/preview/runs.sqlite) or its snapshot. */
function previewMentions(dir: string, name: string): boolean {
  if (existsSync(join(dir, `${name}.parquet`))) return true;
  if (!existsSync(join(dir, RUNS_DB_FILE))) return false;
  let db: RunsDb | undefined;
  try {
    db = RunsDb.open(dir);
    return db.catalogAll<CatalogAsset>().some(({ value: v }) => v.asset === name || (v.reads ?? []).includes(name)
      || (v.inputsSeen !== undefined && Object.hasOwn(v.inputsSeen, name)));
  } catch {
    return true;   // unreadable: clear it rather than leave a preview of the old name
  } finally {
    db?.close();
  }
}

/** Step 4: empty the preview when it involves `from` (under the preview database's own lock, as a preview holds it),
 *  so nothing shows the old name. The next `croft preview` builds it again. */
async function clearPreview(project: Project, from: string, runId: string): Promise<RenameResult["preview"]> {
  const { PREVIEW_DATABASE, PREVIEW_DIR, LIVE_SCHEMA } = await import("../run/preview.ts");
  const { stateDir } = project.paths;
  const dir = join(stateDir, PREVIEW_DIR);
  const path = join(stateDir, PREVIEW_DATABASE);
  if (!previewMentions(dir, from)) return "none";
  if (!existsSync(path)) {
    rmSync(dir, { recursive: true, force: true });
    return "cleared";
  }
  const { openWarehouse } = await import("../db/warehouse.ts");
  const pdb = openWarehouse({
    path, mode: "read_write", writeIntent: false, register: false, label: "the preview database",
    timezone: project.timezone, root: project.root, stateDir, waits: { offTtyMs: 5000, ttyReadMs: 5000, ttyWriteMs: 5000 },
  });
  try {
    await pdb.write("clear the preview", async (tx) => {
      const objects = await tx.all<{ name: string; kind: string }>(
        `SELECT view_name AS name, 'VIEW' AS kind FROM duckdb_views() WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal
         UNION ALL
         SELECT table_name, 'TABLE' FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal`);
      for (const o of objects) await tx.exec(`DROP ${o.kind} IF EXISTS main.${quoteIdent(o.name)}`);
      await tx.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(LIVE_SCHEMA)} CASCADE`);
      await tx.exec(`DROP SCHEMA IF EXISTS _croft CASCADE`);
      rmSync(dir, { recursive: true, force: true });
    }, { runId, transaction: false });
    return "cleared";
  } catch {
    return "kept";
  } finally {
    await pdb.close();
  }
}

/** A failure after the warehouse committed: the rest is left to a second rename, which the error names. */
function unfinishedError(plan: RenamePlan, e: unknown): CroftError {
  const base = e instanceof CroftError ? e : null;
  const why = base?.problem.message ?? String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300);
  const command = `croft rename ${plan.from} ${plan.to}`;
  return new CroftError(base && isCode(base.code) ? base.code : "INTERNAL_ERROR", {
    ...(base?.problem.details ? { details: base.problem.details } : {}),
    asset: plan.to,
    message: `${plan.from} was renamed to ${plan.to} in the warehouse, but the rename stopped before it finished: ${why}`,
    hint: `${command} again finishes it (croft status shows it until then); run neither name before that`,
    fix: { kind: "command", description: `finish renaming ${plan.from} to ${plan.to}`, command },
    effect: "the table and its _croft state have the new name; runs.sqlite, the trash or the preview may still use the old one",
    retryable: true,
  });
}

/**
 * Carry out a plan (planRename): take the leases of both names (refused at once while a run holds either: ASSET_BUSY)
 * and the warehouse's write lock, then move the file, the table, the _croft rows, runs.sqlite's records, the trash
 * and the preview, in the order the header gives. A second call with the same names finishes a rename that stopped.
 */
export async function applyRename(root: string, plan: RenamePlan, o: ApplyRenameOptions = {}): Promise<RenameResult> {
  const project = o.project ?? loadProject({ root });
  const { stateDir, database } = project.paths;
  const clock = o.now ?? (() => clockNow());
  const point = (at: RenamePoint) => {
    o.onPoint?.(at);
    if (o.fault === at) process.kill(process.pid, "SIGKILL");
  };
  const { from, to } = plan;
  const src = join(project.root, plan.fileFrom);
  const dst = join(project.root, plan.fileTo);
  let fileMoved = false;
  const moveFile = () => {
    if (plan.mode === "adopt" || plan.fileFrom === plan.fileTo) return;
    const hasSrc = existsSync(src);
    const hasDst = existsSync(dst);
    if (hasSrc && hasDst) {
      throw new CroftError("NAME_CONFLICT", {
        message: `${plan.fileTo} already exists next to ${plan.fileFrom}; a rename never replaces another asset's file`,
        hint: `remove one of the two files, then croft rename ${from} ${to}`, file: plan.fileTo,
        fix: { kind: "manual", description: `keep one of ${plan.fileFrom} and ${plan.fileTo}` }, effect: "nothing was changed",
      });
    }
    if (hasSrc) {
      renameSync(src, dst);
      fileMoved = true;
    } else if (!hasDst) {
      throw new CroftError("USAGE_ERROR", {
        message: `${plan.fileFrom} is gone, and ${plan.fileTo} does not exist either`,
        hint: `put the asset file back as ${plan.fileFrom} or ${plan.fileTo}, then croft rename ${from} ${to}`,
        fix: { kind: "manual", description: `put the asset file of ${from} back` }, effect: "nothing was changed",
      });
    }
  };
  const undoFile = () => {
    if (!fileMoved) return;
    try {
      if (!existsSync(src)) renameSync(dst, src);
    } catch {}
    fileMoved = false;
  };

  mkdirSync(stateDir, { recursive: true });
  const runs = RunsDb.open(stateDir, { now: clock });
  const { openWarehouse } = await import("../db/warehouse.ts");
  const { busyError, release, tryAcquire } = await import("../history/leases.ts");
  let warehouse: DuckWarehouse | null = null;
  let runId: string | null = null;
  let committed = false;
  let journaled = false;
  try {
    const problems: Problem[] = [];
    const hasDb = existsSync(database);
    if (hasDb) {
      warehouse = openWarehouse({
        path: database, mode: "read_write", timezone: project.timezone, root: project.root, stateDir, isTTY: o.interactive === true,
        lookupHolder: (pid) => {
          const h = runs.getLockHolder();
          return h && h.pid === pid ? h : null;
        },
        ...(o.onWait ? { onWait: o.onWait } : {}),
      });
      // Every command that writes starts with reconcile() (§5 "Crash recovery"): dead runs' leases go first.
      const { reconcile } = await import("../history/reconcile.ts");
      const rec = await reconcile({ db: runs, warehouse });
      for (const dir of rec.stagingDirs) rmSync(dir, { recursive: true, force: true });
      problems.push(...rec.problems);
    }

    // Both names, at once: a run that holds either refuses the rename (it never waits for a run). And the name the
    // earlier versions of `to` are kept under, so no restore reads them while they move.
    const id = newRunId(clock(), project.timezone);
    const got = tryAcquire(runs, [from, to, ...(plan.earlier ? [plan.earlier.name] : [])], id);
    if (!got.ok) throw busyError(runs, got.busy[0]!);
    runId = runs.createRun({ id, trigger: "manual", human: true, argv: ["rename", from, to], timeZone: project.timezone }).id;

    // A resumed rename keeps its journal's mode and start; this run takes it over.
    const earlier = plan.mode === "resume" ? readJournal(stateDir) : null;
    const journal: RenameJournal = {
      from, to, fileFrom: plan.fileFrom, fileTo: plan.fileTo, mode: earlier?.mode ?? (plan.mode === "adopt" ? "adopt" : "file"),
      startedAt: earlier?.startedAt || clock().toISOString(), runId, earlier: plan.earlier,
    };
    writeJournal(stateDir, journal, plan.mode === "resume");
    journaled = true;

    // 1. The warehouse (and the file, inside its transaction).
    let table: RenameResult["table"] = { renamed: false, rows: null };
    try {
      if (warehouse) table = await renameInWarehouse(warehouse, runs, plan, runId, moveFile, point);
      else moveFile();
    } catch (e) {
      undoFile();
      throw e;
    }
    committed = true;
    point("rename_after_commit");

    // 2. runs.sqlite.
    renameInRuns(runs, from, to);
    point("rename_after_state");

    // 3. The trash: an earlier asset's versions of `to` apart first, then the renamed asset's own.
    const kept = plan.earlier ? await moveEarlier(warehouse, stateDir, to, plan.earlier, runId) : null;
    point("rename_after_earlier");
    const trash = { ...await moveTrash(warehouse, stateDir, from, to, runId, new Set(plan.earlier?.versions ?? [])), earlier: kept };
    point("rename_after_trash");

    // 4. The preview.
    const preview = await clearPreview(project, from, runId);

    removeJournal(stateDir);
    journaled = false;
    const result: RenameResult = {
      from, to, mode: plan.mode, runId,
      file: { from: plan.fileFrom, to: plan.fileTo, moved: fileMoved },
      table, trash, preview,
      references: await findReferences(project, from),
      problems,
    };
    runs.finishRun(runId, "succeeded", { data: { runId, status: "succeeded", steps: [], rename: { from, to, mode: plan.mode } }, problems: [], next: [], exit: 0, ok: true });
    if (project.config.readCopy && warehouse) {
      try {
        const { refreshReadCopy } = await import("../db/readcopy.ts");
        await refreshReadCopy(project.root, { project, warehouse, runId });
      } catch {
        // The rename stands; the read copy catches up with the next run.
      }
    }
    return result;
  } catch (e) {
    // A fresh rename that failed before anything moved leaves nothing behind; after that, the journal stays so that
    // the same command finishes it (and findRenamed says so).
    if (journaled && !committed && plan.mode !== "resume") removeJournal(stateDir);
    const err = committed ? unfinishedError(plan, e) : e;
    if (runId) {
      const p = err instanceof CroftError ? err.problem : problem("INTERNAL_ERROR", { message: String((err as Error)?.message ?? err), hint: "report this croft bug" });
      runs.finishRun(runId, "failed", {
        data: { runId, status: "failed", steps: [], rename: { from, to, mode: plan.mode } }, problems: [p], next: [], exit: err instanceof CroftError ? err.exit : 1, ok: false,
      });
    }
    throw err;
  } finally {
    if (runId) release(runs, runId);
    runs.close();
    await warehouse?.close();
  }
}


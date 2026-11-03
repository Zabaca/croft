// Moving a project's file warehouse into a lake (DESIGN.md D155 to D161; option 07, slice 4). The work behind `croft move-to-lake`
// (cli/commands/move-to-lake.ts), which owns the question, the confirmation and the run record.
//
// The file is the way back, so nothing here ever writes it. The whole move reads a *backup* of the file, made by croft's own backup first
// (db/backup.ts backupProject, a checkpointed clone taken under the file's lock), and the file itself is touched by nobody but the backup:
//
//   1. the inventory of the file: every table of `main` with its columns and rows, the bookkeeping rows, what cannot come along (views,
//      macros, ...), and the columns a lake cannot store (found before anything starts, with the cast that fixes each);
//   2. the lake is looked at with the read-only login: it must hold nothing (or hold exactly the copy an interrupted move made);
//   3. the backup, then a fingerprint (sha256, in a child process: a descriptor of this process on the file would drop its lock, §5) of
//      the file and of the backup's copy of it, which must be the same bytes;
//   4. the copy: ONE lake transaction attaches the backup's file read-only and creates every table with `CREATE TABLE ... AS SELECT *`
//      (types exact), loads every `_croft` table into the log adapter's logs, and writes a marker row into `_croft.meta`. One snapshot, so
//      the lake holds all of it or nothing;
//   5. the proof: a new instance with the READ-ONLY login and key (so that also proves the reader's credentials) compares every table
//      with the backup's, row for row (EXCEPT ALL both ways and the counts), the column types, and every `_croft` view with the file's
//      bookkeeping;
//   6. the file is fingerprinted again: if it changed (something wrote it meanwhile) the copy is undone and nothing is switched;
//   7. the switch: `lake.enabled` in croft.json from false to true, one token replaced, written whole by a rename.
//
// A kill -9 at any point leaves the project on the file (the switch is the last step and is one rename) and the lake empty or holding
// the marked copy, which the next `croft move-to-lake` recognises (the marker, and the commit tag of the lake's newest snapshot being the
// copy's own) and finishes by proving it again and switching, without copying twice.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Sql } from "../core/types.ts";
import { type ProjectEnv } from "../project/env.ts";
import { scanJson } from "../project/json-locate.ts";
import { lakeLabel } from "../project/lake-config.ts";
import { CONFIG_FILE, parseConfig, type Project } from "../project/root.ts";
import { quoteIdent, quoteLiteral } from "../load/evolve.ts";
import { withTrashFile } from "../safety/trash.ts";
import { ASSET_TABLES, bookkeepingOf, STATE_SPECS, type StateTableName } from "./bookkeeping.ts";
import { lakeCastFix, lakeOption, lakeRefusedColumns, type LakeRefusedKind } from "./lake.ts";
import { ensureState } from "./state.ts";
import { type DuckWarehouse, openWarehouse } from "./warehouse.ts";

/** The key of `_croft.meta` that marks a lake as holding the copy a move made (its value is a MoveMarker, as JSON). */
export const MOVE_MARKER = "moved_into_lake";
/** The folder of the state folder the move's lake handles are named after; nothing is ever made there. */
const MOVE_DIR = "move";

// ---- What the file holds -----------------------------------------------------------------------------------------

export interface MovedTable {
  name: string;
  rows: number;
  columns: { name: string; type: string }[];
}

export interface NotMoved {
  /** "view", "macro", "sequence", "index", "type", or "table in schema <s>". */
  kind: string;
  name: string;
}

export interface MoveInventory {
  /** The tables of `main`, by name: all of them move. */
  tables: MovedTable[];
  /** The latest rows of each `_croft` table (the file adapter's tables, or the log adapter's views). */
  bookkeeping: { table: StateTableName; rows: number }[];
  /** What is in the file that a lake project has no place for: it stays in the file, and the move says so. */
  notMoved: NotMoved[];
  /** `_croft.meta` format_version of the file, or null (a file croft never wrote state into). */
  formatVersion: string | null;
  /** A hash of the counts and stamps the confirmation is for: a table written or replaced since is a different generation. */
  generation: string;
}

/** The names of a state table's columns, from the spec the adapters share. */
function stateColumns(t: Exclude<StateTableName, "meta">): string[] {
  return STATE_SPECS[t].columns.split(",").map((c) => c.trim().split(/\s+/)[0]!).filter(Boolean);
}

/** The latest rows of a `_croft` table in `pre` (a database alias with a dot, or ""): a plain SELECT for the file adapter, the log's newest
 *  row of each key for the log adapter. Spelled out, with the row id as the tiebreak, because the view of a file made before D154 breaks a tie as DuckDB happens to. */
function latestRows(pre: string, t: Exclude<StateTableName, "meta">, log: boolean): string {
  if (!log) return `SELECT * FROM ${pre}_croft.${t}`;
  const key = STATE_SPECS[t].key.join(", ");
  return `SELECT * EXCLUDE (seq, closed) FROM ${pre}_croft.${t}_log QUALIFY row_number() OVER (PARTITION BY ${key} ORDER BY seq DESC NULLS LAST, rowid DESC) = 1 AND NOT coalesce(closed, false)`;
}

const num = (v: unknown): number => Number(v ?? 0);

/**
 * What `sql`'s database holds: the live file (`alias` null, the connection's own database) or an attached copy of it. Read-only.
 */
export async function inventoryOf(sql: Sql, alias: string | null): Promise<MoveInventory> {
  const db = alias ?? (await sql.all<{ db: string }>("SELECT current_database() AS db"))[0]!.db;
  const pre = alias ? `${quoteIdent(alias)}.` : "";
  const objects = await sql.all<{ schema: string; name: string }>(
    `SELECT schema_name AS schema, table_name AS name FROM duckdb_tables() WHERE database_name = $1 AND NOT internal ORDER BY schema_name, table_name`, [db]);
  const cols = await sql.all<{ t: string; name: string; type: string }>(
    `SELECT table_name AS t, column_name AS name, data_type AS type FROM duckdb_columns() WHERE database_name = $1 AND schema_name = 'main' ORDER BY table_name, column_index`, [db]);
  const tables: MovedTable[] = [];
  for (const t of objects.filter((o) => o.schema === "main")) {
    const [n] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${pre}main.${quoteIdent(t.name)}`);
    tables.push({ name: t.name, rows: num(n?.n), columns: cols.filter((c) => c.t === t.name).map((c) => ({ name: c.name, type: c.type })) });
  }
  const notMoved: NotMoved[] = [];
  for (const o of objects.filter((o) => o.schema !== "main" && o.schema !== "_croft")) notMoved.push({ kind: `table in schema ${o.schema}`, name: o.name });
  const views = await sql.all<{ schema: string; name: string }>(
    `SELECT schema_name AS schema, view_name AS name FROM duckdb_views() WHERE database_name = $1 AND NOT internal AND schema_name <> '_croft' ORDER BY 1, 2`, [db]);
  for (const v of views) notMoved.push({ kind: "view", name: v.schema === "main" ? v.name : `${v.schema}.${v.name}` });
  const macros = await sql.all<{ name: string }>(
    `SELECT DISTINCT function_name AS name FROM duckdb_functions() WHERE database_name = $1 AND NOT internal AND function_type IN ('macro', 'table_macro') ORDER BY 1`, [db]);
  for (const m of macros) notMoved.push({ kind: "macro", name: m.name });
  const sequences = await sql.all<{ name: string }>(`SELECT sequence_name AS name FROM duckdb_sequences() WHERE database_name = $1 AND schema_name <> '_croft' ORDER BY 1`, [db]);
  for (const s of sequences) notMoved.push({ kind: "sequence", name: s.name });
  const indexes = await sql.all<{ name: string }>(`SELECT index_name AS name FROM duckdb_indexes() WHERE database_name = $1 AND schema_name <> '_croft' ORDER BY 1`, [db]);
  for (const i of indexes) notMoved.push({ kind: "index", name: i.name });
  const types = await sql.all<{ name: string }>(`SELECT type_name AS name FROM duckdb_types() WHERE database_name = $1 AND NOT internal AND schema_name <> '_croft' ORDER BY 1`, [db]);
  for (const t of types) notMoved.push({ kind: "type", name: t.name });

  const state = new Set(objects.filter((o) => o.schema === "_croft").map((o) => o.name));
  const log = state.has("assets_log");
  const bookkeeping: MoveInventory["bookkeeping"] = [];
  let formatVersion: string | null = null;
  let stamps: unknown[] = [];
  if (state.has("meta")) {
    const [f] = await sql.all<{ v: string }>(`SELECT value AS v FROM ${pre}_croft.meta WHERE key = 'format_version'`);
    formatVersion = f?.v ?? null;
  }
  for (const t of ASSET_TABLES) {
    if (!(log ? state.has(`${t}_log`) : state.has(t))) continue;
    const [n] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM (${latestRows(pre, t, log)})`);
    bookkeeping.push({ table: t, rows: num(n?.n) });
  }
  if (bookkeeping.some((b) => b.table === "assets")) {
    stamps = await sql.all(`SELECT name, epoch_us(last_loaded_at) AS l, epoch_us(last_replaced_at) AS r, row_count AS n, epoch_us(max_loaded_at) AS m FROM (${latestRows(pre, "assets", log)}) ORDER BY name`);
  }
  const generation = createHash("sha256").update(JSON.stringify(
    { tables: tables.map((t) => [t.name, t.rows, t.columns.map((c) => `${c.name} ${c.type}`)]), bookkeeping, stamps },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v))).digest("hex");
  return { tables, bookkeeping, notMoved, formatVersion, generation };
}

/** The columns of the file's tables a lake cannot store, table by table. */
export function refusedColumns(inv: MoveInventory): { table: string; columns: { name: string; type: string; kind: LakeRefusedKind; fix: string }[] }[] {
  return inv.tables.flatMap((t) => {
    const bad = lakeRefusedColumns(t.columns);
    return bad.length ? [{ table: t.name, columns: bad.map((c) => ({ ...c, fix: lakeCastFix(c) })) }] : [];
  });
}

/** LAKE_TYPE_UNSUPPORTED for every table of the file with a column a lake cannot store, with the cast for each; nothing, when there is none. */
export function refuseMoveTypes(inv: MoveInventory, files: ReadonlyMap<string, string>): void {
  const refused = refusedColumns(inv);
  if (!refused.length) return;
  const words = refused.map((r) => `${r.table}: ${r.columns.map((c) => `${c.name} is ${c.type.length > 50 ? `${c.type.slice(0, 47)}...` : c.type}`).join(", ")}`);
  const fixes = refused.map((r) => `${files.get(r.table) ?? `${r.table}'s code`}: ${r.columns.map((c) => c.fix).join("; ")}`);
  throw new CroftError("LAKE_TYPE_UNSUPPORTED", {
    message: `${refused.length === 1 ? "one table of the file has" : `${refused.length} tables of the file have`} columns a lake cannot store (${words.join("; ")}), so the move cannot start`,
    hint: `change what makes ${refused.length === 1 ? "the column" : "each column"} so the table stores a type a lake takes, in the asset's SELECT (${fixes.join(" | ")}) or in the pin that sets its type, run the asset again, then move again; the file was not touched`,
    fix: { kind: "manual", description: `cast the columns above to types a lake stores, run the assets, then run croft move-to-lake again` },
    effect: "nothing was changed: the file and the lake are as they were",
    details: { tables: refused.map((r) => ({ table: r.table, ...(files.get(r.table) ? { file: files.get(r.table) } : {}), columns: r.columns })), kind: refused[0]!.columns[0]!.kind },
  });
}

/** A column whose values a lake would keep inexactly, with how many and one example. */
export interface InexactColumn {
  table: string;
  column: string;
  type: string;
  kind: "HUGEINT" | "UHUGEINT" | "INTERVAL" | "TIMETZ";
  values: number;
  example: string | null;
}

/**
 * DuckLake 1.0 (DuckDB 2.0.0) keeps what fits a Parquet file's own types exactly, and the rest it changes on the way in, silently [V: 2.0.0,
 * option 07 slice 4's probe, 400 rows of each type so that a file is written; a few rows stay in the catalog and read back exactly, which
 * hides it]:
 * - HUGEINT and UHUGEINT are stored as DOUBLE: a value a DOUBLE cannot hold (past 2^53, or 9007199254740993 for one) comes back changed
 *   (9007199254740992), and one near the top of the range cannot be read at all (the whole table fails to read);
 * - an INTERVAL loses the microseconds under a millisecond (1.000003 s comes back as 1 s);
 * - a TIMETZ comes back as the same time at offset 0 (10:11:12+02 as 08:11:12+00), which is not the value that went in.
 * Every other type, DECIMAL(38,0) and TIMESTAMP_NS included, comes back as it went in. So a column of those four types is checked
 * value by value (top level only: one inside a STRUCT, LIST or MAP is left to the proof after the copy, which names it). `alias`: an attached
 * copy of the file, else the connection's own database.
 */
export async function inexactColumns(sql: Sql, inv: MoveInventory, alias: string | null = null): Promise<InexactColumn[]> {
  const found: InexactColumn[] = [];
  const pre = alias ? `${quoteIdent(alias)}.` : "";
  for (const t of inv.tables) {
    for (const c of t.columns) {
      const q = quoteIdent(c.name);
      let kind: InexactColumn["kind"];
      let bad: string;
      switch (c.type) {
        case "HUGEINT": kind = "HUGEINT"; bad = `try_cast(try_cast(${q} AS DOUBLE) AS HUGEINT) IS DISTINCT FROM ${q}`; break;
        case "UHUGEINT": kind = "UHUGEINT"; bad = `try_cast(try_cast(${q} AS DOUBLE) AS UHUGEINT) IS DISTINCT FROM ${q}`; break;
        case "INTERVAL": kind = "INTERVAL"; bad = `datepart('microsecond', ${q}) % 1000 <> 0`; break;
        case "TIME WITH TIME ZONE": kind = "TIMETZ"; bad = `datepart('timezone', ${q}) <> 0`; break;
        default: continue;
      }
      const from = `${pre}main.${quoteIdent(t.name)}`;
      const [n] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${from} WHERE ${q} IS NOT NULL AND (${bad})`);
      if (num(n?.n) === 0) continue;
      const [e] = await sql.all<{ v: string }>(`SELECT ${q}::VARCHAR AS v FROM ${from} WHERE ${q} IS NOT NULL AND (${bad}) LIMIT 1`);
      found.push({ table: t.name, column: c.name, type: c.type, kind, values: num(n?.n), example: e?.v ?? null });
    }
  }
  return found;
}

/** The SELECT expression that stores a column of an inexact type in a type a lake keeps exactly. */
function inexactFix(c: InexactColumn): string {
  switch (c.kind) {
    case "HUGEINT": return `CAST(${c.column} AS DECIMAL(38,0)) AS ${c.column} (exact up to 38 digits), or AS VARCHAR`;
    case "UHUGEINT": return `CAST(${c.column} AS VARCHAR) AS ${c.column}`;
    case "INTERVAL": return `CAST(${c.column} AS VARCHAR) AS ${c.column}, or the length as a whole number of milliseconds`;
    case "TIMETZ": return `CAST(${c.column} AS VARCHAR) AS ${c.column}, or CAST(${c.column} AS TIME) AS ${c.column} when the offset does not matter`;
  }
}

const INEXACT_WHY: Record<InexactColumn["kind"], string> = {
  HUGEINT: "a lake stores a HUGEINT as a DOUBLE, which changes a value past 2^53 (9007199254740993 comes back 9007199254740992) and cannot read one near the top of the range at all",
  UHUGEINT: "a lake stores a UHUGEINT as a DOUBLE, which changes a value past 2^53 and cannot read one near the top of the range at all",
  INTERVAL: "a lake keeps an INTERVAL to the millisecond, so 1.000003 seconds comes back 1 second",
  TIMETZ: "a lake stores a TIMETZ as the same time at offset 0, so 10:11:12+02 comes back 08:11:12+00",
};

/** LAKE_VALUES_INEXACT for every column whose values a lake would change, with the cast for each; nothing, when there is none. */
export function refuseInexact(found: readonly InexactColumn[], files: ReadonlyMap<string, string>): void {
  if (!found.length) return;
  const words = found.map((c) => `${c.table}.${c.column} (${c.type}): ${c.values} value${c.values === 1 ? "" : "s"} such as ${c.example}`);
  const kinds = [...new Set(found.map((c) => c.kind))];
  throw new CroftError("LAKE_VALUES_INEXACT", {
    message: `a lake would store ${found.length === 1 ? "a column" : `${found.length} columns`} of the file inexactly, so the move cannot start: ${words.slice(0, 5).join("; ")}${found.length > 5 ? `; and ${found.length - 5} more` : ""}`,
    hint: `${kinds.map((k) => INEXACT_WHY[k]).join("; ")}; change what makes ${found.length === 1 ? "the column" : "each column"} so the table stores a type a lake keeps exactly, in the asset's SELECT (${found.slice(0, 5).map((c) => `${files.get(c.table) ?? `${c.table}'s code`}: ${inexactFix(c)}`).join(" | ")}) or in the pin that sets its type, run the asset again, then move again; the file was not touched`,
    fix: { kind: "manual", description: "cast the columns above to types a lake keeps exactly, run the assets, then run croft move-to-lake again" },
    effect: "nothing was changed: the file and the lake are as they were",
    details: { columns: found.map((c) => ({ table: c.table, column: c.column, type: c.type, values: c.values, example: c.example, fix: inexactFix(c) })) },
  });
}

// ---- The lake the file moves into --------------------------------------------------------------------------------

/** What the move leaves in the lake, in the same transaction as the copy: it is how a later move knows the lake holds the copy and nothing else. */
export interface MoveMarker {
  v: 1;
  /** The commit tag of the copy's snapshot: while it is the lake's newest snapshot, nobody has written the lake since. */
  tag: string;
  at: string;
  croftVersion: string;
  /** The file's bytes the copy was made from (a backup's clone of it, which is the same bytes). */
  fileSha256: string;
  fileBytes: number;
  tables: { name: string; rows: number }[];
  bookkeeping: { table: string; rows: number }[];
}

export interface LakeInspection {
  /** absent: nobody has written it. empty: no table of a project, no bookkeeping row. marked: holds the copy of a move (see `unchanged`).
   *  used: holds anything else. */
  state: "absent" | "empty" | "marked" | "used";
  /** Tables in the lake outside croft's own schema. */
  tables: string[];
  /** Rows in the bookkeeping logs. */
  bookkeepingRows: number;
  marker: MoveMarker | null;
  /** The commit tag of the lake's newest snapshot. */
  newestTag: string | null;
  /** marked: the copy is still the lake's newest snapshot, so nothing was written since. */
  unchanged: boolean;
}

/** The project as it will be once it is in the lake: the idle `lake` block on, so every lake path of croft opens it. */
export function lakeProjectOf(project: Project): Project {
  const lake = project.config.idleLake;
  if (!lake) throw new CroftError("INTERNAL_ERROR", { message: "lakeProjectOf: the project has no idle lake block", hint: "report this croft bug" });
  return { ...project, config: { ...project.config, lake: { ...lake, enabled: true }, idleLake: null }, databaseLabel: lakeLabel(lake, project.root) };
}

export interface LakeHandles {
  writer: DuckWarehouse;
  reader: DuckWarehouse;
  close(): Promise<void>;
}

/**
 * A writing warehouse and a read-only one on the project's idle lake. Each is registered under a path of its own in the state folder, which
 * is only a name: the file warehouse of the same process (the backup's) keeps its own, so one process holds both.
 */
export function lakeHandles(lp: Project, env: ProjectEnv, o: { isTTY: boolean; onWait?: (h: import("../core/types.ts").LockHolder, ms: number) => void }): LakeHandles {
  const stateDir = lp.paths.stateDir;
  const base = {
    timezone: lp.timezone, root: lp.root, stateDir, profile: "warehouse" as const, isTTY: o.isTTY, register: false, ...lakeOption(lp, env),
    ...(o.onWait ? { onWait: o.onWait } : {}),
  };
  const writer = openWarehouse({ ...base, path: join(stateDir, MOVE_DIR, "lake-writer"), mode: "read_write" });
  const reader = openWarehouse({ ...base, path: join(stateDir, MOVE_DIR, "lake-reader"), mode: "read_only" });
  return { writer, reader, async close() { await writer.close(); await reader.close(); } };
}

async function inspectOn(sql: Sql): Promise<Omit<LakeInspection, "state"> & { state: Exclude<LakeInspection["state"], "absent"> }> {
  const objects = await sql.all<{ schema: string; name: string }>(
    `SELECT schema_name AS schema, table_name AS name FROM duckdb_tables() WHERE database_name = current_database() ORDER BY 1, 2`);
  const tables = objects.filter((o) => o.schema !== "_croft").map((o) => (o.schema === "main" ? o.name : `${o.schema}.${o.name}`));
  const state = new Set(objects.filter((o) => o.schema === "_croft").map((o) => o.name));
  let bookkeepingRows = 0;
  for (const t of ASSET_TABLES) {
    if (!state.has(`${t}_log`)) continue;
    const [n] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM _croft.${t}_log`);
    bookkeepingRows += num(n?.n);
  }
  let marker: MoveMarker | null = null;
  if (state.has("meta")) {
    const [m] = await sql.all<{ v: string }>(`SELECT value AS v FROM _croft.meta WHERE key = $1`, [MOVE_MARKER]);
    if (m) {
      try {
        const parsed = JSON.parse(m.v) as Partial<MoveMarker>;
        if (parsed && parsed.v === 1 && typeof parsed.tag === "string" && typeof parsed.fileSha256 === "string") marker = parsed as MoveMarker;
      } catch { /* not a marker croft wrote */ }
    }
  }
  const [snap] = await sql.all<{ tag: string | null }>(`SELECT commit_message AS tag FROM ducklake_snapshots('lake') ORDER BY snapshot_id DESC LIMIT 1`);
  const newestTag = snap?.tag ?? null;
  const used = tables.length > 0 || bookkeepingRows > 0;
  const result = marker && used ? "marked" : used ? "used" : "empty";
  return { state: result, tables, bookkeepingRows, marker, newestTag, unchanged: result === "marked" && newestTag === marker!.tag };
}

/** What the lake holds, read with the read-only login. A lake nobody has written is `absent`. */
export async function inspectLake(reader: DuckWarehouse): Promise<LakeInspection> {
  try {
    return await reader.read((sql) => inspectOn(sql), { purpose: "inspect the lake for a move" });
  } catch (e) {
    if (e instanceof CroftError && e.code === "DB_NOT_FOUND" && e.problem.details?.notCreated) {
      return { state: "absent", tables: [], bookkeepingRows: 0, marker: null, newestTag: null, unchanged: false };
    }
    throw e;
  }
}

// ---- Fingerprints ------------------------------------------------------------------------------------------------

export interface Fingerprint { sha256: string; bytes: number }

const HASH_SCRIPT = `const fs = require("node:fs"), { createHash } = require("node:crypto");
const out = JSON.parse(process.env.CROFT_HASH_PATHS).map((p) => {
  let fd;
  try { fd = fs.openSync(p, "r"); } catch { return null; }
  const h = createHash("sha256"), buf = Buffer.allocUnsafe(1 << 20);
  let n, total = 0;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { h.update(buf.subarray(0, n)); total += n; }
  fs.closeSync(fd);
  return { sha256: h.digest("hex"), bytes: total };
});
process.stdout.write(JSON.stringify(out));`;

/**
 * The sha256 and size of files, or null for one that does not exist, computed by a child process: DuckDB's lock on a file is a POSIX lock,
 * and closing any descriptor of the process that holds it releases it (§5 "Owning the DuckDB file"), so this process never reads the
 * warehouse file itself.
 */
export function fingerprints(paths: readonly string[]): Promise<(Fingerprint | null)[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", HASH_SCRIPT], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CROFT_HASH_PATHS: JSON.stringify(paths) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`could not fingerprint ${paths.join(", ")}: ${err.trim().split("\n")[0] ?? `exit ${code}`}`));
      try {
        resolve(JSON.parse(out) as (Fingerprint | null)[]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---- The copy ----------------------------------------------------------------------------------------------------

function notEmpty(l: Pick<LakeInspection, "state" | "tables" | "marker" | "unchanged" | "bookkeepingRows">, label: string): CroftError {
  const marked = l.state === "marked";
  return new CroftError("MOVE_LAKE_NOT_EMPTY", {
    message: marked
      ? `${label} already holds a copy that a move made on ${l.marker?.at ?? "an earlier day"}, and it ${l.unchanged ? "no longer matches the file" : "has been written since"}`
      : `${label} already holds ${l.tables.length ? `${l.tables.length} table${l.tables.length === 1 ? "" : "s"} (${l.tables.slice(0, 5).join(", ")}${l.tables.length > 5 ? ", ..." : ""})` : `${l.bookkeepingRows} bookkeeping rows`}; a move only fills a lake that holds nothing`,
    hint: marked
      ? "to use that lake again set \"lake.enabled\": true in croft.json by hand (writes made there since stay there); to move the file again, name a new catalog database and bucket folder in the lake block"
      : "name a new catalog database and bucket folder in the lake block (the folder holds nothing but one lake, croft docs lake); croft never writes into a lake that already holds tables",
    fix: { kind: "manual", requiresHuman: true, description: "ask the user which lake the project moves into: a new, empty catalog database and bucket folder" },
    effect: "nothing was changed",
    details: { state: l.state, tables: l.tables, bookkeepingRows: l.bookkeepingRows, ...(l.marker ? { marker: { at: l.marker.at, tag: l.marker.tag } } : {}) },
  });
}

export interface CopyResult { tables: number; rows: number; bookkeepingRows: number; snapshotTag: string }

/**
 * The copy: one lake transaction, under croft's lock on the lake's writes. `backupFile` is the backup's checkpointed copy of the file, attached
 * read-only (the sandbox allows the state folder, where backups live).
 */
export async function copyIntoLake(writer: DuckWarehouse, backupFile: string, inv: MoveInventory, marker: MoveMarker, o: { runId: string; label: string; signal?: AbortSignal }): Promise<CopyResult> {
  const sourceLog = inv.bookkeeping.length > 0 && (await sourceIsLog(writer, backupFile));
  return writer.write("move into the lake", (sql) => withTrashFile(sql, backupFile, async (alias) => {
    await sql.exec("BEGIN TRANSACTION");
    try {
      const there = await inspectOn(sql);
      if (there.state !== "empty") throw notEmpty(there, o.label);
      await ensureState(sql, { bookkeeping: "log" });
      let rows = 0;
      for (const t of inv.tables) {
        await sql.exec(`CREATE TABLE main.${quoteIdent(t.name)} AS SELECT * FROM ${quoteIdent(alias)}.main.${quoteIdent(t.name)}`);
        rows += t.rows;
      }
      const bk = await bookkeepingOf(sql);
      let bookkeepingRows = 0;
      for (const b of inv.bookkeeping) {
        if (b.table === "meta") continue;
        await bk.insertSelect(b.table, latestRows(`${quoteIdent(alias)}.`, b.table as Exclude<StateTableName, "meta">, sourceLog));
        bookkeepingRows += b.rows;
      }
      await bk.upsert("meta", { key: "$1", value: "$2" }, [MOVE_MARKER, JSON.stringify(marker)]);
      await sql.exec("COMMIT");
      return { tables: inv.tables.length, rows, bookkeepingRows, snapshotTag: marker.tag };
    } catch (e) {
      try { await sql.exec("ROLLBACK"); } catch { /* none open */ }
      throw e;
    }
  }), { runId: o.runId, transaction: false, commitTag: marker.tag, ...(o.signal ? { signal: o.signal } : {}) });
}

/** Whether the backup's file keeps its bookkeeping as a log (a file made under the test suite's log switch). */
async function sourceIsLog(w: DuckWarehouse, file: string): Promise<boolean> {
  return w.read((sql) => withTrashFile(sql, file, async (alias) => {
    const [r] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = $1 AND schema_name = '_croft' AND table_name = 'assets_log'`, [alias]);
    return num(r?.n) > 0;
  }), { purpose: "the backup's bookkeeping" });
}

// ---- The proof ---------------------------------------------------------------------------------------------------

export interface Verified {
  tables: number;
  rows: number;
  bookkeepingRows: number;
  /** Everything that differed: empty when the lake equals the file. */
  differences: string[];
  /** The columns whose values the lake stored differently. */
  columns: { table: string; column: string; type: string }[];
}

/**
 * The lake against the backup's copy of the file, as the read-only login sees it: every table's columns and types, its row count and its
 * rows (EXCEPT ALL, the file's rows against the lake's, which with equal counts is multiset equality); every `_croft` table's latest rows
 * against the lake's view of it. `differences` says what was not equal.
 */
export async function verifyLake(reader: DuckWarehouse, backupFile: string, inv: MoveInventory): Promise<Verified> {
  return reader.read((sql) => withTrashFile(sql, backupFile, async (alias) => {
    const pre = `${quoteIdent(alias)}.`;
    const differences: string[] = [];
    const columns: Verified["columns"] = [];
    const mine = await inventoryOf(sql, null);
    let rows = 0;
    let bookkeepingRows = 0;
    const lakeTables = new Map(mine.tables.map((t) => [t.name, t]));
    for (const t of inv.tables) {
      const lake = lakeTables.get(t.name);
      if (!lake) {
        differences.push(`${t.name}: missing from the lake`);
        continue;
      }
      const same = lake.columns.length === t.columns.length && lake.columns.every((c, i) => c.name === t.columns[i]!.name && c.type === t.columns[i]!.type);
      if (!same) {
        differences.push(`${t.name}: columns differ (file: ${t.columns.map((c) => `${c.name} ${c.type}`).join(", ")}; lake: ${lake.columns.map((c) => `${c.name} ${c.type}`).join(", ")})`);
        continue;
      }
      if (lake.rows !== t.rows) {
        differences.push(`${t.name}: ${t.rows} rows in the file, ${lake.rows} in the lake`);
        continue;
      }
      const [d] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM (SELECT * FROM ${pre}main.${quoteIdent(t.name)} EXCEPT ALL SELECT * FROM main.${quoteIdent(t.name)})`);
      if (num(d?.n) > 0) {
        // Which columns: each one's values against the lake's (the multiset of that column alone, which is enough to name it).
        const named: string[] = [];
        for (const c of t.columns) {
          const q = quoteIdent(c.name);
          const [x] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM (SELECT ${q} FROM ${pre}main.${quoteIdent(t.name)} EXCEPT ALL SELECT ${q} FROM main.${quoteIdent(t.name)})`);
          if (num(x?.n) > 0) {
            named.push(`${c.name} (${c.type}) holds ${num(x?.n)} value${num(x?.n) === 1 ? "" : "s"} the lake stored differently`);
            columns.push({ table: t.name, column: c.name, type: c.type });
          }
        }
        differences.push(`${t.name}: ${num(d?.n)} rows of the file are not in the lake as they were${named.length ? `: ${named.join("; ")}` : ""}`);
      } else rows += t.rows;
    }
    for (const name of lakeTables.keys()) if (!inv.tables.some((t) => t.name === name)) differences.push(`${name}: in the lake and not in the file`);

    const [log] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = $1 AND schema_name = '_croft' AND table_name = 'assets_log'`, [alias]);
    const sourceLog = num(log?.n) > 0;
    for (const b of inv.bookkeeping) {
      if (b.table === "meta") continue;
      const t = b.table as Exclude<StateTableName, "meta">;
      // The columns the file has (an older file lacks some): those are compared, the lake's others are NULL by construction.
      const have = new Set((await sql.all<{ c: string }>(
        `SELECT column_name AS c FROM duckdb_columns() WHERE database_name = $1 AND schema_name = '_croft' AND table_name = $2`, [alias, sourceLog ? `${t}_log` : t])).map((r) => r.c));
      const list = stateColumns(t).filter((c) => have.has(c)).map(quoteIdent).join(", ");
      const [here] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM _croft.${t}`);
      if (num(here?.n) !== b.rows) {
        differences.push(`_croft.${t}: ${b.rows} rows in the file, ${num(here?.n)} in the lake`);
        continue;
      }
      const [d] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM (SELECT ${list} FROM (${latestRows(pre, t, sourceLog)}) EXCEPT ALL SELECT ${list} FROM _croft.${t})`);
      if (num(d?.n) > 0) differences.push(`_croft.${t}: ${num(d?.n)} rows of the file are not in the lake as they were`);
      else bookkeepingRows += b.rows;
    }
    return { tables: inv.tables.length, rows, bookkeepingRows, differences, columns };
  }), { purpose: "prove the lake equals the file" });
}

/**
 * Undo the copy: the tables it made dropped, the bookkeeping rows and the marker removed, in one transaction. Only while the marker is
 * the copy's own and its commit is the lake's newest snapshot (nobody wrote the lake since); otherwise it changes nothing and says so.
 * The lake held nothing before the copy (the copy refuses a lake that held anything), so this puts it back to that.
 */
export async function undoCopy(writer: DuckWarehouse, marker: MoveMarker, o: { runId: string }): Promise<boolean> {
  return writer.write("undo the move", async (sql) => {
    await sql.exec("BEGIN TRANSACTION");
    try {
      const there = await inspectOn(sql);
      if (there.marker?.tag !== marker.tag || !there.unchanged) {
        await sql.exec("ROLLBACK");
        return false;
      }
      for (const t of marker.tables) await sql.exec(`DROP TABLE IF EXISTS main.${quoteIdent(t.name)}`);
      for (const t of ASSET_TABLES) await sql.exec(`DELETE FROM _croft.${t}_log`);
      await sql.exec(`DELETE FROM _croft.meta WHERE key = ${quoteLiteral(MOVE_MARKER)}`);
      await sql.exec("COMMIT");
      return true;
    } catch (e) {
      try { await sql.exec("ROLLBACK"); } catch { /* none open */ }
      throw e;
    }
  }, { runId: o.runId, transaction: false });
}

export const newMoveTag = (): string => `croft:${process.pid}:move:${randomUUID()}`;

// ---- The switch --------------------------------------------------------------------------------------------------

/**
 * croft.json with `lake.enabled` set to true, written whole by a rename: one token replaced in the user's own text (their formatting, key
 * order and comments-in-keys are kept), the result read back through the validator before it is written. Returns the project's config
 * file path. Throws MOVE_BLOCKED when the file cannot be edited this way.
 */
export function switchLakeOn(project: Project): string {
  const path = project.paths.config;
  const blocked = (why: string) => new CroftError("MOVE_BLOCKED", {
    message: `croft could not switch croft.json to the lake: ${why}`,
    hint: "the lake holds a verified copy but the project still uses the file; set \"lake.enabled\": true in croft.json by hand (or run croft move-to-lake again, which finishes the move)",
    effect: "the copy is in the lake and the project still keeps its warehouse in the file",
    fix: { kind: "manual", description: "set \"enabled\": true in the lake block of croft.json" },
    details: { reasons: [why] },
  });
  const text = readFileSync(path, "utf8");
  const scan = scanJson(text);
  if (!scan.ok) throw blocked(`croft.json is not valid JSON (${scan.message})`);
  const at = scan.paths.get("lake.enabled");
  const m = at ? /^"enabled"\s*:\s*false(?![\w.])/.exec(text.slice(at.offset)) : null;
  if (!at || !m) throw blocked('croft.json has no "enabled": false in its lake block');
  const edited = text.slice(0, at.offset) + m[0].replace(/false$/, "true") + text.slice(at.offset + m[0].length);
  const check = parseConfig(edited, { root: project.root });
  if (!check.ok || check.config.lake === null) throw blocked(`the edited croft.json does not read as a project in a lake${check.ok ? "" : ` (${check.issues[0]?.message})`}`);
  const tmp = join(project.root, `.${CONFIG_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, edited, { mode: statSync(path).mode & 0o777 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw blocked(String((e as Error)?.message ?? e));
  }
  return path;
}

/** Whether croft.json can be rewritten here (checked before the move starts, so a read-only file does not fail it at the end). */
export function configWritable(project: Project): boolean {
  try {
    accessSync(project.paths.config, constants.W_OK);
    accessSync(project.root, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

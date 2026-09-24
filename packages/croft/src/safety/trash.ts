// The trash (DESIGN.md §6 "Trash, restore and delete"). Every destructive change (run --allow-shrink or
// --rebuild, delete, restore, a lossy pin, a key conversion) moves what it would lose here first, then commits.
//
// - A trashed version is a standalone DuckDB file, <state>/trash/<asset>/<time>.duckdb, holding the table as
//   main.<asset> and its _croft rows (assets, columns, files, inputs, writes) under _croft, plus
//   _croft.trash (why, when, which run). It is written through ATTACH from the warehouse's own connection,
//   which keeps HUGEINT, JSON, TIMESTAMPTZ and DECIMAL exact [V, safety/trash.test.ts]; the warehouse file
//   itself is never opened a second way.
// - Two commits: one transaction cannot write to two database files, so the trash commits first and the
//   destructive change second. A crash in between only leaves an extra trash file.
// - A small <time>.json next to each file lets listTrash() work without opening DuckDB.
// - A version holds the whole table (kind "table": --allow-shrink, --rebuild, delete, restore) or the rows a
//   predicate matched (kind "rows": delete --where), recorded in the sidecar and in the file's _croft.trash.
// - Retention (§6, "30 days or 5 versions per asset"): a version is kept for 30 days, and each asset's 5 newest
//   versions are kept however old; so a version goes only when it is older than 30 days and 5 newer versions of
//   its asset exist. trashTable prunes the asset it trashed, once the new version is safe; croft doctor prunes
//   every asset. Neither prunes the version just written, nor what the caller names in `keep` (the version a
//   restore is about to read).
// Restore and delete are safety/restore.ts and safety/delete.ts. Listing and pruning load no DuckDB binding.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { now as clockNow } from "../core/time.ts";
import { CROFT_VERSION } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { currentDatabase, quoteIdent, quoteLiteral, readTableSchema } from "../load/evolve.ts";

export const TRASH_DIR = "trash";
const STATE_TABLES = ["assets", "columns", "files", "inputs", "writes"] as const;

/** How long the trash keeps versions (§6): 30 days, and each asset's 5 newest whatever their age. */
export const TRASH_RETENTION = { days: 30, versions: 5 } as const;

/** What a version holds: the whole table, or the rows a predicate matched (delete --where). */
export type TrashKind = "table" | "rows";

export interface TrashEntry {
  asset: string;
  /** The trash file. */
  path: string;
  /** ISO-8601 UTC. */
  trashedAt: string;
  reason: string;
  runId: string | null;
  rows: number;
  bytes: number;
  croftVersion: string;
  /** "table" for a whole table; "rows" for the rows of a delete --where. A sidecar from before kinds reads as
   *  "table" (restore reads the file's own _croft.trash, which is authoritative). */
  kind: TrashKind;
  /** The predicate of a "rows" version; null for a whole table. */
  where: string | null;
}

export function trashDir(stateDir: string, asset?: string): string {
  return asset ? join(stateDir, TRASH_DIR, asset) : join(stateDir, TRASH_DIR);
}

/** A file name that sorts by time and is safe on every file system: 20260922T184000.123Z. */
export function trashStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "");
}

let attachSeq = 0;

export interface TrashOptions {
  runId?: string;
  now?: Date;
  signal?: AbortSignal;
  /** Keep only the rows this predicate matches (a "rows" version). The caller has vetted it as one expression over
   *  the table (safety/delete.ts countWhere); it goes into the statement as written. */
  where?: string;
  /** Versions the retention pass after the trash must not prune (the one a restore is about to read). */
  keep?: readonly string[];
}

/**
 * Copy an asset's table (or, with `where`, the rows it matches) and its _croft rows into a new trash file and
 * commit it. Returns null when the table does not exist (nothing to keep). Runs as its own write lease, before
 * the destructive change. Then it prunes the asset's expired versions, never the new one; a prune that fails is
 * left for the next trash or croft doctor, since the new version is already safe.
 */
export async function trashTable(warehouse: DuckWarehouse, asset: string, reason: string,
  o: TrashOptions = {}): Promise<TrashEntry | null> {
  // db/connect.ts loads the DuckDB binding: imported here, so listing and pruning (croft doctor) never need it.
  const { canonicalPath } = await import("../db/connect.ts");
  const stateDir = canonicalPath(warehouse.options.stateDir);
  const dir = trashDir(stateDir, asset);
  mkdirSync(dir, { recursive: true });
  const at = o.now ?? clockNow();
  let stamp = trashStamp(at);
  for (let n = 2; existsSync(join(dir, `${stamp}.duckdb`)); n++) stamp = `${trashStamp(at)}-${n}`;
  const path = join(dir, `${stamp}.duckdb`);
  const alias = `croft_trash_${process.pid}_${++attachSeq}`;
  const kind: TrashKind = o.where !== undefined ? "rows" : "table";
  const where = o.where ?? null;
  const entry = await warehouse.write(`trash ${asset}`, async (sql) => {
    const db = await currentDatabase(sql);
    const columns = await readTableSchema(sql, asset, db);
    if (!columns) return null;
    await sql.exec(`ATTACH ${quoteLiteral(path)} AS ${quoteIdent(alias)}`);
    try {
      await sql.exec("BEGIN TRANSACTION");
      try {
        const t = quoteIdent(alias);
        // The predicate on lines of its own, so a trailing `--` comment in it ends there.
        const filter = where === null ? "" : ` WHERE (\n${where}\n)`;
        await sql.exec(`CREATE TABLE ${t}.main.${quoteIdent(asset)} AS SELECT * FROM ${quoteIdent(db)}.main.${quoteIdent(asset)}${filter}`);
        await sql.exec(`CREATE SCHEMA ${t}._croft`);
        const have = new Set((await sql.all<{ t: string }>(
          `SELECT table_name AS t FROM duckdb_tables() WHERE database_name = $1 AND schema_name = '_croft'`, [db])).map((r) => r.t));
        for (const table of STATE_TABLES) {
          if (!have.has(table)) continue;
          const col = table === "assets" ? "name" : "asset";
          await sql.exec(`CREATE TABLE ${t}._croft.${table} AS SELECT * FROM ${quoteIdent(db)}._croft.${table} WHERE ${col} = $1`, [asset]);
        }
        await sql.exec(`CREATE TABLE ${t}._croft.trash AS SELECT $1::VARCHAR AS asset, $2::VARCHAR AS reason, $3::VARCHAR AS run_id,
          $4::TIMESTAMPTZ AS trashed_at, $5::VARCHAR AS croft_version, $6::VARCHAR AS kind, $7::VARCHAR AS where_sql`,
        [asset, reason, o.runId ?? null, at.toISOString(), CROFT_VERSION, kind, where]);
        const [row] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${t}.main.${quoteIdent(asset)}`);
        await sql.exec("COMMIT");
        return { rows: Number(row?.n ?? 0) };
      } catch (e) {
        try {
          await sql.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    } finally {
      await sql.exec(`DETACH ${quoteIdent(alias)}`).catch(() => {});
    }
  }, { runId: o.runId ?? "trash", asset, transaction: false, ...(o.signal ? { signal: o.signal } : {}) });
  if (!entry) return null;
  const out: TrashEntry = {
    asset, path, trashedAt: at.toISOString(), reason, runId: o.runId ?? null, rows: entry.rows,
    bytes: fileSize(path), croftVersion: CROFT_VERSION, kind, where,
  };
  const meta = join(dir, `${stamp}.json`);
  writeFileSync(`${meta}.tmp`, JSON.stringify(out, null, 1));
  renameSync(`${meta}.tmp`, meta);
  try {
    pruneTrash(stateDir, { asset, now: at, keep: [path, ...(o.keep ?? [])] });
  } catch {
    // Housekeeping only: croft doctor or the next trash of this asset tries again.
  }
  return out;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Trashed versions, newest first; one asset's or every asset's. */
export function listTrash(stateDir: string, asset?: string): TrashEntry[] {
  const root = trashDir(stateDir);
  if (!existsSync(root)) return [];
  const assets = asset ? [asset] : readdirSync(root).filter((d) => {
    try {
      return statSync(join(root, d)).isDirectory();
    } catch {
      return false;
    }
  });
  const out: TrashEntry[] = [];
  for (const a of assets) {
    const dir = join(root, a);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".duckdb")) continue;
      const path = join(dir, f);
      const stamp = f.slice(0, -".duckdb".length);
      let meta: Partial<TrashEntry> = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, `${stamp}.json`), "utf8")) as Partial<TrashEntry>;
      } catch {
        // A crash between the trash commit and its sidecar: the file is still a valid trashed version.
      }
      out.push({
        asset: a, path, trashedAt: meta.trashedAt ?? stampTime(stamp) ?? new Date(statSync(path).mtimeMs).toISOString(),
        reason: meta.reason ?? "unknown", runId: meta.runId ?? null, rows: meta.rows ?? 0, bytes: fileSize(path),
        croftVersion: meta.croftVersion ?? "unknown", kind: meta.kind === "rows" ? "rows" : "table",
        where: meta.kind === "rows" && typeof meta.where === "string" ? meta.where : null,
      });
    }
  }
  return out.sort((x, y) => (x.trashedAt < y.trashedAt ? 1 : x.trashedAt > y.trashedAt ? -1 : 0));
}

function stampTime(stamp: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z/.exec(stamp);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}Z`;
}

/** Add fields to a version's sidecar (croft delete keeps the asset's catalog entry there, for a later restore). */
export function annotateVersion(path: string, extra: Record<string, unknown>): void {
  const meta = path.replace(/\.duckdb$/, ".json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
  } catch {
    return; // no sidecar: listTrash reads the file's name
  }
  writeFileSync(`${meta}.tmp`, JSON.stringify({ ...current, ...extra }, null, 1));
  renameSync(`${meta}.tmp`, meta);
}

/** A field croft kept in a version's sidecar (annotateVersion), or undefined. */
export function versionNote(path: string, key: string): unknown {
  try {
    return (JSON.parse(readFileSync(path.replace(/\.duckdb$/, ".json"), "utf8")) as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Delete expired versions (TRASH_RETENTION): those older than 30 days of which the asset has 5 newer versions.
 * One asset's, or every asset's; never a path in `keep`. Returns what was deleted. A version is its .duckdb file,
 * its sidecar and any WAL DuckDB left next to it; an asset folder left empty goes too.
 */
export function pruneTrash(stateDir: string, o: { asset?: string; now?: Date; keep?: readonly string[] } = {}): TrashEntry[] {
  const cutoff = (o.now ?? clockNow()).getTime() - TRASH_RETENTION.days * 86_400_000;
  const keep = new Set(o.keep ?? []);
  const byAsset = new Map<string, TrashEntry[]>();
  for (const e of listTrash(stateDir, o.asset)) byAsset.set(e.asset, [...(byAsset.get(e.asset) ?? []), e]);
  const pruned: TrashEntry[] = [];
  for (const [asset, versions] of byAsset) {
    // listTrash lists newest first: the first TRASH_RETENTION.versions stay whatever their age.
    versions.forEach((e, i) => {
      if (i < TRASH_RETENTION.versions || keep.has(e.path) || !(Date.parse(e.trashedAt) < cutoff)) return;
      for (const f of [e.path, `${e.path}.wal`, e.path.replace(/\.duckdb$/, ".json")]) rmSync(f, { force: true });
      pruned.push(e);
    });
    if (pruned.some((e) => e.asset === asset)) {
      try {
        const dir = trashDir(stateDir, asset);
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {
        // Gone already.
      }
    }
  }
  return pruned;
}

/** Where the next trash file of an asset would go (for a confirmation's impact; the stamp is a guess). */
export function plannedTrashPath(stateDir: string, asset: string, at: Date = clockNow()): string {
  return join(trashDir(stateDir, asset), `${trashStamp(at)}.duckdb`);
}

/** INTERNAL_ERROR when the trash could not be written: the destructive change must not go ahead. */
export function trashFailed(asset: string, e: unknown): CroftError {
  return new CroftError("INTERNAL_ERROR", {
    asset,
    message: `could not move ${asset} to the trash: ${(e as Error)?.message ?? String(e)}`,
    hint: "nothing was changed; check free disk space and that .croft/ is writable, then run again",
    effect: "nothing was changed",
  });
}

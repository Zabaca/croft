// The trash, minimal (DESIGN.md §6 "Trash, restore and delete"). Phase 1 needs it for `run --allow-shrink`:
// the current table goes to the trash first, then the destructive write commits.
//
// - A trashed version is a standalone DuckDB file, <state>/trash/<asset>/<time>.duckdb, holding the table as
//   main.<asset> and its _croft rows (assets, columns, files, inputs, writes) under _croft, plus
//   _croft.trash (why, when, which run). It is written through ATTACH from the warehouse's own connection,
//   which keeps HUGEINT, JSON, TIMESTAMPTZ and DECIMAL exact [V, safety/trash.test.ts]; the warehouse file
//   itself is never opened a second way.
// - Two commits: one transaction cannot write to two database files, so the trash commits first and the
//   destructive change second. A crash in between only leaves an extra trash file.
// - A small <time>.json next to each file lets listTrash() work without opening DuckDB.
// Restore, delete and retention (30 days or 5 versions) come with phase 4.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { now as clockNow } from "../core/time.ts";
import { canonicalPath } from "../db/connect.ts";
import { CROFT_VERSION } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { currentDatabase, quoteIdent, quoteLiteral, readTableSchema } from "../load/evolve.ts";

export const TRASH_DIR = "trash";
const STATE_TABLES = ["assets", "columns", "files", "inputs", "writes"] as const;

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
}

export function trashDir(stateDir: string, asset?: string): string {
  return asset ? join(stateDir, TRASH_DIR, asset) : join(stateDir, TRASH_DIR);
}

/** A file name that sorts by time and is safe on every file system: 20260922T184000.123Z. */
export function trashStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "");
}

let attachSeq = 0;

/**
 * Copy an asset's table and its _croft rows into a new trash file and commit it. Returns null when the table
 * does not exist (nothing to keep). Runs as its own write lease, before the destructive change.
 */
export async function trashTable(warehouse: DuckWarehouse, asset: string, reason: string,
  o: { runId?: string; now?: Date; signal?: AbortSignal } = {}): Promise<TrashEntry | null> {
  const stateDir = canonicalPath(warehouse.options.stateDir);
  const dir = trashDir(stateDir, asset);
  mkdirSync(dir, { recursive: true });
  const at = o.now ?? clockNow();
  let stamp = trashStamp(at);
  for (let n = 2; existsSync(join(dir, `${stamp}.duckdb`)); n++) stamp = `${trashStamp(at)}-${n}`;
  const path = join(dir, `${stamp}.duckdb`);
  const alias = `croft_trash_${process.pid}_${++attachSeq}`;
  const entry = await warehouse.write(`trash ${asset}`, async (sql) => {
    const db = await currentDatabase(sql);
    const columns = await readTableSchema(sql, asset, db);
    if (!columns) return null;
    await sql.exec(`ATTACH ${quoteLiteral(path)} AS ${quoteIdent(alias)}`);
    try {
      await sql.exec("BEGIN TRANSACTION");
      try {
        const t = quoteIdent(alias);
        await sql.exec(`CREATE TABLE ${t}.main.${quoteIdent(asset)} AS SELECT * FROM ${quoteIdent(db)}.main.${quoteIdent(asset)}`);
        await sql.exec(`CREATE SCHEMA ${t}._croft`);
        const have = new Set((await sql.all<{ t: string }>(
          `SELECT table_name AS t FROM duckdb_tables() WHERE database_name = $1 AND schema_name = '_croft'`, [db])).map((r) => r.t));
        for (const table of STATE_TABLES) {
          if (!have.has(table)) continue;
          const col = table === "assets" ? "name" : "asset";
          await sql.exec(`CREATE TABLE ${t}._croft.${table} AS SELECT * FROM ${quoteIdent(db)}._croft.${table} WHERE ${col} = $1`, [asset]);
        }
        await sql.exec(`CREATE TABLE ${t}._croft.trash AS SELECT $1::VARCHAR AS asset, $2::VARCHAR AS reason, $3::VARCHAR AS run_id,
          $4::TIMESTAMPTZ AS trashed_at, $5::VARCHAR AS croft_version`, [asset, reason, o.runId ?? null, at.toISOString(), CROFT_VERSION]);
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
    bytes: fileSize(path), croftVersion: CROFT_VERSION,
  };
  const meta = join(dir, `${stamp}.json`);
  writeFileSync(`${meta}.tmp`, JSON.stringify(out, null, 1));
  renameSync(`${meta}.tmp`, meta);
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
        croftVersion: meta.croftVersion ?? "unknown",
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

// Restore (DESIGN.md §6 "Trash, restore and delete"): bring a trashed version of an asset back. Needs
// confirmation; the command (cli/commands/restore.ts) asks, takes the asset's lease and records the run.
//
// - The current table goes to the trash first (its own commit), so a restore is itself undoable. Then one
//   transaction reads the trash file, ATTACHed read-only (never the live warehouse a second way), and writes the
//   warehouse [V].
// - A whole-table version replaces the table (CREATE OR REPLACE … AS SELECT, which keeps every type) and the
//   asset's _croft rows (assets, columns, files, inputs, writes): the cursor, positions and history are the
//   version's again. What other assets have seen of it stays theirs.
// - A "rows" version (the rows a delete --where removed) is put back into the table as it is now, by column name;
//   with a key, rows whose key is in the table again (a refetch) are skipped and counted. The table must exist.
// - A "rows" version whose delete was never recorded as done (trash.ts `applied: false`: the delete stopped between
//   its two commits, or was refused) holds rows that were most likely never deleted. When the table still has every
//   one of them it is refused ("the delete did not finish"); otherwise only the rows the table does not have go
//   back (EXCEPT ALL, so a keyless table gets no second copy). A finished delete's rows go back as they are.
// - Putting rows back into a table that something other than croft changed reports OUT_OF_BAND_CHANGE first, rather
//   than folding the change into the numbers recorded.
// - Either way last_replaced_at is bumped past every version croft or a reader recorded (delete.ts
//   replacedStamp), so downstream SQL rebuilds (input_replaced) and incremental TS transforms say the input was
//   restored; row_count and max_loaded_at are set to the table's real numbers, so the out-of-band check stays
//   quiet. The kind is read from the file's own _croft.trash; a file from before kinds holds a whole table.
import { existsSync } from "node:fs";
import { CroftError } from "../core/errors.ts";
import { now as clockNow } from "../core/time.ts";
import type { Problem, Sql } from "../core/types.ts";
import { ensureState, hasState } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { quoteIdent, readTableSchema } from "../load/evolve.ts";
import { downstreamOf, replacedStamp, tableGeneration } from "./delete.ts";
import { isoMicros, tableStats } from "./guards.ts";
import { checkOutOfBand } from "./out-of-band.ts";
import { listTrash, trashFailed, trashTable, type TrashEntry, type TrashKind, withTrashFile } from "./trash.ts";

const STATE_TABLES = ["assets", "columns", "files", "inputs", "writes"] as const;

/** The trash, newest first, for one asset or all. */
export function listVersions(stateDir: string, asset?: string): TrashEntry[] {
  return listTrash(stateDir, asset);
}

/** What restoring a version would do (the confirmation's impact). */
export interface RestoreImpact {
  asset: string;
  version: TrashEntry;
  /** From the trash file itself. */
  kind: TrashKind;
  /** The rows that come back: the version's whole table, or the trashed rows whose key is not in the table now. */
  rows: number;
  /** A "rows" version: trashed rows left out because the table has them again (their key; or, for a delete that did
   *  not finish, the same row). */
  skipped: number;
  /** The table's rows now, which go to the trash first; null when there is no table. */
  currentRows: number | null;
  /** Every asset that has read it (from _croft.inputs); they go stale. */
  downstream: string[];
  /** The current table's generation (delete.ts tableGeneration), hashed into the confirmation. */
  generation: string | null;
}

export interface RestoreResult {
  asset: string;
  /** The version brought back. */
  restored: TrashEntry;
  /** Where the table it replaced went (null when there was none). */
  trashed: TrashEntry | null;
  /** The rows that came back. */
  rows: number;
  kind: TrashKind;
  skipped: number;
  /** The table's rows afterwards. */
  rowsAfter: number;
  downstream: string[];
  /** Warnings: OUT_OF_BAND_CHANGE when something other than croft changed the table the rows went back into. */
  problems: Problem[];
}

/** `fault` is CROFT_FAULT: between_trash_and_drop kills the process after the current table went to the trash. */
export interface RestoreOptions { runId?: string; now?: Date; signal?: AbortSignal; fault?: string }

function versionGone(v: TrashEntry): CroftError {
  return new CroftError("USAGE_ERROR", {
    asset: v.asset,
    message: `the trashed version of ${v.asset} from ${v.trashedAt} is no longer in the trash (${v.path})`,
    hint: "croft restore lists the versions the trash holds now",
    effect: "nothing was changed",
    fix: { kind: "command", description: "list the trash", command: "croft restore" },
    details: { path: v.path },
  });
}

/** Run `fn` with the version's file ATTACHed read-only under a fresh alias, and DETACH it after. */
async function withVersion<T>(sql: Sql, v: TrashEntry, fn: (alias: string) => Promise<T>): Promise<T> {
  if (!existsSync(v.path)) throw versionGone(v);
  let attached = false;
  try {
    return await withTrashFile(sql, v.path, (alias) => {
      attached = true;
      return fn(alias);
    });
  } catch (e) {
    if (attached) throw e;
    throw new CroftError("USAGE_ERROR", {
      asset: v.asset,
      message: `the trashed version of ${v.asset} from ${v.trashedAt} cannot be read: ${String((e as Error)?.message ?? e).split("\n")[0]}`,
      hint: "pick another version: croft restore lists them",
      effect: "nothing was changed",
      fix: { kind: "command", description: "list the trash", command: "croft restore" },
      details: { path: v.path },
    });
  }
}

async function hasTable(sql: Sql, database: string, schema: string, table: string): Promise<boolean> {
  const [r] = await sql.all<{ n: number | bigint }>(
    `SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3`, [database, schema, table]);
  return Number(r?.n ?? 0) > 0;
}

async function kindOf(sql: Sql, alias: string): Promise<TrashKind> {
  const [c] = await sql.all<{ n: number | bigint }>(
    `SELECT count(*) AS n FROM duckdb_columns() WHERE database_name = $1 AND schema_name = '_croft' AND table_name = 'trash' AND column_name = 'kind'`, [alias]);
  if (Number(c?.n ?? 0) === 0) return "table";
  const [k] = await sql.all<{ kind: string | null }>(`SELECT kind FROM ${quoteIdent(alias)}._croft.trash LIMIT 1`);
  return k?.kind === "rows" ? "rows" : "table";
}

const count = async (sql: Sql, ref: string, where = ""): Promise<number> =>
  Number((await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${ref}${where}`))[0]?.n ?? 0);

/**
 * A "rows" version's plan: the SELECT of the trashed rows that go back. With a key the table has now (every key
 * column in both), trashed rows whose key is back are left out (NOT EXISTS). Without one, a version whose delete did
 * not finish (`unapplied`) leaves out the rows the table has already (EXCEPT ALL, by the trashed columns); a finished
 * delete's rows all go back. Refuses trashed columns the table no longer has.
 */
async function rowsPlan(sql: Sql, v: TrashEntry, alias: string, unapplied: boolean): Promise<{ select: string; columns: string[] }> {
  const asset = v.asset;
  const current = (await readTableSchema(sql, asset))!;
  const trashed = (await readTableSchema(sql, asset, alias)) ?? [];
  const have = new Set(current.map((c) => c.name.toLowerCase()));
  const lost = trashed.filter((c) => !have.has(c.name.toLowerCase())).map((c) => c.name);
  if (lost.length) {
    throw new CroftError("USAGE_ERROR", {
      asset,
      message: `the trashed rows of ${asset} have columns the table no longer has (${lost.join(", ")}), so they cannot go back into it`,
      hint: `restore a whole-table version of ${asset} instead (croft restore lists them)`,
      effect: "nothing was changed",
      fix: { kind: "command", description: "list the trash", command: "croft restore" },
      details: { columns: lost, path: v.path },
    });
  }
  let key: string[] = [];
  if (await hasState(sql)) {
    const [a] = await sql.all<{ k: unknown }>(`SELECT key_columns AS k FROM _croft.assets WHERE name = $1`, [asset]);
    key = Array.isArray(a?.k) ? a.k.map(String) : [];
  }
  const inTrash = new Set(trashed.map((c) => c.name.toLowerCase()));
  const src = `${quoteIdent(alias)}.main.${quoteIdent(asset)}`;
  const columns = trashed.map((c) => quoteIdent(c.name));
  if (!key.length || !key.every((k) => have.has(k.toLowerCase()) && inTrash.has(k.toLowerCase()))) {
    if (!unapplied) return { select: `SELECT s.* FROM ${src} s`, columns };
    const list = columns.join(", ");
    return { select: `SELECT * FROM (SELECT ${list} FROM ${src} EXCEPT ALL SELECT ${list} FROM main.${quoteIdent(asset)})`, columns };
  }
  const same = key.map((k) => `t.${quoteIdent(k)} IS NOT DISTINCT FROM s.${quoteIdent(k)}`).join(" AND ");
  return { select: `SELECT s.* FROM ${src} s WHERE NOT EXISTS (SELECT 1 FROM main.${quoteIdent(asset)} t WHERE ${same})`, columns };
}

/** The trashed rows do not go into the table as it is now (a column retyped since, say). */
function doesNotFit(v: TrashEntry, e: unknown, effect = "nothing was changed"): CroftError {
  return new CroftError("USAGE_ERROR", {
    asset: v.asset,
    message: `the trashed rows of ${v.asset} do not fit the table as it is now: ${String((e as Error)?.message ?? e).split("\n")[0]}`,
    hint: `restore a whole-table version of ${v.asset} instead (croft restore lists them)`,
    effect,
    fix: { kind: "command", description: "list the trash", command: "croft restore" },
    details: { path: v.path },
  });
}

/**
 * A "rows" version whose delete was never recorded as done (trash.ts `applied: false`): its rows were most likely
 * never deleted. USAGE_ERROR when the table still has every one of them (INTERSECT ALL by the trashed columns).
 */
async function refuseUndeleted(sql: Sql, v: TrashEntry, alias: string, columns: readonly string[], all: number): Promise<void> {
  const list = columns.join(", ");
  let present: number;
  try {
    present = await count(sql, `(SELECT ${list} FROM ${quoteIdent(alias)}.main.${quoteIdent(v.asset)} INTERSECT ALL SELECT ${list} FROM main.${quoteIdent(v.asset)})`);
  } catch (e) {
    throw doesNotFit(v, e);
  }
  if (present < all) return;
  throw new CroftError("USAGE_ERROR", {
    asset: v.asset,
    message: `the delete that put these ${all} rows of ${v.asset} in the trash (${v.reason}) did not finish: all ${all} are still in the table, so there is nothing to put back`,
    hint: `this version is a copy of rows that were never deleted; croft restore lists the versions, and ${v.asset}'s rows are as they were`,
    effect: "nothing was changed",
    fix: { kind: "command", description: "list the trash", command: "croft restore" },
    details: { path: v.path, applied: false, rows: all },
  });
}

function tableGone(v: TrashEntry): CroftError {
  return new CroftError("USAGE_ERROR", {
    asset: v.asset,
    message: `${v.asset} does not exist now, so the rows deleted from it at ${v.trashedAt} have no table to go back into`,
    hint: `restore a whole-table version of ${v.asset} first (croft restore ${v.asset} --at <time>; croft restore lists them), then these rows`,
    effect: "nothing was changed",
    fix: { kind: "command", description: "list the trash", command: "croft restore" },
    details: { path: v.path },
  });
}

async function impactOn(sql: Sql, v: TrashEntry, alias: string): Promise<RestoreImpact> {
  const asset = v.asset;
  if (!(await hasTable(sql, alias, "main", asset))) {
    throw new CroftError("USAGE_ERROR", {
      asset,
      message: `the trash file ${v.path} holds no table named ${asset}`,
      hint: "pick another version: croft restore lists them",
      effect: "nothing was changed",
      fix: { kind: "command", description: "list the trash", command: "croft restore" },
      details: { path: v.path },
    });
  }
  const kind = await kindOf(sql, alias);
  const exists = (await readTableSchema(sql, asset)) !== null;
  const currentRows = exists ? await count(sql, `main.${quoteIdent(asset)}`) : null;
  const all = await count(sql, `${quoteIdent(alias)}.main.${quoteIdent(asset)}`);
  let rows = all;
  if (kind === "rows") {
    if (!exists) throw tableGone(v);
    const unapplied = v.applied === false;
    const plan = await rowsPlan(sql, v, alias, unapplied);
    if (unapplied) await refuseUndeleted(sql, v, alias, plan.columns, all);
    try {
      rows = await count(sql, `(${plan.select})`);
    } catch (e) {
      throw doesNotFit(v, e);
    }
  }
  return {
    asset, version: v, kind, rows, skipped: all - rows, currentRows, downstream: await downstreamOf(sql, asset),
    generation: exists ? await tableGeneration(sql, asset) : null,
  };
}

/** What restoring `version` would do. Read-only (the trash file is ATTACHed read-only). */
export async function restoreImpact(warehouse: DuckWarehouse, version: TrashEntry): Promise<RestoreImpact> {
  return warehouse.read((sql) => withVersion(sql, version, (alias) => impactOn(sql, version, alias)), { purpose: `restore ${version.asset}` });
}

function fault(at: string, want: string | undefined): void {
  if (want && want === at) process.kill(process.pid, "SIGKILL");
}

/** Restore `version` of its asset. The caller has confirmed. */
export async function restoreVersion(warehouse: DuckWarehouse, version: TrashEntry, o: RestoreOptions = {}): Promise<RestoreResult> {
  const asset = version.asset;
  const impact = await restoreImpact(warehouse, version);
  let trashed: TrashEntry | null = null;
  if (impact.currentRows !== null) {
    try {
      trashed = await trashTable(warehouse, asset, `replaced by restore${o.runId ? ` (${o.runId})` : ""}`, {
        ...(o.runId ? { runId: o.runId } : {}), ...(o.now ? { now: o.now } : {}), ...(o.signal ? { signal: o.signal } : {}),
        keep: [version.path],
      });
    } catch (e) {
      if (e instanceof CroftError && ["DB_BUSY", "DB_HELD_BY_OTHER_PROGRAM", "INTERRUPTED"].includes(e.code)) throw e;
      throw trashFailed(asset, e);
    }
  }
  fault("between_trash_and_drop", o.fault);
  const at = o.now ?? clockNow();
  const done = await warehouse.write(`restore ${asset}`, (sql) => withVersion(sql, version, async (alias) => {
    await sql.exec("BEGIN TRANSACTION");
    try {
      await ensureState(sql);
      const stamp = await replacedStamp(sql, asset, at, alias);
      const src = `${quoteIdent(alias)}.main.${quoteIdent(asset)}`;
      let rows: number;
      let skipped = 0;
      const problems: Problem[] = [];
      if (impact.kind === "table") {
        await sql.exec(`CREATE OR REPLACE TABLE main.${quoteIdent(asset)} AS SELECT * FROM ${src}`);
        for (const table of STATE_TABLES) {
          const col = table === "assets" ? "name" : "asset";
          await sql.exec(`DELETE FROM _croft.${table} WHERE ${col} = $1`, [asset]);
          if (await hasTable(sql, alias, "_croft", table)) {
            await sql.exec(`INSERT INTO _croft.${table} BY NAME SELECT * FROM ${quoteIdent(alias)}._croft.${table} WHERE ${col} = $1`, [asset]);
          }
        }
        rows = await count(sql, `main.${quoteIdent(asset)}`);
      } else {
        if (!(await readTableSchema(sql, asset))) throw tableGone(version);
        // Something other than croft changed the table: said here, before its numbers are taken below.
        const oob = await checkOutOfBand(sql, asset);
        if (oob) problems.push(oob.problem);
        const unapplied = version.applied === false;
        const plan = await rowsPlan(sql, version, alias, unapplied);
        const all = await count(sql, src);
        if (unapplied) await refuseUndeleted(sql, version, alias, plan.columns, all);
        try {
          const [res] = await sql.all<{ Count: number | bigint }>(`INSERT INTO main.${quoteIdent(asset)} BY NAME ${plan.select}`);
          rows = Number(res?.Count ?? 0);
          skipped = all - rows;
        } catch (e) {
          throw doesNotFit(version, e, "nothing was put back");
        }
      }
      const stats = await tableStats(sql, asset);
      await sql.exec(
        `UPDATE _croft.assets SET row_count = $2, max_loaded_at = $3::TIMESTAMPTZ, last_replaced_at = $4::TIMESTAMPTZ, updated_at = $5::TIMESTAMPTZ
         WHERE name = $1`,
        [asset, stats.rowCount, stats.maxLoadedAtUs === null ? null : isoMicros(stats.maxLoadedAtUs), isoMicros(stamp), at.toISOString()],
      );
      await sql.exec("COMMIT");
      return { rows, skipped, rowsAfter: stats.rowCount, problems };
    } catch (e) {
      try {
        await sql.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }), { runId: o.runId ?? "restore", asset, transaction: false, ...(o.signal ? { signal: o.signal } : {}) });
  return {
    asset, restored: version, trashed, rows: done.rows, kind: impact.kind, skipped: done.skipped, rowsAfter: done.rowsAfter,
    downstream: impact.downstream, problems: done.problems,
  };
}

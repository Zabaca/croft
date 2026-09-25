// Delete (DESIGN.md §6 "Trash, restore and delete"): move a whole table, or the rows matching a predicate, to
// the trash, then remove them. Needs confirmation; the command (cli/commands/delete.ts) asks, takes the asset's
// lease and records the run, and these functions do the work.
//
// - Two commits, as for every destructive change: the trash commits first (trash.ts), then the delete. A crash
//   in between leaves the table as it was plus an extra trash file.
// - A whole table goes with its _croft state (assets, columns, files, inputs, writes). What other assets have
//   seen of it (their _croft.inputs rows) is theirs and stays: once the table is built again, they are stale.
// - `--where "<expr>"` is one SQL condition over the table's columns, vetted like a row check (checks/parse.ts
//   vetCheck: one expression, no second statement, no files, only the project's tables, no parameters) and bound
//   against the table before anything runs. A condition that picks rows at random (random(), uuid(), nextval(),
//   USING SAMPLE / TABLESAMPLE anywhere in it) is refused: the rows counted for the confirmation would not be the
//   rows deleted. The clock is allowed (`_loaded_at < now() - INTERVAL 90 DAY`); the count is recomputed at
//   confirmation, and the rows that go to the trash must be as many as the person agreed to (expectRows).
// - The predicate runs once, in the trash transaction. The delete never runs it again: it removes exactly the rows
//   the trash holds, by identity (every column equal, as many copies of each as the trash has), with the trash
//   file ATTACHed read-only. So the rows deleted are the rows in the trash, whatever the predicate would pick now: a
//   subquery over another table, the clock, a LIMIT, or rows written between the two commits. A trashed row the
//   table no longer has (changed outside croft in between) refuses the delete, and nothing is deleted. The "rows"
//   version is marked applied once the delete commits (trash.ts markApplied); until then restore treats it as rows
//   that were never deleted.
// - Rows deleted bump last_replaced_at (downstream rebuilds), and row_count and max_loaded_at are set to the
//   table's real numbers, so the out-of-band check does not mistake croft's own delete for someone else's. A change
//   made outside croft before the delete is reported first (OUT_OF_BAND_CHANGE, a warning), not folded in silently.
//   last_loaded_at does not move: no row was written.
import { vetCheck } from "../checks/parse.ts";
import { CroftError } from "../core/errors.ts";
import { now as clockNow, toEpochMicros } from "../core/time.ts";
import type { AssetKind, Problem, Sql } from "../core/types.ts";
import { hasState } from "../db/state.ts";
import type { DuckWarehouse } from "../db/warehouse.ts";
import { quoteIdent, readTableSchema } from "../load/evolve.ts";
import { didYouMean } from "../project/suggest.ts";
import { finiteJson, volatileUses, walk } from "../sql/ast.ts";
import { isoMicros, tableStats } from "./guards.ts";
import { checkOutOfBand } from "./out-of-band.ts";
import { markApplied, trashFailed, trashTable, type TrashEntry, withTrashFile } from "./trash.ts";

export interface DeleteImpact {
  asset: string;
  /** The rows that would go to the trash. */
  rows: number;
  /** The rows the table has now. */
  rowsBefore: number;
  /** null for the whole table. */
  where: string | null;
  /** Every asset that has read it, directly or through another (from _croft.inputs); they go stale. */
  downstream: string[];
  /** The kind croft recorded for it (_croft.assets), or null for a table croft has no record of. */
  kind: AssetKind | null;
  /** The table's generation (tableGeneration): part of the confirmation's hash, so a write since makes a token stale. */
  generation: string | null;
}

export interface DeleteResult extends DeleteImpact {
  trashed: TrashEntry;
  /** The rows the table has after the delete (0 for a whole table, which is gone). */
  rowsAfter: number;
  /** Warnings found on the way: OUT_OF_BAND_CHANGE when something other than croft changed the table first. */
  problems: Problem[];
}

/** Options of the destructive functions. `fault` is CROFT_FAULT (crash tests): between_trash_and_drop kills the
 *  process after the trash committed and before the delete. `expectRows`: the rows the person agreed to delete; a
 *  --where that puts another number in the trash is refused (CONFIRMATION_STALE) before anything is deleted.
 *  `afterTrash` runs between the two commits (tests: what another writer could do meanwhile). */
export interface DeleteOptions {
  runId?: string; now?: Date; signal?: AbortSignal; fault?: string; expectRows?: number; afterTrash?: () => Promise<void>;
}

/** Functions whose value changes on every call: the rows counted for the confirmation would not be the rows deleted. */
const RANDOM_FUNCTIONS = new Set(["random", "setseed", "gen_random_uuid", "uuid", "uuidv4", "uuidv7", "nextval", "currval"]);

const WHERE_HINT = (asset: string) =>
  `--where takes one SQL condition over ${asset}'s columns, as in a WHERE clause: --where "created_at < '2024-01-01'"`;

function whereError(asset: string, where: string, why: string, o: { code?: "USAGE_ERROR" | "UNKNOWN_COLUMN" | "UNKNOWN_TABLE"; hint?: string; details?: Record<string, unknown> } = {}): CroftError {
  return new CroftError(o.code ?? "USAGE_ERROR", {
    asset,
    message: `--where ${JSON.stringify(where.trim())} ${why}`,
    hint: o.hint ?? WHERE_HINT(asset),
    effect: "nothing was changed",
    fix: { kind: "command", description: `see ${asset}'s columns`, command: `croft describe ${asset}` },
    details: { asset, where, ...o.details },
  });
}

/** The table's name as DuckDB sees it in the warehouse's main schema, or UNKNOWN_TABLE (with a guess). */
export async function unknownTable(sql: Sql, asset: string, what = "delete"): Promise<CroftError> {
  const tables = (await sql.all<{ t: string }>(
    `SELECT table_name AS t FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' ORDER BY 1`)).map((r) => r.t);
  const guess = didYouMean(asset, tables);
  return new CroftError("UNKNOWN_TABLE", {
    asset,
    message: `there is no table named ${asset} in the warehouse, so there is nothing to ${what}`,
    hint: guess ? `did you mean ${guess}? names are exact (no patterns); croft status lists the tables` : "names are exact (no patterns); croft status lists the tables",
    effect: "nothing was changed",
    fix: { kind: "command", description: "list the assets and their tables", command: "croft status" },
    details: { asset, ...(guess ? { suggestion: guess } : {}) },
  });
}

/**
 * Vet `where` as one condition over `asset` and count the rows it matches (under the caller's lease). USAGE_ERROR
 * for what is not one safe expression, UNKNOWN_COLUMN / UNKNOWN_TABLE when it names what is not there, USAGE_ERROR
 * with DuckDB's words for anything else that does not run.
 */
export async function countWhere(sql: Sql, asset: string, where: string): Promise<number> {
  const text = where.trim();
  if (!text) throw whereError(asset, where, "is empty");
  const serialize = async (statement: string) =>
    String((await sql.all<{ j: string }>(`SELECT json_serialize_sql($1::VARCHAR)::VARCHAR AS j`, [statement]))[0]?.j ?? "{}");
  const vetted = await vetCheck(serialize, asset, { source: text, kind: "rule", blocking: true, scope: "table", sql: text, reads: [] });
  if (!vetted.ok) throw whereError(asset, where, vetted.why.replace(/\ba check\b/g, "--where").replace(/\bchecks\b/g, "--where"));
  const ast = JSON.parse(finiteJson(await serialize(`SELECT (\n${text}\n) FROM ${quoteIdent(asset)}`))) as unknown;
  const random = volatileUses(ast).map((u) => u.shown).filter((s) => RANDOM_FUNCTIONS.has(s.replace(/\(\)$/, "")));
  if (random.length) {
    throw whereError(asset, where, `calls ${random.join(", ")}, which picks different rows each time; the rows counted for the confirmation would not be the rows deleted`,
      { hint: "write a condition on the table's values" });
  }
  // USING SAMPLE / TABLESAMPLE, anywhere in it (a subquery included): the same, a random pick.
  let sampled = false;
  walk(ast, (node) => {
    if (node.sample !== null && typeof node.sample === "object") sampled = true;
  });
  if (sampled) {
    throw whereError(asset, where, "samples rows (USING SAMPLE or TABLESAMPLE), which picks different rows each time; the rows counted for the confirmation would not be the rows deleted",
      { hint: "write a condition on the table's values" });
  }
  try {
    const [row] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM main.${quoteIdent(asset)} WHERE (\n${text}\n)`);
    return Number(row?.n ?? 0);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const first = msg.split("\n")[0]!.replace(/^[A-Za-z ]+ Error: /, "");
    const column = /Referenced column "([^"]+)" not found/.exec(msg)?.[1] ?? /does not have a column named "([^"]+)"/.exec(msg)?.[1];
    if (column !== undefined) {
      const columns = ((await readTableSchema(sql, asset)) ?? []).map((c) => c.name);
      const guess = didYouMean(column, columns);
      throw whereError(asset, where, `names the column ${column}, which ${asset} does not have`, {
        code: "UNKNOWN_COLUMN",
        hint: `${guess ? `did you mean ${guess}? ` : ""}${asset}'s columns: ${columns.join(", ")}`,
        details: { column, columns, ...(guess ? { suggestion: guess } : {}) },
      });
    }
    const table = /Table with name ([^\s]+) does not exist/.exec(msg)?.[1];
    if (table !== undefined) {
      throw whereError(asset, where, `reads the table ${table}, which does not exist`, { code: "UNKNOWN_TABLE", hint: "name a table of this project; croft status lists them", details: { table } });
    }
    throw whereError(asset, where, `does not run: ${first}`, { details: { duckdb: first } });
  }
}

/** Every asset that has read `asset`, directly or through another, from _croft.inputs; sorted. */
export async function downstreamOf(sql: Sql, asset: string): Promise<string[]> {
  if (!(await hasState(sql))) return [];
  const rows = await sql.all<{ a: string }>(
    `WITH RECURSIVE down(a) AS (
       SELECT asset FROM _croft.inputs WHERE input = $1
       UNION
       SELECT i.asset FROM _croft.inputs i JOIN down ON i.input = down.a
     ) SELECT DISTINCT a FROM down WHERE a <> $1 ORDER BY a`, [asset]);
  return rows.map((r) => r.a);
}

/**
 * The instant a replaced table's last_replaced_at gets (epoch µs): the later of `now` and 1 µs past every version
 * croft recorded of the table (last_loaded_at, last_replaced_at) and every version a reader saw of it
 * (_croft.inputs.input_last_loaded_at). So a reader is stale afterwards (input_replaced) even when the clock is
 * behind those. `alias` also counts the _croft.assets row of an attached trash file (a restore).
 */
export async function replacedStamp(sql: Sql, asset: string, now: Date, alias?: string): Promise<bigint> {
  let stamp = toEpochMicros(now);
  if (!(await hasState(sql))) return stamp;
  const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as number | bigint));
  const seen: unknown[] = [];
  const [a] = await sql.all<{ l: unknown; r: unknown }>(
    `SELECT epoch_us(last_loaded_at) AS l, epoch_us(last_replaced_at) AS r FROM _croft.assets WHERE name = $1`, [asset]);
  seen.push(a?.l, a?.r);
  const [col] = await sql.all<{ n: number | bigint }>(
    `SELECT count(*) AS n FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = '_croft'
       AND table_name = 'inputs' AND column_name = 'input_last_loaded_at'`);
  if (Number(col?.n ?? 0) > 0) {
    const [i] = await sql.all<{ m: unknown }>(`SELECT epoch_us(max(input_last_loaded_at)) AS m FROM _croft.inputs WHERE input = $1`, [asset]);
    seen.push(i?.m);
  }
  if (alias !== undefined) {
    const [t] = await sql.all<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = $1 AND schema_name = '_croft' AND table_name = 'assets'`, [alias]);
    if (Number(t?.n ?? 0) > 0) {
      const [v] = await sql.all<{ l: unknown; r: unknown }>(
        `SELECT epoch_us(last_loaded_at) AS l, epoch_us(last_replaced_at) AS r FROM ${quoteIdent(alias)}._croft.assets WHERE name = $1`, [asset]);
      seen.push(v?.l, v?.r);
    }
  }
  for (const s of seen.map(big)) if (s !== null && s + 1n > stamp) stamp = s + 1n;
  return stamp;
}

/**
 * The table's generation: its last write and last replacement as croft recorded them (_croft.assets last_loaded_at
 * and last_replaced_at, epoch µs), or null when croft has no record of it. A write that changed rows, a rebuild, a
 * delete or a restore moves it, so a confirmation hashed with it is stale afterwards even when the row count is the
 * same (safety/confirm.ts impactHash).
 */
export async function tableGeneration(sql: Sql, asset: string): Promise<string | null> {
  if (!(await hasState(sql))) return null;
  const [a] = await sql.all<{ l: unknown; r: unknown }>(
    `SELECT epoch_us(last_loaded_at)::VARCHAR AS l, epoch_us(last_replaced_at)::VARCHAR AS r FROM _croft.assets WHERE name = $1`, [asset]);
  return a ? `${a.l ?? "-"}/${a.r ?? "-"}` : null;
}

async function recordedKind(sql: Sql, asset: string): Promise<AssetKind | null> {
  if (!(await hasState(sql))) return null;
  const [a] = await sql.all<{ kind: string | null }>(`SELECT kind FROM _croft.assets WHERE name = $1`, [asset]);
  return a?.kind === "ingest" || a?.kind === "sql" || a?.kind === "ts" ? a.kind : null;
}

/** Count what a delete would remove (the confirmation's impact). Read-only. */
export async function deleteImpact(warehouse: DuckWarehouse, asset: string, where: string | null): Promise<DeleteImpact> {
  return warehouse.read(async (sql) => {
    if (!(await readTableSchema(sql, asset))) throw await unknownTable(sql, asset);
    const [all] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM main.${quoteIdent(asset)}`);
    const rowsBefore = Number(all?.n ?? 0);
    const rows = where === null ? rowsBefore : await countWhere(sql, asset, where);
    return {
      asset, rows, rowsBefore, where, downstream: await downstreamOf(sql, asset), kind: await recordedKind(sql, asset),
      generation: await tableGeneration(sql, asset),
    };
  }, { purpose: `delete ${asset}` });
}

function fault(at: string, want: string | undefined): void {
  if (want && want === at) process.kill(process.pid, "SIGKILL");
}

async function toTrash(warehouse: DuckWarehouse, asset: string, reason: string, o: DeleteOptions, where?: string): Promise<TrashEntry> {
  let trashed: TrashEntry | null;
  try {
    trashed = await trashTable(warehouse, asset, reason, {
      ...(o.runId ? { runId: o.runId } : {}), ...(o.now ? { now: o.now } : {}), ...(o.signal ? { signal: o.signal } : {}),
      ...(where !== undefined ? { where, pending: true } : {}),
    });
  } catch (e) {
    if (e instanceof CroftError && ["DB_BUSY", "DB_HELD_BY_OTHER_PROGRAM", "INTERRUPTED"].includes(e.code)) throw e;
    throw trashFailed(asset, e);
  }
  if (!trashed) throw await warehouse.read((sql) => unknownTable(sql, asset));
  return trashed;
}

const runSuffix = (runId: string | undefined) => (runId ? ` (${runId})` : "");

/** Move the whole table and its _croft state to the trash, then drop it. The caller has confirmed. */
export async function deleteTable(warehouse: DuckWarehouse, asset: string, o: DeleteOptions = {}): Promise<DeleteResult> {
  const trashed = await toTrash(warehouse, asset, `delete${runSuffix(o.runId)}`, o);
  fault("between_trash_and_drop", o.fault);
  const gone = await warehouse.write(`delete ${asset}`, async (tx) => {
    if (!(await readTableSchema(tx, asset))) throw await unknownTable(tx, asset);
    const down = await downstreamOf(tx, asset);
    const kind = await recordedKind(tx, asset);
    await tx.exec(`DROP TABLE main.${quoteIdent(asset)}`);
    if (await hasState(tx)) {
      await tx.exec(`DELETE FROM _croft.assets WHERE name = $1`, [asset]);
      for (const table of ["columns", "files", "inputs", "writes"]) await tx.exec(`DELETE FROM _croft.${table} WHERE asset = $1`, [asset]);
    }
    return { down, kind };
  }, { runId: o.runId ?? "delete", asset, ...(o.signal ? { signal: o.signal } : {}) });
  return {
    asset, rows: trashed.rows, rowsBefore: trashed.rows, rowsAfter: 0, where: null, downstream: gone.down, kind: gone.kind, generation: null,
    trashed, problems: [],
  };
}

/** CONFIRMATION_STALE for a delete --where that stopped between its two commits: the rows are in the trash, and
 *  none were deleted. */
function rowsStale(asset: string, where: string, trashed: TrashEntry, why: string, details: Record<string, unknown> = {}): CroftError {
  return new CroftError("CONFIRMATION_STALE", {
    asset,
    message: `${why}; nothing was deleted`,
    hint: `the table changed meanwhile; run croft delete ${asset} --where again to see the rows it would delete now, and show the user the new impact`,
    effect: `nothing was deleted; an extra copy of ${trashed.rows} rows is in the trash (${trashed.path}), listed as not deleted`,
    fix: { kind: "manual", description: "run the delete again and show the user the new impact" },
    details: { asset, where, trashed: trashed.rows, trashPath: trashed.path, ...details },
  });
}

/**
 * Delete from the table exactly the rows of the "rows" version ATTACHed as `alias`: each trashed row by identity
 * (every column IS NOT DISTINCT FROM), as many copies of it as the trash holds and no more. Returns the rows deleted
 * and the rows in the trash; they differ only when the table lost some trashed rows meanwhile (the caller refuses).
 * CONFIRMATION_STALE when the table's columns are no longer the trashed ones.
 */
async function deleteTrashedRows(sql: Sql, asset: string, alias: string, where: string, trashed: TrashEntry): Promise<{ deleted: number; inTrash: number }> {
  const table = (await readTableSchema(sql, asset)) ?? [];
  const kept = (await readTableSchema(sql, asset, alias)) ?? [];
  const shape = (cs: readonly { name: string; type: string }[]) => cs.map((c) => `${c.name.toLowerCase()} ${c.type}`).join(", ");
  if (!table.length || shape(table) !== shape(kept)) {
    throw rowsStale(asset, where, trashed, `the columns of ${asset} changed between the trash and the delete (outside croft)`,
      { columnsNow: shape(table), columnsTrashed: shape(kept) });
  }
  const cols = kept.map((c) => quoteIdent(c.name));
  const same = cols.map((c) => `t.${c} IS NOT DISTINCT FROM w.${c}`).join(" AND ");
  const src = `${quoteIdent(alias)}.main.${quoteIdent(asset)}`;
  const [n] = await sql.all<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${src}`);
  const inTrash = Number(n?.n ?? 0);
  // w: each distinct trashed row once, with how many copies the trash holds (__croft_n) and a group number; the
  // table's rows equal to one are numbered within their group, and the first __croft_n of each go.
  const [res] = await sql.all<{ Count: number | bigint }>(
    `DELETE FROM main.${quoteIdent(asset)} WHERE rowid IN (
       SELECT __croft_rid FROM (
         SELECT t.rowid AS __croft_rid, w.__croft_n, row_number() OVER (PARTITION BY w.__croft_g) AS __croft_rn
         FROM main.${quoteIdent(asset)} t
         JOIN (SELECT *, row_number() OVER () AS __croft_g FROM (SELECT ${cols.join(", ")}, count(*) AS __croft_n FROM ${src} GROUP BY ALL)) w
           ON ${same}
       ) WHERE __croft_rn <= __croft_n)`);
  return { deleted: Number(res?.Count ?? 0), inTrash };
}

/** Move the rows matching `where` to the trash, then delete exactly those rows. The caller has confirmed. */
export async function deleteWhere(warehouse: DuckWarehouse, asset: string, where: string, o: DeleteOptions = {}): Promise<DeleteResult> {
  const impact = await deleteImpact(warehouse, asset, where);
  if (impact.rows === 0) {
    throw whereError(asset, where, `matches no rows of ${asset}; nothing was deleted`, { hint: "check the condition with croft query first" });
  }
  const text = where.trim();
  const trashed = await toTrash(warehouse, asset, `delete --where ${JSON.stringify(text)}${runSuffix(o.runId)}`, o, text);
  fault("between_trash_and_drop", o.fault);
  if (o.expectRows !== undefined && trashed.rows !== o.expectRows) {
    throw rowsStale(asset, text, trashed, `--where matched ${trashed.rows} rows of ${asset} when they went to the trash, not the ${o.expectRows} the confirmation was for`,
      { expected: o.expectRows });
  }
  await o.afterTrash?.();
  const at = o.now ?? clockNow();
  const done = await warehouse.write(`delete rows of ${asset}`, (sql) => withTrashFile(sql, trashed.path, async (alias) => {
    await sql.exec("BEGIN TRANSACTION");
    try {
      // Something other than croft changed the table since croft's last commit: said once, here, rather than
      // folded into the numbers recorded below.
      const oob = await checkOutOfBand(sql, asset);
      // The stamp is read before the delete: only _croft rows change after it.
      const stamp = await replacedStamp(sql, asset, at);
      let counts: { deleted: number; inTrash: number };
      try {
        counts = await deleteTrashedRows(sql, asset, alias, text, trashed);
      } catch (e) {
        if (e instanceof CroftError) throw e;
        throw new CroftError("INTERNAL_ERROR", {
          asset,
          message: `could not match the trashed rows of ${asset} with its rows: ${String((e as Error)?.message ?? e).split("\n")[0]}`,
          hint: "nothing was deleted; report this croft bug",
          effect: `nothing was deleted; an extra copy of ${trashed.rows} rows is in the trash (${trashed.path}), listed as not deleted`,
        });
      }
      if (counts.deleted !== counts.inTrash) {
        throw rowsStale(asset, text, trashed,
          `${counts.inTrash - counts.deleted} of the ${counts.inTrash} rows of ${asset} that went to the trash were no longer in the table at the delete`,
          { matched: counts.deleted });
      }
      const stats = await tableStats(sql, asset);
      if (await hasState(sql)) {
        await sql.exec(
          `UPDATE _croft.assets SET row_count = $2, max_loaded_at = $3::TIMESTAMPTZ, last_replaced_at = $4::TIMESTAMPTZ, updated_at = $5::TIMESTAMPTZ
           WHERE name = $1`,
          [asset, stats.rowCount, stats.maxLoadedAtUs === null ? null : isoMicros(stats.maxLoadedAtUs), isoMicros(stamp), at.toISOString()],
        );
      }
      await sql.exec("COMMIT");
      return { rowsAfter: stats.rowCount, problems: oob ? [oob.problem] : [] };
    } catch (e) {
      try {
        await sql.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }), { runId: o.runId ?? "delete", asset, transaction: false, ...(o.signal ? { signal: o.signal } : {}) });
  // The rows are deleted: the version holds rows a restore may put back.
  markApplied(trashed.path);
  const { applied: _pending, ...version } = trashed;
  return { ...impact, where: text, rows: trashed.rows, rowsAfter: done.rowsAfter, trashed: version, problems: done.problems };
}

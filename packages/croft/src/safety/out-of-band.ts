// Out-of-band changes (DESIGN.md §5 "Versions, staleness and atomicity" → "Out-of-band changes"; §6 principle: croft
// "detects writes it did not make").
//
// Every commit records the table's row_count and max(_loaded_at) in _croft.assets: writeBatch (ingests, SQL and TS
// transforms, each chunk and partial commit), and the delete, restore, rename and config-change paths, which set them
// from the table itself. A table whose numbers differ was written by something other than croft (the duckdb CLI, a
// GUI, a script).
//
//   write lease   load/write.ts writeBatch compares them first thing in its transaction (checkOutOfBand). On a
//                 mismatch the step warns OUT_OF_BAND_CHANGE, saying what changed; last_replaced_at moves to the
//                 write's stamp, so what reads the table rebuilds (input_replaced); and the table's real numbers are
//                 recorded with the write, so the change is reported once. A write that fails records nothing, and
//                 the next one reports it.
//   doctor        scanTables compares every table croft has a record of, read-only, and also reports
//                 TABLE_MODIFIED_OUTSIDE_CROFT (columns added, dropped or retyped outside croft: safety/guards.ts,
//                 unchanged). It changes nothing: the next write of the asset takes the change in.
//
// Updates that keep both the row count and the newest stamp are not seen; `croft preview <asset> --rebuild` finds
// those by comparing the table with a fresh build.
import { problem } from "../core/errors.ts";
import type { Problem, Sql } from "../core/types.ts";
import { hasState } from "../db/state.ts";
import { currentDatabase } from "../load/evolve.ts";
import { detectOutOfBand, detectTableModified, type OutOfBand, tableStats, type TableStats } from "./guards.ts";

export type { OutOfBand } from "./guards.ts";

type Numbers = OutOfBand["expected"];
type Actual = OutOfBand["actual"];

const formatCount = (n: number) => n.toLocaleString("en-US");
const rowsText = (n: number) => `${formatCount(n)} row${n === 1 ? "" : "s"}`;

/**
 * What changed between croft's last commit and the table, in words: "1 row removed (3 → 2)", "the table was dropped
 * (croft left 3 rows)", "rows stamped after croft's last write (newest _loaded_at …, croft's …)".
 */
export function changeWords(expected: Numbers, actual: Actual): string {
  if (!actual.exists) return `the table was dropped (croft left ${rowsText(expected.rowCount)})`;
  const parts: string[] = [];
  const d = actual.rowCount - expected.rowCount;
  if (d < 0) parts.push(`${rowsText(-d)} removed (${formatCount(expected.rowCount)} → ${formatCount(actual.rowCount)})`);
  if (d > 0) parts.push(`${rowsText(d)} added (${formatCount(expected.rowCount)} → ${formatCount(actual.rowCount)})`);
  const was = expected.maxLoadedAt;
  const now = actual.maxLoadedAt;
  if (was !== now) {
    const same = d === 0 ? `the same ${rowsText(actual.rowCount)}, but ` : "";
    if (now === null) parts.push(`${same}no row has a _loaded_at any more (croft's newest was ${was})`);
    else if (was === null || now > was) parts.push(`${same}rows stamped after croft's last write (newest _loaded_at ${now}${was ? `, croft's ${was}` : ""})`);
    else parts.push(`${same}the rows croft wrote last are gone or restamped (newest _loaded_at ${now}, croft's ${was})`);
  }
  return parts.join("; ");
}

/**
 * OUT_OF_BAND_CHANGE for a table that differs from croft's record. `at`: "write" when a write lease takes the change
 * in now; "doctor" when it is only seen, and the next write of the asset takes it in.
 */
export function outOfBandProblem(asset: string, expected: Numbers, actual: Actual, at: "write" | "doctor" = "write"): Problem {
  const what = changeWords(expected, actual);
  return problem("OUT_OF_BAND_CHANGE", {
    asset,
    message: `${asset} was changed outside croft: ${what}`,
    hint: `tell the user something other than croft (the duckdb CLI, a GUI, a script) wrote ${asset}; croft preview ${asset} --rebuild compares it with a fresh build`,
    effect: at === "write" ? "croft went on from the table as it was; assets that read it are rebuilt on their next run"
      : `the next run of ${asset} goes on from the table as it is then, and assets that read it are rebuilt after that`,
    fix: { kind: "manual", description: `tell the user ${asset} was changed outside croft (${what}), and change tables only through croft` },
    details: { expected, actual },
  });
}

/**
 * At a write lease: detectOutOfBand's comparison (safety/guards.ts), worded with what changed. null when croft has no
 * commit of the asset on record, or the numbers agree. `stats`: the table's numbers when the caller has them.
 */
export async function checkOutOfBand(sql: Sql, asset: string, stats?: TableStats): Promise<OutOfBand | null> {
  const found = await detectOutOfBand(sql, asset, stats);
  if (!found) return null;
  return { ...found, problem: outOfBandProblem(asset, found.expected, found.actual, "write") };
}

/** One table doctor found changed outside croft. */
export interface TableFinding {
  asset: string;
  /** Rows or stamps differ from croft's last commit (OUT_OF_BAND_CHANGE, doctor's wording). */
  outOfBand: OutOfBand | null;
  /** Columns differ from croft's record (TABLE_MODIFIED_OUTSIDE_CROFT); null for a dropped table, which outOfBand
   *  already reports. */
  schema: Problem | null;
}

export interface TableScan {
  /** Tables compared (assets with a commit on record). */
  checked: number;
  /** Tables left out because the time budget ran out (the next write of each still compares it). */
  skipped: number;
  findings: TableFinding[];
}

/**
 * doctor: every table croft has a commit of, compared with its record, in name order. Read-only; usable from a read
 * lease. `budgetMs`: stop starting new tables after this long (max(_loaded_at) reads a whole column), so doctor stays
 * quick on a big warehouse.
 */
export async function scanTables(sql: Sql, o: { budgetMs?: number } = {}): Promise<TableScan> {
  const none: TableScan = { checked: 0, skipped: 0, findings: [] };
  if (!(await hasState(sql))) return none;
  // A database from a croft that wrote _croft.meta only (or a hand-made one) has nothing to compare.
  const have = new Set((await sql.all<{ t: string }>(
    `SELECT table_name AS t FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = '_croft'`)).map((r) => r.t));
  if (!have.has("assets")) return none;
  const start = Date.now();
  const db = await currentDatabase(sql);
  const assets = (await sql.all<{ name: string }>(`SELECT name FROM _croft.assets WHERE row_count IS NOT NULL ORDER BY name`)).map((r) => r.name);
  const findings: TableFinding[] = [];
  let checked = 0;
  for (const asset of assets) {
    if (o.budgetMs !== undefined && Date.now() - start >= o.budgetMs) break;
    const stats = await tableStats(sql, asset, db);
    const found = await detectOutOfBand(sql, asset, stats);
    const outOfBand = found ? { ...found, problem: outOfBandProblem(asset, found.expected, found.actual, "doctor") } : null;
    const schema = stats.exists && have.has("columns") ? await detectTableModified(sql, asset, stats.columns) : null;
    if (outOfBand || schema) findings.push({ asset, outOfBand, schema });
    checked++;
  }
  return { checked, skipped: assets.length - checked, findings };
}

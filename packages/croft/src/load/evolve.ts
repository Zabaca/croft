// Schema evolution of an ingest's target table (DESIGN.md §5 "One ingest step" step g, §7 "Evolution of an
// existing column").
//
// cast.ts has already decided, per column, what the batch needs (ColumnPlan.decision); this module applies
// those decisions to the real table: CREATE TABLE on the first load, ADD COLUMN for new fields, ALTER
// COLUMN TYPE for proven-lossless widenings and for pending (all-NULL) placeholders that received real
// values. It runs before any DML on the table, because DuckDB fails at COMMIT when an ALTER follows an
// UPDATE/DELETE/MERGE on the same table in one transaction [V]; the Sql wrapper's TxGuard turns a violation
// into DDL_AFTER_DML at the offending statement.
//
// Every identifier is quoted and every type string is checked against a strict shape, because pins come
// from user config and end up inside DDL.
import { CroftError } from "../core/errors.ts";
import type { ColumnPlan, SchemaChange, Sql } from "../core/types.ts";
import { inLake } from "../db/bookkeeping.ts";
import { RESERVED } from "./contract.ts";

/** A column as the database reports it, with the type normalized (see normalizeType). */
export interface RealColumn { name: string; type: string }

/** Quote an identifier for DuckDB: always double quotes, embedded quotes doubled. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Quote a string literal. */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// DuckDB spells some types differently from croft's ColumnType names; user pins may use common aliases.
const ALIASES: Record<string, string> = {
  "TIMESTAMP WITH TIME ZONE": "TIMESTAMPTZ",
  "TIME WITH TIME ZONE": "TIMETZ",
  "TIMESTAMP WITHOUT TIME ZONE": "TIMESTAMP",
  DATETIME: "TIMESTAMP",
  INT8: "BIGINT", LONG: "BIGINT",
  INT: "INTEGER", INT4: "INTEGER", SIGNED: "INTEGER",
  INT2: "SMALLINT", SHORT: "SMALLINT", INT1: "TINYINT",
  INT16: "HUGEINT", INT128: "HUGEINT",
  FLOAT8: "DOUBLE", "DOUBLE PRECISION": "DOUBLE",
  FLOAT4: "FLOAT", REAL: "FLOAT",
  STRING: "VARCHAR", TEXT: "VARCHAR", CHAR: "VARCHAR", BPCHAR: "VARCHAR",
  BOOL: "BOOLEAN", LOGICAL: "BOOLEAN",
  NUMERIC: "DECIMAL(18,3)", DECIMAL: "DECIMAL(18,3)",
};

/** Canonical spelling of a SQL type, so types from duckdb_columns(), cast.ts and pins compare equal:
 *  upper case, single spaces, no spaces inside parentheses, DuckDB's aliases resolved. */
export function normalizeType(type: string): string {
  let t = type.trim().toUpperCase().replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1");
  t = t.replace(/^NUMERIC\(/, "DECIMAL(");
  const suffix = /(\[\d*\])+$/.exec(t)?.[0] ?? "";
  const base = suffix ? t.slice(0, -suffix.length) : t;
  return (ALIASES[base] ?? base) + suffix;
}

// Scalar types, DECIMAL(p,s), VARCHAR(n) and list suffixes. Nothing else can reach DDL.
const TYPE_SHAPE = /^[A-Z][A-Z0-9_]*( [A-Z][A-Z0-9_]*)*(\(\d{1,3}(,\d{1,3})?\))?(\[\d*\])*$/;

/** The normalized type, or ASSET_INVALID when the text is not a plain SQL type (it goes into DDL). */
export function safeType(type: string, column: string): string {
  const t = normalizeType(type);
  if (!TYPE_SHAPE.test(t)) {
    throw new CroftError("ASSET_INVALID", {
      message: `column ${column}: "${type}" is not a SQL type croft can use`,
      hint: "pin a plain type such as BIGINT, DOUBLE, VARCHAR, DATE, TIMESTAMPTZ, JSON or DECIMAL(18,2)",
      details: { column, type },
    });
  }
  return t;
}

const lower = (s: string) => s.toLowerCase();
const sameName = (a: string, b: string) => lower(a) === lower(b);

/** The name of the database the connection writes (the warehouse's catalog). */
export async function currentDatabase(sql: Sql): Promise<string> {
  const [row] = await sql.all<{ db: string }>(`SELECT current_database() AS db`);
  return row!.db;
}

/**
 * A fully qualified reference to a table in the warehouse's main schema. The catalog must be named:
 * a TEMP table with the same name shadows both `t` and `main.t` [V], and cast.ts names its temp tables.
 */
export function tableRef(database: string, table: string): string {
  return `${quoteIdent(database)}.main.${quoteIdent(table)}`;
}

/** A reference to a TEMP table. */
export function tempRef(table: string): string {
  return `temp.main.${quoteIdent(table)}`;
}

/**
 * The real columns of a table from duckdb_columns(), in table order, or null when it does not exist.
 * `database` is "temp" for TEMP tables; by default the connection's current database.
 */
export async function readTableSchema(sql: Sql, table: string, database?: string): Promise<RealColumn[] | null> {
  const rows = await sql.all<{ name: string; type: string }>(
    `SELECT column_name AS name, data_type AS type FROM duckdb_columns()
     WHERE database_name = $1 AND schema_name = 'main' AND table_name = $2
     ORDER BY column_index`,
    [database ?? (await currentDatabase(sql)), table],
  );
  if (rows.length === 0) return null;
  return rows.map((r) => ({ name: r.name, type: normalizeType(r.type) }));
}

/**
 * The column type changes DuckLake takes with ALTER ... TYPE: its widening promotions, which are exactly the widenings croft makes (§7,
 * load/types.ts widenTarget). Any other change (a pending placeholder that received values, a pin that retypes a stored column) is refused
 * by a lake ("only widening type promotions are allowed") [V: 2.0.0, DuckLake 1.0], and is made by rewriting the table instead.
 */
const LAKE_PROMOTIONS: Readonly<Record<string, readonly string[]>> = {
  INTEGER: ["BIGINT", "HUGEINT", "DOUBLE"],
  BIGINT: ["HUGEINT", "DOUBLE"],
  HUGEINT: ["DOUBLE"],
  DATE: ["TIMESTAMP", "TIMESTAMPTZ"],
  TIMESTAMP: ["TIMESTAMPTZ"],
};

/** One column's type change: `using` is the pin's cast of the stored values, where there is one. */
export interface Retype { column: string; from: string; to: string; using?: string }

/** Whether a lake takes this change as a plain ALTER (a widening promotion, with no cast of its own); every other change is a rewrite there. */
export const lakePromotes = (c: Retype): boolean => c.using === undefined && LAKE_PROMOTIONS[c.from]?.includes(c.to) === true;

/**
 * Change the type of columns of the table `ref` (db.main.<table>), the whole table being `table` in database `db`, together. In a file each is
 * ALTER COLUMN ... TYPE (with `using` when there is one). In a lake, when any of them is a change its ALTER does not take, they are all made by
 * one rewrite in the same transaction: CREATE OR REPLACE TABLE ... AS SELECT the same columns in the same order, each changed one by its cast.
 * The table keeps its name, its columns and their order and every row; it is a new table to the lake (a version of the old one stays readable
 * as of the earlier snapshots). One, and first: DuckLake 2.0.0 cannot
 * read a table back in a transaction that changed it ("Table 0 does not exist" after an ALTER, a missing data file after a rewrite) [V: 2.0.0,
 * DuckLake 1.0, probed in the transaction with 2 and with 50 rows], so a rewrite is the first change to a table in its write, and a second
 * one is refused here with a croft code instead of that. An ALTER after the rewrite is fine.
 */
export async function retypeColumns(tx: Sql, o: { ref: string; table: string; db: string; changes: readonly Retype[] }): Promise<void> {
  if (o.changes.length === 0) return;
  const lake = await inLake(tx);
  if (!lake || o.changes.every(lakePromotes)) {
    for (const c of o.changes) {
      await tx.exec(c.using === undefined
        ? `ALTER TABLE ${o.ref} ALTER COLUMN ${quoteIdent(c.column)} TYPE ${c.to}`
        : `ALTER TABLE ${o.ref} ALTER COLUMN ${quoteIdent(c.column)} SET DATA TYPE ${c.to} USING ${c.using}`);
    }
    return;
  }
  const columns = await readTableSchema(tx, o.table, o.db);
  if (!columns) throw new CroftError("INTERNAL_ERROR", { message: `cannot retype ${o.changes[0]!.column}: ${o.table} does not exist`, hint: "report this croft bug" });
  const select = columns.map((c) => {
    const change = o.changes.find((x) => sameName(x.column, c.name));
    return change ? `${change.using ?? `CAST(${quoteIdent(c.name)} AS ${change.to})`} AS ${quoteIdent(c.name)}` : quoteIdent(c.name);
  });
  try {
    await tx.exec(`CREATE OR REPLACE TABLE ${o.ref} AS SELECT ${select.join(", ")} FROM ${o.ref}`);
  } catch (e) {
    if (!/Table \d+ does not exist|Cannot open file|NoSuchKey|HTTP 404/.test(e instanceof Error ? e.message : String(e))) throw e;
    throw new CroftError("LAKE_UNSUPPORTED", {
      message: `${o.table} cannot be retyped (${o.changes.map((c) => `${c.column} to ${c.to}`).join(", ")}) in the same write that already changed it: a lake rewrites a table for this change, and cannot do it after another change to the table`,
      hint: "make one change at a time: run once with the pin or the new data that retypes the column, then again with the other change",
      fix: { kind: "manual", description: "split the change over two runs; nothing was written by this one", requiresHuman: false },
      effect: "nothing was written",
      details: { table: o.table, columns: o.changes.map((c) => c.column) },
    });
  }
}

export interface EvolveInput {
  /** The asset's table in the main schema. */
  table: string;
  /** Decisions from cast.ts (TypedBatch.columns). */
  plans: ColumnPlan[];
  /** Columns of the batch's TEMP table (fallback types for plans without target or existing). */
  batchColumns: RealColumn[];
}

export interface EvolveResult {
  created: boolean;
  changes: SchemaChange[];
  /** The table's columns after evolution. */
  columns: RealColumn[];
}

/** Columns croft owns in every table (and the batch's ordering column); never planned as data. */
export function isReservedColumn(name: string): boolean {
  const n = name.toLowerCase();
  return n === RESERVED.loadedAt || n === RESERVED.seq || n === RESERVED.file;
}

/** The type a plan wants its column to have in the table. */
function wantedType(plan: ColumnPlan, fallback: RealColumn | undefined, real: RealColumn | undefined): string | null {
  const t = plan.target ?? plan.existing ?? real?.type ?? fallback?.type;
  return t ? safeType(t, plan.column) : null;
}

function conflict(plan: ColumnPlan, message: string, details: Record<string, unknown> = {}): CroftError {
  return new CroftError("TYPE_CONFLICT", {
    message,
    hint: "clean the value in rows() or map(), or pin a type in `columns`",
    details: {
      column: plan.column, existingType: plan.existing, incomingKinds: plan.incoming, badRows: plan.badRows, samples: plan.samples,
      existing: plan.existing, incoming: plan.incoming, ...details,
    },
  });
}

/**
 * Bring the table's schema in line with the batch. Runs only DDL (plus read-only probes), so callers can do
 * it first in the transaction. Returns what changed; creating the table on the first load is not a change.
 */
export async function evolveTable(tx: Sql, input: EvolveInput): Promise<EvolveResult> {
  const db = await currentDatabase(tx);
  const ref = tableRef(db, input.table);
  const real = await readTableSchema(tx, input.table, db);
  const batchCol = (name: string) => input.batchColumns.find((c) => sameName(c.name, name));
  const hasFile = Boolean(batchCol(RESERVED.file));

  for (const plan of input.plans) {
    if (plan.decision === "conflict") {
      throw conflict(plan, `column ${plan.column}: ${plan.existing ?? "?"} cannot hold the incoming ${plan.incoming.join(", ")} values`);
    }
  }
  const plans = input.plans.filter((p) => !isReservedColumn(p.column));

  if (!real) {
    const defs: string[] = [];
    const seen = new Set<string>();
    for (const plan of plans) {
      const key = plan.column.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const type = wantedType(plan, batchCol(plan.column), undefined);
      if (!type) {
        throw new CroftError("INTERNAL_ERROR", { message: `column ${plan.column} has no type (no target, no existing type, not in the batch)`, hint: "report this croft bug" });
      }
      defs.push(`${quoteIdent(plan.column)} ${type}`);
    }
    if (hasFile) defs.push(`${quoteIdent(RESERVED.file)} VARCHAR`);
    defs.push(`${quoteIdent(RESERVED.loadedAt)} TIMESTAMPTZ`);
    await tx.exec(`CREATE TABLE ${ref} (${defs.join(", ")})`);
    return { created: true, changes: [], columns: (await readTableSchema(tx, input.table, db))! };
  }

  const changes: SchemaChange[] = [];
  const realCol = (name: string) => real.find((c) => sameName(c.name, name));
  const nonNullCount = async (column: string): Promise<number> => {
    const [row] = await tx.all<{ n: number | bigint }>(`SELECT count(${quoteIdent(column)}) AS n FROM ${ref}`);
    return Number(row!.n);
  };
  const add = async (column: string, type: string) => {
    await tx.exec(`ALTER TABLE ${ref} ADD COLUMN ${quoteIdent(column)} ${type}`);
    real.push({ name: column, type });
    changes.push({ kind: "add_column", column, type });
  };
  // A pending placeholder retypes only when it holds nothing; "add" lands here when the column already exists (state lost, or added outside
  // croft), and only an all-NULL column may retype.
  const requireEmpty = async (plan: ColumnPlan, have: RealColumn, want: string) => {
    const n = await nonNullCount(have.name);
    if (n > 0) {
      throw conflict(plan, `column ${have.name} already holds ${n} non-NULL ${have.type} values; croft will not retype it to ${want}`, { tableType: have.type, wanted: want, nonNull: n });
    }
  };
  // In a lake the changes its ALTER does not take are made first and together, by one rewrite of the table (retypeColumns says why); the loop
  // below then finds them done. The loop's own ALTERs (promotions, new columns) come after, which a lake takes.
  const rewritten = new Set<string>();
  if (await inLake(tx)) {
    const todo: Retype[] = [];
    for (const plan of plans) {
      const have = realCol(plan.column);
      const want = wantedType(plan, batchCol(plan.column), have);
      if (!have || !want || have.type === want) continue;
      if (plan.decision === "retype_pending" || plan.decision === "add") await requireEmpty(plan, have, want);
      else if (plan.decision !== "widen") continue; // the loop below refuses it
      const change = { column: have.name, from: have.type, to: want };
      if (!lakePromotes(change)) todo.push(change);
    }
    await retypeColumns(tx, { ref, table: input.table, db, changes: todo });
    for (const c of todo) rewritten.add(lower(c.column));
  }
  const retype = async (column: string, type: string) => {
    const col = real.find((c) => sameName(c.name, column))!;
    if (!rewritten.has(lower(column))) await retypeColumns(tx, { ref, table: input.table, db, changes: [{ column, from: col.type, to: type }] });
    col.type = type;
  };

  for (const plan of plans) {
    const have = realCol(plan.column);
    const want = wantedType(plan, batchCol(plan.column), have);
    if (!want) continue;
    if (!have) {
      // A new field, or a known column that disappeared from the table outside croft.
      await add(plan.column, want);
      continue;
    }
    if (have.type === want) continue;
    switch (plan.decision) {
      case "widen": {
        // cast.ts proved the widening lossless for stored and incoming values (§7).
        const from = have.type;
        await retype(have.name, want);
        changes.push({ kind: "widen", column: have.name, from, to: want });
        break;
      }
      case "retype_pending":
      case "add": {
        // A pending placeholder holds only NULLs, so any type change is free.
        await requireEmpty(plan, have, want);
        await retype(have.name, want);
        changes.push({ kind: "retype_pending", column: have.name, to: want });
        break;
      }
      default:
        // keep / cast: the batch was cast to a type the table no longer has (changed outside croft).
        throw conflict(plan, `column ${have.name} is ${have.type} in the table but croft expected ${want}; the table was changed outside croft`, { tableType: have.type, wanted: want });
    }
  }
  if (hasFile && !realCol(RESERVED.file)) await add(RESERVED.file, "VARCHAR");
  if (!realCol(RESERVED.loadedAt)) await add(RESERVED.loadedAt, "TIMESTAMPTZ");
  return { created: false, changes, columns: (await readTableSchema(tx, input.table, db))! };
}

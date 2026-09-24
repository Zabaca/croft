// A typed batch over a TEMP table croft computed itself (DESIGN.md §5 "Transforms"): the SQL step's result.
//
// cast.ts types rows that arrive as JSON: it infers, widens and casts. Here the SELECT has typed every column
// already, so nothing is inferred or cast: each column's ColumnPlan says the type it has (target), the type the
// asset's table gives it now (existing), and the kinds of values it holds (incoming), which _croft.columns
// records (kinds, present_last_batch). One scan reads them all: a count per column, and the JSON kinds of JSON
// columns. write.ts then diffs the batch into the table like a replace ingest (kind "sql").
import { CroftError } from "../core/errors.ts";
import type { ColumnPlan, Sql, ValueKind } from "../core/types.ts";
import { RESERVED, type TypedBatch } from "./contract.ts";
import { isReservedColumn, quoteIdent, readTableSchema, tempRef } from "./evolve.ts";

export interface TableBatchInput {
  /** The TEMP table: the rows, their columns, and RESERVED.seq (BIGINT, e.g. row_number() OVER ()). */
  temp: string;
  /** The asset the batch is written to: its table's current column types become ColumnPlan.existing. */
  asset: string;
}

const INTEGERS = new Set(["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT"]);

/** The value kind a non-NULL value of a (normalized) DuckDB type is recorded as. JSON columns are read value by
 *  value instead (tableBatch); here JSON counts as a string. */
export function kindOfType(type: string): ValueKind {
  const t = type.toUpperCase();
  if (/\[\d*\]$/.test(t)) return "array";
  if (/^(STRUCT|MAP|UNION)\(/.test(t)) return "object";
  if (INTEGERS.has(t)) return "integer";
  if (t === "FLOAT" || t === "DOUBLE" || t.startsWith("DECIMAL")) return "float";
  if (t === "BOOLEAN") return "boolean";
  if (t === "TIMESTAMPTZ" || t === "TIMESTAMP WITH TIME ZONE") return "iso_instant";
  if (t.startsWith("TIMESTAMP")) return "iso_naive";
  if (t === "DATE") return "iso_date";
  return "string";
}

// json_type() of a JSON value → its kind.
const JSON_KINDS: Record<string, ValueKind> = {
  OBJECT: "object", ARRAY: "array", VARCHAR: "string", BIGINT: "integer", UBIGINT: "integer", DOUBLE: "float",
  BOOLEAN: "boolean", NULL: "null",
};

/** A TypedBatch over `temp`, one ColumnPlan per data column (reserved columns are not data). A column with a
 *  non-NULL value lists the kinds it holds; one with only NULLs is ["null"]; in an empty batch, []. */
export async function tableBatch(tx: Sql, i: TableBatchInput): Promise<TypedBatch> {
  const cols = await readTableSchema(tx, i.temp, "temp");
  if (!cols || !cols.some((c) => c.name.toLowerCase() === RESERVED.seq)) {
    throw new CroftError("INTERNAL_ERROR", {
      message: cols ? `the batch table ${i.temp} has no ${RESERVED.seq} column` : `the batch table ${i.temp} does not exist`,
      hint: "report this croft bug", asset: i.asset,
    });
  }
  const data = cols.filter((c) => !isReservedColumn(c.name));
  const table = (await readTableSchema(tx, i.asset)) ?? [];
  const exprs = ["count(*) AS n"];
  data.forEach((c, k) => {
    const q = quoteIdent(c.name);
    exprs.push(`count(${q}) AS c${k}`);
    if (c.type === "JSON") exprs.push(`list(DISTINCT json_type(${q})) FILTER (WHERE ${q} IS NOT NULL) AS j${k}`);
  });
  const [row] = await tx.all<Record<string, unknown>>(`SELECT ${exprs.join(", ")} FROM ${tempRef(i.temp)}`);
  const rows = Number(row!.n);
  const columns: ColumnPlan[] = data.map((c, k) => {
    const have = table.find((t) => t.name.toLowerCase() === c.name.toLowerCase());
    let incoming: ValueKind[] = [];
    if (rows > 0) {
      if (Number(row![`c${k}`]) === 0) incoming = ["null"];
      else if (c.type === "JSON") incoming = [...new Set(((row![`j${k}`] as string[] | null) ?? []).map((t) => JSON_KINDS[t] ?? "string"))];
      else incoming = [kindOfType(c.type)];
    }
    return { column: c.name, sourceName: c.name, existing: have?.type ?? null, incoming, decision: have?.type === c.type ? "keep" : "add", target: c.type };
  });
  return { temp: i.temp, columns, rows, warnings: [] };
}

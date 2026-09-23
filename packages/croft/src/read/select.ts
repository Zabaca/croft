// One user SELECT on an open connection, for @zabaca/croft/read's direct and in-process paths.
// Rows use the §4.3 json rendering (db/values.ts), exactly what croft serve puts on the wire, so both
// modes return identical rows. It uses no Bun-only APIs: this file ships in the Node build.
import { blobValue, type DuckDBConnection, type DuckDBValue, listValue } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { Row } from "../types.ts";
import { mapSandboxError, type Profile } from "../db/connect.ts";
import { renderRows } from "../db/values.ts";
import { assertOneSelect } from "../sql/gate.ts";
import { type SelectRequest, stringifyLossless, tooManyRows } from "./wire.ts";

/** JS parameter → DuckDB value, as db/warehouse.ts binds them: plain objects as JSON text, Dates as ISO instants. */
export function toDuck(v: unknown): DuckDBValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return blobValue(v);
  if (Array.isArray(v)) return listValue(v.map(toDuck));
  if (typeof v === "object" && v.constructor !== Object) return v as DuckDBValue; // DuckDB value classes
  return stringifyLossless(v);
}

/** Map a DuckDB error from a user's query to a coded CroftError. */
export function mapQueryError(err: unknown, profile: Profile): unknown {
  if (err instanceof CroftError) return err;
  const mapped = mapSandboxError(err, profile);
  if (mapped !== err) return mapped;
  if (!(err instanceof Error)) return err;
  const first = err.message.split("\n")[0]!;
  const kind = first.match(/^([A-Za-z ]+?) Error: /)?.[1] ?? null;
  const details = { duckdb: first, duckdbErrorType: kind };
  const table = first.match(/Table with name (\S+?) does not exist/)?.[1];
  if (kind === "Catalog" && table) {
    return new CroftError("UNKNOWN_TABLE", { message: `no table named ${table}`, hint: "list the tables with: croft status", details });
  }
  const column = first.match(/Referenced column "?(.+?)"? not found/)?.[1];
  if (kind === "Binder" && column) {
    return new CroftError("UNKNOWN_COLUMN", { message: first.replace(/^Binder Error: /, ""), hint: "check the column name (croft describe <table> lists them)", details });
  }
  // Everything else is still a problem with the query text or its values (Binder, Conversion, Invalid
  // Input, Out of Range, ...). There is no dedicated code for query runtime errors yet; SQL_SYNTAX is the
  // closest "fix your SQL" code, and details.duckdbErrorType says what DuckDB reported.
  return new CroftError("SQL_SYNTAX", { message: first, hint: "fix the query; DuckDB's message says what went wrong", details });
}

/**
 * Gate, bind and run one SELECT, reading at most limit + 1 rows: more than `limit` is QUERY_TOO_MANY_ROWS,
 * never a truncated result. runAndReadUntil converts only the chunks it needs into JS, and a partly read
 * materialized result did not keep the file locked once the statement, connection and instance were closed.
 */
export async function runSelect(conn: DuckDBConnection, req: SelectRequest, o: { timezone: string; profile: Profile }): Promise<Row[]> {
  await assertOneSelect(conn, req.sql, { profile: o.profile });
  let stmt;
  try {
    stmt = await conn.prepare(req.sql);
  } catch (e) {
    throw mapQueryError(e, o.profile);
  }
  try {
    if (req.params.length) stmt.bind(req.params.map(toDuck));
    const reader = await stmt.runAndReadUntil(req.limit + 1);
    if (reader.currentRowCount > req.limit) throw tooManyRows(req.limit);
    const rows = renderRows(reader, { mode: "json", timezone: o.timezone });
    for (const r of rows) wireSafe(r);
    return rows;
  } catch (e) {
    throw mapQueryError(e, o.profile);
  } finally {
    stmt.destroySync();
  }
}

/**
 * Make an in-process value equal to what JSON.parse(JSON.stringify(value)) yields, so direct mode returns
 * exactly what server mode does: -0 becomes 0, and any bigint (json mode renders none) becomes its digits.
 * Everything else json mode renders already survives a JSON round trip unchanged. Rendered rows are fresh
 * objects, so they are fixed in place rather than copied.
 */
export function wireSafe(v: unknown): unknown {
  if (typeof v === "number") return Object.is(v, -0) ? 0 : v;
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const x = o[k];
      if (typeof x === "number" ? Object.is(x, -0) : typeof x === "bigint" || (x !== null && typeof x === "object")) o[k] = wireSafe(x);
    }
  }
  return v;
}

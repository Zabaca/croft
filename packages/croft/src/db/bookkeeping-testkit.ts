// Test support for the bookkeeping adapters (DESIGN.md §10 "Test strategy", D-L1). The whole suite runs twice: with the
// file adapter, and with the log adapter on a plain DuckDB file (CROFT_BOOKKEEPING=log, no Postgres and no lake).
// A test that seeds the bookkeeping with SQL of its own (INSERT INTO _croft.assets ...) writes it through seedState(),
// which runs the statement as it is for a file and turns it into the log's appends for a log, so the fixture says what
// it means in both. Test support, left out of the published package (package.json "files").
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Sql } from "../core/types.ts";
import { ASSET_TABLES, bookkeepingOf, defaultBookkeeping, fileDdl, logDdl, STATE_SPECS, type StateTableName } from "./bookkeeping.ts";

/** Whether this run of the suite uses the log adapter. */
export const LOG_ADAPTER = defaultBookkeeping() === "log";

/** The environment a test gives a croft it spawns, so the child follows the same adapter: the switch and the harness mark
 *  that lets it count (defaultBookkeeping()). Nothing when the run is on the file adapter. */
export function bookkeepingEnv(): Record<string, string> {
  return process.env.CROFT_BOOKKEEPING === "log" ? { CROFT_BOOKKEEPING: "log", CROFT_TEST_HARNESS: "1" } : {};
}

const isLogged = (t: string): t is (typeof ASSET_TABLES)[number] => (ASSET_TABLES as readonly string[]).includes(t);

/** The column names of a bookkeeping table, in order. */
export function columnNames(table: StateTableName): string[] {
  return STATE_SPECS[table].columns.split(",").map((c) => c.trim().split(/\s+/)[0]!).filter(Boolean);
}

/** Split `text` at the commas that are not inside parentheses, brackets, braces or quotes. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(from, i).trim()); from = i + 1; }
  }
  out.push(text.slice(from).trim());
  return out.filter(Boolean);
}

const INSERT = /^\s*INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+_croft\.(\w+)\s*(?:\(([^)]*)\))?\s*((?:VALUES|SELECT)[\s\S]*?)\s*;?\s*$/i;
const UPDATE = /^\s*UPDATE\s+_croft\.(\w+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\s+([\s\S]*?))?\s*;?\s*$/i;
const DELETE = /^\s*DELETE\s+FROM\s+_croft\.(\w+)(?:\s+WHERE\s+([\s\S]*?))?\s*;?\s*$/i;

/** Run one statement of a test's fixture against the bookkeeping. */
export async function seedState(sql: Sql, statement: string, params: unknown[] = []): Promise<void> {
  // The statement is translated only for a database whose bookkeeping is a log: a test that builds a file-shaped one
  // (an older format, say) inside a log run writes it as it is.
  if (!LOG_ADAPTER || (await bookkeepingOf(sql)).kind === "file") return sql.exec(statement, params);
  const ins = INSERT.exec(statement);
  if (ins && isLogged(ins[1]!)) {
    const table = ins[1]!;
    const names = ins[2] ? ins[2].split(",").map((c) => c.trim()) : columnNames(table);
    await sql.exec(
      `INSERT INTO _croft.${table}_log BY NAME SELECT v.*, (SELECT coalesce(max(seq), 0) FROM _croft.${table}_log) + row_number() OVER () AS seq, false AS closed
       FROM (${ins[3]}) AS v(${names.join(", ")})`, params);
    return;
  }
  const upd = UPDATE.exec(statement);
  if (upd && isLogged(upd[1]!)) {
    const set = Object.fromEntries(splitTop(upd[2]!).map((a) => {
      const at = a.indexOf("=");
      return [a.slice(0, at).trim(), a.slice(at + 1).trim()];
    }));
    await (await bookkeepingOf(sql)).update(upd[1] as StateTableName, set, upd[3] ?? "true", params);
    return;
  }
  const del = DELETE.exec(statement);
  if (del && isLogged(del[1]!)) {
    await (await bookkeepingOf(sql)).remove(del[1] as StateTableName, del[2] ?? "true", params);
    return;
  }
  return sql.exec(statement, params);
}

/** A bare Sql over one connection, for fixtures that seed a database file with a private DuckDB instance. */
export function sqlOver(conn: DuckDBConnection): Sql {
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await conn.runAndReadAll(sql, params as never)).getRowObjectsJS() as T[];
    },
    async exec(sql: string, params: unknown[] = []): Promise<void> {
      await conn.run(sql, params as never);
    },
  };
}

/** The statements that create croft's bookkeeping in a fixture database, for the configured adapter. */
export function stateDdl(): string[] {
  return LOG_ADAPTER ? ["CREATE SCHEMA IF NOT EXISTS _croft", ...logDdl().map((d) => d.ddl)] : ["CREATE SCHEMA IF NOT EXISTS _croft", ...fileDdl()];
}

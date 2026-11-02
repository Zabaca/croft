// The one-SELECT gate's shell (DESIGN.md §5 "Sandboxing every DuckDB instance", D112, D123). The decision is one
// synchronous function in sql/gate-core.ts, decide(), that every path to user SQL goes through (`croft query`, SQL assets,
// checks, TS transforms, croft serve for the app token and for keys, and Quack's authorization hook later). This file
// fetches what that function is given, from DuckDB, before it decides:
//
// - the statement count (extractStatements) and the parsed query (json_serialize_sql);
// - for the serve profile, the catalog snapshot (loadCatalog): which tables and views the connection can name;
// - for the profiles that read files, the path policy (loadPathPolicy) and the matches of every glob a query's paths hold
//   (`glob()`), so that decide() never has to ask DuckDB.
//
// A caller that runs many queries on one attached file (croft serve's workers) loads the catalog snapshot and the path
// policy once and passes them in; the file cannot change under them until it is swapped. Everyone else lets gateSelect()
// fetch them for the one query.
// It uses no Bun-only APIs, so read.ts can import it.
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import { mapSandboxError, type Profile } from "../db/connect.ts";
import {
  type CatalogRow, type CatalogSnapshot, catalogOf, decide, type GateOptions, type GateVerdict, type GlobExpansion, parseSerialized, PathPolicy,
  pathLiterals, type PathSettings, type SelectAst,
} from "./gate-core.ts";

/** What a caller may hand the gate so that it need not fetch it again: see the head of this file. */
export interface GateKnowns {
  catalog?: CatalogSnapshot;
  paths?: PathPolicy;
}

/**
 * Fetch what decide() needs and decide: throw unless `sql` is exactly one read-only SELECT (or DESCRIBE/SUMMARIZE/SHOW)
 * that reads only what its profile allows. Returns the statement's AST, the SQL to run and the tables it reads.
 * Codes: SQL_NOT_ONE_STATEMENT, QUERY_NOT_SELECT (or SQL_NOT_SELECT), SQL_SYNTAX, QUERY_PATH_DENIED.
 */
export async function gateSelect(conn: DuckDBConnection, sql: string, o: GateOptions & GateKnowns = {}): Promise<GateVerdict> {
  let count: number | "unparsable";
  try {
    count = (await conn.extractStatements(sql)).count;
  } catch {
    count = "unparsable";
  }
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)", [sql]);
  const parsed = String(reader.getRowsJS()[0]?.[0] ?? "{}");
  // Only a statement that parsed can name a table or a path; one that did not is refused by decide() without them.
  const s = parseSerialized(parsed);
  const stmt = !s.error && s.statements?.length === 1 ? s.statements[0]! : null;
  let catalog = o.catalog;
  let paths = o.paths;
  const globs = new Map<string, GlobExpansion>();
  if (stmt) {
    if (o.profile === "serve") catalog ??= await loadCatalog(conn);
    else {
      const raws = pathLiterals(stmt, o.profile);
      if (raws.length) {
        paths ??= await loadPathPolicy(conn, o);
        for (const raw of raws) if (!globs.has(raw) && paths.hasGlob(raw)) globs.set(raw, await expandGlob(conn, raw, o.profile));
      }
    }
  }
  return decide({ sql, count, parsed, options: o, ...(catalog ? { catalog } : {}), ...(paths ? { paths } : {}), globs });
}

/** gateSelect() for a caller that wants the statement's AST only. */
export async function assertOneSelect(conn: DuckDBConnection, sql: string, o: GateOptions & GateKnowns = {}): Promise<SelectAst> {
  return (await gateSelect(conn, sql, o)).ast;
}

/** The tables and views the connection can name (its default database's main schema), and the built-in names a CTE may
 *  not take. One query; take it once per attached file. */
export async function loadCatalog(conn: DuckDBConnection): Promise<CatalogSnapshot> {
  const reader = await conn.runAndReadAll(`
    SELECT current_database() AS current, table_name AS name, 'table' AS kind, database_name, schema_name, temporary, false AS internal
    FROM duckdb_tables()
    UNION ALL
    SELECT current_database(), view_name, 'view', database_name, schema_name, temporary, internal
    FROM duckdb_views()`);
  const rows = (reader.getRowObjectsJS() as unknown as (Omit<CatalogRow, "database" | "schema"> & { database_name: string; schema_name: string })[])
    .map(({ database_name, schema_name, ...r }): CatalogRow => ({ ...r, database: database_name, schema: schema_name }));
  const current = rows[0]?.current ?? String((await conn.runAndReadAll("SELECT current_database()")).getRowsJS()[0]?.[0] ?? "");
  return catalogOf(rows, current);
}

/** Where the connection lets a query read files, and which files it must never name: its sandbox settings and attached
 *  databases (and `o.protect`, such as the state folder), resolved. One query; take it once per instance. */
export async function loadPathPolicy(conn: DuckDBConnection, o: { protect?: string[] } = {}): Promise<PathPolicy> {
  const reader = await conn.runAndReadAll(`SELECT
    current_setting('enable_external_access') AS external,
    current_setting('allowed_directories') AS dirs,
    current_setting('allowed_paths') AS files,
    current_setting('temp_directory') AS temp,
    current_setting('home_directory') AS home,
    (SELECT list(path) FROM duckdb_databases() WHERE path IS NOT NULL AND path <> '') AS databases`);
  const s = reader.getRowObjectsJS()[0] as unknown as PathSettings;
  return PathPolicy.from(s, { protect: o.protect });
}

/** The files a glob in a query's path matches, through DuckDB's own glob(), or why it could not be expanded. */
async function expandGlob(conn: DuckDBConnection, raw: string, profile: Profile | undefined): Promise<GlobExpansion> {
  try {
    const reader = await conn.runAndReadAll("SELECT file FROM glob($1::VARCHAR)", [raw]);
    return { files: reader.getRowsJS().map((r) => String(r[0])) };
  } catch (e) {
    const mapped = mapSandboxError(e, profile ?? "warehouse");
    if (mapped instanceof CroftError) return { failed: { message: mapped.message, hint: mapped.problem.hint } };
    return { failed: { message: `cannot check the files ${raw} matches: ${(e as Error).message.split("\n")[0]}`, hint: "name the files without a pattern" } };
  }
}

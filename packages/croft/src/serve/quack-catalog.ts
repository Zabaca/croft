// The two catalog queries a DuckDB client sends to Quack when it attaches, and what croft runs instead (DESIGN.md D125, §5
// "Server mode"; option 06, slice 4). A DuckDB 2.0 client learns what a Quack server holds by sending these two texts,
// verbatim, as the first queries of ATTACH. Left alone they list every schema and every table of every database in the
// readers' process, croft's own `_croft` schema included, so croft's authorization hook recognises each by its exact bytes
// and swaps in a query that lists only the in-memory database's main schema and the views of the shared tables.
//
// Exact, not close: an earlier version of this allowance let through any text that mentioned a catalog function, and a key
// holder put a function's name in a comment and read hidden rows, deleted rows and stopped the server (the option's
// review). So a text is replaced only when it is one of these two, byte for byte; any other text, with a trailing space, a
// comment, or a second statement added, goes through the gate like every other query, which refuses the catalog functions.
//
// The texts belong to one build of the quack extension. A DuckDB upgrade that moves the pinned quack build changes them
// (`quack-catalog.test.ts` fails then, naming what to capture again), and until it is captured again an ATTACH fails
// closed: the client's catalog query is no longer recognised, the gate refuses it, and no one can attach.
import { READERS_VIEWS_DB } from "../db/modes.ts";

/** The quack build these texts were captured from: the extension's build field in its footer (db/extension-files.ts readFooter). */
export const QUACK_BUILD = "f96420ed46";

/** The first query of an ATTACH: the schemas of every database, as the quack build sends it (tabs, newlines and all). */
export const SCHEMA_QUERY =
  "\nWITH RECURSIVE schema_tree AS (\n\tSELECT oid, database_name, [schema_name] AS schema_path\n\tFROM duckdb_schemas()\n\tWHERE parent_schema_oid IS NULL\n\tUNION ALL\n\tSELECT nested.oid, nested.database_name, list_append(parent.schema_path, nested.schema_name)\n\tFROM duckdb_schemas() nested\n\tJOIN schema_tree parent ON nested.parent_schema_oid = parent.oid\n)\nSELECT oid, database_name, schema_path, current_database()\nFROM schema_tree\nWHERE database_name NOT IN ('system', 'temp')\nORDER BY (database_name = current_database()) DESC, database_name, length(schema_path), schema_path\n\t";

/** The second: every table and view, by schema. */
export const TABLES_QUERY =
  "\nSELECT schema_oid, sql, 'table'\nFROM duckdb_tables()\nUNION ALL\nSELECT schema_oid, view_name, 'view'\nFROM duckdb_views()\n\t";

/** The transaction control the client wraps its queries in. Exact texts, like the catalog queries. */
export const TRANSACTION_TEXTS: ReadonlySet<string> = new Set(["BEGIN TRANSACTION", "COMMIT", "ROLLBACK"]);

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * What runs in place of each catalog query, given the views a client may see (the shared tables' views and the as-of view,
 * by name). The columns are the original's, in order and type. Only the in-memory database's main schema is listed, so
 * `_croft` (which lives in the copy) never appears, and only views by those names, so nothing else made in the in-memory
 * database could. Every table is left out: the shared tables are views there.
 */
export function catalogReplacements(views: readonly string[]): ReadonlyMap<string, string> {
  const db = lit(READERS_VIEWS_DB);
  return new Map([
    [SCHEMA_QUERY, `SELECT oid, database_name, [schema_name] AS schema_path, current_database() FROM duckdb_schemas() WHERE database_name = ${db} AND schema_name = 'main'`],
    [TABLES_QUERY, `SELECT schema_oid, view_name, 'view' FROM duckdb_views() WHERE database_name = ${db} AND schema_name = 'main' AND NOT internal AND view_name IN (${views.map(lit).join(", ")})`],
  ]);
}

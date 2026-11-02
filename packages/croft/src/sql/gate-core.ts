// The one-SELECT gate's decision (DESIGN.md §5 "Sandboxing every DuckDB instance", D112, D123): one synchronous function,
// decide(), that every path to user SQL goes through: `croft query`, SQL assets, checks, TS transforms' ctx.query, croft
// serve's HTTP API for the app token and for a key, and, in slice 4, Quack's authorization hook, which must answer at once.
// Nothing here waits on DuckDB. The gate's inputs are what DuckDB produced before the decision, and the async shell
// (sql/gate.ts) fetches them:
//
// - the parsed query: json_serialize_sql's text, and the statement count from extractStatements (a hook that has only the
//   parsed query passes no count; json_serialize_sql serializes `select 1; select 2` as two statements, so the count is
//   still known, but extractStatements also counts a COPY or ATTACH that json_serialize_sql refuses);
// - the catalog snapshot, for the serve profile: the tables and views a caller may name and the built-in names a CTE may not
//   take. One snapshot per attached file, taken when the file is attached (a worker's file cannot change while it holds it,
//   and the readers' process takes a new one at every swap);
// - the path policy, for a query that names a path (never the serve profile's): the folders a path may name and the files it
//   may never name, already resolved. Globs are expanded before the decision (the only step that needs DuckDB, `glob()`), and
//   their matches are passed in; the serve profile allows no path, so it expands nothing.
//
// A statement is exactly one SELECT (or DESCRIBE, SUMMARIZE, SHOW), and every query node is a read. The gate then walks the
// statement's AST (verified on DuckDB 2.0.0):
// - DuckDB's sandbox always lets a connection read its own database file, even outside allowed_directories.
//   `read_blob('warehouse.duckdb')`, a symlink or hard link to it, or a replacement scan such as
//   `FROM 'files/up/warehouse.duckdb'` opens a second descriptor on the file, and closing it drops the
//   process's POSIX lock (§5, hazard 3). So every path a query names must be a string literal, and the gate
//   resolves it as the OS will (symlinks, `..` after a symlink, `~`, `file://`, globs) and refuses the open
//   database, its WAL and temp files (also by inode, which catches hard links), anything a caller protects,
//   and anything outside the connection's allowed_directories.
// - Table functions are an allowlist (TABLE_FUNCTIONS). Those with side effects (enable_logging changes the
//   whole instance even on a locked READ_ONLY connection; checkpoint writes) and those whose SQL or table
//   name is a string the walk cannot see (query, query_table, json_execute_serialized_sql) are refused, and
//   so is any table function or table macro not in the list.
// - croft serve is an allowlist too: user tables in the main schema, CTEs and a few harmless table
//   functions. DuckDB's built-in views need no parentheses (`FROM duckdb_databases`, `FROM pg_settings`), so
//   a denylist of function calls is not enough.
// - A key (GateOptions.shared) is the serve profile narrowed to the tables the project shares: any other table is refused
//   with the words for a table that does not exist, and SHOW TABLES lists the shared tables only (the decision's `sql`
//   is then a SELECT of those names, not the SHOW).
// Not covered: a macro or view created in the warehouse outside croft can shadow a built-in name; the gate
// trusts the warehouse's own catalog. Paths are checked just before DuckDB opens them, not atomically.
// It uses no Bun-only APIs, so read.ts can import it.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Profile } from "../db/connect.ts";
import { physicalPath } from "../project/root.ts";
import {
  args, asciiLower, type AstNode, charIndex, collect, constant, finiteJson, foreignQueryNode, literal, location, looksLikePath, positional, stringOf, TABLE_ARGUMENT_FUNCTIONS, tableArguments,
  type Use, walk,
} from "./ast.ts";
import { pivotWithoutValuesIn } from "./lex.ts";

export interface GateOptions {
  profile?: Profile;                                  // "serve" allows tables only
  notSelectCode?: "QUERY_NOT_SELECT" | "SQL_NOT_SELECT"; // SQL assets report SQL_NOT_SELECT (§3c)
  file?: string;                                      // for problem locations
  lineOffset?: number;                                // lines before the SQL in `file` (asset headers)
  /** Files and folders user SQL must never read, beyond the connection's own database files; e.g. the
   *  state folder (runs.sqlite, serve.json) on a warehouse connection, which allows it for croft itself. */
  protect?: string[];
  /** A key's query: the tables the project shares (serve.sharedTables). With the serve profile, any other table is refused
   *  as if it did not exist. An empty list shares nothing: every table is refused. */
  shared?: readonly string[];
}

/** The parsed statement, as json_serialize_sql returns it (the `statements[0]` object). */
export type SelectAst = { node: Record<string, unknown>; named_param_map?: unknown } & Record<string, unknown>;

/** What the gate does with a table function or table macro. */
export type TableFunctionKind =
  | "serve"       // harmless everywhere, croft serve included
  | "local"       // catalog, settings and introspection: fine for croft query, not over HTTP
  | "path"        // reads the files its first argument names (a path, a glob or a list of them)
  | "table"       // its first argument names a table, or a file through a replacement scan
  | "hidden-sql"  // runs SQL or names a table given as a string, which the AST walk cannot see
  | "effect";     // changes the instance, the database or the process (or takes raw pointers)

const kinds = (kind: TableFunctionKind, names: string) => names.trim().split(/\s+/).map((n) => [n, kind] as const);

/**
 * Every table function and table macro of DuckDB 2.0.0, classified. gate.test.ts fails when DuckDB ships
 * one that is not listed here (until it is classified, the gate refuses it), and when one listed here is no
 * longer shipped.
 */
export const TABLE_FUNCTIONS: ReadonlyMap<string, TableFunctionKind> = new Map([
  ...kinds("serve", "range generate_series unnest json_each json_tree"),
  ...kinds("local", `
    duckdb_approx_database_count duckdb_columns duckdb_connection_count duckdb_constraints
    duckdb_coordinate_systems duckdb_databases duckdb_dependencies duckdb_extensions duckdb_external_file_cache
    duckdb_functions duckdb_indexes duckdb_keywords duckdb_log_contexts duckdb_logs duckdb_logs_parsed
    duckdb_memory duckdb_optimizers duckdb_prepared_statements duckdb_profiling_settings duckdb_schemas
    duckdb_secret_types duckdb_secrets duckdb_sequences duckdb_settings duckdb_table_sample duckdb_tables
    duckdb_temporary_files duckdb_types duckdb_variables duckdb_views which_secret
    duckdb_available_metrics duckdb_dialects duckdb_eviction_queues duckdb_extension_repositories
    duckdb_external_resource_types duckdb_external_resources duckdb_grammar_extensions
    duckdb_secret_type_parameters duckdb_triggers sql_tokenize
    pragma_collations pragma_database_size pragma_metadata_info pragma_platform pragma_show
    pragma_storage_info pragma_table_info pragma_user_agent pragma_version
    pg_timezone_names icu_calendar_names sql_auto_complete check_peg_parser
    repeat repeat_row summary seq_scan test_all_types test_vector_types`),
  ...kinds("path", `
    read_csv read_csv_auto read_json read_json_auto read_json_objects read_json_objects_auto read_ndjson
    read_ndjson_auto read_ndjson_objects read_parquet parquet_scan read_text read_blob read_duckdb glob
    sniff_csv parquet_metadata parquet_schema parquet_file_metadata parquet_kv_metadata parquet_full_metadata
    parquet_bloom_probe read_single_csv_file read_single_json_file read_single_parquet_file`),
  ...kinds("table", [...TABLE_ARGUMENT_FUNCTIONS].join(" ")),
  ...kinds("hidden-sql", "query query_table json_execute_serialized_sql"),
  ...kinds("effect", `
    checkpoint force_checkpoint enable_logging disable_logging truncate_duckdb_logs enable_profiling
    disable_profiling arrow_scan arrow_scan_dumb create_external_resource deregister_external_resource
    destroy_external_resource register_external_resource register_external_resource_type`),
]);

// Scalar functions: write_log writes into the instance's log, setval moves a sequence; over HTTP, settings and
// variables reveal paths, and sleep_ms only holds a worker.
const SCALAR_DENIED = new Set(["write_log", "setval"]);
// getenv is not a function of DuckDB 2.0.0 (the engine says so), but it reads the server's environment where a build has it
// (the first Quack spike's attack list names it), so it is refused by name before it can ever be bound.
const SERVE_SCALAR_DENIED = new Set(["current_setting", "getvariable", "getenv", "sleep_ms"]);
// SHOW forms that are not DESCRIBE: they list names, never paths. `__show_from` is SHOW TABLES FROM <schema or database>
// (ast.ts collect()), which lists another schema's tables.
const SHOW_LISTS = new Set(["tables", "databases", "variables", "__show_tables_expanded", "__show_from"]);
// Over HTTP only SHOW TABLES, which lists the main schema's names. SHOW ALL TABLES (also a bare DESCRIBE or SHOW,
// which DuckDB parses as __show_tables_expanded) lists every schema's tables with their columns, _croft's
// included, SHOW TABLES FROM <schema> lists that schema's tables, and SHOW databases/schemas/variables name catalogs
// and settings the serve gate refuses to read.
const SERVE_SHOW_LISTS = new Set(["tables"]);
const SHOW_NAMES: Record<string, string> = {
  __show_tables_expanded: "SHOW ALL TABLES (or a bare DESCRIBE or SHOW)",
  __show_from: "SHOW TABLES FROM <schema or database>",
};

/**
 * The longest list range() or generate_series() may build as a value (not as a table) over HTTP. A scalar builds
 * its whole list inside one expression, which DuckDB evaluates (and constant-folds while planning) without
 * checking for interrupts: `list_sort(range(150000000))` ran 25 s past every interrupt. The serve engine's
 * watchdog (serve/instance.ts) ends such a query by killing its worker process; this cap only refuses the
 * literal cases up front. As a table (`FROM range(n)`) range() streams and stops at the next interrupt.
 */
export const SERVE_MAX_LIST_VALUES = 10_000_000;
const LIST_BUILDERS = new Set(["range", "generate_series"]);

/** 1-based line and column (in code points) of a DuckDB position, which counts UTF-8 bytes on 2.0 (verified with
 *  emoji and CJK). */
export function lineColumn(sql: string, position: number): { line: number; column: number } {
  const before = sql.slice(0, charIndex(sql, position));
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: Array.from(before.slice(lineStart)).length + 1 };
}

// ---- Inputs -----------------------------------------------------------------------------------------------

/** json_serialize_sql's output. */
export interface Serialized {
  error: boolean;
  error_type?: string;
  error_message?: string;
  position?: string;
  statements?: SelectAst[];
}

/** json_serialize_sql's text as an object. A DOUBLE constant beyond range came back from DuckDB 1.5.5 as a bare Infinity
 *  (`SELECT 1e400`), which JSON.parse refuses. */
export function parseSerialized(text: string): Serialized {
  return JSON.parse(finiteJson(text || "{}")) as Serialized;
}

/**
 * The tables and views a query may name, as the connection that runs it sees them. `current` is its default database;
 * `userTables` and `views` are the names (ASCII-lowercased) in that database's main schema (temporary objects left out);
 * `others` are the names of built-in or foreign objects reachable unqualified, which a CTE may not take; `builtin` is the part
 * of them that DuckDB itself provides (the system catalog's views, which everyone sees).
 */
export interface CatalogSnapshot {
  current: string;
  userTables: ReadonlySet<string>;
  views: ReadonlySet<string>;
  others: ReadonlySet<string>;
  builtin: ReadonlySet<string>;
}

/** One row of duckdb_tables() or duckdb_views(), as loadCatalog (sql/gate.ts) reads it. */
export interface CatalogRow {
  /** current_database() on the reading connection. */
  current: string;
  name: string;
  kind: "table" | "view";
  database: string;
  schema: string;
  temporary: boolean;
  /** Views only: DuckDB's own. */
  internal: boolean;
}

/** The snapshot of rows read on one connection. */
export function catalogOf(rows: readonly CatalogRow[], current: string): CatalogSnapshot {
  const userTables = new Set<string>();
  const views = new Set<string>();
  const others = new Set<string>();
  const builtin = new Set<string>();
  for (const r of rows) {
    const name = asciiLower(r.name);
    if ((r.database === "system" || r.database === "temp") && (r.schema === "main" || r.schema === "pg_catalog")) builtin.add(name);
    const mine = r.schema === "main" && r.database === r.current && !r.temporary;
    if (r.kind === "table" && mine) userTables.add(name);
    else if (r.kind === "view" && mine && !r.internal) views.add(name);
    if (r.kind === "table" && mine) continue;
    if (r.schema === "main" || r.schema === "pg_catalog") others.add(name); // reachable unqualified
  }
  return { current: asciiLower(current), userTables, views, others, builtin };
}

/**
 * What a key may name: the shared tables the catalog has, as tables or as views. A key's connection in the readers'
 * process (D123) has croft's own views of the shared tables as its default database; in a warehouse, the shared names are
 * tables. A name that is shared but absent is not here, so it is refused like any other.
 *
 * The names a CTE may not take are DuckDB's own built-in ones, which everyone sees, and no others. A table hidden from the key
 * must not be told apart from one that does not exist, and a CTE named after it is the one place a name could be: refusing
 * `WITH payments AS (SELECT 1) SELECT * FROM payments` because payments exists, and allowing it for a name that does not,
 * lets a key list the project's table names one guess at a time (the reviewer's finding on D122). So a CTE's name is judged
 * the same whether or not a hidden table has it. What keeps such a CTE from reaching the hidden table is the walk's reading of
 * CTE scopes, which ast.test.ts holds to DuckDB's own plans; and in server mode a key's connection works in a database where
 * a hidden table has no name at all.
 */
export function restrictCatalog(c: CatalogSnapshot, shared: readonly string[]): CatalogSnapshot {
  const want = new Set(shared.map(asciiLower));
  const visible = new Set<string>();
  for (const n of [...c.userTables, ...c.views]) if (want.has(n)) visible.add(n);
  return { ...c, userTables: visible, views: new Set(), others: c.builtin };
}

/** The result of expanding a glob in a path (`glob()`), or why it could not be. */
export type GlobExpansion = { files: readonly string[] } | { failed: { message: string; hint: string } };

export interface GateInputs {
  sql: string;
  /** extractStatements' count; "unparsable" when it threw (a syntax error, or nothing but comments); undefined when the
   *  caller has no separate count, and the parsed query's own is used. */
  count?: number | "unparsable";
  /** json_serialize_sql(sql) as text. */
  parsed: string;
  options: GateOptions;
  /** Required by the serve profile. */
  catalog?: CatalogSnapshot;
  /** Required when the query names a path (every profile but serve). */
  paths?: PathPolicy;
  /** The matches of every glob the query's paths hold, by the path as written (pathLiterals). */
  globs?: ReadonlyMap<string, GlobExpansion>;
}

/** What the gate lets through: the statement's AST, the SQL to run (the query as written, except a key's SHOW TABLES), and
 *  the shared tables the query reads (a key's or the serve profile's), ASCII-lowercased in the order first read. */
export interface GateVerdict {
  ast: SelectAst;
  sql: string;
  tables: string[];
}

function syntaxError(sql: string, s: Serialized, o: GateOptions): CroftError {
  const pos = s.position !== undefined ? Number(s.position) : NaN;
  const at = Number.isFinite(pos) ? lineColumn(sql, pos) : undefined;
  return new CroftError("SQL_SYNTAX", {
    message: at ? `${s.error_message} (line ${at.line}, column ${at.column})` : String(s.error_message),
    hint: "fix the SQL near the reported position",
    file: o.file,
    line: at ? at.line + (o.lineOffset ?? 0) : undefined,
    column: at?.column,
  });
}

/**
 * Throw unless the query is exactly one read-only SELECT (or DESCRIBE/SUMMARIZE/SHOW) that reads only what its
 * profile allows. Returns the statement's AST, the SQL to run and the tables it reads. Synchronous: every input is given.
 * Codes: SQL_NOT_ONE_STATEMENT, QUERY_NOT_SELECT (or SQL_NOT_SELECT), SQL_SYNTAX, QUERY_PATH_DENIED.
 */
export function decide(i: GateInputs): GateVerdict {
  const { sql, options: o } = i;
  const s = parseSerialized(i.parsed);
  let count: number;
  if (i.count === "unparsable") {
    // Parse errors and empty input both land here; json_serialize_sql tells them apart and gives a position.
    if (s.error && s.error_type === "parser") throw syntaxError(sql, s, o);
    count = s.statements?.length ?? 0;
    if (count === 1) {
      throw new CroftError("INTERNAL_ERROR", { message: "extractStatements failed on a statement json_serialize_sql accepted", hint: "report this croft bug" });
    }
  } else {
    count = i.count ?? s.statements?.length ?? 0;
  }
  if (count !== 1) {
    throw new CroftError("SQL_NOT_ONE_STATEMENT", {
      message: count === 0 ? "found no SQL statement" : `found ${count} statements; croft runs exactly one SELECT`,
      hint: count === 0 ? "write a SELECT" : "run one SELECT at a time; combine queries with a CTE (WITH ...) or UNION",
      file: o.file,
    });
  }
  if (s.error) {
    if (s.error_type === "parser") throw syntaxError(sql, s, o);
    const code = o.notSelectCode ?? "QUERY_NOT_SELECT";
    // DuckDB 2.0 cannot serialize a PIVOT whose columns depend on the data (no IN list): name the fix.
    const pivot = pivotWithoutValuesIn(sql);
    if (pivot) {
      throw new CroftError(code, {
        message: `PIVOT ... ON ${pivot.column} lists no values, so its columns depend on the data; croft runs SELECTs whose columns it can know`,
        hint: `list the values: ON ${pivot.column} IN ('pro', 'basic'), or use sum(x) FILTER (WHERE ${pivot.column} = 'pro')`,
        file: o.file,
        details: { duckdb: s.error_message, column: pivot.column },
      });
    }
    throw new CroftError(code, {
      message: code === "QUERY_NOT_SELECT"
        ? "query runs exactly one SELECT (DESCRIBE, SUMMARIZE and SHOW also work)"
        : "an SQL asset is exactly one SELECT (CTEs allowed)",
      hint: code === "QUERY_NOT_SELECT"
        ? "to export, put the SELECT in an asset or pipe --json output; exports are post-v1"
        : "remove statements other than the SELECT; croft creates and writes the table itself",
      file: o.file,
      details: { duckdb: s.error_message },
    });
  }
  const stmt = s.statements?.[0];
  if (!stmt || s.statements!.length !== 1) {
    throw new CroftError("SQL_NOT_ONE_STATEMENT", { message: `found ${s.statements?.length ?? 0} statements`, hint: "run one SELECT at a time", file: o.file });
  }
  const checker = new Checker(sql, o, i);
  checker.check(stmt);
  return { ast: stmt, sql: checker.rewrite ?? sql, tables: [...checker.read] };
}

// ---- AST helpers (the walk is sql/ast.ts) -----------------------------------------------------------------

type Node = AstNode;
const lower = asciiLower;
const str = stringOf;

/** 'a' or ['a', 'b'] → the strings; anything computed → null. */
function literalPaths(n: Node | undefined): string[] | null {
  const one = literal(n);
  if (one !== null) return [one];
  if (n?.class === "FUNCTION" && lower(str(n.function_name)) === "list_value") {
    const all = args(n).map((a) => (a.name ? null : literal(a.expression)));
    return all.length && all.every((p): p is string => p !== null) ? all : null;
  }
  return null;
}

/**
 * Every path the statement names as a string literal, as the gate will check it: the first argument of a file-reading
 * table function (a path, a list of paths, a glob), and a table name that is a file (`FROM 'files/x.csv'`, a table macro's
 * file). A path that is not a literal is left out; the decision refuses it. The serve profile reads no files, so it has none
 * to find. The shell expands the globs among them before it decides.
 */
export function pathLiterals(stmt: SelectAst, profile?: Profile): string[] {
  if (profile === "serve") return [];
  const out: string[] = [];
  for (const u of collect(stmt).uses) {
    if (u.kind === "table_function" && TABLE_FUNCTIONS.get(lower(u.name)) === "path") out.push(...(literalPaths(positional(u.fn)[0]) ?? []));
    else if (u.kind === "relation" && looksLikePath(u.name)) out.push(u.name);
  }
  return out;
}

const NUMERIC_TYPES = new Set(["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
  "FLOAT", "DOUBLE", "DECIMAL", "INT", "INT1", "INT2", "INT4", "INT8", "INT16", "INT32", "INT64", "INT128", "LONG", "SHORT", "SIGNED", "REAL",
  "FLOAT4", "FLOAT8", "NUMERIC", "UINT8", "UINT16", "UINT32", "UINT64", "UINT128", "BYTEINT", "UBYTEINT"]);

/** A numeric literal's value (through casts to numeric types and a unary minus); null when `n` is computed
 *  (a column, a function, a string), "unknown" when it is a constant of a shape croft does not know, so the
 *  caller can refuse rather than guess. */
function numericLiteral(n: Node | undefined): number | null | "unknown" {
  if (!n) return null;
  if (n.class === "CAST") {
    const to = str((n.type_expr as { type_name?: unknown } | undefined)?.type_name);
    if (!to) return "unknown";
    return NUMERIC_TYPES.has(to.toUpperCase()) ? numericLiteral(n.child as Node | undefined) : null;
  }
  if (n.class === "FUNCTION" && (str(n.function_name) === "-" || str(n.function_name) === "+")) {
    const a = args(n);
    if (a.length !== 1) return null;
    const v = numericLiteral(a[0]!.expression);
    return typeof v === "number" && str(n.function_name) === "-" ? -v : v;
  }
  if (n.class !== "CONSTANT") return null;
  const c = constant(n);
  if (!c) return "unknown";
  if (c.kind === "STRING" || c.kind === "BOOLEAN" || c.kind === "NULL_LITERAL") return null;
  if (c.kind !== "INTEGER" && c.kind !== "NUMERIC") return "unknown";
  const x = Number(c.text.replace(/_/g, ""));
  // 1e400 is Infinity: no list of that length fits, which listSize treats as such.
  return Number.isNaN(x) ? "unknown" : x;
}

/** How many values range()/generate_series() with these arguments build; null unless every bound is a literal,
 *  "unknown" when a bound is a constant croft cannot read. */
function listSize(name: string, list: Node[]): number | null | "unknown" {
  const n = list.map(numericLiteral);
  if (n.includes("unknown")) return "unknown";
  if (n.length === 0 || n.length > 3 || n.some((x) => x === null)) return null;
  const [start, stop, step] = (n.length === 1 ? [0, n[0], 1] : [n[0], n[1], n.length === 3 ? n[2] : 1]) as number[];
  if (step === 0) return null; // DuckDB refuses it
  const span = (stop! - start!) / step!;
  if (!Number.isFinite(span)) return span > 0 ? Infinity : 0;
  const size = name === "generate_series" ? Math.floor(span) + 1 : Math.ceil(span);
  return Math.max(0, size);
}

/** Whether the statement is `SHOW TABLES` and nothing more: a select of everything from that one SHOW, with no clause,
 *  modifier or CTE around it. */
function bareShowTables(stmt: SelectAst): boolean {
  const node = stmt.node as { type?: unknown; from_table?: AstNode; where_clause?: unknown; modifiers?: unknown[]; select_list?: AstNode[]; cte_map?: { map?: unknown[] };
    group_expressions?: unknown[]; group_sets?: unknown[]; having?: unknown; qualify?: unknown; sample?: unknown };
  const from = node.from_table;
  return node.type === "SELECT_NODE" && from?.type === "SHOW_REF" && from.show_type === "SHOW_SPECIAL" && from.query == null
    && node.select_list?.length === 1 && node.select_list[0]!.class === "STAR" && !node.where_clause && !node.having && !node.qualify && !node.sample
    && !(node.modifiers?.length) && !(node.cte_map?.map?.length) && !(node.group_expressions?.length) && !(node.group_sets?.length);
}

/** A key's SHOW TABLES: the shared tables there are, as the column `name` SHOW TABLES returns. */
function showTablesSql(names: readonly string[]): string {
  const sorted = [...names].sort();
  if (!sorted.length) return "SELECT CAST(NULL AS VARCHAR) AS name WHERE false";
  return `SELECT name FROM (VALUES ${sorted.map((n) => `('${n.replaceAll("'", "''")}')`).join(", ")}) AS t(name) ORDER BY name`;
}

// ---- The checks -------------------------------------------------------------------------------------------

class Checker {
  private readonly serve: boolean;
  private readonly key: boolean;
  private readonly catalogSnapshot: CatalogSnapshot | undefined;
  private sawShowTables = false;
  /** The tables read, in order. */
  readonly read = new Set<string>();
  /** The SQL to run instead of the query as written. */
  rewrite: string | undefined;

  constructor(private readonly sql: string, private readonly o: GateOptions, private readonly i: GateInputs) {
    this.serve = o.profile === "serve";
    this.key = this.serve && o.shared !== undefined;
    this.catalogSnapshot = i.catalog && this.key ? restrictCatalog(i.catalog, o.shared!) : i.catalog;
  }

  check(stmt: SelectAst): void {
    const foreign = foreignQueryNode(stmt);
    if (foreign) {
      throw this.notSelect(`the query holds a ${foreign.type.replace(/_QUERY_NODE$|_NODE$/, "").replace(/_/g, " ")} statement; croft runs read-only SELECTs`,
        "a CTE that writes or exports (INSERT, UPDATE, DELETE or COPY inside WITH) is not a read; keep the SELECT, and let croft write tables", foreign.at);
    }
    for (const u of collect(stmt).uses) {
      if (u.kind === "scalar") this.scalar(u.name, u.at);
      else if (u.kind === "table_function") this.tableFunction(u.name, u.fn, u.at);
      else if (u.kind === "relation") this.relation(u);
      else if (this.serve) this.show(u.name);
    }
    if (this.serve) this.lists(stmt);
    if (this.key && this.sawShowTables) {
      if (!bareShowTables(stmt)) {
        throw this.serveDenied("SHOW TABLES inside a larger query", undefined, "is not available to a key; run SHOW TABLES on its own",
          "SHOW TABLES on its own lists the tables shared with this key");
      }
      this.rewrite = showTablesSql([...this.catalog().userTables]);
    }
  }

  /** SHOW forms over HTTP: SHOW TABLES only (the main schema's names). */
  private show(name: string): void {
    const n = lower(name);
    if (SERVE_SHOW_LISTS.has(n)) {
      this.sawShowTables = true;
      return;
    }
    const shown = SHOW_NAMES[n] ?? `SHOW ${name}`;
    throw this.serveDenied(shown, undefined,
      SHOW_LISTS.has(n) ? "lists schemas, catalogs or settings beyond the project's tables; the read server shows those only" : "is not available",
      "SHOW TABLES lists the project's tables, and DESCRIBE <table> the columns of one");
  }

  /** range() and generate_series() used as values with literal bounds past SERVE_MAX_LIST_VALUES. */
  private lists(stmt: SelectAst): void {
    // A table function's own node sits under its TABLE_FUNCTION's `function` key; every other call is a scalar.
    const tables = new Set<Node>();
    walk(stmt, (n) => {
      if (n.type === "TABLE_FUNCTION" && n.function && typeof n.function === "object") tables.add(n.function as Node);
    });
    walk(stmt, (n) => {
      if (typeof n.function_name !== "string" || tables.has(n) || !LIST_BUILDERS.has(lower(n.function_name))) return;
      const size = listSize(lower(n.function_name), positional(n));
      if (size === null || (size !== "unknown" && size <= SERVE_MAX_LIST_VALUES)) return;
      const values = size === "unknown" ? "values croft cannot count" : Number.isFinite(size) ? `${size.toLocaleString("en-US")} values` : "more values than memory holds";
      const cap = SERVE_MAX_LIST_VALUES.toLocaleString("en-US");
      throw this.serveDenied(`${n.function_name}() as a value`, location(n),
        `builds a list of ${values} in one expression, which DuckDB cannot interrupt; over HTTP such a list may hold at most ${cap} values`,
        `use it as a table instead (SELECT ... FROM range(n)), which the query deadline can stop, or keep the list under ${cap} values`);
    });
  }

  private scalar(name: string, at?: number): void {
    const n = lower(name);
    if (this.serve && (SCALAR_DENIED.has(n) || SERVE_SCALAR_DENIED.has(n))) throw this.serveDenied(`${name}()`, at);
    if (n === "setval") throw this.notSelect(`${name}() changes a sequence; croft runs read-only SELECTs`, "remove it", at);
    if (SCALAR_DENIED.has(n)) {
      throw this.notSelect(`${name}() writes to DuckDB's log; croft runs read-only SELECTs`, "remove it; croft keeps its own logs", at);
    }
  }

  private tableFunction(name: string, fn: Node, at?: number): void {
    const kind = TABLE_FUNCTIONS.get(lower(name));
    if (this.serve) {
      if (kind === "serve") return;
      throw this.serveDenied(`${name}()`, at);
    }
    switch (kind) {
      case "serve":
      case "local":
        return;
      case "path": {
        const args = positional(fn);
        const paths = literalPaths(args[0]);
        if (!paths) throw this.notLiteral(`${name}()`, location(args[0] ?? fn) ?? at);
        const policy = this.pathPolicy();
        for (const p of paths) policy.check(p, (why, hint) => this.pathDenied(why, hint, location(args[0]!) ?? at), this.i.globs?.get(p));
        return;
      }
      case "table":
        // Its table, or file, comes next as a relation of its own (collect()), checked like any other.
        if (!tableArguments(fn)) throw this.notLiteral(`${name}()`, location(positional(fn)[0] ?? fn) ?? at);
        return;
      case "hidden-sql":
        throw this.notSelect(`${name}() runs SQL or reads a table named in a string, which croft cannot check`,
          "write the SELECT, or name the table, directly in the query", at);
      case "effect":
        throw this.notSelect(`${name}() changes DuckDB's state (logging, profiling, external resources or a checkpoint); croft runs read-only SELECTs`,
          "remove it; croft manages checkpoints, logging and profiling itself", at);
      case undefined:
        throw this.notSelect(`${name}() is not a table function croft allows; croft cannot tell what it reads or changes`,
          "query tables, read files under files/ with read_csv, read_parquet or read_json, or use range() and unnest()", at);
    }
  }

  private relation(u: Extract<Use, { kind: "relation" }>): void {
    const shown = [u.catalog, u.schema, u.name].filter(Boolean).join(".");
    if (looksLikePath(u.name)) {
      // `FROM 'files/x.csv'`: DuckDB reads the file through a replacement scan (or attaches a .duckdb file).
      if (this.serve) throw this.serveDenied(shown, u.at, "is a file; the read server reads the project's tables only");
      this.pathPolicy().check(u.name, (why, hint) => this.pathDenied(why, hint, u.at), this.i.globs?.get(u.name));
      return;
    }
    if (!this.serve) return;
    const cat = this.catalog();
    const name = lower(u.name);
    const plain = u.catalog === "" && u.schema === "";
    const inMain = (u.catalog === "" || lower(u.catalog) === cat.current) && (u.schema === "" || lower(u.schema) === "main");
    if (inMain && cat.userTables.has(name)) {
      this.read.add(name);
      return;
    }
    // A CTE in scope here (collect() scopes them as DuckDB does). A CTE may still not share a name with a
    // built-in view: were the two ever to disagree about a scope, the name would reach the view.
    if (plain && u.cte && !cat.others.has(name)) return;
    if (this.key) {
      const may = [...cat.userTables].sort();
      throw this.serveDenied(shown, u.at, "is not one of the tables shared with this key; a key reads those only",
        may.length ? `this key may read: ${may.join(", ")} (SHOW TABLES lists them)` : "the project shares no table with keys that exist yet (serve.sharedTables in croft.json)");
    }
    throw this.serveDenied(shown, u.at, "is not one of the project's tables; the read server reads those only");
  }

  private pathPolicy(): PathPolicy {
    if (!this.i.paths) {
      throw new CroftError("INTERNAL_ERROR", { message: "the gate was given no path policy for a query that names a file", hint: "report this croft bug" });
    }
    return this.i.paths;
  }

  private catalog(): CatalogSnapshot {
    if (!this.catalogSnapshot) {
      throw new CroftError("INTERNAL_ERROR", { message: "the serve gate was given no catalog snapshot", hint: "report this croft bug" });
    }
    return this.catalogSnapshot;
  }

  private where(at?: number): { line?: number; column?: number; file?: string } {
    const pos = at !== undefined ? lineColumn(this.sql, at) : undefined;
    return { file: this.o.file, line: pos ? pos.line + (this.o.lineOffset ?? 0) : undefined, column: pos?.column };
  }

  private serveDenied(what: string, at?: number, why = "is not available over HTTP; the read server reads the project's tables only",
    hint = "query the project's tables by name; files come in through file ingests"): CroftError {
    return new CroftError("QUERY_PATH_DENIED", { message: `${what} ${why}`, hint, ...this.where(at) });
  }

  private notSelect(message: string, hint: string, at?: number): CroftError {
    return new CroftError(this.o.notSelectCode ?? "QUERY_NOT_SELECT", { message, hint, ...this.where(at) });
  }

  private notLiteral(what: string, at?: number): CroftError {
    return new CroftError("QUERY_PATH_DENIED", {
      message: `${what} needs its path as a string literal; croft checks every path before DuckDB opens it`,
      hint: "write the path as a quoted string, e.g. read_csv('files/orders.csv')",
      ...this.where(at),
    });
  }

  private pathDenied(message: string, hint: string, at?: number): CroftError {
    return new CroftError("QUERY_PATH_DENIED", { message, hint, ...this.where(at) });
  }
}

// ---- Paths ------------------------------------------------------------------------------------------------

type Deny = (message: string, hint: string) => CroftError;

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

// stat never opens the file, so it cannot release the process's lock (§5); realpath can (see physicalPath).
const inode = (p: string): string | null => {
  try {
    const st = statSync(p);
    return st.isFile() ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
};

/** The connection's settings that decide which files a path may name (sql/gate.ts loadPathPolicy reads them). */
export interface PathSettings {
  external: boolean;
  dirs: string[] | null;
  files: string[] | null;
  temp: string | null;
  home: string | null;
  /** The paths of the attached databases. */
  databases: string[] | null;
}

/**
 * Where a query may read files on one connection, and what it must never touch: resolved from the connection's settings
 * and attached databases, then consulted without DuckDB. The file system is read (stat, readlink) when a path is checked, just before DuckDB opens it.
 */
export class PathPolicy {
  private constructor(
    private readonly home: string,
    private readonly allowed: string[] | null,       // canonical folders and files; null = no sandbox
    private readonly protectedPaths: string[],       // canonical, lower-cased: equal or inside is refused
    private readonly protectedInodes: Set<string>,   // dev:ino of protected files (catches hard links)
  ) {}

  static from(s: PathSettings, o: { protect?: string[] } = {}): PathPolicy {
    const home = s.home || process.env.HOME || homedir();
    const canon = (p: string) => physicalPath(p).path;
    // DuckDB always lets a connection reach its own file, WAL and spill folder; croft's user SQL never may.
    const protect = [...(s.databases ?? []).flatMap((d) => [d, `${d}.wal`, `${d}.tmp`]), ...(s.temp ? [s.temp] : []), ...(o.protect ?? [])];
    const protectedInodes = new Set<string>();
    for (const p of protect) {
      const id = inode(p);
      if (id) protectedInodes.add(id);
    }
    const allowed = s.external ? null : [...(s.dirs ?? []), ...(s.files ?? [])].map(canon);
    return new PathPolicy(home, allowed, protect.map((p) => lower(canon(p))), protectedInodes);
  }

  /** A policy that lets a query read no file at all (checks, the readers' profile): every path is refused, and nothing is
   *  protected by name because nothing is allowed. */
  static none(): PathPolicy {
    return new PathPolicy(process.env.HOME || homedir(), [], [], new Set());
  }

  /** Whether `raw` holds a glob, and so needs expanding before the decision. Not for a URL or any other scheme. */
  hasGlob(raw: string): boolean {
    const local = this.localPath(raw);
    return local !== null && /[*?[]/.test(local);
  }

  /** Throw (via `deny`) unless DuckDB may read `raw`, as a query wrote it. A glob is checked through its matches. */
  check(raw: string, deny: Deny, expansion?: GlobExpansion): void {
    const local = this.localPath(raw);
    if (local === null) throw deny(`cannot read ${raw}: croft reads local files only`, "fetch URLs in a TS ingest with ctx.http, then query the table");
    if (!/[*?[]/.test(local)) return this.checkOne(raw, local, deny);
    if (!expansion) throw deny(`cannot check the files ${raw} matches: the pattern was not expanded`, "name the files without a pattern");
    if ("failed" in expansion) throw deny(expansion.failed.message, expansion.failed.hint);
    for (const m of expansion.files) {
      const p = this.localPath(m);
      if (p === null) throw deny(`cannot read ${m} (matched by ${raw}): croft reads local files only`, "narrow the pattern");
      this.checkOne(m === raw ? raw : `${m} (matched by ${raw})`, p, deny);
    }
  }

  /** DuckDB's own prefixes: file:///x, file://localhost/x and file:/x are /x; ~ is the home folder. Any
   *  other scheme (https://, s3://, ...) is not a local file: null. */
  private localPath(raw: string): string | null {
    let p = raw;
    if (p.startsWith("file://localhost/")) p = p.slice("file://localhost".length);
    else if (p.startsWith("file:///")) p = p.slice("file://".length);
    else if (/^file:\/(?!\/)/.test(p)) p = p.slice("file:".length);
    else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) return null;
    if (p.startsWith("~")) p = this.home + p.slice(1);
    return p;
  }

  private checkOne(shown: string, path: string, deny: Deny): void {
    // No lexical normalization: `files/up/../x` must go through the symlink `up` first, as open(2) does.
    const abs = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
    let resolved: { path: string; exists: boolean };
    try {
      resolved = physicalPath(abs);
    } catch (e) {
      throw deny(`cannot read ${shown}: ${(e as Error).message}`, "name a file under files/");
    }
    const { path: real, exists } = resolved;
    const id = exists ? inode(real) : null;
    const key = lower(real);
    if ((id && this.protectedInodes.has(id)) || this.protectedPaths.some((p) => within(key, p))) {
      throw deny(`cannot read ${shown}: it is ${real === shown ? "" : `${real}, `}a file croft must never open this way (the open database, its WAL or temp files, or croft's state)`,
        "query the warehouse's tables by name; croft never reads its own files through SQL");
    }
    if (this.allowed && !this.allowed.some((d) => within(real, d))) {
      const where = this.allowed.length ? `outside the folders this SQL may read (${this.allowed.join(", ")})` : "not readable here: this connection may not read files";
      throw deny(`cannot read ${shown}: ${real === shown || real === abs ? "it is" : `it resolves to ${real},`} ${where}`,
        "move the file under files/, or load it with a file ingest");
    }
  }
}

/** First function node (table or scalar) whose name matches, with its source position when known. */
export function findFunctions(ast: unknown, match: (name: string) => boolean): { name: string; location?: number } | null {
  const stack: unknown[] = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const rec = node as Record<string, unknown>;
    if (typeof rec.function_name === "string" && match(rec.function_name)) {
      return { name: rec.function_name, location: location(rec) };
    }
    for (const v of Object.values(rec)) if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

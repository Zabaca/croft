// The one-SELECT gate (DESIGN.md §5 "Sandboxing every DuckDB instance"). All user-authored SQL must be
// exactly one SELECT: `extractStatements` must find one statement AND `json_serialize_sql` must accept it.
// Neither is enough alone: json_serialize_sql serializes `select 1; select 2` as two statements, and
// extractStatements happily counts one COPY or ATTACH. DESCRIBE, SUMMARIZE and SHOW serialize, so they pass.
//
// A SELECT can still do harm, so the gate then walks the statement's AST (verified on DuckDB 1.5.5):
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
// Not covered: a macro or view created in the warehouse outside croft can shadow a built-in name; the gate
// trusts the warehouse's own catalog. Paths are checked just before DuckDB opens them, not atomically.
// It uses no Bun-only APIs, so read.ts can import it.
import type { DuckDBConnection } from "@duckdb/node-api";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import { CroftError } from "../core/errors.ts";
import { mapSandboxError, type Profile } from "../db/connect.ts";
import { physicalPath } from "../project/root.ts";
import { asciiLower, type AstNode, collect, location, looksLikePath, stringOf, type Use } from "./ast.ts";

export interface GateOptions {
  profile?: Profile;                                  // "serve" allows tables only
  notSelectCode?: "QUERY_NOT_SELECT" | "SQL_NOT_SELECT"; // SQL assets report SQL_NOT_SELECT (§3c)
  file?: string;                                      // for problem locations
  lineOffset?: number;                                // lines before the SQL in `file` (asset headers)
  /** Files and folders user SQL must never read, beyond the connection's own database files; e.g. the
   *  state folder (runs.sqlite, serve.json) on a warehouse connection, which allows it for croft itself. */
  protect?: string[];
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
 * Every table function and table macro of DuckDB 1.5.5, classified. gate.test.ts fails when DuckDB ships
 * one that is not listed here; until it is classified, the gate refuses it.
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
    pragma_collations pragma_database_size pragma_metadata_info pragma_platform pragma_show
    pragma_storage_info pragma_table_info pragma_user_agent pragma_version
    pg_timezone_names icu_calendar_names sql_auto_complete check_peg_parser
    repeat repeat_row summary seq_scan test_all_types test_vector_types`),
  ...kinds("path", `
    read_csv read_csv_auto read_json read_json_auto read_json_objects read_json_objects_auto read_ndjson
    read_ndjson_auto read_ndjson_objects read_parquet parquet_scan read_text read_blob read_duckdb glob
    sniff_csv parquet_metadata parquet_schema parquet_file_metadata parquet_kv_metadata parquet_full_metadata
    parquet_bloom_probe`),
  ...kinds("table", "histogram histogram_values"),
  ...kinds("hidden-sql", "query query_table json_execute_serialized_sql"),
  ...kinds("effect", `
    checkpoint force_checkpoint enable_logging disable_logging truncate_duckdb_logs enable_profiling
    disable_profiling enable_peg_parser disable_peg_parser arrow_scan arrow_scan_dumb`),
]);

// Scalar functions: write_log writes into the instance's log; over HTTP, settings and variables reveal
// paths, and sleep_ms only holds a worker.
const SCALAR_DENIED = new Set(["write_log"]);
const SERVE_SCALAR_DENIED = new Set(["current_setting", "getvariable", "sleep_ms"]);
// SHOW forms that are not DESCRIBE: they list names, never paths.
const SHOW_LISTS = new Set(["tables", "databases", "variables", "__show_tables_expanded"]);

/** 1-based line and column of a DuckDB position, which counts code points (verified with emoji). */
export function lineColumn(sql: string, position: number): { line: number; column: number } {
  const chars = Array.from(sql);
  let line = 1;
  let column = 1;
  for (let i = 0; i < Math.min(position, chars.length); i++) {
    if (chars[i] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

interface Serialized {
  error: boolean;
  error_type?: string;
  error_message?: string;
  position?: string;
  statements?: SelectAst[];
}

async function serialize(conn: DuckDBConnection, sql: string): Promise<Serialized> {
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)", [sql]);
  return JSON.parse(String(reader.getRowsJS()[0]?.[0] ?? "{}")) as Serialized;
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
 * Throw unless `sql` is exactly one read-only SELECT (or DESCRIBE/SUMMARIZE/SHOW) that reads only what its
 * profile allows. Returns the statement's AST.
 * Codes: SQL_NOT_ONE_STATEMENT, QUERY_NOT_SELECT (or SQL_NOT_SELECT), SQL_SYNTAX, QUERY_PATH_DENIED.
 */
export async function assertOneSelect(conn: DuckDBConnection, sql: string, o: GateOptions = {}): Promise<SelectAst> {
  let count: number;
  try {
    count = (await conn.extractStatements(sql)).count;
  } catch {
    // Parse errors and empty input both land here; json_serialize_sql tells them apart and gives a position.
    const s = await serialize(conn, sql);
    if (s.error && s.error_type === "parser") throw syntaxError(sql, s, o);
    count = s.statements?.length ?? 0;
    if (count === 1) {
      throw new CroftError("INTERNAL_ERROR", { message: "extractStatements failed on a statement json_serialize_sql accepted", hint: "report this croft bug" });
    }
  }
  if (count !== 1) {
    throw new CroftError("SQL_NOT_ONE_STATEMENT", {
      message: count === 0 ? "found no SQL statement" : `found ${count} statements; croft runs exactly one SELECT`,
      hint: count === 0 ? "write a SELECT" : "run one SELECT at a time; combine queries with a CTE (WITH ...) or UNION",
      file: o.file,
    });
  }
  const s = await serialize(conn, sql);
  if (s.error) {
    if (s.error_type === "parser") throw syntaxError(sql, s, o);
    const code = o.notSelectCode ?? "QUERY_NOT_SELECT";
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
  await new Checker(conn, sql, o).check(stmt);
  return stmt;
}

// ---- AST helpers (the walk is sql/ast.ts) -----------------------------------------------------------------

type Node = AstNode;
const lower = asciiLower;
const str = stringOf;

/** A table function's positional arguments: named ones come as `name := v` (an alias) or `name = v`. */
function positional(fn: Node): Node[] {
  const children = Array.isArray(fn.children) ? (fn.children as Node[]) : [];
  return children.filter((c) => !str(c.alias) && !(c.type === "COMPARE_EQUAL" && (c.left as Node | undefined)?.class === "COLUMN_REF"));
}

/** The string of a VARCHAR literal, or null. */
function literal(n: Node | undefined): string | null {
  if (n?.class !== "CONSTANT") return null;
  const v = n.value as { type?: { id?: string }; is_null?: boolean; value?: unknown } | undefined;
  return v && !v.is_null && (v.type?.id === "VARCHAR" || v.type?.id === "STRING_LITERAL") && typeof v.value === "string" ? v.value : null;
}

/** 'a' or ['a', 'b'] → the strings; anything computed → null. */
function literalPaths(n: Node | undefined): string[] | null {
  const one = literal(n);
  if (one !== null) return [one];
  if (n?.class === "FUNCTION" && lower(str(n.function_name)) === "list_value" && Array.isArray(n.children) && n.children.length) {
    const all = (n.children as Node[]).map(literal);
    return all.every((p): p is string => p !== null) ? all : null;
  }
  return null;
}

// ---- The checks -------------------------------------------------------------------------------------------

interface ServeCatalog { current: string; userTables: Set<string>; others: Set<string> }

class Checker {
  private readonly serve: boolean;
  private paths?: Promise<PathGuard>;
  private catalog?: Promise<ServeCatalog>;

  constructor(private readonly conn: DuckDBConnection, private readonly sql: string, private readonly o: GateOptions) {
    this.serve = o.profile === "serve";
  }

  async check(stmt: SelectAst): Promise<void> {
    const { uses, ctes } = collect(stmt);
    for (const u of uses) {
      if (u.kind === "scalar") await this.scalar(u.name, u.at);
      else if (u.kind === "table_function") await this.tableFunction(u.name, u.fn, u.at);
      else if (u.kind === "relation") await this.relation(u, ctes);
      else if (this.serve && !SHOW_LISTS.has(lower(u.name))) throw this.serveDenied(`SHOW ${u.name}`, undefined, "is not available");
    }
  }

  private async scalar(name: string, at?: number): Promise<void> {
    const n = lower(name);
    if (this.serve && (SCALAR_DENIED.has(n) || SERVE_SCALAR_DENIED.has(n))) throw this.serveDenied(`${name}()`, at);
    if (SCALAR_DENIED.has(n)) {
      throw this.notSelect(`${name}() writes to DuckDB's log; croft runs read-only SELECTs`, "remove it; croft keeps its own logs", at);
    }
  }

  private async tableFunction(name: string, fn: Node, at?: number): Promise<void> {
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
        const guard = await this.pathGuard();
        for (const p of paths) await guard.check(p, (why, hint) => this.pathDenied(why, hint, location(args[0]!) ?? at));
        return;
      }
      case "table": {
        const first = positional(fn)[0];
        const text = literal(first);
        const parts = first?.class === "COLUMN_REF" && Array.isArray(first.column_names) ? (first.column_names as unknown[]).map(str) : null;
        if (text === null && !parts?.length) throw this.notLiteral(`${name}()`, location(first ?? fn) ?? at);
        const [table, schema = "", catalog = ""] = text !== null ? [text] : [...parts!].reverse();
        await this.relation({ kind: "relation", catalog, schema, name: table!, at: location(first!) ?? at }, new Set());
        return;
      }
      case "hidden-sql":
        throw this.notSelect(`${name}() runs SQL or reads a table named in a string, which croft cannot check`,
          "write the SELECT, or name the table, directly in the query", at);
      case "effect":
        throw this.notSelect(`${name}() changes DuckDB's state (logging, profiling, the parser or a checkpoint); croft runs read-only SELECTs`,
          "remove it; croft manages checkpoints, logging and profiling itself", at);
      case undefined:
        throw this.notSelect(`${name}() is not a table function croft allows; croft cannot tell what it reads or changes`,
          "query tables, read files under files/ with read_csv, read_parquet or read_json, or use range() and unnest()", at);
    }
  }

  private async relation(u: Extract<Use, { kind: "relation" }>, ctes: Set<string>): Promise<void> {
    const shown = [u.catalog, u.schema, u.name].filter(Boolean).join(".");
    if (looksLikePath(u.name)) {
      // `FROM 'files/x.csv'`: DuckDB reads the file through a replacement scan (or attaches a .duckdb file).
      if (this.serve) throw this.serveDenied(shown, u.at, "is a file; the read server reads the project's tables only");
      const guard = await this.pathGuard();
      await guard.check(u.name, (why, hint) => this.pathDenied(why, hint, u.at));
      return;
    }
    if (!this.serve) return;
    const cat = await this.serveCatalog();
    const name = lower(u.name);
    const plain = u.catalog === "" && u.schema === "";
    const inMain = (u.catalog === "" || lower(u.catalog) === cat.current) && (u.schema === "" || lower(u.schema) === "main");
    if (inMain && cat.userTables.has(name)) return;
    // A CTE reference; a CTE may not share a name with a built-in view, or a reference outside the CTE's
    // scope would reach the view.
    if (plain && ctes.has(name) && !cat.others.has(name)) return;
    throw this.serveDenied(shown, u.at, "is not one of the project's tables; the read server reads those only");
  }

  private pathGuard(): Promise<PathGuard> {
    this.paths ??= PathGuard.load(this.conn, this.o);
    return this.paths;
  }

  private serveCatalog(): Promise<ServeCatalog> {
    this.catalog ??= (async () => {
      const reader = await this.conn.runAndReadAll(`
        SELECT current_database() AS current, table_name AS name, schema_name = 'main' AND database_name = current_database() AND NOT temporary AS mine, schema_name
        FROM duckdb_tables()
        UNION ALL
        SELECT current_database(), view_name, false, schema_name FROM duckdb_views()`);
      const rows = reader.getRowObjectsJS() as { current: string; name: string; mine: boolean; schema_name: string }[];
      const userTables = new Set<string>();
      const others = new Set<string>();
      for (const r of rows) {
        if (r.mine) userTables.add(lower(r.name));
        else if (r.schema_name === "main" || r.schema_name === "pg_catalog") others.add(lower(r.name)); // reachable unqualified
      }
      const current = rows[0]?.current ?? String((await this.conn.runAndReadAll("SELECT current_database()")).getRowsJS()[0]?.[0] ?? "");
      return { current: lower(current), userTables, others };
    })();
    return this.catalog;
  }

  private where(at?: number): { line?: number; column?: number; file?: string } {
    const pos = at !== undefined ? lineColumn(this.sql, at) : undefined;
    return { file: this.o.file, line: pos ? pos.line + (this.o.lineOffset ?? 0) : undefined, column: pos?.column };
  }

  private serveDenied(what: string, at?: number, why = "is not available over HTTP; the read server reads the project's tables only"): CroftError {
    return new CroftError("QUERY_PATH_DENIED", {
      message: `${what} ${why}`,
      hint: "query the project's tables by name; files come in through file ingests",
      ...this.where(at),
    });
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

/** Where a query may read files on one connection, and what it must never touch. */
class PathGuard {
  private constructor(
    private readonly conn: DuckDBConnection,
    private readonly home: string,
    private readonly allowed: string[] | null,       // canonical folders and files; null = no sandbox
    private readonly protectedPaths: string[],       // canonical, lower-cased: equal or inside is refused
    private readonly protectedInodes: Set<string>,   // dev:ino of protected files (catches hard links)
    private readonly profile: Profile | undefined,
  ) {}

  static async load(conn: DuckDBConnection, o: GateOptions): Promise<PathGuard> {
    const reader = await conn.runAndReadAll(`SELECT
      current_setting('enable_external_access') AS external,
      current_setting('allowed_directories') AS dirs,
      current_setting('allowed_paths') AS files,
      current_setting('temp_directory') AS temp,
      current_setting('home_directory') AS home,
      (SELECT list(path) FROM duckdb_databases() WHERE path IS NOT NULL AND path <> '') AS databases`);
    const s = reader.getRowObjectsJS()[0] as { external: boolean; dirs: string[] | null; files: string[] | null; temp: string | null; home: string | null; databases: string[] | null };
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
    return new PathGuard(conn, home, allowed, protect.map((p) => lower(canon(p))), protectedInodes, o.profile);
  }

  /** Throw (via `deny`) unless DuckDB may read `raw`, as a query wrote it. Globs are expanded first. */
  async check(raw: string, deny: Deny): Promise<void> {
    const local = this.localPath(raw);
    if (local === null) throw deny(`cannot read ${raw}: croft reads local files only`, "fetch URLs in a TS ingest with ctx.http, then query the table");
    if (!/[*?[]/.test(local)) return this.checkOne(raw, local, deny);
    let matches: string[];
    try {
      const reader = await this.conn.runAndReadAll("SELECT file FROM glob($1::VARCHAR)", [raw]);
      matches = reader.getRowsJS().map((r) => String(r[0]));
    } catch (e) {
      const mapped = mapSandboxError(e, this.profile ?? "warehouse");
      if (mapped instanceof CroftError) throw deny(mapped.message, mapped.problem.hint);
      throw deny(`cannot check the files ${raw} matches: ${(e as Error).message.split("\n")[0]}`, "name the files without a pattern");
    }
    for (const m of matches) {
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

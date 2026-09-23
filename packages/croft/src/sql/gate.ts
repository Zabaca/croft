// The one-SELECT gate (DESIGN.md §5 "Sandboxing every DuckDB instance"). All user-authored SQL must be
// exactly one SELECT: `extractStatements` must find one statement AND `json_serialize_sql` must accept it.
// Neither is enough alone: json_serialize_sql serializes `select 1; select 2` as two statements, and
// extractStatements happily counts one COPY or ATTACH. DESCRIBE, SUMMARIZE and SHOW serialize, so they pass.
// It uses no Bun-only APIs, so read.ts can import it.
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";
import type { Profile } from "../db/connect.ts";

export interface GateOptions {
  profile?: Profile;                                  // "serve" also denies file and settings functions
  notSelectCode?: "QUERY_NOT_SELECT" | "SQL_NOT_SELECT"; // SQL assets report SQL_NOT_SELECT (§3c)
  file?: string;                                      // for problem locations
  lineOffset?: number;                                // lines before the SQL in `file` (asset headers)
}

/** The parsed statement, as json_serialize_sql returns it (the `statements[0]` object). */
export type SelectAst = { node: Record<string, unknown>; named_param_map?: unknown } & Record<string, unknown>;

// Table and scalar functions an HTTP client must not reach: they read files or reveal paths and settings.
// query('<sql>') is denied too: its SQL is a string the AST walk cannot see into (it only runs a SELECT).
const SERVE_DENIED = /^(glob|read_\w+|duckdb_settings|duckdb_databases|pragma_database_list|sniff_csv|parquet_\w+|current_setting|query)$/i;

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
 * Throw unless `sql` is exactly one SELECT (or DESCRIBE/SUMMARIZE/SHOW). Returns the statement's AST.
 * Codes: SQL_NOT_ONE_STATEMENT, QUERY_NOT_SELECT (or SQL_NOT_SELECT), SQL_SYNTAX, QUERY_PATH_DENIED (serve).
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
  if (o.profile === "serve") {
    const denied = findFunctions(stmt, (name) => SERVE_DENIED.test(name));
    if (denied) {
      const at = denied.location !== undefined ? lineColumn(sql, denied.location) : undefined;
      throw new CroftError("QUERY_PATH_DENIED", {
        message: `${denied.name}() is not available over HTTP; croft serve reads tables only`,
        hint: "query tables by name; files come in through file ingests",
        line: at?.line,
        column: at?.column,
      });
    }
  }
  return stmt;
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
      const loc = rec.query_location;
      // json_serialize_sql uses 2^64-1 for "no location"; JSON.parse rounds it to ~1.8e19.
      return { name: rec.function_name, location: typeof loc === "number" && loc < 2 ** 53 ? loc : undefined };
    }
    for (const v of Object.values(rec)) if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

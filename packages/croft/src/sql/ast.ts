// The walk over a statement's AST, as json_serialize_sql returns it (DESIGN.md §3c "Dependencies", §10 layout).
// The one-SELECT gate (gate.ts) checks every use it finds; SQL assets take their dependencies from it
// (relationNames, then sql/deps.ts adds the unoptimized plan's scans); TS transforms check ctx.query()
// against their declared inputs with it (UNDECLARED_INPUT). SQL assets (project/sql-asset.ts) also use it for
// catalog prefixes (CATALOG_PREFIX) and volatile functions (VOLATILE_SQL).
//
// Shapes verified on DuckDB 1.5.5: a table reference is a BASE_TABLE node with catalog_name, schema_name and
// table_name; a function call carries function_name (a table function sits under a TABLE_FUNCTION node's
// `function` key); a CTE's name is a key of its query node's cte_map.map; a DuckDB position is query_location;
// `current_date` and the other clock keywords are COLUMN_REF nodes, not functions.
// It uses no Bun-only APIs, so read.ts can import it through gate.ts.

/** One node of json_serialize_sql's output. */
export type AstNode = Record<string, unknown>;

/** Something a statement uses. */
export type Use =
  | { kind: "table_function"; name: string; fn: AstNode; at?: number }
  | { kind: "scalar"; name: string; at?: number }
  | { kind: "relation"; catalog: string; schema: string; name: string; at?: number }
  | { kind: "show"; name: string };

/** DuckDB matches built-in names ASCII case-insensitively; anything non-ASCII can only match a user object. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A node field as a string ("" when it is not one). */
export const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * json_serialize_sql's output made JSON: DuckDB writes a DOUBLE constant beyond range as a bare `Infinity`
 * (`SELECT 1e400`, verified on 1.5.5), which JSON.parse refuses. Such tokens outside strings (`Infinity`,
 * `-Infinity`, `NaN`) become strings; the text is returned unchanged when it has none.
 */
export function finiteJson(text: string): string {
  if (!/Infinity|NaN/.test(text)) return text;
  const token = /-?Infinity|NaN/y;
  let out = "";
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i += text[i] === "\\" ? 2 : 1);
      i++;
      continue;
    }
    token.lastIndex = i;
    const m = c === "I" || c === "N" || c === "-" ? token.exec(text) : null;
    if (m) {
      out += text.slice(from, i) + JSON.stringify(m[0]);
      i += m[0].length;
      from = i;
    } else i++;
  }
  return out + text.slice(from);
}

/** A node's position in the SQL (DuckDB counts code points), or undefined when it has none. */
export function location(node: AstNode): number | undefined {
  const loc = node.query_location;
  // json_serialize_sql uses 2^64-1 for "no location"; JSON.parse rounds it to ~1.8e19.
  return typeof loc === "number" && loc < 2 ** 53 ? loc : undefined;
}

/** Every function call, table reference and CTE name in the statement, in the AST's order (a query node's
 *  select list before its FROM). CTE names are ASCII-lowercased and collected over the whole statement,
 *  without their scopes. */
export function collect(ast: unknown): { uses: Use[]; ctes: Set<string> } {
  const uses: Use[] = [];
  const ctes = new Set<string>();
  const stack: { node: unknown; head: boolean }[] = [{ node: ast, head: false }];
  while (stack.length) {
    const { node, head } = stack.pop()!;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], head: false });
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const rec = node as AstNode;
    if (typeof rec.function_name === "string") {
      uses.push(head ? { kind: "table_function", name: rec.function_name, fn: rec, at: location(rec) } : { kind: "scalar", name: rec.function_name, at: location(rec) });
    }
    if (rec.type === "BASE_TABLE" && typeof rec.table_name === "string") {
      uses.push({ kind: "relation", catalog: stringOf(rec.catalog_name), schema: stringOf(rec.schema_name), name: rec.table_name, at: location(rec) });
    }
    if (rec.type === "SHOW_REF" && rec.query == null && typeof rec.table_name === "string" && rec.table_name !== "") {
      uses.push({ kind: "show", name: rec.table_name.replace(/^"(.*)"$/, "$1") });
    }
    const map = (rec.cte_map as { map?: unknown } | undefined)?.map;
    if (Array.isArray(map)) for (const e of map) if (typeof e?.key === "string") ctes.add(asciiLower(e.key));
    const next: { node: unknown; head: boolean }[] = [];
    for (const [k, v] of Object.entries(rec)) if (v && typeof v === "object") next.push({ node: v, head: rec.type === "TABLE_FUNCTION" && k === "function" });
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
  }
  return { uses, ctes };
}

// A table name DuckDB would hand to a replacement scan (read_csv, read_parquet, read_json, a DuckDB file):
// those need a file extension, and names croft creates never contain a dot or a slash.
export const looksLikePath = (name: string): boolean => /[./\\]/.test(name);

/**
 * The tables a statement reads by name: every BASE_TABLE reference in the main schema (unqualified or
 * `main.x`, no catalog) that is not a CTE, ASCII-lowercased, unique, in the AST's order. Left out: file paths
 * (`FROM 'files/x.csv'`, a replacement scan: SQL_READS_FILES), other schemas (`_croft.assets`,
 * `information_schema.tables`) and catalog-qualified names (CATALOG_PREFIX). An unqualified CTE name hides a
 * table everywhere in the statement (collect() keeps no scopes), so a CTE that shadows an asset in one query
 * node hides that asset in the others too; `main.x` always names the table. sql/deps.ts adds the
 * unoptimized plan's scans, which respect scopes.
 */
export function relationNames(ast: unknown): string[] {
  const { uses, ctes } = collect(ast);
  const out: string[] = [];
  for (const u of uses) {
    if (u.kind !== "relation" || u.catalog !== "" || looksLikePath(u.name)) continue;
    if (u.schema !== "" && asciiLower(u.schema) !== "main") continue;
    const name = asciiLower(u.name);
    // `main.x` names the table even where a CTE x is in scope.
    if ((u.schema !== "" || !ctes.has(name)) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Visit every node (object) of the AST, depth first, in the AST's order. */
export function walk(ast: unknown, visit: (node: AstNode) => void): void {
  const stack: unknown[] = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    visit(node as AstNode);
    const next = Object.values(node).filter((v) => v && typeof v === "object");
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
  }
}

// ---- Catalog prefixes (CATALOG_PREFIX) --------------------------------------------------------------------

/** A table named with a prefix other than `main.`: `other.main.t`, `warehouse.t`, `_croft.assets`. */
export interface PrefixedRelation {
  /** As DuckDB parsed it, dot-joined ("other.main.orders"). */
  shown: string;
  /** The table's own name, as written (without quotes). */
  name: string;
  at?: number;
}

/**
 * Tables named through a catalog or a schema other than `main` (DESIGN.md §3c "Dependencies"). croft keeps
 * every table in the project database's main schema and tracks inputs by plain name, so a prefix either names
 * something croft cannot track (another database, croft's `_croft` state, DuckDB's `information_schema`) or
 * hides a dependency: DuckDB resolves `warehouse.orders` (catalog, no schema) and `memory.main.orders` to the
 * table, while relationNames() leaves them out. File paths are not tables here (SQL_READS_FILES).
 */
export function catalogPrefixes(ast: unknown): PrefixedRelation[] {
  const out: PrefixedRelation[] = [];
  for (const u of collect(ast).uses) {
    if (u.kind !== "relation" || looksLikePath(u.name)) continue;
    if (u.catalog === "" && (u.schema === "" || asciiLower(u.schema) === "main")) continue;
    out.push({ shown: [u.catalog, u.schema, u.name].filter(Boolean).join("."), name: u.name, ...(u.at !== undefined ? { at: u.at } : {}) });
  }
  return out;
}

// ---- Volatile SQL (VOLATILE_SQL) --------------------------------------------------------------------------

/**
 * Functions whose value changes from one run to the next with the same input (DESIGN.md §3c "Volatile SQL"):
 * a table built with them keeps the value of its last rebuild. DuckDB 1.5.5's own stability markers
 * (duckdb_functions().stability VOLATILE or CONSISTENT_WITHIN_QUERY) minus NOT_VOLATILE, plus what the markers
 * miss: current_localtime and current_localtimestamp are marked CONSISTENT, and the macros ago,
 * pg_conf_load_time and pg_postmaster_start_time expand to current_timestamp. ast.test.ts fails when DuckDB
 * marks a function neither list names.
 */
export const VOLATILE_FUNCTIONS: ReadonlySet<string> = new Set(`
  now today current_date current_time current_timestamp get_current_time get_current_timestamp
  transaction_timestamp current_localtime current_localtimestamp localtime localtimestamp ago
  pg_conf_load_time pg_postmaster_start_time
  random setseed gen_random_uuid uuid uuidv4 uuidv7 nextval currval
  txid_current current_transaction_id current_query_id current_connection_id current_query stats`.trim().split(/\s+/));

/** Functions DuckDB marks VOLATILE or CONSISTENT_WITHIN_QUERY that give an asset the same values on every run:
 *  the database's own names (always "main" and the warehouse's name), and functions that return no value
 *  (error() fails the query, sleep_ms waits; the gate refuses write_log). */
export const NOT_VOLATILE: ReadonlySet<string> = new Set(`
  current_database current_catalog current_schema current_schemas in_search_path error sleep_ms write_log`.trim().split(/\s+/));

/** Bare keywords DuckDB parses as a column reference (a COLUMN_REF node, not a function) and binds to the
 *  clock when no column has the name [V 1.5.5]. */
export const VOLATILE_KEYWORDS: ReadonlySet<string> = new Set(["current_date", "current_time", "current_timestamp", "localtime", "localtimestamp"]);

/** A use of a volatile function, as written: "now()" or "current_date". */
export interface VolatileUse { shown: string; at?: number }

/** Every volatile function call and clock keyword in the statement, in the AST's order, each name once. */
export function volatileUses(ast: unknown): VolatileUse[] {
  const out: VolatileUse[] = [];
  const seen = new Set<string>();
  const add = (shown: string, node: AstNode) => {
    if (seen.has(shown)) return;
    seen.add(shown);
    const at = location(node);
    out.push({ shown, ...(at !== undefined ? { at } : {}) });
  };
  walk(ast, (node) => {
    if (typeof node.function_name === "string" && VOLATILE_FUNCTIONS.has(asciiLower(node.function_name))) {
      add(`${asciiLower(node.function_name)}()`, node);
    } else if (node.class === "COLUMN_REF" && Array.isArray(node.column_names) && node.column_names.length === 1) {
      const name = asciiLower(stringOf(node.column_names[0]));
      if (VOLATILE_KEYWORDS.has(name)) add(name, node);
    }
  });
  return out;
}

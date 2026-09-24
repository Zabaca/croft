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
//
// CTE scopes, as DuckDB 1.5.5 binds them (ast.test.ts checks every case against the unoptimized plan): the CTEs
// of a query node (a SELECT_NODE, or a SET_OPERATION_NODE for a WITH over a whole UNION) are in scope in that
// node and everything under it. Inside the CTE list, a CTE's body sees only the CTEs listed before it, not
// itself or later ones: `WITH orders AS (SELECT * FROM orders WHERE …)` reads the table orders. A recursive
// CTE (a RECURSIVE_CTE_NODE body) sees itself in its recursive part (`right`) only; its anchor reads the table.
// A CTE name never hides a `main.`-qualified table.
//
// histogram and histogram_values (TABLE_ARGUMENT_FUNCTIONS) are table macros over query_table: their first
// argument, or `source :=`, names the table they read, as an identifier or a string, and CTEs in scope count.
// A string that is a path reads the file through a replacement scan. collect() reports that table as a
// relation of its own (`via` the macro), so dependencies, catalog prefixes and path checks all see it.
//
// It uses no Bun-only APIs, so read.ts can import it through gate.ts.

/** One node of json_serialize_sql's output. */
export type AstNode = Record<string, unknown>;

/** Something a statement uses. */
export type Use =
  | { kind: "table_function"; name: string; fn: AstNode; at?: number }
  | { kind: "scalar"; name: string; at?: number }
  | {
    kind: "relation"; catalog: string; schema: string; name: string; at?: number;
    /** A CTE of this name is in scope here, so an unqualified name reads the CTE, not a table. */
    cte: boolean;
    /** The table macro (TABLE_ARGUMENT_FUNCTIONS) whose argument names it; absent for a table in FROM. */
    via?: string;
  }
  | { kind: "show"; name: string };

/** Table functions and table macros whose first argument (or `source :=`) names the table they read. */
export const TABLE_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set(["histogram", "histogram_values"]);

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

/** A set of ASCII-lowercased CTE names in scope: shared, never changed once built. */
type Scope = ReadonlySet<string>;
const NO_CTES: Scope = new Set();
const widen = (scope: Scope, names: readonly string[]): Scope => (names.length ? new Set([...scope, ...names]) : scope);

/**
 * Every function call, table reference and CTE name in the statement, in the AST's order (a query node's
 * select list before its FROM; a table macro's table right after the macro). Each relation says whether a CTE of
 * its name is in scope where it stands (see the scope rules above). `ctes` is every CTE name in the statement,
 * ASCII-lowercased, whatever its scope.
 */
export function collect(ast: unknown): { uses: Use[]; ctes: Set<string> } {
  const uses: Use[] = [];
  const ctes = new Set<string>();
  const stack: { node: unknown; head: boolean; scope: Scope }[] = [{ node: ast, head: false, scope: NO_CTES }];
  while (stack.length) {
    const { node, head, scope } = stack.pop()!;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], head: false, scope });
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const rec = node as AstNode;
    const hidden = (catalog: string, schema: string, name: string) => catalog === "" && schema === "" && scope.has(asciiLower(name));
    if (typeof rec.function_name === "string") {
      uses.push(head ? { kind: "table_function", name: rec.function_name, fn: rec, at: location(rec) } : { kind: "scalar", name: rec.function_name, at: location(rec) });
      if (head && TABLE_ARGUMENT_FUNCTIONS.has(asciiLower(rec.function_name))) {
        for (const t of tableArguments(rec) ?? []) {
          uses.push({ kind: "relation", catalog: t.catalog, schema: t.schema, name: t.name, at: t.at, cte: hidden(t.catalog, t.schema, t.name), via: rec.function_name });
        }
      }
    }
    if (rec.type === "BASE_TABLE" && typeof rec.table_name === "string") {
      const catalog = stringOf(rec.catalog_name);
      const schema = stringOf(rec.schema_name);
      uses.push({ kind: "relation", catalog, schema, name: rec.table_name, at: location(rec), cte: hidden(catalog, schema, rec.table_name) });
    }
    if (rec.type === "SHOW_REF" && rec.query == null && typeof rec.table_name === "string" && rec.table_name !== "") {
      uses.push({ kind: "show", name: rec.table_name.replace(/^"(.*)"$/, "$1") });
    }
    const map = (rec.cte_map as { map?: unknown } | undefined)?.map;
    const listed: string[] = [];
    if (Array.isArray(map)) for (const e of map) if (typeof e?.key === "string") listed.push(asciiLower(e.key));
    for (const n of listed) ctes.add(n);
    // The node's own parts see all of its CTEs; a recursive CTE's recursive part sees the CTE itself.
    const inner = widen(scope, listed);
    const recursive = rec.type === "RECURSIVE_CTE_NODE" && typeof rec.cte_name === "string" ? widen(scope, [asciiLower(rec.cte_name)]) : null;
    const next: { node: unknown; head: boolean; scope: Scope }[] = [];
    for (const [k, v] of Object.entries(rec)) {
      if (!v || typeof v !== "object") continue;
      if (k === "cte_map" && Array.isArray(map)) {
        // Each CTE's body sees the CTEs listed before it, never itself or later ones.
        map.forEach((e: unknown, i: number) => next.push({ node: e, head: false, scope: widen(scope, listed.slice(0, i)) }));
        continue;
      }
      next.push({ node: v, head: rec.type === "TABLE_FUNCTION" && k === "function", scope: recursive && k === "right" ? recursive : inner });
    }
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
  }
  return { uses, ctes };
}

// ---- Arguments --------------------------------------------------------------------------------------------

/** A table function's positional arguments: named ones come as `name := v` (an alias) or `name = v`. */
export function positional(fn: AstNode): AstNode[] {
  const children = Array.isArray(fn.children) ? (fn.children as AstNode[]) : [];
  return children.filter((c) => !stringOf(c.alias) && !(c.type === "COMPARE_EQUAL" && (c.left as AstNode | undefined)?.class === "COLUMN_REF"));
}

/** A table function's named argument `name := v` or `name = v` (ASCII case-insensitive), or undefined. */
export function namedArgument(fn: AstNode, name: string): AstNode | undefined {
  const children = Array.isArray(fn.children) ? (fn.children as AstNode[]) : [];
  for (const c of children) {
    if (asciiLower(stringOf(c.alias)) === name) return c;
    const left = c.left as AstNode | undefined;
    if (c.type === "COMPARE_EQUAL" && left?.class === "COLUMN_REF" && Array.isArray(left.column_names)
      && left.column_names.length === 1 && asciiLower(stringOf(left.column_names[0])) === name) return c.right as AstNode | undefined;
  }
  return undefined;
}

/** The string of a VARCHAR literal, or null. */
export function literal(n: AstNode | undefined): string | null {
  if (n?.class !== "CONSTANT") return null;
  const v = n.value as { type?: { id?: string }; is_null?: boolean; value?: unknown } | undefined;
  return v && !v.is_null && (v.type?.id === "VARCHAR" || v.type?.id === "STRING_LITERAL") && typeof v.value === "string" ? v.value : null;
}

/** A table a table macro names. */
export interface TableArgument {
  catalog: string;
  schema: string;
  /** As written, without quotes; a file path when it looksLikePath. */
  name: string;
  /** Written as a string ('orders'), not an identifier. */
  literal: boolean;
  at?: number;
}

/**
 * The tables a TABLE_ARGUMENT_FUNCTIONS call names: its first positional argument and its `source :=`, each an
 * identifier (`orders`, `main.orders`) or a string ('orders', 'files/x.csv'). null when one of them is computed
 * (`'ord' || 'ers'`, a subquery) or there is none: what it reads cannot be known without running it.
 */
export function tableArguments(fn: AstNode): TableArgument[] | null {
  const args = [positional(fn)[0], namedArgument(fn, "source")].filter((a): a is AstNode => a !== undefined);
  if (!args.length) return null;
  const out: TableArgument[] = [];
  for (const a of args) {
    const text = literal(a);
    const at = location(a);
    if (text !== null) {
      out.push({ catalog: "", schema: "", name: text, literal: true, ...(at !== undefined ? { at } : {}) });
      continue;
    }
    const parts = a.class === "COLUMN_REF" && Array.isArray(a.column_names) ? (a.column_names as unknown[]).map(stringOf) : [];
    if (!parts.length || parts.length > 3 || parts.some((p) => p === "")) return null;
    const [name, schema = "", catalog = ""] = [...parts].reverse();
    out.push({ catalog, schema, name: name!, literal: false, ...(at !== undefined ? { at } : {}) });
  }
  return out;
}

// A table name DuckDB would hand to a replacement scan (read_csv, read_parquet, read_json, a DuckDB file):
// those need a file extension, and names croft creates never contain a dot or a slash.
export const looksLikePath = (name: string): boolean => /[./\\]/.test(name);

/**
 * The tables a statement reads by name: every table reference in the main schema (unqualified or `main.x`, no
 * catalog) that is not a CTE in scope where it stands, and every table a table macro names
 * (`histogram(orders, amount)`); ASCII-lowercased, unique, in the AST's order. Left out: file paths
 * (`FROM 'files/x.csv'`, a replacement scan: SQL_READS_FILES), other schemas (`_croft.assets`,
 * `information_schema.tables`) and catalog-qualified names (CATALOG_PREFIX). `main.x` always names the table.
 * sql/deps.ts adds the unoptimized plan's scans.
 */
export function relationNames(ast: unknown): string[] {
  const out: string[] = [];
  for (const u of collect(ast).uses) {
    if (u.kind !== "relation" || u.catalog !== "" || u.cte || looksLikePath(u.name)) continue;
    if (u.schema !== "" && asciiLower(u.schema) !== "main") continue;
    const name = asciiLower(u.name);
    if (!out.includes(name)) out.push(name);
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
 * table, while relationNames() leaves them out. A table macro's table counts (`histogram(_croft.assets, x)`).
 * File paths are not tables here (SQL_READS_FILES).
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

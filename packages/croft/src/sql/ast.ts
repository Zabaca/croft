// The walk over a statement's AST, as json_serialize_sql returns it (DESIGN.md §3c "Dependencies", §10 layout).
// The one-SELECT gate (gate.ts) checks every use it finds; SQL assets take their dependencies from it
// (relationNames, then sql/deps.ts adds the unoptimized plan's scans); TS transforms check ctx.query()
// against their declared inputs with it (UNDECLARED_INPUT). SQL assets (project/sql-asset.ts) also use it for
// catalog prefixes (CATALOG_PREFIX) and volatile functions (VOLATILE_SQL).
//
// Shapes verified on DuckDB 2.0.0: a table reference is a BASE_TABLE node with catalog_name, schema_name and
// table_name; a function call carries function_name and its arguments as `arguments: [{name, expression}]`
// (name "" when positional; `children` is left only on OPERATOR and CONJUNCTION nodes); a table function sits
// under a TABLE_FUNCTION node's `function` key; a constant is `literal: {kind, text}` (STRING, INTEGER,
// NUMERIC, BOOLEAN, NULL_LITERAL), the text as written; a CTE's name is a key of its query node's cte_map.map; a
// DuckDB position is query_location, a UTF-8 byte offset; `SHOW t` is a SHOW_REF with show_type SHOW and no
// query, SHOW TABLES and the like are SHOW_SPECIAL; `current_date` and the other clock keywords are COLUMN_REF
// nodes, not functions.
//
// CTE scopes, as DuckDB 2.0.0 binds them (ast.test.ts checks every case against the unoptimized plan): the CTEs
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
  /** SHOW TABLES, SHOW ALL TABLES (or a bare DESCRIBE), SHOW databases: a SHOW_SPECIAL. */
  | { kind: "show"; name: string };

/** Table functions and table macros whose first argument (or `source :=`) names the table they read. */
export const TABLE_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set(["histogram", "histogram_values"]);

/** DuckDB matches built-in names ASCII case-insensitively; anything non-ASCII can only match a user object. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A node field as a string ("" when it is not one). */
export const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * json_serialize_sql's output made JSON. DuckDB 1.5.5 wrote a DOUBLE constant beyond range as a bare `Infinity`
 * (`SELECT 1e400`), which JSON.parse refuses; 2.0 writes every constant as its text, so this is a guard should a
 * bare token come back. Such tokens outside strings (`Infinity`, `-Infinity`, `NaN`) become strings; the text is
 * returned unchanged when it has none.
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

/** A node's position in the SQL (a UTF-8 byte offset; charIndex makes it a string index), or undefined when it
 *  has none. */
export function location(node: AstNode): number | undefined {
  const loc = node.query_location;
  // json_serialize_sql uses 2^64-1 for "no location"; JSON.parse rounds it to ~1.8e19.
  return typeof loc === "number" && loc < 2 ** 53 ? loc : undefined;
}

/** The string index (UTF-16 units) of a DuckDB position, which counts UTF-8 bytes into `sql`; sql.length when
 *  the position is past the end. A position inside a character counts as that character. */
export function charIndex(sql: string, byteOffset: number): number {
  let bytes = 0;
  let i = 0;
  while (i < sql.length && bytes < byteOffset) {
    const c = sql.codePointAt(i)!;
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (bytes > byteOffset) break;
    i += c > 0xffff ? 2 : 1;
  }
  return i;
}

/** A string index as DuckDB's position: the UTF-8 bytes before it. */
export function byteOffset(sql: string, index: number): number {
  return new TextEncoder().encode(sql.slice(0, index)).length;
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
  // `at`: a table function's position, which DuckDB 2.0 puts on its TABLE_FUNCTION node, not on the call.
  const stack: { node: unknown; head: boolean; scope: Scope; at?: number }[] = [{ node: ast, head: false, scope: NO_CTES }];
  while (stack.length) {
    const { node, head, scope, at: headAt } = stack.pop()!;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], head: false, scope });
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const rec = node as AstNode;
    const hidden = (catalog: string, schema: string, name: string) => catalog === "" && schema === "" && scope.has(asciiLower(name));
    if (typeof rec.function_name === "string") {
      uses.push(head ? { kind: "table_function", name: rec.function_name, fn: rec, at: location(rec) ?? headAt } : { kind: "scalar", name: rec.function_name, at: location(rec) });
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
      if (rec.show_type === "SHOW") {
        // `SHOW t` describes the table t: a use of it, like `DESCRIBE t` (whose query reads it).
        const catalog = stringOf(rec.catalog_name);
        const schema = stringOf(rec.schema_name);
        uses.push({ kind: "relation", catalog, schema, name: rec.table_name, at: location(rec), cte: hidden(catalog, schema, rec.table_name) });
      } else uses.push({ kind: "show", name: rec.table_name.replace(/^"(.*)"$/, "$1") });
    }
    const map = (rec.cte_map as { map?: unknown } | undefined)?.map;
    const listed: string[] = [];
    if (Array.isArray(map)) for (const e of map) if (typeof e?.key === "string") listed.push(asciiLower(e.key));
    for (const n of listed) ctes.add(n);
    // The node's own parts see all of its CTEs; a recursive CTE's recursive part sees the CTE itself.
    const inner = widen(scope, listed);
    const recursive = rec.type === "RECURSIVE_CTE_NODE" && typeof rec.cte_name === "string" ? widen(scope, [asciiLower(rec.cte_name)]) : null;
    const next: { node: unknown; head: boolean; scope: Scope; at?: number }[] = [];
    for (const [k, v] of Object.entries(rec)) {
      if (!v || typeof v !== "object") continue;
      if (k === "cte_map" && Array.isArray(map)) {
        // Each CTE's body sees the CTEs listed before it, never itself or later ones.
        map.forEach((e: unknown, i: number) => next.push({ node: e, head: false, scope: widen(scope, listed.slice(0, i)) }));
        continue;
      }
      const head = rec.type === "TABLE_FUNCTION" && k === "function";
      next.push({ node: v, head, scope: recursive && k === "right" ? recursive : inner, ...(head ? { at: location(rec) } : {}) });
    }
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
  }
  return { uses, ctes };
}

// ---- Arguments --------------------------------------------------------------------------------------------

/** A function call's arguments as written, in order: `name` is "" for a positional one and the name of
 *  `name := v`. */
export function args(fn: AstNode): { name: string; expression: AstNode }[] {
  const list = Array.isArray(fn.arguments) ? (fn.arguments as unknown[]) : [];
  const out: { name: string; expression: AstNode }[] = [];
  for (const a of list) {
    const e = (a as { expression?: unknown } | null)?.expression;
    if (e && typeof e === "object") out.push({ name: stringOf((a as { name?: unknown }).name), expression: e as AstNode });
  }
  return out;
}

/** `name = v` among a table function's arguments: DuckDB parses it as a comparison with a column. */
const isEqualsNamed = (e: AstNode) => e.type === "COMPARE_EQUAL" && (e.left as AstNode | undefined)?.class === "COLUMN_REF";

/** A function's positional arguments: named ones come as `name := v` or `name = v`. */
export function positional(fn: AstNode): AstNode[] {
  return args(fn).filter((a) => !a.name && !stringOf(a.expression.alias) && !isEqualsNamed(a.expression)).map((a) => a.expression);
}

/** A function's named argument `name := v` or `name = v` (ASCII case-insensitive), or undefined. */
export function namedArgument(fn: AstNode, name: string): AstNode | undefined {
  for (const { name: n, expression: e } of args(fn)) {
    if (asciiLower(n || stringOf(e.alias)) === name) return e;
    const left = e.left as AstNode | undefined;
    if (isEqualsNamed(e) && Array.isArray(left!.column_names) && left!.column_names.length === 1
      && asciiLower(stringOf(left!.column_names[0])) === name) return e.right as AstNode | undefined;
  }
  return undefined;
}

/** A constant's literal: its kind (STRING, INTEGER, NUMERIC, BOOLEAN, NULL_LITERAL) and text as written, or
 *  null when `n` is not a constant of that shape. */
export function constant(n: AstNode | undefined): { kind: string; text: string } | null {
  if (n?.class !== "CONSTANT") return null;
  const l = n.literal as { kind?: unknown; text?: unknown } | undefined;
  return l && typeof l.kind === "string" && typeof l.text === "string" ? { kind: l.kind, text: l.text } : null;
}

/** The string of a string literal, or null. */
export function literal(n: AstNode | undefined): string | null {
  const c = constant(n);
  return c?.kind === "STRING" ? c.text : null;
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

// ---- Query nodes ------------------------------------------------------------------------------------------

/** The query nodes that only read. DuckDB 2.0 also parses INSERT_, UPDATE_, DELETE_ and COPY_QUERY_NODE in any
 *  CTE, nested ones included (`WITH x AS (DELETE … RETURNING *) SELECT …`), and runs them: COPY writes files even
 *  on a READ_ONLY connection. */
export const QUERY_NODE_TYPES: ReadonlySet<string> = new Set(["SELECT_NODE", "SET_OPERATION_NODE", "RECURSIVE_CTE_NODE"]);

/** The first query node (an object whose `type` ends in `_NODE`) that is not a read, or null. A type croft does
 *  not know is returned too, so the check fails closed. */
export function foreignQueryNode(ast: unknown): { type: string; at?: number } | null {
  let found: { type: string; at?: number } | null = null;
  walk(ast, (node) => {
    if (found || typeof node.type !== "string" || !node.type.endsWith("_NODE") || QUERY_NODE_TYPES.has(node.type)) return;
    const at = location(node);
    found = { type: node.type, ...(at !== undefined ? { at } : {}) };
  });
  return found;
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
 * a table built with them keeps the value of its last rebuild. DuckDB 2.0.0's own stability markers
 * (duckdb_functions().stability VOLATILE or CONSISTENT_WITHIN_QUERY) minus NOT_VOLATILE, plus what the markers
 * miss: current_localtime and current_localtimestamp are marked CONSISTENT, and the macros ago,
 * pg_conf_load_time and pg_postmaster_start_time expand to current_timestamp. ast.test.ts fails when DuckDB
 * marks a function neither list names.
 */
export const VOLATILE_FUNCTIONS: ReadonlySet<string> = new Set(`
  now today current_date current_time current_timestamp get_current_time get_current_timestamp
  transaction_timestamp current_localtime current_localtimestamp localtime localtimestamp ago
  pg_conf_load_time pg_postmaster_start_time
  random setseed gen_random_uuid uuid uuidv4 uuidv7 nextval currval setval
  txid_current current_transaction_id current_query_id current_connection_id current_query stats vector_type`.trim().split(/\s+/));

/** Functions DuckDB marks VOLATILE or CONSISTENT_WITHIN_QUERY that give an asset the same values on every run:
 *  the database's own names (always "main" and the warehouse's name), functions that return no value (error()
 *  fails the query, sleep_ms waits; the gate refuses write_log), and settings and variables, which croft's
 *  sandbox fixes for every run (DuckDB 2.0 marks current_setting and getvariable CONSISTENT_WITHIN_QUERY). */
export const NOT_VOLATILE: ReadonlySet<string> = new Set(`
  current_database current_catalog current_schema current_schemas in_search_path error sleep_ms write_log
  current_setting getvariable`.trim().split(/\s+/));

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

// ---- Arrow lambdas (LAMBDA_ARROW) -------------------------------------------------------------------------

/** The functions that take a lambda: duckdb_functions() lists a LAMBDA parameter for exactly these (ast.test.ts
 *  holds the list to it). `COLUMNS(c -> …)` is list_filter over the columns in the AST. */
export const LAMBDA_FUNCTIONS: ReadonlySet<string> = new Set(`
  apply array_apply array_filter array_reduce array_transform filter invoke list_apply list_filter list_reduce
  list_transform reduce`.trim().split(/\s+/));

/** An arrow lambda (`x -> x + 1`) as written, with the `lambda` form that replaces it when croft can split it. */
export interface ArrowLambda { text?: string; to?: string; at?: number }

/**
 * Every lambda written with an arrow (`x -> …`, `(a, b) -> …`), which DuckDB 2.0 refuses ("Deprecated lambda arrow
 * (->) detected"): a SINGLE_ARROW LAMBDA that is an argument of a LAMBDA_FUNCTIONS call, or the expression of a
 * `COLUMNS(...)` star. JSON's `j->'k'` parses as a SINGLE_ARROW lambda too, but it is never such an argument, so it
 * is left alone. `sql` is the text the AST was parsed from: the lambda's span is cut from it.
 */
export function arrowLambdas(ast: unknown, sql: string): ArrowLambda[] {
  const found = new Set<AstNode>();
  const arrow = (n: AstNode | undefined) => n?.class === "LAMBDA" && n.syntax_type === "SINGLE_ARROW";
  walk(ast, (node) => {
    if (node.class === "FUNCTION" && LAMBDA_FUNCTIONS.has(asciiLower(stringOf(node.function_name)))) {
      for (const a of args(node)) if (arrow(a.expression)) found.add(a.expression);
    } else if (node.class === "STAR" && node.columns === true && arrow(node.expr as AstNode | undefined)) found.add(node.expr as AstNode);
  });
  return [...found].map((l) => {
    const at = location(l);
    return { ...lambdaRewrite(l, sql), ...(at !== undefined ? { at } : {}) };
  });
}

/** `(a, b) -> a + b` as written and as `lambda a, b: a + b`, from the lambda's byte span and its parameters'; {}
 *  when the span cannot be split at its arrow. */
function lambdaRewrite(l: AstNode, sql: string): { text?: string; to?: string } {
  const lhs = l.lhs as AstNode | undefined;
  const at = location(l);
  const length = l.query_location_length;
  const lhsAt = lhs ? location(lhs) : undefined;
  const lhsLength = lhs?.query_location_length;
  if (at === undefined || typeof length !== "number" || lhsAt === undefined || typeof lhsLength !== "number") return {};
  const start = charIndex(sql, at);
  const end = charIndex(sql, at + length);
  const paramsEnd = charIndex(sql, lhsAt + lhsLength);
  if (!(start <= paramsEnd && paramsEnd < end)) return {};
  const text = sql.slice(start, end);
  const arrowAt = /^\s*->\s*/.exec(sql.slice(paramsEnd, end));
  let params = sql.slice(start, paramsEnd).trim();
  if (params.startsWith("(") && params.endsWith(")")) params = params.slice(1, -1).trim();
  const body = sql.slice(paramsEnd + (arrowAt?.[0].length ?? 0), end);
  if (!arrowAt || !params || !body.trim()) return { text };
  return { text, to: `lambda ${params}: ${body}` };
}

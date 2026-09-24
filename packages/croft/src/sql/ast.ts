// The walk over a statement's AST, as json_serialize_sql returns it (DESIGN.md §3c "Dependencies", §10 layout).
// The one-SELECT gate (gate.ts) checks every use it finds; SQL assets take their dependencies from it
// (relationNames, then sql/deps.ts adds the unoptimized plan's scans); TS transforms check ctx.query()
// against their declared inputs with it (UNDECLARED_INPUT).
//
// Shapes verified on DuckDB 1.5.5: a table reference is a BASE_TABLE node with catalog_name, schema_name and
// table_name; a function call carries function_name (a table function sits under a TABLE_FUNCTION node's
// `function` key); a CTE's name is a key of its query node's cte_map.map; a DuckDB position is query_location.
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

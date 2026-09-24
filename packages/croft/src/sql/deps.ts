// Dependencies from the unoptimized bound plan (DESIGN.md §3c "Dependencies"): the scans of
// `PRAGMA disable_optimizer; EXPLAIN (FORMAT json) <body>` over the shadow catalog find the tables the AST
// hides (table macros, PIVOT) and respect CTE shadowing. The optimizer must be off: it prunes scans
// (`WHERE false`, `LIMIT 0`) [V]. An SQL asset's inputs are sql/ast.ts relationNames ∪ planScans.
//
// Verified on DuckDB 1.5.5 (deps.test.ts, and the golden corpus in deps-corpus/):
// - PRAGMA disable_optimizer works on a connection whose configuration is locked (SET enable_optimizer is
//   refused there), and nothing reports the setting, so it is read back by explaining `SELECT 1 WHERE false`:
//   the optimizer turns that into EMPTY_RESULT.
// - A table scan is a plan node whose extra_info has "Table": the catalog, schema and table, each quoted when
//   DuckDB would quote it (`"temp".main.t`, `memory.main."we.ird"`).
// - A CTE's scan appears once, under the CTE node; a table named in an unused CTE is not scanned; DESCRIBE
//   scans nothing (it reads the catalog).
// - EXPLAIN goes through prepare(), which refuses a second statement, and never runs the body.
import type { DuckDBConnection } from "@duckdb/node-api";
import { asciiLower } from "./ast.ts";

/**
 * The tables `body`'s unoptimized plan scans, ASCII-lowercased, unique and sorted. `conn` must hold every
 * table the body reads (sql/bind.ts's shadow catalog, never the warehouse); it is left with the optimizer
 * setting it had. null when the body does not bind there: the bind check reports why.
 *
 * Only tables in a `main` schema count (any catalog: a temp table is `temp.main.x`), as in relationNames.
 * `body` is an asset's body that loadSqlAsset accepted: a trailing `;` or `--` comment is fine, and so is a
 * comment on its first line. Not safe to call concurrently on one connection (the optimizer switch is per
 * connection).
 */
export async function planScans(conn: DuckDBConnection, body: string): Promise<string[] | null> {
  const wasOn = await optimizerOn(conn);
  if (wasOn) await conn.run("PRAGMA disable_optimizer");
  try {
    let plans: unknown[];
    try {
      plans = await explain(conn, body);
    } catch {
      return null;
    }
    const tables = new Set<string>();
    for (const plan of plans) collectScans(plan, tables);
    return [...tables].sort();
  } finally {
    if (wasOn) await conn.run("PRAGMA enable_optimizer");
  }
}

/** Whether the connection's optimizer is on: it turns `WHERE false` into an empty result. */
async function optimizerOn(conn: DuckDBConnection): Promise<boolean> {
  const plans = await explain(conn, "SELECT 1 WHERE false");
  return JSON.stringify(plans).includes('"EMPTY_RESULT"');
}

/** The physical plans of EXPLAIN (FORMAT json), parsed. The body goes after the prefix unchanged, so a
 *  trailing `;` or comment stays harmless and DuckDB's line numbers stay the body's. */
async function explain(conn: DuckDBConnection, sql: string): Promise<unknown[]> {
  const prepared = await conn.prepare(`EXPLAIN (FORMAT json) ${sql}`);
  try {
    const reader = await prepared.runAndReadAll();
    return reader.getRowsJS().map((r) => JSON.parse(String(r[1])) as unknown);
  } finally {
    prepared.destroySync();
  }
}

function collectScans(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectScans(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const rec = node as { extra_info?: { Table?: unknown }; children?: unknown };
  const table = rec.extra_info?.Table;
  if (typeof table === "string") {
    const parts = splitQualified(table);
    const name = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2]! : "main";
    if (name && asciiLower(schema) === "main") out.add(asciiLower(name));
  }
  collectScans(rec.children, out);
}

/** `"temp".main."we.ird"` → ["temp", "main", "we.ird"]: dots outside double quotes split, `""` is a quote. */
export function splitQualified(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ".") {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

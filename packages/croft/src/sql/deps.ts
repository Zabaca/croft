// Dependencies from the unoptimized bound plan (DESIGN.md §3c "Dependencies"): the scans of
// `PRAGMA disable_optimizer; EXPLAIN (FORMAT json) <body>` over the shadow catalog find the tables the AST
// hides (table macros, PIVOT) and respect CTE shadowing. The optimizer must be off: it prunes scans
// (`WHERE false`, `LIMIT 0`) [V]. An SQL asset's inputs are sql/ast.ts relationNames ∪ planScans.
//
// PHASE 2 STUB. The signature is final (the phase-2 contract): builder A (the SQL front end) implements it,
// with the golden corpus of DESIGN.md §10 "Test strategy"; until then it throws INTERNAL_ERROR "PHASE_STUB".
import type { DuckDBConnection } from "@duckdb/node-api";
import { phaseStub } from "../core/phase.ts";

/**
 * The tables `body`'s unoptimized plan scans, ASCII-lowercased, unique and sorted. `conn` must hold every
 * table the body reads (sql/bind.ts's shadow catalog, never the warehouse); it is left with the optimizer
 * setting it had. null when the body does not bind there: the bind check reports why.
 */
export async function planScans(conn: DuckDBConnection, body: string): Promise<string[] | null> {
  return phaseStub("planScans (sql/deps.ts)");
}

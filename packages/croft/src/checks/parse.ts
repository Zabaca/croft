// The check language (DESIGN.md §3f): the same in TypeScript (`checks`, `warnings`) and SQL (`-- check:`,
// `-- warn:`). `unique(a, b)`, `not_null(a, b)`, `min_rows(n)`, or any boolean SQL expression (a row rule;
// NULL passes, combine it with not_null). A key implies unique(key) and not_null(key).
//
// Every check is parsed before use: `SELECT (<expr>) FROM <asset>` through json_serialize_sql must give exactly
// one statement with one select item (CHECK_INVALID otherwise), identifiers are quoted with `"` escaping, and
// every statement croft builds runs through prepare(), which takes a single statement. Concatenating a check
// into a multi-statement run() would execute an embedded `; DROP TABLE …` [V].
//
// PHASE 2 STUB. The signatures are final (the phase-2 contract): builder C (checks and staleness) implements
// them; until then each throws INTERNAL_ERROR "PHASE_STUB".
import type { DuckDBConnection } from "@duckdb/node-api";
import { phaseStub } from "../core/phase.ts";
import type { Check, Problem } from "../core/types.ts";

export interface ParseChecksInput {
  asset: string;
  /** Root-relative, for CHECK_INVALID. */
  file: string;
  /** The asset's key: implies unique(key) and not_null(key), listed first. */
  key: readonly string[];
  /** Blocking checks, as written. */
  checks: readonly string[];
  /** Non-blocking checks, as written. */
  warnings: readonly string[];
}

/** Checks as croft runs them (core/types.ts Check: kind, scope, the SQL, the tables a subquery reads), without
 *  DuckDB. What does not parse is CHECK_INVALID, and is left out of `checks`. */
export function parseChecks(i: ParseChecksInput): { checks: Check[]; problems: Problem[] } {
  return phaseStub("parseChecks (checks/parse.ts)");
}

/** CHECK_INVALID for each check whose `SELECT (<expr>) FROM <asset>` is not exactly one statement with one select
 *  item (json_serialize_sql on `conn`, which needs no tables); [] when all are valid. */
export async function validateChecks(conn: DuckDBConnection, asset: string, checks: readonly Check[]): Promise<Problem[]> {
  return phaseStub("validateChecks (checks/parse.ts)");
}

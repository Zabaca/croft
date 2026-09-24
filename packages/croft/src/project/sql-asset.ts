// SQL assets (DESIGN.md §3c, §8 "What a code change does", §10 layout): the header, the one-SELECT body, its
// dependencies from the AST, and the fingerprint.
//
// PHASE 2 STUB. The signatures are final (the phase-2 contract): builder A (the SQL front end) implements
// them; until then each throws INTERNAL_ERROR "PHASE_STUB".
import type { DuckDBConnection } from "@duckdb/node-api";
import { phaseStub } from "../core/phase.ts";
import type { Problem } from "../core/types.ts";
import type { SelectAst } from "../sql/gate.ts";
import type { DiscoveredAsset } from "./discover.ts";

/** The header: the run of `-- name: value` comment lines at the top of the file (§3c). */
export interface SqlHeader {
  /** `-- description:`. */
  description?: string;
  /** `-- key: a, b`: the key columns, split on commas and trimmed; empty without one. */
  key: string[];
  /** `-- check:` expressions (repeatable, blocking), in file order, as written. */
  checks: string[];
  /** `-- warn:` expressions (repeatable, non-blocking), in file order, as written. */
  warnings: string[];
  /** How many lines the header spans: the body starts on line `lines + 1` of the file. The gate's and the
   *  bind check's lineOffset. */
  lines: number;
}

/**
 * Split an SQL asset's text into its header and body. An unknown name is HEADER_UNKNOWN_KEY with a
 * did-you-mean (`chek` → `check`) and the header line; the rest of the header still parses.
 * @param text the whole file.
 * @param file root-relative, for problem locations.
 */
export function parseSqlHeader(text: string, file: string): { header: SqlHeader; body: string; problems: Problem[] } {
  return phaseStub("parseSqlHeader (project/sql-asset.ts)");
}

/** An SQL asset as the planner, validate and the SQL step see it. */
export interface LoadedSqlAsset {
  name: string;
  /** Root-relative, "assets/open_issues.sql". */
  file: string;
  /** Absolute. */
  path: string;
  /** No error-severity problems. */
  ok: boolean;
  header: SqlHeader;
  /** The SQL after the header, verbatim: a trailing `;` or `--` comment stays (the SQL step wraps the body in
   *  a view, which tolerates both). */
  body: string;
  /** Lines before the body (header.lines): the line offset for problems the body raises. */
  headerLines: number;
  /** Tables the body reads by name, from the AST (sql/ast.ts relationNames), ASCII-lowercased. The unoptimized
   *  plan's scans come from the bind check (sql/bind.ts BindResult.planInputs); the asset's inputs are both. */
  astInputs: string[];
  /** sqlFingerprint(): present once the body passed the gate. */
  codeHash?: string;
  /** Everything loading found: HEADER_UNKNOWN_KEY, SQL_SYNTAX, SQL_NOT_ONE_STATEMENT, SQL_NOT_SELECT,
   *  PIVOT_NEEDS_VALUES, CATALOG_PREFIX, SQL_READS_FILES, QUERY_PATH_DENIED, ASSET_INVALID (an unreadable
   *  file), and the warning VOLATILE_SQL. */
  problems: Problem[];
}

export interface SqlAssetOptions {
  root: string;
  /** The project time zone: part of the fingerprint. */
  timezone: string;
  /** A connection for json_serialize_sql and the one-SELECT gate: an in-memory one (db/connect.ts openMemory),
   *  never the warehouse. */
  conn: DuckDBConnection;
  /** Every asset name in the project: which relations are assets, and did-you-mean suggestions. */
  assetNames: readonly string[];
}

/** Read, parse and check one SQL asset. Never throws for a problem with the asset: it lands in `problems`. */
export async function loadSqlAsset(a: Pick<DiscoveredAsset, "name" | "file" | "path">, o: SqlAssetOptions): Promise<LoadedSqlAsset> {
  return phaseStub("loadSqlAsset (project/sql-asset.ts)");
}

/**
 * The code hash of an SQL asset (§8): sha256 over the AST without query_location and with every `*_name`
 * identifier lowercased, plus the header and the project time zone. Whitespace, comments and keyword or
 * identifier case do not change it; changing the time zone does (`::DATE` results depend on it).
 */
export function sqlFingerprint(ast: SelectAst, header: SqlHeader, timezone: string): string {
  return phaseStub("sqlFingerprint (project/sql-asset.ts)");
}

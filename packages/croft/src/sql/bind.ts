// The bind check (DESIGN.md §6 "Ways to try a change": `croft validate`) and DuckDB errors of SQL assets.
//
// ShadowCatalog: an in-memory DuckDB with an empty table per input, built from cached column lists (the
// catalog mirror, previews, `columns` pins). Each SQL asset is prepare()d in dependency order, and its output
// columns become the empty input of the next asset. DuckDB's own messages supply "Candidate bindings" and caret
// positions, shifted past the header [V].
//
// PHASE 2 STUB, except mapAssetError, which works now. The signatures are final (the phase-2 contract): builder
// B (bind and graph) implements ShadowCatalog; until then its methods throw INTERNAL_ERROR "PHASE_STUB".
import { CroftError } from "../core/errors.ts";
import { phaseStub } from "../core/phase.ts";
import type { Problem } from "../core/types.ts";
import type { LoadedSqlAsset } from "../project/sql-asset.ts";
import { mapQueryError } from "../read/select.ts";

/** A column of a shadow table, or of an asset's output. */
export interface ShadowColumn {
  name: string;
  /** DuckDB's type name, as _croft.columns and the catalog mirror record it ("BIGINT", "DECIMAL(18,2)", "JSON"). */
  type: string;
}

export interface BindOptions {
  /** Columns still pending (all NULL so far, a name-typed placeholder) per input table: a binder error that
   *  involves one is NULL_ONLY_COLUMN, with an edit fix that adds a pin. */
  pending?: Readonly<Record<string, readonly string[]>>;
}

export interface BindResult {
  /** The asset's output columns in order (define() them as its shadow table for the assets that read it);
   *  null when it did not bind. */
  outputColumns: ShadowColumn[] | null;
  /** UNKNOWN_COLUMN (candidate bindings as an edit fix), UNKNOWN_TABLE, QUOTE_IDENTIFIER, NULL_ONLY_COLUMN,
   *  DUPLICATE_OUTPUT_COLUMN, or another DuckDB error (QUERY_FAILED), located in the asset's file. */
  problems: Problem[];
  /** The tables its unoptimized plan scans (sql/deps.ts planScans); null when it did not bind. */
  planInputs: string[] | null;
}

/** An in-memory catalog of empty tables to bind SQL assets against. Never the warehouse. */
export class ShadowCatalog {
  private constructor() {}

  /** An empty in-memory database set to the project time zone, sandboxed like every croft connection. */
  static async open(timezone: string): Promise<ShadowCatalog> {
    return phaseStub("ShadowCatalog.open (sql/bind.ts)");
  }

  /** Create, or replace, the empty table `table` with these columns. */
  async define(table: string, columns: readonly ShadowColumn[]): Promise<void> {
    return phaseStub("ShadowCatalog.define (sql/bind.ts)");
  }

  /** prepare() the asset's body against the tables defined so far. Problems about the asset are returned,
   *  never thrown. */
  async bind(asset: LoadedSqlAsset, o: BindOptions = {}): Promise<BindResult> {
    return phaseStub("ShadowCatalog.bind (sql/bind.ts)");
  }

  /** Close the in-memory database. */
  close(): void {
    phaseStub("ShadowCatalog.close (sql/bind.ts)");
  }
}

// ---------------------------------------------------------------------------------------------------------
// DuckDB errors of an asset's SQL

export interface AssetErrorOptions {
  /** The asset's file, root-relative ("assets/open_issues.sql"). */
  file: string;
  /** Lines of the file before the SQL DuckDB saw (LoadedSqlAsset.headerLines). */
  lineOffset: number;
  /** The asset's body as written. DuckDB's line numbers must count from its first line; a prefix on that line
   *  (the SQL step's `CREATE TEMP VIEW __body AS <body>`) is fine. */
  body: string;
  /** Columns still pending per input table (BindOptions.pending), for NULL_ONLY_COLUMN (builder B). */
  pending?: Readonly<Record<string, readonly string[]>>;
}

/**
 * read/select.ts mapQueryError for an asset's SQL, located in the asset's file: DuckDB's "LINE n:" becomes
 * the file's line (n + lineOffset), and its caret the column. A CroftError, and an error that is not DuckDB's
 * (a croft bug), come back unchanged.
 */
export function mapAssetError(err: unknown, o: AssetErrorOptions): unknown {
  if (err instanceof CroftError) return err;
  const mapped = mapQueryError(err, "warehouse");
  if (!(mapped instanceof CroftError)) return mapped;
  const at = duckdbPosition(err instanceof Error ? err.message : "", o.body);
  const { severity: _s, code: _c, docs: _d, ...init } = mapped.problem;
  return new CroftError(mapped.code, {
    ...init, file: o.file,
    ...(at ? { line: at.line + o.lineOffset, ...(at.column !== undefined ? { column: at.column } : {}) } : {}),
  });
}

/**
 * Where DuckDB's error excerpt points ("LINE 3: <excerpt>" with a caret under it), as a 1-based line and
 * code-point column of `sql`; null when the message has no excerpt. The caret counts display columns (a wide
 * character takes 2) and a long line's excerpt is cut ("..."), so the column is found by matching the rest of
 * the excerpt, from the caret on, in the line; without a match the column is left out.
 */
export function duckdbPosition(message: string, sql: string): { line: number; column?: number } | null {
  const all = [...message.matchAll(/LINE (\d+): (.*)\n( *)\^/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  const line = Number(m[1]);
  const caret = m[3]!.length - `LINE ${m[1]}: `.length;
  const excerpt = Array.from(m[2]!);
  let width = 0;
  let k = 0;
  while (k < excerpt.length && width < caret) width += displayWidth(excerpt[k++]!);
  const text = sql.split("\n")[line - 1]?.replace(/\r$/, "");
  if (width !== caret || text === undefined) return { line };
  let rest = excerpt.slice(k).join("");
  if (rest.endsWith("...") && !text.endsWith(rest)) rest = rest.slice(0, -3);
  if (rest === "") return { line };
  const chars = Array.from(text);
  // An excerpt that starts the line: the caret's index is the column. Otherwise the excerpt was cut or has a
  // prefix the body lacks: find the rest of it in the line, preferring the line's end.
  if (chars.slice(k).join("").startsWith(rest) && text.startsWith(excerpt.slice(0, k).join(""))) return { line, column: k + 1 };
  const pos = text.endsWith(rest) ? text.length - rest.length : text.indexOf(rest);
  return pos < 0 ? { line } : { line, column: Array.from(text.slice(0, pos)).length + 1 };
}

/** Terminal columns of one code point, as DuckDB's caret counts them: combining marks 0, East Asian wide
 *  characters and emoji 2, the rest 1. */
function displayWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

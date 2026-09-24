// The bind check (DESIGN.md §6 "Ways to try a change": `croft validate`) and DuckDB errors of SQL assets.
//
// ShadowCatalog: an in-memory DuckDB with an empty table per input, built from cached column lists (the
// catalog mirror, previews, `columns` pins). Each SQL asset is prepare()d in dependency order, and its output
// columns become the empty input of the next asset. DuckDB's own messages supply "Candidate bindings" and caret
// positions, shifted past the header [V].
//
// Nothing here runs an asset's SQL: prepare() binds, a TEMP view only records the output types, and
// sql/deps.ts planScans only EXPLAINs. The shadow database is sandboxed like every croft connection (no files,
// no network), so even a table function's bind step can reach nothing.
//
// What a failed bind becomes (verified on DuckDB 1.5.5):
// - UNKNOWN_COLUMN: "Referenced column "x" not found in FROM clause!" and, for `t.x`, "Table "t" does not have a
//   column named "x"", both with "Candidate bindings". The closest candidate is an edit fix on the caret's line.
// - UNKNOWN_TABLE: "Table with name x does not exist!". DuckDB's own "Did you mean" can name a system view
//   (pg_constraint), so the suggestion comes from the project's assets. An asset with no shadow table yet is
//   INPUT_NOT_BUILT (info): its columns are unknown, which the agent cannot fix by editing.
// - QUOTE_IDENTIFIER: a column named like a keyword (`order`, `group`, `limit`) fails to parse where it is
//   written bare, and DuckDB's caret points past it (`SELECT id, order FROM t` fails at FROM). Quoting the
//   keyword written at or before the error is tried, and it counts only when the parse error goes away, or
//   moves on, and the quoted body parses in the end; so `ORDER BY` stays a keyword.
// - NULL_ONLY_COLUMN (warning): an error that goes away when a pending column (all NULL so far, typed from its
//   name) gets another type. The type that binds is the pin in the edit fix.
// - DUPLICATE_OUTPUT_COLUMN: two output columns with one name, which the SQL step's view would rename to x_1.
//   Reserved names (_loaded_at, _file, _croft_seq) do not count: the step drops every copy of them, so
//   `SELECT *` over a join of two assets, which repeats _loaded_at, binds and runs.
import { type DuckDBConnection, StatementType } from "@duckdb/node-api";
import { CroftError, problem } from "../core/errors.ts";
import type { Fix, Problem } from "../core/types.ts";
import { openMemory } from "../db/connect.ts";
import { RESERVED } from "../load/contract.ts";
import { normalizeType, quoteIdent } from "../load/evolve.ts";
import { jsKey } from "../load/types.ts";
import type { LoadedSqlAsset } from "../project/sql-asset.ts";
import { didYouMean } from "../project/suggest.ts";
import { mapQueryError } from "../read/select.ts";
import { asciiLower, finiteJson, location } from "./ast.ts";
import { planScans } from "./deps.ts";
import { lineColumn } from "./gate.ts";

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
  /** Every asset of the project, name → root-relative file ("assets/github_issues.ts"). It gives UNKNOWN_TABLE
   *  its did-you-mean, makes a missing table that is an asset INPUT_NOT_BUILT, and names the file
   *  NULL_ONLY_COLUMN's pin goes in (without it that fix is manual). Default: the tables defined so far. */
  assetFiles?: Readonly<Record<string, string>>;
}

export interface BindResult {
  /** The asset's output columns in order (define() them as its shadow table for the assets that read it);
   *  null when it did not bind. Reserved columns (_loaded_at, _file, _croft_seq, in any case) are left out, as
   *  the SQL step leaves them out; with DUPLICATE_OUTPUT_COLUMN, the first column of each name is kept. */
  outputColumns: ShadowColumn[] | null;
  /** UNKNOWN_COLUMN (candidate bindings as an edit fix), UNKNOWN_TABLE, QUOTE_IDENTIFIER, NULL_ONLY_COLUMN,
   *  DUPLICATE_OUTPUT_COLUMN, or another DuckDB error (QUERY_FAILED), located in the asset's file. Also
   *  INPUT_NOT_BUILT (info) when it reads an asset that has no shadow table, SQL_SYNTAX for a parse error that
   *  quoting does not fix, and QUERY_PATH_DENIED for a file read (the loader's SQL_READS_FILES comes first). */
  problems: Problem[];
  /** The tables its unoptimized plan scans (sql/deps.ts planScans); null when it did not bind. */
  planInputs: string[] | null;
}

type MemoryDb = Awaited<ReturnType<typeof openMemory>>;

/** Columns the SQL step drops from an asset's output, every copy of each and in any case (run/sql.ts
 *  materialize, §3c): an input's _loaded_at and _file, and _croft_seq, which the step adds itself. */
const DROPPED_OUTPUT: ReadonlySet<string> = new Set([RESERVED.loadedAt, RESERVED.file, RESERVED.seq]);
const dropped = (name: string) => DROPPED_OUTPUT.has(asciiLower(name));
/** Every croft table has it; an SQL asset's output does not list it. */
const STAMP: ShadowColumn = { name: "_loaded_at", type: "TIMESTAMPTZ" };
/** Types tried for a pending column, in the order a pin is suggested: numbers before text (a text placeholder
 *  that fails is used as a number), and DOUBLE before BIGINT (it takes both). */
const PIN_TYPES = ["DOUBLE", "BIGINT", "VARCHAR", "TIMESTAMPTZ", "DATE", "BOOLEAN", "JSON"] as const;
/** Prepares one NULL_ONLY_COLUMN search may spend. */
const RETYPE_BUDGET = 60;
/** The TEMP view that records an asset's output types (names starting with _ are never assets). */
const VIEW = "__croft_bind";

/** An in-memory catalog of empty tables to bind SQL assets against. Never the warehouse. */
export class ShadowCatalog {
  /** By ASCII-lowercased name: DuckDB matches table and column names that way. */
  private readonly tables = new Map<string, { name: string; columns: ShadowColumn[] }>();
  private keywordSet: Set<string> | null = null;
  private closed = false;
  /** define() and bind() run one at a time: a bind retypes tables and uses one TEMP view. */
  private turn: Promise<unknown> = Promise.resolve();

  private constructor(private readonly db: MemoryDb, private readonly conn: DuckDBConnection) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const mine = this.turn.then(work, work);
    this.turn = mine.catch(() => {});
    return mine;
  }

  /** An empty in-memory database set to the project time zone, sandboxed like every croft connection. */
  static async open(timezone: string): Promise<ShadowCatalog> {
    const db = await openMemory({ timezone });
    try {
      return new ShadowCatalog(db, await db.connect());
    } catch (e) {
      db.close();
      throw e;
    }
  }

  /** Create, or replace, the empty table `table` with these columns. _loaded_at TIMESTAMPTZ is added when
   *  the list lacks it (every croft table has it, and an asset's output columns leave it out). */
  define(table: string, columns: readonly ShadowColumn[]): Promise<void> {
    const cols = columns.some((c) => asciiLower(c.name) === STAMP.name) ? columns.map((c) => ({ ...c })) : [...columns.map((c) => ({ ...c })), STAMP];
    return this.serial(async () => {
      await this.create(table, cols);
      this.tables.set(asciiLower(table), { name: table, columns: cols });
    });
  }

  /** prepare() the asset's body against the tables defined so far. Problems about the asset are returned,
   *  never thrown. Bind an asset that loaded without errors, or whose only error is SQL_SYNTAX: a parse error
   *  that quoting a keyword fixes comes back as QUOTE_IDENTIFIER, which replaces the loader's SQL_SYNTAX. A body
   *  that is not one SELECT binds to nothing, with no problem (the loader reports it). */
  bind(asset: LoadedSqlAsset, o: BindOptions = {}): Promise<BindResult> {
    return this.serial(() => this.bindNow(asset, o));
  }

  private async bindNow(asset: LoadedSqlAsset, o: BindOptions): Promise<BindResult> {
    const none = (problems: Problem[] = []): BindResult => ({ outputColumns: null, problems, planInputs: null });
    let extracted;
    try {
      extracted = await this.conn.extractStatements(asset.body);
    } catch (e) {
      // A parse error, or no statement at all (DuckDB then fails without a message of its own).
      return none(/Parser Error/.test(e instanceof Error ? e.message : "") ? await this.explain(e, asset, o) : []);
    }
    if (extracted.count !== 1) return none();
    let stmt;
    try {
      stmt = await extracted.prepare(0);
    } catch (e) {
      return none(await this.explain(e, asset, o));
    }
    let names: string[];
    try {
      if (stmt.statementType !== StatementType.SELECT) return none();
      if (stmt.parameterCount > 0) {
        return none([problem("QUERY_FAILED", {
          message: "an SQL asset cannot use parameters ($1, ?, $name)",
          hint: "write the value into the SQL",
          asset: asset.name, file: asset.file, details: { parameters: stmt.parameterCount },
        })]);
      }
      names = Array.from({ length: stmt.columnCount }, (_, i) => stmt.columnName(i));
    } finally {
      stmt.destroySync();
    }

    // The output types, as the SQL step's view has them (a nested JSON type keeps its name there), and the
    // names that view gives repeated columns.
    let view: { name: string; type: string }[];
    try {
      await this.exec(`CREATE OR REPLACE TEMP VIEW ${VIEW} AS ${asset.body}`);
      view = await this.rows<{ name: string; type: string }>(
        `SELECT column_name AS name, data_type AS type FROM duckdb_columns()
         WHERE database_name = 'temp' AND schema_name = 'main' AND table_name = '${VIEW}' ORDER BY column_index`);
    } catch (e) {
      return none(await this.explain(e, asset, o));
    } finally {
      await this.exec(`DROP VIEW IF EXISTS temp.main.${VIEW}`);
    }
    if (view.length !== names.length) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `the bind check of ${asset.name} found ${names.length} output columns, and its view ${view.length}`,
        hint: "report this croft bug",
      });
    }

    const problems = await this.duplicates(asset, names, view.map((v) => v.name));
    const seen = new Set<string>();
    const outputColumns: ShadowColumn[] = [];
    names.forEach((name, i) => {
      const k = asciiLower(name);
      if (seen.has(k)) return;
      seen.add(k);
      if (!dropped(name)) outputColumns.push({ name, type: typeName(view[i]!.type) });
    });
    return { outputColumns, problems, planInputs: await planScans(this.conn, asset.body) };
  }

  /** Close the in-memory database. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---- what a failed bind means ------------------------------------------------------------------------

  private async explain(e: unknown, asset: LoadedSqlAsset, o: BindOptions): Promise<Problem[]> {
    const err = withoutExtractPrefix(e);
    const mapped = mapAssetError(err, { file: asset.file, lineOffset: asset.headerLines, body: asset.body, pending: o.pending });
    if (!(mapped instanceof CroftError)) throw mapped; // not DuckDB's: a croft bug
    const p: Problem = { ...mapped.problem, asset: asset.name };
    const message = err instanceof Error ? err.message : String(err);
    switch (mapped.code) {
      case "SQL_SYNTAX":
        return (await this.quoteKeywords(asset, o)) ?? [p];
      case "UNKNOWN_TABLE":
        return [this.unknownTable(message, p, asset, o)];
      case "UNKNOWN_COLUMN":
        return [unknownColumn(message, p, asset)];
      case "QUERY_FAILED":
        return [(await this.nullOnly(asset, o, p)) ?? p];
      default:
        return [p];
    }
  }

  private unknownTable(message: string, p: Problem, asset: LoadedSqlAsset, o: BindOptions): Problem {
    const name = message.match(/Table with name (\S+?) does not exist/)?.[1];
    if (!name) return p;
    const assets = o.assetFiles ?? Object.fromEntries([...this.tables.values()].map((t) => [t.name, ""]));
    const asAsset = Object.keys(assets).find((a) => asciiLower(a) === asciiLower(name));
    if (asAsset !== undefined && !this.tables.has(asciiLower(name))) {
      return problem("INPUT_NOT_BUILT", {
        message: `columns of ${asAsset} are unknown until it has run or been previewed; bind check of ${asset.name} skipped`,
        hint: `${asset.name} is checked once ${asAsset} has run or been previewed`,
        asset: asset.name, file: asset.file, details: { input: asAsset },
      });
    }
    const known = [...new Set([...Object.keys(assets), ...[...this.tables.values()].map((t) => t.name)])];
    const suggestion = didYouMean(name, known.filter((k) => asciiLower(k) !== asciiLower(asset.name)));
    if (!suggestion) return p;
    return {
      ...p,
      hint: `did you mean ${suggestion}?`,
      fix: editFix("fix the table name", asset, p.line, name, suggestion),
      details: { ...p.details, table: name, suggestion },
    };
  }

  /**
   * NULL_ONLY_COLUMN: the first pending column of a table the asset reads, named in its body, and the first
   * type in PIN_TYPES that makes the body bind with that column retyped. null when no retype binds.
   */
  private async nullOnly(asset: LoadedSqlAsset, o: BindOptions, original: Problem): Promise<Problem | null> {
    if (!o.pending) return null;
    const reads = new Set(asset.astInputs.map(asciiLower));
    const words = new Set(identifierWords(asset.body).map((w) => asciiLower(w.text)));
    let budget = RETYPE_BUDGET;
    for (const table of Object.keys(o.pending).sort()) {
      const shadow = this.tables.get(asciiLower(table));
      if (!shadow || (reads.size > 0 && !reads.has(asciiLower(table)))) continue;
      for (const column of o.pending[table]!) {
        const at = shadow.columns.findIndex((c) => asciiLower(c.name) === asciiLower(column));
        if (at < 0 || !words.has(asciiLower(column))) continue;
        const current = normalizeType(shadow.columns[at]!.type);
        for (const type of PIN_TYPES) {
          if (type === current) continue;
          if (budget-- <= 0) return null;
          if (await this.bindsWith(asset.body, shadow, at, type)) {
            return pinProblem(asset, o, original, { table: shadow.name, column: shadow.columns[at]!.name, current, type });
          }
        }
      }
    }
    return null;
  }

  /** Whether `body` prepares with one column of `shadow` retyped; the table is restored either way. */
  private async bindsWith(body: string, shadow: { name: string; columns: ShadowColumn[] }, at: number, type: string): Promise<boolean> {
    await this.create(shadow.name, shadow.columns.map((c, i) => (i === at ? { ...c, type } : c)));
    try {
      (await this.conn.prepare(body)).destroySync();
      return true;
    } catch {
      return false;
    } finally {
      await this.create(shadow.name, shadow.columns);
    }
  }

  /**
   * QUOTE_IDENTIFIER for each bare keyword that names a column and breaks the parse; null when quoting none
   * of them helps. Candidates are tried from the parse error backwards (at most 3 per error); one counts when
   * the error goes away or moves past it. A syntax error that remains after them is reported too (SQL_SYNTAX,
   * on its line: quoting adds no lines).
   */
  private async quoteKeywords(asset: LoadedSqlAsset, o: BindOptions): Promise<Problem[] | null> {
    const keywords = await this.keywords();
    const columns = new Set([...this.tables.values()].flatMap((t) => t.columns.map((c) => asciiLower(c.name))));
    const candidates = identifierWords(asset.body).filter((w) => !w.qualified && !w.call
      && keywords.has(asciiLower(w.text)) && columns.has(asciiLower(w.text)));
    if (!candidates.length) return null;
    const accepted: Word[] = [];
    let error = await this.parseErrorAt(asset.body, []);
    for (let round = 0; error !== null && round < 50; round++) {
      const at = error.offset;
      const before = candidates.filter((w) => w.start <= at && !accepted.includes(w)).reverse().slice(0, 3);
      let next: ParseError | null | undefined;
      for (const w of before) {
        const after = await this.parseErrorAt(asset.body, [...accepted, w]);
        if (after === null || after.offset > at) {
          accepted.push(w);
          next = after;
          break;
        }
      }
      if (next === undefined) break;
      error = next;
    }
    if (!accepted.length) return null;
    const out = accepted.sort((a, b) => a.start - b.start).map((w) => {
      const at = lineColumnOfUnit(asset.body, w.start);
      return problem("QUOTE_IDENTIFIER", {
        message: `${w.text} is an SQL keyword, so as a column name it must be quoted: "${w.text}"`,
        hint: `write "${w.text}" (in double quotes) where it names the column`,
        asset: asset.name, file: asset.file, line: at.line + asset.headerLines, column: at.column,
        fix: editFix(`quote the column name ${w.text}`, asset, at.line + asset.headerLines, w.text, `"${w.text}"`),
        details: { keyword: asciiLower(w.text) },
      });
    });
    if (error) {
      const rest = mapAssetError(withoutExtractPrefix(error.error), { file: asset.file, lineOffset: asset.headerLines, body: asset.body, pending: o.pending });
      if (rest instanceof CroftError) out.push({ ...rest.problem, asset: asset.name });
    }
    return out;
  }

  /** Where `body`, with `quoted` words quoted, first fails to parse, as an offset into `body`; null when it
   *  parses. An error without a position is at the end. */
  private async parseErrorAt(body: string, quoted: readonly Word[]): Promise<ParseError | null> {
    const { text, original } = quoteWords(body, quoted);
    try {
      await this.conn.extractStatements(text);
      return null;
    } catch (error) {
      const at = duckdbPosition(error instanceof Error ? error.message : String(error), text);
      if (!at) return { offset: body.length, error };
      const lines = text.split("\n");
      const lineStart = lines.slice(0, at.line - 1).reduce((n, l) => n + l.length + 1, 0);
      const line = lines[at.line - 1] ?? "";
      const within = at.column === undefined ? line.length : Array.from(line).slice(0, at.column - 1).join("").length;
      return { offset: original(Math.min(lineStart + within, text.length)), error };
    }
  }

  /** DuckDB's keywords that are not "unreserved": each can break the parse where it is written bare. */
  private async keywords(): Promise<Set<string>> {
    this.keywordSet ??= new Set((await this.rows<{ k: string }>(
      "SELECT keyword_name AS k FROM duckdb_keywords() WHERE keyword_category <> 'unreserved'")).map((r) => asciiLower(r.k)));
    return this.keywordSet;
  }

  /** DUPLICATE_OUTPUT_COLUMN for each name the output has more than once (ASCII case-insensitive, as DuckDB
   *  compares names), located on the line of the repeat when the select list shows it. A reserved name
   *  (DROPPED_OUTPUT) is not one: the SQL step drops every copy of it (`SELECT *` over a join of two assets
   *  repeats _loaded_at), as it drops the renamed copies the view makes of it. */
  private async duplicates(asset: LoadedSqlAsset, names: readonly string[], viewNames: readonly string[]): Promise<Problem[]> {
    const groups = new Map<string, number[]>();
    names.forEach((n, i) => {
      if (dropped(n)) return;
      const k = asciiLower(n);
      groups.set(k, [...(groups.get(k) ?? []), i]);
    });
    const repeated = [...groups.values()].filter((g) => g.length > 1);
    if (!repeated.length) return [];
    const lines = await this.selectItemLines(asset.body, names.length);
    return repeated.map((g) => {
      const name = names[g[0]!]!;
      const copies = g.slice(1).map((i) => viewNames[i]!);
      const line = lines?.[g[1]!];
      return problem("DUPLICATE_OUTPUT_COLUMN", {
        message: `the output has ${g.length} columns named ${name}; the table would get ${[name, ...copies].join(", ")}`,
        hint: `name each output column once: rename the repeat of ${name} with AS`,
        asset: asset.name, file: asset.file, ...(line !== undefined ? { line: line + asset.headerLines } : {}),
        details: { column: name, count: g.length, renamedTo: copies },
      });
    });
  }

  /** The body line of each select-list item, when the top query's select list maps one to one onto the
   *  output (no *, no set operation); null otherwise. */
  private async selectItemLines(body: string, count: number): Promise<(number | undefined)[] | null> {
    const [row] = await this.rows<{ j: string }>("SELECT json_serialize_sql($1::VARCHAR) AS j", [body]);
    // finiteJson: a DOUBLE constant beyond range (`x < 1e400`) comes back as a bare Infinity.
    const parsed = JSON.parse(finiteJson(row?.j ?? "{}")) as { error?: boolean; statements?: { node?: Record<string, unknown> }[] };
    const node = parsed.statements?.[0]?.node;
    const list = node?.select_list;
    if (parsed.error || node?.type !== "SELECT_NODE" || !Array.isArray(list) || list.length !== count) return null;
    if (list.some((x: Record<string, unknown>) => x.class === "STAR")) return null;
    return list.map((x: Record<string, unknown>) => {
      const at = location(x);
      return at === undefined ? undefined : lineColumn(body, at).line;
    });
  }

  // ---- plumbing -------------------------------------------------------------------------------------------

  private async create(table: string, columns: readonly ShadowColumn[]): Promise<void> {
    const cols = columns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(", ");
    try {
      await this.exec(`CREATE OR REPLACE TABLE main.${quoteIdent(table)} (${cols})`);
    } catch (e) {
      throw new CroftError("INTERNAL_ERROR", {
        message: `cannot define the shadow table ${table}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`,
        hint: "report this croft bug",
        details: { table, columns: columns.map((c) => ({ ...c })) },
      });
    }
  }

  /** Run one statement: prepare() refuses a second one, whatever the text holds. */
  private async exec(sql: string): Promise<void> {
    const stmt = await this.conn.prepare(sql);
    try {
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  }

  private async rows<T>(sql: string, params: string[] = []): Promise<T[]> {
    const reader = await this.conn.runAndReadAll(sql, params);
    return reader.getRowObjectsJS() as T[];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Problems

function editFix(description: string, asset: LoadedSqlAsset, line: number | undefined, from: string, to: string): Fix {
  return { kind: "edit", description, file: asset.file, ...(line !== undefined ? { line } : {}), replace: { from, to } };
}

function unknownColumn(message: string, p: Problem, asset: LoadedSqlAsset): Problem {
  const first = message.replace(/^Failed to extract statements: /, "");
  const column = first.match(/Referenced column "(.+?)" not found/)?.[1] ?? first.match(/does not have a column named "(.+?)"/)?.[1];
  const listed = first.match(/Candidate bindings: (?:: )?(.*)/)?.[1] ?? "";
  const candidates = [...listed.matchAll(/"((?:[^"]|"")+)"/g)].map((m) => m[1]!.replaceAll('""', '"'));
  const suggestion = column ? didYouMean(column, candidates) : undefined;
  const reads = asset.astInputs.length === 1 ? asset.astInputs[0]! : "<table>";
  return {
    ...p,
    message: p.message.replace(/!$/, "."),
    hint: suggestion ? `did you mean "${suggestion}"?` : `check the column name (croft describe ${reads} lists them)`,
    ...(column && suggestion ? { fix: editFix("fix the column name", asset, p.line, column, suggestion) } : {}),
    details: { ...p.details, ...(column ? { column } : {}), candidates },
  };
}

function pinProblem(asset: LoadedSqlAsset, o: BindOptions, original: Problem,
  c: { table: string; column: string; current: string; type: string }): Problem {
  const file = Object.entries(o.assetFiles ?? {}).find(([a]) => asciiLower(a) === asciiLower(c.table))?.[1];
  const pin = `columns: { ${jsKey(c.column)}: "${c.type}" }`;
  const where = file || `${c.table}'s definition`;
  const fix: Fix = file
    ? { kind: "edit", description: `pin the type of ${c.column} in ${file}: ${pin}`, file, insert: pin }
    : { kind: "manual", description: `pin the type of ${c.column} in ${where}: ${pin}` };
  const { severity: _s, code: _c, docs: _d, fix: _f, hint: _h, message: _m, ...located } = original;
  return problem("NULL_ONLY_COLUMN", {
    ...located,
    message: `${asset.name} does not bind while ${c.table}.${c.column} holds only NULLs: it is typed ${c.current} from its name until values arrive, and ${asset.name} binds with it as ${c.type}`,
    hint: `pin the type in ${where}: ${pin}, or wait until ${c.column} has values`,
    fix,
    details: { ...original.details, input: c.table, column: c.column, placeholderType: c.current, pinType: c.type },
  });
}

/** A DuckDB type as the catalog records it: plain types normalized (TIMESTAMP WITH TIME ZONE → TIMESTAMPTZ),
 *  nested ones (STRUCT, MAP, ENUM, UNION, whose names and values are case-sensitive) kept as DuckDB wrote them. */
function typeName(type: string): string {
  return /^[A-Za-z][A-Za-z0-9_ ]*(\(\d+(, ?\d+)?\))?(\[\d*\])*$/.test(type) ? normalizeType(type) : type;
}

/** extractStatements prefixes parser errors with "Failed to extract statements: "; mapQueryError reads the
 *  kind from the start of the message. */
function withoutExtractPrefix(e: unknown): unknown {
  if (!(e instanceof Error) || !e.message.startsWith("Failed to extract statements: ")) return e;
  return new Error(e.message.slice("Failed to extract statements: ".length));
}

// ---------------------------------------------------------------------------------------------------------
// Words of the SQL text

/** A parse error at an offset of the asset's body. */
interface ParseError {
  offset: number;
  error: unknown;
}

interface Word {
  text: string;
  /** Code-unit offsets into the body. */
  start: number;
  end: number;
  /** After `.` or `::` (`g.order`, `x::varchar`): a keyword is fine there. */
  qualified: boolean;
  /** Before `(`: a function call (`left(x, 2)`). */
  call: boolean;
}

/** The bare words of `sql` (identifiers and keywords), skipping strings, quoted identifiers and comments. */
function identifierWords(sql: string): Word[] {
  const out: Word[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      i++;
      while (i < n && !(sql[i] === c && sql[i + 1] !== c)) i += sql[i] === c ? 2 : 1;
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? n : end + tag.length;
    } else if (/[A-Za-z_]/.test(c) && !/[\p{L}\p{N}_$]/u.test(sql[i - 1] ?? " ")) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_$]/u.test(sql[j]!)) j++;
      const prev = sql.slice(0, i).trimEnd();
      const next = sql.slice(j).trimStart();
      out.push({ text: sql.slice(i, j), start: i, end: j, qualified: prev.endsWith(".") || prev.endsWith("::"), call: next.startsWith("(") });
      i = j;
    } else i++;
  }
  return out;
}

/** `sql` with `words` double-quoted, and a map from an offset of the new text back to one of `sql`. */
function quoteWords(sql: string, words: readonly Word[]): { text: string; original(offset: number): number } {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const back: number[] = [];
  let text = "";
  let last = 0;
  const copy = (to: number) => {
    for (let k = last; k < to; k++) back.push(k);
    text += sql.slice(last, to);
    last = to;
  };
  for (const w of sorted) {
    copy(w.start);
    back.push(w.start);
    text += '"';
    copy(w.end);
    back.push(w.end);
    text += '"';
  }
  copy(sql.length);
  back.push(sql.length);
  return { text, original: (offset) => back[Math.min(offset, back.length - 1)]! };
}

/** 1-based line and code-point column of a code-unit offset. */
function lineColumnOfUnit(sql: string, offset: number): { line: number; column: number } {
  const before = sql.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: Array.from(sql.slice(lineStart, offset)).length + 1 };
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
  /** Columns still pending per input table (BindOptions.pending). An error that is not about a missing table
   *  or column, on a line that names one of them, keeps its code (the step failed) and gets a hint to pin the
   *  column's type, with the columns in details.pendingColumns. The bind check goes further: it retypes the
   *  column to find the pin (ShadowCatalog.bind, NULL_ONLY_COLUMN). */
  pending?: Readonly<Record<string, readonly string[]>>;
}

/**
 * read/select.ts mapQueryError for an asset's SQL, located in the asset's file: DuckDB's "LINE n:" becomes
 * the file's line (n + lineOffset), and its caret the column. `t.x` for a column t lacks is UNKNOWN_COLUMN,
 * as a bare `x` is. A CroftError, and an error that is not DuckDB's (a croft bug), come back unchanged.
 */
export function mapAssetError(err: unknown, o: AssetErrorOptions): unknown {
  if (err instanceof CroftError) return err;
  const mapped = mapQueryError(err, "warehouse");
  if (!(mapped instanceof CroftError)) return mapped;
  const message = err instanceof Error ? err.message : "";
  const at = duckdbPosition(message, o.body);
  const { severity: _s, code: _c, docs: _d, ...init } = mapped.problem;
  let code = mapped.code;
  const first = message.split("\n")[0]!;
  if (code === "QUERY_FAILED" && /^Binder Error: Table ".+" does not have a column named ".+"/.test(first)) {
    code = "UNKNOWN_COLUMN";
    init.message = first.replace(/^Binder Error: /, "");
    init.hint = "check the column name (croft describe <table> lists them)";
  }
  if (code === "QUERY_FAILED" && o.pending) {
    const line = at ? o.body.split("\n")[at.line - 1] ?? o.body : o.body;
    const words = new Set(identifierWords(line).map((w) => asciiLower(w.text)));
    const hits = Object.entries(o.pending).flatMap(([table, cols]) => cols.filter((c) => words.has(asciiLower(c))).map((column) => ({ table, column })));
    if (hits.length) {
      const named = hits.map((h) => `${h.table}.${h.column}`).join(", ");
      init.hint = `${named} ${hits.length > 1 ? "hold" : "holds"} only NULLs so far, typed from the name until values arrive; `
        + `if the SQL needs another type, pin it in the input asset: columns: { ${jsKey(hits[0]!.column)}: "<type>" }`;
      init.details = { ...init.details, pendingColumns: hits };
    }
  }
  return new CroftError(code, {
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

// SQL assets (DESIGN.md §3c, §8 "What a code change does", §10 layout): the header, the one-SELECT body, its
// dependencies from the AST, and the fingerprint.
//
// Loading an asset runs these checks, in this order, and collects every problem instead of stopping at one:
// 1. The header: `-- name: value` lines at the top. An unknown name is HEADER_UNKNOWN_KEY (did-you-mean), and
//    so is a `-- key:`, `-- check:` or `-- warn:` line below the header, which croft would otherwise ignore.
// 2. PIVOT without an IN list (PIVOT_NEEDS_VALUES). DuckDB rewrites it into two statements whose columns depend
//    on the data [V], so the gate would only say "found 2 statements". It is told apart by counting statements
//    twice: DuckDB's extractStatements, and a lexer that knows strings, quoted names and comments. More
//    statements from DuckDB than in the text, with a PIVOT in the text, is the rewrite.
// 3. Checks on the AST before the gate: reading files (SQL_READS_FILES; the gate allows files/, croft query
//    reads them), DESCRIBE/SUMMARIZE/SHOW (SQL_NOT_SELECT), table prefixes (CATALOG_PREFIX), and volatile
//    functions (the warning VOLATILE_SQL).
// 4. The one-SELECT gate (sql/gate.ts), reporting SQL_NOT_ONE_STATEMENT, SQL_NOT_SELECT, SQL_SYNTAX and
//    QUERY_PATH_DENIED at the asset's lines (past the header).
// The AST is parsed losslessly (integers beyond 2^53 stay exact), so the fingerprint tells `id = 9007199254740993`
// from `id = 9007199254740992`.
import { readFileSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { CroftError, problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { canonicalJson, losslessReviver } from "../load/stage.ts";
import {
  asciiLower, type AstNode, catalogPrefixes, collect, finiteJson, looksLikePath, relationNames, stringOf, volatileUses, walk,
} from "../sql/ast.ts";
import { assertOneSelect, lineColumn, type SelectAst, TABLE_FUNCTIONS } from "../sql/gate.ts";
import { type DiscoveredAsset, suggestName } from "./discover.ts";
import { didYouMean } from "./suggest.ts";

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

/** The names a header line may have. */
export const HEADER_KEYS = ["description", "key", "check", "warn"] as const;

// `-- name: value`. Not `-- https://...`: a URL in a plain comment is not a header line.
const HEADER_LINE = /^(\s*--\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:(?!\/\/)\s*(.*?)\s*$/;

/**
 * Split an SQL asset's text into its header and body. An unknown name is HEADER_UNKNOWN_KEY with a
 * did-you-mean (`chek` → `check`) and the header line; the rest of the header still parses.
 *
 * The header is the leading run of `--` comment lines and blank lines: names are matched without regard to
 * case, plain comments may sit between header lines (as in describe's reading of the header), and the first
 * other line starts the body. `key` values accumulate across lines, repeated descriptions are joined with a
 * space, and empty values are ignored. A byte-order mark is dropped.
 *
 * Header lines must come first. A `-- key:`, `-- check:` or `-- warn:` line in the body (a whole-line `--`
 * comment, outside strings, quoted names and block comments) would be a plain comment, so the asset would
 * silently lose its key or checks: it is HEADER_UNKNOWN_KEY at its line instead, and is not applied. That
 * includes a header written below a leading `/* ... *\/` comment, which ends the header like any SQL line.
 * A `-- description:` there, which only documents, is left alone.
 * @param text the whole file.
 * @param file root-relative, for problem locations.
 */
export function parseSqlHeader(text: string, file: string): { header: SqlHeader; body: string; problems: Problem[] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const header: SqlHeader = { key: [], checks: [], warnings: [], lines: 0 };
  const problems: Problem[] = [];
  const descriptions: string[] = [];
  let offset = 0;
  let lineNo = 0;
  while (offset < src.length) {
    const nl = src.indexOf("\n", offset);
    const end = nl < 0 ? src.length : nl;
    const line = src.slice(offset, end).replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("--")) break;
    lineNo++;
    offset = nl < 0 ? src.length : nl + 1;
    header.lines = lineNo;
    const m = HEADER_LINE.exec(line);
    if (!m) continue;
    const [, lead, name, value] = m as unknown as [string, string, string, string];
    switch (name.toLowerCase()) {
      case "description":
        if (value) descriptions.push(value);
        break;
      case "key":
        for (const k of value.split(",").map((s) => unquote(s.trim())).filter(Boolean)) if (!header.key.includes(k)) header.key.push(k);
        break;
      case "check":
        if (value) header.checks.push(value);
        break;
      case "warn":
        if (value) header.warnings.push(value);
        break;
      default:
        problems.push(unknownKeyProblem(name, value, file, lineNo, Array.from(lead).length + 1));
    }
  }
  if (descriptions.length) header.description = descriptions.join(" ");
  const body = src.slice(offset);
  for (const c of bodyCommentLines(body)) {
    const m = HEADER_LINE.exec(c.text);
    const name = m?.[2]!.toLowerCase();
    if (!m || !name || !LATE_HEADER_KEYS.has(name)) continue;
    problems.push(lateHeaderProblem(name, c.text.trim(), file, header.lines + c.line, Array.from(m[1]!).length + 1, header.lines + 1));
  }
  return { header, body, problems };
}

/** Header names that change what croft does with the asset: below the header, they would be lost silently. */
const LATE_HEADER_KEYS: ReadonlySet<string> = new Set(["key", "check", "warn"]);

function lateHeaderProblem(name: string, written: string, file: string, line: number, column: number, bodyStartsAt: number): Problem {
  return problem("HEADER_UNKNOWN_KEY", {
    message: `line ${line}: -- ${name}: comes after the header, which ends at line ${bodyStartsAt}, so croft ignores it; header lines must come first`,
    hint: `move ${written} to the top of the file, above the first line that is not a -- comment (a /* */ comment ends the header)`,
    file, line, column,
    fix: {
      kind: "edit", file, line,
      description: `move it into the header (the -- lines at the top of the file, before any SQL or /* */ comment), or reword the comment without "${name}:"`,
    },
    details: { name, bodyStartsAt },
  });
}

/** The whole-line `--` comments of an SQL text: each line whose first non-blank characters start a comment
 *  outside strings ('…', E'…', $tag$…$tag$), quoted names ("…") and block comments, with its 1-based line. */
function bodyCommentLines(sql: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let line = 1;
  let blank = true;                                   // only blanks since the line began
  let i = 0;
  const n = sql.length;
  // Advance to `to`, counting the newlines passed; `blank` is false after anything but whitespace.
  const skip = (to: number) => {
    for (; i < Math.min(to, n); i++) {
      if (sql[i] === "\n") line++;
    }
    blank = false;
  };
  while (i < n) {
    const c = sql[i]!;
    if (c === "\n") {
      line++;
      blank = true;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      if (blank) out.push({ line, text: sql.slice(sql.lastIndexOf("\n", i) + 1, stop).replace(/\r$/, "") });
      i = stop;
      blank = false;
    } else if (c === "/" && sql[i + 1] === "*") {
      let nest = 1;
      let j = i + 2;
      while (j < n && nest > 0) {
        if (sql.startsWith("/*", j)) { nest++; j += 2; } else if (sql.startsWith("*/", j)) { nest--; j += 2; } else j++;
      }
      skip(j);
    } else if (c === "'" || ((c === "E" || c === "e") && sql[i + 1] === "'" && !/[A-Za-z0-9_$\u0080-\uffff]/.test(sql[i - 1] ?? " "))) {
      const escapes = c !== "'";
      let j = escapes ? i + 2 : i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      skip(j + 1);
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      skip(j + 1);
    } else if (c === "$" && dollarTag(sql, i)) {
      const tag = dollarTag(sql, i)!;
      const close = sql.indexOf(tag, i + tag.length);
      skip(close < 0 ? n : close + tag.length);
    } else {
      i++;
      blank = false;
    }
  }
  return out;
}

/** `"Order ID"` → `Order ID` (a quoted key column); anything else as written. */
function unquote(s: string): string {
  return /^"(?:[^"]|"")+"$/.test(s) ? s.slice(1, -1).replaceAll('""', '"') : s;
}

function unknownKeyProblem(name: string, value: string, file: string, line: number, column: number): Problem {
  const guess = didYouMean(name, HEADER_KEYS);
  const names = "description, key, check and warn";
  return problem("HEADER_UNKNOWN_KEY", {
    message: `line ${line}: "${name}" is not a header name; the header takes ${names}${guess ? ` (did you mean ${guess}?)` : ""}`,
    hint: guess
      ? `rename it: -- ${guess}: ${value}`
      : `use one of ${names}; for a plain comment at the top, leave out the colon after the first word`,
    file, line, column,
    fix: guess
      ? { kind: "edit", description: `rename ${name} to ${guess}`, file, line, replace: { from: name, to: guess } }
      : { kind: "edit", description: `rename ${name} to one of ${names}, or reword the comment without "${name}:"`, file, line },
    details: { name, ...(guess ? { suggestion: guess } : {}), allowed: [...HEADER_KEYS] },
  });
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
  const { name, file, path } = a;
  const out: LoadedSqlAsset = { name, file, path, ok: false, header: { key: [], checks: [], warnings: [], lines: 0 }, body: "", headerLines: 0, astInputs: [], problems: [] };
  const add = (p: Problem) => out.problems.push({ ...p, asset: name });
  const finish = () => {
    out.ok = !out.problems.some((p) => p.severity === "error");
    return out;
  };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    add(problem("ASSET_INVALID", { message: `cannot read ${file}: ${(e as Error).message}`, hint: "check that the file exists and is readable", file }));
    return finish();
  }
  const parsed = parseSqlHeader(text, file);
  out.header = parsed.header;
  out.body = parsed.body;
  out.headerLines = parsed.header.lines;
  parsed.problems.forEach(add);
  const at = new Locator(parsed.body, file, parsed.header.lines);

  // 2. PIVOT without IN: before the gate, which would count the rewrite's statements.
  const pivot = await pivotWithoutValues(o.conn, parsed.body);
  if (pivot) {
    add(pivotProblem(pivot, at));
    return finish();
  }

  // 3. The AST checks the gate does not make for an asset.
  const ast = await serializeOne(o.conn, parsed.body);
  let readsFiles = false;
  if (ast) {
    const files = fileReads(ast);
    readsFiles = files.length > 0;
    for (const f of files) add(readsFilesProblem(f, name, o.assetNames, at));
    const shown = showStatement(ast);
    if (shown) add(showProblem(shown, at));
    for (const p of catalogPrefixes(ast)) add(prefixProblem(p, o.assetNames, parsed.body, at));
    const volatile = volatileUses(ast);
    if (volatile.length) add(volatileProblem(name, volatile, at));
    out.astInputs = relationNames(ast);
  }

  // 4. The gate. A file read was reported above; the gate would only add its verdict on the path.
  if (!readsFiles) {
    try {
      const gated = await assertOneSelect(o.conn, parsed.body, { notSelectCode: "SQL_NOT_SELECT", file, lineOffset: parsed.header.lines });
      out.codeHash = sqlFingerprint(ast ?? gated, parsed.header, o.timezone);
      if (!ast) out.astInputs = relationNames(gated);
    } catch (e) {
      if (!(e instanceof CroftError)) throw e;
      add(e.problem);
    }
  }
  return finish();
}

/**
 * The code hash of an SQL asset (§8): sha256 over the AST without query_location and with every `*_name`
 * identifier lowercased, plus the header and the project time zone. Whitespace, comments and keyword or
 * identifier case do not change it; changing the time zone does (`::DATE` results depend on it).
 *
 * `*_name` covers table, schema, catalog, function and star-qualifier names, which never name an output
 * column. Column references (`column_names`) and aliases keep their case: DuckDB names an unaliased
 * expression's column after the text as written (`sum(AMOUNT)` is a column "sum(AMOUNT)") [V], so a case
 * change there can rename a column, and a spurious rebuild is safe where a missed one is not. The header
 * counts without its line count, so a blank line added to it changes nothing. Pass an AST parsed losslessly
 * (loadSqlAsset does) to tell integers beyond 2^53 apart.
 */
export function sqlFingerprint(ast: SelectAst, header: SqlHeader, timezone: string): string {
  const material = canonicalJson({
    v: 1,
    timezone,
    header: { description: header.description ?? null, key: header.key, checks: header.checks, warnings: header.warnings },
    ast: normalizeAst(ast),
  });
  return new Bun.CryptoHasher("sha256").update(material).digest("hex");
}

function normalizeAst(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeAst);
  if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "query_location") continue;
    out[k] = k.endsWith("_name") && typeof x === "string" ? asciiLower(x) : normalizeAst(x);
  }
  return out;
}

// ---- Serializing ------------------------------------------------------------------------------------------

/** The statement's AST when `sql` is exactly one statement json_serialize_sql accepts, else null (the gate
 *  says why). Integers beyond 2^53 come back as bigint. */
async function serializeOne(conn: DuckDBConnection, sql: string): Promise<SelectAst | null> {
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)", [sql]);
  const text = String(reader.getRowsJS()[0]?.[0] ?? "{}");
  const s = JSON.parse(finiteJson(text), losslessReviver as (this: unknown, key: string, value: unknown) => unknown) as { error?: boolean; statements?: SelectAst[] };
  return !s.error && s.statements?.length === 1 ? s.statements[0]! : null;
}

// ---- Locations --------------------------------------------------------------------------------------------

/** Positions in the body (DuckDB's code points, or a JS string index) as the file's line and column. */
class Locator {
  constructor(readonly body: string, readonly file: string, readonly lineOffset: number) {}

  /** A DuckDB position (code points into the body). */
  at(pos?: number): { file: string; line?: number; column?: number } {
    if (pos === undefined) return { file: this.file };
    const p = lineColumn(this.body, pos);
    return { file: this.file, line: p.line + this.lineOffset, column: p.column };
  }

  /** A JS string index into the body. */
  atIndex(index: number): { file: string; line?: number; column?: number } {
    return this.at(Array.from(this.body.slice(0, index)).length);
  }
}

// ---- PIVOT without IN -------------------------------------------------------------------------------------

/** A token of lexSql: a bare word (keyword or name), a quoted name, `(`, `)` or `,`, or anything else (a
 *  string, a number, an operator). `index` is a JS string index; `depth` counts the parentheses around it. */
export interface SqlToken { kind: "word" | "name" | "punct" | "other"; text: string; index: number; depth: number }
type Token = SqlToken;

const WORD = /[A-Za-z0-9_$\u0080-\uffff]+/y;
const DOLLAR = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** The `$tag$` (or `$$`) opening a dollar-quoted string at `i`, or null ($1 is a parameter). */
function dollarTag(sql: string, i: number): string | null {
  DOLLAR.lastIndex = i;
  return DOLLAR.exec(sql)?.[0] ?? null;
}

/** The tokens DuckDB would see, without comments, and how many statements the text holds (non-empty runs
 *  between semicolons). Knows '' and E'' strings, "" names, $tag$ strings, and nested block comments. */
export function lexSql(sql: string): { tokens: SqlToken[]; statements: number } {
  const tokens: Token[] = [];
  let depth = 0;
  let statements = 0;
  let open = false;
  let i = 0;
  const n = sql.length;
  const push = (kind: Token["kind"], start: number, end: number) => {
    if (!open) {
      open = true;
      statements++;
    }
    tokens.push({ kind, text: sql.slice(start, end), index: start, depth });
    i = end;
  };
  while (i < n) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      let nest = 1;
      i += 2;
      while (i < n && nest > 0) {
        if (sql.startsWith("/*", i)) { nest++; i += 2; } else if (sql.startsWith("*/", i)) { nest--; i += 2; } else i++;
      }
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === ";") {
      open = false;
      i++;
    } else if (c === "'" || ((c === "E" || c === "e") && sql[i + 1] === "'")) {
      const escapes = c !== "'";
      let j = escapes ? i + 2 : i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      push("other", i, Math.min(j + 1, n));
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      push("name", i, Math.min(j + 1, n));
    } else if (c === "$" && dollarTag(sql, i)) {
      const tag = dollarTag(sql, i)!;
      const close = sql.indexOf(tag, i + tag.length);
      push("other", i, close < 0 ? n : close + tag.length);
    } else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      WORD.lastIndex = i;
      WORD.exec(sql);
      push("word", i, WORD.lastIndex);
    } else if (c === "(") {
      push("punct", i, i + 1);
      depth++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      push("punct", i, i + 1);
    } else if (c === ",") {
      push("punct", i, i + 1);
    } else {
      push("other", i, i + 1);
    }
  }
  return { tokens, statements };
}

interface PivotWithoutValues {
  /** JS string index of the ON item that lists no values, else of the PIVOT keyword. */
  index: number;
  /** The ON item as written ("product"), when found. */
  column?: string;
}

const PIVOT_WORDS = new Set(["pivot", "pivot_wider"]);
// Words that end a PIVOT statement's ON list.
const ON_LIST_END = new Set(["using", "group", "order", "limit", "offset", "union", "except", "intersect", "qualify", "window", "having", "where"]);

/** A PIVOT whose columns depend on the data, or null. DuckDB's statement count decides; the lexer only finds
 *  where it is. */
async function pivotWithoutValues(conn: DuckDBConnection, sql: string): Promise<PivotWithoutValues | null> {
  const lexed = lexSql(sql);
  const pivots = lexed.tokens.filter((t) => t.kind === "word" && PIVOT_WORDS.has(asciiLower(t.text)));
  if (!pivots.length) return null;
  let count: number;
  try {
    count = (await conn.extractStatements(sql)).count;
  } catch {
    return null;                                     // a syntax error: the gate reports it
  }
  if (count <= lexed.statements) return null;
  for (const p of pivots) {
    const item = onItemWithoutValues(lexed.tokens, lexed.tokens.indexOf(p), sql);
    if (item) return item;
  }
  return { index: pivots[0]!.index };
}

/** The first item of a PIVOT's ON list with no `IN (<values>)` (or with `IN (SELECT ...)`), or null. */
function onItemWithoutValues(tokens: Token[], from: number, sql: string): PivotWithoutValues | null {
  const depth = tokens[from]!.depth;
  let k = from + 1;
  const word = (t: Token | undefined, w: string) => t?.kind === "word" && asciiLower(t.text) === w;
  const query = (t: Token | undefined) => word(t, "select") || word(t, "from") || word(t, "with");
  // FROM t PIVOT (agg FOR col IN (...)) requires IN; an ON after it belongs to a join. PIVOT (SELECT ...) ON
  // col is a pivot over a subquery, whose own ONs sit deeper.
  if (tokens[k]?.text === "(" && !query(tokens[k + 1])) return null;
  while (k < tokens.length && !(tokens[k]!.depth === depth && word(tokens[k], "on"))) {
    if (tokens[k]!.depth < depth) return null;
    k++;
  }
  k++;
  let start = k;
  let inAt = -1;                                     // the item's IN at this depth
  let hasValues = false;
  const done = (end: number): PivotWithoutValues | null => {
    if (start >= end || hasValues) return null;
    const last = tokens[(inAt > start ? inAt : end) - 1]!;
    return { index: tokens[start]!.index, column: sql.slice(tokens[start]!.index, last.index + last.text.length).trim() };
  };
  for (; k < tokens.length; k++) {
    const t = tokens[k]!;
    // An enclosing `)` is at a lower depth; the ones inside the list close at this depth.
    if (t.depth < depth || (t.depth === depth && t.kind === "word" && ON_LIST_END.has(asciiLower(t.text)))) break;
    if (t.depth !== depth) continue;
    if (t.text === ",") {
      const missing = done(k);
      if (missing) return missing;
      start = k + 1;
      inAt = -1;
      hasValues = false;
    } else if (word(t, "in")) {
      inAt = k;
      hasValues = !(tokens[k + 1]?.text === "(" && query(tokens[k + 2]));
    }
  }
  return done(k);
}

function pivotProblem(p: PivotWithoutValues, at: Locator): Problem {
  const on = p.column ?? "product";
  return problem("PIVOT_NEEDS_VALUES", {
    message: p.column
      ? `PIVOT ... ON ${on} lists no values, so its columns depend on the data; croft cannot check or plan it`
      : "a PIVOT lists no values (IN (...)), so its columns depend on the data; croft cannot check or plan it",
    hint: `list the values: ON ${on} IN ('pro', 'basic'), or use sum(x) FILTER (WHERE ${on} = 'pro')`,
    ...at.atIndex(p.index),
    fix: { kind: "edit", description: `list the values the pivot makes columns of: ON ${on} IN ('a', 'b')`, file: at.file, ...lineOf(at.atIndex(p.index)) },
    ...(p.column ? { details: { column: p.column } } : {}),
  });
}

const lineOf = (w: { line?: number }) => (w.line !== undefined ? { line: w.line } : {});

// ---- Files, SHOW, prefixes, volatile functions ------------------------------------------------------------

interface FileRead { shown: string; paths: string[]; at?: number }

/** Where the statement reads files: a path in FROM (`FROM 'files/x.csv'`, a replacement scan), a file table
 *  function (read_csv, read_parquet, glob, ...; the gate's "path" kind), or a table macro given a path
 *  (`histogram('files/x.csv', a)`: collect() reports its table as a relation `via` the macro). */
function fileReads(ast: unknown): FileRead[] {
  const out: FileRead[] = [];
  for (const u of collect(ast).uses) {
    if (u.kind === "relation" && looksLikePath(u.name)) {
      out.push({ shown: u.via ? `${u.via}('${u.name}')` : `'${u.name}'`, paths: [u.name], ...(u.at !== undefined ? { at: u.at } : {}) });
    } else if (u.kind === "table_function" && TABLE_FUNCTIONS.get(asciiLower(u.name)) === "path") {
      const paths = literalStrings((u.fn.children as AstNode[] | undefined)?.[0]);
      out.push({ shown: `${u.name}(${paths.map((p) => `'${p}'`).join(", ")})`, paths, ...(u.at !== undefined ? { at: u.at } : {}) });
    }
  }
  return out;
}

/** 'a' or ['a', 'b'] as strings; anything else none. */
function literalStrings(n: AstNode | undefined): string[] {
  if (n?.class === "CONSTANT") {
    const v = n.value as { is_null?: boolean; value?: unknown } | undefined;
    return v && !v.is_null && typeof v.value === "string" ? [v.value] : [];
  }
  if (n?.class === "FUNCTION" && asciiLower(stringOf(n.function_name)) === "list_value" && Array.isArray(n.children)) {
    return (n.children as AstNode[]).flatMap(literalStrings);
  }
  return [];
}

function readsFilesProblem(f: FileRead, asset: string, assetNames: readonly string[], at: Locator): Problem {
  const base = f.paths.map((p) => p.split(/[\\/]/).pop()!.replace(/\..*$/, "").toLowerCase()).find((b) => assetNames.includes(b));
  const ingest = `croft new file ${fileIngestName(f.paths)}`;
  return problem("SQL_READS_FILES", {
    message: `${asset} reads ${f.shown} directly; croft cannot tell when a file changed, so the table would go stale`,
    hint: base
      ? `read the table instead: FROM ${base}`
      : `load the file with a file ingest (${ingest} writes one; point its file: at the file), then read its table by name`,
    ...at.at(f.at),
    fix: base
      ? { kind: "edit", description: `read the table ${base} instead of ${f.shown}`, file: at.file, ...lineOf(at.at(f.at)) }
      : { kind: "command", description: "write a file ingest for the file, point its file: at it, then read its table by name", command: ingest },
    details: { files: f.paths },
  });
}

/** A name for the file ingest of `paths`: the first file's name, or its folder's for a glob ("files/sales/*.csv" →
 *  sales), made a valid asset name. */
function fileIngestName(paths: readonly string[]): string {
  const parts = (paths[0] ?? "").split(/[\\/]/).filter(Boolean);
  let last = parts.pop() ?? "";
  if (/[*?[{]/.test(last)) last = parts.pop() ?? "";
  return suggestName(last.replace(/\..*$/, ""));
}

/** The DESCRIBE, SUMMARIZE or SHOW in the statement (a SHOW_REF node, which has no position), or null. */
function showStatement(ast: unknown): string | null {
  let found: string | null = null;
  walk(ast, (node) => {
    if (found || node.type !== "SHOW_REF") return;
    const kind = stringOf(node.show_type);
    found = kind === "SUMMARY" ? "SUMMARIZE" : kind === "DESCRIBE" ? "DESCRIBE" : "SHOW";
  });
  return found;
}

function showProblem(shown: string, at: Locator): Problem {
  return problem("SQL_NOT_SELECT", {
    message: `${shown} looks at the database's catalog; an SQL asset is one SELECT that builds a table`,
    hint: "write the SELECT that computes what you need (e.g. SELECT count(*), min(x), max(x) FROM t); use croft query to look around",
    file: at.file,
  });
}

function prefixProblem(p: { shown: string; name: string; at?: number }, assetNames: readonly string[], body: string, at: Locator): Problem {
  const bare = asciiLower(p.name);
  const isAsset = assetNames.includes(bare);
  const written = p.at !== undefined ? qualifiedNameAt(body, p.at) : null;
  const where = at.at(p.at);
  return problem("CATALOG_PREFIX", {
    message: isAsset
      ? `${p.shown} names the table ${bare} through a prefix; croft keeps every table in the project's main schema and tracks inputs by plain name`
      : `${p.shown} is outside the project's tables; an SQL asset reads only those, by plain name, so croft can track its inputs`,
    hint: isAsset ? `drop the prefix: FROM ${bare}` : "read one of the project's tables by its plain name",
    ...where,
    fix: {
      kind: "edit",
      description: isAsset ? `drop the prefix: ${bare}` : `replace ${p.shown} with one of the project's tables`,
      file: at.file, ...lineOf(where),
      ...(isAsset && written ? { replace: { from: written.text, to: written.last } } : {}),
    },
    details: { table: p.shown },
  });
}

/** The qualified name written at a DuckDB position (`Other . "Main".orders`), and its last part as written. */
function qualifiedNameAt(body: string, pos: number): { text: string; last: string } | null {
  const start = Array.from(body).slice(0, pos).join("").length;
  const part = /^(?:"(?:[^"]|"")*"|[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)/;
  let i = start;
  let last = "";
  for (;;) {
    const m = part.exec(body.slice(i));
    if (!m) return null;
    last = m[0];
    i += m[0].length;
    const dot = /^\s*\.\s*/.exec(body.slice(i));
    if (!dot) break;
    i += dot[0].length;
  }
  const text = body.slice(start, i);
  return text === last ? null : { text, last };
}

function volatileProblem(asset: string, uses: { shown: string; at?: number }[], at: Locator): Problem {
  const names = uses.map((u) => u.shown);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return problem("VOLATILE_SQL", {
    message: `${list} ${names.length === 1 ? "gives" : "give"} a different value on every run; ${asset} keeps the values of its last rebuild, which happens only when an input or its SQL changes`,
    hint: "compute such columns when you read the table (croft query, or your app), or keep them if a build-time value is what you want",
    ...at.at(uses[0]!.at),
    details: { functions: names },
  });
}

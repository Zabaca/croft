// The check language (DESIGN.md §3f): the same in TypeScript (`checks`, `warnings`) and SQL (`-- check:`,
// `-- warn:`). `unique(a, b)`, `not_null(a, b)`, `min_rows(n)`, or any boolean SQL expression (a row rule;
// NULL passes, combine it with not_null). A key implies unique(key) and not_null(key).
//
// Every check is parsed before use: `SELECT (<expr>) FROM <asset>` through json_serialize_sql must give exactly
// one statement with one select item (CHECK_INVALID otherwise), identifiers are quoted with `"` escaping, and
// every statement croft builds runs through prepare(), which takes a single statement. Concatenating a check
// into a multi-statement run() would execute an embedded `; DROP TABLE …` [V].
//
// Two passes:
// - parseChecks works on the text alone (no DuckDB), so the planner and the graph get every check's kind,
//   scope, SQL and the tables its subqueries read (they order the asset, §3f) without a connection. It already
//   refuses what cannot be one expression: an unbalanced parenthesis or quote, a `;`, a top-level comma, a
//   check-language form inside a larger expression, a malformed unique/not_null/min_rows, a near miss such as
//   `notnull(a)` (did-you-mean).
// - validateChecks asks DuckDB's parser (json_serialize_sql on any connection; nothing is bound or run). The
//   probe must come back as exactly the statement croft built: one SELECT_NODE, one select item, FROM the asset
//   and nothing else, so text that closes the parenthesis and appends clauses or statements is refused. The
//   AST is then walked like the query gate's (sql/gate.ts): a check reads tables only, so file paths, table
//   functions that read files or run SQL given as a string, functions with side effects, and parameters are
//   CHECK_INVALID. checks/run.ts repeats this vetting on the write transaction before it evaluates a rule, so a
//   check that skipped validate is still never concatenated into anything unvetted.
//
// Check.sql per kind (what checks/run.ts evaluates):
//   unique, not_null   the columns, each double-quoted with `"` doubled: `"a", "b"`
//   min_rows           the row count, as decimal digits: `100`
//   rule               the expression as written, trimmed (a trailing `--` comment is allowed: croft puts the
//                      expression on its own lines)
import type { DuckDBConnection } from "@duckdb/node-api";
import { problem } from "../core/errors.ts";
import type { Check, Problem } from "../core/types.ts";
import { quoteIdent } from "../load/evolve.ts";
import { editDistance } from "../project/suggest.ts";
import { asciiLower, type AstNode, collect, looksLikePath, relationNames } from "../sql/ast.ts";
import { TABLE_FUNCTIONS } from "../sql/gate.ts";

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

/** The forms of the check language that are not row rules. */
export const CHECK_FORMS = ["unique", "not_null", "min_rows"] as const;

const LANGUAGE_HINT = "a check is unique(a, b), not_null(a, b), min_rows(n), or one boolean SQL expression over the asset's columns";

/** Checks as croft runs them (core/types.ts Check: kind, scope, the SQL, the tables a subquery reads), without
 *  DuckDB. What does not parse is CHECK_INVALID, and is left out of `checks`. */
export function parseChecks(i: ParseChecksInput): { checks: Check[]; problems: Problem[] } {
  const checks: Check[] = [];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const add = (c: Check) => {
    const id = `${c.kind}\u0000${c.sql}`;
    if (seen.has(id)) return;                   // a declared unique(id) next to key id, or a check listed twice
    seen.add(id);
    checks.push(c);
  };
  const key = i.key.filter((k) => k.trim() !== "");
  if (key.length) {
    const cols = key.map(displayIdent).join(", ");
    const sql = key.map(quoteIdent).join(", ");
    add({ source: `unique(${cols})`, kind: "unique", blocking: true, scope: "table", sql, reads: [] });
    add({ source: `not_null(${cols})`, kind: "not_null", blocking: true, scope: "batch", sql, reads: [] });
  }
  const one = (text: string, blocking: boolean) => {
    const r = parseOne(text, blocking, i.asset);
    if ("check" in r) add(r.check);
    else problems.push(invalid(i.asset, i.file, text, blocking, r.why, r.hint, r.fix));
  };
  for (const c of i.checks) one(c, true);
  for (const w of i.warnings) one(w, false);
  return { checks, problems };
}

/** CHECK_INVALID for each check whose `SELECT (<expr>) FROM <asset>` is not exactly one statement with one select
 *  item (json_serialize_sql on `conn`, which needs no tables); [] when all are valid.
 *  @param o.file root-relative, for the problems' location. */
export async function validateChecks(conn: DuckDBConnection, asset: string, checks: readonly Check[], o: { file?: string } = {}): Promise<Problem[]> {
  return (await analyzeChecks(conn, asset, checks, o)).problems;
}

/**
 * validateChecks, keeping what passed: the valid checks with `reads` taken from DuckDB's AST (sql/ast.ts
 * relationNames: main-schema tables, CTE names excluded, the asset itself left out), which is exact where
 * parseChecks' lexical reading is a close estimate. For resolving a project, where a connection is at hand.
 */
export async function analyzeChecks(conn: DuckDBConnection, asset: string, checks: readonly Check[], o: { file?: string } = {}): Promise<{ checks: Check[]; problems: Problem[] }> {
  const serialize = async (sql: string) => {
    const reader = await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR)::VARCHAR", [sql]);
    return String(reader.getRowsJS()[0]?.[0] ?? "{}");
  };
  const out: Check[] = [];
  const problems: Problem[] = [];
  for (const c of checks) {
    const v = await vetCheck(serialize, asset, c);
    if (v.ok) out.push({ ...c, reads: v.reads });
    else problems.push(invalid(asset, o.file, c.source, c.blocking, v.why, v.hint));
  }
  return { checks: out, problems };
}

// ---------------------------------------------------------------------------------------------------------
// Vetting one check with DuckDB's parser (shared with checks/run.ts)

/** `SELECT (<expr>) FROM <asset>`, the expression on its own lines so a trailing `--` comment ends there. */
export function probeSql(asset: string, expr: string): string {
  return `SELECT (\n${expr}\n) FROM ${quoteIdent(asset)}`;
}

export type Vetting = { ok: true; reads: string[] } | { ok: false; why: string; hint: string };

/**
 * Whether a check is safe and well-formed, with the tables its rule reads. `serialize` returns
 * json_serialize_sql's text for a statement (on any connection: it parses, never binds or runs). Rules go through
 * DuckDB's parser; the other forms only need their croft-made SQL to have the documented shape.
 */
export async function vetCheck(serialize: (sql: string) => Promise<string>, asset: string, c: Check): Promise<Vetting> {
  const bad = (why: string, hint = LANGUAGE_HINT): Vetting => ({ ok: false, why, hint });
  if (c.kind === "unique" || c.kind === "not_null") {
    return checkColumns(c) ? { ok: true, reads: [] } : bad("names no columns croft can read");
  }
  if (c.kind === "min_rows") return minRowsOf(c) === null ? bad("needs a whole number of rows") : { ok: true, reads: [] };
  const kind: string = c.kind;
  if (kind !== "rule") return bad(`has an unknown kind ${JSON.stringify(kind)}`);
  const lexical = lexicalProblem(c.sql);
  if (lexical) return bad(lexical.why, lexical.hint);
  let parsed: { error?: boolean; error_message?: string; statements?: { node?: AstNode; named_param_map?: unknown }[] };
  try {
    parsed = JSON.parse(await serialize(probeSql(asset, c.sql))) as typeof parsed;
  } catch (e) {
    return bad(`could not be parsed: ${firstLine(e)}`);
  }
  if (parsed.error) return bad(`does not parse: ${String(parsed.error_message ?? "syntax error")}`, "write one SQL expression, e.g. amount >= 0");
  const stmts = parsed.statements ?? [];
  if (stmts.length !== 1) return bad(`is ${stmts.length} statements, not one expression`, "write one SQL expression; croft adds the SELECT itself");
  const node = stmts[0]!.node;
  const shape = selectShape(node, asset);
  if (shape) return bad(shape, "write one SQL expression; croft adds the SELECT itself");
  const item = (node!.select_list as AstNode[])[0]!;
  if (item.class === "FUNCTION" && asciiLower(String(item.function_name ?? "")) === "row") {
    return bad("is a list of values, not one condition", "write one condition per check, or join conditions with AND");
  }
  if (hasParameter(stmts[0]!)) return bad("uses a parameter ($1 or ?); a check has none", "write the value into the check");
  for (const u of collect(node).uses) {
    if (u.kind === "relation" && looksLikePath(u.name)) {
      return bad(`reads the file ${u.name}; a check reads tables only`, "load the file with a file ingest (croft docs ingest), then name its table");
    }
    if (u.kind === "table_function") {
      const kind = TABLE_FUNCTIONS.get(asciiLower(u.name));
      if (kind !== "serve" && kind !== "local" && kind !== "table") {
        return bad(`calls ${u.name}(), which a check may not use (it reads files, runs SQL given as text, or changes DuckDB)`,
          "read the project's tables by name in a subquery");
      }
    }
    if (u.kind === "scalar" && asciiLower(u.name) === "write_log") return bad("calls write_log(), which writes to DuckDB's log", "remove it");
  }
  const self = asciiLower(asset);
  return { ok: true, reads: relationNames(node).filter((t) => t !== self) };
}

/** Why the probe's statement is not exactly `SELECT (<one item>) FROM <asset>`, or null when it is. */
function selectShape(node: AstNode | undefined, asset: string): string | null {
  const notOne = "is not one expression: the text around it would change the statement";
  if (!node || node.type !== "SELECT_NODE") return notOne;
  const list = node.select_list;
  if (!Array.isArray(list) || list.length !== 1) return `is ${Array.isArray(list) ? list.length : 0} expressions, not one`;
  const from = node.from_table as AstNode | null | undefined;
  if (!from || from.type !== "BASE_TABLE" || from.table_name !== asset || (from.schema_name ?? "") !== "" || (from.catalog_name ?? "") !== ""
    || (from.alias ?? "") !== "" || from.sample != null) return notOne;
  const empty = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0);
  const ctes = (node.cte_map as { map?: unknown[] } | undefined)?.map;
  if (!empty(node.where_clause) || !empty(node.group_expressions) || !empty(node.group_sets) || !empty(node.having)
    || !empty(node.qualify) || !empty(node.sample) || !empty(node.modifiers) || !empty(ctes)) return notOne;
  if (node.aggregate_handling !== undefined && node.aggregate_handling !== "STANDARD_HANDLING") return notOne;
  return null;
}

function hasParameter(stmt: { node?: AstNode; named_param_map?: unknown }): boolean {
  if (Array.isArray(stmt.named_param_map) && stmt.named_param_map.length > 0) return true;
  const stack: unknown[] = [stmt.node];
  while (stack.length) {
    const n = stack.pop();
    if (Array.isArray(n)) stack.push(...n);
    else if (n && typeof n === "object") {
      if ((n as AstNode).class === "PARAMETER") return true;
      stack.push(...Object.values(n));
    }
  }
  return false;
}

/** The column names of a unique or not_null check (from Check.sql, a list of double-quoted identifiers), or
 *  null when Check.sql is not such a list. */
export function checkColumns(c: Pick<Check, "kind" | "sql">): string[] | null {
  if (c.kind !== "unique" && c.kind !== "not_null") return null;
  const out: string[] = [];
  const re = /\s*"((?:[^"]|"")*)"\s*(,|$)/y;
  let at = 0;
  const text = c.sql;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m || m[1] === "") return null;
    out.push(m[1]!.replaceAll('""', '"'));
    at = re.lastIndex;
    if (m[2] === "") break;
  }
  return out.length && at >= text.length ? out : null;
}

/** min_rows' n (from Check.sql), or null when Check.sql is not decimal digits. */
export function minRowsOf(c: Pick<Check, "kind" | "sql">): number | null {
  if (c.kind !== "min_rows" || !/^\d{1,15}$/.test(c.sql)) return null;
  return Number(c.sql);
}

// ---------------------------------------------------------------------------------------------------------
// The text pass

type Parsed = { check: Check } | { why: string; hint: string; fix?: { from: string; to: string } };

function parseOne(raw: string, blocking: boolean, asset: string): Parsed {
  const text = raw.trim();
  if (!text) return { why: "is empty", hint: LANGUAGE_HINT };
  const toks = tokenize(text);
  if ("error" in toks) return { why: toks.error, hint: LANGUAGE_HINT };
  const t = toks.tokens;
  const lexical = lexicalProblem(text, t);
  if (lexical) return lexical;
  const first = t[0]!;
  // The whole check is one call `name(…)`: a form of the check language, or a near miss of one.
  const head = first.kind === "ident" && !first.quoted && t[1]?.text === "(" && toks.match.get(1) === t.length - 1 ? first : null;
  const form = head ? CHECK_FORMS.find((f) => f === head.lower) : undefined;
  if (form) {
    const args = splitArgs(t.slice(2, t.length - 1));
    if (form === "min_rows") {
      const a = args[0];
      const digits = a?.length === 1 && a[0]!.kind === "number" ? a[0]!.text.replaceAll("_", "") : "";
      if (args.length !== 1 || !/^\d{1,15}$/.test(digits)) {
        return { why: "needs one whole number of rows, e.g. min_rows(100)", hint: "min_rows(n) fails when the table has fewer than n rows" };
      }
      return { check: { source: text, kind: "min_rows", blocking, scope: "table", sql: String(Number(digits)), reads: [] } };
    }
    const cols: string[] = [];
    for (const a of args) {
      if (a.length !== 1 || a[0]!.kind !== "ident") {
        return { why: `takes column names only, e.g. ${form}(a, b)`, hint: `${form}() lists columns; write a condition on them as its own check` };
      }
      cols.push(a[0]!.name);
    }
    if (!cols.length) return { why: `names no columns, e.g. ${form}(id)`, hint: `${form}() lists the columns it covers` };
    return {
      check: { source: text, kind: form, blocking, scope: form === "unique" ? "table" : "batch", sql: cols.map(quoteIdent).join(", "), reads: [] },
    };
  }
  // A check-language form inside a larger expression: DuckDB has no such function.
  for (let k = 0; k < t.length - 1; k++) {
    const x = t[k]!;
    if (x.kind === "ident" && !x.quoted && t[k + 1]!.text === "(" && (CHECK_FORMS as readonly string[]).includes(x.lower)) {
      return { why: `uses ${x.lower}() inside a larger expression; ${x.lower}() is a check on its own`, hint: `write ${x.lower}(…) as a separate check` };
    }
  }
  // A near miss of a form: `notnull(author)` is not a function, and would fail only when the check runs.
  if (head && head.lower.length >= 5) {
    const near = CHECK_FORMS.find((f) => editDistance(head.lower, f) <= 2);
    if (near) {
      const to = `${near}${text.slice(head.text.length)}`;
      return { why: `calls ${head.text}(), which is not part of the check language; did you mean ${near}?`, hint: `write ${to}`, fix: { from: text, to } };
    }
  }
  const self = asciiLower(asset);
  return { check: { source: text, kind: "rule", blocking, scope: "batch", sql: text, reads: lexicalReads(t, toks.match).filter((n) => n !== self) } };
}

/** What makes a rule's text impossible as one expression, before any parser sees it. */
function lexicalProblem(text: string, known?: Token[]): { why: string; hint: string } | null {
  let t = known;
  if (!t) {
    const r = tokenize(text);
    if ("error" in r) return { why: r.error, hint: LANGUAGE_HINT };
    t = r.tokens;
  }
  if (!t.length) return { why: "is empty", hint: LANGUAGE_HINT };
  if (t.some((x) => x.text === ";")) return { why: "contains ;, but a check is one expression", hint: "remove the ; (write two checks for two conditions)" };
  let depth = 0;
  for (const x of t) {
    if (x.text === "(" || x.text === "[" || x.text === "{") depth++;
    else if (x.text === ")" || x.text === "]" || x.text === "}") depth--;
    else if (x.text === "," && depth === 0) {
      return { why: "lists several expressions; a check is one condition", hint: "write one check per condition, or join them with AND" };
    }
  }
  return null;
}

function invalid(asset: string, file: string | undefined, text: string, blocking: boolean, why: string, hint: string, fix?: { from: string; to: string }): Problem {
  const label = blocking ? "check" : "warning";
  return problem("CHECK_INVALID", {
    asset, file,
    message: `${asset}: the ${label} ${JSON.stringify(text.trim())} ${why}`,
    hint,
    ...(fix && file ? { fix: { kind: "edit" as const, description: `replace ${fix.from} with ${fix.to}`, file, replace: fix } } : {}),
    details: { check: text.trim(), blocking },
  });
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!;

/** A column name as a check's source shows it: bare when it is a plain lower-case identifier, else quoted. */
function displayIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : quoteIdent(name);
}

// ---------------------------------------------------------------------------------------------------------
// A small SQL tokenizer: enough to find expression boundaries, identifiers and table names in check text.

export type Token =
  | { kind: "ident"; text: string; name: string; lower: string; quoted: boolean; at: number }
  | { kind: "string" | "number" | "param" | "punct"; text: string; at: number };

const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uffff]/;

/**
 * Tokens of an SQL fragment without whitespace and comments, and the index of each `(`'s matching `)`.
 * Strings ('…' with '' doubled; E'…' with backslash escapes; $tag$…$tag$), quoted identifiers ("…" with ""
 * doubled) and nested block comments are single tokens or skipped whole. An unterminated one, or an unbalanced
 * bracket, is an error in words.
 */
export function tokenize(sql: string): { tokens: Token[]; match: Map<number, number> } | { error: string } {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; } else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; } else j++;
      }
      if (depth > 0) return { error: "has a /* comment that never ends" };
      i = j;
      continue;
    }
    if (c === "'") {
      const end = quotedEnd(sql, i, "'", false);
      if (end < 0) return { error: "has a string that never ends (a ' is missing)" };
      tokens.push({ kind: "string", text: sql.slice(i, end), at: i });
      i = end;
      continue;
    }
    if (c === '"') {
      const end = quotedEnd(sql, i, '"', false);
      if (end < 0) return { error: 'has a quoted name that never ends (a " is missing)' };
      const text = sql.slice(i, end);
      const name = text.slice(1, -1).replaceAll('""', '"');
      tokens.push({ kind: "ident", text, name, lower: asciiLower(name), quoted: true, at: i });
      i = end;
      continue;
    }
    if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) return { error: `has a ${tag[0]} string that never ends` };
        tokens.push({ kind: "string", text: sql.slice(i, close + tag[0].length), at: i });
        i = close + tag[0].length;
        continue;
      }
      const p = /^\$[A-Za-z0-9_]+/.exec(sql.slice(i));
      tokens.push({ kind: "param", text: p ? p[0] : "$", at: i });
      i += p ? p[0].length : 1;
      continue;
    }
    if (c === "?") {
      tokens.push({ kind: "param", text: "?", at: i });
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const m = /^(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i))!;
      tokens.push({ kind: "number", text: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      // E'…' (backslash escapes), X'…', B'…', N'…': one string token.
      if (sql[j] === "'" && /^[ebxn]$/i.test(word)) {
        const end = quotedEnd(sql, j, "'", /^e$/i.test(word));
        if (end < 0) return { error: "has a string that never ends (a ' is missing)" };
        tokens.push({ kind: "string", text: sql.slice(i, end), at: i });
        i = end;
        continue;
      }
      tokens.push({ kind: "ident", text: word, name: word, lower: asciiLower(word), quoted: false, at: i });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", text: c, at: i });
    i++;
  }
  const match = new Map<number, number>();
  const open: { at: number; ch: string }[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const [k, t] of tokens.entries()) {
    if (t.kind !== "punct") continue;
    if (t.text === "(" || t.text === "[" || t.text === "{") open.push({ at: k, ch: t.text });
    else if (pairs[t.text]) {
      const o = open.pop();
      if (!o || o.ch !== pairs[t.text]) return { error: `has a ${t.text} without its ${pairs[t.text]}` };
      match.set(o.at, k);
    }
  }
  if (open.length) return { error: `has a ${open[open.length - 1]!.ch} that is never closed` };
  return { tokens, match };
}

/** Index just past a quoted token that starts at `start` (its opening quote), or -1 when it never ends. */
function quotedEnd(sql: string, start: number, q: string, backslash: boolean): number {
  let j = start + 1;
  while (j < sql.length) {
    const ch = sql[j]!;
    if (backslash && ch === "\\") { j += 2; continue; }
    if (ch === q) {
      if (sql[j + 1] === q) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return -1;
}

/** Top-level comma-separated groups of tokens. */
function splitArgs(t: Token[]): Token[][] {
  if (!t.length) return [];
  const out: Token[][] = [[]];
  let depth = 0;
  for (const x of t) {
    if (x.text === "(" || x.text === "[" || x.text === "{") depth++;
    else if (x.text === ")" || x.text === "]" || x.text === "}") depth--;
    if (x.text === "," && x.kind === "punct" && depth === 0) out.push([]);
    else out[out.length - 1]!.push(x);
  }
  return out;
}

// Words that end a table reference's alias (or start the next clause).
const CLAUSE = new Set(["where", "group", "having", "order", "limit", "offset", "join", "inner", "left", "right", "full", "outer",
  "cross", "natural", "on", "using", "union", "except", "intersect", "window", "qualify", "positional", "asof", "anti", "semi",
  "lateral", "pivot", "unpivot", "sample", "tablesample", "select", "from", "returning", "fetch", "for", "with", "values", "as"]);

/**
 * The tables a rule's subqueries read, from its tokens: names after a query's FROM (in a parenthesized group that
 * has a SELECT before it, or that starts with FROM: DuckDB's FROM-first form) or after JOIN, in the main schema
 * (bare or `main.x`), without table functions, file paths or CTE names; ASCII-lowercased, unique, in text order.
 * `extract(year FROM d)`, `substring(s FROM 2)`, `trim(x FROM s)` and `IS DISTINCT FROM` are not queries.
 */
export function lexicalReads(t: Token[], match: Map<number, number>): string[] {
  type Ident = Extract<Token, { kind: "ident" }>;
  const found: { name: string; at: number }[] = [];
  const ctes = new Set<string>();
  const kw = (x: Token | undefined, ...words: string[]) => x?.kind === "ident" && !x.quoted && words.includes(x.lower);
  // A name that can be a table or an alias: any identifier but a word that starts the next clause.
  const word = (x: Token | undefined): x is Ident => x?.kind === "ident" && (x.quoted || !CLAUSE.has(x.lower));
  const past = (j: number) => (match.get(j) ?? j) + 1;
  // CTE names: WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] (, and the same after a comma.
  for (let k = 0; k < t.length; k++) {
    const x = t[k]!;
    if (x.kind !== "ident" || !(kw(t[k - 1], "with", "recursive") || t[k - 1]?.text === ",")) continue;
    let j = k + 1;
    if (t[j]?.text === "(") j = past(j);
    if (!kw(t[j], "as")) continue;
    j++;
    if (kw(t[j], "not")) j++;
    if (kw(t[j], "materialized")) j++;
    if (t[j]?.text === "(") ctes.add(x.lower);
  }
  // The table references of one FROM or JOIN: `a [AS] x [(cols)], main.b, (subquery) s, fn(…) f, 'file'`.
  const refs = (from: number) => {
    let j = from;
    for (;;) {
      if (kw(t[j], "lateral")) j++;
      const x = t[j];
      if (!x) return;
      // A subquery: its own FROM is read where it stands; here it only needs skipping to what follows.
      if (x.kind === "punct" && x.text === "(") j = past(j);
      else if (x.kind === "string") j++;
      else if (word(x)) {
        const parts: Ident[] = [x];
        j++;
        while (t[j]?.text === "." && t[j + 1]?.kind === "ident") {
          parts.push(t[j + 1] as Ident);
          j += 2;
        }
        if (t[j]?.text === "(") j = past(j);                                       // a table function
        else {
          const name = parts.length === 1 ? parts[0]!.lower : parts.length === 2 && parts[0]!.lower === "main" ? parts[1]!.lower : null;
          if (name !== null && !ctes.has(name)) found.push({ name, at: x.at });
        }
      } else return;
      if (kw(t[j], "as")) j++;
      if (word(t[j])) {
        j++;
        if (t[j]?.text === "(") j = past(j);
      }
      if (t[j]?.text !== ",") return;
      j++;
    }
  };
  // Each parenthesized group, and whether it has seen SELECT.
  const groups: { start: number; select: boolean }[] = [{ start: 0, select: false }];
  for (let k = 0; k < t.length; k++) {
    const x = t[k]!;
    const g = groups[groups.length - 1]!;
    if (x.kind === "punct" && x.text === "(") groups.push({ start: k + 1, select: false });
    else if (x.kind === "punct" && x.text === ")") {
      if (groups.length > 1) groups.pop();
    } else if (kw(x, "select")) g.select = true;
    else if (kw(x, "from")) {
      const distinctFrom = kw(t[k - 1], "distinct") && kw(t[k - 2], "is", "not");
      if ((g.select || k === g.start) && !distinctFrom) refs(k + 1);
    } else if (kw(x, "join")) refs(k + 1);
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.name))];
}

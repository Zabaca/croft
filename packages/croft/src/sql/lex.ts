// A lexer for DuckDB's SQL that knows no grammar: the tokens DuckDB would see, without comments, with their
// parenthesis depth, and the items of a PIVOT's ON list. project/sql-asset.ts finds a PIVOT without IN with it
// (PIVOT_NEEDS_VALUES), the gate names one in its hint, and project/rename.ts rewrites names with it. It uses no
// Bun-only APIs, so read.ts can import it through gate.ts.
import { asciiLower } from "./ast.ts";

/** A token of lexSql: a bare word (keyword or name), a quoted name, `(`, `)` or `,`, or anything else (a
 *  string, a number, an operator). `index` is a JS string index; `depth` counts the parentheses around it. */
export interface SqlToken { kind: "word" | "name" | "punct" | "other"; text: string; index: number; depth: number }
type Token = SqlToken;

const WORD = /[A-Za-z0-9_$\u0080-\uffff]+/y;
const DOLLAR = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** The `$tag$` (or `$$`) opening a dollar-quoted string at `i`, or null ($1 is a parameter). */
export function dollarTag(sql: string, i: number): string | null {
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

export interface PivotWithoutValues {
  /** JS string index of the ON item that lists no values. */
  index: number;
  /** The ON item as written ("product"). */
  column: string;
}

export const PIVOT_WORDS: ReadonlySet<string> = new Set(["pivot", "pivot_wider"]);
// Words that end a PIVOT statement's ON list.
const ON_LIST_END = new Set(["using", "group", "order", "limit", "offset", "union", "except", "intersect", "qualify", "window", "having", "where"]);

/** The first item of a PIVOT's ON list with no `IN (<values>)` (or with `IN (SELECT ...)`), or null. */
export function onItemWithoutValues(tokens: Token[], from: number, sql: string): PivotWithoutValues | null {
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

/**
 * The first ON item of a PIVOT in `sql` that lists no values (`PIVOT t ON b`, or `ON b IN (SELECT ...)`), by the
 * text alone; null when there is none. DuckDB 2.0 counts such a PIVOT as one statement but cannot serialize it
 * ("Only SELECT statements can be serialized"): its columns depend on the data. Callers ask this only once DuckDB
 * has refused to serialize the statement for a reason other than its syntax.
 */
export function pivotWithoutValuesIn(sql: string): PivotWithoutValues | null {
  const { tokens } = lexSql(sql);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "word" || !PIVOT_WORDS.has(asciiLower(t.text))) continue;
    const item = onItemWithoutValues(tokens, i, sql);
    if (item) return item;
  }
  return null;
}

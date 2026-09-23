// DDL before DML (DESIGN.md §5 "One ingest step", step g). In one DuckDB transaction, an UPDATE, DELETE
// or MERGE on a table followed by ALTER TABLE ADD COLUMN / ALTER COLUMN TYPE on it fails only at COMMIT
// ("another transaction has altered this table") [V]. The Sql wrapper tracks which tables each transaction
// has written and throws DDL_AFTER_DML at the offending ALTER instead, where the stack trace is useful.
//
// Verified matrix (DuckDB 1.5.5): UPDATE/DELETE/MERGE then ADD COLUMN or ALTER TYPE fail at COMMIT;
// INSERT then ALTER, any DML then CREATE OR REPLACE or DROP, and tables created in the same transaction
// (temp or not) all commit. croft enforces the design's simpler invariant: no ALTER TABLE on a table
// after any DML on it in the same transaction, unless the table was created in that transaction.
import { StatementType } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";

type Tok = { kind: "word" | "ident" | "punct" | "string"; text: string };

// Enough of a lexer for croft's own statements: words, quoted identifiers, strings, punctuation.
function tokens(sql: string, max = 40): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length && out.length < max) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith("--", i)) { const n = sql.indexOf("\n", i); i = n < 0 ? sql.length : n + 1; continue; }
    if (sql.startsWith("/*", i)) { const n = sql.indexOf("*/", i + 2); i = n < 0 ? sql.length : n + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === c) {
          if (sql[j + 1] === c) { text += c; j += 2; continue; }
          j++;
          break;
        }
        text += sql[j++];
      }
      out.push({ kind: c === '"' ? "ident" : "string", text });
      i = j;
      continue;
    }
    const w = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/.exec(sql.slice(i, i + 256));
    if (w) { out.push({ kind: "word", text: w[0] }); i += w[0].length; continue; }
    out.push({ kind: "punct", text: c });
    i++;
  }
  return out;
}

const isWord = (t: Tok | undefined, ...words: string[]) => t?.kind === "word" && words.includes(t.text.toUpperCase());

/** Normalized table key: identifiers are case-insensitive in DuckDB, and an unqualified name is main.<t>. */
function qualifiedName(ts: Tok[], at: number): string | null {
  const parts: string[] = [];
  let i = at;
  for (;;) {
    const t = ts[i];
    if (!t || (t.kind !== "word" && t.kind !== "ident")) break;
    parts.push(t.text.toLowerCase());
    if (ts[i + 1]?.text !== ".") break;
    i += 2;
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? `main.${parts[0]}` : parts.join(".");
}

/** Skip a leading WITH ... clause (balanced parentheses) to the statement's main keyword. */
function skipWith(ts: Tok[]): number {
  if (!isWord(ts[0], "WITH")) return 0;
  let depth = 0;
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i]!;
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    else if (depth === 0 && isWord(t, "INSERT", "UPDATE", "DELETE", "MERGE", "SELECT")) return i;
  }
  return ts.length;
}

/** The table a statement writes, alters or creates, or null when it has none (or cannot be parsed). */
export function statementTarget(sql: string, type: StatementType): string | null {
  const ts = tokens(sql);
  let i = skipWith(ts);
  const skip = (...words: string[]) => { while (isWord(ts[i], ...words)) i++; };
  switch (type) {
    case StatementType.INSERT:
      if (!isWord(ts[i++], "INSERT")) return null;
      skip("OR", "REPLACE", "IGNORE");
      if (!isWord(ts[i++], "INTO")) return null;
      return qualifiedName(ts, i);
    case StatementType.UPDATE:
      if (!isWord(ts[i++], "UPDATE")) return null;
      return qualifiedName(ts, i);
    case StatementType.DELETE:
      if (isWord(ts[i], "TRUNCATE")) { i++; skip("TABLE"); return qualifiedName(ts, i); }
      if (!isWord(ts[i++], "DELETE") || !isWord(ts[i++], "FROM")) return null;
      return qualifiedName(ts, i);
    case StatementType.MERGE_INTO:
      if (!isWord(ts[i++], "MERGE") || !isWord(ts[i++], "INTO")) return null;
      return qualifiedName(ts, i);
    case StatementType.ALTER:
      if (!isWord(ts[i++], "ALTER") || !isWord(ts[i++], "TABLE")) return null;
      skip("IF", "EXISTS");
      return qualifiedName(ts, i);
    case StatementType.CREATE:
      if (!isWord(ts[i++], "CREATE")) return null;
      skip("OR", "REPLACE", "TEMP", "TEMPORARY");
      if (!isWord(ts[i++], "TABLE")) return null;
      skip("IF", "NOT", "EXISTS");
      return qualifiedName(ts, i);
    case StatementType.DROP:
      if (!isWord(ts[i++], "DROP") || !isWord(ts[i++], "TABLE")) return null;
      skip("IF", "EXISTS");
      return qualifiedName(ts, i);
    case StatementType.COPY: {
      // COPY <table> FROM '<file>' writes the table; COPY ... TO only reads.
      if (!isWord(ts[i++], "COPY")) return null;
      const name = qualifiedName(ts, i);
      if (!name) return null;
      while (ts[i] && !isWord(ts[i], "FROM", "TO")) i++;
      return isWord(ts[i], "FROM") ? name : null;
    }
    default:
      return null;
  }
}

const DML: ReadonlySet<StatementType> = new Set([
  StatementType.INSERT, StatementType.UPDATE, StatementType.DELETE, StatementType.MERGE_INTO, StatementType.COPY,
]);

/** Per-transaction record of written and created tables. */
export class TxGuard {
  private readonly written = new Map<string, string>(); // table → the first statement that wrote it
  private readonly created = new Set<string>();

  /** Throw DDL_AFTER_DML before running an ALTER on a table this transaction already wrote. */
  check(type: StatementType, sql: string): void {
    if (type !== StatementType.ALTER) return;
    const table = statementTarget(sql, type);
    if (!table || this.created.has(table)) return;
    const first = this.written.get(table);
    if (first === undefined) return;
    throw new CroftError("DDL_AFTER_DML", {
      message: `ALTER on ${table} after it was written in the same transaction; DuckDB would fail at COMMIT`,
      hint: "internal invariant: run every ALTER on a table before any INSERT, UPDATE, DELETE or MERGE on it",
      details: { table, alter: sql.trim().slice(0, 200), firstWrite: first.trim().slice(0, 200) },
    });
  }

  /** Record a statement that ran successfully. */
  record(type: StatementType, sql: string): void {
    if (DML.has(type)) {
      const table = statementTarget(sql, type);
      if (table && !this.written.has(table)) this.written.set(table, sql);
    } else if (type === StatementType.CREATE) {
      // CREATE TABLE IF NOT EXISTS usually finds the table already there; only a statement that surely
      // made a new table (plain CREATE, CREATE OR REPLACE) exempts it.
      const table = statementTarget(sql, type);
      if (table && !/\bIF\s+NOT\s+EXISTS\b/i.test(sql)) { this.created.add(table); this.written.delete(table); }
    } else if (type === StatementType.DROP) {
      const table = statementTarget(sql, type);
      if (table) this.written.delete(table);
    }
  }

  /** Tables written so far in this transaction. */
  tables(): string[] {
    return [...this.written.keys()];
  }
}

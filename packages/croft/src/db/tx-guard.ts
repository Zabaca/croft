// DDL before DML (DESIGN.md §5 "One ingest step", step g). In one DuckDB transaction, an UPDATE, DELETE
// or MERGE on a table followed by ALTER TABLE ADD COLUMN / ALTER COLUMN TYPE on it fails only at COMMIT
// ("another transaction has altered this table") [V]. The Sql wrapper tracks which tables each transaction
// has written and throws DDL_AFTER_DML at the offending ALTER instead, where the stack trace is useful.
//
// Verified matrix (DuckDB 1.5.5): UPDATE/DELETE/MERGE then ADD COLUMN or ALTER TYPE fail at COMMIT;
// INSERT then ALTER, any DML then CREATE OR REPLACE or DROP, and tables created in the same transaction
// (temp or not) all commit. croft enforces the design's simpler invariant: no ALTER TABLE on a table
// after any DML on it in the same transaction, unless the table was created in that transaction.
//
// One table has many spellings: t, main.t, "warehouse".main.t, and warehouse.t once "warehouse" is known
// to be a catalog. A write transaction can modify only one database besides temp, so a non-temp catalog
// is dropped from the key. A TEMP table is its own table (temp.main.t), and while one exists it shadows
// t and main.t [V]; the catalog-qualified name still reaches the real one.
import { StatementType } from "@duckdb/node-api";
import { CroftError } from "../core/errors.ts";

type Tok = { kind: "word" | "ident" | "punct" | "string"; text: string };

const WORD = /[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/y;

// Enough of a lexer for croft's statements: words, quoted identifiers, strings ('…', E'…', $tag$…$tag$),
// comments and punctuation. It reads the whole statement, however long its WITH clause.
function tokens(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith("--", i)) { const n = sql.indexOf("\n", i); i = n < 0 ? sql.length : n + 1; continue; }
    if (sql.startsWith("/*", i)) { const n = sql.indexOf("*/", i + 2); i = n < 0 ? sql.length : n + 2; continue; }
    const escaped = (c === "E" || c === "e") && sql[i + 1] === "'";
    if (c === '"' || c === "'" || escaped) {
      const q = escaped ? "'" : c;
      let j = escaped ? i + 2 : i + 1;
      let text = "";
      while (j < sql.length) {
        if (escaped && sql[j] === "\\") { text += sql[j + 1] ?? ""; j += 2; continue; }
        if (sql[j] === q) {
          if (sql[j + 1] === q) { text += q; j += 2; continue; }
          j++;
          break;
        }
        text += sql[j++];
      }
      out.push({ kind: q === '"' ? "ident" : "string", text });
      i = j;
      continue;
    }
    if (c === "$") {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end;
        out.push({ kind: "string", text: sql.slice(i + tag.length, stop) });
        i = end < 0 ? sql.length : end + tag.length;
        continue;
      }
    }
    WORD.lastIndex = i;
    const w = WORD.exec(sql);
    if (w) { out.push({ kind: "word", text: w[0] }); i += w[0].length; continue; }
    out.push({ kind: "punct", text: c });
    i++;
  }
  return out;
}

const isWord = (t: Tok | undefined, ...words: string[]) => t?.kind === "word" && words.includes(t.text.toUpperCase());

/** A table as a statement spells it: lowercased parts (identifiers are case-insensitive in DuckDB), and for
 *  CREATE whether it is TEMP and guarded by IF NOT EXISTS. */
interface Named { parts: string[]; temp: boolean; create: boolean; ifNotExists: boolean }

function nameAt(ts: Tok[], at: number, o: Partial<Omit<Named, "parts">> = {}): Named | null {
  const parts: string[] = [];
  let i = at;
  for (;;) {
    const t = ts[i];
    if (!t || (t.kind !== "word" && t.kind !== "ident")) break;
    parts.push(t.text.toLowerCase());
    if (ts[i + 1]?.text !== ".") break;
    i += 2;
  }
  return parts.length ? { parts, temp: o.temp ?? false, create: o.create ?? false, ifNotExists: o.ifNotExists ?? false } : null;
}

/** Skip a leading WITH ... clause (balanced parentheses) to the statement's main keyword. */
function skipWith(ts: Tok[]): number {
  if (!isWord(ts[0], "WITH")) return 0;
  let depth = 0;
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i]!;
    if (t.text === "(" && t.kind === "punct") depth++;
    else if (t.text === ")" && t.kind === "punct") depth--;
    else if (depth === 0 && isWord(t, "INSERT", "UPDATE", "DELETE", "MERGE", "SELECT")) {
      // Not a CTE named like a keyword ("WITH update AS (...)").
      if (!isWord(ts[i + 1], "AS") && !isWord(ts[i - 1], "WITH", "RECURSIVE") && ts[i - 1]?.text !== ",") return i;
    }
  }
  return ts.length;
}

/** The table a statement writes, alters or creates, as spelled, or null when it has none (or cannot be parsed). */
function statementName(sql: string, type: StatementType): Named | null {
  const ts = tokens(sql);
  let i = skipWith(ts);
  const skip = (...words: string[]) => { while (isWord(ts[i], ...words)) i++; };
  switch (type) {
    case StatementType.INSERT:
      if (!isWord(ts[i++], "INSERT")) return null;
      skip("OR", "REPLACE", "IGNORE");
      if (!isWord(ts[i++], "INTO")) return null;
      return nameAt(ts, i);
    case StatementType.UPDATE:
      if (!isWord(ts[i++], "UPDATE")) return null;
      return nameAt(ts, i);
    case StatementType.DELETE:
      if (isWord(ts[i], "TRUNCATE")) { i++; skip("TABLE"); return nameAt(ts, i); }
      if (!isWord(ts[i++], "DELETE") || !isWord(ts[i++], "FROM")) return null;
      return nameAt(ts, i);
    case StatementType.MERGE_INTO:
      if (!isWord(ts[i++], "MERGE") || !isWord(ts[i++], "INTO")) return null;
      return nameAt(ts, i);
    case StatementType.ALTER:
      if (!isWord(ts[i++], "ALTER") || !isWord(ts[i++], "TABLE")) return null;
      skip("IF", "EXISTS");
      return nameAt(ts, i);
    case StatementType.CREATE: {
      if (!isWord(ts[i++], "CREATE")) return null;
      let temp = false;
      while (isWord(ts[i], "OR", "REPLACE", "TEMP", "TEMPORARY", "LOCAL", "GLOBAL")) {
        if (isWord(ts[i], "TEMP", "TEMPORARY")) temp = true;
        i++;
      }
      if (!isWord(ts[i++], "TABLE")) return null;
      const ifNotExists = isWord(ts[i], "IF") && isWord(ts[i + 1], "NOT") && isWord(ts[i + 2], "EXISTS");
      if (ifNotExists) i += 3;
      return nameAt(ts, i, { temp, create: true, ifNotExists });
    }
    case StatementType.DROP:
      if (!isWord(ts[i++], "DROP") || !isWord(ts[i++], "TABLE")) return null;
      skip("IF", "EXISTS");
      return nameAt(ts, i);
    case StatementType.COPY: {
      // COPY <table> FROM '<file>' writes the table; COPY ... TO only reads.
      if (!isWord(ts[i++], "COPY")) return null;
      const name = nameAt(ts, i);
      if (!name) return null;
      while (ts[i] && !isWord(ts[i], "FROM", "TO")) i++;
      return isWord(ts[i], "FROM") ? name : null;
    }
    default:
      return null;
  }
}

interface Scope { catalogs: ReadonlySet<string>; temps: ReadonlySet<string> }
const NO_SCOPE: Scope = { catalogs: new Set(), temps: new Set() };

/** Whether the key of this name depends on which catalogs are known (a two-part name that is not
 *  main.t or temp.t: schema.table, or catalog.table once the catalog is known). */
const catalogDependent = (n: Named) => !n.temp && n.parts.length === 2 && n.parts[0] !== "main" && n.parts[0] !== "temp";

/** Normalized table key: main.t, <schema>.t, or temp.main.t. */
function keyOf(n: Named, scope: Scope): string {
  const p = n.parts;
  const table = p[p.length - 1]!;
  if (n.temp) return `temp.main.${table}`;
  if (p.length >= 3) return p[0] === "temp" ? `temp.main.${table}` : `${p[p.length - 2]}.${table}`;
  if (p.length === 2) {
    if (p[0] === "temp") return `temp.main.${table}`;
    if (p[0] !== "main") return scope.catalogs.has(p[0]!) ? `main.${table}` : `${p[0]}.${table}`;
  }
  // t and main.t look a TEMP table up first; CREATE without TEMP always makes the real one.
  return !n.create && scope.temps.has(table) ? `temp.main.${table}` : `main.${table}`;
}

/** The table a statement writes, alters or creates, as a normalized key, or null when it has none. */
export function statementTarget(sql: string, type: StatementType): string | null {
  const n = statementName(sql, type);
  return n ? keyOf(n, NO_SCOPE) : null;
}

const DML: ReadonlySet<StatementType> = new Set([
  StatementType.INSERT, StatementType.UPDATE, StatementType.DELETE, StatementType.MERGE_INTO, StatementType.COPY,
]);

/** A table seen in this transaction. Shadowing is resolved when the statement runs; a catalog.table name
 *  is resolved when compared, since the catalog may only be named by a later statement. */
interface Entry { name: Named; fixed: string | null; sql: string }

/** Per-transaction record of written and created tables. */
export class TxGuard {
  private written: Entry[] = []; // in order; the first one per table is reported
  private created: Entry[] = [];
  // Catalogs named in this transaction, and TEMP tables created in it and not dropped.
  private readonly scope = { catalogs: new Set<string>(), temps: new Set<string>() };

  /** `database`: the connection's current database, so `<database>.t` is known to mean main.t. */
  constructor(o: { database?: string } = {}) {
    if (o.database) this.scope.catalogs.add(o.database.toLowerCase());
  }

  private entry(name: Named, sql: string): Entry {
    const p = name.parts;
    if (!name.temp && p.length >= 3 && p[0] !== "temp") this.scope.catalogs.add(p[0]!);
    return { name, fixed: catalogDependent(name) ? null : keyOf(name, this.scope), sql };
  }

  private key(e: Entry): string {
    return e.fixed ?? keyOf(e.name, this.scope);
  }

  /** Throw DDL_AFTER_DML before running an ALTER on a table this transaction already wrote. */
  check(type: StatementType, sql: string): void {
    if (type !== StatementType.ALTER) return;
    const name = statementName(sql, type);
    if (!name) return;
    const table = this.key(this.entry(name, sql));
    if (this.created.some((e) => this.key(e) === table)) return;
    const first = this.written.find((e) => this.key(e) === table);
    if (first === undefined) return;
    throw new CroftError("DDL_AFTER_DML", {
      message: `ALTER on ${table} after it was written in the same transaction; DuckDB would fail at COMMIT`,
      hint: "internal invariant: run every ALTER on a table before any INSERT, UPDATE, DELETE or MERGE on it",
      details: { table, alter: sql.trim().slice(0, 200), firstWrite: first.sql.trim().slice(0, 200) },
    });
  }

  /** Record a statement that ran successfully. */
  record(type: StatementType, sql: string): void {
    const isDml = DML.has(type);
    if (!isDml && type !== StatementType.CREATE && type !== StatementType.DROP) return;
    const name = statementName(sql, type);
    if (!name) return;
    const entry = this.entry(name, sql);
    const table = this.key(entry);
    const last = name.parts[name.parts.length - 1]!;
    if (isDml) {
      if (!this.written.some((e) => this.key(e) === table)) this.written.push(entry);
    } else if (type === StatementType.CREATE) {
      if (table.startsWith("temp.")) this.scope.temps.add(last);
      // CREATE TABLE IF NOT EXISTS usually finds the table already there; only a statement that surely
      // made a new table (plain CREATE, CREATE OR REPLACE) exempts it.
      if (!name.ifNotExists) {
        this.created.push(entry);
        this.written = this.written.filter((e) => this.key(e) !== table);
      }
    } else {
      this.written = this.written.filter((e) => this.key(e) !== table);
      if (table.startsWith("temp.")) this.scope.temps.delete(last);
    }
  }

  /** Tables written so far in this transaction. */
  tables(): string[] {
    return [...new Set(this.written.map((e) => this.key(e)))];
  }
}

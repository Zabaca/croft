// Generated input types (DESIGN.md §3e "The context API", §6 "Ways to try a change" 1, §11 phase 5): the row
// type of every asset with known columns, so a TS transform's `rows("x")`, `newRows("x")` and `query<"x">(sql)`
// are checked by name, and `croft validate --types` catches a column renamed or removed upstream. An app's
// `query<"x">(sql)` from @zabaca/croft/read is typed by name the same way, with the values that module returns.
//
//   .croft/types/<asset>.d.ts   `export type <Asset>Row = { column: type; ... }` as a TS transform is handed it,
//                               and `<Asset>ReadRow` as @zabaca/croft/read returns it (json mode, below)
//   .croft/types/index.d.ts     adds each Row to croft's CroftAssets interface (src/types.ts) by module
//                               augmentation; the project tsconfig.json includes ".croft/types" (croft init).
//                               It adds each ReadRow to the global CroftTables interface that @zabaca/croft/read
//                               declares (src/read-types.ts): global, so it reaches an app whose own copy of
//                               croft is not the project's (an app with the project in data/)
//
// The folder is always <root>/.croft/types, even when croft.json relocates the state folder: tsconfig.json can
// only name it relative to the project. It is croft's: every generation rewrites the files that changed and
// removes the .d.ts files of assets no longer known, and leaves other files alone.
//
// Where the columns come from (the column cache, as validate's bind check reads it):
//   run       runs.sqlite's catalog mirror: the table as last built
//   preview   .croft/preview/runs.sqlite, for an asset never built: the columns its last preview gave it
//   code      validate --types: an SQL asset's output columns as its code is now (the bind check's), which
//             replace the cache, so a column renamed in SQL is caught before the run
// Generated after every run and preview (run/runner.ts, run/preview.ts) and by validate --types before tsc. It
// reads runs.sqlite and imports no asset code, so it is cheap.
//
// Types are what a TS transform is handed (db/values.ts renderValue, mode "ts"), not what DuckDB stores:
//   BIGINT → number | bigint (bigint beyond ±2^53); HUGEINT and DECIMAL(38,0) → bigint; DECIMAL up to 15
//   digits → number, wider → string; dates, times and timestamps → string (never Date: §3e); JSON → unknown
//   (its parsed value, of no known shape); UUID, BLOB, INTERVAL → string; lists → arrays; MAP → {key, value}[].
// ReadRow types are what @zabaca/croft/read returns (mode "json"): BIGINT → number | string (text beyond
//   ±2^53); HUGEINT and every DECIMAL → string; the rest as above. A DOUBLE that is NaN or ±Infinity arrives as
//   its text in json mode; the types say number, since a warehouse rarely holds one and number | string on every
//   DOUBLE would make the common case unusable.
// Every column may be NULL but the key (KEY_NULL and the key's implied not_null refuse NULL keys), croft's
// _loaded_at and _file, and the columns a blocking not_null check vouches for (D107). A pending column (NULL in
// every row so far) is unknown: its type is not settled.
//
// Vouched for (notNull) means every row of the table as last built passed the check, which the record of the step
// that built it says (history/runs-db.ts lastStepChecks): a blocking not_null among that ok step's results. It
// holds for every write mode, appends and merges included, because a check covers each write's rows and a new or
// edited one the whole table once (§3f), so a row saved before the check was added was checked when it was. Never
// from a warning (its rows are not refused), nor from the code alone: a check added since the last run has not
// looked at the table yet, so the column narrows after the run it passes. Nothing is vouched for after a restore or
// delete (their steps run no checks), while a run that did not end ok has written the table since (a chunked TS
// transform's committed chunks), for a step an older croft recorded (no `blocking` on its results), or for an
// asset only previewed (the preview records no steps). validate --types' code columns narrow where the record and
// the code both say so, so the types hold for the table now and for the build the code will make.
// STRUCT field names are not claimed: the column cache upper-cases them (load/evolve.ts normalizeType).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkColumns, parseChecks } from "../checks/parse.ts";
import type { StepResult } from "../core/types.ts";
import { allCatalog, type CatalogAsset } from "../history/catalog.ts";
import { RUNS_DB_FILE, RunsDb } from "../history/runs-db.ts";
import { RESERVED } from "../load/contract.ts";
import { loadProject } from "./root.ts";

/** The folder, relative to the project root (tsconfig.json "include" names it). */
export const TYPES_DIR = ".croft/types";
/** The file that augments CroftAssets. */
export const TYPES_INDEX = "index.d.ts";
/** run/preview.ts PREVIEW_DIR: the preview's runs.sqlite (types-gen.test.ts checks they agree). */
const PREVIEW_DIR = "preview";

export interface TypedColumn {
  name: string;
  /** DuckDB's type name, as the column cache or the bind check spells it. */
  type: string;
  /** NULL in every row so far (the catalog's pending): its type is not settled. */
  pending?: boolean;
  /** Keys seen inside a JSON column (a comment only). */
  jsonKeys?: readonly string[];
}

export interface TypeSource {
  asset: string;
  columns: readonly TypedColumn[];
  /** Key columns: never NULL. */
  key: readonly string[];
  /** Columns no row holds NULL in (D107): from the cache, vouched for by the last ok step's blocking not_null checks
   *  (vouchedNotNull); from code, the columns its blocking not_null checks name, kept only where the cache vouches. */
  notNull?: readonly string[];
  /** Where the columns come from (see the top of this file). */
  from: "run" | "preview" | "code";
  /** The asset file, for "code". */
  file?: string;
}

/** One generated row type, by its type name (tsc's messages name it). */
export interface GeneratedType {
  asset: string;
  /** Root-relative: ".croft/types/github_issues.d.ts". */
  file: string;
  columns: string[];
  /** Each column's TypeScript type as the file writes it ("number | bigint | null"): validate --types words its
   *  hints from them (a column that may be NULL, a BIGINT in arithmetic). */
  columnTypes: Record<string, string>;
}

export interface TypesResult {
  /** The folder written: <root>/.croft/types. */
  dir: string;
  /** Assets with a generated type, sorted. */
  assets: string[];
  /** Each row type by name ("GithubIssuesRow"). */
  types: Record<string, GeneratedType>;
  /** Files written or removed; a file whose text did not change is left alone. */
  changed: string[];
}

export interface TypesOptions {
  /** The state folder holding runs.sqlite (default: croft.json's, else <root>/.croft). */
  stateDir?: string;
  /** Columns that replace the cache for their assets (validate --types: SQL assets as their code is now). */
  code?: readonly TypeSource[];
}

// ---------------------------------------------------------------------------------------------------------
// DuckDB → TypeScript

const NUMBER = new Set(["TINYINT", "SMALLINT", "INTEGER", "INT", "INT1", "INT2", "INT4", "SHORT", "SIGNED", "UTINYINT", "USMALLINT",
  "UINTEGER", "FLOAT", "FLOAT4", "REAL", "DOUBLE", "FLOAT8", "DOUBLE PRECISION"]);
const SAFE_OR_BIG = new Set(["BIGINT", "INT8", "LONG", "UBIGINT"]);
const BIG = new Set(["HUGEINT", "UHUGEINT", "INT128", "INT16", "VARINT", "BIGNUM"]);
const BOOLEAN = new Set(["BOOLEAN", "BOOL", "LOGICAL"]);
// Text, and every type db/values.ts renders as text: dates and times (never Date), and the values the DuckDB
// binding hands over as objects (UUID, BLOB, INTERVAL, BIT), which it turns into their string form.
const STRING = new Set(["VARCHAR", "STRING", "TEXT", "CHAR", "BPCHAR", "ENUM", "DATE", "TIME", "TIMETZ", "TIME WITH TIME ZONE",
  "TIMESTAMP", "TIMESTAMPTZ", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITHOUT TIME ZONE", "DATETIME", "TIMESTAMP_S", "TIMESTAMP_MS",
  "TIMESTAMP_NS", "TIMESTAMP_US", "UUID", "BLOB", "BYTEA", "BINARY", "VARBINARY", "INTERVAL", "BIT", "BITSTRING"]);
/** The widest DECIMAL db/values.ts hands over as a number (a double holds 15 significant digits exactly). */
const DOUBLE_DIGITS = 15;
const OPEN = "([";
const CLOSE = ")]";

/** Split at top-level commas (not inside parentheses, brackets or quotes). */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

/** `T | null`, for a value that may be NULL (unknown already includes null). */
function orNull(ts: string): string {
  return ts === "unknown" ? ts : `${ts} | null`;
}

/** Parenthesized when it is a union, so `[]` applies to all of it. */
function element(ts: string): string {
  return ts.includes("|") || ts.includes("{") ? `(${ts})` : ts;
}

/** How a value reaches code (db/values.ts RenderMode): "ts" as a TS transform is handed it, "json" as
 *  @zabaca/croft/read returns it. */
export type TypeMode = "ts" | "json";

/** The TypeScript type of a value of this DuckDB type, as a TS transform is handed it (db/values.ts, mode "ts"),
 *  or as @zabaca/croft/read returns it (mode "json"). Not NULL-able at the top: the caller adds `| null` where a
 *  column may hold NULL. */
export function tsType(sqlType: string, mode: TypeMode = "ts"): string {
  const t = sqlType.trim();
  const list = /^(.*)\[\d*\]$/s.exec(t);
  if (list) {
    const inner = tsType(list[1]!, mode);
    return inner === "unknown" ? "unknown[]" : `${element(orNull(inner))}[]`;
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*)*)\s*(?:\((.*)\))?$/s.exec(t);
  if (!m) return "unknown";
  const base = m[1]!.toUpperCase();
  const args = m[2];
  if (base === "DECIMAL" || base === "NUMERIC") {
    if (mode === "json") return "string";
    const [p, s] = args === undefined ? [18, 3] : splitTop(args).map(Number);
    if (p === undefined || !Number.isInteger(p)) return "unknown";
    if (p === 38 && (s ?? 0) === 0) return "bigint";              // HUGEINT's stand-in in Parquet snapshots
    return p > DOUBLE_DIGITS ? "string" : "number";
  }
  if (base === "MAP" && args !== undefined) {
    const [k, v] = splitTop(args);
    if (k === undefined || v === undefined) return "unknown";
    return `{ key: ${tsType(k, mode)}; value: ${orNull(tsType(v, mode))} }[]`;
  }
  if (base === "STRUCT") return "{ [field: string]: unknown }";
  if (base === "UNION") return "{ tag: string; value: unknown }";
  if (BOOLEAN.has(base)) return "boolean";
  if (NUMBER.has(base)) return "number";
  if (SAFE_OR_BIG.has(base)) return mode === "json" ? "number | string" : "number | bigint";
  if (BIG.has(base)) return mode === "json" ? "string" : "bigint";
  if (STRING.has(base)) return "string";
  return "unknown";                                               // JSON, and any type croft does not know
}

/** The row type's name: PascalCase of the asset plus Row ("github_issues" → "GithubIssuesRow"). Asset names
 *  start with a letter, so it is always an identifier, and never a TypeScript keyword or a croft type. */
export function rowTypeName(asset: string): string {
  return `${asset.split("_").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")}Row`;
}

/** The name of the same rows as @zabaca/croft/read returns them: GithubIssuesRow → GithubIssuesReadRow. */
export const readTypeName = (rowType: string) => `${rowType.slice(0, -3)}ReadRow`;

// ---------------------------------------------------------------------------------------------------------
// The files

const HEADER_TAIL = "// Generated by croft after each run and preview, and by croft validate --types; edits are overwritten.";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Text inside a /** comment *\/ must not close it. */
const commentSafe = (s: string) => s.replaceAll("*/", "* /");

function origin(s: TypeSource): string {
  if (s.from === "preview") return "From the columns the last croft preview gave it; it has never been built.";
  if (s.from === "code") return `From the output columns of ${s.file ?? `the asset ${s.asset}`} as its code is now.`;
  return "From the columns of its table as last built.";
}

/** Wrap comment words at about 115 columns, each line starting with "// " (a line break in a path cannot end
 *  the comment early). */
function commentLines(text: string): string[] {
  const out: string[] = [];
  let line = "//";
  for (const word of text.replace(/[\r\n\u2028\u2029]+/g, " ").split(" ")) {
    if (line.length + 1 + word.length > 115 && line !== "//") {
      out.push(line);
      line = "//";
    }
    line += ` ${word}`;
  }
  out.push(line);
  return out;
}

/** A column's TypeScript type, and the comment above it. */
function columnType(c: TypedColumn, s: Pick<TypeSource, "key" | "notNull">, mode: TypeMode = "ts"): { ts: string; note: string } {
  const type = c.type.trim() || "unknown";
  const isKey = s.key.some((k) => sameName(k, c.name));
  const vouched = !isKey && (s.notNull ?? []).some((k) => sameName(k, c.name));
  const own = sameName(c.name, RESERVED.loadedAt) ? "when croft loaded the row" : sameName(c.name, RESERVED.file) ? "the file the row came from" : null;
  let ts: string;
  let note: string;
  if (c.pending && !isKey) {
    ts = "unknown";
    note = `${type}, NULL in every row so far: its type is not settled`;
  } else {
    const base = tsType(type, mode);
    // A JSON column stays unknown: a not_null check refuses SQL NULL, not a JSON null inside it.
    const checked = vouched && base !== "unknown";
    ts = isKey || own || checked ? base : orNull(base);
    // A transform's rows are guarded proxies that leave croft's columns out of a spread; an app's are plain objects.
    note = own ? (mode === "ts" ? `${type}: ${own}; readable, but left out of { ...row }` : `${type}: ${own}`)
      : isKey ? `${type}, the key`
        : `${c.jsonKeys?.length ? `${type} (keys seen: ${c.jsonKeys.join(", ")})` : type}${checked ? ", never NULL: a blocking not_null check" : ""}`;
  }
  return { ts, note };
}

function columnLine(c: TypedColumn, s: TypeSource, mode: TypeMode): string[] {
  const name = IDENTIFIER.test(c.name) ? c.name : JSON.stringify(c.name);
  const { ts, note } = columnType(c, s, mode);
  return [`  /** ${commentSafe(note)} */`, `  ${name}: ${ts};`];
}

/** An SQL table always has croft's _loaded_at, which the SELECT's output columns (the bind check's) leave out. */
function withLoadedAt(s: TypeSource): readonly TypedColumn[] {
  if (s.from !== "code" || s.columns.some((c) => sameName(c.name, RESERVED.loadedAt))) return s.columns;
  return [...s.columns, { name: RESERVED.loadedAt, type: "TIMESTAMPTZ" }];
}

function rowType(s: TypeSource, typeName: string, columns: readonly TypedColumn[], mode: TypeMode = "ts"): string {
  return [`export type ${typeName} = {`, ...columns.flatMap((c) => columnLine(c, s, mode)), "};"].join("\n");
}

/** The ReadRow type with its comment: the same columns as @zabaca/croft/read returns them. */
function readRowType(s: TypeSource, typeName: string, columns: readonly TypedColumn[]): string {
  const q = JSON.stringify(s.asset);
  return [
    ...commentLines(`The same rows as an app reads them: query<${q}>(sql) from @zabaca/croft/read. DECIMAL, HUGEINT and integers beyond ±2^53 arrive as strings there.`),
    rowType(s, readTypeName(typeName), columns, "json"),
  ].join("\n");
}

/** The text of every file of .croft/types for these sources (file name → text), and the row types by name.
 *  An asset with no columns gets no type. */
export function renderTypes(sources: readonly TypeSource[]): { files: Map<string, string>; types: Record<string, GeneratedType>; assets: string[] } {
  const sorted = sources.filter((s) => s.columns.length > 0).sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
  // Distinct type names: an asset whose PascalCase form an earlier one took ("a_b" after "a__b") gets a numbered
  // name, with an underscore no plain name has.
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const s of sorted) {
    let name = rowTypeName(s.asset);
    for (let n = 2; taken.has(name); n++) name = `${rowTypeName(s.asset).slice(0, -3)}_${n}Row`;
    taken.add(name);
    names.set(s.asset, name);
  }
  const files = new Map<string, string>();
  const types: Record<string, GeneratedType> = {};
  const entries: string[] = [];
  const readEntries: string[] = [];
  let indexRow = "";
  for (const s of sorted) {
    const typeName = names.get(s.asset)!;
    const columns = withLoadedAt(s);
    const inIndex = `${s.asset}.d.ts` === TYPES_INDEX;
    types[typeName] = {
      asset: s.asset, file: `${TYPES_DIR}/${s.asset}.d.ts`, columns: columns.map((c) => c.name),
      columnTypes: Object.fromEntries(columns.map((c) => [c.name, columnType(c, s).ts])),
    };
    const q = JSON.stringify(s.asset);
    const header = commentLines(`${s.asset}: its rows as TS transforms read them: ctx.rows(${q}), ctx.newRows(${q}) and ctx.query<${q}>(sql). ${origin(s)}`);
    if (inIndex) {
      // An asset named index: its row type is declared in index.d.ts itself.
      indexRow = `${[...header, rowType(s, typeName, columns), "", readRowType(s, typeName, columns)].join("\n")}\n`;
      entries.push(`    ${s.asset}: ${typeName};`);
      readEntries.push(`    ${s.asset}: ${readTypeName(typeName)};`);
    } else {
      files.set(`${s.asset}.d.ts`, `${[...header, HEADER_TAIL, rowType(s, typeName, columns), "", readRowType(s, typeName, columns)].join("\n")}\n`);
      entries.push(`    ${s.asset}: import("./${s.asset}.js").${typeName};`);
      readEntries.push(`    ${s.asset}: import("./${s.asset}.js").${readTypeName(typeName)};`);
    }
  }
  if (sorted.length) {
    files.set(TYPES_INDEX, [
      "// Input row types by asset name, for TS transforms: ctx.rows(\"x\") and ctx.newRows(\"x\") hand over x's row type,",
      "// and ctx.query<\"x\">(sql) returns x's rows. Reading a column x does not have is then a type error, which",
      "// croft validate --types reports. rows<Row>(\"x\") opts out, for column names computed at run time.",
      "// For apps, query<\"x\">(sql) from @zabaca/croft/read returns x's rows as that module renders them.",
      HEADER_TAIL,
      "// It applies when tsconfig.json includes \".croft/types\" (an app with the project in data/: data/.croft/types).",
      ...(indexRow ? [indexRow.trimEnd()] : []),
      "export {};",
      "declare module \"@zabaca/croft\" {",
      "  interface CroftAssets {",
      ...entries,
      "  }",
      "}",
      "declare global {",
      "  interface CroftTables {",
      ...readEntries,
      "  }",
      "}",
      "",
    ].join("\n"));
  }
  return { files, types, assets: sorted.map((s) => s.asset) };
}

// ---------------------------------------------------------------------------------------------------------
// The column cache and the folder

/**
 * The columns the blocking not_null checks among a step's results cover (RunsDb.lastStepChecks: every row of the
 * table passed them), as the checks name them. A warning's never count, nor a failed one, nor a result an older
 * croft recorded without `blocking`.
 */
export function vouchedNotNull(asset: string, results: StepResult["checks"] | null): string[] {
  const out = new Set<string>();
  for (const r of results ?? []) {
    if (r.blocking !== true || !r.ok) continue;
    const { checks } = parseChecks({ asset, file: "", key: [], checks: [r.check], warnings: [] });
    for (const c of checks) if (c.kind === "not_null") for (const col of checkColumns(c) ?? []) out.add(col);
  }
  return [...out];
}

/** The catalog mirror's entries as type sources. A live one's notNull comes from the record of the step that
 *  built it; the preview's runs.sqlite records no steps, so a previewed asset has none. */
function catalogOf(stateDir: string, from: TypeSource["from"]): TypeSource[] {
  if (!existsSync(join(stateDir, RUNS_DB_FILE))) return [];
  const db = RunsDb.open(stateDir);
  try {
    return allCatalog(db).map((c) => {
      const notNull = from === "run" ? vouchedNotNull(c.asset, db.lastStepChecks(c.asset)) : [];
      return { ...fromCatalog(c, from), ...(notNull.length ? { notNull } : {}) };
    });
  } finally {
    db.close();
  }
}

const fromCatalog = (c: CatalogAsset, from: TypeSource["from"]): TypeSource => ({
  asset: c.asset, from, key: c.key ?? [],
  columns: (c.columns ?? []).map((x) => ({ name: x.name, type: x.type, pending: x.pending === true, ...(x.jsonKeys?.length ? { jsonKeys: x.jsonKeys } : {}) })),
});

/** The column cache as validate's bind check reads it: the live catalog mirror, then each asset never built
 *  that a preview built (a live entry wins). Creates nothing. */
export function typeSources(stateDir: string): TypeSource[] {
  const live = catalogOf(stateDir, "run");
  const known = new Set(live.map((c) => c.asset));
  const previewed = catalogOf(join(stateDir, PREVIEW_DIR), "preview").filter((c) => !known.has(c.asset));
  return [...live, ...previewed];
}

function stateDirOf(root: string): string {
  try {
    return loadProject({ root }).paths.stateDir;
  } catch {
    return join(root, ".croft");
  }
}

/** Write a file through a temporary name, so a tsc that reads the folder meanwhile never sees half of it. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Write .croft/types from the column cache (and `code`, which replaces it for its assets): each asset's
 * <asset>.d.ts and index.d.ts. Only files whose text changed are written; the .d.ts files of assets no longer
 * known are removed, and so is the folder once nothing is left in it. Cheap: reads runs.sqlite, imports no
 * asset code. Throws only when the folder cannot be written.
 */
export function generateInputTypes(root: string, o: TypesOptions = {}): TypesResult {
  const stateDir = o.stateDir ?? stateDirOf(root);
  const cached = new Map(typeSources(stateDir).map((s) => [s.asset, s]));
  // Code columns replace the cache's, keeping what only a run saw: the keys inside a JSON column of the same name.
  // A column the code's not_null names narrows only where the cache vouches for it too (D107): the table now has
  // no NULL there, and the next build cannot commit one.
  const code = new Map((o.code ?? []).map((s) => {
    const prior = cached.get(s.asset);
    const was = prior?.columns ?? [];
    const notNull = (s.notNull ?? []).filter((n) => (prior?.notNull ?? []).some((v) => sameName(v, n)));
    const { notNull: _n, ...rest } = s;
    return [s.asset, { ...rest, ...(notNull.length ? { notNull } : {}), columns: s.columns.map((c) => {
      const keys = was.find((w) => w.name === c.name && w.jsonKeys?.length)?.jsonKeys;
      return keys && !c.jsonKeys ? { ...c, jsonKeys: keys } : c;
    }) }];
  }));
  const sources = [...[...cached.values()].filter((s) => !code.has(s.asset)), ...code.values()];
  const { files, types, assets } = renderTypes(sources);
  const dir = join(root, ...TYPES_DIR.split("/"));
  const changed: string[] = [];
  if (files.size) mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) {
    const path = join(dir, name);
    let old: string | null = null;
    try {
      old = readFileSync(path, "utf8");
    } catch { /* a new file */ }
    if (old === text) continue;
    writeAtomic(path, text);
    changed.push(name);
  }
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".d.ts") || files.has(name)) continue;
      rmSync(join(dir, name), { force: true });
      changed.push(name);
    }
    if (!files.size && readdirSync(dir).length === 0) {
      try {
        rmdirSync(dir);
      } catch { /* something else is in it now */ }
    }
  }
  return { dir, assets, types, changed };
}

// croft describe <asset> (DESIGN.md §4.1, §4.2, §4.3 "describe"): one asset in words and numbers. Its
// behavior in plain words, the saved cursor, the table's columns with the keys seen inside JSON columns,
// what it reads and what reads it, its checks, recent writes (_croft.writes) and three sample rows.
//
// The config comes from the asset file itself (a TS asset is imported in isolation, as validate does; an
// SQL asset's header is read). Table facts come from the warehouse under a short read-only lease (§5:
// describe waits only for the current write step). When a run holds the file longer than that, describe
// falls back to the catalog mirror in runs.sqlite and says so (data.source "catalog"); samples and recent
// writes need the warehouse itself and are left empty.
//
// This file also holds what the other read-only commands (context, query, secrets) share: loading asset
// configs without failing on one broken file, the read-only warehouse, and value capping with redaction.
import { readFileSync } from "node:fs";
import { CroftError, problem } from "../../core/errors.ts";
import { CHECKS_ENFORCED, CHECKS_NOT_ENFORCED } from "../../core/phase.ts";
import type { AssetKind, CursorType, Incremental, LockHolder, Problem, WriteMode } from "../../core/types.ts";
import { hasState } from "../../db/state.ts";
import { type DuckWarehouse, type LeaseSql, openWarehouse } from "../../db/warehouse.ts";
import type { CatalogAsset } from "../../history/catalog.ts";
import type { StepRecord } from "../../history/runs-db.ts";
import { quoteIdent } from "../../load/evolve.ts";
import { discoverAssets, type DiscoveredAsset, NAME_PATTERN } from "../../project/discover.ts";
import type { Project } from "../../project/root.ts";
import { didYouMean } from "../../project/suggest.ts";
import { loadTsAsset } from "../../project/ts-asset.ts";
import type { Row } from "../../types.ts";
import type { CommandImpl, Ctx } from "../command.ts";
import { formatCount, formatDuration, table, toJsonLine, truncate, VALUE_WIDTH } from "../render.ts";
import { effectiveStatus, nextOf, openRunsDb, runningEntries, sniffKind, zoned } from "./status.ts";

// ---------------------------------------------------------------------------------------------------------
// Asset configs, read from the files

export interface AssetConfig {
  name: string;
  file: string;
  path: string;
  kind: AssetKind | null;            // null: a TS file whose config could not be read
  description: string | null;
  schedule: string | null;
  key: string[];
  write: WriteMode | null;           // as declared
  incremental: Incremental;
  inputs: string[];
  checks: string[];
  warnings: string[];
  secrets: string[];
  /** The config was read: the TS asset imported and validated, or the SQL header parsed. */
  loaded: boolean;
  problems: Problem[];
}

/** An SQL asset's header: the `-- name: value` lines at the top (plain comments and blank lines may sit between). */
export function sqlHeader(text: string): { description: string | null; key: string[]; checks: string[]; warnings: string[] } {
  const out = { description: null as string | null, key: [] as string[], checks: [] as string[], warnings: [] as string[] };
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) break;
    const m = /^--\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/.exec(trimmed);
    if (!m) continue;
    const [, name, value] = m as unknown as [string, string, string];
    switch (name.toLowerCase()) {
      case "description": out.description = value; break;
      case "key": out.key = value.split(",").map((k) => k.trim()).filter(Boolean); break;
      case "check": if (value) out.checks.push(value); break;
      case "warn": if (value) out.warnings.push(value); break;
    }
  }
  return out;
}

/** Secret names a TS file declares, read from its text: `secrets: ["A", 'B']` lists and `secret("C")` calls.
 *  The fallback for a file that does not import, so its secrets are still known (and redacted). */
export function staticSecrets(source: string): string[] {
  const names = new Set<string>();
  const literal = /(["'`])([A-Za-z_][\w.-]*)\1/g;
  for (const m of source.matchAll(/\bsecrets\s*:\s*\[([^\]]*)\]/g)) {
    for (const l of m[1]!.matchAll(literal)) names.add(l[2]!);
  }
  for (const m of source.matchAll(/\bsecret\s*\(\s*(["'`])([A-Za-z_][\w.-]*)\1\s*\)/g)) names.add(m[2]!);
  return [...names].sort();
}

function emptyConfig(a: DiscoveredAsset, kind: AssetKind | null): AssetConfig {
  return {
    name: a.name, file: a.file, path: a.path, kind, description: null, schedule: null, key: [], write: null,
    incremental: { kind: "none" }, inputs: [], checks: [], warnings: [], secrets: [], loaded: false, problems: [],
  };
}

/**
 * The config of each asset. A TS asset is imported in isolation (ts-asset.ts); one that fails keeps its
 * problems, its kind from a look at the text, and the secrets its text names. An SQL asset's header is read.
 */
export async function loadConfigs(project: Project, assets: readonly DiscoveredAsset[], o: { importTimeoutMs?: number } = {}): Promise<AssetConfig[]> {
  const out: AssetConfig[] = [];
  for (const a of assets) {
    let source = "";
    try {
      source = readFileSync(a.path, "utf8");
    } catch {}
    if (a.kind === "sql") {
      const h = sqlHeader(source);
      out.push({ ...emptyConfig(a, "sql"), description: h.description, key: h.key, write: "replace", checks: h.checks, warnings: h.warnings, loaded: true });
      continue;
    }
    const loaded = await loadTsAsset(a, { root: project.root, timezone: project.timezone },
      o.importTimeoutMs !== undefined ? { importTimeoutMs: o.importTimeoutMs } : {});
    const spec = loaded.spec;
    if (!loaded.ok || !spec || !loaded.definition) {
      out.push({ ...emptyConfig(a, sniffKind(a)), secrets: staticSecrets(source), problems: loaded.problems });
      continue;
    }
    const config = loaded.definition.config as { description?: unknown };
    out.push({
      name: a.name, file: a.file, path: a.path, kind: spec.role === "ingest" ? "ingest" : "ts",
      description: typeof config.description === "string" ? config.description : null,
      schedule: spec.schedule ?? null, key: [...spec.key], write: spec.write ?? null, incremental: spec.incremental,
      inputs: [...spec.inputs], checks: [...spec.checks], warnings: [...spec.warnings], secrets: [...spec.secrets],
      loaded: true, problems: loaded.problems,
    });
  }
  return out;
}

/** Declared secrets per asset, for ProjectEnv.listSecrets and declare(). */
export function secretsByAsset(configs: readonly AssetConfig[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of configs) if (c.secrets.length) out[c.name] = [...c.secrets];
  return out;
}

/** Declare every secret the project's assets name, so data redaction hides their values whatever they look
 *  like (ProjectEnv.redactData). Commands that show table data call this before returning it. */
export async function declareProjectSecrets(ctx: Ctx, project: Project, configs?: readonly AssetConfig[]): Promise<AssetConfig[]> {
  const list = configs ?? await loadConfigs(project, (await discoverAssets(project.root, { assetsDir: project.paths.assetsDir })).assets,
    { importTimeoutMs: 5000 });
  const names = [...new Set(list.flatMap((c) => c.secrets))];
  // declare() also registers a declared secret that is set in the shell rather than .env.
  ctx.env.declare(names);
  return [...list];
}

// ---------------------------------------------------------------------------------------------------------
// Behavior in words

export interface Behavior {
  words: string;
  write: WriteMode | null;
  key: string[];
  incremental: {
    kind: Incremental["kind"];
    field: string | null;
    cursorValue: string | null;
    cursorType: CursorType | null;
    unit: "s" | "ms" | null;
    lookback: string | null;
  } | null;
}

/** "30 days", "10 minutes", "1 second". */
export function durationWords(ms: number): string {
  const units: [number, string][] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"]];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${ms} ms`;
}

export function inferWrite(c: Pick<AssetConfig, "kind" | "key" | "write" | "incremental">): WriteMode | null {
  if (c.write) return c.write;
  if (c.kind === null) return null;
  if (c.kind === "sql") return "replace";
  const inc = c.incremental.kind;
  if (inc === "cursor" || inc === "files" || inc === "new-rows") return c.key.length ? "merge" : "append";
  return "replace";
}

export function behaviorOf(c: AssetConfig | null, cat: CatalogAsset | null): Behavior {
  const kind = c?.kind ?? cat?.kind ?? null;
  const key = c?.key.length ? c.key : cat?.key ?? [];
  const write = cat?.write ?? (c ? inferWrite(c) : null);
  const inc = c?.incremental ?? (cat?.cursor ? { kind: "cursor" as const, field: cat.cursor.field, lookbackMs: 0, ...(cat.cursor.unit ? { unit: cat.cursor.unit } : {}) } : { kind: "none" as const });
  const lookback = inc.kind === "cursor" && inc.lookbackMs > 0 ? durationWords(inc.lookbackMs) : null;
  const incremental: Behavior["incremental"] = inc.kind === "none" ? null : {
    kind: inc.kind,
    field: inc.kind === "cursor" ? inc.field : null,
    cursorValue: cat?.cursor?.value ?? null,
    cursorType: cat?.cursor?.type ?? null,
    unit: inc.kind === "cursor" ? inc.unit ?? cat?.cursor?.unit ?? null : null,
    lookback,
  };
  if (cat?.behavior) return { words: cat.behavior, write, key, incremental };
  const by = key.length ? key.join(", ") : "row content";
  let words: string;
  if (kind === null) words = "unknown until the asset file loads (croft validate shows why)";
  else if (kind === "sql") words = `rebuilt in full when an input or its SQL changes; rows matched by ${by}`;
  else if (inc.kind === "cursor") {
    // Without the asset file (a warehouse-only table) the field's name is not known.
    const field = inc.field || "its cursor field";
    const unit = inc.unit ? ` (${field} is epoch ${inc.unit === "s" ? "seconds" : "milliseconds"})` : "";
    const since = `fetches rows with ${field} after the saved position${lookback ? `, re-reading the last ${lookback}` : ""}`;
    words = `${write === "merge" ? `updates rows by ${by}` : "appends new rows"}; ${since}${unit}`;
  } else if (inc.kind === "files") words = `loads only new and changed files; ${write === "merge" ? `updates rows by ${by}` : "appends their rows"}`;
  else if (inc.kind === "new-rows") words = `processes only new input rows; ${write === "merge" ? `updates rows by ${by}` : "appends the results"}`;
  else if (kind === "ts") words = `recomputed in full when an input changes; rows matched by ${by}`;
  else if (write === "append") words = "appends every row it fetches";
  else if (write === "merge") words = `updates rows by ${by}; fetches everything each run`;
  else words = `replaces the table on each run; rows matched by ${by}`;
  return { words, write, key, incremental };
}

/** The implied checks of a key, then the declared ones (§4.2: "unique(id) · not_null(id) · amount >= 0"). */
export function checksOf(c: AssetConfig | null, key: string[]): { check: string; blocking: boolean; implied: boolean }[] {
  const out: { check: string; blocking: boolean; implied: boolean }[] = [];
  if (key.length) {
    out.push({ check: `unique(${key.join(", ")})`, blocking: true, implied: true });
    out.push({ check: `not_null(${key.join(", ")})`, blocking: true, implied: true });
  }
  for (const check of c?.checks ?? []) out.push({ check, blocking: true, implied: false });
  for (const check of c?.warnings ?? []) out.push({ check, blocking: false, implied: false });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The warehouse, read-only

/** "croft run r_…, writing x", "croft serve pid 4121", "DuckDB UI (PID 812)". */
export function holderText(h: LockHolder): string {
  if (h.runId) return `croft run ${h.runId}${h.asset ? `, writing ${h.asset}` : ""}`;
  if (h.program === "croft serve") return `croft serve pid ${h.pid}`;
  return `${h.program ?? "another program"}${h.pid !== null ? ` (PID ${h.pid})` : ""}`;
}

/** Who a PID holding the warehouse is, from runs.sqlite: its running run and the asset it is on. */
export function holderFromRuns(stateDir: string, pid: number): Partial<LockHolder> | null {
  let db;
  try {
    db = openRunsDb(stateDir);
  } catch {
    return null;
  }
  if (!db) return null;
  try {
    const run = db.runningRuns().find((r) => r.pid === pid);
    if (!run) return null;
    const step = db.stepsFor(run.id).find((s) => s.status === "running");
    return { runId: run.id, program: "croft", since: run.startedAt, ...(step ? { asset: step.asset } : {}) };
  } finally {
    db.close();
  }
}

/** The warehouse opened read-only with the `query` sandbox, as query, describe and context use it. */
export function readOnlyWarehouse(ctx: Ctx, project: Project): DuckWarehouse {
  return openWarehouse({
    path: project.paths.database, mode: "read_only", profile: "query", timezone: project.timezone,
    root: project.root, stateDir: project.paths.stateDir, isTTY: ctx.isTTY.stdin && ctx.isTTY.stdout,
    onWait: (h, ms) => ctx.render.progress(`waiting for the warehouse: ${holderText(h)} holds it (${Math.round(ms / 1000)} s so far)`),
    lookupHolder: (pid) => holderFromRuns(project.paths.stateDir, pid),
  });
}

/** Whether an error means "someone else holds the file" (describe and context then use the catalog). */
export function isBusy(e: unknown): e is CroftError {
  return e instanceof CroftError && (e.code === "DB_BUSY" || e.code === "DB_HELD_BY_OTHER_PROGRAM");
}

export interface DescribeColumn {
  name: string;
  type: string;
  pinned: boolean;
  pending: boolean;
  sourceName: string | null;
  format: string | null;
  addedAt: string | null;
  jsonKeys: string[] | null;
  kinds: string[] | null;
}

export interface RecentWrite {
  runId: string | null;
  at: string;
  mode: string | null;
  rowsIn: number | null;
  added: number | null;
  updated: number | null;
  unchanged: number | null;
  deleted: number | null;
  cursorBefore: string | null;
  cursorAfter: string | null;
  schemaChanges: Record<string, unknown>[];
}

export interface WarehouseAsset {
  state: {
    kind: AssetKind | null; write: WriteMode | null; key: string[]; codeHash: string | null;
    cursorValue: string | null; cursorType: CursorType | null; cursorUnit: "s" | "ms" | null;
    lastLoadedAt: string | null; lastReplacedAt: string | null; rowCount: number | null;
  } | null;
  tableExists: boolean;
  rows: number | null;
  columns: DescribeColumn[];
  inputsSeen: Record<string, { seenLoadedAt: string | null; inputLastLoadedAt: string | null; pendingRows: number | null }>;
  recentWrites: RecentWrite[];
  samples: Row[];
}

export const JSON_KEY_LIMIT = 50;
const JSON_KEY_ROWS = 1000;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const typeText = (t: string) => t.replaceAll("TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ").replaceAll("TIME WITH TIME ZONE", "TIMETZ");

async function rowsOf(db: LeaseSql, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params, "json")).rows;
}

/** Up to 50 keys seen inside a JSON column: object keys, or the keys of an array's first element. */
export async function jsonKeys(db: LeaseSql, table: string, column: string): Promise<string[]> {
  const c = quoteIdent(column);
  const rows = await rowsOf(db,
    `SELECT DISTINCT k FROM (
       SELECT unnest(json_keys(CASE WHEN json_type(v) = 'ARRAY' THEN v->0 ELSE v END)) AS k
       FROM (SELECT ${c}::JSON AS v FROM main.${quoteIdent(table)} WHERE ${c} IS NOT NULL LIMIT ${JSON_KEY_ROWS}))
     ORDER BY k LIMIT ${JSON_KEY_LIMIT}`);
  return rows.map((r) => String(r.k));
}

/** What the warehouse knows about one asset. Call inside a read lease. */
export async function readWarehouseAsset(db: LeaseSql, asset: string, o: { samples: number; keys?: boolean } = { samples: 3 }): Promise<WarehouseAsset> {
  const out: WarehouseAsset = { state: null, tableExists: false, rows: null, columns: [], inputsSeen: {}, recentWrites: [], samples: [] };
  const withState = await hasState(db);
  if (withState) {
    const [s] = await rowsOf(db,
      `SELECT kind, write_mode, key_columns, code_hash, cursor_value, cursor_type, cursor_unit, last_loaded_at, last_replaced_at, row_count
       FROM _croft.assets WHERE name = $1`, [asset]);
    if (s) {
      out.state = {
        kind: str(s.kind) as AssetKind | null, write: str(s.write_mode) as WriteMode | null,
        key: Array.isArray(s.key_columns) ? s.key_columns.map(String) : [], codeHash: str(s.code_hash),
        cursorValue: str(s.cursor_value), cursorType: str(s.cursor_type) as CursorType | null, cursorUnit: str(s.cursor_unit) as "s" | "ms" | null,
        lastLoadedAt: str(s.last_loaded_at), lastReplacedAt: str(s.last_replaced_at), rowCount: num(s.row_count),
      };
    }
  }
  const real = await rowsOf(db,
    `SELECT column_name AS name, data_type AS type FROM duckdb_columns()
     WHERE database_name = current_database() AND schema_name = 'main' AND table_name = $1 ORDER BY column_index`, [asset]);
  out.tableExists = real.length > 0;
  const meta = new Map<string, Row>();
  if (withState) {
    for (const r of await rowsOf(db,
      `SELECT name, type, source_name, format, pinned, pending, kinds, added_at FROM _croft.columns WHERE asset = $1`, [asset])) {
      meta.set(String(r.name).toLowerCase(), r);
    }
  }
  if (out.tableExists) {
    const [n] = await rowsOf(db, `SELECT count(*) AS n FROM main.${quoteIdent(asset)}`);
    out.rows = num(n?.n);
    for (const r of real) {
      const name = String(r.name);
      const type = typeText(String(r.type));
      const m = meta.get(name.toLowerCase());
      out.columns.push({
        name, type, pinned: m?.pinned === true, pending: m?.pending === true, sourceName: str(m?.source_name), format: str(m?.format),
        addedAt: str(m?.added_at), kinds: Array.isArray(m?.kinds) ? (m!.kinds as unknown[]).map(String) : null,
        jsonKeys: type === "JSON" && o.keys !== false ? await jsonKeys(db, asset, name) : null,
      });
    }
    if (o.samples > 0) {
      const stamped = real.some((r) => r.name === "_loaded_at");
      out.samples = await rowsOf(db, stamped
        ? `SELECT * EXCLUDE (_loaded_at) FROM main.${quoteIdent(asset)} ORDER BY _loaded_at DESC NULLS LAST LIMIT ${o.samples}`
        : `SELECT * FROM main.${quoteIdent(asset)} LIMIT ${o.samples}`);
    }
  }
  if (withState) {
    for (const r of await rowsOf(db,
      `SELECT i.input, i.seen_loaded_at, a.last_loaded_at FROM _croft.inputs i LEFT JOIN _croft.assets a ON a.name = i.input
       WHERE i.asset = $1 ORDER BY i.input`, [asset])) {
      const input = String(r.input);
      let pendingRows: number | null = null;
      const has = await rowsOf(db,
        `SELECT count(*) AS n FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = 'main'
         AND table_name = $1 AND column_name = '_loaded_at'`, [input]);
      if (num(has[0]?.n)) {
        const [p] = await rowsOf(db,
          `SELECT count(*) AS n FROM main.${quoteIdent(input)}
           WHERE _loaded_at > coalesce((SELECT seen_loaded_at FROM _croft.inputs WHERE asset = $1 AND input = $2), '-infinity'::TIMESTAMPTZ)`,
          [asset, input]);
        pendingRows = num(p?.n);
      }
      out.inputsSeen[input] = { seenLoadedAt: str(r.seen_loaded_at), inputLastLoadedAt: str(r.last_loaded_at), pendingRows };
    }
    out.recentWrites = (await rowsOf(db,
      `SELECT run_id, loaded_at, mode, rows_in, added, updated, unchanged, deleted, cursor_before, cursor_after, schema_changes
       FROM _croft.writes WHERE asset = $1 ORDER BY loaded_at DESC LIMIT 5`, [asset])).map((w) => ({
      runId: str(w.run_id), at: String(w.loaded_at), mode: str(w.mode), rowsIn: num(w.rows_in), added: num(w.added), updated: num(w.updated),
      unchanged: num(w.unchanged), deleted: num(w.deleted), cursorBefore: str(w.cursor_before), cursorAfter: str(w.cursor_after),
      schemaChanges: Array.isArray(w.schema_changes) ? (w.schema_changes as Record<string, unknown>[]) : [],
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Value capping (§4 "Truncation"; §9.6): redaction first, so a cut can never leave half a secret behind

export interface Capped<T> { value: T; cut: number; redacted: boolean }

/**
 * Redact, then cut, one rendered value. Strings longer than `width` end in "…"; an object or array whose
 * JSON is longer becomes that JSON text, cut the same way. `full` keeps whole values (still redacted).
 */
export function capValue(v: unknown, o: { full: boolean; redact: (s: string) => string; width?: number }): Capped<unknown> {
  const width = o.width ?? VALUE_WIDTH;
  let redacted = false;
  const red = (s: string) => {
    const r = o.redact(s);
    if (r !== s) redacted = true;
    return r;
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return red(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) {
        if (k === "__proto__") Object.defineProperty(out, k, { value: walk(val), enumerable: true, writable: true, configurable: true });
        else out[k] = walk(val);
      }
      return out;
    }
    return x;
  };
  const value = walk(v);
  if (o.full) return { value, cut: 0, redacted };
  if (typeof value === "string") {
    const t = truncate(value, width);
    return { value: t.text, cut: t.cut ? 1 : 0, redacted };
  }
  if (value && typeof value === "object") {
    const text = toJsonLine(value).trimEnd();
    const t = truncate(text, width);
    return t.cut ? { value: t.text, cut: 1, redacted } : { value, cut: 0, redacted };
  }
  return { value, cut: 0, redacted };
}

/** capValue over every value of every row. */
export function capRows(rows: readonly Row[], o: { full: boolean; redact: (s: string) => string }): Capped<Row[]> {
  let cut = 0;
  let redacted = false;
  const value = rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) {
      const c = capValue(v, o);
      cut += c.cut;
      redacted ||= c.redacted;
      if (k === "__proto__") Object.defineProperty(out, k, { value: c.value, enumerable: true, writable: true, configurable: true });
      else out[k] = c.value;
    }
    return out;
  });
  return { value, cut, redacted };
}

// ---------------------------------------------------------------------------------------------------------
// The command

export interface DescribeData {
  asset: string;
  kind: AssetKind | null;
  file: string | null;
  description: string | null;
  next: { at: string | null; reason: string };
  behavior: Behavior;
  reads: string[];
  readBy: string[];
  rows: number | null;
  columns: DescribeColumn[];
  inputsSeen: WarehouseAsset["inputsSeen"];
  builtWithCodeHash: string | null;
  checks: { check: string; blocking: boolean; implied: boolean }[];
  /** false in phase 1: the checks above are listed, not run (core/phase.ts). */
  checksEnforced: boolean;
  recentWrites: RecentWrite[];
  recentRuns: { runId: string; status: string; at: string; durationMs: number | null; code: string | null }[];
  samples: Row[];
  truncatedValues: number;
  /** Where table facts came from: the warehouse, the catalog mirror (warehouse busy), or nowhere yet. */
  source: "warehouse" | "catalog" | "none";
  catalogRefreshedAt?: string;
  /** Set when a sample value was redacted (as main.ts does for the rest of the data). */
  redactedValues?: true;
}

/** Test hook: how long describe waits for a write step before using the catalog (§5: seconds). */
export const DESCRIBE_TIMING = { busyWaitMs: 5000 };

export const describe: CommandImpl<DescribeData> = {
  async run(ctx) {
    const name = ctx.positionals[0];
    if (!name) {
      throw new CroftError("USAGE_ERROR", {
        message: "croft describe needs an asset name", hint: "usage: croft describe <asset> (croft status lists them)",
        fix: { kind: "command", description: "list the assets", command: "croft status" },
      });
    }
    const project = ctx.project;
    const tz = project.timezone;
    const discovery = await discoverAssets(project.root, { assetsDir: project.paths.assetsDir });
    const found = discovery.assets.find((a) => a.name === name) ?? null;
    const runs = openRunsDb(project.paths.stateDir);
    let catalog: CatalogAsset | null = null;
    let catalogRefreshedAt: string | null = null;
    let steps: StepRecord[] = [];
    let dead = new Set<string>();
    try {
      if (runs) {
        const entry = runs.catalogGet<CatalogAsset>(name);
        catalog = entry?.value ?? null;
        catalogRefreshedAt = entry?.refreshedAt ?? null;
        steps = runs.sqlite.query("SELECT run_id, asset, attempt FROM steps WHERE asset = ? ORDER BY started_at DESC, attempt DESC LIMIT 5")
          .all(name).map((r) => { const x = r as { run_id: string; asset: string; attempt: number }; return runs.getStep(x.run_id, x.asset, x.attempt)!; });
        dead = runningEntries(runs, tz).dead;
      }
    } finally {
      runs?.close();
    }
    const unknown = () => {
      const guess = didYouMean(name, discovery.assets.map((a) => a.name));
      return new CroftError("UNKNOWN_TABLE", {
        message: `there is no asset named ${name}`,
        hint: guess ? `did you mean ${guess}?` : "croft status lists the assets",
        fix: guess ? { kind: "command", description: `describe ${guess}`, command: `croft describe ${guess}` }
          : { kind: "command", description: "list the assets", command: "croft status" },
        details: { asset: name, ...(guess ? { suggestion: guess } : {}) },
      });
    };
    // Asset names are table names; anything else cannot name one.
    if (!found && !catalog && !NAME_PATTERN.test(name)) throw unknown();

    const configs = await declareProjectSecrets(ctx, project, await loadConfigs(project, discovery.assets, { importTimeoutMs: 5000 }));
    const config = configs.find((c) => c.name === name) ?? null;
    const problems = config ? config.problems : [];

    let wh: WarehouseAsset | null = null;
    let source: DescribeData["source"] = "none";
    const next: { command: string; reason: string }[] = [];
    try {
      wh = await readOnlyWarehouse(ctx, project).read((db) => readWarehouseAsset(db, name, { samples: 3 }),
        { purpose: `describe ${name}`, waitMs: DESCRIBE_TIMING.busyWaitMs });
      source = "warehouse";
    } catch (e) {
      if (isBusy(e)) {
        const holder = e.problem.details?.holder as LockHolder | undefined;
        ctx.render.progress(`the warehouse is busy${holder ? ` (${holderText(holder)})` : ""}; showing the catalog copy without samples`);
        next.push({ command: `croft describe ${name}`, reason: "again when the run has finished, for samples and recent writes" });
        source = catalog ? "catalog" : "none";
      } else if (!(e instanceof CroftError && e.code === "DB_NOT_FOUND")) throw e;
    }
    // Known from the file, the mirror, or (with neither, e.g. runs.sqlite deleted) the warehouse's own state.
    if (!found && !catalog && !wh?.state && !wh?.tableExists) throw unknown();

    const kind = config?.kind ?? wh?.state?.kind ?? catalog?.kind ?? (found ? sniffKind(found) : null);
    const cat: CatalogAsset | null = catalog;
    const behavior = behaviorOf(config, cat ?? stateAsCatalog(name, wh));
    if (wh?.state && behavior.incremental) {
      behavior.incremental.cursorValue = wh.state.cursorValue;
      behavior.incremental.cursorType = wh.state.cursorType;
      behavior.incremental.unit ??= wh.state.cursorUnit;
    }
    const redact = (s: string) => ctx.env.redactData(s);
    const full = ctx.values["full-values"] === true;
    const samples = capRows(wh?.samples ?? [], { full, redact });
    const columns = source === "warehouse" ? wh!.columns : (cat?.columns ?? []).map((c) => ({
      name: c.name, type: c.type, pinned: c.pinned, pending: c.pending, sourceName: c.sourceName, format: c.format, addedAt: null,
      jsonKeys: c.jsonKeys ?? null, kinds: null,
    }));
    const data: DescribeData = {
      asset: name,
      kind,
      file: found?.file ?? null,
      description: config?.description ?? null,
      next: nextOf(kind, !!found),
      behavior,
      reads: config?.inputs ?? [],
      readBy: [],
      rows: source === "warehouse" ? wh!.rows : cat?.rows ?? null,
      columns,
      inputsSeen: wh?.inputsSeen ?? {},
      builtWithCodeHash: wh?.state?.codeHash ?? cat?.codeHash ?? null,
      checks: checksOf(config, behavior.key),
      checksEnforced: CHECKS_ENFORCED,
      recentWrites: wh?.recentWrites ?? [],
      recentRuns: steps.map((s) => ({
        runId: s.runId, status: effectiveStatus(s, dead), at: zoned(s.finishedAt ?? s.startedAt, tz)!,
        durationMs: s.finishedAt ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : null, code: s.error?.code ?? null,
      })),
      samples: samples.value,
      truncatedValues: samples.cut,
      source,
    };
    if (source === "catalog" && catalogRefreshedAt) data.catalogRefreshedAt = zoned(catalogRefreshedAt, tz)!;
    if (samples.redacted) data.redactedValues = true;
    // An orphan (its asset file is gone) is a warning with a manual fix. Deleting the table is destructive, so
    // it never appears in next (§4.3): only the user decides that.
    if (!found) problems.push(orphanTable(name, kind, data.rows));
    else if (!wh?.tableExists && source !== "catalog" && !cat) next.push({ command: `croft run ${name}`, reason: "build the table" });
    if (samples.cut > 0) next.push({ command: `croft describe ${name} --full-values`, reason: "sample values were cut to 80 characters" });
    return { data, problems, next };
  },
  human(result, ctx) {
    return formatDescribe(result.data, ctx.project.timezone, ctx.render.style.bold);
  },
};

/** ORPHAN_TABLE: the table outlived its asset file. No run updates it any more; it is kept until the user
 *  decides, because deleting a table is destructive. */
function orphanTable(name: string, kind: AssetKind | null, rows: number | null): Problem {
  const file = `assets/${name}.${kind === "sql" ? "sql" : "ts"}`;
  return problem("ORPHAN_TABLE", {
    asset: name,
    message: `${name} has no asset file (${file} is gone); its table${rows !== null ? ` of ${formatCount(rows)} rows` : ""} is kept, but no run updates it`,
    hint: `put ${file} back to keep updating it; if the table should go instead, ask the user first: deleting it is destructive`,
    fix: { kind: "manual", requiresHuman: true, description: `restore ${file}, or ask the user whether ${name} should be deleted` },
  });
}

/** _croft.assets facts in the catalog's shape, so behaviorOf reads either. */
function stateAsCatalog(name: string, wh: WarehouseAsset | null): CatalogAsset | null {
  const s = wh?.state;
  if (!s || !s.kind || !s.write) return null;
  return {
    asset: name, kind: s.kind, behavior: "", write: s.write, key: s.key, rows: s.rowCount ?? 0, columns: [],
    cursor: s.cursorValue !== null || s.cursorType !== null ? { field: "", value: s.cursorValue, type: s.cursorType, unit: s.cursorUnit } : null,
    lastLoadedAt: s.lastLoadedAt, lastReplacedAt: s.lastReplacedAt, lastRunId: null, codeHash: s.codeHash,
  };
}

/** An epoch cursor shown with its instant: 1758600000 (2025-09-22T21:00:00-07:00). */
function cursorText(b: Behavior, tz: string): string | null {
  const inc = b.incremental;
  if (!inc || inc.kind !== "cursor") return null;
  const value = inc.cursorValue;
  if (value === null) return `${inc.field} (nothing saved yet: the first run fetches everything)`;
  let extra = "";
  if (inc.unit && /^-?\d+(\.\d+)?$/.test(value)) {
    const ms = Number(value) * (inc.unit === "s" ? 1000 : 1);
    if (Number.isFinite(ms)) extra = ` (${zoned(new Date(ms).toISOString(), tz)})`;
  }
  return `${inc.field} = ${value}${extra}`;
}

export function columnsText(columns: readonly { name: string; type: string; pending?: boolean; jsonKeys?: string[] | null }[], max = 12): string {
  const parts = columns.filter((c) => c.name !== "_loaded_at").map((c) => {
    let t = `${c.name} ${c.type}`;
    if (c.pending) t += " (no values yet)";
    if (c.jsonKeys && c.jsonKeys.length) {
      const shown = c.jsonKeys.slice(0, 3).join(", ");
      t += ` {${shown}${c.jsonKeys.length > 3 ? `, … ${c.jsonKeys.length} keys` : ""}}`;
    }
    return t;
  });
  const shown = parts.slice(0, max).join(" · ");
  return parts.length > max ? `${shown} · … ${parts.length - max} more` : shown;
}

export function formatDescribe(d: DescribeData, tz: string, bold: (s: string) => string = (s) => s): string {
  const label = (s: string) => bold(s.padEnd(10));
  const next = d.next.reason === "none" ? "no asset file" : d.next.reason;
  const lines = [[d.asset, d.kind ?? "unknown kind", d.file ?? "(no asset file)", next].join(" · ")];
  if (d.description) lines.push(`${label("About")} ${d.description}`);
  lines.push(`${label("Behavior")} ${d.behavior.words}`);
  const cursor = cursorText(d.behavior, tz);
  if (cursor) lines.push(`${label("Cursor")} ${cursor}`);
  if (d.reads.length) lines.push(`${label("Reads")} ${d.reads.join(", ")}`);
  if (d.readBy.length) lines.push(`${label("Read by")} ${d.readBy.join(", ")}`);
  if (d.rows === null && d.columns.length === 0) {
    lines.push(`${label("Table")} not built yet`);
  } else {
    const w = d.recentWrites[0];
    const last = w ? ` · last write ${w.at} (+${formatCount(w.added ?? 0)} added, ${formatCount(w.updated ?? 0)} updated)` : "";
    const from = d.source === "catalog" ? ` · from the catalog${d.catalogRefreshedAt ? ` of ${d.catalogRefreshedAt}` : ""} (warehouse busy)` : "";
    lines.push(`${label("Table")} ${d.rows === null ? "?" : formatCount(d.rows)} rows · ${d.columns.filter((c) => c.name !== "_loaded_at").length} columns${last}${from}`);
    if (d.columns.length) lines.push(`${label("Columns")} ${columnsText(d.columns)}`);
  }
  for (const [input, s] of Object.entries(d.inputsSeen)) {
    lines.push(`${label("Input")} ${input}: ${s.pendingRows === null ? "?" : formatCount(s.pendingRows)} new rows since ${s.seenLoadedAt ?? "never"}`);
  }
  if (d.checks.length) {
    lines.push(`${label("Checks")} ${d.checks.map((c) => (c.blocking ? c.check : `warn ${c.check}`)).join(" · ")}`);
    if (d.checksEnforced === false) lines.push(`${" ".repeat(11)}${CHECKS_NOT_ENFORCED}`);
  }
  if (d.recentRuns.length) {
    lines.push(`${label("Recent")} ${d.recentRuns.map((r) => `${r.runId} ${r.status}${r.code ? ` ${r.code}` : ""}${r.durationMs !== null ? ` ${formatDuration(r.durationMs)}` : ""}`).join(" · ")}`);
  }
  if (d.samples.length) {
    const cols = [...new Set(d.samples.flatMap((r) => Object.keys(r)))];
    const t = table(cols, d.samples.map((r) => cols.map((c) => r[c])), { limit: Infinity, indent: " ".repeat(11), maxWidth: Infinity });
    lines.push(`${label("Sample")} ${t.text.trimStart()}`);
    if (d.truncatedValues > 0) lines.push(`${" ".repeat(11)}(values cut to 80 characters; --full-values shows them whole)`);
  }
  return lines.join("\n");
}

// croft query "<sql>" [--limit N] [--full-values] (DESIGN.md §4.1, §4.2, §4.3 "query", §5 "Sandboxing every
// DuckDB instance"). One SELECT against the warehouse, read-only and sandboxed:
//
// - The file is opened READ_ONLY with the `query` sandbox (only files/ is reachable) under a read lease, which
//   waits only for the current write step and names the holder while it waits.
// - The SQL passes the one-SELECT gate (sql/gate.ts) with the state folder protected, so a query can never
//   write, never touch runs.sqlite, and never open the database file a second time.
// - Paths in the SQL are relative to the project folder, wherever croft was started, so the zero-asset read
//   `croft query "from 'files/sales/*.csv'"` works from any subfolder. Anything outside files/ is
//   QUERY_PATH_DENIED.
// - Before anything has run there is no warehouse, and a read-only command never creates it: the query runs
//   on a private in-memory DuckDB with the same `query` sandbox, so the zero-asset path works in a fresh
//   project. A table named there is DB_NOT_FOUND with the run that builds it (UNKNOWN_TABLE for other names).
// - Rows are capped at 50 and values at 80 characters (--limit N and --full-values lift the caps), and the
//   result is streamed: rows past the cap are counted in chunks, never converted to JavaScript.
// - Values are redacted before they are cut (so a cut never leaves half a secret behind), after the
//   project's declared secrets are declared (ProjectEnv.redactData hides those whatever they look like).
//
// --preview (the preview database) arrives with croft preview in phase 2.
import { type DuckDBConnection, DuckDBInstance, DuckDBResultReader } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { CroftError } from "../../core/errors.ts";
import { connect, instanceConfig } from "../../db/connect.ts";
import type { ColumnInfo } from "../../db/values.ts";
import { renderValue, resultColumns } from "../../db/values.ts";
import type { Project } from "../../project/root.ts";
import { didYouMean } from "../../project/suggest.ts";
import { mapQueryError } from "../../read/select.ts";
import { assertOneSelect } from "../../sql/gate.ts";
import type { Row } from "../../types.ts";
import type { CommandImpl } from "../command.ts";
import { formatCount, formatDuration, table } from "../render.ts";
import { type AssetConfig, capValue, declareProjectSecrets, readOnlyWarehouse } from "./describe.ts";

export interface QueryData {
  columns: ColumnInfo[];
  rows: Row[];
  rowCount: number;
  truncatedRows: number;
  truncatedValues: number;
  /** Set when a value was redacted (as main.ts does for other data). */
  redactedValues?: true;
}

export const DEFAULT_LIMIT = 50;

/** --limit N: a whole number of rows, 0 or more. */
export function parseLimit(v: unknown): number {
  if (v === undefined) return DEFAULT_LIMIT;
  const text = String(v).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new CroftError("USAGE_ERROR", {
      message: `--limit needs a whole number of rows; got ${JSON.stringify(String(v))}`,
      hint: "for example --limit 200",
      fix: { kind: "manual", description: "pass --limit with a whole number, such as --limit 200" },
    });
  }
  return Number(text);
}

/** Run `fn` with the process working directory at `dir`, so relative paths in SQL (which DuckDB and the gate
 *  both resolve against the process's directory) mean the project folder. */
export async function inDirectory<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  if (before === dir) return fn();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

interface Raw { columns: ColumnInfo[]; rows: Row[]; rowCount: number }

export const query: CommandImpl<QueryData> = {
  async run(ctx) {
    if (ctx.values.preview === true) {
      throw new CroftError("USAGE_ERROR", {
        message: "croft query --preview reads the preview database, which comes with croft preview in a later version",
        hint: "query the live tables without --preview; this version has no croft preview yet",
        fix: { kind: "manual", description: "drop --preview and query the live warehouse" },
      });
    }
    const sql = ctx.positionals[0];
    if (sql === undefined || sql.trim() === "") {
      throw new CroftError("USAGE_ERROR", {
        message: "croft query needs one SELECT, in quotes",
        hint: `usage: croft query "select state, count(*) from github_issues group by 1"`,
        fix: { kind: "manual", description: "pass the SELECT as one quoted argument" },
      });
    }
    const limit = parseLimit(ctx.values.limit);
    const full = ctx.values["full-values"] === true;
    const project = ctx.project;
    // Declared secrets first: their values are redacted from the rows whatever they look like.
    const configs = await declareProjectSecrets(ctx, project);

    const run = (conn: DuckDBConnection) => inDirectory(project.root, () => selectRows(conn, sql, limit, project.timezone, project.paths.stateDir));
    // No warehouse yet (nothing has run): an in-memory DuckDB, never a new warehouse file.
    const raw = existsSync(project.paths.database)
      ? await readOnlyWarehouse(ctx, project).read((db) => run(db.connection), { purpose: "croft query" })
      : await withoutWarehouse(project, configs, run);

    const redact = (s: string) => ctx.env.redactData(s);
    let truncatedValues = 0;
    let redacted = false;
    const rows = raw.rows.map((r) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(r)) {
        const c = capValue(v, { full, redact });
        truncatedValues += c.cut;
        redacted ||= c.redacted;
        if (k === "__proto__") Object.defineProperty(out, k, { value: c.value, enumerable: true, writable: true, configurable: true });
        else out[k] = c.value;
      }
      return out;
    });
    const data: QueryData = {
      columns: raw.columns, rows, rowCount: raw.rowCount, truncatedRows: raw.rowCount - rows.length, truncatedValues,
    };
    if (redacted) data.redactedValues = true;
    const next = data.truncatedRows > 0
      ? [{ command: `croft query ${shellArg(sql)} --limit ${Math.min(raw.rowCount, Math.max(limit * 4, 200))}`, reason: `${formatCount(data.truncatedRows)} more rows; or aggregate in SQL` }]
      : [];
    return { data, problems: [], next };
  },
  human(result, ctx) {
    return formatQuery(result.data, performance.now() - ctx.startedAt);
  },
};

/** Gate, prepare and stream one SELECT: at most `limit` rows are converted, the rest counted chunk by chunk. */
async function selectRows(conn: DuckDBConnection, sql: string, limit: number, tz: string, stateDir: string): Promise<Raw> {
  await assertOneSelect(conn, sql, { profile: "query", protect: [stateDir] });
  let stmt;
  try {
    stmt = await conn.prepare(sql);
  } catch (e) {
    throw mapQueryError(e, "query");
  }
  try {
    const result = await stmt.stream();
    const reader = new DuckDBResultReader(result);
    await reader.readUntil(limit);
    const columns = resultColumns(reader);
    const names = reader.deduplicatedColumnNames();
    const types = reader.columnTypes();
    const shown = Math.min(limit, reader.currentRowCount);
    const rows: Row[] = [];
    for (let r = 0; r < shown; r++) {
      const row: Row = {};
      for (let c = 0; c < names.length; c++) {
        const v = renderValue(reader.value(c, r), types[c]!, { mode: "json", timezone: tz });
        if (names[c] === "__proto__") Object.defineProperty(row, "__proto__", { value: v, enumerable: true, writable: true, configurable: true });
        else row[names[c]!] = v;
      }
      rows.push(row);
    }
    // Count what is left without converting it: chunk by chunk, each dropped as soon as it is counted.
    let rowCount = reader.currentRowCount;
    if (!reader.done) {
      for (;;) {
        const chunk = await result.fetchChunk();
        if (!chunk || chunk.rowCount === 0) break;
        rowCount += chunk.rowCount;
      }
    }
    return { columns, rows, rowCount };
  } catch (e) {
    throw mapQueryError(e, "query");
  } finally {
    stmt.destroySync();
  }
}

/** connect.ts keeps its sandbox bookkeeping per instance key. Each in-memory instance here is fresh, so it is
 *  configured on its first connection, and one key serves every such query of a process. */
const MEMORY_KEY = ":memory:croft-query";

/**
 * A query in a project that has no warehouse yet (nothing has run). It runs on a private in-memory DuckDB
 * with the instance options and the `query` sandbox of every croft connection (files/ only, no extension
 * loading, configuration locked), so `croft query "from 'files/x.csv'"` needs no run and creates no file.
 */
async function withoutWarehouse(project: Project, configs: readonly AssetConfig[], run: (conn: DuckDBConnection) => Promise<Raw>): Promise<Raw> {
  const instance = await DuckDBInstance.create(":memory:", instanceConfig("read_write"));
  let conn: DuckDBConnection | undefined;
  try {
    conn = await connect(instance, { profile: "query", timezone: project.timezone, root: project.root }, MEMORY_KEY);
    return await run(conn);
  } catch (e) {
    throw notBuiltYet(e, project, configs);
  } finally {
    conn?.disconnectSync();
    instance.closeSync();
  }
}

/** A table named before the first run cannot exist yet. An asset's name is DB_NOT_FOUND with the run that
 *  builds that one asset (not a bare `croft run`, which would fetch every ingest); another name stays
 *  UNKNOWN_TABLE, with the closest asset name when there is one. */
function notBuiltYet(e: unknown, project: Project, configs: readonly AssetConfig[]): unknown {
  if (!(e instanceof CroftError) || e.code !== "UNKNOWN_TABLE") return e;
  const table = /^no table named (\S+)/.exec(e.problem.message)?.[1]?.replace(/^"|"$/g, "");
  if (!table) return e;
  const names = configs.map((c) => c.name);
  const asset = names.find((n) => n === table.toLowerCase());
  if (asset) {
    return new CroftError("DB_NOT_FOUND", {
      message: `${asset} is not built yet: nothing has run in this project, so ${project.databaseLabel} does not exist`,
      hint: `build it first: croft run ${asset} (files under files/ can be queried already)`,
      fix: { kind: "command", description: `build ${asset}`, command: `croft run ${asset}` },
      details: { ...e.problem.details, table, asset },
    });
  }
  const guess = didYouMean(table, names);
  return new CroftError("UNKNOWN_TABLE", {
    message: `no table named ${table}: nothing has run in this project yet, so there are no tables`,
    hint: guess ? `did you mean ${guess}? build it first: croft run ${guess}`
      : names.length ? `the assets are ${names.join(", ")}; build one with croft run <asset>`
      : "files under files/ can be queried already; croft new --list shows the assets croft can make",
    ...(guess ? { fix: { kind: "command" as const, description: `build ${guess}`, command: `croft run ${guess}` } } : {}),
    details: { ...e.problem.details, table, ...(guess ? { suggestion: guess } : {}) },
  });
}

function shellArg(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

const ID_LIKE = /(^|_)id$|^id_|^number$|year$/i;

/** A cell for the human table: integers get thousands separators, except in id-like columns. */
function humanCell(v: unknown, column: string): unknown {
  if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) >= 1000 && !ID_LIKE.test(column)) return formatCount(v);
  return v;
}

export function formatQuery(d: QueryData, elapsedMs: number): string {
  const header = d.columns.map((c) => c.name);
  const keys = d.rows.length ? Object.keys(d.rows[0]!) : header;
  const t = table(header, d.rows.map((r) => keys.map((k, i) => humanCell(r[k], header[i] ?? k))), {
    limit: Infinity, total: d.rowCount, maxWidth: Infinity, moreRows: "--limit N",
  });
  const lines = [t.text];
  if (d.truncatedValues > 0) lines.push("(values cut to 80 characters; --full-values shows them whole)");
  lines.push(`(${formatCount(d.rowCount)} row${d.rowCount === 1 ? "" : "s"}, ${formatDuration(elapsedMs)})`);
  return lines.join("\n");
}

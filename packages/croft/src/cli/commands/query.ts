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
// - Rows are capped at 50 and values at 80 characters (--limit N and --full-values lift the caps), and the
//   result is streamed: rows past the cap are counted in chunks, never converted to JavaScript.
// - Values are redacted before they are cut (so a cut never leaves half a secret behind), after the
//   project's declared secrets are declared (ProjectEnv.redactData hides those whatever they look like).
//
// --preview (the preview database) arrives with croft preview in phase 2.
import { DuckDBResultReader } from "@duckdb/node-api";
import { CroftError } from "../../core/errors.ts";
import type { ColumnInfo } from "../../db/values.ts";
import { renderValue, resultColumns } from "../../db/values.ts";
import { mapQueryError } from "../../read/select.ts";
import { assertOneSelect } from "../../sql/gate.ts";
import type { Row } from "../../types.ts";
import type { CommandImpl } from "../command.ts";
import { formatCount, formatDuration, table } from "../render.ts";
import { capValue, declareProjectSecrets, readOnlyWarehouse } from "./describe.ts";

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
    await declareProjectSecrets(ctx, project);

    const tz = project.timezone;
    const warehouse = readOnlyWarehouse(ctx, project);
    const raw = await warehouse.read((db) => inDirectory(project.root, async (): Promise<Raw> => {
      const conn = db.connection;
      await assertOneSelect(conn, sql, { profile: "query", protect: [project.paths.stateDir] });
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
    }), { purpose: "croft query" });

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

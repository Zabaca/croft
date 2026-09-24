// croft preview <asset…> [--rows N] [--rebuild] (DESIGN.md §4.1, §4.2, §6 "Ways to try a change" 2). Builds the
// named assets in .croft/preview.duckdb from Parquet snapshots of their live inputs (taken under one short read
// lease; the live file is never ATTACHed), and diffs each against its live table: row counts, added, removed
// and changed rows by key, column changes, checks and samples. SQL downstream of a named transform is built too;
// an ingest fetches at most --rows rows from its saved position, which does not move, and its downstream is
// listed, not built. `croft query --preview` explores the result. The engine is run/preview.ts; this file parses
// the flags, cuts the samples like query output, and prints (§4.2):
//
//   Preview: your real tables are not changed.
//   open_issues   4,211 rows (live 4,208)   +3 added · 0 removed · 12 changed (by key id)
//     columns     + comments BIGINT
//     checks      ok unique(id) · ok not_null(id) · warn id > 0: 2 rows
//     sample      id    title                 author
//                 2291  Crash on Windows …    jarred
//   Explore: croft query --preview "from open_issues"
//   Apply:   croft run open_issues
//
// Data: PreviewData (core/types.ts). Its spec (usage, options) is in commands/index.ts. Preview processes are
// read-only on the warehouse: no write intent, and lock waits of 60 s on a terminal and 90 s off it.
import { relative } from "node:path";
import { CroftError } from "../../core/errors.ts";
import type { PreviewAsset, PreviewData, Problem, StepResult } from "../../core/types.ts";
import { DEFAULT_PREVIEW_ROWS, previewDirectory, previewRows, runPreview } from "../../run/preview.ts";
import type { Row } from "../../types.ts";
import type { CommandImpl, CommandResult, Next } from "../command.ts";
import { formatCount, formatDuration, redactProblem, table } from "../render.ts";
import { capValue, holderFromRuns, holderText } from "./describe.ts";

/** --rows N: a whole number of rows, from 1 to 100,000 (run/preview.ts previewRows). */
export function parseRows(v: unknown): number {
  if (v === undefined) return DEFAULT_PREVIEW_ROWS;
  const text = String(v).trim();
  return previewRows(/^\d+$/.test(text) ? Number(text) : Number.NaN, String(v));
}

/** Sample values in a table cell are cut shorter than query's 80 characters: a sample is a glance. */
const SAMPLE_WIDTH = 40;

/** The result of run(): with the Explore and Apply commands human() prints (for --json they are in `next`).
 *  main.ts hands human() a copy of the result made with a spread, which keeps `shown`. */
type PreviewResult = CommandResult<PreviewData> & { shown: PreviewShown };

export const preview: CommandImpl<PreviewData> = {
  async run(ctx) {
    // Left out, --rows stays unset: a transform that makes requests then gets at most its confirmAbove rows.
    const rows = ctx.values.rows === undefined ? undefined : parseRows(ctx.values.rows);
    const rebuild = ctx.values.rebuild === true;
    const project = ctx.project;
    const interactive = ctx.isTTY.stdin && ctx.isTTY.stdout;
    const ac = new AbortController();
    let signals = 0;
    const onSignal = (sig: NodeJS.Signals) => {
      if (++signals > 1) process.exit(130); // a second Ctrl-C does not wait for cleanup
      ac.abort(new CroftError("INTERRUPTED", {
        message: `the preview was stopped by ${sig}`,
        hint: "nothing real changed; preview again when you are ready",
      }));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let out;
    try {
      out = await runPreview({
        project, env: ctx.env, selectors: [...ctx.positionals], ...(rows !== undefined ? { rows } : {}), rebuild, interactive, signal: ac.signal, now: () => ctx.now(),
        onWait: (h, ms, what) => ctx.render.progress(`waiting for ${what}: ${holderText(h)} holds it (${Math.round(ms / 1000)} s so far)`),
        lookupHolder: (pid) => holderFromRuns(project.paths.stateDir, pid),
        ...(interactive && !ctx.json ? { onProgress: (line: string) => ctx.render.progress(line) } : {}),
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    // Samples are redacted and cut like query output (--json keeps 80 characters, as query does). An asset's error
    // is a problem, redacted as free text like problems[] (every .env value), and so is a reason that quotes it.
    const redact = (s: string) => ctx.env.redactData(s);
    const text = (s: string) => ctx.env.redact(s);
    for (const a of out.data.assets) {
      a.sample = a.sample.map((r) => capRow(r, redact));
      if (!a.error) continue;
      if (a.reason.startsWith(`${a.error.code}: `)) a.reason = text(a.reason);
      a.error = redactProblem(a.error, text);
    }
    const first = out.built[0];
    const explore = first !== undefined ? `croft query --preview "from ${first}"` : undefined;
    const apply = out.apply.length ? `croft run ${out.apply.join(" ")}` : undefined;
    const next: Next[] = [
      ...(explore ? [{ command: explore, reason: "explore what the preview built (it stays until the next preview)" }] : []),
      ...(apply ? [{ command: apply, reason: "apply: build them for real" }] : []),
      ...out.next,
    ];
    const result: PreviewResult = {
      data: out.data, problems: out.problems, next: ctx.json ? next : out.next,
      shown: { ...(explore ? { explore } : {}), ...(apply ? { apply } : {}) },
    };
    return result;
  },
  human(result, ctx) {
    const shown = (result as Partial<PreviewResult>).shown ?? {};
    return formatPreview(result.data, {
      ...shown, logs: relative(ctx.cwd, previewDirectory(ctx.project.paths.stateDir)) || ".", warnings: warningChecks(result.problems),
    });
  },
};

/** One sample row, redacted and cut to 80 characters per value, as `croft query` shows rows. */
function capRow(r: Row, redact: (s: string) => string): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    const c = capValue(v, { full: false, redact });
    if (k === "__proto__") Object.defineProperty(out, k, { value: c.value, enumerable: true, writable: true, configurable: true });
    else out[k] = c.value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Human output (§4.2)

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;
const LABEL = 12;
const label = (l: string) => `  ${l.padEnd(LABEL)}`;
const PAD = " ".repeat(LABEL + 2);

export interface PreviewShown {
  explore?: string;
  apply?: string;
  /** The folder of the preview's logs, relative to where croft ran. */
  logs?: string;
  /** The failing checks that are warnings (non-blocking), as `<asset>\u0000<check>`: shown as "warn", not "fail". */
  warnings?: ReadonlySet<string>;
}

/** The warnings among the failing checks: CHECK_FAILED problems of warning severity name their check. */
function warningChecks(problems: readonly Problem[]): Set<string> {
  return new Set(problems.filter((p) => p.code === "CHECK_FAILED" && p.severity === "warning" && typeof p.details?.check === "string")
    .map((p) => `${p.asset ?? ""}\u0000${String(p.details!.check)}`));
}

export function formatPreview(d: PreviewData, o: PreviewShown = {}): string {
  const lines: string[] = [header(d)];
  const width = Math.max(14, ...d.assets.map((a) => a.asset.length + 1));
  for (const a of d.assets) lines.push(...assetLines(a, width, d, o));
  if (o.explore) lines.push(`Explore: ${o.explore}`);
  if (o.apply) lines.push(`Apply:   ${o.apply}`);
  return lines.join("\n");
}

function header(d: PreviewData): string {
  const ingests = d.assets.filter((a) => a.kind === "ingest");
  if (d.assets.length > 0 && ingests.length === d.assets.length) {
    const since = ingests.length === 1 ? ingests[0]!.since : undefined;
    return since !== undefined
      ? `Preview: nothing is saved and the saved position (since ${since}) does not move.`
      : "Preview: nothing is saved and your real tables are not changed.";
  }
  return "Preview: your real tables are not changed.";
}

function assetLines(a: PreviewAsset, width: number, d: PreviewData, o: PreviewShown): string[] {
  const name = a.asset.padEnd(width);
  if (a.status === "skipped") return [`${name}skipped: ${a.reason}`];
  if (a.status === "failed" && a.diff === null) {
    const e = a.error;
    return [`${name}failed: ${e ? `${e.code}: ${e.message.split("\n")[0]}` : a.reason}`, `${label("log")}${o.logs ?? ".croft/preview"}/logs/${a.asset}.log`];
  }
  const out: string[] = [];
  if (a.kind === "ingest") {
    const how = [a.requests !== undefined ? plural(a.requests, "request") : undefined, formatDuration(a.durationMs),
      a.capped ? `stopped at --rows ${formatCount(d.rowCap)}` : undefined].filter(Boolean).join(", ");
    out.push(`${name}fetched ${plural(a.rows ?? 0, "row")} (${how})${failedNote(a)}`);
    if (a.since !== undefined && d.assets.length > 1) out.push(`${label("since")}${a.since} (the saved position does not move)`);
  } else {
    const live = a.liveRows === null ? "new table" : `live ${formatCount(a.liveRows)}`;
    const rows = `${plural(a.rows ?? 0, "row")}${a.partial && a.diff ? " built" : ""} (${live})`;
    out.push(`${name}${rows}   ${a.diff ? diffWords(a, d.rebuild) : ""}`.trimEnd() + failedNote(a));
  }
  if (a.columns.length) out.push(`${label("columns")}${columnsWords(a)}`);
  if (a.checks.length) out.push(`${label("checks")}${a.checks.map((c) => checkWords(c, o.warnings?.has(`${a.asset}\u0000${c.check}`) === true)).join(" · ")}`);
  if (a.kind === "ingest" && a.diff) out.push(`${label("diff")}${ingestDiff(a)}`);
  if (a.reason && (a.kind !== "ingest" || /CSV header|unchanged/.test(a.reason) || a.capped)) out.push(`${label("note")}${a.reason}`);
  if (a.sample.length) {
    const cols = [...new Set(a.sample.flatMap((r) => Object.keys(r)))];
    const t = table(cols, a.sample.map((r) => cols.map((c) => r[c])), { limit: Infinity, maxWidth: SAMPLE_WIDTH, gap: 2, moreValues: "croft query --preview" });
    const [head, ...rest] = t.text.split("\n");
    out.push(`${label("sample")}${head}`, ...rest.map((l) => `${PAD}${l}`));
  }
  if (a.downstream.length) {
    const why = a.kind === "ingest" ? "not built in an ingest preview" : "not built in this preview";
    out.push(`${label("downstream")}${a.downstream.join(", ")} would update (${why})`);
  }
  return out;
}

/** Built, but a real run would fail (a blocking check): said on the asset's line. */
function failedNote(a: PreviewAsset): string {
  return a.status === "failed" ? ` · a real run would fail: ${a.error?.code ?? "an error"}` : "";
}

function by(a: PreviewAsset): string {
  return a.diff && a.diff.by.length ? `by key ${a.diff.by.join(", ")}` : "by whole rows";
}

/** A transform's diff: "+3 added · 0 removed · 12 changed (by key id)", with how many keys a partial preview
 *  touched, or how many rows differ in a --rebuild. */
function diffWords(a: PreviewAsset, rebuild: boolean): string {
  const x = a.diff!;
  const counts = `+${formatCount(x.added)} added · ${formatCount(x.removed)} removed · ${formatCount(x.changed)} changed (${by(a)})`;
  const differ = x.added + x.removed + x.changed;
  if (a.partial) {
    const touched = x.added + x.changed + x.unchanged;
    return `of ${plural(touched, a.diff!.by.length ? "key" : "row")} touched, ${formatCount(differ)} differ: ${counts}`;
  }
  if (rebuild) return `${formatCount(differ)} of ${plural(Math.max(a.liveRows ?? 0, a.rows ?? 0), "row")} differ: ${counts}`;
  return counts;
}

/** An ingest's diff: "212 would update, 788 would add (by key id)". */
function ingestDiff(a: PreviewAsset): string {
  const x = a.diff!;
  const parts = [`${formatCount(x.changed)} would update`, `${formatCount(x.added)} would add`];
  if (x.removed) parts.push(`${formatCount(x.removed)} would be removed`);
  if (x.unchanged) parts.push(`${formatCount(x.unchanged)} unchanged`);
  return `${parts.join(", ")} (${by(a)})`;
}

/** A table live does not have yet lists its columns ("new table: id BIGINT · title VARCHAR"); otherwise what
 *  changed ("+ comments BIGINT (new) · − old VARCHAR · ~ amount BIGINT → DOUBLE"). */
function columnsWords(a: PreviewAsset): string {
  if (a.liveRows === null && a.columns.every((c) => c.change === "added")) {
    return `new table: ${a.columns.map((c) => `${c.column} ${c.type}${c.note ? ` (${c.note})` : ""}`).join(" · ")}`;
  }
  return a.columns.map(columnWords).join(" · ");
}

function columnWords(c: PreviewAsset["columns"][number]): string {
  if (c.change === "added") return `+ ${c.column} ${c.type}${c.note ? ` (${c.note})` : ""}`;
  if (c.change === "removed") return `− ${c.column} ${c.type}`;
  return `~ ${c.column} ${c.from ?? "?"} → ${c.type}`;
}

function checkWords(c: StepResult["checks"][number], warning: boolean): string {
  if (c.ok) return `ok ${c.check}`;
  const n = c.failing !== undefined ? `: ${plural(c.failing, "row")}` : "";
  return `${warning ? "warn" : "fail"} ${c.check}${n}`;
}

// croft restore [asset] [--at <time>] (DESIGN.md §4.1, §4.2, §6 "Trash, restore and delete"). Its spec is in
// commands/index.ts; the work is safety/restore.ts.
//
// - `croft restore` lists the trash, newest first: table, when (in the project zone), rows, size and why. It only
//   reads the trash's sidecar files, never the warehouse.
// - `croft restore <asset>` brings back the asset's latest version, `--at <time>` another: the time as the list
//   shows it ("2026-09-22 11:40", in the project zone), to the second or millisecond when two versions share a
//   minute, a full ISO time with an offset, or the version's file name (20260922T184000.123Z). A time that picks
//   none or several versions is USAGE_ERROR with the choices.
// - Restoring overwrites the current table, so it is destructive and asks first, exactly as croft delete does
//   (delete.ts: y/N on a terminal, otherwise exit 5 with a token that only `croft confirm` carries out, the impact
//   counted again under the asset's lease). The stored command names the version exactly (--at), so a newer
//   version trashed meanwhile cannot change what the token restores. The current table goes to the trash first.
// - Downstream goes stale (last_replaced_at); its run record's step reason is "restored". next[] runs the readers
//   a plain run redoes; an incremental TS transform that reads the asset processes new input rows only, so the text
//   (and next's reason) names `croft run <t> --rebuild` for it, which asks first. next[] never holds it (§4.3).
// - A "rows" version whose delete did not finish (trash.ts `applied: false`) is listed as such; `croft restore
//   <asset>` without --at takes the newest version whose change happened, and one named with --at is refused while
//   the table still holds its rows (safety/restore.ts).
// - The impact carries the current table's generation, hashed into the token (safety/confirm.ts): a token minted
//   before the table was written is stale. A whole-table version croft delete trashed carries the code the
//   scheduler was allowed to run (delete.ts): restoring it puts that approval back, unless a person ran the asset
//   since.
import { CroftError } from "../../core/errors.ts";
import { formatInstant, parseInstant, zonedParts } from "../../core/time.ts";
import { type CatalogAsset, getCatalog } from "../../history/catalog.ts";
import { unfinishedRename } from "../../project/rename.ts";
import type { Project } from "../../project/root.ts";
import { didYouMean } from "../../project/suggest.ts";
import { Confirmations, type HashedImpact } from "../../safety/confirm.ts";
import { listVersions, type RestoreImpact, restoreImpact, type RestoreResult, restoreVersion } from "../../safety/restore.ts";
import { plannedTrashPath, TRASH_RETENTION, type TrashEntry, versionNote } from "../../safety/trash.ts";
import type { CommandImpl, CommandResult, Ctx } from "../command.ts";
import { shellQuote } from "../main.ts";
import { formatCount, table } from "../render.ts";
import {
  afterWrite, carryOut, closeSession, confirmationProblem, confirmationText, exactAsset, names, openSession, plural, prompter, questionText,
  rebuildCommands, rebuildReaders, refreshCatalog, shownPath,
} from "./delete.ts";

const USAGE = "croft restore [asset] [--at <time>]";

/** One version in the trash, as `croft restore --json` shows it. */
export interface TrashVersion {
  asset: string;
  /** ISO-8601 with the project offset, to the millisecond. */
  trashedAt: string;
  reason: string;
  rows: number;
  bytes: number;
  /** "table": the whole table; "rows": the rows a delete --where removed. */
  kind: "table" | "rows";
  where: string | null;
  /** false: the delete that trashed these rows did not finish (a crash between its commits, or refused), so they
   *  were most likely never deleted; also a version with no sidecar. */
  applied: boolean;
  runId: string | null;
  path: string;
}

/** `croft restore` (no asset): the trash. */
export interface TrashListData {
  versions: TrashVersion[];
  retention: { days: number; versions: number };
}

/** `croft restore <asset>`. */
export interface RestoreData {
  asset: string;
  /** restored: done. needs_confirmation: a token was issued (exit 5), nothing changed. declined: the person said
   *  no at the terminal. */
  status: "restored" | "needs_confirmation" | "declined";
  version: TrashVersion;
  /** The rows that come back (a "rows" version: those whose key is not in the table again). */
  rows: number;
  /** A "rows" version: trashed rows left out because they are in the table again (their key, or the same row). */
  skipped: number;
  /** The table's rows before (they go to the trash first); null when there is no table. */
  replacedRows: number | null;
  rowsAfter: number | null;
  downstream: string[];
  /** The incremental TS transforms among them that read it: a plain run processes new input rows only, so only
   *  `croft run <t> --rebuild` (it asks first) redoes the restored rows. */
  rebuild: string[];
  /** Where the table it replaced went. */
  trashed: { path: string; rows: number } | null;
  runId: string | null;
}

// ---------------------------------------------------------------------------------------------------------
// Times

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "2026-09-22 11:40:00.123", the version's time in the project zone, to the millisecond. */
export function localTime(iso: string, tz: string): string {
  const at = new Date(iso);
  const p = zonedParts(at, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(at.getUTCMilliseconds(), 3)}`;
}

/** ISO-8601 with the project offset, always to the millisecond. */
function zonedMs(iso: string, tz: string): string {
  const s = formatInstant(iso, tz);
  return /\.\d{3}/.test(s) ? s : s.replace(/([+-]\d{2}:\d{2}|Z)$/, ".000$1");
}

const stampOf = (v: TrashEntry) => v.path.slice(v.path.lastIndexOf("/") + 1).replace(/\.duckdb$/, "");

/** How --at matches: the prefix of localTime() it names, or the version's file name. */
function atKey(at: string, tz: string): { stamp: string } | { prefix: string } | null {
  const text = at.trim();
  if (/^\d{8}T\d{6}(\.\d+)?Z(-\d+)?$/.test(text)) return { stamp: text };
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(text);
  if (!m) return null;
  const [, date, h, mi, s, frac, off] = m;
  let prefix = date!;
  if (h !== undefined) prefix += ` ${h}:${mi}`;
  if (s !== undefined) prefix += `:${s}`;
  if (frac !== undefined) prefix += `.${frac}`;
  if (off !== undefined) {
    if (h === undefined) return null;
    let us: bigint;
    try {
      us = parseInstant(text.replace(" ", "T"));
    } catch {
      return null;
    }
    prefix = localTime(new Date(Number(us / 1000n)).toISOString(), tz).slice(0, prefix.length);
  }
  return { prefix };
}

/** A "rows" version whose delete did not finish: its rows were most likely never deleted. */
const unfinished = (v: { kind: TrashEntry["kind"]; applied?: boolean }) => v.kind === "rows" && v.applied === false;

/** The version `--at` names; without it the latest whose change happened (not an unfinished delete's rows), else the
 *  latest. USAGE_ERROR for none or several, with the choices. */
export function pickVersion(versions: readonly TrashEntry[], asset: string, at: string | undefined, tz: string): TrashEntry {
  if (versions.length === 0) throw nothingInTrash(asset, []);
  if (at === undefined) return versions.find((v) => !unfinished(v)) ?? versions[0]!;
  const key = atKey(at, tz);
  const choices = versions.slice(0, 8).map((v) => localTime(v.trashedAt, tz));
  const fix = { kind: "command" as const, description: "list the versions in the trash", command: "croft restore" };
  if (!key) {
    throw new CroftError("USAGE_ERROR", {
      asset, message: `--at ${JSON.stringify(at)} is not a time`,
      hint: `give the time as croft restore lists it, in the project zone: --at "${choices[0]!.slice(0, 16)}"`,
      fix, details: { at, versions: choices },
    });
  }
  const found = versions.filter((v) => ("stamp" in key ? stampOf(v) === key.stamp : localTime(v.trashedAt, tz).startsWith(key.prefix)));
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw new CroftError("USAGE_ERROR", {
      asset, message: `the trash holds no version of ${asset} from ${at}; it has ${versions.length === 1 ? "one, from" : "these, newest first:"} ${choices.join(", ")}`,
      hint: `give one of those times: --at "${choices[0]!.slice(0, 16)}"`,
      fix, details: { at, versions: choices },
    });
  }
  const shown = found.slice(0, 8).map((v) => localTime(v.trashedAt, tz));
  throw new CroftError("USAGE_ERROR", {
    asset, message: `${found.length} versions of ${asset} match --at ${JSON.stringify(at)}: ${shown.join(", ")}`,
    hint: `give the time to the second or millisecond: --at "${shown[0]}"`,
    fix, details: { at, versions: shown },
  });
}

function nothingInTrash(asset: string, others: readonly string[]): CroftError {
  const guess = didYouMean(asset, [...others]);
  return new CroftError("USAGE_ERROR", {
    asset,
    message: `the trash holds nothing of ${asset}`,
    hint: guess ? `did you mean ${guess}? croft restore lists the trash` : "croft restore lists the trash; versions are kept 30 days, and the 5 newest of each table",
    fix: { kind: "command", description: "list the trash", command: "croft restore" },
    details: { asset, ...(guess ? { suggestion: guess } : {}) },
  });
}

/** --at that names this version exactly: its time to the millisecond, or its file name when another version shares
 *  that millisecond. */
function pin(v: TrashEntry, all: readonly TrashEntry[], tz: string): string {
  const twin = all.some((o) => o !== v && o.trashedAt === v.trashedAt);
  return twin ? stampOf(v) : zonedMs(v.trashedAt, tz);
}

function versionJson(v: TrashEntry, tz: string): TrashVersion {
  return {
    asset: v.asset, trashedAt: zonedMs(v.trashedAt, tz), reason: v.reason, rows: v.rows, bytes: v.bytes, kind: v.kind, where: v.where,
    applied: v.applied !== false, runId: v.runId, path: v.path,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The impact

function restoreAction(i: RestoreImpact, tz: string): string {
  const when = localTime(i.version.trashedAt, tz).slice(0, 19);
  return i.kind === "rows"
    ? `put back the rows deleted from it at ${when}`
    : `restore its version of ${when} (${plural(i.rows, "row")})`;
}

function toImpact(project: Project, i: RestoreImpact, at: Date): HashedImpact {
  // What is at stake: the table the restore replaces (a whole version), or the rows it adds (a "rows" version).
  const rows = i.kind === "table" ? i.currentRows ?? 0 : i.rows;
  return {
    asset: i.asset, action: restoreAction(i, project.timezone), rows, bytes: i.version.bytes,
    ...(i.currentRows !== null ? { trashPath: plannedTrashPath(project.paths.stateDir, i.asset, at) } : {}), downstream: i.downstream,
    generation: i.generation,
  };
}

/** What the incremental TS readers of a restored asset need (rebuildReaders): a plain run skips the restored rows. */
function rebuildText(rebuild: readonly string[]): string {
  const one = rebuild.length === 1;
  return `${names(rebuild)} ${one ? "processes" : "process"} new input rows only: ${rebuildCommands(rebuild)} ${one ? "redoes" : "redo"} the restored rows (${one ? "it asks" : "they ask"} first)`;
}

function impactLines(i: { asset: string; kind: "table" | "rows"; rows: number; skipped: number; currentRows: number | null; downstream: string[] }, when: string,
  rebuild: readonly string[]): { head: string; first: string | null; then: string[] } {
  const head = i.kind === "rows"
    ? `restore ${i.asset}: put back the ${plural(i.rows, "row")} deleted from it at ${when}${i.skipped ? ` (${formatCount(i.skipped)} more are back already: they are in the table)` : ""}`
    : `restore ${i.asset} to its version of ${when}: ${plural(i.rows, "row")}`;
  const first = i.currentRows === null ? null : `the current ${plural(i.currentRows, "row")} of ${i.asset} go to the trash`;
  const stale = i.downstream.filter((d) => !rebuild.includes(d));
  const then = [...(stale.length ? [`${names(stale)} go stale: the next croft run rebuilds them`] : []), ...(rebuild.length ? [rebuildText(rebuild)] : [])];
  return { head, first, then };
}

function question(i: RestoreImpact, tz: string, rebuild: readonly string[]): string {
  const { head, first, then } = impactLines(i, localTime(i.version.trashedAt, tz).slice(0, 19), rebuild);
  return questionText(head, first, then);
}

function data(i: RestoreImpact, status: RestoreData["status"], tz: string, rebuild: string[], o: { r?: RestoreResult; runId?: string } = {}): RestoreData {
  return {
    asset: i.asset, status, version: versionJson(i.version, tz), rows: o.r?.rows ?? i.rows, skipped: o.r?.skipped ?? i.skipped,
    replacedRows: i.currentRows, rowsAfter: o.r?.rowsAfter ?? null, downstream: i.downstream, rebuild,
    trashed: o.r?.trashed ? { path: o.r.trashed.path, rows: o.r.trashed.rows } : null, runId: o.runId ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The command

function list(ctx: Ctx): CommandResult<TrashListData> {
  const project = ctx.project;
  const versions = listVersions(project.paths.stateDir).map((v) => versionJson(v, project.timezone));
  return { data: { versions, retention: { days: TRASH_RETENTION.days, versions: TRASH_RETENTION.versions } }, problems: [], next: [] };
}

async function restoreOne(ctx: Ctx, asset: string, at: string | undefined): Promise<CommandResult<RestoreData>> {
  const project = ctx.project;
  const tz = project.timezone;
  const all = listVersions(project.paths.stateDir);
  const mine = all.filter((v) => v.asset === asset);
  if (mine.length === 0) throw nothingInTrash(asset, [...new Set(all.map((v) => v.asset))]);
  const version = pickVersion(mine, asset, at, tz);
  const command = ["croft", "restore", asset, "--at", pin(version, mine, tz)].map(shellQuote).join(" ");
  const s = await openSession(ctx, `croft restore ${asset}`);
  let wrote = false;
  try {
    const problems = [...s.problems];
    let shown: HashedImpact | null = null;
    let rebuild: string[] | null = null;
    const rebuildOf = async (downstream: readonly string[]) => (rebuild ??= await rebuildReaders(project, asset, downstream));
    if (s.token === undefined) {
      const i = await restoreImpact(s.warehouse, version);
      const impact = toImpact(project, i, ctx.now());
      const readers = await rebuildOf(i.downstream);
      if (!s.ask) {
        const c = new Confirmations(s.runs).create({ command, impact });
        const { head, first } = impactLines(i, localTime(version.trashedAt, tz).slice(0, 19), readers);
        problems.push(confirmationProblem(c, head, first));
        return { data: data(i, "needs_confirmation", tz, readers), problems, next: [], confirmation: c };
      }
      if (!(await prompter.ask(question(i, tz, readers)))) return { data: data(i, "declined", tz, readers), problems, next: [], ok: false, exit: 1 };
      shown = impact;
    }
    // The entry of a deleted asset is kept with its trashed version (delete.ts).
    const prev = getCatalog(s.runs, asset) ?? (versionNote(version.path, "catalog") as CatalogAsset | undefined) ?? null;
    let impact: RestoreImpact | null = null;
    const { value: r, runId } = await carryOut<RestoreResult>(ctx, s, {
      asset, command, action: "restore", shown,
      argv: ["restore", ...ctx.argv.filter((a) => a !== "--json")],
      impact: async () => toImpact(project, impact = await restoreImpact(s.warehouse, version), ctx.now()),
      act: (id) => restoreVersion(s.warehouse, version, {
        runId: id, now: ctx.now(), ...(ctx.processEnv.CROFT_FAULT ? { fault: ctx.processEnv.CROFT_FAULT } : {}),
      }),
      record: (x) => ({
        reason: "restored",
        behavior: x.kind === "rows" ? `restore: the rows deleted at ${localTime(version.trashedAt, tz).slice(0, 19)} went back` : `restore: the version of ${localTime(version.trashedAt, tz).slice(0, 19)}`,
        rows: {
          in: 0, added: x.rows, updated: 0, unchanged: x.kind === "rows" ? x.rowsAfter - x.rows : 0,
          deleted: x.kind === "table" ? x.trashed?.rows ?? 0 : 0, total: x.rowsAfter,
        },
        trashed: x.trashed ? { path: x.trashed.path, rows: x.trashed.rows } : null,
        lines: [
          `${ctx.now().toISOString()} ${command}`,
          x.kind === "rows"
            ? `put back ${plural(x.rows, "row")} of ${asset}${x.skipped ? ` (${formatCount(x.skipped)} skipped: already in the table)` : ""}; ${plural(x.rowsAfter, "row")} now`
            : `restored ${asset} to its version of ${zonedMs(version.trashedAt, tz)}: ${plural(x.rows, "row")}`,
          `from: ${version.path}`,
          ...(x.trashed ? [`the table it replaced (${plural(x.trashed.rows, "row")}) went to the trash: ${x.trashed.path}`] : []),
          ...(x.downstream.length ? [`stale now: ${names(x.downstream)}`] : []),
        ],
      }),
    });
    wrote = true;
    await refreshCatalog(s, asset, runId, prev);
    // A version croft delete trashed carries the code the scheduler was allowed to run: the table is back, so the
    // scheduler may go on from where it was, unless a person has run the asset since (their approval stands).
    const approved = r.kind === "table" ? versionNote(version.path, "approvedCodeHash") : undefined;
    if (typeof approved === "string" && s.runs.approvedCode(asset) === null) {
      try {
        s.runs.approveCode(asset, approved);
      } catch {
        // The asset stays held: a run by hand releases it.
      }
    }
    problems.push(...r.problems);
    // A plain run redoes the SQL and full-refresh readers; an incremental TS reader skips the restored rows (--rebuild,
    // which asks first, is named in the reason, never as a command of its own).
    const readers = await rebuildOf(r.downstream);
    const runs = r.downstream.filter((d) => !readers.includes(d));
    const also = readers.length ? rebuildText(readers) : null;
    const next = runs.length
      ? [{ command: `croft run ${runs.join(" ")}`, reason: `they read ${asset}, which was restored${also ? `; ${also}` : ""}` }]
      : also ? [{ command: "croft status", reason: also }] : [];
    return { data: data(impact!, "restored", tz, readers, { r, runId }), problems, next };
  } finally {
    await closeSession(s);
    if (wrote) await afterWrite(project);
  }
}

export const restore: CommandImpl<TrashListData | RestoreData> = {
  async run(ctx): Promise<CommandResult<TrashListData | RestoreData>> {
    const at = typeof ctx.values.at === "string" ? ctx.values.at : undefined;
    if (ctx.positionals.length === 0) {
      if (at !== undefined) {
        throw new CroftError("USAGE_ERROR", {
          message: "--at picks a version of one asset; name the asset too", hint: `usage: ${USAGE}`,
          fix: { kind: "command", description: "list the trash", command: "croft restore" },
        });
      }
      return list(ctx);
    }
    const asset = exactAsset("restore", ctx.positionals[0], USAGE);
    // A croft rename that did not finish names it: the rename finishes first (project/rename.ts, R41-05).
    const renaming = unfinishedRename(ctx.project.paths.stateDir, asset);
    if (renaming) throw renaming;
    return restoreOne(ctx, asset, at);
  },
  human(result, ctx) {
    const d = result.data;
    const project = ctx.project;
    const tz = project.timezone;
    if ("versions" in d) {
      if (d.versions.length === 0) return `the trash is empty (it keeps versions ${d.retention.days} days, and the ${d.retention.versions} newest of each table)`;
      const rows = d.versions.map((v) => [v.asset, listedTime(v, d.versions, tz), formatCount(v.rows), formatBytes(v.bytes),
        unfinished(v) ? `${v.reason}, not applied: the delete did not finish` : v.reason]);
      return [
        table(["TABLE", "TRASHED", "ROWS", "SIZE", "WHY"], rows, { limit: Number.POSITIVE_INFINITY, maxWidth: 100 }).text,
        `(kept ${d.retention.days} days, and the ${d.retention.versions} newest of each table; croft restore <table> [--at <time>] brings one back, after confirmation)`,
      ].join("\n");
    }
    const when = localTime(d.version.trashedAt, tz).slice(0, 19);
    const i = { asset: d.asset, kind: d.version.kind, rows: d.rows, skipped: d.skipped, currentRows: d.replacedRows, downstream: d.downstream };
    const { head, first, then } = impactLines(i, when, d.rebuild);
    switch (d.status) {
      case "needs_confirmation":
        return confirmationText(result.confirmation, head, first, then);
      case "declined":
        return `not restored: ${head} was not confirmed; nothing was changed`;
      case "restored": {
        const what = d.version.kind === "rows"
          ? `put back ${plural(d.rows, "row")} deleted at ${when}${d.skipped ? ` (${formatCount(d.skipped)} skipped: already in the table)` : ""}; ${plural(d.rowsAfter ?? 0, "row")} now`
          : `restored the version of ${when}: ${plural(d.rows, "row")}`;
        const lines = [`ok    ${d.asset}   ${what}`];
        if (d.trashed) lines.push(`      the table it replaced (${plural(d.trashed.rows, "row")}) is in the trash: ${shownPath(project, d.trashed.path)}`);
        for (const line of then) lines.push(`      ${line}`);
        return lines.join("\n");
      }
    }
  },
};

/** The TRASHED column: to the minute, or finer when the same table has two versions in that minute. */
function listedTime(v: TrashVersion, all: readonly TrashVersion[], tz: string): string {
  const full = localTime(v.trashedAt, tz);
  const same = all.filter((o) => o.asset === v.asset && o !== v).map((o) => localTime(o.trashedAt, tz));
  for (const n of [16, 19, 23]) if (!same.some((o) => o.slice(0, n) === full.slice(0, n))) return full.slice(0, n);
  return `${full} (${v.path.slice(v.path.lastIndexOf("/") + 1).replace(/\.duckdb$/, "")})`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}


// croft backup [<dir>] (DESIGN.md §4.1, §6 "Backups of the project's data", D109, D151): a consistent copy of what cannot be
// fetched again, the warehouse with runs.sqlite and the trash, in a new folder <project>-<stamp>/ inside <dir>
// (default .croft/backups/). It takes the file as every croft writer does (write intent, then the lock), so croft
// serve steps aside and a run's next step waits, for as long as a checkpoint and a clone take; the work is
// db/backup.ts backupProject. Of a lake (D151) the warehouse is a dump of the catalog and a mirror of the bucket folder,
// taken under croft's lock on the lake's writes for the dump only (db/lake-backup.ts). Nothing is overwritten and nothing
// needs confirmation: it changes no data. Putting a backup back is manual (`croft docs backup`), since `croft restore`
// is the trash's. Spec in commands/index.ts.
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { LockHolder } from "../../core/types.ts";
import { backupProject, type ProjectBackup } from "../../db/backup.ts";
import { RUNS_DB_FILE, RunsDb } from "../../history/runs-db.ts";
import type { CommandImpl } from "../command.ts";
import { formatCount, formatDuration } from "../render.ts";
import { formatBytes } from "./doctor.ts";
import { holderFromRuns, holderText } from "./describe.ts";

export type BackupData = ProjectBackup;

export const backup: CommandImpl<BackupData> = {
  async run(ctx) {
    const project = ctx.project;
    const stateDir = project.paths.stateDir;
    const dir = ctx.positionals[0];
    // A writer that sees registered waiters yields between its steps (§5 "Fairness"); runs.sqlite is not created here.
    const waiting: { runs: RunsDb | null } = { runs: null };
    try {
      const options = {
        ...(dir !== undefined ? { dir: resolve(ctx.cwd, dir) } : {}),
        now: () => ctx.now(), isTTY: ctx.isTTY.stdin && ctx.isTTY.stdout,
        lookupHolder: (pid: number) => holderFromRuns(stateDir, pid),
        onWait: (h: LockHolder, ms: number) => {
          try {
            if (!waiting.runs && existsSync(join(stateDir, RUNS_DB_FILE))) (waiting.runs = RunsDb.open(stateDir)).registerWaiter("backup");
          } catch { /* fairness only */ }
          ctx.render.progress(`waiting for the warehouse: ${holderText(h)} holds it (${Math.round(ms / 1000)} s so far)`);
        },
      };
      // A lake is a catalog and a bucket folder, not one file to clone: a dump of the one and a mirror of the other (D151).
      const data = project.config.lake
        ? await (await import("../../db/lake-backup.ts")).backupLake(project, ctx.env, { ...options, processEnv: ctx.processEnv })
        : await backupProject(project, options);
      return { data, problems: [], next: [{ command: "croft docs backup", reason: "how to put a backup back, and what it holds" }] };
    } finally {
      try {
        waiting.runs?.unregisterWaiter();
      } catch { /* the next reconcile tidies it */ }
      waiting.runs?.close();
    }
  },

  human(result, ctx) {
    return formatBackup(result.data, ctx.project.root, ctx.cwd);
  },
};

/** A lake's backup in words: the catalog's dump, the mirror of the folder (and what came from the last backup), run history and the trash. */
function formatLakeBackup(d: BackupData, l: NonNullable<BackupData["lake"]>, root: string, cwd: string): string {
  const shown = (p: string) => (p === root || p.startsWith(root + sep) ? relative(cwd, p) || "." : p);
  const rows: [string, string, string][] = [
    [l.catalog.file, formatBytes(l.catalog.bytes), `the lake's catalog as of snapshot ${l.snapshot} (${l.catalog.tool})`],
    [`${l.data.dir}/`, formatBytes(l.data.bytes), `${formatCount(l.data.files)} file${l.data.files === 1 ? "" : "s"} of the lake's folder${l.data.reused ? `, ${formatCount(l.data.reused)} linked from the last backup` : ""}`],
  ];
  if (d.runs) rows.push([d.runs.file, formatBytes(d.runs.bytes), "run history, schedules, the catalog mirror"]);
  rows.push(d.trash ? [`${d.trash.dir}/`, formatBytes(d.trash.bytes), `${formatCount(d.trash.versions)} version${d.trash.versions === 1 ? "" : "s"}`] : ["trash/", "-", "empty"]);
  const w = [0, 1].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  const lines = [`Backed up ${l.source} to ${shown(d.path)} (${formatBytes(d.bytes)})`];
  for (const r of rows) lines.push(`  ${r[0].padEnd(w[0]!)}  ${r[1].padStart(w[1]!)}  ${r[2]}`);
  lines.push(`Writes to the lake waited ${formatDuration(d.heldMs)} for the catalog; the folder was copied with runs going on.`);
  if (d.sameDisk) lines.push("This copy is on the project's disk, which also holds the trash and the run history: it does not survive that disk. croft backup <folder> puts one on another.");
  return lines.join("\n");
}

/** The human output: where it went and how big, what it holds, and what it does not protect against. */
export function formatBackup(d: BackupData, root: string, cwd: string): string {
  if (d.lake) return formatLakeBackup(d, d.lake, root, cwd);
  const shown = (p: string) => (p === root || p.startsWith(root + sep) ? relative(cwd, p) || "." : p);
  const how = d.warehouse.method === "copy" ? "copied"
    : "cloned: it shares the disk's blocks with the warehouse until either changes";
  const rows: [string, string, string][] = [[d.warehouse.file, formatBytes(d.warehouse.bytes), `as of ${d.createdAt.slice(0, 19).replace("T", " ")} (${how})`]];
  if (d.runs) rows.push([d.runs.file, formatBytes(d.runs.bytes), "run history, schedules, the catalog"]);
  rows.push(d.trash
    ? [`${d.trash.dir}/`, formatBytes(d.trash.bytes), `${formatCount(d.trash.versions)} version${d.trash.versions === 1 ? "" : "s"}`]
    : ["trash/", "-", "empty"]);
  const w = [0, 1].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  const lines = [`Backed up to ${shown(d.path)} (${formatBytes(d.bytes)})`];
  for (const r of rows) lines.push(`  ${r[0].padEnd(w[0]!)}  ${r[1].padStart(w[1]!)}  ${r[2]}`);
  lines.push(`The warehouse was held ${formatDuration(d.heldMs)}; croft serve and runs carried on after that.`);
  if (d.sameDisk) {
    lines.push("This copy is on the warehouse's disk: it undoes a mistake, not a lost disk. croft backup <folder> puts one on another disk.");
  }
  return lines.join("\n");
}

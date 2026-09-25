// croft rename <old> <new> (DESIGN.md §4.1, §6 "Nothing implicit destroys ingested data"): rename an asset, its
// file, table and state together, and list the references to update. It needs no confirmation (§6: a rename is
// reversible). The work is project/rename.ts: planRename refuses what cannot happen (a bad or taken name, an
// unknown asset, another rename not finished), applyRename takes the leases and the write lock and moves
// everything in a crash-safe order; the same command again finishes a rename that stopped. croft never edits user
// code: the references come back in data.references and as file:line lines. Spec in commands/index.ts.
import { CroftError } from "../../core/errors.ts";
import type { LockHolder } from "../../core/types.ts";
import { applyRename, planRename, type RenameReference, type RenameResult } from "../../project/rename.ts";
import type { CommandImpl, Next } from "../command.ts";
import { formatCount } from "../render.ts";

export type RenameData = Omit<RenameResult, "problems">;

function holderWords(h: LockHolder): string {
  const who = h.runId ? `run ${h.runId}${h.asset ? ` (${h.asset})` : ""}` : h.program ?? "another program";
  return h.pid !== null ? `${who}, pid ${h.pid}` : who;
}

/** What to do next: fix the references it listed, then validate (§9 recipe: rename; fix every reference it lists;
 *  validate; preview; run). */
export function renameNext(d: Pick<RenameResult, "from" | "references">): Next[] {
  const n = d.references.length;
  return [{
    command: "croft validate",
    reason: n > 0 ? `after updating the ${n} reference${n === 1 ? "" : "s"} to ${d.from} listed above, check the project` : "check the project",
  }];
}

export const rename: CommandImpl<RenameData> = {
  async run(ctx) {
    const [from, to] = ctx.positionals;
    if (!from || !to) {
      throw new CroftError("USAGE_ERROR", {
        message: "croft rename needs the asset's name and its new name",
        hint: "usage: croft rename <old> <new>, e.g. croft rename github_issues gh_issues (croft status lists the assets)",
        fix: { kind: "command", description: "list the assets", command: "croft status" },
      });
    }
    const project = ctx.project;
    const plan = await planRename(project.root, from, to, { project });
    const fault = ctx.processEnv.CROFT_FAULT;
    const result = await applyRename(project.root, plan, {
      project, now: () => ctx.now(), interactive: ctx.isTTY.stdin && ctx.isTTY.stdout,
      ...(fault ? { fault } : {}),
      onWait: (h) => ctx.render.progress(`waiting for the warehouse: ${holderWords(h)} holds it`),
    });
    const { problems, ...data } = result;
    return { data, problems, next: renameNext(result) };
  },

  human(result) {
    return formatRename(result.data);
  },
};

/** The human output: what moved, then every reference to update, as file:line. */
export function formatRename(d: RenameData): string {
  const lines = [`${d.mode === "resume" ? "Finished renaming" : "Renamed"} ${d.from} to ${d.to}.`];
  const row = (label: string, text: string) => lines.push(`  ${label.padEnd(8)} ${text}`);
  if (d.mode === "adopt") row("file", `${d.file.to} (already renamed outside croft)`);
  else if (d.file.moved) row("file", `${d.file.from} → ${d.file.to}`);
  else row("file", d.file.to);
  if (d.table.rows !== null) {
    row("table", `${d.from} → ${d.to} (${formatCount(d.table.rows)} row${d.table.rows === 1 ? "" : "s"}), with its cursor, history and scheduler approval`);
  } else {
    row("table", `none yet: ${d.to} has never been built`);
  }
  if (d.trash.versions > 0) row("trash", `${d.trash.versions} version${d.trash.versions === 1 ? "" : "s"} moved`);
  if (d.trash.left.length > 0) row("trash", `${d.trash.left.length} version${d.trash.left.length === 1 ? "" : "s"} could not be renamed and stay under ${d.from}: ${d.trash.left.join(", ")}`);
  const e = d.trash.earlier;
  if (e) {
    const n = e.versions + e.left.length;
    row("trash", `${n} version${n === 1 ? "" : "s"} of an earlier ${d.to} (deleted before) kept apart as ${e.name}: croft restore ${d.to} never offers ${n === 1 ? "it" : "them"}; croft restore ${e.name} can`);
    if (e.left.length > 0) row("trash", `${e.left.length} of them could not be renamed inside and cannot be restored as ${e.name}: ${e.left.join(", ")}`);
  }
  if (d.preview === "cleared") row("preview", `cleared (it used ${d.from}); croft preview ${d.to} builds it again`);
  if (d.preview === "kept") row("preview", `not cleared (the preview database was busy); the last preview still shows ${d.from} until croft preview ${d.to}`);
  lines.push("");
  if (d.references.length === 0) {
    lines.push(`No code names ${d.from}.`);
  } else {
    const n = d.references.length;
    lines.push(`${n} reference${n === 1 ? "" : "s"} to ${d.from} to update (croft does not edit your code):`);
    lines.push(...referenceLines(d.references));
  }
  return lines.join("\n");
}

function referenceLines(refs: readonly RenameReference[]): string[] {
  const at = refs.map((r) => `${r.file}:${r.line}`);
  const width = Math.min(48, Math.max(...at.map((s) => s.length)));
  return refs.map((r, i) => `  ${at[i]!.padEnd(width)}  ${r.text}`);
}

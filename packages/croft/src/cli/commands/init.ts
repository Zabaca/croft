// croft init [dir] [--claude] [--no-install] (DESIGN.md §2, §4.1, §9). Its spec (usage, options) is in
// commands/index.ts.
import { createInterface } from "node:readline/promises";
import { relative, resolve } from "node:path";
import { problem } from "../../core/errors.ts";
import type { Problem } from "../../core/types.ts";
import { initProject, type InitResult } from "../../project/init.ts";
import { findRoot } from "../../project/root.ts";
import type { CommandImpl, Ctx, Next } from "../command.ts";
import { formatDuration } from "../render.ts";

export type InitData = InitResult;

/** Quote a path for a copy-pasteable command (main.ts has the same rule; importing it would be circular). */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Where the user was when they typed the command. The launcher runs a project's pinned croft from the
 *  project root and passes the original folder in CROFT_CALLER_CWD, so `croft init ../x` still means
 *  what the user meant. */
export function callerCwd(ctx: Pick<Ctx, "cwd" | "processEnv">): string {
  return ctx.processEnv.CROFT_CALLER_CWD || ctx.cwd;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^\s*y(es)?\s*$/i.test(await rl.question(question));
  } finally {
    rl.close();
  }
}

export const init: CommandImpl<InitData> = {
  async run(ctx) {
    const from = callerCwd(ctx);
    const dir = ctx.positionals[0];
    // Without a folder, `croft init` inside a project means that project (--claude refreshes it; plain
    // init says it already exists) rather than a new project nested in whatever subfolder the user is in.
    const target = dir !== undefined ? resolve(from, dir) : findRoot(from) ?? from;
    const interactive = ctx.isTTY.stdin && ctx.isTTY.stdout && !ctx.json;
    const result = await initProject({
      target,
      ...(dir !== undefined ? { displayTarget: shellQuote(dir) } : {}),
      claudeOnly: ctx.values.claude === true,
      install: ctx.values["no-install"] !== true,
      env: ctx.processEnv,
      onProgress: (line) => ctx.render.progress(line),
      ...(interactive ? {
        confirmEdit: async (edit: { file: string; diff: string }) => {
          ctx.render.out(`To keep your app's type-check away from data/ (it needs Bun's types), croft would change ${edit.file}:\n${indent(edit.diff)}`);
          return askYesNo(`Apply this change to ${edit.file}? [y/N] `);
        },
      } : {}),
      // HOOK(example): pass `runExample` here once `croft run` exists (see ExampleRunner in project/init.ts).
    });
    return { data: result, problems: initProblems(result, from), next: nextSteps(result, from) };
  },
  human(result, ctx) {
    return describe(result.data, callerCwd(ctx));
  },
};

/** INSTALL_FAILED when bun install ran and failed: the project exists, but nothing can run in it yet. */
export function initProblems(r: InitResult, from: string): Problem[] {
  if (!r.install.ran || r.install.ok) return [];
  const cd = cdPrefix(r.root, from);
  const lastLine = (r.install.output ?? "").trim().split("\n").at(-1) ?? "";
  const where = relative(from, r.root) || ".";
  return [problem("INSTALL_FAILED", {
    message: `bun install failed in ${where.startsWith("..") ? r.root : where}${lastLine ? ` (${lastLine})` : ""}; the project is created, but croft cannot run in it until the install succeeds`,
    hint: `fix what bun install reports (a network or registry problem, usually), then run ${cd}bun install`,
    fix: { kind: "command", description: "install the project's dependencies", command: `${cd}bun install` },
    details: { root: r.root, command: r.install.command, ms: r.install.ms, output: r.install.output ?? "" },
  })];
}

/** `cd <dir> && ` when the project is not the current folder. */
function cdPrefix(root: string, from: string): string {
  const rel = relative(from, root);
  return rel === "" ? "" : `cd ${shellQuote(rel.startsWith("..") ? root : rel)} && `;
}

export function nextSteps(r: InitResult, from: string): Next[] {
  const cd = cdPrefix(r.root, from);
  if (r.mode === "claude") return [];
  const next: Next[] = [];
  if (!r.install.ran || !r.install.ok) next.push({ command: `${cd}bun install`, reason: "install croft and its DuckDB binding into the project" });
  if (r.example.ran && r.example.ok) {
    next.push({ command: `${cd}croft query "from example_sales limit 5"`, reason: "look at the example table" });
  } else {
    next.push({ command: `${cd}croft run example_sales`, reason: "load the example table from files/example_sales.csv (no network needed)" });
  }
  return next;
}

function indent(text: string, by = "  "): string {
  return text.split("\n").map((l) => by + l).join("\n");
}

const ACTION_WORDS: Record<string, string> = {
  created: "created", appended: "added the croft block", replaced: "updated", merged: "merged", unchanged: "unchanged",
  skipped: "kept as it was",
};

export function describe(r: InitResult, from: string): string {
  const lines: string[] = [];
  const where = (p: string) => {
    const rel = relative(from, p);
    return rel === "" ? "this folder" : rel.startsWith("..") ? p : `${rel}/`;
  };
  if (r.mode === "claude") {
    const changed = r.files.filter((f) => f.action !== "unchanged");
    lines.push(changed.length
      ? `Refreshed the Claude files for croft ${r.version}:`
      : `The Claude files already match croft ${r.version}:`);
    for (const f of r.files) lines.push(`  ${f.path}  ${ACTION_WORDS[f.action]}`);
    return lines.join("\n");
  }

  if (r.mode === "app") {
    lines.push(`Created ${where(r.root)} next to your app (croft ${r.version}, timezone ${r.timezone}); no app file was overwritten.`);
  } else {
    lines.push(`Created ${where(r.root)} (croft ${r.version}, timezone ${r.timezone})`);
  }
  // New files inside the project need no comment; anything else init touched or kept (and, in an app,
  // every file outside data/) is listed.
  const kept = r.files.filter((f) => f.action !== "created" || (r.mode === "app" && !f.path.startsWith("data/")));
  for (const f of kept) lines.push(`  ${f.path}: ${ACTION_WORDS[f.action]}${f.note ? ` (${f.note})` : ""}`);
  if (r.relocation) {
    lines.push(`This folder is in ${r.relocation.reason}; file sync can corrupt a database mid-write, so the database and`,
      `.croft/ live in ${r.relocation.dir} instead (recorded in croft.json). Your asset files stay here.`);
  }
  if (r.tsconfig) {
    const t = r.tsconfig;
    if (t.status === "applied") lines.push(`${t.file}: added "data" to "exclude", so your app's type-check skips the pipelines.`);
    else if (t.status === "manual") lines.push(`${t.file}: ${t.reason}.`);
    else {
      lines.push(`${t.file} was not changed. So that your app's type-check (next build, tsc) skips data/, make this edit${t.status === "declined" ? " when you are ready" : ""}:`);
      if (t.diff) lines.push(indent(t.diff));
    }
  }
  if (r.appSteps.length) {
    lines.push("In your app:");
    for (const s of r.appSteps) lines.push(`  ${s}`);
  }
  if (r.install.ran) {
    lines.push(r.install.ok
      ? `Installed dependencies (${r.install.command}, ${formatDuration(r.install.ms)})`
      : `${r.install.command} failed after ${formatDuration(r.install.ms)}; the project is created but cannot run yet:\n${indent(r.install.output ?? "", "    ")}`);
  }
  if (r.example.ran) {
    lines.push(r.example.ok
      ? `Ran ${r.example.asset}: ${r.example.rows.toLocaleString("en-US")} rows · checks ${r.example.checks}`
      : `${r.example.asset} did not run cleanly; see croft logs ${r.example.asset} --failed`);
  }
  const claudeFiles = r.mode === "app" ? "CLAUDE.md (here and in data/) and the croft skill" : "CLAUDE.md and .claude/skills/croft/SKILL.md";
  lines.push(`Claude Code: ${claudeFiles} are ready. croft docs claude-permissions suggests permission rules.`);
  return lines.join("\n");
}

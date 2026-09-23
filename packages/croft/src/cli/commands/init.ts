// croft init [dir] [--claude] [--no-install] (DESIGN.md §2, §4.1, §9).
import { createInterface } from "node:readline/promises";
import { relative, resolve } from "node:path";
import { initProject, type InitResult } from "../../project/init.ts";
import { findRoot } from "../../project/root.ts";
import type { Command, Ctx, Next } from "../command.ts";
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

export const init: Command<InitData> = {
  name: "init",
  summary: "create a croft project (or data/ inside an existing app); --claude refreshes the Claude files",
  usage: "croft init [dir] [--claude] [--no-install]",
  options: {
    claude: { type: "boolean", description: "only refresh CLAUDE.md's croft block and .claude/skills/croft/SKILL.md" },
    "no-install": { type: "boolean", description: "do not run bun install (the project needs it before its first run)" },
  },
  maxPositionals: 1,
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
      onProgress: (line) => ctx.render.progress(line),
      ...(interactive ? {
        confirmEdit: async (edit: { file: string; diff: string }) => {
          ctx.render.out(`To keep your app's type-check away from data/ (it needs Bun's types), croft would change ${edit.file}:\n${indent(edit.diff)}`);
          return askYesNo(`Apply this change to ${edit.file}? [y/N] `);
        },
      } : {}),
      // HOOK(example): pass `runExample` here once `croft run` exists (see ExampleRunner in project/init.ts).
    });
    return { data: result, problems: [], next: nextSteps(result, from), ...(installFailed(result) ? { exit: 1, ok: false } : {}) };
  },
  human(result, ctx) {
    return describe(result.data, callerCwd(ctx));
  },
};

function installFailed(r: InitResult): boolean {
  return r.install.ran && !r.install.ok;
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

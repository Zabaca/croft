// The opt-in Claude Code hook (DESIGN.md §9 item 7, D27). `croft init --with-hook` (or `croft init --claude
// --with-hook` in an existing project) merges a PostToolUse hook into .claude/settings.json, and Claude Code then
// runs `croft validate --hook` after every Edit, Write or MultiEdit, with the tool call's JSON on stdin.
//
// What Claude Code does with it [V: code.claude.com/docs/en/hooks, 2026-09-24]:
// - a command hook runs through `sh -c` (shell form) in Claude's current folder, which follows its `cd`, with
//   CLAUDE_PROJECT_DIR set to the folder the session started in, which is also the folder whose
//   .claude/settings.json it read;
// - the input is JSON on stdin: hook_event_name, tool_name, cwd, tool_input (file_path, always absolute, for the
//   file tools) and tool_response;
// - PostToolUse and exit 2: "Shows stderr to Claude; the tool already ran". Exit 0: stdout and stderr go to the
//   debug log only. Any other exit: a "hook error" notice for the user with the first line of stderr, and
//   Claude carries on;
// - a command that cannot start (a missing file: sh exits 127) is such a non-blocking error;
// - the same handler defined in several settings files runs once; a command hook times out after 600 s unless
//   `timeout` (seconds) says otherwise.
//
// The command runs the project's pinned croft (node_modules/.bin/croft, the copy `bun install` put there) from
// the project folder: no network, no global croft, and the version the project runs. For a project in data/
// inside an app, the app's settings `cd` into data/ first. bunx is not used: when the package is not installed
// locally it fetches one from the registry, and the npm name `croft` is not croft.
//
// This file holds the pure parts: the settings entry and its merge (init), the hook input and which file it
// names, which assets an edit affects, and the text Claude reads. validate.ts validateHook runs the check.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import type { FileChange } from "../project/init.ts";

export const HOOK_EVENT = "PostToolUse";
/** Claude Code's file-editing tools. MultiEdit is gone from current Claude Code's tool list and kept for the
 *  versions that still have it; a name that matches no tool matches nothing. */
export const HOOK_MATCHER = "Edit|Write|MultiEdit";
/** Seconds before Claude Code cancels the check (its default is 600). A TS asset's import has 30 s. */
export const HOOK_TIMEOUT_S = 120;
export const SETTINGS_FILE = ".claude/settings.json";
/** The folders whose edits the hook checks: asset files, and the shared code TS assets import. */
export const HOOK_DIRS = ["assets", "lib"] as const;

export interface HookHandler { type: "command"; command: string; timeout: number }
export interface HookGroup { matcher: string; hooks: HookHandler[] }

/** How validate --hook reads stdin; tests replace it. */
export const HOOK_IO = {
  /** All of stdin, as text. */
  readStdin: async (): Promise<string> => await Bun.stdin.text(),
};

/** Quote a path segment for sh (main.ts has the same rule; importing it here would load the CLI). */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook's shell command: the project's pinned croft, run from the project folder. `sub` is the project's
 * folder relative to where Claude Code starts (CLAUDE_PROJECT_DIR): "" for the project itself, "data" for a
 * project inside an app.
 */
export function hookCommand(sub = ""): string {
  const dir = sub ? `"$CLAUDE_PROJECT_DIR"/${sub.split("/").map(shellQuote).join("/")}` : `"$CLAUDE_PROJECT_DIR"`;
  return `cd ${dir} && ./node_modules/.bin/croft validate --hook`;
}

/** The hook entry merged into .claude/settings.json. */
export function hookSettings(sub = ""): { hooks: { PostToolUse: HookGroup[] } } {
  return { hooks: { [HOOK_EVENT]: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: hookCommand(sub), timeout: HOOK_TIMEOUT_S }] }] } } as { hooks: { PostToolUse: HookGroup[] } };
}

// ---------------------------------------------------------------------------------------------------------
// Merging into .claude/settings.json

export type MergeResult =
  | { ok: true; text: string; action: "created" | "merged" | "unchanged"; note: string }
  | { ok: false; reason: string };

const ADDED = "PostToolUse hook: croft validate --hook";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The croft validate --hook handler already in these settings, if any (written by croft or by hand). */
function existingHandler(groups: readonly unknown[]): string | null {
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (isObject(h) && typeof h.command === "string" && /\bcroft(\.mjs)?["']?\s+validate\b[^\n]*--hook\b/.test(h.command)) return h.command;
    }
  }
  return null;
}

/**
 * Merge the hook into the text of a settings file (null: there is none). Everything already there stays, in its
 * order; the hook is appended to hooks.PostToolUse as a group of its own, in the file's indentation. A file
 * that already runs croft validate --hook (this command or another way of writing it) is left as it is, so a
 * second run never doubles the hook. Refused, with the reason, when the file is not a JSON object whose hooks
 * croft can extend: croft never rewrites what it cannot read.
 */
export function mergeHookSettings(existing: string | null, sub = ""): MergeResult {
  const entry = hookSettings(sub);
  if (existing === null) return { ok: true, action: "created", text: `${JSON.stringify(entry, null, 2)}\n`, note: ADDED };
  const source = existing.replace(/^﻿/, "");
  let settings: unknown = {};
  if (source.trim()) {
    try {
      settings = JSON.parse(source);
    } catch (e) {
      return { ok: false, reason: `it is not valid JSON (${(e as Error).message})` };
    }
  }
  if (!isObject(settings)) return { ok: false, reason: "it is not a JSON object" };
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return { ok: false, reason: `"hooks" is not an object` };
  const hooks = (settings.hooks ?? {}) as Json;
  const groups = hooks[HOOK_EVENT];
  if (groups !== undefined && !Array.isArray(groups)) return { ok: false, reason: `"hooks.${HOOK_EVENT}" is not a list` };
  const found = existingHandler(groups ?? []);
  if (found !== null) {
    const note = found === hookCommand(sub) ? "already runs croft validate --hook" : `already runs croft validate --hook (as ${JSON.stringify(found)}); left as it was`;
    return { ok: true, action: "unchanged", text: existing, note };
  }
  const merged: Json = { ...settings, hooks: { ...hooks, [HOOK_EVENT]: [...(groups ?? []), ...entry.hooks.PostToolUse] } };
  return { ok: true, action: "merged", text: `${JSON.stringify(merged, null, indentOf(source))}\n`, note: ADDED };
}

/** The indentation a JSON file uses: its first indented line's, else two spaces. */
function indentOf(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1]! : "  ";
}

// ---------------------------------------------------------------------------------------------------------
// Installing it (croft init --with-hook)

export interface HookPlace { dir: string; sub: string }

/** The folders Claude Code may start in for this project, each with the project's folder relative to it: the
 *  project, and the app folder around a project in data/ (as the skill is written to both, templates.ts). */
export function hookPlaces(root: string, base: string): HookPlace[] {
  const places: HookPlace[] = [{ dir: root, sub: "" }];
  if (base !== root) places.push({ dir: base, sub: relative(base, root).split(sep).join("/") });
  return places;
}

/**
 * Merge the hook into .claude/settings.json of each place (hookPlaces). Each file is a FileChange, with paths
 * relative to `base` as InitResult.files are. A file croft cannot merge into is left untouched: a skipped file
 * and a USAGE_ERROR whose fix is the snippet to add by hand.
 */
export function installHook(root: string, base: string): { files: FileChange[]; problems: Problem[] } {
  const files: FileChange[] = [];
  const problems: Problem[] = [];
  for (const place of hookPlaces(root, base)) {
    const abs = join(place.dir, ...SETTINGS_FILE.split("/"));
    const path = relative(base, abs).split(sep).join("/");
    const r = mergeHookSettings(existsSync(abs) ? readFileSync(abs, "utf8") : null, place.sub);
    if (!r.ok) {
      files.push({ path, action: "skipped", note: `${r.reason}; the hook was not added` });
      problems.push(unmergeable(path, r.reason, place.sub));
      continue;
    }
    if (r.action !== "unchanged") {
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, r.text);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (!["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT"].includes(code)) throw e;
        files.push({ path, action: "skipped", note: `cannot write it (${code}); the hook was not added` });
        problems.push(problem("PROJECT_NOT_WRITABLE", {
          message: `croft init cannot write ${path} (${code}), so the hook was not added; everything else croft init does was done`,
          hint: `make ${dirname(path)} writable for your user, then run croft init --claude --with-hook again`,
          file: path,
          fix: { kind: "manual", description: `make ${dirname(path)} writable for your user and run croft init --claude --with-hook`, requiresHuman: true },
          details: { path: abs, error: code },
        }));
        continue;
      }
    }
    files.push({ path, action: r.action, note: r.note });
  }
  return { files, problems };
}

function unmergeable(path: string, reason: string, sub: string): Problem {
  const snippet = JSON.stringify(hookSettings(sub));
  return problem("USAGE_ERROR", {
    message: `${path}: ${reason}, so croft left it as it was and the hook was not added; everything else croft init does was done`,
    hint: `fix ${path} (Claude Code reads it as strict JSON: no comments, no trailing commas), then run croft init --claude --with-hook again`,
    file: path,
    fix: { kind: "manual", description: `make ${path} valid JSON and run croft init --claude --with-hook, or add this to it by hand: ${snippet}` },
    details: { reason, hook: hookSettings(sub) },
  });
}

// ---------------------------------------------------------------------------------------------------------
// The hook's input (croft validate --hook)

export interface HookInput {
  event?: string;
  tool?: string;
  /** The edited file as Claude Code gives it (absolute for the file tools), or null when the input names none. */
  file: string | null;
  cwd?: string;
}

/** The hook JSON Claude Code writes on stdin. USAGE_ERROR when it is not a JSON object. */
export function parseHookInput(stdin: string): HookInput {
  let v: unknown;
  try {
    v = JSON.parse(stdin);
  } catch {
    v = undefined;
  }
  if (!isObject(v)) {
    throw new CroftError("USAGE_ERROR", {
      message: `croft validate --hook reads the JSON Claude Code sends a PostToolUse hook on stdin, and stdin held ${stdin.trim() ? "something else" : "nothing"}`,
      hint: "the hook that croft init --claude --with-hook adds runs it after each edit; to check the project yourself, run croft validate",
      fix: { kind: "command", description: "validate the whole project", command: "croft validate" },
      details: { stdinBytes: stdin.length },
    });
  }
  const input = isObject(v.tool_input) ? v.tool_input : {};
  const response = isObject(v.tool_response) ? v.tool_response : {};
  const file = typeof input.file_path === "string" && input.file_path ? input.file_path
    : typeof response.filePath === "string" && response.filePath ? response.filePath : null;
  return {
    file,
    ...(typeof v.hook_event_name === "string" ? { event: v.hook_event_name } : {}),
    ...(typeof v.tool_name === "string" ? { tool: v.tool_name } : {}),
    ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
  };
}

/** A path with symlinks resolved as far as it exists (macOS's /tmp is /private/tmp), for comparing folders. */
function physical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(physical(parent), basename(p));
  }
}

/** Whether a root-relative path is one the hook checks: a .ts or .sql file in assets/ (not a .d.ts), or any
 *  file in lib/. */
function watched(rel: string): boolean {
  if (rel.startsWith("lib/")) return true;
  return rel.startsWith("assets/") && /\.(ts|sql)$/.test(rel) && !rel.endsWith(".d.ts");
}

/**
 * The file a hook invocation is about, relative to the project root with "/" separators, from the hook's JSON
 * on stdin; null when it names no file, or one that is not an asset file in assets/ or a file in lib/ of this
 * project. A relative path is read from the input's cwd. Throws USAGE_ERROR for stdin that is not hook JSON.
 */
export function hookTarget(stdin: string, root: string): string | null {
  const input = parseHookInput(stdin);
  if (!input.file) return null;
  const abs = resolve(input.cwd ?? root, input.file);
  for (const [file, dir] of [[abs, root], [physical(abs), physical(root)]] as const) {
    const rel = relative(dir, file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const posix = rel.split(sep).join("/");
    return watched(posix) ? posix : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// What an edit affects, and what Claude reads

/** What the hook needs of a resolved project (project/resolve.ts ResolvedProject). */
export interface HookProject {
  assets: readonly { name: string; file: string; kind: string | null; ok?: boolean; ts?: { localFiles: readonly string[] }; problems?: readonly Problem[] }[];
  graph: { downstream(names: readonly string[]): string[] };
}

/**
 * The assets an edit of `target` can break, the edited one first:
 * - an SQL asset and everything downstream of it: its output columns are what its readers bind against;
 * - a TS asset alone: what it writes is known only once it runs, so its readers have nothing new to check;
 * - a lib/ file: the TS assets that import it (their bundle's files), and those that failed to load because of
 *   it (a lib file that no longer compiles leaves them without a bundle).
 */
export function hookSelection(resolved: HookProject, target: string): string[] {
  const asset = resolved.assets.find((a) => a.file === target);
  if (asset) return asset.kind === "sql" ? [asset.name, ...resolved.graph.downstream([asset.name]).filter((n) => n !== asset.name)] : [asset.name];
  return resolved.assets.filter((a) => a.ts?.localFiles.includes(target)
    || (a.ok === false && (a.problems ?? []).some((p) => p.file === target || p.message.includes(target))))
    .map((a) => a.name);
}

/** The problems Claude sees: errors and warnings of the selected assets and of the edited file (info is left
 *  for croft validate). */
export function hookProblems(problems: readonly Problem[], selected: ReadonlySet<string>, target: string): Problem[] {
  return problems.filter((p) => p.severity !== "info" && (p.asset ? selected.has(p.asset) : p.file === target || p.code === "CYCLE"));
}

/**
 * The stderr Claude reads when an edit left errors (exit 2): one line saying what was checked, each problem as
 * croft prints it (file:line, message, fix: `formatted`), and what to do next. `asset` is the edited asset's
 * name (null for a lib/ file); `selected` is every asset checked.
 */
export function hookReport(o: { target: string; asset: string | null; selected: readonly string[]; problems: readonly Problem[]; formatted: string }): string {
  const count = (sev: Problem["severity"], word: string) => {
    const k = o.problems.filter((p) => p.severity === sev).length;
    return k ? [`${k} ${word}${k === 1 ? "" : "s"}`] : [];
  };
  const found = [...count("error", "error"), ...count("warning", "warning")].join(", ");
  const others = o.selected.filter((n) => n !== o.asset);
  const checked = !others.length ? ""
    : o.target.startsWith("lib/") ? ` (checked the assets that import it: ${others.join(", ")})`
      : ` (also checked the assets that read it: ${others.join(", ")})`;
  return [
    `croft validate --hook: ${found} after the edit to ${o.target}${checked}`,
    o.formatted,
    `Fix ${o.problems.length === 1 ? "it" : "them"}, then carry on: croft checks each edit under assets/ and lib/ again.`,
  ].join("\n");
}

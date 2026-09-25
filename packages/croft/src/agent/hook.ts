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
// - PostToolUse and exit 2: "Shows stderr to Claude; the tool already ran". Exit 0: stderr goes to the debug log
//   only, and stdout that starts with { and ends with } is read as JSON: hookSpecificOutput.additionalContext
//   (hookEventName "PostToolUse") reaches Claude as a system reminder next to the tool result, capped at 10,000
//   characters. Any other exit: a "hook error" notice for the user with the first line of stderr ("Failed with
//   non-blocking status code: ..."), and Claude carries on;
// - a command that cannot start (a missing file: sh exits 127) is such a non-blocking error;
// - the same handler defined in several settings files runs once; a command hook times out after 600 s unless
//   `timeout` (seconds) says otherwise.
// [V: code.claude.com/docs/en/hooks.md, read 2026-09-24.] So croft validate --hook exits 2 only for errors in the
// edited assets, hands warnings to Claude as additionalContext with exit 0, and exits 1 for its own failures
// (NEEDS_BUN, BUN_TOO_OLD, the DuckDB binding, a usage error), which never block Claude.
//
// Not used: a handler's `if` field (a permission rule such as "Edit(/assets/**)") would spare the spawn for other
// edits, but whether an Edit(...) rule matches Write calls there, and whether older Claude Code versions accept the
// field, is [U]; croft filters the edited path itself.
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
import { type Node as JsonNode, parseJsonc } from "../project/init-tsconfig.ts";

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
  /** How long validate --hook waits for stdin to close. Claude Code writes the JSON at once and closes it; a pipe
   *  nobody closes (a shell or a wrapper whose stdin is a pipe) would otherwise hold the hook until its timeout. */
  stdinTimeoutMs: 5_000,
  /** All of stdin as text, or null when it is still open after `ms`. */
  readStdin: (ms: number): Promise<string | null> => readAll(Bun.stdin.stream(), ms),
};

/**
 * All of a stream as UTF-8 text, or null when it has not ended after `ms`; then the read is canceled, since a
 * pending read of stdin keeps Bun running until the pipe closes [V: Bun.stdin.text() raced against a timer
 * held a `(sleep 4) |` process for 4 s; a canceled reader let it exit at the deadline].
 */
export async function readAll(stream: ReadableStream<Uint8Array>, ms: number): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((done) => { timer = setTimeout(() => done(null), ms); });
  const all = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      chunks.push(value);
    }
  })();
  try {
    const text = await Promise.race([all, deadline]);
    if (text === null) {
      all.catch(() => {});                              // the canceled read rejects or ends; nothing waits on it
      await reader.cancel().catch(() => {});
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** The hook's stdin (HOOK_IO), or USAGE_ERROR when it is still open after the time limit. */
export async function readHookStdin(): Promise<string> {
  const text = await HOOK_IO.readStdin(HOOK_IO.stdinTimeoutMs);
  if (text !== null) return text;
  throw new CroftError("USAGE_ERROR", {
    message: `croft validate --hook reads the JSON Claude Code sends a PostToolUse hook on stdin, and stdin was still open after ${HOOK_IO.stdinTimeoutMs / 1000} s`,
    hint: "Claude Code writes the hook's JSON and closes stdin at once; to check the project yourself, run croft validate",
    fix: { kind: "command", description: "validate the whole project", command: "croft validate" },
    details: { timeoutMs: HOOK_IO.stdinTimeoutMs },
  });
}

/** Quote a path segment for sh (main.ts has the same rule; importing it here would load the CLI). */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook's shell command: the project's pinned croft, run from the project folder. `sub` is the project's
 * folder relative to where Claude Code starts (CLAUDE_PROJECT_DIR): "" for the project itself, "data" for a
 * project inside an app.
 *
 * Until `bun install` has linked node_modules/.bin/croft (a fresh clone, a teammate who pulled the settings, an
 * app whose data/ is not installed yet), or when the folder is gone, the guard exits 0: nothing to check, and no
 * "hook error" after every edit. With the pinned croft present but no bun on the hook's PATH, bin/croft.mjs
 * answers NEEDS_BUN with exit 1, a notice for the user that does not block Claude.
 */
export function hookCommand(sub = ""): string {
  const dir = sub ? `"$CLAUDE_PROJECT_DIR"/${sub.split("/").map(shellQuote).join("/")}` : `"$CLAUDE_PROJECT_DIR"`;
  return `cd ${dir} && test -x ${PINNED_BIN} || exit 0; ${PINNED_BIN} validate --hook`;
}

/** The project's pinned croft, as `bun install` links it. */
const PINNED_BIN = "./node_modules/.bin/croft";

/**
 * Whether argv runs croft validate --hook: then a failure that is not a finding about the edited assets (croft's
 * own, or the machine's: Bun too old, the DuckDB binding) exits 1, never 2 (main.ts; bin/croft.mjs has the same
 * test for NEEDS_BUN). Flags before a bare `--` count; the first argument that is not a flag names the command.
 */
export function isHookArgv(argv: readonly string[]): boolean {
  let name: string | undefined;
  let hook = false;
  for (const a of argv) {
    if (a === "--") break;
    if (a === "--hook") hook = true;
    else if (name === undefined && !a.startsWith("-")) name = a;
  }
  return hook && name === "validate";
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
 * Merge the hook into the text of a settings file (null: there is none). The file is usually committed and
 * shared, so the hook goes in as one text insertion and every other byte stays as written: line endings,
 * indentation, compact arrays, number spelling, escapes, key order. The group is appended to hooks.PostToolUse
 * (or a "PostToolUse" list, or a "hooks" object, is added), laid out like the file: its indentation and line
 * endings, or on one line in a one-line file. A file that already runs croft validate --hook (this command or
 * another way of writing it) is left as it is, so a second run never doubles the hook. Refused, with the reason,
 * when croft cannot make that one insertion: the file is not strict JSON (Claude Code reads it that way), not an
 * object, "hooks" or "hooks.PostToolUse" has another shape or is written twice. croft never rewrites the file.
 */
export function mergeHookSettings(existing: string | null, sub = ""): MergeResult {
  const entry = hookSettings(sub);
  const created = `${JSON.stringify(entry, null, 2)}\n`;
  if (existing === null) return { ok: true, action: "created", text: created, note: ADDED };
  const source = existing.replace(/^﻿/, "");
  if (!source.trim()) return { ok: true, action: "merged", text: created, note: ADDED };
  let settings: unknown;
  try {
    settings = JSON.parse(source);
  } catch (e) {
    return { ok: false, reason: `it is not valid JSON (${(e as Error).message})` };
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
  const group = entry.hooks.PostToolUse[0]!;
  const inserted = insertHook(existing, group);
  if (typeof inserted !== "string") return inserted;
  // The one insertion must read back as the settings plus the group, and nothing else.
  const expected: Json = { ...settings, hooks: { ...hooks, [HOOK_EVENT]: [...(groups ?? []), group] } };
  let check: unknown;
  try {
    check = JSON.parse(inserted.replace(/^﻿/, ""));
  } catch {
    check = undefined;
  }
  if (JSON.stringify(check) !== JSON.stringify(expected)) return { ok: false, reason: "croft could not add the hook to it without changing anything else" };
  const off = settings.disableAllHooks === true ? `; "disableAllHooks" is true in it, so Claude Code runs no hooks until that is removed` : "";
  return { ok: true, action: "merged", text: inserted, note: `${ADDED}${off}` };
}

type ObjectNode = Extract<JsonNode, { type: "object" }>;
type ArrayNode = Extract<JsonNode, { type: "array" }>;

/** `text` with the hook group inserted where it goes (see mergeHookSettings), or the refusal. */
function insertHook(text: string, group: HookGroup): string | Extract<MergeResult, { ok: false }> {
  let root: JsonNode;
  try {
    root = parseJsonc(text);
  } catch (e) {
    return { ok: false, reason: `it is not valid JSON (${(e as Error).message})` };
  }
  if (root.type !== "object") return { ok: false, reason: "it is not a JSON object" };
  const twice = (obj: ObjectNode, key: string) => obj.props.filter((p) => p.key === key).length > 1;
  if (twice(root, "hooks")) return { ok: false, reason: `"hooks" is written twice in it` };
  const hooks = root.props.find((p) => p.key === "hooks")?.value;
  if (!hooks) return insertMember(text, root, `"hooks": `, { [HOOK_EVENT]: [group] });
  if (hooks.type !== "object") return { ok: false, reason: `"hooks" is not an object` };
  if (twice(hooks, HOOK_EVENT)) return { ok: false, reason: `"hooks.${HOOK_EVENT}" is written twice in it` };
  const list = hooks.props.find((p) => p.key === HOOK_EVENT)?.value;
  if (!list) return insertMember(text, hooks, `${JSON.stringify(HOOK_EVENT)}: `, [group]);
  if (list.type !== "array") return { ok: false, reason: `"hooks.${HOOK_EVENT}" is not a list` };
  return insertMember(text, list, "", group);
}

/**
 * Add a member (`key` is `"name": ` for an object, "" for a list) as the last one of `node`, laid out like the
 * file: in a container that spans lines, on its own line at the indentation of the members before it (one step
 * deeper than the container's line when it has none), with the file's line endings and indentation step; in a
 * one-line file, on the same line.
 */
function insertMember(text: string, node: ObjectNode | ArrayNode, key: string, value: unknown): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const members = node.type === "object" ? node.props.map((p) => p.value) : node.items;
  const last = members.at(-1);
  const multiline = text.slice(node.start, node.end).includes("\n") || (!last && /\n\s*\S/.test(text.trim()));
  if (!multiline && (last || text.trim() !== text.slice(node.start, node.end))) {
    // One line (the container, or the whole file when the container is empty): stay on it, spaced like it.
    const spaced = /":\s/.test(last ? text.slice(node.start, node.end) : text);
    const member = spaced
      ? `${key}${JSON.stringify(value, null, 1).replace(/,\n\s*/g, ", ").replace(/\n\s*/g, "")}`
      : `${key.replace(/: $/, ":")}${JSON.stringify(value)}`;
    return last
      ? `${text.slice(0, last.end)}${spaced ? ", " : ","}${member}${text.slice(last.end)}`
      : `${text.slice(0, node.start + 1)}${member}${text.slice(node.end - 1)}`;
  }
  const step = indentStep(text);
  const indent = last ? lineIndent(text, last.start) : lineIndent(text, node.start) + step;
  const member = key + JSON.stringify(value, null, step).split("\n").join(eol + indent);
  if (last) return `${text.slice(0, last.end)},${eol}${indent}${member}${text.slice(last.end)}`;
  // Empty: the member on its own line, the closing bracket back at the container's indentation.
  return `${text.slice(0, node.start + 1)}${eol}${indent}${member}${eol}${lineIndent(text, node.start)}${text.slice(node.end - 1)}`;
}

/** The whitespace that starts the line holding offset `at`. */
function lineIndent(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** The indentation step a JSON file uses: its first indented line's, else two spaces. */
function indentStep(text: string): string {
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

/** A settings file croft cannot add the hook to with one insertion: nothing is written, and the fix is the snippet
 *  to add by hand. */
function unmergeable(path: string, reason: string, sub: string): Problem {
  const snippet = JSON.stringify(hookSettings(sub));
  const invalid = reason.startsWith("it is not valid JSON");
  return problem("USAGE_ERROR", {
    message: `${path}: ${reason}, so croft left it as it was and the hook was not added; everything else croft init does was done`,
    hint: invalid
      ? `fix ${path} (Claude Code reads it as strict JSON: no comments, no trailing commas), then run croft init --claude --with-hook again`
      : `croft changes ${path} only by one insertion that keeps the rest as written; add the hook by hand, or fix what is named above and run croft init --claude --with-hook again`,
    file: path,
    fix: {
      kind: "manual",
      description: `add this to ${path} by hand, merged into "hooks" and "hooks.PostToolUse" where the file has them: ${snippet}${invalid ? `; or make ${path} valid JSON and run croft init --claude --with-hook` : ""}`,
    },
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

/**
 * How the hook names a project file (root-relative, "/" separators) for Claude: relative to the folder Claude
 * works in, the hook input's `cwd`. In an app whose croft project is data/, Claude Code starts in the app folder,
 * so an asset is data/assets/x.sql; after Claude has moved into assets/, it is x.sql. A folder that is neither
 * inside the project nor above it gets absolute paths. Without a usable cwd, paths stay root-relative.
 */
export function hookPaths(root: string, cwd: string | undefined): (file: string) => string {
  if (!cwd || !isAbsolute(cwd)) return (file) => file;
  const from = physical(cwd);
  const to = physical(root);
  const below = (rel: string) => rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  const abs = (dir: string, file: string) => (isAbsolute(file) ? file : join(dir, ...file.split("/")));
  if (!below(relative(to, from)) && !below(relative(from, to))) return (file) => abs(root, file);
  return (file) => relative(from, abs(to, file)).split(sep).join("/") || file;
}

/** A project path written in a sentence: assets/… or lib/… with an extension, not part of a longer path. */
const PATH_IN_TEXT = /(?<![\w./-])(?:assets|lib)\/[\w./-]*\.[A-Za-z0-9]+(?![\w/-])/g;

/**
 * The problems with their files named by `show` (hookPaths): the file, an edit fix's file, and the paths written
 * in the first line of the message, the hint and the fix's description (the lines after a message's first quote
 * code, which stays as written).
 */
export function showPaths(problems: readonly Problem[], show: (file: string) => string): Problem[] {
  const text = (s: string) => s.replace(PATH_IN_TEXT, (path) => show(path));
  return problems.map((p) => {
    const [first = "", ...rest] = p.message.split("\n");
    const out: Problem = { ...p, message: [text(first), ...rest].join("\n"), hint: text(p.hint) };
    if (p.file !== undefined) out.file = show(p.file);
    if (p.fix) out.fix = p.fix.kind === "edit" ? { ...p.fix, file: show(p.fix.file), description: text(p.fix.description) } : { ...p.fix, description: text(p.fix.description) };
    return out;
  });
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

/** What the hook found: `target` is the edited file relative to the project root, `shown` the same file as Claude
 *  reads it (hookPaths; default `target`). */
interface HookFindings { target: string; shown?: string; asset: string | null; selected: readonly string[]; problems: readonly Problem[] }

/** The first line Claude reads: what the edit left, and what was checked besides the edited file. */
function hookHeader(o: HookFindings): string {
  const count = (sev: Problem["severity"], word: string) => {
    const k = o.problems.filter((p) => p.severity === sev).length;
    return k ? [`${k} ${word}${k === 1 ? "" : "s"}`] : [];
  };
  const found = [...count("error", "error"), ...count("warning", "warning")].join(", ");
  const others = o.selected.filter((n) => n !== o.asset);
  const checked = !others.length ? ""
    : o.target.startsWith("lib/") ? ` (checked the assets that import it: ${others.join(", ")})`
      : ` (also checked the assets that read it: ${others.join(", ")})`;
  return `croft validate --hook: ${found} after the edit to ${o.shown ?? o.target}${checked}`;
}

/**
 * The stderr Claude reads when an edit left errors (exit 2): one line saying what was checked, each problem as
 * croft prints it (file:line, message, fix: `formatted`), and what to do next. `asset` is the edited asset's
 * name (null for a lib/ file); `selected` is every asset checked.
 */
export function hookReport(o: HookFindings & { formatted: string }): string {
  return [
    hookHeader(o),
    o.formatted,
    `Fix ${o.problems.length === 1 ? "it" : "them"}, then carry on: croft checks each edit under assets/ and lib/ again.`,
  ].join("\n");
}

/** Claude Code's cap on a hook's additionalContext: longer text goes to a file Claude is not asked to read
 *  [V: code.claude.com/docs/en/hooks, "JSON output", 2026-09-24]. */
export const HOOK_CONTEXT_MAX = 10_000;

/**
 * What Claude reads when an edit left warnings only (exit 0, hookOutput): the header, each warning as croft prints
 * it (`formatted`, one per problem), and a closing line that says what warnings mean. Written as facts, not
 * orders, as the docs advise for additionalContext. Warnings that would pass HOOK_CONTEXT_MAX are counted
 * instead of shown.
 */
export function hookContext(o: HookFindings & { formatted: readonly string[] }): string {
  const n = o.problems.length;
  const head = hookHeader(o);
  const tail = n === 1
    ? "A warning does not stop the edit or croft run; it says what the asset will cost or risk as written."
    : "Warnings do not stop the edit or croft run; each says what its asset will cost or risk as written.";
  const more = (k: number) => `... and ${k} more warning${k === 1 ? "" : "s"}; croft validate lists them all`;
  const shown: string[] = [];
  let length = head.length + tail.length + 2;
  for (let i = 0; i < n; i++) {
    const text = o.formatted[i] ?? "";
    const reserve = i < n - 1 ? more(n).length + 1 : 0;       // room to say what was left out
    if (length + text.length + 1 + reserve > HOOK_CONTEXT_MAX) {
      shown.push(more(n - i));
      break;
    }
    shown.push(text);
    length += text.length + 1;
  }
  return [head, ...shown, tail].join("\n");
}

/** The one line of JSON on stdout that hands `context` to Claude without blocking it: PostToolUse
 *  hookSpecificOutput.additionalContext, read on exit 0, which Claude sees next to the tool's result as a system
 *  reminder [V: code.claude.com/docs/en/hooks, "PostToolUse decision control" and "Add context for Claude"]. */
export function hookOutput(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: context } });
}

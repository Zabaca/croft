// Secrets from <root>/.env (DESIGN.md §9.8). Bun's own .env loading is off (`bun --no-env-file`):
// it depends on the working directory and silently prefers .env.local. croft parses .env itself,
// the shell environment wins over it, only declared names reach asset code, and every .env value
// is redacted from messages and logs. Command data (query rows) is redacted more narrowly: see redactsInData.
//
// croft.json's secretsFrom (D108) names a command whose output, read as .env text, supplies what the shell and .env
// lack: an encrypted store (`sops -d --output-type dotenv secrets.enc.yaml`) without a wrapper script around every
// croft command. It runs only when a secret is asked for (ctx.secret(), croft secrets) and neither the shell nor .env
// has it, at most once per ProjectEnv (one per process), with no shell, no input, an explicit environment and a
// deadline. Its values stay in memory and are redacted like .env values; a failure is SECRETS_COMMAND_FAILED,
// remembered, with the command's stderr redacted.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { CONFIG_FILE, parseConfig, type SecretsFrom } from "./root.ts";

export interface DotenvIssue { line: number; message: string }
export interface DotenvParse { values: Map<string, string>; issues: DotenvIssue[] }

const KEY = /^[A-Za-z_][\w.-]*$/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/** Parse .env text, dotenv-style: `#` comments, an optional `export ` prefix, single, double and
 *  backtick quotes (multi-line), and \n \r \t \" \\ escapes inside double quotes only.
 *  Two deliberate differences from dotenv: an unquoted `#` starts a comment only after whitespace
 *  (so `KEY=pa#ss` keeps its `#`), and there is no `${VAR}` expansion. The last duplicate wins. */
export function parseDotenv(text: string): DotenvParse {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const values = new Map<string, string>();
  const issues: DotenvIssue[] = [];
  let i = 0;
  let line = 1;

  const restOfLine = (from: number) => {
    const end = src.indexOf("\n", from);
    return end === -1 ? src.length : end;
  };

  while (i < src.length) {
    const startLine = line;
    const eol = restOfLine(i);
    const raw = src.slice(i, eol);
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) { i = eol + 1; line++; continue; }

    const m = /^\s*(?:export\s+)?([^=\s]+)\s*=[ \t]*/.exec(raw);
    if (!m || !KEY.test(m[1]!)) {
      issues.push({ line: startLine, message: `line ${startLine} is not KEY=value and was skipped` });
      i = eol + 1; line++; continue;
    }
    const key = m[1]!;
    const valueStart = i + m[0].length;
    const quote = src[valueStart];

    if (quote === '"' || quote === "'" || quote === "`") {
      const close = findClose(src, valueStart + 1, quote);
      if (close !== -1) {
        const after = src.slice(close + 1, restOfLine(close + 1));
        if (/^\s*(?:#.*)?$/.test(after)) {
          const body = src.slice(valueStart + 1, close);
          values.set(key, quote === '"' ? unescapeDouble(body) : body);
          const end = restOfLine(close + 1);
          line += countNewlines(src, i, end) + 1;
          i = end + 1;
          continue;
        }
      } else {
        issues.push({ line: startLine, message: `${key} on line ${startLine} opens a ${quote} quote that is never closed; the rest of the line was used as the value` });
      }
    }
    // Unquoted (or a quote that does not close cleanly): the rest of the line, minus a " #" comment.
    values.set(key, stripComment(src.slice(valueStart, eol)).trim());
    i = eol + 1; line++;
  }
  return { values, issues };
}

function findClose(src: string, from: number, quote: string): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\" && j + 1 < src.length) { j++; continue; }  // an escaped quote never closes
    if (src[j] === quote) return j;
  }
  return -1;
}

function unescapeDouble(body: string): string {
  return body.replace(/\\(.)/gs, (all, ch: string) => ESCAPES[ch] ?? all);
}

function stripComment(value: string): string {
  if (value.startsWith("#")) return "";
  const m = /\s#/.exec(value);
  return m ? value.slice(0, m.index) : value;
}

function countNewlines(s: string, from: number, to: number): number {
  let count = 0;
  for (let j = from; j < to; j++) if (s.charCodeAt(j) === 10) count++;
  return count;
}

export type SecretSource = ".env" | "env" | "command";
/** "unchecked": in neither the shell nor .env, and only the secretsFrom command, not run (or failed), could say
 *  (source "command"). */
export interface SecretStatus { name: string; status: "set" | "missing" | "unchecked"; source: SecretSource | null; usedBy: string[] }

/** How long the secretsFrom command may take: long enough for an unlock a person answers in another window, short
 *  enough that a run waiting on a prompt nobody sees fails instead of hanging. */
export const SECRETS_COMMAND_TIMEOUT_MS = 60_000;
/** The most output the command may print (stdout or stderr). */
const SECRETS_COMMAND_MAX_BYTES = 16 * 1024 * 1024;
/** croft's own credentials, never handed to the command: the confirmation grant (safety/confirm.ts
 *  CONFIRM_GRANT_ENV) and the serve token (serve/auth.ts TOKEN_ENV). */
const NOT_PASSED = new Set(["CROFT_CONFIRM_GRANT", "CROFT_SERVE_TOKEN"]);
/** How much of the command's stderr a failure quotes: its end, where tools say what went wrong. */
const STDERR_LINES = 20;
const STDERR_CHARS = 2000;

// Template names that document variables rather than hold them; warning about them would be noise.
const TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const MIN_REDACT = 4;
const MIN_DATA_REDACT = 8;

/** Whether a value is redacted inside command data (query rows, samples): a declared secret always (4+
 *  characters, as everywhere), any other .env value only when it looks like a credential, i.e. 8+ characters
 *  and not only letters or only digits. PORT=5432, LOG_LEVEL=info or NODE_ENV=production would otherwise
 *  rewrite ordinary values an agent reasons from; they are still redacted from messages and logs. */
export function redactsInData(value: string, declared: boolean): boolean {
  if (value.length < MIN_REDACT) return false;
  if (declared) return true;
  return value.length >= MIN_DATA_REDACT && !/^\p{L}+$/u.test(value) && !/^\d+$/.test(value);
}

/** Secret names a TS file declares, read from its text: `secrets: ["A", 'B']` lists and `secret("C")` calls.
 *  The fallback for a file that does not import, so its secrets are still known (and redacted), and what the
 *  scheduler reads, without importing, to hold assets that read secrets (D108). */
export function staticSecrets(source: string): string[] {
  const names = new Set<string>();
  const literal = /(["'`])([A-Za-z_][\w.-]*)\1/g;
  for (const m of source.matchAll(/\bsecrets\s*:\s*\[([^\]]*)\]/g)) {
    for (const l of m[1]!.matchAll(literal)) names.add(l[2]!);
  }
  for (const m of source.matchAll(/\bsecret\s*\(\s*(["'`])([A-Za-z_][\w.-]*)\1\s*\)/g)) names.add(m[2]!);
  return [...names].sort();
}

/** A compiled redaction (Redaction, below). */
type Pattern = Redaction;

/** The project's secrets: <root>/.env overlaid by the shell environment, and what croft.json's secretsFrom command
 *  prints for names neither has. Values are held in private fields so logging or serializing this object never
 *  prints them. */
export class ProjectEnv {
  readonly root: string | null;
  readonly ignoredFiles: string[];
  readonly issues: DotenvIssue[];
  /** croft.json's secretsFrom, or null. */
  readonly secretsFrom: SecretsFrom | null;
  readonly #file: Map<string, string>;
  readonly #shell: Record<string, string | undefined>;
  readonly #extra = new Map<string, string>();           // shell values handed out by secret()
  readonly #declared = new Set<string>();                // names assets list in `secrets`
  readonly #commandTimeoutMs: number;
  /** What the secretsFrom command printed: the values once it succeeded; after a failure, whatever its output held,
   *  kept only so redaction hides it. */
  readonly #command = new Map<string, string>();
  /** Whether the command ran: null not yet, "ok", or its failure (thrown again for every name it would supply). */
  #commandRun: "ok" | CroftError | null = null;
  #pattern: Pattern | null = null;
  #dataPattern: Pattern | null | undefined;

  constructor(opts: { root: string | null; fileValues?: Map<string, string>; shell?: Record<string, string | undefined>;
    ignoredFiles?: string[]; issues?: DotenvIssue[]; secretsFrom?: SecretsFrom | null; commandTimeoutMs?: number }) {
    this.root = opts.root;
    this.#file = opts.fileValues ?? new Map();
    this.#shell = opts.shell ?? {};
    this.ignoredFiles = opts.ignoredFiles ?? [];
    this.issues = opts.issues ?? [];
    this.secretsFrom = opts.secretsFrom ?? null;
    this.#commandTimeoutMs = opts.commandTimeoutMs ?? SECRETS_COMMAND_TIMEOUT_MS;
  }

  /** Read <root>/.env (a missing file is fine), note .env.local and .env.* files croft ignores, and take
   *  croft.json's secretsFrom (none when croft.json does not load: every command that runs assets refuses then). */
  static load(root: string | null, shell: Record<string, string | undefined> = process.env, o: { commandTimeoutMs?: number } = {}): ProjectEnv {
    if (!root) return new ProjectEnv({ root: null, shell });
    let text = "";
    try {
      text = readFileSync(join(root, ".env"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const { values, issues } = parseDotenv(text);
    let ignoredFiles: string[] = [];
    try {
      ignoredFiles = readdirSync(root).filter((f) => f.startsWith(".env.") && !TEMPLATES.has(f)).sort();
    } catch { /* unreadable root: nothing to report */ }
    return new ProjectEnv({ root, fileValues: values, shell, ignoredFiles, issues, secretsFrom: secretsFromOf(root), ...o });
  }

  /** A value and where it came from, without running anything. A non-empty shell variable wins over .env; an empty
   *  one does not, because CI systems export missing secrets as "". The secretsFrom command's values come last, and
   *  only once it has run (resolve() runs it). */
  lookup(name: string): { value: string; source: SecretSource } | null {
    const shell = this.#shell[name];
    if (shell !== undefined && shell !== "") return { value: shell, source: "env" };
    const file = this.#file.get(name);
    if (file !== undefined && file !== "") return { value: file, source: ".env" };
    const command = this.#commandRun === "ok" ? this.#command.get(name) : undefined;
    if (command !== undefined && command !== "") return { value: command, source: "command" };
    return null;
  }

  /** lookup(), running the secretsFrom command first when the shell and .env lack the name and it has not run in
   *  this process. Throws its SECRETS_COMMAND_FAILED (with `asset`) when it failed, now or earlier. */
  resolve(name: string, asset?: string): { value: string; source: SecretSource } | null {
    const found = this.lookup(name);
    if (found || !this.secretsFrom) return found;
    if (this.#commandRun === null) this.#runCommand();
    if (this.#commandRun instanceof CroftError) {
      const p = this.#commandRun.problem;
      throw new CroftError("SECRETS_COMMAND_FAILED", {
        message: p.message, hint: p.hint, ...(asset ? { asset } : {}), ...(p.file ? { file: p.file } : {}),
        ...(p.fix ? { fix: p.fix } : {}), ...(p.details ? { details: { ...p.details, name } } : {}),
      });
    }
    return this.lookup(name);
  }

  /** The secretsFrom command's failure in this process, or null (it succeeded, or has not run). */
  commandFailure(): CroftError | null {
    return this.#commandRun instanceof CroftError ? this.#commandRun : null;
  }

  /** Whether the secretsFrom command has run in this process (successfully or not). */
  get commandRan(): boolean {
    return this.#commandRun !== null;
  }

  /** ctx.secret(): only names the asset declared in `secrets`; throws SECRET_MISSING otherwise. */
  secret(name: string, declared: readonly string[], asset?: string): string {
    const where = asset ? ` (asset ${asset})` : "";
    if (!declared.includes(name)) {
      throw new CroftError("SECRET_MISSING", {
        message: `secret "${name}" is not declared${where}; only names listed in the asset's secrets can be read`,
        hint: `add secrets: ["${[...declared, name].join('", "')}"] to the asset`,
        ...(asset ? { asset } : {}),
        fix: { kind: "manual", description: `add "${name}" to the asset's secrets list` },
        details: { name, declared: [...declared] },
      });
    }
    this.declare(declared);
    const found = this.resolve(name, asset);
    if (!found) throw missingSecret(name, asset, this.secretsFrom);
    if (found.source === "env") this.#remember(name, found.value);
    return found.value;
  }

  /** `croft secrets --json`: every declared name, whether it is set, where from, and who uses it. With `run`
   *  (croft secrets), the secretsFrom command runs when a name is in neither the shell nor .env; without it
   *  (validate, doctor, which run on every edit) such a name is "unchecked", as it is when the command failed. */
  listSecrets(declaredByAsset: Record<string, readonly string[]>, o: { run?: boolean } = {}): SecretStatus[] {
    const usedBy = new Map<string, Set<string>>();
    for (const [asset, names] of Object.entries(declaredByAsset)) {
      for (const name of names) {
        if (!usedBy.has(name)) usedBy.set(name, new Set());
        usedBy.get(name)!.add(asset);
      }
    }
    return [...usedBy.keys()].sort().map((name) => {
      let found = this.lookup(name);
      if (!found && o.run) {
        try {
          found = this.resolve(name);
        } catch {
          // commandFailure() has it; the name stays unchecked.
        }
      }
      const users = [...usedBy.get(name)!].sort();
      if (!found && this.secretsFrom && this.#commandRun !== "ok") return { name, status: "unchecked", source: "command", usedBy: users };
      return { name, status: found ? "set" : "missing", source: found?.source ?? null, usedBy: users };
    });
  }

  /** ENV_FILE_IGNORED warnings, one per ignored file. */
  problems(): Problem[] {
    return this.ignoredFiles.map((file) => problem("ENV_FILE_IGNORED", {
      message: `${file} is ignored: croft reads secrets only from .env`,
      hint: `move the values you need from ${file} into .env`,
      file,
      fix: { kind: "manual", description: `move the values from ${file} into .env, then delete ${file}`, requiresHuman: true },
    }));
  }

  /** Mark names as declared secrets (an asset's `secrets` list): redactData() then always hides their values,
   *  whether they come from .env, the shell (a shell value is registered as secret() would, without being
   *  handed out) or the secretsFrom command (once it has run; declaring never runs it). secret() declares the
   *  calling asset's list; commands that show data should declare the project's. */
  declare(names: Iterable<string>): void {
    for (const name of names) {
      if (this.#declared.has(name)) continue;
      this.#declared.add(name);
      this.#dataPattern = undefined;
      const found = this.lookup(name);
      if (found?.source === "env") this.#remember(name, found.value);
    }
  }

  /** Replace every .env value (every value the secretsFrom command printed, and every shell value handed out by
   *  secret()) of 4+ characters, in any of its renderings (escaped, URL-encoded, base64, a line of a multi-line
   *  value: see below), with [redacted:NAME]. Longer values are replaced first so overlapping values stay hidden.
   *  For free text: messages, hints, logs. A command that has not run in this process has given croft nothing to
   *  hide, and redaction never runs it. */
  redact(text: string): string {
    return replaceWith(this.#compile(), text);
  }

  /** Redaction for command data (query rows, samples): see redactsInData. The command's values count as .env
   *  values; shell values handed out by secret() count as declared. */
  redactData(text: string): string {
    if (this.#dataPattern === undefined) {
      const entries = [...this.#file, ...this.#command].filter(([name, value]) => redactsInData(value, this.#declared.has(name)));
      for (const [name, value] of this.#extra) if (redactsInData(value, true)) entries.push([name, value]);
      this.#dataPattern = buildPattern(entries);
    }
    return replaceWith(this.#dataPattern, text);
  }

  /** Redact every string inside a JSON-like value; keys are kept. */
  redactDeep<T>(value: T): T {
    if (!this.#compile()) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.redact(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(value) as T;
  }

  toJSON(): { root: string | null; names: string[]; ignoredFiles: string[]; secretsFrom: SecretsFrom | null } {
    return { root: this.root, names: [...this.#file.keys()].sort(), ignoredFiles: this.ignoredFiles, secretsFrom: this.secretsFrom };
  }

  #remember(name: string, value: string): void {
    if (this.#extra.get(name) === value) return;
    this.#extra.set(name, value);
    this.#pattern = null;
    this.#dataPattern = undefined;
  }

  #compile(): Pattern | null {
    this.#pattern ??= buildPattern([...this.#file, ...this.#command, ...this.#extra].filter(([, value]) => value.length >= MIN_REDACT));
    return this.#pattern;
  }

  /** Run the secretsFrom command once (see the top of this file). Its values are redacted from here on, whatever
   *  the outcome, before its stderr is quoted. */
  #runCommand(): void {
    const argv = this.secretsFrom!.command;
    const out = runSecretsCommand(argv, { cwd: this.root ?? process.cwd(), env: this.#shell, timeoutMs: this.#commandTimeoutMs });
    for (const [name, value] of out.values) this.#command.set(name, value);
    this.#pattern = null;
    this.#dataPattern = undefined;
    if (out.failure) {
      const f = out.failure;
      const stderr = this.redact(out.stderr);
      this.#commandRun = new CroftError("SECRETS_COMMAND_FAILED", {
        message: `the secretsFrom command in croft.json (${commandText(argv)}) ${f.what}${stderr ? `:\n${stderr}` : ""}`,
        hint: f.hint,
        file: CONFIG_FILE,
        fix: {
          kind: "manual", requiresHuman: true,
          description: "ask the user to run the secretsFrom command in their own terminal, from the project folder, and fix it or what it needs",
        },
        details: { command: [...argv], ...f.details, stderr },
      });
      return;
    }
    this.#commandRun = "ok";
  }
}

/** croft.json's secretsFrom, or null when it names none or croft.json does not load. */
function secretsFromOf(root: string): SecretsFrom | null {
  try {
    const r = parseConfig(readFileSync(join(root, CONFIG_FILE), "utf8"));
    return r.ok ? r.config.secretsFrom : null;
  } catch {
    return null;
  }
}

/** What the scheduler's approval of the secretsFrom command records (§6, D108): the command, not its output. */
export function secretsCommandHash(from: SecretsFrom): string {
  return createHash("sha256").update(JSON.stringify(from.command)).digest("hex").slice(0, 16);
}

/** A command as one line for messages: arguments with spaces or quotes in JSON quotes. */
export function commandText(argv: readonly string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./~-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

/** What running the secretsFrom command gave: the KEY=value pairs its stdout held (also after a failure, so they
 *  can be redacted), its stderr's end, and why it failed, if it did. */
export interface SecretsCommandOutput {
  values: Map<string, string>;
  stderr: string;
  failure: { what: string; hint: string; details: Record<string, unknown> } | null;
}

/** Run `argv` with no shell and no input, from `cwd`, with exactly `env` (croft's own credentials taken out), for at
 *  most `timeoutMs`. A bare program name is looked up on env.PATH, as the scheduler's runs see it, rather than on
 *  croft's own; a relative path is taken from `cwd`. stdout is read as .env text. */
export function runSecretsCommand(argv: readonly string[], o: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }): SecretsCommandOutput {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined && !NOT_PASSED.has(k)) env[k] = v;
  const program = argv[0]!;
  const unattended = "croft runs it with no terminal and no input, as runs from Claude Code and the scheduler do";
  const fail = (what: string, hint: string, details: Record<string, unknown> = {}, stdout = "", stderr = ""): SecretsCommandOutput =>
    ({ values: parseDotenv(stdout).values, stderr: tail(stderr), failure: { what, hint, details } });

  const path = program.includes("/") ? resolve(o.cwd, program) : Bun.which(program, { PATH: env.PATH ?? "" });
  if (!path) {
    return fail(`could not start: ${program} is not on PATH (${env.PATH || "empty"})`,
      `install ${program}, or write its absolute path as the first element of secretsFrom.command (\`command -v ${program}\` in a terminal prints it); scheduled runs search only Bun's folder, /opt/homebrew/bin (macOS), /usr/local/bin and the system folders`,
      { reason: "not_found", path: env.PATH ?? null });
  }
  const r = spawnSync(path, argv.slice(1), {
    cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: o.timeoutMs, maxBuffer: SECRETS_COMMAND_MAX_BYTES, windowsHide: true,
  });
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return fail(`could not start: ${path} does not exist`, "fix the program's path in secretsFrom.command (a relative path starts at the project folder)", { reason: "not_found" });
  }
  if (code === "EACCES") {
    return fail(`could not start: ${path} is not executable`, `make ${path} executable (chmod +x), or name the program that runs it first`, { reason: "not_executable" });
  }
  if (code === "ETIMEDOUT") {
    return fail(`did not finish within ${Math.round(o.timeoutMs / 1000)} s and was stopped`,
      `a command that waits for a password, a touch or a confirmation cannot finish here: ${unattended}. Make it work unattended (sops with an age key file, a service account token), or put the secrets in .env`,
      { reason: "timeout", timeoutMs: o.timeoutMs }, stdout, stderr);
  }
  if (code === "ENOBUFS") {
    return fail(`printed more than ${SECRETS_COMMAND_MAX_BYTES / 1024 / 1024} MiB and was stopped`, "make it print only the KEY=value lines of the secrets",
      { reason: "too_much_output" }, stdout, stderr);
  }
  if (r.error) return fail(`could not start: ${r.error.message}`, "run it in a terminal from the project folder to see why", { reason: "spawn_failed" }, stdout, stderr);
  if (r.status !== 0) {
    const how = r.signal ? `was stopped by ${r.signal}` : `exited with status ${r.status}`;
    return fail(how, `the user can run it in their own terminal from the project folder to see why (an agent must not: what it prints is the secrets); ${unattended}, and a scheduled run passes it only HOME, PATH, LANG and a few more variables (croft docs secrets)`,
      { reason: "exit", status: r.status, signal: r.signal ?? null }, stdout, stderr);
  }
  const parsed = parseDotenv(stdout);
  if (parsed.values.size === 0 && stdout.trim() !== "") {
    return fail(`printed ${parsed.issues.length} line${parsed.issues.length === 1 ? "" : "s"}, none of them KEY=value`,
      "croft reads the command's output as .env text, one KEY=value per line: make it print that (sops: -d --output-type dotenv)",
      { reason: "not_dotenv" }, stdout, stderr);
  }
  return { values: parsed.values, stderr: "", failure: null };
}

/** The end of a command's stderr: its last lines, at most STDERR_CHARS. */
function tail(stderr: string): string {
  const lines = stderr.replace(/\r\n?/g, "\n").trimEnd().split("\n").slice(-STDERR_LINES).join("\n");
  return lines.length > STDERR_CHARS ? `…${lines.slice(-STDERR_CHARS)}` : lines;
}

// ---------------------------------------------------------------------------------------------------------
// How a value can appear in text (§9.6: every rendering of a .env value is redacted).
//
// Asset code rarely prints a secret raw. It prints it inside an object (console.log and ctx.log use util.inspect,
// which escapes \ ' and control characters and splits a multi-line string into '…\n' + lines), serializes it
// (JSON.stringify escapes " \ and control characters), and APIs echo it back escaped (PHP's json_encode writes
// "/" as "\/" and non-ASCII as \u00e9), URL-encoded, or base64-encoded (a Basic auth header echoed in an error).
// So one value becomes several alternatives of one regular expression:
//
//   - the value itself, where every character other than a letter or digit may be written escaped: backslashes
//     before it (JSON, inspect, \/, and text escaped up to three times), \n \t \r \b \f \v, \xHH or \uHHHH (either
//     case); a line break may also be followed by inspect's `' +\n  '` continuation. This one pattern covers the
//     raw text, JSON.stringify, util.inspect in any quote style, PHP-style \/ and ASCII-only JSON;
//   - each line of 8+ characters of a multi-line value (a PEM key's body), in the same escaped-or-not form, so
//     part of a key printed on its own is caught too;
//   - its URL encodings: encodeURIComponent and form encoding (space as +), percent escapes in either case;
//   - base64 and base64url, for values of 8+ characters, escaped-or-not like the value: of the whole value, and
//     the three alignment-independent runs a base64 text carries when the value sits anywhere inside what was
//     encoded (`user:<secret>` in a Basic auth header), so at most the characters of two bytes at either edge of
//     the value remain.
//
// Longer alternatives come first, so a value that contains another is replaced whole. Not covered: other
// encodings (hex, gzip, encryption), and a value split across two writes of a stream.
const MIN_LINE_REDACT = 8;
const MIN_BASE64_REDACT = 8;
const SHORT_ESCAPES: Record<number, string> = { 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r" };
/** inspect's continuation between the lines of a split multi-line string: `' +\n    '`. */
const INSPECT_CONTINUATION = "(?:['\"`] \\+\\r?\\n[ \\t]*['\"`])?";

/** A hex number as a regex matching it in either case, `[aA]` style. */
function hexPattern(n: number, width: number): string {
  return n.toString(16).padStart(width, "0").replace(/[a-f]/g, (c) => `[${c}${c.toUpperCase()}]`);
}

// Escape runs are bounded (three levels of JSON escaping: 7 backslashes before a character, 8 per backslash), so
// a text with a long run of backslashes costs a bounded amount of backtracking per position.
const ESCAPES_MAX = 8;
const ESC = `\\\\{1,${ESCAPES_MAX}}`;
const OPT_ESC = `\\\\{0,${ESCAPES_MAX}}`;

/** One UTF-16 code unit of a value (not a backslash): itself, or any escaped rendering of it. */
function charPattern(code: number): string {
  const ch = String.fromCharCode(code);
  if (/[A-Za-z0-9]/.test(ch)) return ch;
  const u = `${ESC}u${hexPattern(code, 4)}`;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
    const short = SHORT_ESCAPES[code];
    const alt = `(?:\\x${code.toString(16).padStart(2, "0")}|${short ? `${ESC}${short}|` : ""}${ESC}x${hexPattern(code, 2)}|${u})`;
    return code === 10 ? `${alt}${INSPECT_CONTINUATION}` : alt;
  }
  if (code >= 0x80) return `(?:\\u${code.toString(16).padStart(4, "0")}|${u})`;
  return `(?:${OPT_ESC}\\${ch}|${u})`;                         // punctuation, optionally backslash-escaped
}

function escapedPattern(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) !== 0x5c) {
      out += charPattern(value.charCodeAt(i));
      continue;
    }
    // A run of k backslashes, however many times escaped: k to 8k of them.
    let k = 1;
    while (value.charCodeAt(i + k) === 0x5c) k++;
    out += `\\\\{${k},${k * ESCAPES_MAX}}`;
    i += k - 1;
  }
  return out;
}

/** A URL encoding with its %HH escapes in either case. */
function percentPattern(encoded: string): string {
  return encoded.split(/(%[0-9A-F]{2})/).map((part, i) => (i % 2 ? `%${hexPattern(parseInt(part.slice(1), 16), 2)}` : escapeRegExp(part))).join("");
}

/** base64 and base64url texts that reveal `value` wherever it sits inside the encoded bytes. */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const out = [bytes.toString("base64")];
  for (let skip = 0; skip < 3; skip++) {
    const whole = Math.floor((bytes.length - skip) / 3) * 3;
    if (whole > 0) out.push(bytes.subarray(skip, skip + whole).toString("base64"));
  }
  return out.flatMap((b) => [b, b.replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_")])
    .filter((b) => b.length >= MIN_BASE64_REDACT);
}

/** One alternative: its regex source and the length of the shortest text it matches (for longest-first order). */
type Alternative = { source: string; min: number };
/** One value's alternatives, and literal strings at least one of which is in any text they match (null: none is
 *  known, so the value is always tried). */
type ValueForms = { name: string; alternatives: Alternative[]; anchors: string[] | null };

/** The longest run of ASCII letters and digits, which every rendering above keeps as is (3+ characters). */
function literalRun(s: string): string | null {
  let best = "";
  for (const run of s.match(/[A-Za-z0-9]+/g) ?? []) if (run.length > best.length) best = run;
  return best.length >= 3 ? best : null;
}

/** The renderings of one value (see above). */
function valueForms(name: string, value: string): ValueForms {
  const alternatives: Alternative[] = [{ source: escapedPattern(value), min: value.length }];
  const anchors: (string | null)[] = [literalRun(value)];        // also inside its URL encodings
  if (/[\r\n]/.test(value)) {
    for (const line of value.split(/\r\n|\r|\n/)) {
      const t = line.trim();
      if (t.length < MIN_LINE_REDACT) continue;
      alternatives.push({ source: escapedPattern(t), min: t.length });
      anchors.push(literalRun(t));
    }
  }
  for (const encoded of [encodeURIComponent(value), new URLSearchParams([["", value]]).toString().slice(1)]) {
    if (encoded !== value) alternatives.push({ source: percentPattern(encoded), min: encoded.length });
  }
  if (value.length >= MIN_BASE64_REDACT) {
    // Escaped like any text: an API echoing a Basic auth header through json_encode writes its "/" as "\/".
    for (const b of base64Forms(value)) {
      alternatives.push({ source: escapedPattern(b), min: b.length });
      anchors.push(literalRun(b));
    }
  }
  return { name, alternatives, anchors: anchors.every((a) => a !== null) ? [...new Set(anchors as string[])] : null };
}

/** Texts at least this long first look for the values' anchors, and run a pattern over only the values found. */
const PREFILTER_FROM = 16 * 1024;
const MAX_SUBSETS = 32;

type Compiled = { re: RegExp; names: string[] };

/** Every rendering of a set of values as one regular expression (a capture group per alternative, longest first). */
class Redaction {
  readonly #values: ValueForms[];
  readonly #all: Compiled;
  readonly #subsets = new Map<string, Compiled>();

  private constructor(values: ValueForms[]) {
    this.#values = values;
    this.#all = Redaction.#compile(values);
  }

  static build(entries: Iterable<[string, string]>): Redaction | null {
    const values: ValueForms[] = [];
    const seen = new Set<string>();
    for (const [name, value] of entries) {
      const forms = valueForms(name, value);
      // The first name for a rendering wins.
      forms.alternatives = forms.alternatives.filter((a) => !seen.has(a.source) && seen.add(a.source));
      if (forms.alternatives.length) values.push(forms);
    }
    return values.length ? new Redaction(values) : null;
  }

  static #compile(values: ValueForms[]): Compiled {
    const all = values.flatMap((v) => v.alternatives.map((a) => ({ ...a, name: v.name })));
    all.sort((a, b) => b.min - a.min);
    return { re: new RegExp(all.map((a) => `(${a.source})`).join("|"), "g"), names: all.map((a) => a.name) };
  }

  apply(text: string): string {
    if (!text) return text;
    let compiled = this.#all;
    if (text.length >= PREFILTER_FROM) {
      // A long text (a big log, a large object printed) costs a scan per anchor instead of the whole pattern.
      const found: number[] = [];
      this.#values.forEach((v, i) => {
        if (!v.anchors || v.anchors.some((a) => text.includes(a))) found.push(i);
      });
      if (found.length === 0) return text;
      if (found.length < this.#values.length) {
        const key = found.join(",");
        let subset = this.#subsets.get(key);
        if (!subset) {
          if (this.#subsets.size >= MAX_SUBSETS) this.#subsets.clear();
          subset = Redaction.#compile(found.map((i) => this.#values[i]!));
          this.#subsets.set(key, subset);
        }
        compiled = subset;
      }
    }
    const { re, names } = compiled;
    return text.replace(re, (match: string, ...groups: unknown[]) => {
      for (let i = 0; i < names.length; i++) if (groups[i] !== undefined) return `[redacted:${names[i]}]`;
      return match;
    });
  }
}

function buildPattern(entries: Iterable<[string, string]>): Pattern | null {
  return Redaction.build(entries);
}

function replaceWith(pattern: Pattern | null, text: string): string {
  return pattern ? pattern.apply(text) : text;
}

/** SECRET_MISSING for a declared name nothing sets. With a secretsFrom command, it ran and did not print the name. */
export function missingSecret(name: string, asset?: string, secretsFrom?: SecretsFrom | null): CroftError {
  if (secretsFrom) {
    const command = commandText(secretsFrom.command);
    return new CroftError("SECRET_MISSING", {
      message: `secret ${name} is not set${asset ? ` (used by ${asset})` : ""}: not in the environment, not in .env, and not printed by the secretsFrom command (${command})`,
      hint: `add ${name} to the store the secretsFrom command reads, or ${name}=... to .env (or run \`croft secrets set ${name}\` in your terminal)`,
      ...(asset ? { asset } : {}),
      fix: { kind: "manual", description: `ask the user to add ${name} to the secrets the secretsFrom command prints, or ${name}=... to .env`, requiresHuman: true },
      details: { name, command: [...secretsFrom.command] },
    });
  }
  return new CroftError("SECRET_MISSING", {
    message: `secret ${name} is not set${asset ? ` (used by ${asset})` : ""}`,
    hint: `add ${name}=... to .env (or run \`croft secrets set ${name}\` in your terminal)`,
    ...(asset ? { asset } : {}),
    fix: { kind: "manual", description: `ask the user to add ${name}=... to .env`, requiresHuman: true },
    details: { name },
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

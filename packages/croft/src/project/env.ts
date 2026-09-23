// Secrets from <root>/.env (DESIGN.md §9.8). Bun's own .env loading is off (`bun --no-env-file`):
// it depends on the working directory and silently prefers .env.local. croft parses .env itself,
// the shell environment wins over it, only declared names reach asset code, and every .env value
// is redacted from messages and logs. Command data (query rows) is redacted more narrowly: see redactsInData.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";

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

export type SecretSource = ".env" | "env";
export interface SecretStatus { name: string; status: "set" | "missing"; source: SecretSource | null; usedBy: string[] }

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

type Pattern = { re: RegExp; names: Map<string, string> };

/** The project's secrets: <root>/.env overlaid by the shell environment. Values are held in private
 *  fields so logging or serializing this object never prints them. */
export class ProjectEnv {
  readonly root: string | null;
  readonly ignoredFiles: string[];
  readonly issues: DotenvIssue[];
  readonly #file: Map<string, string>;
  readonly #shell: Record<string, string | undefined>;
  readonly #extra = new Map<string, string>();           // shell values handed out by secret()
  readonly #declared = new Set<string>();                // names assets list in `secrets`
  #pattern: Pattern | null = null;
  #dataPattern: Pattern | null | undefined;

  constructor(opts: { root: string | null; fileValues?: Map<string, string>; shell?: Record<string, string | undefined>;
    ignoredFiles?: string[]; issues?: DotenvIssue[] }) {
    this.root = opts.root;
    this.#file = opts.fileValues ?? new Map();
    this.#shell = opts.shell ?? {};
    this.ignoredFiles = opts.ignoredFiles ?? [];
    this.issues = opts.issues ?? [];
  }

  /** Read <root>/.env (a missing file is fine) and note .env.local and .env.* files croft ignores. */
  static load(root: string | null, shell: Record<string, string | undefined> = process.env): ProjectEnv {
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
    return new ProjectEnv({ root, fileValues: values, shell, ignoredFiles, issues });
  }

  /** A value and where it came from. A non-empty shell variable wins over .env; an empty one does
   *  not, because CI systems export missing secrets as "". */
  lookup(name: string): { value: string; source: SecretSource } | null {
    const shell = this.#shell[name];
    if (shell !== undefined && shell !== "") return { value: shell, source: "env" };
    const file = this.#file.get(name);
    if (file !== undefined && file !== "") return { value: file, source: ".env" };
    return null;
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
    const found = this.lookup(name);
    if (!found) throw missingSecret(name, asset);
    if (found.source === "env") this.#remember(name, found.value);
    return found.value;
  }

  /** `croft secrets --json`: every declared name, whether it is set, where from, and who uses it. */
  listSecrets(declaredByAsset: Record<string, readonly string[]>): SecretStatus[] {
    const usedBy = new Map<string, Set<string>>();
    for (const [asset, names] of Object.entries(declaredByAsset)) {
      for (const name of names) {
        if (!usedBy.has(name)) usedBy.set(name, new Set());
        usedBy.get(name)!.add(asset);
      }
    }
    return [...usedBy.keys()].sort().map((name) => {
      const found = this.lookup(name);
      return { name, status: found ? "set" : "missing", source: found?.source ?? null, usedBy: [...usedBy.get(name)!].sort() };
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

  /** Mark names as declared secrets (an asset's `secrets` list): redactData() then always hides their values.
   *  secret() declares the calling asset's list; commands that show data should declare the project's. */
  declare(names: Iterable<string>): void {
    for (const name of names) {
      if (this.#declared.has(name)) continue;
      this.#declared.add(name);
      this.#dataPattern = undefined;
    }
  }

  /** Replace every .env value (and every shell value handed out by secret()) of 4+ characters
   *  with [redacted:NAME]. Longer values are replaced first so overlapping values stay hidden.
   *  For free text: messages, hints, logs. */
  redact(text: string): string {
    return replaceWith(this.#compile(), text);
  }

  /** Redaction for command data (query rows, samples): see redactsInData. Shell values handed out by
   *  secret() count as declared. */
  redactData(text: string): string {
    if (this.#dataPattern === undefined) {
      const entries = [...this.#file].filter(([name, value]) => redactsInData(value, this.#declared.has(name)));
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

  toJSON(): { root: string | null; names: string[]; ignoredFiles: string[] } {
    return { root: this.root, names: [...this.#file.keys()].sort(), ignoredFiles: this.ignoredFiles };
  }

  #remember(name: string, value: string): void {
    if (this.#extra.get(name) === value) return;
    this.#extra.set(name, value);
    this.#pattern = null;
    this.#dataPattern = undefined;
  }

  #compile(): Pattern | null {
    this.#pattern ??= buildPattern([...this.#file, ...this.#extra].filter(([, value]) => value.length >= MIN_REDACT));
    return this.#pattern;
  }
}

/** One regular expression over the values and their URL-encoded forms, longest first. */
function buildPattern(entries: Iterable<[string, string]>): Pattern | null {
  const names = new Map<string, string>();
  for (const [name, value] of entries) {
    for (const form of new Set([value, encodeURIComponent(value)])) if (!names.has(form)) names.set(form, name);
  }
  if (names.size === 0) return null;
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return { re: new RegExp(alternatives.join("|"), "g"), names };
}

function replaceWith(pattern: Pattern | null, text: string): string {
  if (!pattern || !text) return text;
  return text.replace(pattern.re, (match) => `[redacted:${pattern.names.get(match)}]`);
}

export function missingSecret(name: string, asset?: string): CroftError {
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

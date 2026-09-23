// Output: the --json envelope (DESIGN.md §4.3) and the human helpers (§4.2). In JSON mode stdout
// carries exactly one envelope and everything else goes to stderr. Human output is truncated by
// default (50 rows, 80-character values) with a note on how to see more (§9.6).
import type { Confirmation, Envelope, Fix, Problem } from "../core/types.ts";
import { CROFT_VERSION } from "./version.ts";

export interface Next { command: string; reason: string }

export interface EnvelopeInit<T> {
  command: string;
  data: T;
  problems?: Problem[];
  next?: Next[];
  confirmation?: Confirmation;
  ok?: boolean;                      // default: no error-severity problem
  database: string;
  timezone: string;
  durationMs: number;
}

/** Build an envelope with the contract's key order. */
export function buildEnvelope<T>(init: EnvelopeInit<T>): Envelope<T> {
  const problems = init.problems ?? [];
  const env: Envelope<T> = {
    schemaVersion: 1,
    ok: init.ok ?? !problems.some((p) => p.severity === "error"),
    command: init.command,
    croftVersion: CROFT_VERSION,
    database: init.database,
    timezone: init.timezone,
    durationMs: Math.max(0, Math.round(init.durationMs)),
    data: init.data,
    problems,
    next: init.next ?? [],
  };
  if (init.confirmation) env.confirmation = init.confirmation;
  return env;
}

type Redact = (text: string) => string;

/** Redact every free-text string in an envelope. Structural fields (severity, code, docs, fix.kind,
 *  the envelope header, confirmation token) are croft's own constants and are left alone, so a .env
 *  value like "info" or "true" can never break the contract. */
export function redactEnvelope<T>(env: Envelope<T>, redact: Redact): Envelope<T> {
  const out: Envelope<T> = {
    ...env,
    data: redactStrings(env.data, redact),
    problems: env.problems.map((p) => redactProblem(p, redact)),
    next: env.next.map((n) => ({ command: redact(n.command), reason: redact(n.reason) })),
  };
  if (env.confirmation) {
    out.confirmation = { ...env.confirmation, command: redact(env.confirmation.command), impact: redactStrings(env.confirmation.impact, redact) };
  }
  return out;
}

export function redactProblem(p: Problem, redact: Redact): Problem {
  const { severity, code, docs, fix, ...rest } = p;
  const out = { severity, code, ...redactStrings(rest, redact), docs } as Problem;
  if (fix) {
    const { kind, ...fixRest } = fix;
    out.fix = { kind, ...redactStrings(fixRest, redact) } as Fix;
  }
  // Keep the documented key order: severity, code, message, hint, docs, then the optional fields.
  return orderProblem(out);
}

function orderProblem(p: Problem): Problem {
  const { severity, code, message, hint, docs, ...rest } = p;
  return { severity, code, message, hint, docs, ...rest };
}

/** Apply `redact` to every string in a JSON-like value; keys and non-strings are kept. */
export function redactStrings<T>(value: T, redact: Redact): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

/** One line of JSON. bigints become numbers when safe and strings otherwise (§4.3). */
export function toJsonLine(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v) + "\n";
}

// ---------------------------------------------------------------------------------------------
// Colors

export interface Styles {
  bold(s: string): string; dim(s: string): string; red(s: string): string;
  yellow(s: string): string; green(s: string): string; cyan(s: string): string;
}

const sgr = (on: number, off: number) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;
const COLORED: Styles = { bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), yellow: sgr(33, 39), green: sgr(32, 39), cyan: sgr(36, 39) };
const id = (s: string) => s;
const PLAIN: Styles = { bold: id, dim: id, red: id, yellow: id, green: id, cyan: id };

export function styles(color: boolean): Styles {
  return color ? COLORED : PLAIN;
}

/** Colors only on a TTY and only when NO_COLOR is unset or empty (no-color.org). */
export function useColor(isTTY: boolean, env: Record<string, string | undefined>): boolean {
  return isTTY && !env.NO_COLOR;
}

// ---------------------------------------------------------------------------------------------
// The per-invocation writer

export interface RenderOptions {
  json: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdoutTTY: boolean;
  stderrTTY: boolean;
  env: Record<string, string | undefined>;
}

export class Render {
  readonly json: boolean;
  readonly color: boolean;           // for stdout
  readonly errColor: boolean;        // for stderr
  /** Set once the project's .env is known; applied to every free-text line written. */
  redact: Redact = id;
  #stdout: (text: string) => void;
  #stderr: (text: string) => void;
  #envelopes = 0;

  constructor(o: RenderOptions) {
    this.json = o.json;
    this.color = useColor(o.stdoutTTY, o.env);
    this.errColor = useColor(o.stderrTTY, o.env);
    this.#stdout = o.stdout;
    this.#stderr = o.stderr;
  }

  get style(): Styles { return styles(this.color); }
  get errStyle(): Styles { return styles(this.errColor); }

  /** Human output. In JSON mode it goes to stderr so stdout stays a single envelope. */
  out(text: string): void {
    (this.json ? this.#stderr : this.#stdout)(line(this.redact(text)));
  }

  /** Progress and logs: always stderr. */
  progress(text: string): void {
    this.#stderr(line(this.redact(text)));
  }

  err(text: string): void {
    this.#stderr(line(this.redact(text)));
  }

  /** Text already built from redacted data (labels like "info" must not pass through redact). */
  outRaw(text: string): void {
    if (text) (this.json ? this.#stderr : this.#stdout)(line(text));
  }

  errRaw(text: string): void {
    if (text) this.#stderr(line(text));
  }

  /** The one envelope of a JSON-mode invocation. The caller redacts it first. */
  envelope(env: Envelope<unknown>): void {
    if (this.#envelopes++ > 0) throw new Error("croft bug: a second envelope was written to stdout");
    this.#stdout(toJsonLine(env));
  }
}

function line(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

// ---------------------------------------------------------------------------------------------
// Tables

export const ROW_LIMIT = 50;
export const VALUE_WIDTH = 80;

export interface TableOptions {
  limit?: number;                    // rows shown; default 50 (Infinity for none)
  maxWidth?: number;                 // display width per value; default 80
  total?: number;                    // rows that exist when the caller already capped them
  moreRows?: string;                 // how to see more rows; default "--limit N"
  moreValues?: string;               // how to see whole values; default "--full-values"
  indent?: string;
  gap?: number;                      // spaces between columns; default 3
  color?: boolean;                   // bold header
}

export interface Table { text: string; shownRows: number; hiddenRows: number; truncatedValues: number }

/** An aligned table. Values are cut to 80 characters and rows to 50, with notes on how to see more. */
export function table(header: readonly string[], rows: readonly (readonly unknown[])[], o: TableOptions = {}): Table {
  const limit = o.limit ?? ROW_LIMIT;
  const maxWidth = o.maxWidth ?? VALUE_WIDTH;
  const gap = " ".repeat(o.gap ?? 3);
  const indent = o.indent ?? "";
  const shown = rows.slice(0, limit);
  let truncatedValues = 0;
  const cells = shown.map((row) => header.map((_, i) => {
    const { text, cut } = truncate(cellText(row[i]), maxWidth);
    if (cut) truncatedValues++;
    return text;
  }));
  const widths = header.map((h, i) => Math.max(width(h), ...cells.map((r) => width(r[i]!))));
  const render = (r: readonly string[], head = false) => {
    const text = r.map((c, i) => (i === r.length - 1 ? c : c + " ".repeat(widths[i]! - width(c)) + gap)).join("").trimEnd();
    return indent + (head && o.color ? styles(true).bold(text) : text);
  };
  const lines = [render(header, true), ...cells.map((r) => render(r))];
  const total = Math.max(o.total ?? rows.length, rows.length);
  const hiddenRows = total - shown.length;
  if (hiddenRows > 0) {
    lines.push(`${indent}(${formatCount(shown.length)} of ${formatCount(total)} rows shown; ${o.moreRows ?? "--limit N"} shows more)`);
  }
  if (truncatedValues > 0) {
    lines.push(`${indent}(values cut to ${maxWidth} characters; ${o.moreValues ?? "--full-values"} shows them whole)`);
  }
  return { text: lines.join("\n"), shownRows: shown.length, hiddenRows, truncatedValues };
}

/** A table from objects, with columns in first-seen order unless given. */
export function tableFromObjects(rows: readonly Record<string, unknown>[], columns?: readonly string[], o: TableOptions = {}): Table {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return table(cols, rows.map((r) => cols.map((c) => r[c])), o);
}

/** How a value shows in a table cell: one line, no control characters. */
export function cellText(v: unknown): string {
  if (v === null) return "NULL";
  if (v === undefined) return "";
  if (typeof v === "string") return v.replace(/[\r\n\t]/g, (c) => (c === "\n" ? "\\n" : c === "\r" ? "\\r" : " "));
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
  try {
    return toJsonLine(v).trimEnd();
  } catch {
    return String(v);
  }
}

/** Cut a value to a display width, ending in "…" when cut. */
export function truncate(text: string, max = VALUE_WIDTH): { text: string; cut: boolean } {
  if (width(text) <= max) return { text, cut: false };
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = width(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return { text: out + "…", cut: true };
}

/** Display width in a terminal (wide CJK and emoji count as 2; ANSI escapes as 0). */
export function width(text: string): number {
  return Bun.stringWidth(text);
}

// ---------------------------------------------------------------------------------------------
// Problems

const LABEL: Record<Problem["severity"], string> = { error: "error", warning: "warn", info: "info" };
const INDENT = "      ";

/** A problem block in the §4.2 style:
 *    error UNKNOWN_COLUMN  assets/open_issues.sql:9:3
 *          Referenced column "creatd_at" not found in github_issues.
 *          fix: replace creatd_at with created_at on line 9 */
export function formatProblem(p: Problem, color = false): string {
  const s = styles(color);
  const paint = p.severity === "error" ? s.red : p.severity === "warning" ? s.yellow : s.cyan;
  const label = paint(LABEL[p.severity].padEnd(5));
  const where = location(p);
  const messageLines = p.message.split("\n");
  const head = `${label} ${s.bold(p.code)}  ${where ?? messageLines.shift() ?? ""}`.trimEnd();
  const body = [...messageLines];
  // A hint that says more than the fix command ("did you mean --list?") is shown above it.
  if (p.fix?.kind === "command" && p.hint && !p.hint.includes(p.fix.command)) body.push(`hint: ${p.hint}`);
  const fix = fixLine(p);
  if (fix) body.push(fix);
  if (p.effect) body.push(`effect: ${p.effect}`);
  return [head, ...body.flatMap((l) => l.split("\n")).map((l) => INDENT + l)].join("\n");
}

function location(p: Problem): string | undefined {
  if (p.file) return [p.file, p.line, p.line !== undefined ? p.column : undefined].filter((x) => x !== undefined).join(":");
  return p.asset;
}

function fixLine(p: Problem): string | undefined {
  const f = p.fix;
  if (f?.kind === "edit" && f.replace) {
    const where = f.line !== undefined ? ` on line ${f.line}` : "";
    const file = f.file && f.file !== p.file ? ` of ${f.file}` : "";
    return `fix: replace ${f.replace.from} with ${f.replace.to}${where}${file}`;
  }
  if (f?.kind === "command") {
    return `${p.severity === "info" ? "next" : "fix"}: ${f.command}${f.requiresHuman ? " (ask the user to run it in their terminal)" : ""}`;
  }
  if (f) return `fix: ${p.hint || f.description}`;
  return p.hint ? `hint: ${p.hint}` : undefined;
}

export function formatProblems(problems: readonly Problem[], color = false): string {
  return problems.map((p) => formatProblem(p, color)).join("\n");
}

/** "1 error, 0 warnings, 1 info" (info only when there is some). */
export function problemSummary(problems: readonly Problem[]): string {
  const count = (sev: Problem["severity"]) => problems.filter((p) => p.severity === sev).length;
  const e = count("error"), w = count("warning"), i = count("info");
  const parts = [`${e} ${e === 1 ? "error" : "errors"}`, `${w} ${w === 1 ? "warning" : "warnings"}`];
  if (i > 0) parts.push(`${i} info`);
  return parts.join(", ");
}

/** `next:` lines; the reason is a shell comment so the line stays copy-pasteable. */
export function formatNext(next: readonly Next[], color = false): string {
  const s = styles(color);
  return next.map((n) => `next: ${n.command}${n.reason ? s.dim(`  # ${n.reason}`) : ""}`).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Numbers and durations

export function formatCount(n: number | bigint): string {
  return typeof n === "bigint" ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** 9 ms · 41.2 s · 3 min 20 s · 2 h 5 min */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60), s = totalSeconds % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  const h = Math.floor(totalMinutes / 60), m = totalMinutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Where asset code's console output goes (DESIGN.md §4 "Conventions": --json prints exactly one envelope to
// stdout; §4.1 `croft logs`: the console output of a step; §9.6: .env values are redacted from logs).
//
// Asset code runs inside croft's own process: its module is imported by every command that loads assets
// (run, query, describe, context, secrets), and rows()/map() run inside `croft run`. Its console.log would land
// on croft's stdout, before the one --json envelope, with any secret it printed unredacted. So once croft loads
// asset code, the guard below is installed:
//
//   - rows()/map() run inside captureOutput(sink): an AsyncLocalStorage scope, so concurrent steps each write
//     to their own step log, including from callbacks and timers they start;
//   - an asset module is imported inside captureImport(sink): top-level code does not inherit an
//     AsyncLocalStorage scope in Bun, so the sink is process-wide for the duration of the import (croft imports
//     one asset at a time); a run collects it for the step log, other commands send it to stderr (guardImport);
//   - console.* outside any scope (a callback that lost its scope) goes to stderr, redacted with the last
//     redactor set: never stdout, which only croft's own renderer writes;
//   - process.stdout.write and process.stderr.write inside a scope go to its sink; outside they are untouched,
//     because croft writes its envelope with process.stdout.write.
import { AsyncLocalStorage } from "node:async_hooks";
import { formatWithOptions, inspect, type InspectOptions } from "node:util";

export interface OutputSink {
  /** One console call's text (no trailing newline), or a chunk written to process.stdout/stderr. */
  write(text: string): void;
}

const scope = new AsyncLocalStorage<OutputSink>();
const importSinks: OutputSink[] = [];
let redactFallback: (text: string) => string = (t) => t;
let redactorSet = false;
let installed = false;

type Write = typeof process.stdout.write;
let originalStderrWrite: Write | null = null;

/** The sink the current code writes to, if any. */
export function currentSink(): OutputSink | undefined {
  return scope.getStore() ?? importSinks.at(-1);
}

/** Redaction for console output that reaches stderr outside any scope (a run sets the project's). */
export function setOutputRedactor(redact: (text: string) => string): void {
  redactFallback = redact;
  redactorSet = true;
}

/** setOutputRedactor unless one is set already; `make` runs only when something is printed. */
export function defaultOutputRedactor(make: () => (text: string) => string): void {
  if (redactorSet) return;
  let r: ((text: string) => string) | undefined;
  setOutputRedactor((text) => (r ??= make())(text));
}

/** Write a line to the real stderr, redacted, whatever scope is active (never back into a sink). */
export function writeStderr(text: string): void {
  const line = redactFallback(text);
  const write = originalStderrWrite ?? process.stderr.write.bind(process.stderr);
  write.call(process.stderr, line.endsWith("\n") ? line : `${line}\n`);
}

function emit(text: string): void {
  const sink = currentSink();
  if (sink) sink.write(text);
  else writeStderr(text);
}

const format = (args: unknown[]) => formatWithOptions({ colors: false, depth: 4 }, ...args);

function chunkText(chunk: unknown, encoding?: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  return String(chunk);
}

function patchStream(stream: NodeJS.WriteStream): Write {
  const original = stream.write;
  const patched = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
    const sink = currentSink();
    if (!sink) return (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
    sink.write(chunkText(chunk, rest[0]).replace(/\n$/, ""));
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    if (cb) queueMicrotask(cb);
    return true;
  };
  stream.write = patched as Write;
  return original;
}

/** Route console.* (always) and process.stdout/stderr writes (inside a scope) as described above. Idempotent. */
export function installOutputGuard(): void {
  if (installed) return;
  installed = true;
  const c = console as unknown as Record<string, unknown>;
  for (const name of ["log", "info", "debug", "warn", "error", "dirxml"]) c[name] = (...args: unknown[]) => emit(format(args));
  c.trace = (...args: unknown[]) => {
    const stack = (new Error().stack ?? "").split("\n").slice(2).join("\n");
    emit(`Trace${args.length ? `: ${format(args)}` : ""}\n${stack}`);
  };
  c.dir = (obj: unknown, options?: InspectOptions) => emit(inspect(obj, { depth: 4, ...options, colors: false }));
  c.table = (data: unknown) => emit(format([data]));
  c.assert = (ok: unknown, ...args: unknown[]) => {
    if (!ok) emit(`Assertion failed${args.length ? `: ${format(args)}` : ""}`);
  };
  const counts = new Map<string, number>();
  c.count = (label = "default") => {
    const n = (counts.get(String(label)) ?? 0) + 1;
    counts.set(String(label), n);
    emit(`${String(label)}: ${n}`);
  };
  c.countReset = (label = "default") => void counts.delete(String(label));
  const timers = new Map<string, number>();
  c.time = (label = "default") => void timers.set(String(label), performance.now());
  const elapsed = (label: string) => {
    const t = timers.get(label);
    return t === undefined ? `${label}: no such timer` : `${label}: ${(performance.now() - t).toFixed(3)}ms`;
  };
  c.timeLog = (label = "default", ...args: unknown[]) => emit([elapsed(String(label)), args.length ? format(args) : ""].filter(Boolean).join(" "));
  c.timeEnd = (label = "default") => {
    emit(elapsed(String(label)));
    timers.delete(String(label));
  };
  c.group = (...args: unknown[]) => {
    if (args.length) emit(format(args));
  };
  c.groupCollapsed = c.group;
  c.groupEnd = () => {};
  patchStream(process.stdout);
  originalStderrWrite = patchStream(process.stderr);
}

/** Run asset code (rows(), map()) with its console output going to `sink`, however deep its async work goes. */
export function captureOutput<T>(sink: OutputSink, fn: () => T): T {
  installOutputGuard();
  return scope.run(sink, fn);
}

/**
 * Run croft's own code outside any capture, so what it writes goes where croft sends it: progress events are
 * emitted from inside a step's scope (a request completing inside rows()), yet belong on stderr (--events), not
 * in the step log. The scope stays off for async work fn starts; import sinks are hidden only while fn runs.
 */
export function outsideCapture<T>(fn: () => T): T {
  if (!installed) return fn();
  const hidden = importSinks.splice(0);
  try {
    return scope.exit(fn);
  } finally {
    importSinks.unshift(...hidden);
  }
}

/** Import asset code with its top-level console output going to `sink` until the import settles. */
export async function captureImport<T>(sink: OutputSink, fn: () => Promise<T>): Promise<T> {
  installOutputGuard();
  importSinks.push(sink);
  try {
    return await fn();
  } finally {
    const i = importSinks.lastIndexOf(sink);
    if (i >= 0) importSinks.splice(i, 1);
  }
}

/**
 * An asset import in any command: inside a capture (a run's plan, which keeps the output for the step log) it
 * goes there; otherwise to stderr, prefixed with the file and redacted, so a --json stdout stays one envelope.
 */
export async function guardImport<T>(file: string, redact: () => (text: string) => string, fn: () => Promise<T>): Promise<T> {
  installOutputGuard();
  if (currentSink()) return fn();
  let r: ((text: string) => string) | undefined;
  // Output that escapes the import (a timer its top-level code started) is redacted the same way.
  defaultOutputRedactor(() => (r ??= redact()));
  return captureImport({
    write: (text) => {
      r ??= redact();
      writeStderr(r(text.split("\n").map((l) => `${file}: ${l}`).join("\n")));
    },
  }, fn);
}

/** A sink that collects lines (a run's plan keeps each asset's import output for its step log). */
export function collectingSink(): OutputSink & { lines: string[] } {
  const lines: string[] = [];
  return { lines, write: (text) => void lines.push(text) };
}

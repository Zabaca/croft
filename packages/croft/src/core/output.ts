// Where asset code's output goes (DESIGN.md §4 "Conventions": --json prints exactly one envelope to stdout;
// §4.1 `croft logs`: the console output of a step; §5: output that escapes any scope goes to stderr, redacted;
// §9.6: .env values are redacted from logs).
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
//   - process.stdout.write and process.stderr.write inside a scope go to its sink; outside they are croft's own
//     output (its envelope, progress), written to croft's real stdout and stderr.
//
// Below all of that, file descriptors 1 and 2 themselves are captured while asset code runs, because a
// subprocess (Bun Shell `$`, which prints by default; Bun.spawn or child_process with inherited stdio) and
// Bun.write(Bun.stdout) write to them directly, past console and process.stdout:
//
//   - the first capture duplicates fds 1 and 2 (close-on-exec, so no subprocess inherits croft's real stdout)
//     and points fds 1 and 2 at an unlinked temporary file (dup2 through bun:ffi; Bun has no dup2 of its own);
//     a file, not a pipe, because croft reads it on its own thread: a write to it can never block;
//   - what lands there is read back every 50 ms, when a capture ends and at exit, in whole lines, and goes to the
//     sink of the asset code running at the time (the step log, which redacts it) when exactly one is running;
//     with several (concurrent steps) or none it goes to croft's real stderr, redacted;
//   - croft's own writes (process.stdout/stderr.write outside a sink, writeStderr) go to the duplicates, so the
//     --json envelope is the only thing on stdout;
//   - in a library or test process fds 1 and 2 are restored when the last capture ends. In croft's own process
//     (bin/croft.mjs, and the detached run's child, run/detach.ts) they stay captured until exit once asset code
//     has run, so a subprocess that outlives its step (started and not awaited) cannot reach stdout either; in
//     the detached child, whose stderr is _process.log, what it prints lands there redacted.
//
// Limits: output that lands while several steps run at once is not attributed to a step (it goes to stderr,
// redacted); a line without a newline is held until one arrives, its step ends or 64 KB accumulate; a native
// crash in the middle of a step can lose what was printed in the last 50 ms; on a platform without dup2
// (Windows) or when bun:ffi cannot load libc, fds are not captured and a subprocess prints where it would have.
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const out = line.endsWith("\n") ? line : `${line}\n`;
  if (fds?.captured) return writeFully(fds.err, out);
  const write = originalStderrWrite ?? process.stderr.write.bind(process.stderr);
  write.call(process.stderr, out);
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

function patchStream(stream: NodeJS.WriteStream, fd: 1 | 2): Write {
  const original = stream.write;
  const patched = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
    const sink = currentSink();
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    if (sink) {
      sink.write(chunkText(chunk, rest[0]).replace(/\n$/, ""));
    } else if (fds?.captured) {
      // croft's own output while fds 1 and 2 are captured: straight to the real stdout or stderr.
      writeFully(fd === 1 ? fds.out : fds.err, typeof chunk === "string" || chunk instanceof Uint8Array ? chunk : chunkText(chunk, rest[0]));
    } else {
      return (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
    }
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
  patchStream(process.stdout, 1);
  originalStderrWrite = patchStream(process.stderr, 2);
}

/** Run asset code (rows(), map()) with its output going to `sink`, however deep its async work goes, and with fds
 *  1 and 2 captured until it settles. */
export function captureOutput<T>(sink: OutputSink, fn: () => T): T {
  installOutputGuard();
  const release = holdFds(sink);
  let result: T;
  try {
    result = scope.run(sink, fn);
  } catch (e) {
    release();
    throw e;
  }
  if (result instanceof Promise) return result.finally(release) as T;
  release();
  return result;
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

/** Import asset code with its top-level output going to `sink` until the import settles. */
export async function captureImport<T>(sink: OutputSink, fn: () => Promise<T>): Promise<T> {
  installOutputGuard();
  importSinks.push(sink);
  const release = holdFds(sink);
  try {
    return await fn();
  } finally {
    release();
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

// ---------------------------------------------------------------------------------------------------------
// Capturing file descriptors 1 and 2 (see the top of this file)

interface Libc {
  dup(fd: number): number;
  dup2(fd: number, to: number): number;
  dup3?(fd: number, to: number, flags: number): number;
}

interface CapturedFds {
  libc: Libc;
  /** croft's real stdout and stderr: close-on-exec duplicates of the fds 1 and 2 croft started with. */
  out: number;
  err: number;
  /** The unlinked file fds 1 and 2 point at while captured. */
  file: number;
  captured: boolean;
  offset: number;
  /** The file's size at the previous pump (unchanged since: nothing is writing). */
  lastSize: number;
  decoder: TextDecoder;
  partial: string;
  timer: ReturnType<typeof setInterval> | null;
}

/** undefined: not set up yet; null: fds cannot be captured here. */
let fds: CapturedFds | null | undefined;
/** Sinks of the asset code running now, in the order it started. */
const holders: OutputSink[] = [];
let keepCaptured = false;

const PUMP_MS = 50;
const MAX_PARTIAL = 64 * 1024;
const TRUNCATE_FROM = 4 * 1024 * 1024;
const LINUX_O_CLOEXEC = 0o2000000;
const CROFT_ENTRIES = ["../../bin/croft.mjs", "../run/detach.ts"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

/**
 * Keep fds 1 and 2 captured from the first asset code until the process exits (croft's own entry points; see
 * the top of this file). In any other process captures end with the last asset code running.
 */
export function keepFdsCaptured(): void {
  keepCaptured = true;
}

/** Whether this process is croft's CLI or its detached child (Bun.main is one of croft's entry points). */
function isCroftProcess(): boolean {
  try {
    const main = realpathSync(Bun.main);
    return CROFT_ENTRIES.some((entry) => {
      try {
        return realpathSync(entry) === main;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function loadLibc(): Libc | null {
  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") return null;
  let ffi: typeof import("bun:ffi");
  try {
    ffi = import.meta.require("bun:ffi") as typeof import("bun:ffi");
  } catch {
    return null;
  }
  const i32 = ffi.FFIType.i32;
  const names = linux ? ["libc.so.6", "libc.so", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"] : ["libc.dylib", "/usr/lib/libSystem.B.dylib"];
  for (const name of names) {
    try {
      const lib = ffi.dlopen(name, {
        dup: { args: [i32], returns: i32 },
        dup2: { args: [i32, i32], returns: i32 },
        ...(linux ? { dup3: { args: [i32, i32, i32], returns: i32 } } : {}),
      });
      return lib.symbols as unknown as Libc;
    } catch { /* the next name */ }
  }
  return null;
}

/** A close-on-exec duplicate of `fd`, so a subprocess of asset code never inherits croft's real stdout. */
function privateDup(libc: Libc, fd: number): number {
  // macOS: opening /dev/fd/N duplicates N (same open file, shared offset), and Bun opens with O_CLOEXEC.
  if (process.platform === "darwin") return openSync(`/dev/fd/${fd}`, constants.O_WRONLY);
  const n = libc.dup(fd);
  if (n < 0) throw new Error(`dup(${fd}) failed`);
  // Linux: dup3 replaces that duplicate with one marked close-on-exec.
  libc.dup3?.(fd, n, LINUX_O_CLOEXEC);
  return n;
}

function setupFds(): CapturedFds | null {
  const libc = loadLibc();
  if (!libc) return null;
  let file = -1;
  const opened: number[] = [];
  try {
    const path = join(tmpdir(), `croft-output-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    file = openSync(path, "a+", 0o600);
    opened.push(file);
    unlinkSync(path);
    const out = privateDup(libc, 1);
    opened.push(out);
    const err = privateDup(libc, 2);
    opened.push(err);
    const f: CapturedFds = { libc, out, err, file, captured: false, offset: 0, lastSize: 0, decoder: new TextDecoder(), partial: "", timer: null };
    keepCaptured ||= isCroftProcess();
    process.on("exit", () => {
      if (f.captured) pump(f, true);
    });
    return f;
  } catch {
    for (const fd of opened) {
      try {
        closeSync(fd);
      } catch { /* already closed */ }
    }
    return null;
  }
}

function startCapture(f: CapturedFds): void {
  if (f.captured) return;
  if (f.libc.dup2(f.file, 1) < 0) return;
  if (f.libc.dup2(f.file, 2) < 0) {
    f.libc.dup2(f.out, 1);
    return;
  }
  f.captured = true;
  // Outside any scope: the timer must not inherit the asset code's sink.
  f.timer = scope.exit(() => setInterval(() => pump(f, false), PUMP_MS));
  f.timer.unref?.();
}

function stopCapture(f: CapturedFds): void {
  if (!f.captured) return;
  pump(f, true);
  f.libc.dup2(f.out, 1);
  f.libc.dup2(f.err, 2);
  f.captured = false;
  if (f.timer) clearInterval(f.timer);
  f.timer = null;
}

/** Hold fds 1 and 2 captured for asset code writing to `sink`; the returned function lets go (once). */
function holdFds(sink: OutputSink): () => void {
  if (fds === undefined) fds = setupFds();
  const f = fds;
  if (!f) return () => {};
  holders.push(sink);
  startCapture(f);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // What this code printed goes to its sink while it is still the one holding, a last partial line too.
    if (f.captured) pump(f, true);
    const i = holders.lastIndexOf(sink);
    if (i >= 0) holders.splice(i, 1);
    if (holders.length === 0 && !keepCaptured) stopCapture(f);
  };
}

/** Read what landed on fds 1 and 2 since the last pump and route it, in whole lines unless `flush`. */
function pump(f: CapturedFds, flush: boolean): void {
  let size: number;
  try {
    size = fstatSync(f.file).size;
  } catch {
    return;
  }
  if (size > f.offset) {
    const buf = Buffer.alloc(Math.min(size - f.offset, 1 << 20));
    while (f.offset < size) {
      const got = readSync(f.file, buf, 0, Math.min(size - f.offset, buf.length), f.offset);
      if (got <= 0) break;
      f.offset += got;
      f.partial += f.decoder.decode(buf.subarray(0, got), { stream: true });
    }
  }
  // The file is unlinked, so nothing else would ever reclaim its space: once a lot of it is read and nothing has
  // been written for a pump interval, start it over. Writers append (O_APPEND is shared by every duplicate), so
  // the next write lands at the new start; only a write in the instant between the check and the truncation
  // could be lost, never leaked.
  const quiet = size === f.lastSize;
  f.lastSize = size;
  if (quiet && f.offset >= TRUNCATE_FROM && f.offset === size) {
    try {
      if (fstatSync(f.file).size === size) {
        ftruncateSync(f.file, 0);
        f.offset = 0;
        f.lastSize = 0;
      }
    } catch { /* keep reading from where it was */ }
  }
  const cut = flush || f.partial.length > MAX_PARTIAL ? f.partial.length : f.partial.lastIndexOf("\n") + 1;
  if (cut <= 0) return;
  const text = f.partial.slice(0, cut).replace(/\n$/, "");
  f.partial = f.partial.slice(cut);
  if (text === "") return;
  const sink = holders.length === 1 ? holders[0]! : undefined;
  try {
    if (sink) sink.write(text);
    else writeStderr(text);
  } catch { /* output must never fail the run */ }
}

/** write(2) all of `data`, waiting out a full non-blocking pipe (Bun makes stdout pipes non-blocking). */
function writeFully(fd: number, data: string | Uint8Array): void {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  let off = 0;
  let waits = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
      waits = 0;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" || ++waits > 60_000) return;   // a reader gone (EPIPE) or stuck for a minute
      Bun.sleepSync(1);
    }
  }
}

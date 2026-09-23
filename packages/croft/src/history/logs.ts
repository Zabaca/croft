// Per-step logs at <stateDir>/logs/<runId>/<asset>.log: the console output and errors of one step,
// read back by `croft logs` (DESIGN.md §4). Writes are synchronous appends, so a line is on disk
// before the step moves on: a crash loses nothing already logged, and `--follow` in another
// process sees each line at once. Every line passes through the caller's redact function, which
// is how `.env` values stay out of logs (§9).
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatWithOptions } from "node:util";
import { CroftError } from "../core/errors.ts";

export type Redact = (text: string) => string;

/** Logs default to the last 200 lines, to protect the agent's context window (§9). */
export const DEFAULT_TAIL_LINES = 200;

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function segment(kind: string, s: string): string {
  // Run ids and asset names are validated elsewhere; this keeps a typo like `../x` out of the path.
  if (!SAFE_SEGMENT.test(s) || s.includes("..")) {
    throw new CroftError("USAGE_ERROR", { message: `not a valid ${kind}: ${JSON.stringify(s)}`, hint: `pass a ${kind} as shown by croft status` });
  }
  return s;
}

export function logDir(stateDir: string, runId: string): string {
  return join(stateDir, "logs", segment("run id", runId));
}

export function logPath(stateDir: string, runId: string, asset: string): string {
  return join(logDir(stateDir, runId), `${segment("asset name", asset)}.log`);
}

export interface LogWriterOptions { redact?: Redact }

/** Appends lines to one step's log. Formats arguments like console.log, without colors. */
export class LogWriter {
  private fd: number | null;
  private readonly redact: Redact;

  constructor(readonly path: string, o: LogWriterOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
    this.redact = o.redact ?? ((s) => s);
  }

  /** `ctx.log(...args)`. */
  log(...args: unknown[]): void {
    this.write(formatWithOptions({ colors: false, depth: 4 }, ...args));
  }

  /** Append text as one or more lines. Redaction runs on the whole text, so a secret that
   *  spans a line break is still caught. A write after close is dropped: a late callback from
   *  asset code must not crash the run. */
  write(text: string): void {
    if (this.fd === null) return;
    const clean = this.redact(text);
    writeSync(this.fd, clean.endsWith("\n") ? clean : `${clean}\n`);
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

export function openLog(stateDir: string, runId: string, asset: string, o: LogWriterOptions = {}): LogWriter {
  return new LogWriter(logPath(stateDir, runId, asset), o);
}

export interface TailResult {
  lines: string[];
  truncated: boolean;   // earlier lines exist
  exists: boolean;
  size: number;         // byte offset of the end of what was read; pass to follow({from}) to continue
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The last `n` lines of a log. Reads backwards in chunks, so a long log costs only what is shown.
 * Splitting on the 0x0A byte is safe for UTF-8, because no multi-byte sequence contains it.
 */
export function tail(path: string, n: number = DEFAULT_TAIL_LINES, o: { redact?: Redact } = {}): TailResult {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { lines: [], truncated: false, exists: false, size: 0 };
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    if (n <= 0 || size === 0) return { lines: [], truncated: size > 0, exists: true, size };
    const CHUNK = 64 * 1024;
    const chunks: Buffer[] = [];
    let pos = size;
    let newlines = 0;
    let start = 0;          // byte offset where the returned text begins
    let found = false;
    // A trailing newline ends the last line rather than starting an empty one, so it is not counted.
    const lastByte = Buffer.alloc(1);
    readSync(fd, lastByte, 0, 1, size - 1);
    const skipFinal = lastByte[0] === 0x0a ? 1 : 0;
    while (pos > 0 && !found) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      chunks.unshift(buf);
      for (let i = len - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a || pos + i === size - skipFinal) continue;
        if (++newlines === n) {
          start = pos + i + 1;
          found = true;
          break;
        }
      }
    }
    const all = Buffer.concat(chunks);
    const text = all.subarray(start - pos).toString("utf8");
    const redact = o.redact ?? ((s: string) => s);
    return { lines: splitLines(redact(text)), truncated: start > 0, exists: true, size };
  } finally {
    closeSync(fd);
  }
}

const READ_CHUNK = 1 << 20;

export interface FollowOptions {
  from?: "start" | "end" | number;          // byte offset; default "start"
  signal?: AbortSignal;                     // stop at once
  until?: () => boolean | Promise<boolean>; // stop once true (e.g. the step finished), after draining
  pollMs?: number;                          // default 100
  redact?: Redact;
}

/**
 * Yield lines as they are appended, like `tail -f`. Waits for the file to appear, survives
 * truncation (starts over), and holds back a partial last line until its newline arrives, or
 * until `until()` says the writer is done.
 */
export async function* follow(path: string, o: FollowOptions = {}): AsyncGenerator<string> {
  const pollMs = o.pollMs ?? 100;
  const redact = o.redact ?? ((s: string) => s);
  const sizeOf = (): number | null => {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  };
  let offset = o.from === "end" ? (sizeOf() ?? 0) : typeof o.from === "number" ? o.from : 0;
  let decoder = new TextDecoder("utf-8");
  let partial = "";

  const readNew = (): string[] => {
    const size = sizeOf();
    if (size === null) return [];
    if (size < offset) {           // shrank (truncated or replaced): start over
      offset = 0;
      partial = "";
      decoder = new TextDecoder("utf-8");
    }
    if (size === offset) return [];
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(Math.min(size - offset, READ_CHUNK));
      while (offset < size) {
        const got = readSync(fd, buf, 0, Math.min(size - offset, buf.length), offset);
        if (got === 0) break;
        offset += got;
        partial += decoder.decode(buf.subarray(0, got), { stream: true });
      }
    } finally {
      closeSync(fd);
    }
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    return lines.map(redact);
  };

  for (;;) {
    if (o.signal?.aborted) return;
    const done = o.until ? await o.until() : false;
    // Read after checking `until`, so lines written just before the writer finished still arrive.
    for (const line of readNew()) yield line;
    if (done) {
      partial += decoder.decode();
      if (partial !== "") yield redact(partial);
      return;
    }
    try {
      await sleep(pollMs, undefined, o.signal ? { signal: o.signal } : undefined);
    } catch {
      return;   // aborted
    }
  }
}

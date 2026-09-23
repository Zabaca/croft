// The extract step of an ingest (DESIGN.md §5 "One ingest step", step 2): rows from the asset's generator
// become NDJSON parts under .croft/staging/<run>/<asset>/, with NO database lock held. manifest.json is
// written last, so a manifest means the extraction completed.
//
// What the writer guarantees, so the write step can trust the files:
// - Canonical JSON. Object keys are sorted at every depth and output is minified, so a re-fetched row whose
//   API reordered keys compares equal and keeps its _loaded_at (JSON IS DISTINCT FROM is text-based [V]).
//   bigint is written as exact digits via JSON.rawJSON and Date as an ISO instant. The serializer is
//   hand-written rather than JSON.stringify over a sorted copy, because JS objects list integer-like keys
//   ("10", "9") before others whatever the insertion order.
// - Loud failures instead of silent JSON.stringify losses: Map/Set become {}, NaN/±Infinity become null,
//   functions and symbols vanish. Those throw UNSERIALIZABLE_VALUE with the row and field, and a row that
//   is not an object throws ROW_NOT_OBJECT.
// - Clean, stable column names (§7 "Column names"), resolved before anything reaches read_json, which
//   matches keys case-sensitively (`ID` loaded NULL into `Id`) and fails on an empty key or on `Id` + `id`
//   in one file [V].
// - Every row carries _croft_seq in yield order: dedupe keeps the last row yielded for a key.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Problem, StageManifest } from "../core/types.ts";
import type { Row, RowSource } from "../types.ts";
import { RESERVED } from "./contract.ts";
import { jsKey } from "./types.ts";

export const PART_ROWS = 50_000;
export const MANIFEST_FILE = "manifest.json";

/**
 * Rows from file ingests carry their source path under this symbol; the writer stores it in the reserved
 * `_file` column. A symbol key never collides with a source field and is skipped by Object.keys.
 */
export const STAGE_FILE: symbol = Symbol.for("croft.stage.file");

/** Source fields that would shadow croft's own columns. */
const RENAMED: Readonly<Record<string, string>> = { [RESERVED.loadedAt]: "_source_loaded_at", [RESERVED.file]: "_source_file" };

// Flush a part's buffer to disk at this size, so memory stays flat for wide rows.
const FLUSH_BYTES = 1 << 20;

// ---------------------------------------------------------------------------------------------------------
// Lossless JSON (ctx.http reuses these)

/**
 * JSON.parse that keeps integers beyond ±2^53 exact as bigint, via the reviver's `context.source` [V].
 * Plain JSON.parse turns 12345678901234567890 into 12345678901234567000.
 */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, losslessReviver as (this: unknown, key: string, value: unknown) => unknown);
}

/** The reviver behind parseJsonLossless, for callers that parse JSON themselves. */
export function losslessReviver(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    const src = context?.source;
    if (src !== undefined && /^-?\d+$/.test(src)) return BigInt(src);
  }
  return value;
}

// JSON.rawJSON (Bun, Node 21+) makes JSON.stringify emit a bigint's digits exactly [V]; TypeScript's lib does
// not declare it yet.
const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

/** A value JSON cannot carry exactly. `path` is a JSONPath-like location inside the field. */
export class UnserializableError extends Error {
  constructor(readonly path: string, readonly type: string) {
    super(`${type} at ${path || "(value)"}`);
    this.name = "UnserializableError";
  }
}

export interface CanonicalOptions {
  /** Called for each JS number that is an integer beyond ±2^53: its digits may already be wrong. */
  onUnsafeInteger?: (path: string, value: number) => void;
}

/**
 * Canonical, minified JSON text: object keys sorted by code unit at every depth, bigint as exact digits,
 * Date as an ISO instant, objects with toJSON() serialized through it. Throws UnserializableError for
 * values JSON.stringify would silently change: Map, Set, typed arrays, functions, symbols, NaN, ±Infinity,
 * invalid dates, strings with unpaired surrogates (DuckDB rejects them [V]) and circular references.
 * `undefined` object properties are omitted and `undefined` array items become null, as in JSON.
 */
export function canonicalJson(value: unknown, o: CanonicalOptions = {}): string {
  return ser(value, { stack: new Set(), path: [], onUnsafeInteger: o.onUnsafeInteger });
}

// The path is kept as segments and joined only for an error or a warning: building a path string for every
// value made serialization several times slower.
interface SerState { stack: Set<object>; path: (string | number)[]; onUnsafeInteger?: (path: string, value: number) => void }

function pathOf(segments: readonly (string | number)[]): string {
  let out = "";
  for (const s of segments) out += typeof s === "number" ? `[${s}]` : out ? `.${s}` : s;
  return out;
}

const fail = (st: SerState, type: string): never => {
  throw new UnserializableError(pathOf(st.path), type);
};

function ser(v: unknown, st: SerState): string {
  switch (typeof v) {
    case "string":
      if (!v.isWellFormed()) fail(st, "string with an unpaired surrogate");
      return JSON.stringify(v);
    case "number":
      if (Number.isNaN(v)) fail(st, "NaN");
      if (!Number.isFinite(v)) fail(st, v > 0 ? "Infinity" : "-Infinity");
      if (st.onUnsafeInteger && Number.isInteger(v) && !Number.isSafeInteger(v)) st.onUnsafeInteger(pathOf(st.path), v);
      return JSON.stringify(v);
    case "bigint":
      return JSON.stringify(rawJSON(v.toString()));
    case "boolean":
      return v ? "true" : "false";
    case "undefined":
      return "null";
    case "function":
    case "symbol":
      return fail(st, typeof v);
  }
  if (v === null) return "null";
  const obj = v as object;
  if (Array.isArray(obj)) return enter(st, obj, serArray);
  const proto = Object.getPrototypeOf(obj);
  // Plain objects (the common case) skip the checks for built-ins below.
  if ((proto === Object.prototype || proto === null) && typeof (obj as { toJSON?: unknown }).toJSON !== "function") {
    return enter(st, obj, serObject);
  }
  const bad = rejectedObject(obj);
  if (bad) fail(st, bad);
  if (obj instanceof Date) {
    if (Number.isNaN(obj.getTime())) fail(st, "Invalid Date");
    return JSON.stringify(obj.toISOString());
  }
  if (obj instanceof Number || obj instanceof String || obj instanceof Boolean || obj instanceof BigInt) return ser(obj.valueOf(), st);
  const toJSON = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return enter(st, obj, () => ser(toJSON.call(obj, ""), st));
  return enter(st, obj, serObject);
}

function enter<T extends object>(st: SerState, obj: T, body: (obj: T, st: SerState) => string): string {
  if (st.stack.has(obj)) fail(st, "circular reference");
  st.stack.add(obj);
  try {
    return body(obj, st);
  } finally {
    st.stack.delete(obj);
  }
}

function serArray(arr: unknown[], st: SerState): string {
  let out = "[";
  for (let i = 0; i < arr.length; i++) {
    st.path.push(i);
    out += (i ? "," : "") + ser(arr[i], st);
    st.path.pop();
  }
  return out + "]";
}

function serObject(obj: object, st: SerState): string {
  const keys = Object.keys(obj).sort();
  let out = "{";
  let first = true;
  for (const k of keys) {
    const item = (obj as Record<string, unknown>)[k];
    if (item === undefined) continue;
    st.path.push(k);
    if (!k.isWellFormed()) fail(st, "key with an unpaired surrogate");
    out += (first ? "" : ",") + JSON.stringify(k) + ":" + ser(item, st);
    st.path.pop();
    first = false;
  }
  return out + "}";
}

/** The type name of an object JSON.stringify would silently turn into {} (or worse); null if fine. */
function rejectedObject(v: object): string | null {
  if (v instanceof Map) return "Map";
  if (v instanceof Set) return "Set";
  if (v instanceof WeakMap) return "WeakMap";
  if (v instanceof WeakSet) return "WeakSet";
  if (ArrayBuffer.isView(v)) return v.constructor?.name ?? "typed array";
  if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer)) return v.constructor.name;
  if (v instanceof RegExp) return "RegExp";
  if (v instanceof Error) return v.constructor?.name ?? "Error";
  if (v instanceof Promise || typeof (v as { then?: unknown }).then === "function") return "Promise (missing await?)";
  if (typeof WeakRef !== "undefined" && v instanceof WeakRef) return "WeakRef";
  return null;
}

/** A short type label for ROW_NOT_OBJECT. */
function typeLabel(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return rejectedObject(v as object) ?? (v instanceof Date ? "Date" : (v as object).constructor?.name ?? "object");
  return typeof v;
}

function isRowObject(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date) && !rejectedObject(v)
    && !(v instanceof Number || v instanceof String || v instanceof Boolean);
}

// ---------------------------------------------------------------------------------------------------------
// Column names (DESIGN.md §7 "Column names")

/**
 * Minimal cleanup: characters other than letters (any script), combining marks, digits and `_` become `_`;
 * runs of `_` collapse; leading and trailing `_` are trimmed; a leading digit gains `col_`; an empty result
 * becomes `col_<position>` (1-based position of the key in its row). Text is NFC-normalized first, so a
 * composed and a decomposed "café" are one column. Case is kept: DuckDB identifiers are case-insensitive.
 */
export function cleanColumnName(raw: string, position: number): string {
  let s = raw.normalize("NFC").replace(/[^\p{L}\p{M}\p{Nd}_]+/gu, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (s === "") return `col_${position}`;
  if (/^\p{Nd}/u.test(s)) s = `col_${s}`;
  return s;
}

export interface KnownName { name: string; sourceName?: string | null }
export interface StagedColumn { name: string; sourceName: string }

/**
 * Resolves raw keys to column names for one batch, the same way for every row:
 * 1. `_loaded_at` / `_file` become `_source_loaded_at` / `_source_file`;
 * 2. a key equal to a stored source_name maps to that stored column;
 * 3. otherwise the cleaned name is matched case-insensitively against stored columns and columns already
 *    seen in this batch, so `ID` and `Id` land in one column with the first spelling;
 * 4. two keys of the same row that land in one column collide: the key that does not own the column moves
 *    to `<name>_2` (then `_3`, …) for the rest of the batch, with a warning.
 */
export class ColumnNamer {
  private readonly byRaw = new Map<string, string>();
  private readonly byLower = new Map<string, string>();    // lower(column) → spelling (stored + batch)
  private readonly knownBySource = new Map<string, string>();
  private readonly owner = new Map<string, string>();      // lower(column) → raw key that owns it
  private readonly batch = new Map<string, StagedColumn>(); // lower(column) → batch column, first-seen order
  private readonly spelling = new Map<string, string>();    // raw key → its own cleaned spelling
  readonly warnings: Problem[] = [];

  constructor(known: Iterable<KnownName> = [], private readonly asset?: string) {
    for (const k of known) {
      this.byLower.set(k.name.toLowerCase(), k.name);
      if (k.sourceName != null) {
        this.knownBySource.set(k.sourceName, k.name);
        this.owner.set(k.name.toLowerCase(), k.sourceName);
      }
    }
  }

  /** Batch columns in first-seen order, each with the first source name that landed in it. */
  get columns(): StagedColumn[] {
    return [...this.batch.values()];
  }

  /** Column names for one row's keys, in the same order. */
  resolveRow(keys: readonly string[]): string[] {
    const out: string[] = [];
    const used = new Map<string, number>(); // lower(column) → index in out
    for (let i = 0; i < keys.length; i++) {
      const raw = keys[i]!;
      let col = this.byRaw.get(raw) ?? this.first(raw, i + 1);
      const lower = col.toLowerCase();
      const clash = used.get(lower);
      if (clash !== undefined) {
        const prevRaw = keys[clash]!;
        if (this.owner.get(lower) === raw) {
          // This key owns the column: the earlier key of this row moves.
          const moved = this.split(prevRaw, col);
          out[clash] = moved;
          used.set(moved.toLowerCase(), clash);
        } else {
          col = this.split(raw, col);
        }
      }
      used.set(col.toLowerCase(), i);
      out.push(col);
    }
    return out;
  }

  private first(raw: string, position: number): string {
    let col: string;
    const renamed = RENAMED[raw.toLowerCase()];
    const known = this.knownBySource.get(raw);
    if (known !== undefined) col = known;
    else {
      const base = renamed ?? cleanColumnName(raw, position);
      this.spelling.set(raw, base);
      col = this.byLower.get(base.toLowerCase()) ?? base;
    }
    this.claim(col, raw);
    this.byRaw.set(raw, col);
    return col;
  }

  private claim(col: string, raw: string): void {
    const lower = col.toLowerCase();
    if (!this.byLower.has(lower)) this.byLower.set(lower, col);
    if (!this.owner.has(lower)) this.owner.set(lower, raw);
    if (!this.batch.has(lower)) this.batch.set(lower, { name: col, sourceName: raw });
  }

  /** Give `raw` its own column next to `col`, in its own spelling: `id_2`, `id_3`, … */
  private split(raw: string, col: string): string {
    const base = this.spelling.get(raw) ?? col;
    let n = 2;
    while (this.byLower.has(`${base}_${n}`.toLowerCase())) n++;
    const next = `${base}_${n}`;
    this.claim(next, raw);
    this.byRaw.set(raw, next);
    this.warnings.push(problem("COLUMN_NAME_COLLISION", {
      message: `fields ${JSON.stringify(this.owner.get(col.toLowerCase()) ?? col)} and ${JSON.stringify(raw)} both clean to column ${col}; ${JSON.stringify(raw)} is stored as ${next}`,
      hint: `rename one of them in rows() or map(), e.g. { ...row, ${jsKey(next)}: row[${JSON.stringify(raw)}] }`,
      details: { column: col, field: raw, storedAs: next },
      ...(this.asset ? { asset: this.asset } : {}),
    }));
    return next;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The part writer

export interface StageOptions {
  /** Staging directory for this asset in this run: .croft/staging/<run>/<asset>. */
  dir: string;
  asset: string;
  runId: string;
  /** What rows() returned: an (async) iterable of rows or arrays of rows, or a promise of rows. */
  source: RowSource | AsyncIterable<unknown> | Iterable<unknown>;
  /** Stored columns (_croft.columns name + source_name), so new keys resolve to stored spellings. */
  knownColumns?: Iterable<KnownName>;
  /** Preview row cap: stop after this many rows and close the generator. */
  maxRows?: number;
  /** Called once when maxRows is reached, before the generator is closed (e.g. to abort ctx.signal). */
  onCap?: () => void;
  signal?: AbortSignal;
  partRows?: number;
  sinceUsed?: string | number;
}

/** manifest.json: the shared StageManifest plus what typing needs from staging. */
export interface StageManifestFile extends StageManifest {
  /** Batch columns in first-seen order with their original source names (_croft.columns.source_name). */
  columns: StagedColumn[];
  /** Rows carry the reserved `_file` column (file ingests). */
  hasFile: boolean;
  /** The row cap stopped extraction early. */
  capped: boolean;
  /** UNSAFE_INTEGER, name collisions. */
  warnings: Problem[];
}

interface Unsafe { count: number; row: number; path: string; value: number }

/** Appends lines to part-NNNN.ndjson files of at most `partRows` lines, buffering writes. */
class PartWriter {
  readonly parts: { path: string; rows: number }[] = [];
  private fh: FileHandle | null = null;
  private buf = "";

  constructor(private readonly dir: string, private readonly partRows: number) {}

  async write(line: string): Promise<void> {
    if (!this.fh) {
      const path = join(this.dir, `part-${String(this.parts.length + 1).padStart(4, "0")}.ndjson`);
      this.fh = await open(path, "w");
      this.parts.push({ path, rows: 0 });
    }
    const part = this.parts.at(-1)!;
    this.buf += line;
    part.rows++;
    if (this.buf.length >= FLUSH_BYTES) await this.flush();
    if (part.rows >= this.partRows) await this.close();
  }

  async close(): Promise<void> {
    if (!this.fh) return;
    await this.flush();
    await this.fh.close();
    this.fh = null;
  }

  /** Close without flushing (after a failure; staging is kept for inspection). */
  async abandon(): Promise<void> {
    this.buf = "";
    await this.fh?.close().catch(() => {});
    this.fh = null;
  }

  private async flush(): Promise<void> {
    if (this.fh && this.buf) await this.fh.write(this.buf);
    this.buf = "";
  }
}

/**
 * Stream rows into NDJSON parts of `partRows` rows, then write manifest.json. Throws ROW_NOT_OBJECT,
 * UNSERIALIZABLE_VALUE, INTERRUPTED (or the signal's CroftError reason) and whatever the generator throws.
 */
export async function writeStage(o: StageOptions): Promise<StageManifestFile> {
  mkdirSync(o.dir, { recursive: true });
  const namer = new ColumnNamer(o.knownColumns, o.asset);
  const out = new PartWriter(o.dir, Math.max(1, o.partRows ?? PART_ROWS));
  const unsafe = new Map<string, Unsafe>();
  let rows = 0;
  let hasFile = false;
  let capped = false;

  const encode = (row: unknown, seq: number): string => {
    if (!isRowObject(row)) {
      throw new CroftError("ROW_NOT_OBJECT", {
        message: `row ${seq} of ${o.asset} is ${article(typeLabel(row))}, not an object`,
        hint: "rows() must yield objects, or arrays of objects (one array per page)",
        asset: o.asset, runId: o.runId,
        details: { row: seq, type: typeLabel(row) },
      });
    }
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const names = namer.resolveRow(keys);
    let line = `{"${RESERVED.seq}":${seq}`;
    for (let i = 0; i < keys.length; i++) {
      const field = keys[i]!;
      let text: string;
      try {
        text = canonicalJson(row[field], {
          onUnsafeInteger: (path, value) => {
            const col = names[i]!;
            const u = unsafe.get(col);
            if (u) u.count++;
            else unsafe.set(col, { count: 1, row: seq, path: path ? `${field}.${path}` : field, value });
          },
        });
      } catch (e) {
        if (!(e instanceof UnserializableError)) throw e;
        const at = e.path ? `${field}${e.path.startsWith("[") ? "" : "."}${e.path}` : field;
        throw new CroftError("UNSERIALIZABLE_VALUE", {
          message: `row ${seq} of ${o.asset}: field ${at} is ${article(e.type)}, which JSON cannot store`,
          hint: unserializableHint(e.type),
          asset: o.asset, runId: o.runId,
          details: { row: seq, field, path: at, type: e.type },
        });
      }
      line += `,${JSON.stringify(names[i])}:${text}`;
    }
    const file = (row as Record<symbol, unknown>)[STAGE_FILE];
    if (typeof file === "string") {
      hasFile = true;
      line += `,"${RESERVED.file}":${JSON.stringify(file)}`;
    }
    return line + "}\n";
  };

  const it = iterate(o.source);
  let abortWait: Promise<never> | null = null;
  let onAbort: (() => void) | null = null;
  if (o.signal) {
    const signal = o.signal;
    abortWait = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError(signal, o));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    abortWait.catch(() => {}); // handled where it is raced
  }

  try {
    if (o.signal?.aborted) throw abortError(o.signal, o);
    outer: for (;;) {
      const next = abortWait ? await Promise.race([it.next(), abortWait]) : await it.next();
      if (next.done) break;
      if (o.signal?.aborted) throw abortError(o.signal, o);
      const batch = Array.isArray(next.value) ? next.value : [next.value];
      for (const row of batch) {
        if (o.maxRows !== undefined && rows >= o.maxRows) {
          capped = true;
          break outer;
        }
        rows++;
        await out.write(encode(row, rows));
      }
      if (o.maxRows !== undefined && rows >= o.maxRows) {
        capped = true;
        break;
      }
    }
    if (capped) {
      o.onCap?.();
      // The generator is suspended at a yield, so return() runs its finally blocks promptly.
      await Promise.resolve(it.return?.()).catch(() => {});
    }
    await out.close();
  } catch (e) {
    // A generator waiting on the network may never settle; do not await its return().
    Promise.resolve(it.return?.()).catch(() => {});
    await out.abandon();
    throw e;
  } finally {
    if (o.signal && onAbort) o.signal.removeEventListener("abort", onAbort);
  }

  const warnings: Problem[] = [...namer.warnings];
  for (const [col, u] of unsafe) {
    warnings.push(problem("UNSAFE_INTEGER", {
      message: `column ${col}: ${u.count} integer${u.count === 1 ? "" : "s"} beyond ±2^53 reached croft as JS numbers and may have lost digits (e.g. ${u.value} in row ${u.row}, ${u.path})`,
      hint: "parse responses with ctx.http's res.json() (lossless: big integers become bigint), or yield such values as strings or bigint",
      asset: o.asset, runId: o.runId,
      details: { column: col, count: u.count, row: u.row, path: u.path, sample: String(u.value) },
    }));
  }
  const manifest: StageManifestFile = {
    runId: o.runId, asset: o.asset, parts: out.parts, topLevelKeys: namer.columns.map((c) => c.name), rows,
    ...(o.sinceUsed !== undefined ? { sinceUsed: o.sinceUsed } : {}),
    complete: true, columns: namer.columns, hasFile, capped, warnings,
  };
  // Written last and renamed into place: a manifest on disk means every part is complete.
  const tmp = join(o.dir, `${MANIFEST_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 1));
  renameSync(tmp, join(o.dir, MANIFEST_FILE));
  return manifest;
}

/** Read a completed stage's manifest. Throws when the extraction never finished. */
export function readStageManifest(dir: string): StageManifestFile {
  const path = join(dir, MANIFEST_FILE);
  let m: StageManifest & Partial<StageManifestFile>;
  try {
    m = JSON.parse(readFileSync(path, "utf8")) as StageManifest & Partial<StageManifestFile>;
  } catch (e) {
    throw new CroftError("INTERNAL_ERROR", {
      message: `staging in ${dir} has no readable manifest.json; the extraction did not complete`,
      hint: "run the asset again; staging is only loaded after a complete extraction",
      details: { error: (e as Error).message },
    });
  }
  return { hasFile: false, capped: false, warnings: [], columns: m.topLevelKeys.map((k) => ({ name: k, sourceName: k })), ...m };
}

// ---------------------------------------------------------------------------------------------------------

type AnyIterator = { next(): Promise<IteratorResult<unknown>> | IteratorResult<unknown>; return?(v?: unknown): unknown };

/** One async iterator over every RowSource shape: async iterables, iterables, and promises of rows. */
function iterate(source: StageOptions["source"]): { next(): Promise<IteratorResult<unknown>>; return?(): unknown } {
  if (source && typeof (source as PromiseLike<unknown>).then === "function") {
    let done = false;
    return {
      async next() {
        if (done) return { done: true, value: undefined };
        done = true;
        return { done: false, value: await (source as PromiseLike<unknown>) };
      },
    };
  }
  let inner: AnyIterator;
  if (source && typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    inner = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  } else if (source && typeof (source as Iterable<unknown>)[Symbol.iterator] === "function") {
    inner = (source as Iterable<unknown>)[Symbol.iterator]();
  } else {
    throw new CroftError("ROW_NOT_OBJECT", {
      message: `rows() returned ${article(typeLabel(source))}, not rows`,
      hint: "rows() must be an async generator (async *rows(ctx) { yield … }), or return an array of objects",
      details: { type: typeLabel(source) },
    });
  }
  return {
    next: async () => await inner.next(),
    return: inner.return ? () => inner.return!() : undefined,
  };
}

function abortError(signal: AbortSignal, o: StageOptions): CroftError {
  if (signal.reason instanceof CroftError) return signal.reason;
  return new CroftError("INTERRUPTED", {
    message: `extraction of ${o.asset} was interrupted`,
    hint: "nothing was saved; run it again",
    asset: o.asset, runId: o.runId,
    details: { reason: signal.reason instanceof Error ? signal.reason.message : signal.reason === undefined ? null : String(signal.reason) },
  });
}

function article(type: string): string {
  if (/^(null|undefined|NaN|Infinity|-Infinity)$/.test(type)) return type;
  return `${/^[aeiouAEIOU]/.test(type) ? "an" : "a"} ${type}`;
}

function unserializableHint(type: string): string {
  if (type === "Map") return "convert it with Object.fromEntries(map)";
  if (type === "Set") return "convert it with [...set]";
  if (/Array$|ArrayBuffer|DataView/.test(type)) return "convert binary data to a string (e.g. base64) or an array of numbers";
  if (/NaN|Infinity/.test(type)) return "JSON has no NaN or Infinity; yield null (or a string) for such values";
  if (type === "function" || type === "symbol") return "yield plain data: strings, numbers, booleans, null, arrays and objects";
  if (type.startsWith("Promise")) return "await the value before yielding the row";
  if (type === "Invalid Date") return "the Date is invalid; yield null or a valid date";
  if (type === "circular reference") return "an object refers to itself; yield a copy without the cycle";
  if (/surrogate/.test(type)) return "the text is not valid Unicode; fix it with s.toWellFormed()";
  return "yield plain data: strings, numbers, booleans, null, arrays and objects";
}

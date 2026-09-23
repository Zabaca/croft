// File ingests (DESIGN.md §3b, §5, §6, §7 "CSV text"). Like every ingest step, two halves plus bookkeeping:
//
//   extractFiles    NO database lock. Resolves paths, globs (Bun.Glob) and URLs against the project root;
//                   downloads URLs with a conditional GET (If-None-Match / If-Modified-Since); fingerprints every
//                   file (size, mtime, sha256) and compares it with _croft.files (new / changed / unchanged /
//                   gone); snapshots the files it will load into <stateDir>/staging/<run>/<asset>/files/ (a
//                   copy-on-write clone where the file system has one), so the sha256 recorded is exactly the
//                   content loaded even if the user edits the file mid-run, and the write step reads only inside
//                   the state folder the sandbox always allows; decides each CSV's encoding (UTF-8, else UTF-16
//                   by its byte-order mark, else latin-1, with CSV_ENCODING_GUESSED; a declared csv.encoding wins)
//                   and dialect (header, delimiter, skip) in a private in-memory DuckDB; and stages rows as NDJSON
//                   when JavaScript must see them (JSON files, map()).
//   buildFileBatch  inside the write lease: a typed TEMP table for write.ts. CSV is read with all_varchar and
//                   union_by_name and typed by croft's CSV text rules (money, d/m/y dates decided once per column
//                   and stored in _croft.columns.format), never by DuckDB's sniffer; Parquet keeps its types,
//                   normalized to croft's lattice; JSON goes through the ordinary cast.ts pipeline. Every value is
//                   verified by the same round-trip loss check as API rows (a value that does not parse with the
//                   stored format is TYPE_CONFLICT). DUPLICATE_ROWS_ACROSS_FILES is reported here, because it needs
//                   the table.
//   recordFiles     inside the same transaction: _croft.files.
//
// Why encoding and header are decided at extraction, not in the write lease: a read_csv that fails (a latin-1 file
// read as UTF-8) aborts the enclosing transaction, so "try UTF-8, then latin-1" cannot run inside it [V]; and a
// wrong header is best refused before any lock is taken.
//
// File identity. A file's `path` (in _croft.files, in FileExtract.load/gone and in the `_file` column) is its path
// relative to the project root with `/` separators, an absolute path for a file outside the root, or its URL.
// The snapshot a load reads is FileStatus.local.
//
// Gone files. _croft.files has no "gone" marker, so none is invented: a file that disappeared keeps its row, and
// extractFiles reports it on every run (status "gone", FileExtract.gone) by comparing _croft.files with what
// exists. Its rows stay in the table (§6). A non-incremental ingest is a replace of the whole table, which removes
// a deleted file's rows, so recordFiles drops its _croft.files row too.
//
// Verified behaviors this relies on (files.test.ts): read_csv on a latin-1 file as UTF-8 fails with "Invalid
// unicode … not utf-8 encoded" and ABORTS the enclosing transaction (JavaScript's fatal UTF-8 decoder agrees with
// DuckDB); union_by_name matches column names case-insensitively and keeps a later file's extra column; sniff_csv
// reports HasHeader=true for a header-less all-text file (the row-losing case of §3b) and SkipRows>0 when it would
// silently drop leading lines; on a ragged file the default sniff drops lines or falls back to a one-column
// dialect, while an explicit dialect fails loudly and names the line; INSERT … BY NAME matches case-insensitively;
// rows a transaction inserts get transaction-local rowids (from 36028797018960000), contiguous in insertion (file)
// order; `filename = '<name>'` names the file column so a CSV column called "filename" survives.
import { constants, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CroftError, problem } from "../core/errors.ts";
import type { Fix, Problem, Sql, ValueKind } from "../core/types.ts";
import { canonicalPath, openMemory } from "../db/connect.ts";
import { ensureState } from "../db/state.ts";
import { LeaseSql } from "../db/warehouse.ts";
import { excerpt, parseRetryAfter } from "../http/http.ts";
import type { FileFormat, FileIngest, Http, HttpInit, HttpResponse, Row } from "../types.ts";
import { buildTypedBatch, castExpr, lossExpr, realColumns, typedTableName, type TypedBatchResult } from "./cast.ts";
import { classify, classifyCsv, ident, sqlString, stageRaw } from "./classify.ts";
import { RESERVED, type TypedBatch } from "./contract.ts";
import { currentDatabase, normalizeType, readTableSchema, tableRef, tempRef } from "./evolve.ts";
import { ColumnNamer, cleanColumnName, type KnownName, parseJsonLossless, readStageManifest, STAGE_FILE, writeStage } from "./stage.ts";
import {
  type ColumnDecision, csvColumnType, csvValueKinds, type CsvStats, decimalParts, describeKinds, evolve, type IncomingColumn, jsKey,
  type KindCounts, type KnownColumn, type NewType, normalizePins, type Pin, typeFamily,
} from "./types.ts";

/** One row of _croft.files. `path` is the file's identity (see the header): root-relative path, absolute path
 *  outside the root, or URL. It is also the value of the `_file` column. */
export interface KnownFile {
  path: string;
  size: number;
  /** Modification time (ISO-8601); for a URL its Last-Modified header, or null when the server sent none. */
  mtime: string | null;
  etag: string | null;
  sha256: string;
}

export type CsvEncoding = "utf-8" | "latin-1" | "utf-16";

/** How one CSV/TSV file is read. Decided at extraction; the write step reads with exactly these options. */
export interface CsvDialect {
  encoding: CsvEncoding;
  /** The encoding was not declared and the file is not valid UTF-8 (CSV_ENCODING_GUESSED). */
  encodingGuessed: boolean;
  delimiter: string;
  quote: string;
  escape: string;
  header: boolean;
  /** Where the header decision came from: csv.header, DuckDB's sniffer (some column is not text), or the first
   *  line matching stored column names or another file's header. Preview and the first run print it. */
  headerFrom: "declared" | "sniffed" | "known";
  skip: number;
  gzip: boolean;
}

export interface FileStatus extends KnownFile {
  status: "new" | "changed" | "unchanged" | "gone";
  /** Set for URL sources (equal to `path`). */
  url?: string;
  /** The snapshot the write step reads: a clone/copy (or the download) under stageDir/files/. Set for loaded
   *  files, and for downloaded URLs. */
  local?: string;
  /** CSV/TSV files that are loaded: how they are read. */
  csv?: CsvDialect;
}

export interface ExtractFilesInput {
  asset: string;
  config: FileIngest;
  root: string;
  stateDir: string;
  runId: string;
  /** The asset's current _croft.files rows (readKnownFiles). */
  known: KnownFile[];
  http: Http;
  signal: AbortSignal;
  /** Preview: stop after this many rows. */
  previewRows?: number;
  /** --rebuild: treat every file as changed. */
  rebuild?: boolean;
  log?: (...args: unknown[]) => void;
  /** Stored columns (_croft.columns name + source_name): staged names resolve to stored spellings, and a CSV whose
   *  columns all read as text can prove its first line is a header by matching them. */
  knownColumns?: readonly KnownName[];
  /** Project time zone for the private in-memory DuckDB (default UTC; nothing it reads depends on it). */
  timezone?: string;
}

export interface FileExtract {
  asset: string;
  format: FileFormat;
  files: FileStatus[];
  /** Where staged data for this run lives (under <stateDir>/staging/<runId>/<asset>/). */
  stageDir: string;
  /** Paths whose rows this load writes (new and changed files; every file for a non-incremental ingest). */
  load: string[];
  /** Paths that disappeared since the last load. Their rows are kept; status reports them. */
  gone: string[];
  /** True when nothing changed (all files unchanged, or URL answered 304): the runner skips the write. */
  unchanged: boolean;
  /** Findings of extraction (CSV_ENCODING_GUESSED, ...). buildFileBatch carries them into FileBatch.warnings;
   *  a runner that skips the write reports them itself. */
  warnings: Problem[];
  /** config.incremental === true: only new and changed files are loaded, and their rows are replaced by _file. */
  incremental: boolean;
  /** The asset's key (DUPLICATE_ROWS_ACROSS_FILES applies to keyless incremental ingests). */
  key: string[];
  /** Rows were staged as NDJSON parts in stageDir (JSON files, or map()); otherwise the write step reads the
   *  snapshots directly. */
  staged: boolean;
  /** Parquet read through map(): each source column's normalized type, so unmapped columns keep their types. */
  columnTypes?: Record<string, string>;
  /** Preview row cap, applied by the write step to direct reads. */
  previewRows?: number;
}

export interface BuildFileBatchInput {
  extract: FileExtract;
  knownColumns: readonly KnownColumn[];
  pins?: Record<string, Pin>;
  timezone: string;
  readBy?: string[];
}

export interface FileBatch extends TypedBatch {
  /** For incremental file ingests: only rows of these files are replaced (write.ts WriteTarget.replaceFiles). */
  replaceFiles?: string[];
  /** Date/money formats decided for CSV columns (column → format), stored in _croft.columns.format. */
  formats: Record<string, string>;
}

/** A client that can hand back a response's raw bytes. HttpResponse.text is decoded as UTF-8, which would corrupt
 *  Parquet and latin-1 files, so extractFiles downloads through `getBytes` when ctx.http has it, and otherwise
 *  through its own fetch with the same retry rules. */
export interface ByteHttp {
  getBytes(url: string, init?: HttpInit): Promise<HttpResponse & { bytes: Uint8Array }>;
}

// ---------------------------------------------------------------------------------------------------------
// Formats

const EXTENSIONS: Record<string, FileFormat> = {
  ".csv": "csv", ".tsv": "tsv", ".tab": "tsv", ".json": "json", ".ndjson": "ndjson", ".jsonl": "ndjson", ".parquet": "parquet", ".pq": "parquet",
};

/** The format a file name (or URL path) implies, `.gz` looked through. */
export function formatFromName(name: string): FileFormat | undefined {
  let n = name.toLowerCase();
  if (n.endsWith(".gz")) n = n.slice(0, -3);
  return EXTENSIONS[extname(n)];
}

/** The format a Content-Type implies. */
export function formatFromContentType(contentType: string | null | undefined): FileFormat | undefined {
  const t = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (t === "text/csv" || t === "application/csv") return "csv";
  if (t === "text/tab-separated-values") return "tsv";
  if (t === "application/x-ndjson" || t === "application/ndjson" || t === "application/jsonl" || t === "application/x-jsonlines" || t === "application/jsonlines") return "ndjson";
  if (t === "application/json" || t.endsWith("+json")) return "json";
  if (t === "application/vnd.apache.parquet" || t === "application/x-parquet" || t === "application/parquet") return "parquet";
  return undefined;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const GLOB_CHARS = /[*?[\]{}]/;
const SRC = "__croft_source_file";

// ---------------------------------------------------------------------------------------------------------
// extractFiles

interface Present extends FileStatus {
  abs?: string;
  contentType?: string | null;
  fileFormat?: FileFormat;
}

/**
 * Resolve, download, fingerprint and snapshot the asset's files, and stage rows when JavaScript must see them.
 * Holds no database lock. Throws FILE_NOT_FOUND, FILE_UNREADABLE, HTTP_ERROR, CSV_HEADER_AMBIGUOUS,
 * ASSET_INVALID (format), ASSET_CODE_ERROR / ROW_NOT_OBJECT (map()), INTERRUPTED.
 */
export async function extractFiles(input: ExtractFilesInput): Promise<FileExtract> {
  const { asset, config, runId, signal } = input;
  const root = resolve(input.root);
  // The sandbox compares canonical paths, so snapshots live under the canonical state folder.
  const stateDir = canonicalPath(input.stateDir);
  const log = input.log ?? (() => {});
  const incremental = config.incremental === true;
  const key = keyList(config.key);
  const stageDir = join(stateDir, "staging", runId, asset);
  const snapDir = join(stageDir, "files");
  const warnings: Problem[] = [];
  const knownBy = new Map(input.known.map((k) => [k.path, k]));
  const abort = () => {
    if (signal.aborted) throw abortError(signal, asset, runId);
  };
  let snapSeq = 0;
  const snapPath = (name: string) => {
    mkdirSync(snapDir, { recursive: true });
    return join(snapDir, `${String(++snapSeq).padStart(4, "0")}-${safeName(name)}`);
  };

  const specs = (Array.isArray(config.file) ? config.file : [config.file]).map((s) => String(s).trim()).filter(Boolean);
  const { sources, unmatched } = await resolveSources(specs, root, stateDir);

  // 1. Fingerprint what exists now; download URLs (conditionally when croft has seen them).
  const present: Present[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    abort();
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const k = knownBy.get(s.id);
    if (s.url) {
      present.push(await fetchUrl({ url: s.url, known: k, conditional: !input.rebuild, http: input.http, signal, asset, runId, snapPath, log, rebuild: input.rebuild }));
      continue;
    }
    if (!s.exists) {
      if (k) continue; // deleted since the last load: reported as gone below
      throw fileNotFound(asset, s.spec, `${s.id} does not exist`, s.isDir ? `${s.spec} is a folder; use a glob such as ${JSON.stringify(`${s.spec.replace(/\/+$/, "")}/*.csv`)}` : undefined);
    }
    let st: ReturnType<typeof statSync>;
    let fp: { sha256: string; size: number };
    try {
      st = statSync(s.abs!);
      fp = await fingerprint(s.abs!);
    } catch (e) {
      throw unreadable(asset, runId, s.id, e, []);
    }
    present.push({
      path: s.id, abs: s.abs, size: fp.size, mtime: st.mtime.toISOString(), etag: null, sha256: fp.sha256,
      status: statusOf(k, fp.sha256, input.rebuild),
    });
  }
  if (present.length === 0 && knownBy.size === 0) {
    const what = unmatched.length ? `no file matches ${unmatched.map((u) => JSON.stringify(u)).join(", ")}` : "no files";
    throw fileNotFound(asset, specs.join(", "), what);
  }

  // 2. What to load.
  const presentIds = new Set(present.map((p) => p.path));
  const gone: FileStatus[] = input.known.filter((k) => !presentIds.has(k.path)).map((k) => ({ ...k, status: "gone" as const }));
  const changed = present.filter((p) => p.status !== "unchanged");
  const unchanged = incremental ? changed.length === 0 : changed.length === 0 && gone.length === 0;
  const load = unchanged ? [] : incremental ? changed : present;

  // 3. One format for the whole asset.
  const formats = new Set<FileFormat>();
  for (const p of present) {
    const f = config.format ?? formatFromName(p.url ? urlPath(p.url) : p.path) ?? formatFromContentType(p.contentType);
    if (f) {
      p.fileFormat = f;
      formats.add(f);
    } else if (load.includes(p)) {
      throw new CroftError("ASSET_INVALID", {
        message: `cannot tell the format of ${p.path}: its name has no .csv, .tsv, .json, .ndjson, .jsonl or .parquet extension${p.url ? " and the server sent no recognized Content-Type" : ""}`,
        hint: 'set the format in the asset: format: "csv" (or "tsv", "json", "ndjson", "parquet")',
        asset, runId, details: { file: p.path, contentType: p.contentType ?? null },
      });
    }
  }
  if (formats.size > 1) {
    const byFormat = [...formats].map((f) => `${f}: ${present.filter((p) => p.fileFormat === f).map((p) => p.path).slice(0, 3).join(", ")}`);
    throw new CroftError("ASSET_INVALID", {
      message: `${asset} reads files of different formats (${byFormat.join("; ")}); one asset reads one format`,
      hint: "narrow the glob to one extension (files/sales/*.csv), or split the files into two assets",
      asset, runId, details: { formats: [...formats] },
    });
  }
  // Nothing loaded and no name or Content-Type to go by (an extension-less URL answering 304): the format does not
  // matter, because the runner skips the write.
  const format: FileFormat = [...formats][0] ?? config.format ?? "csv";

  const result = (files: FileStatus[], staged: boolean, columnTypes?: Record<string, string>): FileExtract => ({
    asset, format, files, stageDir, load: load.map((p) => p.path), gone: gone.map((g) => g.path), unchanged, warnings,
    incremental, key, staged, ...(columnTypes ? { columnTypes } : {}),
    ...(input.previewRows !== undefined ? { previewRows: input.previewRows } : {}),
  });
  const publicStatus = (p: Present): FileStatus => {
    const { abs: _a, contentType: _c, fileFormat: _f, ...rest } = p;
    return rest;
  };
  if (unchanged) {
    log(`${asset}: ${present.length} file${present.length === 1 ? "" : "s"} unchanged${gone.length ? `, ${gone.length} gone` : ""}`);
    return result([...present.map(publicStatus), ...gone], false);
  }

  // 4. Snapshots: what is hashed and recorded is exactly what is loaded.
  for (const p of load) {
    abort();
    if (p.url) {
      // A 304 in a non-incremental load whose other files changed: the whole set is re-read, so fetch it again.
      if (!p.local) Object.assign(p, await fetchUrl({ url: p.url, known: knownBy.get(p.path), conditional: false, http: input.http, signal, asset, runId, snapPath, log, rebuild: true, keepStatus: p.status }));
      continue;
    }
    const local = snapPath(basename(p.abs!));
    copyFileSync(p.abs!, local, constants.COPYFILE_FICLONE);
    const fp = await fingerprint(local);
    p.local = local;
    p.size = fp.size;
    if (fp.sha256 !== p.sha256) {
      // The file changed between hashing and snapshotting: the snapshot is what is loaded and recorded.
      p.sha256 = fp.sha256;
      if (p.status === "unchanged") p.status = "changed";
    }
  }

  const map = typeof config.map === "function" ? config.map : undefined;
  const staged = format === "json" || format === "ndjson" || map !== undefined;
  // CSV dialects, Parquet checks and map() reads use a private in-memory DuckDB (never the warehouse).
  const needsDb = format !== "json" && format !== "ndjson";
  let mem: Awaited<ReturnType<typeof openMemory>> | null = null;
  let columnTypes: Record<string, string> | undefined;
  try {
    let db: Sql | null = null;
    if (needsDb && load.length > 0) {
      mem = await openMemory({ timezone: input.timezone ?? "UTC", stateDir });
      db = new LeaseSql(await mem.connect(), { mode: "ts", timezone: input.timezone ?? "UTC" }, null);
    }

    // 5. CSV: encoding and dialect per file.
    if ((format === "csv" || format === "tsv") && db) {
      await decideDialects(db, load, { asset, runId, format, csv: config.csv, knownColumns: input.knownColumns ?? [], warnings, abort });
    }
    // Parquet: a corrupt file fails here, before the write lease, with its name.
    if (format === "parquet" && db) {
      for (const p of load) {
        if (!p.local || p.size === 0) continue;
        try {
          await db.all(`DESCRIBE SELECT * FROM read_parquet(${sqlString(p.local)})`);
        } catch (e) {
          throw unreadable(asset, runId, p.path, e, [p]);
        }
      }
    }

    // 6. Rows JavaScript must see: JSON files, and every format when map() cleans rows.
    if (staged) {
      columnTypes = format === "parquet" ? {} : undefined;
      const source = stagedRows({ load, format, map, db, asset, runId, abort, columnTypes });
      await writeStage({
        dir: stageDir, asset, runId, source, knownColumns: input.knownColumns ?? [], signal,
        ...(input.previewRows !== undefined ? { maxRows: input.previewRows } : {}),
      });
    }
  } finally {
    mem?.close();
  }
  log(`${asset}: loading ${load.length} file${load.length === 1 ? "" : "s"} (${format})${gone.length ? `; ${gone.length} gone` : ""}`);
  return result([...present.map(publicStatus), ...gone], staged, columnTypes);
}

function keyList(key: string | string[] | undefined): string[] {
  if (key === undefined) return [];
  return (Array.isArray(key) ? key : [key]).filter((k) => typeof k === "string" && k.trim() !== "");
}

function statusOf(k: KnownFile | undefined, sha256: string, rebuild?: boolean): FileStatus["status"] {
  if (!k) return "new";
  if (rebuild) return "changed";
  return k.sha256 === sha256 ? "unchanged" : "changed";
}

function safeName(name: string): string {
  const n = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(-120);
  return n || "file";
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A file's identity: root-relative with `/`, or absolute outside the root. */
export function fileId(root: string, abs: string): string {
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return abs;
  return rel.split(sep).join("/");
}

interface Source { id: string; spec: string; url?: string; abs?: string; exists: boolean; isDir?: boolean }

/**
 * Specs in the order written; a glob's matches sorted, so a later export (2026-02.csv after 2026-01.csv) is read
 * later and wins a key tie. A spec that names an existing file is a literal path even when it contains glob
 * characters. Matches inside the state folder (staging, trash, previews) are never inputs.
 */
async function resolveSources(specs: string[], root: string, stateDir: string): Promise<{ sources: Source[]; unmatched: string[] }> {
  const sources: Source[] = [];
  const unmatched: string[] = [];
  // A match's folder resolved once (a folder, never the warehouse file, so realpath is safe).
  const realDirs = new Map<string, string>();
  const inState = (abs: string) => {
    const dir = dirname(abs);
    let real = realDirs.get(dir);
    if (real === undefined) {
      try {
        real = realpathSync.native(dir);
      } catch {
        real = dir;
      }
      realDirs.set(dir, real);
    }
    return real === stateDir || real.startsWith(stateDir + sep);
  };
  for (const spec of specs) {
    if (isUrl(spec)) {
      sources.push({ id: spec, spec, url: spec, exists: true });
      continue;
    }
    const abs = resolve(root, spec);
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(abs);
    } catch { /* missing */ }
    if (st?.isFile()) {
      sources.push({ id: fileId(root, abs), spec, abs, exists: true });
      continue;
    }
    if (!st && GLOB_CHARS.test(spec)) {
      const matches: string[] = [];
      for await (const m of new Bun.Glob(spec).scan({ cwd: isAbsolute(spec) ? "/" : root, onlyFiles: true })) {
        const a = resolve(isAbsolute(spec) ? "/" : root, m);
        if (!inState(a)) matches.push(a);
      }
      if (matches.length === 0) unmatched.push(spec);
      for (const a of matches.sort()) sources.push({ id: fileId(root, a), spec, abs: a, exists: true });
      continue;
    }
    sources.push({ id: fileId(root, abs), spec, abs, exists: false, isDir: st?.isDirectory() ?? false });
  }
  return { sources, unmatched };
}

/** sha256 and size of a file, streamed. */
async function fingerprint(path: string): Promise<{ sha256: string; size: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: hasher.digest("hex"), size };
}

function sha256Of(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** gzip by its magic bytes, whatever the name (DuckDB decides compression by extension only). */
async function isGzip(path: string): Promise<boolean> {
  const head = new Uint8Array(await Bun.file(path).slice(0, 2).arrayBuffer());
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/** The file's bytes as a stream, gunzipped when it is gzip. */
function byteStream(path: string, gzip: boolean): ReadableStream<Uint8Array> {
  const s = Bun.file(path).stream();
  return gzip ? s.pipeThrough(new DecompressionStream("gzip")) : s;
}

/** A UTF-16 byte-order mark (FF FE or FE FF) at the start of the (decompressed) file. */
async function hasUtf16Bom(path: string, gzip: boolean): Promise<boolean> {
  const reader = byteStream(path, gzip).getReader();
  try {
    const { value } = await reader.read();
    return value !== undefined && value.length >= 2 && ((value[0] === 0xff && value[1] === 0xfe) || (value[0] === 0xfe && value[1] === 0xff));
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Whether the whole file is valid UTF-8 (the fatal decoder agrees with DuckDB's CSV reader: files.test.ts). */
async function isUtf8File(path: string, gzip: boolean): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of byteStream(path, gzip)) decoder.decode(chunk, { stream: true });
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// URLs

interface Download { status: number; url: string; headers: Headers; bytes: Uint8Array }

interface FetchUrlInput {
  url: string;
  known: KnownFile | undefined;
  conditional: boolean;
  http: Http;
  signal: AbortSignal;
  asset: string;
  runId: string;
  snapPath: (name: string) => string;
  log: (...args: unknown[]) => void;
  rebuild?: boolean;
  keepStatus?: FileStatus["status"];
}

async function fetchUrl(o: FetchUrlInput): Promise<Present> {
  const headers: Record<string, string> = {};
  if (o.conditional && o.known) {
    if (o.known.etag) headers["If-None-Match"] = o.known.etag;
    if (o.known.mtime) {
      const t = new Date(o.known.mtime);
      if (!Number.isNaN(t.getTime())) headers["If-Modified-Since"] = t.toUTCString();
    }
  }
  const res = await download(o.http, o.url, headers, o.signal, o.asset, o.runId);
  if (res.status === 304 && o.known && Object.keys(headers).length > 0) {
    o.log(`${o.url}: not modified`);
    return { ...o.known, path: o.url, url: o.url, status: "unchanged", contentType: res.headers.get("content-type") };
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CroftError("HTTP_ERROR", {
      message: `GET ${o.url} answered ${res.status} without a body to load`,
      hint: "check the URL; croft loads a file from a 2xx response",
      asset: o.asset, runId: o.runId, retryable: false,
      details: { method: "GET", url: o.url, status: res.status, attempts: 1, retryAfterMs: null, requestIndex: null, reason: "status" },
    });
  }
  const local = o.snapPath(basename(urlPath(res.url || o.url)) || "download");
  writeFileSync(local, res.bytes);
  const sha256 = sha256Of(res.bytes);
  const lastModified = res.headers.get("last-modified");
  const lm = lastModified ? new Date(lastModified) : null;
  o.log(`${o.url}: downloaded ${res.bytes.byteLength} bytes`);
  return {
    path: o.url, url: o.url, size: res.bytes.byteLength, mtime: lm && !Number.isNaN(lm.getTime()) ? lm.toISOString() : null,
    etag: res.headers.get("etag"), sha256, status: o.keepStatus ?? statusOf(o.known, sha256, o.rebuild), local,
    contentType: res.headers.get("content-type"),
  };
}

const DOWNLOAD = { retries: 3, timeoutMs: 600_000, retryBaseMs: 500, maxRetryAfterMs: 300_000 } as const;

/** GET with raw bytes: through ctx.http's getBytes when it has one, else fetch with ctx.http's retry rules
 *  (network errors, 429 and 5xx retried up to 3 times, Retry-After honored, the run's signal respected). */
async function download(http: Http, url: string, headers: Record<string, string>, signal: AbortSignal, asset: string, runId: string): Promise<Download> {
  const bytesHttp = http as Partial<ByteHttp>;
  if (typeof bytesHttp.getBytes === "function") {
    const res = await bytesHttp.getBytes(url, { headers });
    return { status: res.status, url: res.url, headers: res.headers, bytes: res.bytes };
  }
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) throw abortError(signal, asset, runId);
    const timeout = AbortSignal.timeout(DOWNLOAD.timeoutMs);
    let failure: { status?: number; body?: string; retryAfterMs?: number | null; message: string };
    try {
      const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.any([signal, timeout]) });
      if (res.status < 400) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, url: res.url || url, headers: res.headers, bytes };
      }
      const body = await res.text().catch(() => "");
      failure = { status: res.status, body, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")), message: `${res.status}${res.statusText ? ` ${res.statusText}` : ""}` };
    } catch (e) {
      if (signal.aborted) throw abortError(signal, asset, runId);
      failure = { message: timeout.aborted ? `no answer within ${DOWNLOAD.timeoutMs / 1000} s` : (e as Error).message };
    }
    const retryable = failure.status === undefined || failure.status === 429 || failure.status >= 500;
    const tooLong = (failure.retryAfterMs ?? 0) > DOWNLOAD.maxRetryAfterMs;
    if (retryable && attempt <= DOWNLOAD.retries && !tooLong) {
      const wait = failure.retryAfterMs ?? Math.round(DOWNLOAD.retryBaseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      await sleep(wait, signal).catch(() => {
        throw abortError(signal, asset, runId);
      });
      continue;
    }
    throw new CroftError("HTTP_ERROR", {
      message: `GET ${url} failed ${failure.status ? `with ${failure.message}` : `(${failure.message})`} after ${attempt} attempt${attempt === 1 ? "" : "s"}${failure.body ? `: ${excerpt(failure.body)}` : ""}`,
      hint: failure.status === 404 ? "check the URL in the asset's file" : failure.status && failure.status < 500 ? "read the response body above for the server's reason" : "the server is failing or unreachable; run again later",
      asset, runId, retryable,
      details: {
        method: "GET", url, status: failure.status ?? null, attempts: attempt, retryAfterMs: failure.retryAfterMs ?? null, requestIndex: null,
        reason: failure.status ? "status" : "network", ...(failure.body ? { body: excerpt(failure.body) } : {}),
      },
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      rej(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------------------
// CSV dialects (at extraction, in a private in-memory DuckDB)

interface SniffRow { Delimiter: string; Quote: string; Escape: string; SkipRows: number; HasHeader: boolean; Columns: { name: string; type: string }[] }

async function sniff(db: Sql, path: string, o: { encoding: CsvEncoding; delimiter?: string; skip?: number; header?: boolean; gzip: boolean }): Promise<SniffRow> {
  const opts = [`encoding = ${sqlString(o.encoding)}`];
  if (o.delimiter !== undefined) opts.push(`delim = ${sqlString(o.delimiter)}`);
  if (o.skip !== undefined) opts.push(`skip = ${Math.max(0, Math.floor(o.skip))}`);
  if (o.header !== undefined) opts.push(`header = ${o.header}`);
  if (o.gzip) opts.push(`compression = 'gzip'`);
  const [row] = await db.all<SniffRow>(`SELECT Delimiter, Quote, Escape, SkipRows, HasHeader, Columns FROM sniff_csv(${sqlString(path)}, ${opts.join(", ")})`);
  return { ...row!, SkipRows: Number(row!.SkipRows) };
}

/** sniff_csv's "(empty)" means the sample had none; the RFC 4180 default is harmless where none occur. */
const dialectChar = (v: string | null | undefined): string => (!v || v === "(empty)" ? '"' : v);

interface DialectContext {
  asset: string;
  runId: string;
  format: FileFormat;
  csv: FileIngest["csv"];
  knownColumns: readonly KnownName[];
  warnings: Problem[];
  abort: () => void;
}

/**
 * Encoding, delimiter, quote, escape, skip and header for every CSV file to load. The header rule (§3b): DuckDB
 * can only tell a header from data when some column is not text, so when csv.header is undeclared and every
 * column sniffs as VARCHAR, the first line must match stored column names (or the header of another file in this
 * load); otherwise CSV_HEADER_AMBIGUOUS. Lines the sniffer would skip before the header are never dropped
 * silently: that is CSV_HEADER_AMBIGUOUS too, unless csv.skip says how many.
 */
async function decideDialects(db: Sql, load: Present[], c: DialectContext): Promise<void> {
  const cfg = c.csv ?? {};
  const declaredDelim = cfg.delimiter ?? (c.format === "tsv" ? "\t" : undefined);
  const pending: { p: Present; row: SniffRow }[] = [];
  const headerNames = new Set<string>();
  const addNames = (names: Iterable<string>) => {
    for (const n of names) {
      headerNames.add(n.toLowerCase());
      headerNames.add(cleanColumnName(n, 1).toLowerCase());
    }
  };
  for (const k of c.knownColumns) {
    headerNames.add(k.name.toLowerCase());
    if (k.sourceName) headerNames.add(k.sourceName.toLowerCase());
  }

  for (const p of load) {
    c.abort();
    if (!p.local) continue;
    const gzip = await isGzip(p.local);
    let encoding: CsvEncoding = cfg.encoding ?? "utf-8";
    let guessed = false;
    if (!cfg.encoding && !(await isUtf8File(p.local, gzip))) {
      // Not UTF-8: a UTF-16 byte-order mark says so; anything else is read as latin-1 (every byte is a character).
      encoding = (await hasUtf16Bom(p.local, gzip)) ? "utf-16" : "latin-1";
      guessed = true;
      c.warnings.push(problem("CSV_ENCODING_GUESSED", {
        message: `${p.path} is not valid UTF-8; croft read it as ${encoding}`,
        hint: `if accented letters look wrong, declare the encoding: csv: { encoding: "latin-1" } (or "utf-16"); declaring csv: { encoding: "${encoding}" } also silences this warning`,
        asset: c.asset, runId: c.runId,
        details: { file: p.path, encoding },
      }));
    }
    if (p.size === 0) {
      // An empty file has no rows and no header to read; it is never handed to read_csv.
      p.csv = {
        encoding, encodingGuessed: guessed, delimiter: declaredDelim ?? ",", quote: '"', escape: '"', header: cfg.header ?? true,
        headerFrom: cfg.header === undefined ? "sniffed" : "declared", skip: cfg.skip ?? 0, gzip,
      };
      continue;
    }
    let row: SniffRow;
    try {
      row = await sniff(db, p.local, { encoding, delimiter: declaredDelim, skip: cfg.skip, header: cfg.header, gzip });
    } catch (e) {
      // With a declared delimiter a ragged file makes the sniffer give up; a strict read names the line.
      const head = (await firstLines(p.local, 1, encoding, gzip, cfg.skip ?? 0))[0] ?? "";
      const why = declaredDelim ? await strictProbe(db, p.local, { delimiter: declaredDelim, encoding, skip: cfg.skip ?? 0, gzip }, head.split(declaredDelim).length) : null;
      throw unreadable(c.asset, c.runId, p.path, why ? new Error(why) : e, [p]);
    }
    // A file whose rows do not all have the same number of fields makes the sniffer fall back to one column
    // under another delimiter ("|"), which would load every line as a single text value [V]. When the header
    // line holds a usual delimiter, read strictly with it: a ragged line fails with its number.
    if (declaredDelim === undefined && (row.Columns ?? []).length === 1) {
      const head = (await firstLines(p.local, 1, encoding, gzip, cfg.skip ?? 0))[0] ?? "";
      const cand = [",", ";", "\t", "|"].find((d) => d !== row.Delimiter && head.includes(d));
      if (cand) {
        const why = await strictProbe(db, p.local, { delimiter: cand, encoding, skip: cfg.skip ?? 0, gzip }, head.split(cand).length);
        if (why) throw unreadable(c.asset, c.runId, p.path, new Error(why), [p]);
        row = await sniff(db, p.local, { encoding, delimiter: cand, skip: cfg.skip, header: cfg.header, gzip });
      }
    }
    if (cfg.skip === undefined && row.SkipRows > 0) {
      const lines = await firstLines(p.local, row.SkipRows + 1, encoding, gzip, 0);
      throw new CroftError("CSV_HEADER_AMBIGUOUS", {
        message: `${p.path}: DuckDB would skip the first ${row.SkipRows} line${row.SkipRows === 1 ? "" : "s"} before the header, and croft does not drop lines silently. The file starts:\n${lines.map((l) => `  ${l}`).join("\n")}`,
        hint: `if those lines are a preamble, declare it: csv: { skip: ${row.SkipRows} }; if they are data, the file has rows of different lengths and needs fixing`,
        asset: c.asset, runId: c.runId,
        fix: { kind: "manual", description: `add csv: { skip: ${row.SkipRows} } to the asset if the first ${row.SkipRows} line${row.SkipRows === 1 ? " is" : "s are"} not data` },
        details: { file: p.path, skipRows: row.SkipRows, lines },
      });
    }
    const dialect: CsvDialect = {
      encoding, encodingGuessed: guessed, delimiter: declaredDelim ?? row.Delimiter, quote: dialectChar(row.Quote), escape: dialectChar(row.Escape),
      header: cfg.header ?? row.HasHeader, headerFrom: cfg.header !== undefined ? "declared" : "sniffed", skip: cfg.skip ?? 0, gzip,
    };
    p.csv = dialect;
    const columns = row.Columns ?? [];
    const allText = columns.every((col) => normalizeType(col.type) === "VARCHAR");
    if (cfg.header === undefined && allText) pending.push({ p, row });
    else if (dialect.header) addNames(columns.map((col) => col.name));
  }

  // Files whose every column reads as text: the first line is a header only if its cells are known names.
  for (const { p } of pending) {
    const d = p.csv!;
    let cells: string[] = [];
    try {
      const r = await sniff(db, p.local!, { encoding: d.encoding, delimiter: d.delimiter, skip: d.skip, header: true, gzip: d.gzip });
      cells = (r.Columns ?? []).map((col) => col.name);
    } catch (e) {
      throw unreadable(c.asset, c.runId, p.path, e, [p]);
    }
    if (cells.length > 0 && cells.every((n) => headerNames.has(n.toLowerCase()) || headerNames.has(cleanColumnName(n, 1).toLowerCase()))) {
      d.header = true;
      d.headerFrom = "known";
      continue;
    }
    const knownNames = c.knownColumns.map((k) => k.name);
    if (knownNames.length > 0 && knownNames.every((n) => /^column\d+$/i.test(n)) && cells.length <= knownNames.length) {
      d.header = false; // an earlier load of this asset declared or proved there is no header
      d.headerFrom = "known";
      continue;
    }
    const lines = await firstLines(p.local!, 2, d.encoding, d.gzip, d.skip);
    throw new CroftError("CSV_HEADER_AMBIGUOUS", {
      message: `${p.path}: every column reads as text, so croft cannot tell whether the first line is a header or data (DuckDB guessed "header", which would lose the first row if it is data). The first two lines:\n${lines.map((l) => `  ${l}`).join("\n")}`,
      hint: "declare it in the asset: csv: { header: true } when the first line holds column names, csv: { header: false } when it is data",
      asset: c.asset, runId: c.runId,
      fix: { kind: "manual", description: "add csv: { header: true } (first line holds column names) or csv: { header: false } (first line is data) to the asset" },
      details: { file: p.path, lines, columns: cells },
    });
  }
}

/** Read the whole file with a fixed dialect and `fields` text columns; DuckDB's error (naming the first line
 *  with another number of fields) or null when every line fits. */
async function strictProbe(db: Sql, path: string, o: { delimiter: string; encoding: CsvEncoding; skip: number; gzip: boolean }, fields: number): Promise<string | null> {
  const columns = `{${Array.from({ length: Math.max(1, fields) }, (_, i) => `'c${i}': 'VARCHAR'`).join(", ")}}`;
  try {
    await db.all(`SELECT count(*) AS n FROM read_csv(${sqlString(path)}, auto_detect = false, header = true, delim = ${sqlString(o.delimiter)}, quote = '"', escape = '"', ` +
      `skip = ${o.skip}, encoding = ${sqlString(o.encoding)}, columns = ${columns}${o.gzip ? ", compression = 'gzip'" : ""})`);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The first `n` lines after `skip`, for messages (decoded as the file's encoding, each cut to 200 characters). */
async function firstLines(path: string, n: number, encoding: CsvEncoding, gzip: boolean, skip: number): Promise<string[]> {
  const want = 64 * 1024;
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    for await (const chunk of byteStream(path, gzip)) {
      chunks.push(chunk);
      got += chunk.byteLength;
      if (got >= want) break;
    }
  } catch { /* show what was read */ }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const ch of chunks) {
    bytes.set(ch, at);
    at += ch.byteLength;
  }
  const label = encoding === "latin-1" ? "latin1" : encoding === "utf-16" ? "utf-16le" : "utf-8";
  const text = new TextDecoder(label).decode(bytes).replace(/^﻿/, "");
  return text.split(/\r?\n/).slice(skip, skip + n).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
}

/** read_csv over files that share one dialect: all text, union by name, the file column named SRC. */
function readCsvSql(paths: string[], d: CsvDialect, withSource: boolean): string {
  const opts = [
    "all_varchar = true", "union_by_name = true", `header = ${d.header}`, `delim = ${sqlString(d.delimiter)}`, `quote = ${sqlString(d.quote)}`,
    `escape = ${sqlString(d.escape)}`, `skip = ${d.skip}`, `encoding = ${sqlString(d.encoding)}`,
  ];
  if (withSource) opts.push(`filename = ${sqlString(SRC)}`);
  if (d.gzip) opts.push(`compression = 'gzip'`);
  return `read_csv([${paths.map(sqlString).join(", ")}], ${opts.join(", ")})`;
}

const dialectKey = (d: CsvDialect) => JSON.stringify([d.encoding, d.delimiter, d.quote, d.escape, d.header, d.skip, d.gzip]);

// ---------------------------------------------------------------------------------------------------------
// Parquet type normalization (§7): the file's types, on croft's lattice

/** The expression and type a Parquet column is read as. */
export function parquetColumn(name: string, duckType: string): { expr: string; type: string } {
  const ref = ident(name);
  const t = normalizeType(duckType);
  if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER)$/.test(t)) return { expr: `CAST(${ref} AS BIGINT)`, type: "BIGINT" };
  if (t === "UBIGINT") return { expr: `CAST(${ref} AS HUGEINT)`, type: "HUGEINT" };
  // Through the float's own shortest text: 0.1::FLOAT is 0.10000000149011612 as a DOUBLE, but '0.1' as text.
  if (t === "FLOAT") return { expr: `CAST(CAST(${ref} AS VARCHAR) AS DOUBLE)`, type: "DOUBLE" };
  if (t === "UUID" || t.startsWith("ENUM")) return { expr: `CAST(${ref} AS VARCHAR)`, type: "VARCHAR" };
  if (/^TIMESTAMP_(S|MS|NS)$/.test(t)) return { expr: `CAST(${ref} AS TIMESTAMP)`, type: "TIMESTAMP" };
  if (t.startsWith("STRUCT") || t.startsWith("MAP") || t.startsWith("UNION") || /\[\d*\]$/.test(t)) return { expr: `CAST(${ref} AS JSON)`, type: "JSON" };
  return { expr: ref, type: t };
}

// ---------------------------------------------------------------------------------------------------------
// Staged rows (JSON files, map())

interface StagedRowsInput {
  load: Present[];
  format: FileFormat;
  map?: (row: Row) => Row | null;
  db: Sql | null;
  asset: string;
  runId: string;
  abort: () => void;
  columnTypes?: Record<string, string>;
}

const CHUNK = 1000;

async function* stagedRows(o: StagedRowsInput): AsyncGenerator<Row[]> {
  for (const p of o.load) {
    o.abort();
    if (!p.local || p.size === 0) continue;
    let n = 0;
    for await (const chunk of fileRows(p, o)) {
      const out: Row[] = [];
      for (const raw of chunk) {
        n++;
        if (!isPlainRow(raw)) {
          throw new CroftError("ROW_NOT_OBJECT", {
            message: `row ${n} of ${p.path} is ${article(typeLabel(raw))}, not an object`,
            hint: "a JSON file holds one object per row: an array of objects, or one object per line (NDJSON)",
            asset: o.asset, runId: o.runId, details: { file: p.path, row: n, type: typeLabel(raw) },
          });
        }
        const row = o.map ? applyMap(o.map, raw, p.path, n, o) : raw;
        if (row === null) continue;
        out.push({ ...row, [STAGE_FILE]: p.path } as Row);
      }
      if (out.length) yield out;
    }
  }
}

function applyMap(map: (row: Row) => Row | null, row: Row, file: string, n: number, o: { asset: string; runId: string }): Row | null {
  let out: unknown;
  try {
    out = map(row);
  } catch (e) {
    throw new CroftError("ASSET_CODE_ERROR", {
      message: `map() threw on row ${n} of ${file}: ${e instanceof Error ? e.message : String(e)}`,
      hint: "fix map() in the asset; details.input is the row it received",
      asset: o.asset, runId: o.runId,
      details: { file, row: n, input: preview(row), error: e instanceof Error ? (e.stack ?? e.message) : String(e) },
    });
  }
  if (out === null) return null;
  if (!isPlainRow(out)) {
    throw new CroftError("ROW_NOT_OBJECT", {
      message: `map() returned ${article(typeLabel(out))} for row ${n} of ${file}, not an object`,
      hint: out === undefined ? "return the row from map() (or null to drop it); an arrow function with a block body needs `return`" : "map() must return an object (or null to drop the row)",
      asset: o.asset, runId: o.runId, details: { file, row: n, type: typeLabel(out) },
    });
  }
  return out;
}

function isPlainRow(v: unknown): v is Row {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function typeLabel(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return (v as object).constructor?.name ?? "object";
  return typeof v;
}

function article(t: string): string {
  if (/^(null|undefined)$/.test(t)) return t;
  return `${/^[aeiouAEIOU]/.test(t) ? "an" : "a"} ${t}`;
}

function preview(row: unknown): string {
  try {
    const s = JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(row);
  }
}

/** A file's rows as JavaScript objects, in chunks. */
async function* fileRows(p: Present, o: StagedRowsInput): AsyncGenerator<unknown[]> {
  const local = p.local!;
  switch (o.format) {
    case "json":
      yield* jsonRows(local, p.path, o);
      return;
    case "ndjson":
      yield* ndjsonRows(local, p.path, o);
      return;
    case "csv":
    case "tsv": {
      // map() sees the file's own columns, as text (NULL for an empty cell), under their header names.
      let rows: Row[];
      try {
        rows = await o.db!.all<Row>(`SELECT * FROM ${readCsvSql([local], p.csv!, false)}`);
      } catch (e) {
        throw unreadable(o.asset, o.runId, p.path, e, [p]);
      }
      for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
      return;
    }
    case "parquet": {
      let rows: Row[];
      try {
        const desc = await o.db!.all<{ column_name: string; column_type: string }>(`DESCRIBE SELECT * FROM read_parquet(${sqlString(local)})`);
        const cols = desc.map((d) => ({ name: d.column_name, ...parquetColumn(d.column_name, d.column_type) }));
        for (const c of cols) if (o.columnTypes && !(c.name in o.columnTypes)) o.columnTypes[c.name] = c.type;
        const select = cols.length ? cols.map((c) => `${c.expr} AS ${ident(c.name)}`).join(", ") : "*";
        rows = await o.db!.all<Row>(`SELECT ${select} FROM read_parquet(${sqlString(local)})`);
      } catch (e) {
        throw unreadable(o.asset, o.runId, p.path, e, [p]);
      }
      for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
      return;
    }
  }
}

function decodeUtf8(bytes: Uint8Array, file: string, o: { asset: string; runId: string }): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    throw new CroftError("FILE_UNREADABLE", {
      message: `${file} is not valid UTF-8; JSON files must be UTF-8`,
      hint: "re-export the file as UTF-8",
      asset: o.asset, runId: o.runId, details: { file },
    });
  }
}

function fileBytes(local: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(local));
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? Bun.gunzipSync(bytes) : bytes;
}

async function* jsonRows(local: string, file: string, o: StagedRowsInput): AsyncGenerator<unknown[]> {
  const text = decodeUtf8(fileBytes(local), file, o);
  let doc: unknown;
  try {
    doc = parseJsonLossless(text);
  } catch (e) {
    // A .json file holding one object per line is NDJSON.
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length > 1) {
      try {
        yield lines.map((l) => parseJsonLossless(l));
        return;
      } catch { /* report the original error */ }
    }
    throw new CroftError("FILE_UNREADABLE", {
      message: `${file} is not valid JSON: ${(e as Error).message}`,
      hint: "fix the file, or set format: \"ndjson\" if it holds one JSON object per line",
      asset: o.asset, runId: o.runId, details: { file, error: (e as Error).message },
    });
  }
  const rows = Array.isArray(doc) ? doc : [doc];
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
}

async function* ndjsonRows(local: string, file: string, o: StagedRowsInput): AsyncGenerator<unknown[]> {
  const gzip = await isGzip(local);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buf = "";
  let line = 0;
  let batch: unknown[] = [];
  const parse = (text: string) => {
    line++;
    const t = (line === 1 ? text.replace(/^﻿/, "") : text).replace(/\r$/, "");
    if (t.trim() === "") return;
    try {
      batch.push(parseJsonLossless(t));
    } catch (e) {
      throw new CroftError("FILE_UNREADABLE", {
        message: `line ${line} of ${file} is not valid JSON: ${(e as Error).message}`,
        hint: "an NDJSON file holds one JSON object per line; fix or remove that line",
        asset: o.asset, runId: o.runId, details: { file, line, text: t.slice(0, 200) },
      });
    }
  };
  try {
    for await (const chunk of byteStream(local, gzip)) {
      buf += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n", start)) {
        parse(buf.slice(start, i));
        start = i + 1;
      }
      buf = buf.slice(start);
      if (batch.length >= CHUNK) {
        yield batch;
        batch = [];
      }
    }
    buf += decoder.decode();
  } catch (e) {
    if (e instanceof CroftError) throw e;
    throw new CroftError("FILE_UNREADABLE", {
      message: `${file} is not valid UTF-8; NDJSON files must be UTF-8`,
      hint: "re-export the file as UTF-8",
      asset: o.asset, runId: o.runId, details: { file, error: (e as Error).message },
    });
  }
  if (buf !== "") parse(buf);
  if (batch.length) yield batch;
}

// ---------------------------------------------------------------------------------------------------------
// buildFileBatch

/**
 * Inside the write lease: the typed TEMP table for write.ts. Run it before writeBatch in the same transaction.
 * Throws TYPE_CONFLICT, TYPE_PIN_VIOLATION, PIN_ROUNDED, DECIMAL_PRECISION_UNSUPPORTED, FILE_UNREADABLE.
 */
export async function buildFileBatch(tx: Sql, input: BuildFileBatchInput): Promise<FileBatch> {
  const { extract } = input;
  const asset = extract.asset;
  const replaceFiles = extract.incremental ? [...extract.load] : undefined;
  let batch: TypedBatchResult;
  let formats: Record<string, string> = {};
  if (extract.staged && (extract.format === "json" || extract.format === "ndjson")) {
    // JSON goes through exactly the API pipeline (§3b).
    const manifest = readStageManifest(extract.stageDir);
    batch = await buildTypedBatch(tx, { manifest, knownColumns: input.knownColumns, pins: input.pins, readBy: input.readBy, source: "json" });
  } else {
    const raw = extract.staged ? await stagedRaw(tx, extract) : extract.format === "parquet" ? await parquetRaw(tx, extract, input.knownColumns) : await csvRaw(tx, extract, input.knownColumns);
    const typed = await typeRaw(tx, raw, { asset, knownColumns: input.knownColumns, pins: input.pins, timezone: input.timezone, readBy: input.readBy });
    batch = typed.batch;
    formats = typed.formats;
  }
  const warnings = [...extract.warnings, ...batch.warnings];
  const dup = await duplicateRows(tx, extract, batch);
  if (dup) warnings.push(dup);
  return { ...batch, warnings, formats, ...(replaceFiles ? { replaceFiles } : {}) };
}

/** A raw relation for typing: _croft_seq, one column per source column, _file. */
interface RawRelation {
  view: string;
  rows: number;
  columns: RawCol[];
  hasFile: boolean;
  /** TEMP objects to drop once the typed table exists. */
  cleanup: { kind: "VIEW" | "TABLE"; ref: string }[];
  warnings: Problem[];
}

interface RawCol {
  /** Column in the raw view (already cleaned, §7 "Column names"). */
  name: string;
  sourceName: string;
  /** csv: text typed by the CSV rules; typed: a value of `type` (Parquet); json: a JSON value typed by §7. */
  mode: "csv" | "typed" | "json";
  /** The raw column is a staged JSON value (its text is `->>'$'`). */
  staged: boolean;
  /** typed: the value's type. */
  type?: string;
  /** staged: the JSON kinds classify() counted. */
  counts?: KindCounts;
  unsafeIntegers?: number;
}

function loadedFiles(extract: FileExtract): FileStatus[] {
  const want = new Set(extract.load);
  return extract.files.filter((f) => want.has(f.path) && f.status !== "gone");
}

/** CASE mapping snapshot paths (the reader's file column) back to file identities. */
function fileCase(files: FileStatus[], col: string): string {
  const arms = files.filter((f) => f.local).map((f) => `WHEN ${sqlString(f.local!)} THEN ${sqlString(f.path)}`);
  return arms.length ? `(CASE ${col} ${arms.join(" ")} END)` : "CAST(NULL AS VARCHAR)";
}

const rawTextName = (asset: string) => `_croft_filetext_${asset}`;
const rawViewName = (asset: string) => `_croft_fileraw_${asset}`;

/** Build the raw view over a TEMP table of source columns (+ SRC), naming columns per §7. */
async function rawView(tx: Sql, o: { asset: string; text: string; sourceCols: string[]; files: FileStatus[]; knownColumns: readonly KnownColumn[];
  mode: (source: string) => Pick<RawCol, "mode" | "type"> }): Promise<RawRelation> {
  const namer = new ColumnNamer(o.knownColumns.map((k) => ({ name: k.name, sourceName: k.sourceName ?? null })), o.asset);
  const names = namer.resolveRow(o.sourceCols);
  const view = rawViewName(o.asset);
  // Rows inserted by this transaction have transaction-local rowids (from 36028797018960000), contiguous in
  // insertion order, i.e. file order [V]: _croft_seq counts from 1 from the first of them.
  const [{ n, base } = { n: 0, base: null }] = await tx.all<{ n: number; base: string | null }>(
    `SELECT count(*)::BIGINT AS n, min(rowid)::VARCHAR AS base FROM ${tempRef(o.text)}`);
  const seq = `(rowid - ${/^\d+$/.test(base ?? "") ? base : "0"} + 1)::BIGINT`;
  const select = [`${seq} AS ${ident(RESERVED.seq)}`, ...o.sourceCols.map((s, i) => `${ident(s)} AS ${ident(names[i]!)}`),
    `${fileCase(o.files, ident(SRC))} AS ${ident(RESERVED.file)}`];
  await tx.exec(`CREATE OR REPLACE TEMP VIEW ${ident(view)} AS SELECT ${select.join(", ")} FROM ${tempRef(o.text)}`);
  return {
    view, rows: Number(n), hasFile: true, cleanup: [{ kind: "VIEW", ref: ident(view) }, { kind: "TABLE", ref: tempRef(o.text) }], warnings: [...namer.warnings],
    columns: o.sourceCols.map((s, i) => ({ name: names[i]!, sourceName: s, staged: false, ...o.mode(s) })),
  };
}

/** Rewrite snapshot paths in a DuckDB message to file identities. */
function readError(asset: string, e: unknown, files: FileStatus[]): unknown {
  if (e instanceof CroftError) return e;
  const hit = files.find((f) => f.local && String((e as Error)?.message ?? e).includes(f.local));
  return unreadable(asset, undefined, hit?.path ?? files.map((f) => f.path).join(", "), e, files);
}

async function csvRaw(tx: Sql, extract: FileExtract, knownColumns: readonly KnownColumn[]): Promise<RawRelation> {
  const files = loadedFiles(extract);
  const readable = files.filter((f) => f.local && f.size > 0 && f.csv);
  // Consecutive files with one dialect share a read_csv; the order of files is kept.
  const groups: { dialect: CsvDialect; paths: string[] }[] = [];
  for (const f of readable) {
    const last = groups.at(-1);
    if (last && dialectKey(last.dialect) === dialectKey(f.csv!)) last.paths.push(f.local!);
    else groups.push({ dialect: f.csv!, paths: [f.local!] });
  }
  const text = rawTextName(extract.asset);
  try {
    const union: string[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      const desc = await tx.all<{ column_name: string }>(`DESCRIBE SELECT * FROM ${readCsvSql(g.paths, g.dialect, true)}`);
      for (const d of desc) {
        if (d.column_name === SRC || seen.has(d.column_name.toLowerCase())) continue;
        seen.add(d.column_name.toLowerCase());
        union.push(d.column_name);
      }
    }
    await tx.exec(`CREATE OR REPLACE TEMP TABLE ${ident(text)} (${[...union, SRC].map((c) => `${ident(c)} VARCHAR`).join(", ")})`);
    let left = extract.previewRows;
    for (const g of groups) {
      if (left !== undefined && left <= 0) break;
      const [r] = await tx.all<{ Count: number }>(
        `INSERT INTO ${tempRef(text)} BY NAME SELECT * FROM ${readCsvSql(g.paths, g.dialect, true)}${left !== undefined ? ` LIMIT ${left}` : ""}`);
      if (left !== undefined) left -= Number(r?.Count ?? 0);
    }
    return await rawView(tx, { asset: extract.asset, text, sourceCols: union, files, knownColumns, mode: () => ({ mode: "csv" }) });
  } catch (e) {
    throw readError(extract.asset, e, files);
  }
}

async function parquetRaw(tx: Sql, extract: FileExtract, knownColumns: readonly KnownColumn[]): Promise<RawRelation> {
  const files = loadedFiles(extract);
  const readable = files.filter((f) => f.local && f.size > 0);
  const text = rawTextName(extract.asset);
  try {
    let cols: { name: string; expr: string; type: string }[] = [];
    if (readable.length === 0) {
      await tx.exec(`CREATE OR REPLACE TEMP TABLE ${ident(text)} (${ident(SRC)} VARCHAR)`);
    } else {
      const from = `read_parquet([${readable.map((f) => sqlString(f.local!)).join(", ")}], union_by_name = true, filename = ${sqlString(SRC)})`;
      const desc = await tx.all<{ column_name: string; column_type: string }>(`DESCRIBE SELECT * FROM ${from}`);
      cols = desc.filter((d) => d.column_name !== SRC).map((d) => ({ name: d.column_name, ...parquetColumn(d.column_name, d.column_type) }));
      const select = [...cols.map((c) => `${c.expr} AS ${ident(c.name)}`), ident(SRC)].join(", ");
      const limit = extract.previewRows !== undefined ? ` LIMIT ${Math.max(0, extract.previewRows)}` : "";
      await tx.exec(`CREATE OR REPLACE TEMP TABLE ${ident(text)} AS SELECT ${select} FROM ${from}${limit}`);
    }
    const typeOf = new Map(cols.map((c) => [c.name, c.type]));
    return await rawView(tx, { asset: extract.asset, text, sourceCols: cols.map((c) => c.name), files, knownColumns, mode: (s) => ({ mode: "typed", type: typeOf.get(s)! }) });
  } catch (e) {
    throw readError(extract.asset, e, files);
  }
}

const STRINGISH: ReadonlySet<ValueKind> = new Set(["null", "string", "iso_instant", "iso_naive", "iso_date"]);

/** The JSON kinds a Parquet value of `type` has after the "ts" rendering and canonical JSON of staging. */
function hintKinds(type: string): ReadonlySet<ValueKind> | "any" {
  switch (typeFamily(type)) {
    case "boolean": return new Set(["boolean"]);
    case "integer": return new Set(["integer"]);
    case "hugeint": return new Set(["integer", "bigint"]);
    case "double": return new Set(["integer", "bigint", "float"]);
    case "decimal": return (decimalParts(type)?.precision ?? 18) <= 15 ? new Set(["integer", "float"]) : new Set(["string", "integer", "bigint", "float"]);
    case "varchar": return new Set(["string", "iso_instant", "iso_naive", "iso_date"]);
    case "date": return new Set(["iso_date"]);
    case "timestamp": return new Set(["iso_naive"]);
    case "timestamptz": return new Set(["iso_instant"]);
    case "json": return "any";
    default: return new Set(["string"]);
  }
}

/**
 * Staged rows (map() output): each column is typed by the rules of the values it holds. Columns map() left as the
 * CSV's text are typed by the CSV text rules; Parquet columns it left alone keep their Parquet type; anything map()
 * produced itself (numbers, booleans, objects, renamed fields) follows the JSON rules of API rows.
 */
async function stagedRaw(tx: Sql, extract: FileExtract): Promise<RawRelation> {
  const manifest = readStageManifest(extract.stageDir);
  const raw = await stageRaw(tx, manifest);
  const sourceOf = new Map(manifest.columns.map((c) => [c.name, c.sourceName]));
  const classified = await classify(tx, raw.table, raw.columns);
  const columns: RawCol[] = classified.map((c) => {
    const sourceName = sourceOf.get(c.name) ?? c.name;
    const kinds = Object.keys(c.counts) as ValueKind[];
    const base = { name: c.name, sourceName, staged: true, counts: c.counts, unsafeIntegers: c.unsafeIntegers };
    if ((extract.format === "csv" || extract.format === "tsv") && kinds.every((k) => STRINGISH.has(k))) return { ...base, mode: "csv" as const };
    const hint = extract.format === "parquet" ? extract.columnTypes?.[sourceName] : undefined;
    if (hint) {
      const allowed = hintKinds(hint);
      if (allowed === "any" || kinds.every((k) => k === "null" || allowed.has(k))) return { ...base, mode: "typed" as const, type: normalizeType(hint) };
    }
    return { ...base, mode: "json" as const };
  });
  return {
    view: raw.table, rows: raw.rows, columns, hasFile: raw.hasFile, cleanup: [{ kind: raw.kind === "view" ? "VIEW" : "TABLE", ref: ident(raw.table) }],
    warnings: [...manifest.warnings],
  };
}

// --- typing -----------------------------------------------------------------------------------------------

/** The value's text: CSV cells with only whitespace are NULL (§7 "empty → NULL"). */
function textOf(c: RawCol): string {
  const ref = ident(c.name);
  const base = c.staged ? `(${ref}->>'$')` : c.mode === "typed" ? `CAST(${ref} AS VARCHAR)` : ref;
  return c.mode === "csv" ? `(CASE WHEN trim(${base}) = '' THEN NULL ELSE ${base} END)` : base;
}

/** The value as JSON, for a JSON target. */
function jsonOf(c: RawCol): string {
  const ref = ident(c.name);
  if (c.mode === "csv") return `to_json(${textOf(c)})`;
  if (c.staged) return ref;
  return normalizeType(c.type ?? "") === "JSON" ? ref : `to_json(${ref})`;
}

/** The value kind of a typed (Parquet) value. */
function typedKind(type: string): ValueKind {
  switch (typeFamily(type)) {
    case "boolean": return "boolean";
    case "integer": return "integer";
    case "hugeint": return "bigint";
    case "double": case "decimal": return "float";
    case "date": return "iso_date";
    case "timestamp": return "iso_naive";
    case "timestamptz": return "iso_instant";
    case "json": return "object";
    default: return "string";
  }
}

/** Formats apply to text; a typed value is cast as it is. */
const formatFor = (c: RawCol | undefined, d: ColumnDecision) => (c && c.mode === "typed" ? undefined : d.format);

/** A typed column read as-is: no cast, nothing to verify. */
const identity = (c: RawCol, target: string) => c.mode === "typed" && !c.staged && normalizeType(c.type ?? "") === normalizeType(target);

interface TypeRawOptions { asset: string; knownColumns: readonly KnownColumn[]; pins?: Record<string, Pin>; timezone: string; readBy?: string[] }

async function typeRaw(tx: Sql, raw: RawRelation, o: TypeRawOptions): Promise<{ batch: TypedBatchResult; formats: Record<string, string> }> {
  const { asset } = o;
  const warnings: Problem[] = [...raw.warnings];
  const known = await reconcileKnown(tx, asset, o.knownColumns, warnings);

  // Kinds: CSV text by the CSV rules (one scan), typed values by their type (one scan), staged JSON as counted.
  const csvCols = raw.columns.filter((c) => c.mode === "csv");
  let csvStats = new Map<string, CsvStats>();
  if (csvCols.length > 0) {
    if (csvCols.some((c) => c.staged)) {
      const txt = `${raw.view}_text`;
      await tx.exec(`CREATE OR REPLACE TEMP VIEW ${ident(txt)} AS SELECT ${csvCols.map((c) => `(${ident(c.name)}->>'$') AS ${ident(c.name)}`).join(", ")} FROM ${ident(raw.view)}`);
      raw.cleanup.unshift({ kind: "VIEW", ref: ident(txt) });
      csvStats = await classifyCsv(tx, txt, csvCols.map((c) => c.name));
    } else {
      csvStats = await classifyCsv(tx, raw.view, csvCols.map((c) => c.name));
    }
  }
  const typedCols = raw.columns.filter((c) => c.mode === "typed" && !c.staged);
  const typedCounts = new Map<string, KindCounts>();
  if (typedCols.length > 0) {
    const aggs = typedCols.flatMap((c, i) => {
      const r = ident(c.name);
      const out = [`count(${r})::BIGINT AS "v${i}"`];
      if (normalizeType(c.type ?? "") === "JSON") out.push(`count(*) FILTER (WHERE json_type(${r}) = 'ARRAY')::BIGINT AS "a${i}"`);
      return out;
    });
    const [row = {}] = await tx.all<Record<string, number>>(`SELECT count(*)::BIGINT AS n, ${aggs.join(", ")} FROM ${ident(raw.view)}`);
    const n = Number(row.n ?? 0);
    typedCols.forEach((c, i) => {
      const values = Number(row[`v${i}`] ?? 0);
      const arrays = Number(row[`a${i}`] ?? 0);
      const counts: KindCounts = {};
      const kind = typedKind(c.type!);
      if (kind === "object") {
        if (values - arrays > 0) counts.object = values - arrays;
        if (arrays > 0) counts.array = arrays;
      } else if (values > 0) counts[kind] = values;
      if (n - values > 0) counts.null = n - values;
      typedCounts.set(c.name, counts);
    });
  }

  const incoming: IncomingColumn[] = raw.columns.map((c) => {
    if (c.mode === "csv") {
      const stats = csvStats.get(c.name)!;
      return { name: c.name, sourceName: c.sourceName, counts: csvValueKinds(stats), unsafeIntegers: stats.unsafeIntegers, newType: csvColumnType(stats, c.name, { timezone: o.timezone }) };
    }
    if (c.mode === "typed") {
      let counts = typedCounts.get(c.name);
      if (!counts) {
        // A staged Parquet column: its nulls as counted, its values of the hinted type.
        const nulls = c.counts?.null ?? 0;
        const values = Object.entries(c.counts ?? {}).reduce((s, [k, v]) => s + (k === "null" ? 0 : (v ?? 0)), 0);
        counts = {};
        if (values > 0) counts[typedKind(c.type!)] = values;
        if (nulls > 0) counts.null = nulls;
      }
      const newType: NewType = { type: normalizeType(c.type!), pending: false, warnings: [] };
      return { name: c.name, sourceName: c.sourceName, counts, newType };
    }
    return { name: c.name, sourceName: c.sourceName, counts: c.counts ?? {}, unsafeIntegers: c.unsafeIntegers ?? 0 };
  });

  const pins = normalizePins(o.pins as Record<string, string | Pin> | undefined);
  const plan = evolve(known, incoming, pins);
  const colOf = new Map(raw.columns.map((c) => [c.name.toLowerCase(), c]));
  const col = (d: ColumnDecision) => colOf.get(d.column.toLowerCase());
  const incomingOf = new Map(incoming.map((c) => [c.name.toLowerCase(), c]));

  for (const d of plan) {
    const c = col(d);
    if (!c) continue;
    // A pinned number in a CSV column of money values: parse the money, then verify it fits the pin.
    const fam = d.target ? typeFamily(d.target) : "other";
    if (c.mode === "csv" && d.pinned && !d.format && (csvStats.get(c.name)?.counts.money ?? 0) > 0 && (fam === "decimal" || fam === "double" || fam === "integer" || fam === "hugeint")) {
      d.format = "money";
    }
    // Fractional JSON numbers under a wide DECIMAL pin have already lost digits (§7 "Money on JSON sources").
    if (c.mode === "json" && d.pinned && d.target) {
      const dec = decimalParts(d.target);
      if (dec && dec.precision > 15 && (incomingOf.get(c.name.toLowerCase())?.counts.float ?? 0) > 0) {
        throw new CroftError("DECIMAL_PRECISION_UNSUPPORTED", {
          message: `column ${d.column} is pinned ${d.target}, but map() returns its values as JavaScript numbers, which carry only about 15 significant digits`,
          hint: `return ${d.column} from map() as a string with every digit, or pin DECIMAL with precision 15 or less`,
          asset, details: { column: d.column, type: d.target, precision: dec.precision },
        });
      }
    }
  }

  for (const d of plan) {
    if (d.decision !== "conflict") continue;
    const c = col(d)!;
    const stored = d.existing ?? d.target!;
    const s = await sampleLosses(tx, raw.view, c, stored, formatFor(c, d));
    d.badRows = s.n || undefined;
    d.samples = s.samples.map((x) => x.value);
    d.sampleRows = s.samples;
    throw fileTypeConflict(asset, d, o.readBy, `${s.n || "some"} value${s.n === 1 ? "" : "s"} of ${describeKinds(d.conflictKinds ?? [])} do not fit it`, stored);
  }

  // Widening an integer column to DOUBLE needs every stored value to survive `v::DOUBLE::HUGEINT = v` (it catches
  // 9007199254740993 [V]); incoming values are covered by the loss check below.
  for (const d of plan) {
    if (d.decision !== "widen" || d.proof !== "double" || (await realColumns(tx, asset)) === null) continue;
    const from = tableRef(await currentDatabase(tx), asset);
    const ref = `${from}.${ident(d.column)}`;
    const bad = `${ref} IS NOT NULL AND TRY_CAST(TRY_CAST(${ref} AS DOUBLE) AS HUGEINT) IS DISTINCT FROM TRY_CAST(${ref} AS HUGEINT)`;
    const rows = await tx.all<{ v: string; n: number }>(`SELECT CAST(${ref} AS VARCHAR) AS v, count(*) OVER ()::BIGINT AS n FROM ${from} WHERE ${bad} LIMIT 5`);
    if (rows.length === 0) continue;
    const n = Number(rows[0]!.n);
    const conflict: ColumnDecision = { ...d, decision: "conflict", target: d.existing ?? undefined, badRows: n, samples: rows.map((r) => r.v) };
    throw fileTypeConflict(asset, conflict, o.readBy, `widening it to DOUBLE would change ${n} stored value${n === 1 ? "" : "s"} beyond ±2^53`, d.existing ?? "BIGINT");
  }

  // Verify: no value may change on the way in (one scan for every column that is cast).
  const checked = plan.filter((d) => {
    const c = col(d);
    if (!d.present || !c || !d.target || identity(c, d.target)) return false;
    const fam = typeFamily(d.target);
    return fam !== "varchar" && fam !== "json";
  });
  if (checked.length > 0) {
    const inner = checked.map((d, i) => `${textOf(col(d)!)} AS t${i}`).join(", ");
    const mid = checked.map((d, i) => `t${i}, ${castExpr(`t${i}`, d.target!, { format: formatFor(col(d), d) })} AS y${i}`).join(", ");
    const aggs = checked.flatMap((d, i) => [
      `count(*) FILTER (WHERE ${lossExpr(`t${i}`, `y${i}`, d.target!, { format: formatFor(col(d), d) })})::BIGINT AS "l${i}"`,
      `count(*) FILTER (WHERE t${i} IS NOT NULL AND y${i} IS NULL)::BIGINT AS "n${i}"`,
    ]);
    const [counts = {}] = await tx.all<Record<string, number>>(`SELECT ${aggs.join(", ")} FROM (SELECT ${mid} FROM (SELECT ${inner} FROM ${ident(raw.view)}))`);
    for (let i = 0; i < checked.length; i++) {
      const lost = Number(counts[`l${i}`] ?? 0);
      if (lost === 0) continue;
      const d = checked[i]!;
      const c = col(d)!;
      const s = await sampleLosses(tx, raw.view, c, d.target!, formatFor(c, d));
      d.badRows = lost;
      d.samples = s.samples.map((x) => x.value);
      d.sampleRows = s.samples;
      throw fileLossError(asset, d, Number(counts[`n${i}`] ?? 0), o.readBy, formatFor(c, d));
    }
  }

  // The typed TEMP table.
  const typed = typedTableName(asset);
  const select = [ident(RESERVED.seq)];
  for (const d of plan) {
    const target = normalizeType(d.target ?? d.existing!);
    const c = col(d);
    let expr: string;
    if (!d.present || !c) expr = `CAST(NULL AS ${target})`;
    else if (identity(c, target)) expr = ident(c.name);
    else expr = castExpr(textOf(c), target, { format: formatFor(c, d), json: jsonOf(c) });
    select.push(`${expr} AS ${ident(d.column)}`);
  }
  if (raw.hasFile) select.push(ident(RESERVED.file));
  await tx.exec(`CREATE OR REPLACE TEMP TABLE ${ident(typed)} AS SELECT ${select.join(", ")} FROM ${ident(raw.view)}`);
  for (const obj of raw.cleanup) await tx.exec(`DROP ${obj.kind} IF EXISTS ${obj.ref}`);

  const formats: Record<string, string> = {};
  for (const d of plan) {
    const c = col(d);
    if (c?.mode === "csv" && !d.pinned && d.format) formats[d.column] = d.format;
  }
  for (const d of plan) warnings.push(...d.warnings.map((w) => ({ ...w, asset: w.asset ?? asset })));
  return { batch: { temp: typed, columns: plan, rows: raw.rows, warnings }, formats };
}

/** Rows whose value does not survive the cast to `type` (count and 5 samples in row order). */
async function sampleLosses(tx: Sql, view: string, c: RawCol, type: string, format: string | undefined): Promise<{ n: number; samples: { row: number; value: unknown; typed?: unknown }[] }> {
  const y = castExpr("t", type, { format });
  const where = typeFamily(type) === "varchar" || typeFamily(type) === "json" ? "false" : lossExpr("t", "y", type, { format });
  let rows = await tx.all<{ seq: number; value: string | null; typed: string | null; n: number }>(
    `SELECT seq, t AS value, CAST(y AS VARCHAR) AS typed, count(*) OVER ()::BIGINT AS n FROM (SELECT seq, t, ${y} AS y FROM ` +
      `(SELECT ${ident(RESERVED.seq)}::BIGINT AS seq, ${textOf(c)} AS t FROM ${ident(view)})) WHERE ${where} ORDER BY seq LIMIT 5`);
  if (rows.length === 0) {
    // Every value happens to cast (a text column of numbers into a number column): show values anyway.
    rows = await tx.all(`SELECT ${ident(RESERVED.seq)}::BIGINT AS seq, ${textOf(c)} AS value, NULL AS typed, 0 AS n FROM ${ident(view)} WHERE ${textOf(c)} IS NOT NULL ORDER BY 1 LIMIT 5`);
  }
  return { n: Number(rows[0]?.n ?? 0), samples: rows.map((r) => ({ row: Number(r.seq), value: r.value, ...(r.typed !== null ? { typed: r.typed } : {}) })) };
}

function sampleText(samples: unknown[] | undefined): string {
  const shown = (samples ?? []).map((s) => (typeof s === "string" ? JSON.stringify(s) : String(s)));
  return shown.length ? ` (e.g. ${shown.join(", ")})` : "";
}

/** Fixes for a file ingest, in the order of §7: clean the value in map(), pin a type (with a format), pin VARCHAR. */
function fileFixes(d: ColumnDecision, stored: string): Fix[] {
  const key = jsKey(d.column);
  const acc = /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(d.sourceName) ? `row.${d.sourceName}` : `row[${JSON.stringify(d.sourceName)}]`;
  const fam = typeFamily(stored);
  const temporal = fam === "date" || fam === "timestamp" || fam === "timestamptz";
  let clean: string;
  if (fam === "integer" || fam === "hugeint" || fam === "double" || fam === "decimal") clean = `${key}: ${acc} == null || ${acc} === "" ? null : Number(String(${acc}).replace(/[^0-9.-]/g, ""))`;
  else if (temporal) clean = `${key}: ${acc} ? new Date(${acc}) : null   // a Date is stored as an ISO instant`;
  else clean = `${key}: ${acc} == null ? null : String(${acc})`;
  return [
    { kind: "manual", description: `clean the value in the asset's map(): map: (row) => ({ ...row, ${clean} })` },
    {
      kind: "manual",
      description: temporal ? `pin the type with the file's date format: columns: { ${key}: { type: "${stored}", format: "%d/%m/%Y" } }` : `pin a type: columns: { ${key}: "${stored}" }`,
    },
    { kind: "manual", description: `pin VARCHAR to keep the text on purpose: columns: { ${key}: "VARCHAR" }; min, max and ORDER BY then compare as text ('9' > '10')` },
  ];
}

function fileTypeConflict(asset: string, d: ColumnDecision, readBy: string[] | undefined, what: string, stored: string): CroftError {
  const fixes = fileFixes(d, stored);
  const down = readBy?.length ? ` Read by ${readBy.join(", ")}.` : "";
  return new CroftError("TYPE_CONFLICT", {
    message: `column ${d.column} is ${stored}${d.format && d.format !== "money" ? ` (format ${d.format})` : ""}, but ${what}${sampleText(d.samples)}.${down}`,
    hint: "the load was rolled back; fix it in order: clean the value in map(), pin a type with a format, or pin VARCHAR",
    effect: "nothing was written; downstream assets keep their current data",
    asset, fix: fixes[0],
    details: {
      column: d.column, sourceName: d.sourceName, storedType: stored, incoming: d.incoming, conflictKinds: d.conflictKinds ?? [],
      format: d.format ?? null, badRows: d.badRows ?? null, samples: d.sampleRows ?? d.samples, readBy: readBy ?? [], fixes,
    },
  });
}

function fileLossError(asset: string, d: ColumnDecision, nullCount: number, readBy: string[] | undefined, format: string | undefined): CroftError {
  const target = d.target!;
  const n = d.badRows ?? 0;
  const rows = `${n} value${n === 1 ? "" : "s"}`;
  const details = {
    column: d.column, sourceName: d.sourceName, type: target, storedType: d.existing, format: format ?? null, incoming: d.incoming, badRows: n,
    samples: d.sampleRows ?? d.samples, readBy: readBy ?? [],
  };
  if (d.pinned) {
    if (decimalParts(target) && nullCount === 0) {
      return new CroftError("PIN_ROUNDED", {
        message: `column ${d.column} is pinned ${target}, and ${rows} would be rounded to fit it${sampleText(d.samples)}`,
        hint: `widen the pin's scale (e.g. DECIMAL(18,${(decimalParts(target)!.scale) + 2})), or round the values in map() on purpose`,
        effect: "nothing was written", asset, details,
      });
    }
    return new CroftError("TYPE_PIN_VIOLATION", {
      message: `column ${d.column} is pinned ${target}${format && format !== "money" ? ` with format ${format}` : ""}, but ${rows} do not cast to it exactly${sampleText(d.samples)}`,
      hint: "clean the values in map(), change the pin (a date pin needs the file's format), or pin VARCHAR to keep them as text",
      effect: "nothing was written", asset, details,
    });
  }
  const verb = n === 1 ? "does not" : "do not";
  const how = format && format !== "money" ? `${verb} parse with its format` : format === "money" ? `${verb} fit it as money` : n === 1 ? "would change on the way in" : "would change on the way in";
  return fileTypeConflict(asset, { ...d }, readBy, `${rows} ${how}`, target);
}

/** _croft.columns corrected by the real table (DuckDB wins), as cast.ts does for API rows. */
async function reconcileKnown(tx: Sql, table: string, known: readonly KnownColumn[], warnings: Problem[], asset = table): Promise<KnownColumn[]> {
  const real = await realColumns(tx, table);
  if (real === null) return [...known];
  const realBy = new Map(real.map((c) => [c.name.toLowerCase(), c]));
  const knownBy = new Map(known.map((c) => [c.name.toLowerCase(), c]));
  const changes: string[] = [];
  const out: KnownColumn[] = [];
  for (const k of known) {
    const r = realBy.get(k.name.toLowerCase());
    if (!r) {
      changes.push(`column ${k.name} was dropped`);
      continue;
    }
    if (normalizeType(k.type) !== r.type) {
      changes.push(`column ${k.name} is ${r.type} in the table but ${normalizeType(k.type)} in croft's records`);
      out.push({ ...k, name: r.name, type: r.type, pending: false });
    } else out.push({ ...k, name: r.name });
  }
  for (const r of real) {
    if (knownBy.has(r.name.toLowerCase())) continue;
    if (known.length > 0) changes.push(`column ${r.name} (${r.type}) was added`);
    out.push({ name: r.name, type: r.type, sourceName: r.name, pinned: false, pending: false });
  }
  if (changes.length > 0) {
    warnings.push(problem("TABLE_MODIFIED_OUTSIDE_CROFT", {
      message: `table ${table} was changed outside croft: ${changes.join("; ")}; croft uses the table as it is`,
      hint: "change tables through assets; `croft describe` shows the columns croft now tracks",
      asset, details: { table, changes },
    }));
  }
  return out;
}

// --- DUPLICATE_ROWS_ACROSS_FILES --------------------------------------------------------------------------

/**
 * A keyless incremental file ingest stores every copy of a repeated row. Reported when a row of this load equals a
 * row of another file, in this load or already in the table (files being reloaded excluded: their rows are
 * replaced). Rows compare on the batch's columns; a column only one side has must be NULL on it.
 */
async function duplicateRows(tx: Sql, extract: FileExtract, batch: TypedBatch): Promise<Problem | null> {
  if (!extract.incremental || extract.key.length > 0 || batch.rows === 0) return null;
  const cols = batch.columns.filter((c) => c.incoming.length > 0).map((c) => c.column);
  const temp = tempRef(batch.temp);
  const tempCols = (await readTableSchema(tx, batch.temp, "temp")) ?? [];
  if (!tempCols.some((c) => c.name === RESERVED.file) || cols.length === 0) return null;
  const list = cols.map(ident).join(", ");
  const [within] = await tx.all<{ rows: number; files: string[] | null }>(
    `SELECT coalesce(sum(c), 0)::BIGINT AS rows, first(files) AS files FROM (SELECT count(*) AS c, list(DISTINCT ${ident(RESERVED.file)} ORDER BY ${ident(RESERVED.file)}) AS files ` +
      `FROM ${temp} GROUP BY ${list} HAVING count(DISTINCT ${ident(RESERVED.file)}) > 1)`);
  let rows = Number(within?.rows ?? 0);
  const example = new Set<string>(within?.files ?? []);
  let tableRows = 0;
  const table = await readTableSchema(tx, extract.asset);
  if (table && table.some((c) => c.name.toLowerCase() === RESERVED.file)) {
    const has = new Set(table.map((c) => c.name.toLowerCase()));
    const cmp = cols.map((c) => (has.has(c.toLowerCase())
      ? `CAST(t.${ident(c)} AS VARCHAR) IS NOT DISTINCT FROM CAST(b.${ident(c)} AS VARCHAR)`
      : `b.${ident(c)} IS NULL`));
    const batchSet = new Set(cols.map((c) => c.toLowerCase()));
    for (const c of table) if (!batchSet.has(c.name.toLowerCase()) && c.name.toLowerCase() !== RESERVED.file && c.name.toLowerCase() !== RESERVED.loadedAt) cmp.push(`t.${ident(c.name)} IS NULL`);
    const ref = tableRef(await currentDatabase(tx), extract.asset);
    const [r] = await tx.all<{ n: number; files: string[] | null }>(
      `SELECT count(*)::BIGINT AS n, list(DISTINCT f) AS files FROM (SELECT b.${ident(RESERVED.file)} AS f FROM ${temp} b WHERE EXISTS (SELECT 1 FROM ${ref} t ` +
        `WHERE t.${ident(RESERVED.file)} IS NOT NULL AND NOT list_contains(CAST($1::JSON AS VARCHAR[]), t.${ident(RESERVED.file)}) AND ${cmp.join(" AND ")}))`,
      [JSON.stringify(extract.load)]);
    tableRows = Number(r?.n ?? 0);
    for (const f of r?.files ?? []) example.add(f);
  }
  rows += tableRows;
  if (rows === 0) return null;
  const files = [...example].slice(0, 5);
  return problem("DUPLICATE_ROWS_ACROSS_FILES", {
    message: `${rows} row${rows === 1 ? "" : "s"} loaded from ${files.join(", ")} ${rows === 1 ? "is" : "are"} identical to rows of other files; ${extract.asset} has no key, so every copy is stored`,
    hint: `add a key so a repeated row replaces its earlier copy, e.g. key: ${JSON.stringify(cols[0])} (the column that identifies a row)`,
    asset: extract.asset,
    fix: { kind: "manual", description: "add a key to the asset: key: \"<column that identifies a row>\"" },
    details: { rows, inBatch: Number(within?.rows ?? 0), againstTable: tableRows, files },
  });
}

// ---------------------------------------------------------------------------------------------------------
// _croft.files

async function filesTableExists(sql: Sql): Promise<boolean> {
  const [r] = await sql.all<{ n: number }>(
    `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = '_croft' AND table_name = 'files'`);
  return Number(r?.n ?? 0) > 0;
}

/** The asset's _croft.files rows (empty before the first load). Usable from a read lease. */
export async function readKnownFiles(sql: Sql, asset: string): Promise<KnownFile[]> {
  if (!(await filesTableExists(sql))) return [];
  const rows = await sql.all<{ path: string; size: number | bigint | null; mtime: string | null; etag: string | null; sha256: string | null }>(
    `SELECT path, size, mtime, etag, sha256 FROM _croft.files WHERE asset = $1 ORDER BY path`, [asset]);
  return rows.map((r) => ({ path: r.path, size: Number(r.size ?? 0), mtime: r.mtime === null ? null : String(r.mtime), etag: r.etag, sha256: r.sha256 ?? "" }));
}

/**
 * Record the load in _croft.files, inside the write transaction. Loaded files are upserted with `loadedAt`; files
 * that were unchanged keep their loaded_at and get their current size/mtime/etag. Gone files keep their rows for
 * an incremental ingest (extractFiles reports them); a non-incremental ingest replaced the whole table, so rows of
 * files no longer present are deleted.
 */
export async function recordFiles(tx: Sql, asset: string, extract: FileExtract, loadedAt: string): Promise<void> {
  if (!(await filesTableExists(tx))) await ensureState(tx);
  const loaded = new Set(extract.load);
  for (const f of extract.files) {
    if (f.status === "gone") continue;
    if (loaded.has(f.path)) {
      await tx.exec(
        `INSERT OR REPLACE INTO _croft.files (asset, path, size, mtime, etag, sha256, loaded_at) VALUES ($1, $2, $3, $4::TIMESTAMPTZ, $5, $6, $7::TIMESTAMPTZ)`,
        [asset, f.path, f.size, f.mtime, f.etag, f.sha256, loadedAt]);
    } else {
      await tx.exec(`UPDATE _croft.files SET size = $3, mtime = $4::TIMESTAMPTZ, etag = $5, sha256 = $6 WHERE asset = $1 AND path = $2`,
        [asset, f.path, f.size, f.mtime, f.etag, f.sha256]);
    }
  }
  if (!extract.incremental) {
    const keep = extract.files.filter((f) => f.status !== "gone").map((f) => f.path);
    await tx.exec(`DELETE FROM _croft.files WHERE asset = $1 AND NOT list_contains(CAST($2::JSON AS VARCHAR[]), path)`, [asset, JSON.stringify(keep)]);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Errors

function fileNotFound(asset: string, spec: string, what: string, hint?: string): CroftError {
  return new CroftError("FILE_NOT_FOUND", {
    message: `${asset}: ${what}`,
    hint: hint ?? "check the asset's file: a path or glob relative to the project folder (files/sales/*.csv), or a URL; put input files under files/",
    asset, details: { file: spec },
  });
}

function unreadable(asset: string, runId: string | undefined, file: string, e: unknown, files: FileStatus[]): CroftError {
  let msg = e instanceof Error ? e.message : String(e);
  for (const f of files) if (f.local) msg = msg.replaceAll(f.local, f.path);
  const first = msg.split("\n").filter((l) => l.trim() !== "").slice(0, 6).join("\n");
  return new CroftError("FILE_UNREADABLE", {
    message: `cannot read ${file}: ${first}`,
    hint: /dialect|column|Expected Number|quote|line/i.test(msg)
      ? "the file's rows do not all have the same columns; fix the file, or declare csv: { delimiter, header, skip } in the asset"
      : "check that the file is complete and in the declared format",
    asset, ...(runId ? { runId } : {}), details: { file, duckdb: first },
  });
}

function abortError(signal: AbortSignal, asset: string, runId: string): CroftError {
  if (signal.reason instanceof CroftError) return signal.reason;
  return new CroftError("INTERRUPTED", {
    message: `extraction of ${asset} was interrupted`,
    hint: "nothing was saved; run it again",
    asset, runId,
  });
}

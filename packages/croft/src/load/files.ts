// File ingests (DESIGN.md §3b, §7 "CSV text"). Like every ingest step, two halves:
//
//   extractFiles    no database lock: resolve paths, globs and URLs, download (conditional GET),
//                   fingerprint, decide what to (re)load against _croft.files, stage rows when a
//                   map() hook must run in JavaScript
//   buildFileBatch  inside the write lease: typed TEMP table for write.ts (union_by_name, encoding
//                   fallback, header check, CSV typing rules, Parquet type normalization)
//   recordFiles     inside the same transaction: update _croft.files
//
// INTERFACE STUB: the signatures below are the contract between the file-ingest builder and the run
// engine. The implementation replaces the bodies.
import { CroftError } from "../core/errors.ts";
import type { Problem, Sql } from "../core/types.ts";
import type { FileFormat, FileIngest, Http } from "../types.ts";
import type { TypedBatch } from "./contract.ts";
import type { KnownColumn, Pin } from "./types.ts";

/** One row of _croft.files. */
export interface KnownFile {
  path: string;
  size: number;
  mtime: string;
  etag: string | null;
  sha256: string;
}

export interface FileStatus extends KnownFile {
  status: "new" | "changed" | "unchanged" | "gone";
  /** Set for URL sources; `path` is then the local download under the state folder. */
  url?: string;
}

export interface ExtractFilesInput {
  asset: string;
  config: FileIngest;
  root: string;
  stateDir: string;
  runId: string;
  /** The asset's current _croft.files rows. */
  known: KnownFile[];
  http: Http;
  signal: AbortSignal;
  /** Preview: stop after this many rows. */
  previewRows?: number;
  /** --rebuild: treat every file as changed. */
  rebuild?: boolean;
  log?: (...args: unknown[]) => void;
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
  warnings: Problem[];
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

const notYet = (what: string) =>
  new CroftError("INTERNAL_ERROR", { message: `${what} is not implemented yet`, hint: "file ingests land in phase 1 wave 3" });

export async function extractFiles(_input: ExtractFilesInput): Promise<FileExtract> {
  throw notYet("extractFiles");
}

export async function buildFileBatch(_tx: Sql, _input: BuildFileBatchInput): Promise<FileBatch> {
  throw notYet("buildFileBatch");
}

export async function recordFiles(_tx: Sql, _asset: string, _extract: FileExtract, _loadedAt: string): Promise<void> {
  throw notYet("recordFiles");
}

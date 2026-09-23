// Error code registry. Every problem croft reports carries one of these codes.
// Source of truth: DESIGN.md §9 ("The codes"). A test fails if code is thrown that is not registered here.
import type { Fix, Problem } from "./types.ts";

export const EXIT = {
  OK: 0,
  FAILED: 1,
  INVALID: 2,
  CHECKS_FAILED: 3,
  BUSY: 4,
  NEEDS_HUMAN: 5,
  STILL_RUNNING: 6,
  INTERRUPTED: 130,
} as const;

export type Category = "project" | "run" | "coordination" | "safety" | "environment" | "warning";
export interface CodeInfo { category: Category; severity: Problem["severity"]; exit: number }

export const CODES = {
  DUPLICATE_OUTPUT_COLUMN: { category: "project", severity: "error", exit: 2 },
  DECIMAL_PRECISION_UNSUPPORTED: { category: "project", severity: "error", exit: 2 },
  QUERY_PATH_DENIED: { category: "project", severity: "error", exit: 2 },
  ASSET_INVALID: { category: "project", severity: "error", exit: 2 },
  NAME_INVALID: { category: "project", severity: "error", exit: 2 },
  NAME_RESERVED: { category: "project", severity: "error", exit: 2 },
  NAME_CONFLICT: { category: "project", severity: "error", exit: 2 },
  HEADER_UNKNOWN_KEY: { category: "project", severity: "error", exit: 2 },
  SQL_SYNTAX: { category: "project", severity: "error", exit: 2 },
  SQL_NOT_SELECT: { category: "project", severity: "error", exit: 2 },
  SQL_NOT_ONE_STATEMENT: { category: "project", severity: "error", exit: 2 },
  PIVOT_NEEDS_VALUES: { category: "project", severity: "error", exit: 2 },
  CATALOG_PREFIX: { category: "project", severity: "error", exit: 2 },
  SQL_READS_FILES: { category: "project", severity: "error", exit: 2 },
  INPUT_NEEDS_KEY: { category: "project", severity: "error", exit: 2 },
  UNKNOWN_TABLE: { category: "project", severity: "error", exit: 2 },
  UNKNOWN_COLUMN: { category: "project", severity: "error", exit: 2 },
  QUOTE_IDENTIFIER: { category: "project", severity: "error", exit: 2 },
  UNDECLARED_INPUT: { category: "project", severity: "error", exit: 2 },
  CYCLE: { category: "project", severity: "error", exit: 2 },
  SCHEDULE_INVALID: { category: "project", severity: "error", exit: 2 },
  CHECK_INVALID: { category: "project", severity: "error", exit: 2 },
  SECRET_MISSING: { category: "project", severity: "error", exit: 2 },
  INCREMENTAL_WITHOUT_KEY: { category: "project", severity: "error", exit: 2 },
  CURSOR_TYPE_MISMATCH: { category: "project", severity: "error", exit: 2 },
  ASSET_OPENS_DATABASE: { category: "project", severity: "error", exit: 2 },
  ASSET_RENAMED: { category: "project", severity: "error", exit: 2 },
  QUERY_NOT_SELECT: { category: "project", severity: "error", exit: 2 },
  USAGE_ERROR: { category: "project", severity: "error", exit: 2 },
  PROJECT_NOT_FOUND: { category: "project", severity: "error", exit: 2 },
  QUERY_FAILED: { category: "project", severity: "error", exit: 2 },
  CONFIG_INVALID: { category: "project", severity: "error", exit: 2 },
  DB_NOT_FOUND: { category: "project", severity: "error", exit: 2 },
  HTTP_ERROR: { category: "run", severity: "error", exit: 1 },
  ASSET_CODE_ERROR: { category: "run", severity: "error", exit: 1 },
  ROW_NOT_OBJECT: { category: "run", severity: "error", exit: 1 },
  UNSERIALIZABLE_VALUE: { category: "run", severity: "error", exit: 1 },
  CSV_HEADER_AMBIGUOUS: { category: "run", severity: "error", exit: 1 },
  PIN_ROUNDED: { category: "run", severity: "error", exit: 1 },
  DDL_AFTER_DML: { category: "run", severity: "error", exit: 1 },
  KEYSET_STUCK: { category: "run", severity: "error", exit: 1 },
  TIMEOUT: { category: "run", severity: "error", exit: 1 },
  INTERRUPTED: { category: "run", severity: "error", exit: 130 },
  TYPE_CONFLICT: { category: "run", severity: "error", exit: 1 },
  TYPE_PIN_VIOLATION: { category: "run", severity: "error", exit: 1 },
  KEY_NULL: { category: "run", severity: "error", exit: 1 },
  CHECK_FAILED: { category: "run", severity: "error", exit: 3 },
  SHRINK_GUARD: { category: "run", severity: "error", exit: 1 },
  INGEST_CONFIG_CHANGED: { category: "run", severity: "error", exit: 1 },
  PIN_CHANGES_DATA: { category: "run", severity: "error", exit: 1 },
  UNKNOWN_INPUT_COLUMN: { category: "run", severity: "error", exit: 1 },
  BACKFILL_UNSUPPORTED: { category: "run", severity: "error", exit: 1 },
  BACKFILL_WOULD_DUPLICATE: { category: "run", severity: "error", exit: 1 },
  LARGE_REPROCESS: { category: "run", severity: "error", exit: 1 },
  INTERNAL_ERROR: { category: "run", severity: "error", exit: 1 },
  RUN_CRASHED: { category: "run", severity: "error", exit: 1 },
  FILE_NOT_FOUND: { category: "run", severity: "error", exit: 1 },
  FILE_UNREADABLE: { category: "run", severity: "error", exit: 1 },
  DB_BUSY: { category: "coordination", severity: "error", exit: 4 },
  DB_HELD_BY_OTHER_PROGRAM: { category: "coordination", severity: "error", exit: 4 },
  ASSET_BUSY: { category: "coordination", severity: "error", exit: 4 },
  SCHEDULE_HELD: { category: "coordination", severity: "error", exit: 4 },
  SERVE_UNAVAILABLE: { category: "coordination", severity: "error", exit: 4 },
  SERVE_UNAUTHORIZED: { category: "coordination", severity: "error", exit: 2 },
  SERVE_UNSAFE_FILESYSTEM: { category: "coordination", severity: "error", exit: 4 },
  QUERY_TOO_MANY_ROWS: { category: "coordination", severity: "error", exit: 2 },
  CONFIRMATION_REQUIRED: { category: "safety", severity: "error", exit: 5 },
  CONFIRMATION_STALE: { category: "safety", severity: "error", exit: 5 },
  REQUIRES_HUMAN: { category: "safety", severity: "error", exit: 5 },
  BUN_TOO_OLD: { category: "environment", severity: "error", exit: 2 },
  NEEDS_BUN: { category: "environment", severity: "error", exit: 2 },
  DUCKDB_BINDING_MISSING: { category: "environment", severity: "error", exit: 2 },
  DUCKDB_BINDING_LOAD: { category: "environment", severity: "error", exit: 2 },
  DB_NEWER_FORMAT: { category: "environment", severity: "error", exit: 2 },
  CLAUDE_FILES_OUTDATED: { category: "environment", severity: "warning", exit: 0 },
  SCHEDULER_STALE: { category: "environment", severity: "warning", exit: 0 },
  PROJECT_NOT_WRITABLE: { category: "environment", severity: "error", exit: 2 },
  DB_UNREADABLE: { category: "environment", severity: "error", exit: 2 },
  INSTALL_FAILED: { category: "environment", severity: "error", exit: 2 },
  ENV_FILE_IGNORED: { category: "warning", severity: "warning", exit: 0 },
  TABLE_MODIFIED_OUTSIDE_CROFT: { category: "warning", severity: "warning", exit: 0 },
  VOLATILE_SQL: { category: "warning", severity: "warning", exit: 0 },
  MIXED_TYPES: { category: "warning", severity: "warning", exit: 0 },
  NULL_ONLY_COLUMN: { category: "warning", severity: "warning", exit: 0 },
  UNSAFE_INTEGER: { category: "warning", severity: "warning", exit: 0 },
  SINCE_IGNORED: { category: "warning", severity: "warning", exit: 0 },
  EMPTY_EXTRACT: { category: "warning", severity: "warning", exit: 0 },
  TYPE_WIDENED: { category: "warning", severity: "warning", exit: 0 },
  COLUMN_STOPPED_ARRIVING: { category: "warning", severity: "warning", exit: 0 },
  JSON_KIND_CHANGED: { category: "warning", severity: "warning", exit: 0 },
  CSV_ENCODING_GUESSED: { category: "warning", severity: "warning", exit: 0 },
  AMBIGUOUS_DATE_FORMAT: { category: "warning", severity: "warning", exit: 0 },
  MIXED_DATE_FORMATS: { category: "warning", severity: "warning", exit: 0 },
  DUPLICATE_ROWS_ACROSS_FILES: { category: "warning", severity: "warning", exit: 0 },
  TRANSFORM_MAKES_REQUESTS: { category: "warning", severity: "warning", exit: 0 },
  SHRINK_GUARD_DISABLED: { category: "warning", severity: "warning", exit: 0 },
  INPUT_NOT_BUILT: { category: "warning", severity: "info", exit: 0 },
  EDITED_SINCE_LAST_RUN: { category: "warning", severity: "warning", exit: 0 },
  ORPHAN_TABLE: { category: "warning", severity: "warning", exit: 0 },
  OUT_OF_BAND_CHANGE: { category: "warning", severity: "warning", exit: 0 },
  ENV_FILE_INVALID: { category: "warning", severity: "warning", exit: 0 },
  COLUMN_NAME_COLLISION: { category: "warning", severity: "warning", exit: 0 },
  BUN_UNTESTED: { category: "warning", severity: "warning", exit: 0 },
  DB_ON_SYNCED_FOLDER: { category: "warning", severity: "warning", exit: 0 },
  TZDATA_MISMATCH: { category: "warning", severity: "warning", exit: 0 },
} as const satisfies Record<string, CodeInfo>;

export type Code = keyof typeof CODES;

export function isCode(code: string): code is Code {
  return Object.hasOwn(CODES, code);
}

export interface ProblemInit {
  message: string;
  hint: string;
  asset?: string;
  file?: string;
  line?: number;
  column?: number;
  runId?: string;
  fix?: Fix;
  effect?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/** Build a Problem for a registered code; severity and docs come from the registry. */
export function problem(code: Code, init: ProblemInit): Problem {
  const info = CODES[code];
  return { severity: info.severity, code, docs: `croft docs ${code}`, ...init };
}

/** The one error type croft throws. It carries a fully formed Problem. */
export class CroftError extends Error {
  readonly problem: Problem;
  constructor(code: Code, init: ProblemInit) {
    super(init.message);
    this.name = "CroftError";
    this.problem = problem(code, init);
  }
  get code(): Code {
    return this.problem.code as Code;
  }
  get exit(): number {
    return CODES[this.code].exit;
  }
}

/**
 * Exit code for a set of problems, following the precedence rules in DESIGN.md §4.3: 130 when interrupted,
 * 6 while still running, 3 only when every failure is CHECK_FAILED, and 1 for any other failure mix that
 * includes exit 1. Otherwise the highest registered exit wins (2 invalid < 4 busy < 5 needs a human).
 * With CHECK_FAILED in the mix, the other failures decide: 4 or 5 when every one of them is a coordination
 * (4) or safety (5) outcome, since "retry later" and "ask a human" still hold; otherwise 1 ("any non-check
 * failure"), so an exit-2 code such as SECRET_MISSING or SQL_SYNTAX is never reported as checks-only.
 */
export function exitCodeFor(problems: Problem[], opts: { stillRunning?: boolean; pendingConfirmation?: boolean } = {}): number {
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.some((p) => p.code === "INTERRUPTED")) return EXIT.INTERRUPTED;
  if (opts.stillRunning) return EXIT.STILL_RUNNING;
  if (errors.length === 0) return opts.pendingConfirmation ? EXIT.NEEDS_HUMAN : EXIT.OK;
  const others = errors.filter((p) => p.code !== "CHECK_FAILED");
  if (others.length === 0) return EXIT.CHECKS_FAILED;
  const exits = others.map((p) => (isCode(p.code) ? CODES[p.code].exit : EXIT.FAILED));
  if (exits.includes(EXIT.FAILED)) return EXIT.FAILED;
  if (others.length < errors.length && !exits.every((e) => e === EXIT.BUSY || e === EXIT.NEEDS_HUMAN)) return EXIT.FAILED;
  return Math.max(...exits);
}

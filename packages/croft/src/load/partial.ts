// Monotone partial commits (DESIGN.md §8 "Large first loads", D50): a long first load of a cursor ingest commits in
// parts while every cursor value in the new rows is at least every value already seen, so a crash, a kill or a
// rate-limit failure late in the load resumes from the committed cursor instead of refetching from zero.
// Non-monotone sources (newest-first APIs) keep single-transaction behavior.
//
//   order      monotoneTracker: every cursor value, in yield order, must be at least every value before it. The
//              check is per value, not per part, so a newest-first API breaks it on its first page, before anything
//              could commit. Values compare the way the typed column will: integers exactly, ISO date-times as
//              instants (with an offset) or wall clocks (without), dates as midnight among naive ones, text in
//              code point order (DuckDB compares VARCHAR as UTF-8 bytes). Anything whose order would depend on how
//              the column ends up typed (dates next to zoned date-times, numbers next to text, ...) breaks it, so
//              the load falls back to one transaction rather than trusting a guess.
//   parts      stageInParts: the rows go through writeStage as before, but while the order holds, a part ends
//              once it holds PARTIAL_COMMIT.rows rows or has been open PARTIAL_COMMIT.ms, at the end of the batch
//              that reached it; the caller commits it (the cursor is then the typed maximum of what committed,
//              computed by the write as always), and staging continues with the next part. The last part is
//              left to the caller's ordinary write.
//   rewind     when the order breaks after a commit, the rows still to come may hold cursor values below the one
//              saved, and a crash before the end would resume past them. So the caller moves the saved cursor
//              back to where the run started, at once, before the rows that broke the order are even staged;
//              the load then finishes in one transaction, whose cursor is kept at least where the parts saved
//              it (keepCursorAtLeast), so a finished load never re-reads what its parts already covered.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { CursorType, Sql } from "../core/types.ts";
import { type RealColumn, readTableSchema } from "./evolve.ts";
import { cleanColumnName, type KnownName, MANIFEST_FILE, type StageManifestFile, type StageOptions, writeStage } from "./stage.ts";
import { RE } from "./types.ts";
import type { WriteResult } from "./write.ts";

export const PARTIAL_COMMIT_ROWS = 50_000;
export const PARTIAL_COMMIT_MS = 5 * 60_000;

/** When a cursor ingest commits the parts staged so far: once they hold `rows` rows or `ms` milliseconds have
 *  passed since the last commit, at the end of the batch that reached it. Tests shrink it (as transform.ts CHUNK). */
export const PARTIAL_COMMIT = { rows: PARTIAL_COMMIT_ROWS, ms: PARTIAL_COMMIT_MS };

// ---------------------------------------------------------------------------------------------------------
// The order

/** Tracks whether a cursor ingest's rows arrive in non-decreasing cursor order, part by part. */
export interface MonotoneTracker {
  /** Record a part's cursor values; false once the order was broken (from then on: one transaction). */
  add(values: readonly unknown[]): boolean;
  readonly monotone: boolean;
  /** The typed maximum seen so far, as the cursor would store it. */
  readonly max: string | null;
  /** The first value that broke the order, the maximum it came after (null: nothing comparable before it), and
   *  its position among every value added (0-based, NULLs included: with one value per row, its row). */
  readonly broken: { value: string; after: string | null; index: number } | null;
}

/** How values compare: exact integers, instants, wall clocks (naive date-times and dates), or text. */
type Family = "int" | "instant" | "wall" | "text";

interface Point {
  family: Family;
  /** The value as the source sent it: what the cursor would store. */
  text: string;
  /** int: the value; instant and wall: whole seconds. */
  n: bigint;
  /** instant and wall: the fraction's digits, as written. */
  frac: string;
}

const INSTANT = new RegExp(`^(?:${RE.isoInstant})$`);
const NAIVE = new RegExp(`^(?:${RE.isoNaive})$`);
const DATE_ONLY = new RegExp(`^(?:${RE.isoDate})$`);
const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const INTEGER_TEXT = /^-?\d+$/;

// JSON.rawJSON (a number beyond DOUBLE, or exact digits from ctx.http's res.json()); TypeScript's lib lacks it.
const isRawJSON = (JSON as unknown as { isRawJSON(v: unknown): boolean }).isRawJSON;

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const textPoint = (s: string): Point => ({ family: "text", text: s, n: 0n, frac: "" });

/**
 * A string as the typed column will see it: an ISO date-time with an offset is an instant, one without is a wall
 * clock, a date is its midnight among wall clocks, anything else (including dates DuckDB's cast refuses, such as
 * 2026-02-30, which stay text in classification) is text.
 */
function stringPoint(s: string): Point {
  let family: Family;
  if (INSTANT.test(s)) family = "instant";
  else if (NAIVE.test(s) || DATE_ONLY.test(s)) family = "wall";
  else return textPoint(s);
  const m = ISO_PARTS.exec(s);
  if (!m) return textPoint(s);
  const [, ys, mos, ds, hs, mis, ss, frac, off] = m;
  const y = Number(ys), mo = Number(mos), d = Number(ds), h = Number(hs ?? 0), mi = Number(mis ?? 0), sec = Number(ss ?? 0);
  if (mo < 1 || mo > 12 || d < 1 || d > (mo === 2 && leap(y) ? 29 : DAYS_IN_MONTH[mo - 1]!) || h > 23 || mi > 59 || sec > 59) return textPoint(s);
  let offset = 0;
  if (off && off !== "Z") {
    const digits = off.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2)), om = Number(digits.slice(2, 4) || 0);
    if (oh > 23 || om > 59) return textPoint(s);
    offset = (off[0] === "-" ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const n = BigInt(daysFromCivil(y, mo, d)) * 86_400n + BigInt(h * 3600 + mi * 60 + sec - offset);
  return { family, text: s, n, frac: frac ?? "" };
}

/** A value as the cursor column will hold it; null when no cursor could hold it (a fraction, a boolean, an object). */
function pointOf(v: unknown, asText: boolean): Point | null {
  if (typeof v === "string") return asText ? textPoint(v) : stringPoint(v);
  if (asText) return null;
  if (typeof v === "bigint") return { family: "int", text: v.toString(), n: v, frac: "" };
  if (typeof v === "number") {
    // The text staging writes (JSON), which is what DuckDB reads.
    const text = JSON.stringify(v);
    return Number.isInteger(v) && INTEGER_TEXT.test(text) ? { family: "int", text, n: BigInt(text), frac: "" } : null;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { ...stringPoint(v.toISOString()), text: v.toISOString() };
  if (v !== null && typeof v === "object" && isRawJSON(v)) {
    const text = (v as { rawJSON: string }).rawJSON;
    return INTEGER_TEXT.test(text) ? { family: "int", text, n: BigInt(text), frac: "" } : null;
  }
  return null;
}

/** Fraction digits compare as decimals: "5" is "50…", beyond microseconds too. */
function compareFrac(a: string, b: string): number {
  const w = Math.max(a.length, b.length);
  const x = a.padEnd(w, "0"), y = b.padEnd(w, "0");
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Code point order, which is UTF-8 byte order: a surrogate (a code point beyond U+FFFF) sorts after every other
 *  UTF-16 code unit, which plain `<` gets wrong against U+E000–U+FFFF. */
function compareText(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    const sx = x >= 0xd800 && x <= 0xdfff, sy = y >= 0xd800 && y <= 0xdfff;
    if (sx !== sy) return sx ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compare(a: Point, b: Point): number {
  if (a.family === "text") return compareText(a.text, b.text);
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return compareFrac(a.frac, b.frac);
}

/** A value in a message. */
function shown(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
  if (v !== null && typeof v === "object" && isRawJSON(v)) return (v as { rawJSON: string }).rawJSON;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

/** The families a cursor type admits; null: not fixed yet (a first load), the first value decides. */
function familiesOf(type: CursorType | null): readonly Family[] | null {
  switch (type) {
    case "integer": return ["int"];
    case "string": return ["text"];
    case "timestamp":
    case "date": return ["instant", "wall"];
    default: return null;
  }
}

class Tracker implements MonotoneTracker {
  #monotone = true;
  #max: Point | null = null;
  #family: Family | null = null;
  #broken: MonotoneTracker["broken"] = null;
  /** Values added so far, NULLs included. */
  #count = 0;
  readonly #families: readonly Family[] | null;
  readonly #asText: boolean;

  constructor(type: CursorType | null) {
    this.#families = familiesOf(type);
    this.#asText = type === "string";
  }

  get monotone(): boolean {
    return this.#monotone;
  }

  get max(): string | null {
    return this.#max?.text ?? null;
  }

  get broken(): MonotoneTracker["broken"] {
    return this.#broken;
  }

  add(values: readonly unknown[]): boolean {
    for (const v of values) {
      this.#count++;
      if (v === null || v === undefined) continue;
      const p = pointOf(v, this.#asText);
      if (p && this.#family === null && (this.#families === null || this.#families.includes(p.family))) this.#family = p.family;
      if (!p || p.family !== this.#family) {
        this.#break(shown(v));
        continue;
      }
      if (this.#max && compare(p, this.#max) < 0) this.#break(p.text);
      // Ties move the maximum to the later value, as the cursor keeps the last row yielded among equals.
      else this.#max = p;
    }
    return this.#monotone;
  }

  #break(value: string): void {
    if (!this.#monotone) return;
    this.#monotone = false;
    this.#broken = { value, after: this.#max?.text ?? null, index: this.#count - 1 };
  }
}

/**
 * A tracker for a cursor of this type (null before the first load fixed it: the first value decides how values
 * compare). `unit` does not change the order of epoch integers; it is accepted for the cursor's full description.
 */
export function monotoneTracker(type: CursorType | null, unit: "s" | "ms" | null): MonotoneTracker {
  void unit;
  return new Tracker(type);
}

/**
 * The incremental field's value in each row: the row's own key `field`, else the key that cleans to it (§7
 * "Column names"), as cast.ts finds the cursor column. undefined for a row without it, or one that is no object.
 */
export function cursorValues(rows: readonly unknown[], field: string): unknown[] {
  const lower = field.toLowerCase();
  const matches = new Map<string, boolean>();
  return rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
    const r = row as Record<string, unknown>;
    if (Object.hasOwn(r, field)) return r[field];
    for (const k of Object.keys(r)) {
      let m = matches.get(k);
      if (m === undefined) matches.set(k, (m = cleanColumnName(k, 1).toLowerCase() === lower));
      if (m) return r[k];
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------------------------------------
// The parts

export interface StageInPartsOptions {
  /** The step's staging folder: the first part is staged here, as a single-transaction load is; later ones in
   *  commit-<n>/ below it. */
  dir: string;
  asset: string;
  runId: string;
  /** What rows() returned. */
  source: unknown;
  /** Stored columns for the first part's names; later parts get what the commits before them stored. */
  knownColumns: KnownName[];
  signal?: AbortSignal;
  sinceUsed?: string | number;
  /** The incremental field. */
  field: string;
  tracker: MonotoneTracker;
  /** Commit the rows staged since the last commit (the n-th commit), with the cursor at their typed maximum;
   *  resolves to the columns now stored, which name the next part's columns. */
  commit(manifest: StageManifestFile, n: number): Promise<KnownName[]>;
  /** The order broke after at least one commit: move the saved cursor back to where the run started. */
  rewind(): Promise<void>;
  /** Default Date.now. */
  clock?: () => number;
}

export interface StagedInParts {
  /** The part after the last commit, for the caller's ordinary write: every row when nothing committed. */
  manifest: StageManifestFile;
  /** Parts committed on the way, and their rows. */
  commits: number;
  committedRows: number;
  /** The cursor order held to the end. */
  monotone: boolean;
  /** Where it broke: the value, the maximum before it, and its row in the whole load (1-based). */
  broken: { value: string; after: string | null; row: number } | null;
  /** The load reached a commit threshold (rows or time): with the order broken, it was one transaction anyway. */
  large: boolean;
}

/** A commit of a part failed. `cause` is the commit's own error; `commits` parts committed before it. */
export class PartialCommitFailed extends Error {
  constructor(override readonly cause: unknown, readonly commits: number, readonly rows: number) {
    super("a partial commit failed");
    this.name = "PartialCommitFailed";
  }
}

type AnyIterator = { next(): Promise<IteratorResult<unknown>> | IteratorResult<unknown>; return?(v?: unknown): unknown };

const DONE = { done: true, value: undefined } as const;

/** The iterator of an (async) iterable source; null for a promise, or anything that is not rows (writeStage
 *  takes those whole, and reports what is wrong). */
function iteratorOf(source: unknown): AnyIterator | null {
  if (!source || typeof source !== "object") return null;
  if (typeof (source as PromiseLike<unknown>).then === "function") return null;
  const s = source as Partial<AsyncIterable<unknown> & Iterable<unknown>>;
  if (typeof s[Symbol.asyncIterator] === "function") return s[Symbol.asyncIterator]!() as AnyIterator;
  if (typeof s[Symbol.iterator] === "function") return s[Symbol.iterator]!() as AnyIterator;
  return null;
}

/** Hands the source's batches to writeStage one part at a time, checking the cursor order as they pass. */
class Cutter {
  /** The current part reached a threshold while the order held: it ends, and commits. */
  cut = false;
  done = false;
  large = false;
  broken: StagedInParts["broken"] = null;
  /** Rows of the whole load so far. */
  rows = 0;
  commits = 0;
  #partRows = 0;
  #startedAt = 0;

  constructor(private readonly src: AnyIterator, private readonly o: StageInPartsOptions, private readonly clock: () => number) {}

  start(): void {
    this.cut = false;
    this.#partRows = 0;
    this.#startedAt = this.clock();
  }

  part(): AsyncIterableIterator<unknown> {
    const it: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]: () => it,
      next: async () => {
        if (this.cut || this.done) return DONE;
        const r = await this.src.next();
        if (r.done) {
          this.done = true;
          return DONE;
        }
        const batch: unknown[] = Array.isArray(r.value) ? r.value : [r.value];
        await this.#check(batch);
        this.rows += batch.length;
        this.#partRows += batch.length;
        // A part with no rows never commits: an empty page (or time alone) makes no part.
        const due = this.#partRows > 0 && (this.#partRows >= PARTIAL_COMMIT.rows || this.clock() - this.#startedAt >= PARTIAL_COMMIT.ms);
        if (due) this.large = true;
        if (due && this.o.tracker.monotone) this.cut = true;
        return { done: false, value: r.value };
      },
      // writeStage gives up on the source (an unserializable row, an abort): stop the generator too, without
      // waiting for one that may be stuck on the network.
      return: async () => {
        Promise.resolve(this.src.return?.()).catch(() => {});
        return DONE;
      },
    };
    return it;
  }

  /** Feed the batch's cursor values to the tracker (one per row, so a break's index is its row); the first break
   *  after a commit rewinds the saved cursor before the batch reaches staging. */
  async #check(batch: unknown[]): Promise<void> {
    const t = this.o.tracker;
    const was = t.monotone;
    t.add(cursorValues(batch, this.o.field));
    if (!was || t.monotone) return;
    const b = t.broken!;
    this.broken = { value: b.value, after: b.after, row: b.index + 1 };
    if (this.commits > 0) await this.o.rewind();
  }
}

/** writeStage numbers rows from 1 in every part; a problem should name the row of the whole load. */
function shiftRow(e: unknown, offset: number): unknown {
  if (!(e instanceof CroftError) || offset === 0 || typeof e.problem.details?.row !== "number") return e;
  const row = e.problem.details.row as number;
  e.problem.details = { ...e.problem.details, row: row + offset };
  e.problem.message = e.problem.message.replace(`row ${row} of`, `row ${row + offset} of`);
  return e;
}

/** A committed part's staged files: nothing will read them again. The first part shares the step's staging
 *  folder (and ctx.query's snapshot in it), so only its own files go; a later part's folder goes whole. */
function removeStaged(m: StageManifestFile, dir: string, ownFolder: boolean): void {
  if (ownFolder) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (const p of m.parts) rmSync(p.path, { force: true });
  rmSync(join(dir, MANIFEST_FILE), { force: true });
}

/**
 * Stage what rows() returned, committing parts on the way while the cursor order holds (see the header). Throws
 * what writeStage throws (row numbers of the whole load), the source's own errors, and PartialCommitFailed around
 * a failed commit, whose part then stays staged.
 */
export async function stageInParts(o: StageInPartsOptions): Promise<StagedInParts> {
  const base: Omit<StageOptions, "dir" | "source" | "knownColumns"> = {
    asset: o.asset, runId: o.runId, ...(o.signal ? { signal: o.signal } : {}), ...(o.sinceUsed !== undefined ? { sinceUsed: o.sinceUsed } : {}),
  };
  const src = iteratorOf(o.source);
  if (!src) {
    const manifest = await writeStage({ ...base, dir: o.dir, source: o.source as StageOptions["source"], knownColumns: o.knownColumns });
    return { manifest, commits: 0, committedRows: 0, monotone: o.tracker.monotone, broken: null, large: manifest.rows >= PARTIAL_COMMIT.rows };
  }
  const cutter = new Cutter(src, o, o.clock ?? Date.now);
  let known = o.knownColumns;
  let committedRows = 0;
  for (let n = 1; ; n++) {
    const dir = n === 1 ? o.dir : join(o.dir, `commit-${n}`);
    const offset = cutter.rows;
    cutter.start();
    let manifest: StageManifestFile;
    try {
      manifest = await writeStage({ ...base, dir, source: cutter.part(), knownColumns: known });
    } catch (e) {
      throw shiftRow(e, offset);
    }
    if (!cutter.cut) {
      return {
        manifest, commits: cutter.commits, committedRows, monotone: o.tracker.monotone, broken: cutter.broken, large: cutter.large,
      };
    }
    try {
      known = await o.commit(manifest, n);
    } catch (e) {
      throw new PartialCommitFailed(e, cutter.commits, committedRows);
    }
    cutter.commits++;
    committedRows += manifest.rows;
    removeStaged(manifest, dir, n > 1);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The cursor after a rewind

/** The asset's cursor column in its table: the incremental field by column name, or by the source name
 *  _croft.columns recorded for it. null when the table or the column is not there. */
export async function cursorColumn(sql: Sql, asset: string, field: string): Promise<RealColumn | null> {
  const schema = await readTableSchema(sql, asset);
  if (!schema) return null;
  const [known] = await sql.all<{ name: string }>(
    `SELECT name FROM _croft.columns WHERE asset = $1 AND (lower(name) = lower($2) OR source_name = $2)
     ORDER BY lower(name) = lower($2) DESC LIMIT 1`, [asset, field]);
  const name = (known?.name ?? field).toLowerCase();
  return schema.find((c) => c.name.toLowerCase() === name) ?? null;
}

/**
 * The last write of a load whose order broke after parts committed: the rewind moved the saved cursor back only
 * while the rest was in flight, so the cursor ends at least where the parts saved it (`floor`), compared on the
 * typed column. Runs inside that write's transaction, after writeBatch; returns the step's cursor.
 */
export async function keepCursorAtLeast(tx: Sql, o: { asset: string; field: string; floor: string; loadedAt: string; cursor: WriteResult["cursor"] }):
  Promise<WriteResult["cursor"]> {
  const col = await cursorColumn(tx, o.asset, o.field);
  if (!col) return o.cursor;
  const after = o.cursor?.after;
  if (after !== undefined) {
    const [row] = await tx.all<{ higher: boolean | null }>(
      `SELECT try_cast($1::VARCHAR AS ${col.type}) > try_cast($2::VARCHAR AS ${col.type}) AS higher`, [o.floor, after]);
    if (row?.higher !== true) return o.cursor;
  }
  await tx.exec(`UPDATE _croft.assets SET cursor_value = $1 WHERE name = $2`, [o.floor, o.asset]);
  await tx.exec(`UPDATE _croft.writes SET cursor_after = $1 WHERE asset = $2 AND loaded_at = $3::TIMESTAMPTZ`, [o.floor, o.asset, o.loadedAt]);
  return { ...o.cursor, after: o.floor };
}

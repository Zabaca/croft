// Type rules (DESIGN.md §7), as pure functions: no DuckDB, no I/O.
//
// - newColumnType: the type of a column croft has not stored yet, from the kinds of its values. NULL-only
//   columns get a placeholder typed from the column name and stay `pending` until real values arrive.
// - evolve / planColumn: the evolution table for columns croft already stored, including pins.
// - castAllowed: the whitelist. The only implicit casts are "the same kind in another format"; anything else
//   is a widen (with its own proof) or a TYPE_CONFLICT. cast.ts re-checks every cast with a round-trip.
// - CSV text rules (used by file ingests): integers, plain decimals, booleans, empty → NULL, money and
//   thousands separators → DECIMAL(18,s), and d/m/y dates whose order is decided once per column.
//
// Why these rules and not DuckDB's sniffer: the sniffer's answer depends on the batch (mixed offsets and
// mixed fractions became VARCHAR, day/month order flipped with the rows present) [V], so two loads of the
// same source could type differently. These rules depend only on the kinds of values seen.
import { problem } from "../core/errors.ts";
import type { ColumnPlan, Problem, ValueKind } from "../core/types.ts";

export const VALUE_KINDS: readonly ValueKind[] = [
  "null", "boolean", "integer", "bigint", "float", "iso_instant", "iso_naive", "iso_date", "string", "object", "array",
];

/** Rows per value kind. A kind that is missing or 0 was not seen. */
export type KindCounts = Partial<Record<ValueKind, number>>;

/** A column croft already stored (_croft.columns), or found in the real table (duckdb_columns()). */
export interface KnownColumn {
  name: string;
  type: string;
  sourceName?: string | null;
  format?: string | null;
  pinned?: boolean | null;
  pending?: boolean | null;
  kinds?: readonly string[] | null;
}

/** A column present in the batch: its classified kinds ("null" included when some row lacks it). */
export interface IncomingColumn {
  name: string;
  sourceName: string;
  counts: KindCounts;
  /** Integers beyond ±2^53: they cannot share a DOUBLE column with fractions. */
  unsafeIntegers?: number;
  /** Type decided by another rule set (CSV text rules), used instead of newColumnType for new columns. */
  newType?: NewType;
}

/** A pinned type from the asset's `columns`. `format` is a strptime pattern. */
export interface Pin { type: string; format?: string }

export interface NewType {
  type: string;
  /** A NULL-only placeholder typed from the column name; retyped freely when values arrive. */
  pending: boolean;
  format?: string;
  warnings: Problem[];
}

/**
 * A ColumnPlan with what write.ts needs beyond the shared contract. `incoming` lists every kind seen,
 * including "null"; it is empty only for a column absent from the whole batch (merges keep its values).
 */
export interface ColumnDecision extends ColumnPlan {
  present: boolean;
  pinned: boolean;
  /** After this load the column is still a NULL-only placeholder (store `pending = true`). */
  pending: boolean;
  /** strptime pattern (pins) or stored CSV format ("money", "%m/%d/%Y"). */
  format?: string;
  /** For "conflict": the kinds the column cannot take. */
  conflictKinds?: ValueKind[];
  /** For "widen" to DOUBLE: stored values must pass `v::DOUBLE::HUGEINT = v` first. */
  proof?: "double";
  /** With `samples` (the raw values): their row numbers (_croft_seq) and, for loss failures, the cast result. */
  sampleRows?: { row: number; value: unknown; typed?: unknown }[];
  /** Plain-words reason for the decision. */
  reason: string;
  warnings: Problem[];
}

// ---------------------------------------------------------------------------------------------------------
// Types and families

/** Canonical spelling of a type: upper case, DuckDB's aliases resolved, DECIMAL with explicit scale. */
export function normalizeType(type: string): string {
  const s = type.trim().replace(/\s+/g, " ").toUpperCase().replace(/\s*\(\s*/g, "(").replace(/\s*,\s*/g, ",").replace(/\s*\)/g, ")");
  const alias = ALIASES[s];
  if (alias) return alias;
  const dec = /^(?:DECIMAL|NUMERIC)\((\d+)(?:,(\d+))?\)$/.exec(s);
  if (dec) return `DECIMAL(${Number(dec[1])},${Number(dec[2] ?? 0)})`;
  if (/^VARCHAR\(\d+\)$/.test(s)) return "VARCHAR"; // DuckDB ignores the length
  return s;
}

const ALIASES: Record<string, string> = {
  "TIMESTAMP WITH TIME ZONE": "TIMESTAMPTZ", "TIMESTAMP WITHOUT TIME ZONE": "TIMESTAMP", DATETIME: "TIMESTAMP",
  TEXT: "VARCHAR", STRING: "VARCHAR", CHAR: "VARCHAR", BPCHAR: "VARCHAR",
  INT8: "BIGINT", LONG: "BIGINT", INT: "INTEGER", INT4: "INTEGER", SIGNED: "INTEGER", INT2: "SMALLINT", SHORT: "SMALLINT",
  INT1: "TINYINT", INT128: "HUGEINT",
  FLOAT8: "DOUBLE", "DOUBLE PRECISION": "DOUBLE", REAL: "FLOAT", FLOAT4: "FLOAT",
  BOOL: "BOOLEAN", LOGICAL: "BOOLEAN",
  DECIMAL: "DECIMAL(18,3)", NUMERIC: "DECIMAL(18,3)", // DuckDB's default width and scale
};

export type TypeFamily = "boolean" | "integer" | "hugeint" | "double" | "decimal" | "varchar" | "date" | "timestamp"
  | "timestamptz" | "json" | "other";

const FAMILY: Record<string, TypeFamily> = {
  BOOLEAN: "boolean",
  BIGINT: "integer", INTEGER: "integer", SMALLINT: "integer", TINYINT: "integer",
  UBIGINT: "integer", UINTEGER: "integer", USMALLINT: "integer", UTINYINT: "integer",
  HUGEINT: "hugeint", UHUGEINT: "hugeint",
  DOUBLE: "double", FLOAT: "double",
  VARCHAR: "varchar", DATE: "date",
  TIMESTAMP: "timestamp", TIMESTAMP_S: "timestamp", TIMESTAMP_MS: "timestamp", TIMESTAMP_NS: "timestamp",
  TIMESTAMPTZ: "timestamptz", JSON: "json",
};

export function typeFamily(type: string): TypeFamily {
  const t = normalizeType(type);
  if (t.startsWith("DECIMAL(")) return "decimal";
  return FAMILY[t] ?? "other";
}

/** DECIMAL(p,s) → {precision, scale}; null for other types. */
export function decimalParts(type: string): { precision: number; scale: number } | null {
  const m = /^DECIMAL\((\d+),(\d+)\)$/.exec(normalizeType(type));
  return m ? { precision: Number(m[1]), scale: Number(m[2]) } : null;
}

// ---------------------------------------------------------------------------------------------------------
// The whitelist

const SCALARS: readonly ValueKind[] = ["boolean", "integer", "bigint", "float", "iso_instant", "iso_naive", "iso_date", "string"];

// Kinds each family takes without changing type. For an unpinned column anything else is a widen or a
// conflict. "Same kind, other format" lives here: an ISO date into a TIMESTAMP(TZ) column (midnight),
// another offset or precision into TIMESTAMPTZ, integers into DOUBLE (the loss check stops 2^53+1).
const ALLOWED: Record<TypeFamily, ReadonlySet<ValueKind>> = {
  boolean: new Set(["boolean"]),
  integer: new Set(["integer"]),
  hugeint: new Set(["integer", "bigint"]),
  double: new Set(["float", "integer", "bigint"]),
  decimal: new Set(["integer", "float"]),
  varchar: new Set(SCALARS),                         // numbers and booleans are stored as text
  date: new Set(["iso_date"]),
  timestamp: new Set(["iso_naive", "iso_date"]),
  timestamptz: new Set(["iso_instant", "iso_date"]),
  json: new Set(VALUE_KINDS),
  other: new Set(SCALARS),                           // a type croft does not create: cast, then the loss check
};

// Kinds that are the family's own; others in ALLOWED are "cast on insert".
const NATIVE: Record<TypeFamily, ReadonlySet<ValueKind>> = {
  boolean: new Set(["boolean"]),
  integer: new Set(["integer"]),
  hugeint: new Set(["integer", "bigint"]),
  double: new Set(["float"]),
  decimal: new Set(["integer", "float"]),
  varchar: new Set(["string", "iso_instant", "iso_naive", "iso_date"]),
  date: new Set(["iso_date"]),
  timestamp: new Set(["iso_naive"]),
  timestamptz: new Set(["iso_instant"]),
  json: new Set(["object", "array"]),
  other: new Set(),
};

/** Whether values of `kind` may go into a column of `type` for an unpinned column. */
export function castAllowed(kind: ValueKind, type: string): boolean {
  return kind === "null" || ALLOWED[typeFamily(type)].has(kind);
}

/** The widened type for an unpinned column that receives `kinds` it cannot take, or null. */
export function widenTarget(type: string, kinds: readonly ValueKind[]): string | null {
  const has = (k: ValueKind) => kinds.includes(k);
  switch (typeFamily(type)) {
    case "integer":
      if (has("float")) return "DOUBLE";
      if (has("bigint")) return "HUGEINT";
      return null;
    case "hugeint":
      return has("float") ? "DOUBLE" : null;
    case "date":
      if (has("iso_instant") && !has("iso_naive")) return "TIMESTAMPTZ";
      if (has("iso_naive") && !has("iso_instant")) return "TIMESTAMP";
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// New columns

/** Kinds with at least one row, "null" excluded, in VALUE_KINDS order. */
export function nonNullKinds(kinds: KindCounts | readonly ValueKind[] | ReadonlySet<ValueKind>): ValueKind[] {
  const seen = new Set<ValueKind>(
    Array.isArray(kinds) || kinds instanceof Set
      ? (kinds as Iterable<ValueKind>)
      : (Object.entries(kinds) as [ValueKind, number | undefined][]).filter(([, n]) => (n ?? 0) > 0).map(([k]) => k),
  );
  return VALUE_KINDS.filter((k) => k !== "null" && seen.has(k));
}

/**
 * The type a NULL-only column gets until values arrive. A VARCHAR placeholder breaks `date_diff`,
 * comparisons with TIMESTAMPTZ and COALESCE downstream [V], and most NULL-only first-load columns are
 * nullable timestamps (closed_at, refunded_at). camelCase APIs get the same rules (closedAt, isActive).
 */
export function placeholderType(name: string): string {
  if (/_(at|time|timestamp)$/i.test(name) || /[a-z0-9](At|Time|Timestamp)$/.test(name)) return "TIMESTAMPTZ";
  if (/_(date|on)$/i.test(name) || /[a-z0-9](Date|On)$/.test(name)) return "DATE";
  if (/^(is|has)_/i.test(name) || /^(is|has)[A-Z0-9]/.test(name)) return "BOOLEAN";
  return "VARCHAR";
}

const KIND_WORDS: Record<ValueKind, string> = {
  null: "null", boolean: "boolean", integer: "integer", bigint: "integer beyond int64", float: "fractional number",
  iso_instant: "ISO timestamp with offset", iso_naive: "ISO timestamp without offset", iso_date: "ISO date",
  string: "text", object: "object", array: "array",
};

export function describeKinds(kinds: readonly ValueKind[]): string {
  const words = [...new Set(kinds.map((k) => KIND_WORDS[k]))];
  return words.length <= 1 ? (words[0] ?? "no") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function mixedTypes(name: string, kinds: readonly ValueKind[], why?: string): Problem {
  return problem("MIXED_TYPES", {
    message: `column ${name} mixes ${describeKinds(kinds)} values${why ? ` (${why})` : ""}; it is stored as text (VARCHAR)`,
    hint: `clean the value in rows() or map(), or pin a type: columns: { ${jsKey(name)}: "BIGINT" }`,
    details: { column: name, kinds },
  });
}

/**
 * The §7 table for a column croft has not stored. `kinds` are counts or a list; "null" is ignored.
 * `unsafeIntegers` counts integers beyond ±2^53, which cannot share DOUBLE with fractions.
 */
export function newColumnType(
  kinds: KindCounts | readonly ValueKind[] | ReadonlySet<ValueKind>,
  name: string,
  o: { unsafeIntegers?: number } = {},
): NewType {
  const k = nonNullKinds(kinds);
  const only = (...allowed: ValueKind[]) => k.every((x) => allowed.includes(x));
  const has = (x: ValueKind) => k.includes(x);
  if (k.length === 0) {
    const type = placeholderType(name);
    return {
      type, pending: true,
      warnings: [problem("NULL_ONLY_COLUMN", {
        message: `column ${name} holds only NULLs so far; it is typed ${type} from its name until values arrive`,
        hint: `if ${name} is not a ${type}, pin it: columns: { ${jsKey(name)}: "VARCHAR" }`,
        details: { column: name, type },
      })],
    };
  }
  const done = (type: string, warnings: Problem[] = []): NewType => ({ type, pending: false, warnings });
  if (has("object") || has("array")) return done("JSON");
  if (only("boolean")) return done("BOOLEAN");
  if (only("integer")) return done("BIGINT");
  if (only("integer", "bigint")) return done("HUGEINT");
  if (only("integer", "bigint", "float")) {
    if (!has("bigint") && (o.unsafeIntegers ?? 0) === 0) return done("DOUBLE");
    return done("VARCHAR", [mixedTypes(name, k, "integers beyond ±2^53 do not fit a DOUBLE exactly")]);
  }
  if (only("iso_instant", "iso_naive", "iso_date", "string")) {
    if (has("string")) return done("VARCHAR"); // no UUID, time or number guessing: "02134" stays text
    if (has("iso_instant") && has("iso_naive")) {
      return done("VARCHAR", [mixedTypes(name, k, "timestamps with and without an offset")]);
    }
    if (has("iso_instant")) return done("TIMESTAMPTZ");
    if (has("iso_naive")) return done("TIMESTAMP");
    return done("DATE");
  }
  return done("VARCHAR", [mixedTypes(name, k)]);
}

// ---------------------------------------------------------------------------------------------------------
// Evolution of stored columns

/** Pins normalized: ColumnPin strings or {type, format}, keyed as the asset wrote them. */
export function normalizePins(pins: Record<string, string | { type: string; format?: string }> | undefined): Record<string, Pin> {
  const out: Record<string, Pin> = {};
  for (const [k, v] of Object.entries(pins ?? {})) {
    out[k] = typeof v === "string" ? { type: normalizeType(v) } : { type: normalizeType(v.type), ...(v.format ? { format: v.format } : {}) };
  }
  return out;
}

/** The pin for a column: by column name (case-insensitive, as in SQL) or by exact source name. */
export function pinFor(pins: Record<string, Pin>, column: string, sourceName?: string | null): Pin | undefined {
  const lower = column.toLowerCase();
  for (const [k, v] of Object.entries(pins)) if (k.toLowerCase() === lower) return v;
  if (sourceName != null && Object.hasOwn(pins, sourceName)) return pins[sourceName];
  return undefined;
}

/**
 * One column's decision (the §7 evolution table). `existing` is undefined for a new column, `incoming`
 * undefined for a stored column absent from the batch.
 */
export function planColumn(existing: KnownColumn | undefined, incoming: IncomingColumn | undefined, pin?: Pin): ColumnDecision {
  const name = existing?.name ?? incoming!.name;
  const sourceName = incoming?.sourceName ?? existing?.sourceName ?? name;
  const incomingKinds = incoming ? VALUE_KINDS.filter((k) => (incoming.counts[k] ?? 0) > 0) : [];
  const kinds = nonNullKinds(incomingKinds);
  const base = {
    column: name, sourceName, existing: existing ? normalizeType(existing.type) : null, incoming: incomingKinds,
    present: incoming !== undefined, warnings: [] as Problem[],
  };
  // The asset's current pins are authoritative: a pin removed from the code unpins the column.
  const pinned = pin !== undefined;
  const pinType = pin ? normalizeType(pin.type) : undefined;
  const pinFormat = pin?.format;

  // New column.
  if (!existing) {
    if (pinType) {
      return { ...base, decision: "add", target: pinType, pinned: true, pending: false, format: pinFormat, reason: `new column, pinned ${pinType}` };
    }
    const nt = incoming!.newType ?? newColumnType(incoming!.counts, name, { unsafeIntegers: incoming!.unsafeIntegers });
    return {
      ...base, decision: "add", target: nt.type, pinned: false, pending: nt.pending, format: nt.format, warnings: nt.warnings,
      reason: nt.pending ? `new column with only NULLs; typed ${nt.type} from its name` : `new column of ${describeKinds(kinds)} values`,
    };
  }

  const stored = normalizeType(existing.type);
  const storedFormat = existing.format ?? undefined;

  // Absent from the whole batch: keep the column (and, in a merge, its stored values).
  if (!incoming) {
    return { ...base, decision: "keep", target: stored, pinned, pending: existing.pending === true, format: pinFormat ?? storedFormat, reason: "absent from this batch" };
  }

  // Pinned: never widened. Every value must cast exactly (cast.ts proves it, or TYPE_PIN_VIOLATION).
  if (pinType) {
    const target = pinType;
    if (target !== stored) {
      // A new or changed pin. The pin-change guard (PIN_CHANGES_DATA) owns confirmation; here the batch is
      // typed as pinned and write.ts retypes the column.
      return {
        ...base, decision: existing.pending ? "retype_pending" : "widen", target, pinned: true, pending: false, format: pinFormat,
        reason: `pinned ${target} (stored as ${stored})`,
      };
    }
    const native = kinds.every((k) => NATIVE[typeFamily(target)].has(k));
    return { ...base, decision: native ? "keep" : "cast", target, pinned: true, pending: false, format: pinFormat, reason: `pinned ${target}` };
  }

  // A NULL-only placeholder: retyped freely once real values arrive.
  if (existing.pending) {
    if (kinds.length === 0) {
      return { ...base, decision: "keep", target: stored, pinned: false, pending: true, format: storedFormat, reason: "still only NULLs" };
    }
    const nt = incoming.newType ?? newColumnType(incoming.counts, name, { unsafeIntegers: incoming.unsafeIntegers });
    return {
      ...base, decision: "retype_pending", target: nt.type, pinned: false, pending: false, format: nt.format, warnings: nt.warnings,
      reason: `first values (${describeKinds(kinds)}) for a NULL-only placeholder`,
    };
  }

  const warnings: Problem[] = [];
  const fam = typeFamily(stored);
  if (fam === "json" && existing.kinds && existing.kinds.length > 0) {
    const before = new Set(existing.kinds);
    const added = kinds.filter((k) => !before.has(k));
    if (added.length > 0) {
      warnings.push(problem("JSON_KIND_CHANGED", {
        message: `JSON column ${name} now also holds ${describeKinds(added)} values (before: ${existing.kinds.join(", ")})`,
        hint: `${name}->>'key' returns NULL on values that are not objects; check queries that read ${name}`,
        details: { column: name, before: [...existing.kinds], added },
      }));
    }
  }

  if (kinds.every((k) => castAllowed(k, stored))) {
    const native = kinds.every((k) => NATIVE[fam].has(k));
    return {
      ...base, decision: native ? "keep" : "cast", target: stored, pinned: false, pending: false, format: storedFormat, warnings,
      reason: native ? `same kind as ${stored}` : `${describeKinds(kinds.filter((k) => !NATIVE[fam].has(k)))} cast to ${stored}`,
    };
  }

  const wider = widenTarget(stored, kinds);
  const checkAgainst = wider ?? stored;
  const conflictKinds = kinds.filter((k) => !castAllowed(k, checkAgainst));
  if (wider && conflictKinds.length === 0) {
    const zoned = typeFamily(stored) === "date" && wider === "TIMESTAMPTZ";
    warnings.push(problem("TYPE_WIDENED", {
      message: `column ${name} widened from ${stored} to ${wider}${zoned ? "; stored dates read as midnight in the project time zone" : ""}`,
      hint: `queries comparing ${name} with ${stored} values still work; pin the column to refuse widening`,
      details: { column: name, from: stored, to: wider },
    }));
    return {
      ...base, decision: "widen", target: wider, pinned: false, pending: false, warnings,
      ...(wider === "DOUBLE" ? { proof: "double" as const } : {}),
      reason: `${describeKinds(kinds)} values need ${wider}`,
    };
  }
  return {
    ...base, decision: "conflict", target: stored, pinned: false, pending: false, format: storedFormat, conflictKinds, warnings,
    reason: `${stored} cannot take ${describeKinds(conflictKinds)} values`,
  };
}

/**
 * The plan for a whole batch: columns in the batch first (in batch order), then stored columns absent from
 * it. Pins apply by column name or source name.
 */
export function evolve(existing: readonly KnownColumn[], incoming: readonly IncomingColumn[], pins: Record<string, Pin> = {}): ColumnDecision[] {
  const byLower = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
  const out: ColumnDecision[] = [];
  const seen = new Set<string>();
  for (const col of incoming) {
    const lower = col.name.toLowerCase();
    const known = byLower.get(lower);
    seen.add(lower);
    out.push(planColumn(known, col, pinFor(pins, known?.name ?? col.name, col.sourceName)));
  }
  for (const col of existing) {
    if (seen.has(col.name.toLowerCase())) continue;
    out.push(planColumn(col, undefined, pinFor(pins, col.name, col.sourceName)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Regular expressions shared by JSON classification, CSV rules and the loss check. They are written for
// both RE2 (DuckDB's regexp_full_match) and JavaScript, and match only what DuckDB's casts parse: DuckDB
// refuses lower-case `t`/`z` and a zoned time without seconds ("2024-01-01T10:00Z") [V].
//
// Non-ASCII characters stay out of String.raw: Bun's transpiler rewrites them to `\uXXXX` inside template
// literals, which String.raw then keeps as text, and RE2 rejects `\u` [V].
const CURRENCY = "[$€£¥]"; // $ € £ ¥

export const RE = {
  isoDate: String.raw`\d{4}-\d{2}-\d{2}`,
  isoNaive: String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?`,
  isoInstant: String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)`,
  /** Partial match: a text that ends in a zone offset after a time. */
  offsetSuffix: String.raw`[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2}(:?\d{2})?)?)$`,
  /** Strict number text for the loss check: no hex, `_`, spaces or words. */
  number: String.raw`[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?`,
  integerText: String.raw`[+-]?\d+`,
  csvInteger: String.raw`-?(0|[1-9]\d*)`,
  csvDecimal: String.raw`-?(0|[1-9]\d*)\.\d+`,
  csvBoolean: String.raw`(?i)(true|false)`,
  /** Money and thousands-separated numbers: a currency sign, `,` groups or accounting parentheses. */
  csvMoney: [
    `-?${CURRENCY}` + String.raw`\s?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?`,
    `${CURRENCY}-` + String.raw`(\d{1,3}(,\d{3})+|\d+)(\.\d+)?`,
    String.raw`-?\d{1,3}(,\d{3})+(\.\d+)?`,
    String.raw`\(` + `${CURRENCY}?` + String.raw`\s?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\)`,
  ].join("|"),
  csvDayMonth: String.raw`(\d{1,2})([/.-])(\d{1,2})([/.-])(\d{4})`,
} as const;

const js = (re: string, flags = "") => new RegExp(`^(?:${re})$`, flags);
const JS = {
  isoDate: js(RE.isoDate), isoNaive: js(RE.isoNaive), isoInstant: js(RE.isoInstant),
  csvInteger: js(RE.csvInteger), csvDecimal: js(RE.csvDecimal), csvBoolean: /^(true|false)$/i,
  csvMoney: js(RE.csvMoney), csvDayMonth: js(RE.csvDayMonth),
};

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;
const INT128_MAX = (1n << 127n) - 1n;
const INT128_MIN = -(1n << 127n);
const TWO_53 = 9007199254740992n;

/** Kind of an integer text: integer (int64), bigint (int128) or null when it fits neither. */
export function integerKind(text: string): "integer" | "bigint" | null {
  const v = BigInt(text);
  if (v >= INT64_MIN && v <= INT64_MAX) return "integer";
  if (v >= INT128_MIN && v <= INT128_MAX) return "bigint";
  return null;
}

/** Whether an integer text lies within ±2^53 (exact in a DOUBLE). */
export function withinDouble(text: string): boolean {
  const v = BigInt(text);
  return v <= TWO_53 && v >= -TWO_53;
}

/** A string's sub-kind by the regular expressions alone (DuckDB also confirms the value casts). */
export function stringKind(s: string): "iso_instant" | "iso_naive" | "iso_date" | "string" {
  if (JS.isoInstant.test(s)) return "iso_instant";
  if (JS.isoNaive.test(s)) return "iso_naive";
  if (JS.isoDate.test(s)) return "iso_date";
  return "string";
}

// ---------------------------------------------------------------------------------------------------------
// CSV text rules. CSV is read with all_varchar and typed here, never by the sniffer: it read 01/02/2024 as
// 2024-02-01, and month-first once a 03/25/2024 row was present [V].

export type CsvKind = "empty" | "boolean" | "integer" | "bigint" | "decimal" | "money" | "day_month" | "iso_instant"
  | "iso_naive" | "iso_date" | "string";

/** One CSV cell's kind. Empty (and whitespace-only) cells are NULL. */
export function csvKind(text: string | null | undefined): CsvKind {
  if (text == null || text.trim() === "") return "empty";
  if (JS.csvBoolean.test(text)) return "boolean";
  if (JS.csvInteger.test(text)) return integerKind(text) === "integer" ? "integer" : "bigint";
  if (JS.csvDecimal.test(text)) return "decimal";
  if (JS.csvMoney.test(text)) return "money";
  const dm = JS.csvDayMonth.exec(text);
  if (dm && dm[2] === dm[4] && validDayMonth(Number(dm[1]), Number(dm[3]))) return "day_month";
  return stringKind(text);
}

/** Both numbers could be a day, and at least one could be a month. */
export function validDayMonth(a: number, b: number): boolean {
  return a >= 1 && a <= 31 && b >= 1 && b <= 31 && (a <= 12 || b <= 12);
}

/** Per-column statistics of CSV text, computed in SQL by classify.ts (or in JS for small inputs). */
export interface CsvStats {
  rows: number;
  counts: Partial<Record<CsvKind, number>>;
  /** Integers beyond ±2^53 (they cannot share a DOUBLE with decimals). */
  unsafeIntegers: number;
  /** Most fractional digits among decimals and money values. */
  maxScale: number;
  /** d/m/y dates by separator, and how many have a first or second number above 12. */
  dateSeparators: string[];
  firstOver12: number;
  secondOver12: number;
}

/** Statistics for a list of cells (tests, small files, `map()` output). */
export function csvStats(values: readonly (string | null | undefined)[]): CsvStats {
  const s: CsvStats = { rows: values.length, counts: {}, unsafeIntegers: 0, maxScale: 0, dateSeparators: [], firstOver12: 0, secondOver12: 0 };
  const seps = new Set<string>();
  for (const v of values) {
    const k = csvKind(v);
    s.counts[k] = (s.counts[k] ?? 0) + 1;
    if ((k === "integer" || k === "bigint") && !withinDouble(v!)) s.unsafeIntegers++;
    if (k === "decimal" || k === "money") s.maxScale = Math.max(s.maxScale, /\.(\d+)/.exec(v!)?.[1]?.length ?? 0);
    if (k === "day_month") {
      const m = JS.csvDayMonth.exec(v!)!;
      seps.add(m[2]!);
      if (Number(m[1]) > 12) s.firstOver12++;
      if (Number(m[3]) > 12) s.secondOver12++;
    }
  }
  s.dateSeparators = [...seps].sort();
  return s;
}

/** Map CSV kinds onto value kinds, so evolve() applies to CSV columns too. */
export function csvValueKinds(stats: CsvStats): KindCounts {
  const c = stats.counts;
  const out: KindCounts = {};
  const add = (k: ValueKind, n = 0) => { if (n > 0) out[k] = (out[k] ?? 0) + n; };
  add("null", c.empty);
  add("boolean", c.boolean);
  add("integer", c.integer);
  add("bigint", c.bigint);
  add("float", (c.decimal ?? 0) + (c.money ?? 0));
  add("iso_date", c.day_month);
  add("iso_date", c.iso_date);
  add("iso_naive", c.iso_naive);
  add("iso_instant", c.iso_instant);
  add("string", c.string);
  return out;
}

/** Month-first for ambiguous dates when the project zone is in the Americas (DESIGN.md §7). */
export function isAmericas(timezone: string): boolean {
  return /^(America|US|Canada|Brazil|Chile|Mexico)\//.test(timezone) || /^(EST|MST|HST|EST5EDT|CST6CDT|MST7MDT|PST8PDT)$/.test(timezone);
}

/** The strptime pattern of a day/month date. */
export function dayMonthFormat(order: "day-first" | "month-first", sep: string): string {
  return order === "day-first" ? `%d${sep}%m${sep}%Y` : `%m${sep}%d${sep}%Y`;
}

/**
 * The type of a new CSV column (or a pending one getting its first values). The same string rules as JSON,
 * plus the CSV rules above. A d/m/y date format is decided here once and stored in _croft.columns.format;
 * later loads cast with the stored format, and a value that does not parse is a TYPE_CONFLICT.
 */
export function csvColumnType(stats: CsvStats, name: string, o: { timezone: string }): NewType {
  const c = stats.counts;
  const n = (k: CsvKind) => c[k] ?? 0;
  const nonEmpty = stats.rows - n("empty");
  if (nonEmpty <= 0) return newColumnType([], name);
  const only = (...kinds: CsvKind[]) => (Object.keys(c) as CsvKind[]).every((k) => k === "empty" || n(k) === 0 || kinds.includes(k));
  const done = (type: string, extra: Partial<NewType> = {}): NewType => ({ type, pending: false, warnings: [], ...extra });
  const present = (Object.keys(c) as CsvKind[]).filter((k) => k !== "empty" && n(k) > 0);

  if (only("boolean")) return done("BOOLEAN");
  if (only("integer", "bigint")) return done(n("bigint") > 0 ? "HUGEINT" : "BIGINT");
  if (only("integer", "bigint", "decimal")) {
    if (n("bigint") === 0 && stats.unsafeIntegers === 0) return done("DOUBLE");
    return done("VARCHAR", { warnings: [mixedTypes(name, ["integer", "float"], "integers beyond ±2^53 do not fit a DOUBLE exactly")] });
  }
  if (n("money") > 0 && only("integer", "decimal", "money")) {
    return done(`DECIMAL(18,${Math.min(stats.maxScale, 18)})`, { format: "money" });
  }
  if (only("day_month")) {
    if (stats.dateSeparators.length !== 1 || (stats.firstOver12 > 0 && stats.secondOver12 > 0)) {
      return done("VARCHAR", {
        warnings: [problem("MIXED_DATE_FORMATS", {
          message: `column ${name} has dates in both day-first and month-first order${stats.dateSeparators.length > 1 ? " (or with different separators)" : ""}; it is stored as text`,
          hint: `clean the dates in map(), or pin the format: columns: { ${jsKey(name)}: { type: "DATE", format: "%d/%m/%Y" } }`,
          details: { column: name, separators: stats.dateSeparators },
        })],
      });
    }
    const sep = stats.dateSeparators[0]!;
    if (stats.firstOver12 > 0) return done("DATE", { format: dayMonthFormat("day-first", sep) });
    if (stats.secondOver12 > 0) return done("DATE", { format: dayMonthFormat("month-first", sep) });
    const order = isAmericas(o.timezone) ? "month-first" : "day-first";
    const other = order === "month-first" ? "day-first" : "month-first";
    const format = dayMonthFormat(order, sep);
    return done("DATE", {
      format,
      warnings: [problem("AMBIGUOUS_DATE_FORMAT", {
        message: `column ${name} has dates like 03${sep}04${sep}2026 that read either way; croft chose ${order} (${format}) from the time zone ${o.timezone}`,
        hint: `if they are ${other}, pin it before the first run: columns: { ${jsKey(name)}: { type: "DATE", format: "${dayMonthFormat(other, sep)}" } }`,
        details: { column: name, format, order, timezone: o.timezone },
      })],
    });
  }
  const valueKinds = nonNullKinds(csvValueKinds(stats));
  if (only("iso_instant", "iso_naive", "iso_date", "string")) return newColumnType(valueKinds, name);
  if (only("iso_instant", "iso_naive", "iso_date", "string", "day_month")) {
    // d/m/y dates mixed with other text: text, but dates are not a "mixed scalar kind" worth a warning
    // unless there is nothing else in the column.
    return done("VARCHAR");
  }
  const families = new Set(present.map((k) => (k === "integer" || k === "bigint" || k === "decimal" || k === "money" ? "number" : k)));
  return done("VARCHAR", families.size > 1 ? { warnings: [mixedTypes(name, valueKinds)] } : {});
}

// ---------------------------------------------------------------------------------------------------------

/** How a column name appears as a key in a JS object literal in fix text. */
export function jsKey(name: string): string {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name) ? name : JSON.stringify(name);
}

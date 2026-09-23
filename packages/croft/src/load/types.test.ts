import { describe, expect, test } from "bun:test";
import type { ValueKind } from "../core/types.ts";
import {
  castAllowed, csvColumnType, csvKind, csvStats, csvValueKinds, decimalParts, evolve, type IncomingColumn, integerKind,
  isAmericas, type KnownColumn, newColumnType, normalizePins, normalizeType, pinFor, placeholderType, planColumn, stringKind,
  typeFamily, widenTarget, withinDouble,
} from "./types.ts";

const inc = (name: string, kinds: Partial<Record<ValueKind, number>> | ValueKind[], extra: Partial<IncomingColumn> = {}): IncomingColumn => ({
  name, sourceName: name,
  counts: Array.isArray(kinds) ? Object.fromEntries(kinds.map((k) => [k, 1])) : kinds,
  ...extra,
});
const known = (name: string, type: string, extra: Partial<KnownColumn> = {}): KnownColumn => ({ name, type, sourceName: name, ...extra });
const codes = (ws: { code: string }[]) => ws.map((w) => w.code);

describe("types and families", () => {
  test("normalizeType resolves DuckDB aliases and spellings", () => {
    expect(normalizeType("timestamp with time zone")).toBe("TIMESTAMPTZ");
    expect(normalizeType("decimal( 18 , 2 )")).toBe("DECIMAL(18,2)");
    expect(normalizeType("NUMERIC(10)")).toBe("DECIMAL(10,0)");
    expect(normalizeType("decimal")).toBe("DECIMAL(18,3)");
    expect(normalizeType("int8")).toBe("BIGINT");
    expect(normalizeType("text")).toBe("VARCHAR");
    expect(normalizeType("varchar(20)")).toBe("VARCHAR");
    expect(normalizeType("bool")).toBe("BOOLEAN");
    expect(normalizeType("json")).toBe("JSON");
  });

  test("typeFamily and decimalParts", () => {
    expect(typeFamily("BIGINT")).toBe("integer");
    expect(typeFamily("integer")).toBe("integer");
    expect(typeFamily("HUGEINT")).toBe("hugeint");
    expect(typeFamily("DECIMAL(18,2)")).toBe("decimal");
    expect(typeFamily("TIMESTAMP WITH TIME ZONE")).toBe("timestamptz");
    expect(typeFamily("UUID")).toBe("other");
    expect(decimalParts("DECIMAL(20,4)")).toEqual({ precision: 20, scale: 4 });
    expect(decimalParts("DOUBLE")).toBeNull();
  });
});

describe("NULL-only placeholders are typed from the column name (§7)", () => {
  test.each([
    ["closed_at", "TIMESTAMPTZ"], ["refunded_at", "TIMESTAMPTZ"], ["CLOSED_AT", "TIMESTAMPTZ"], ["pickup_time", "TIMESTAMPTZ"],
    ["event_timestamp", "TIMESTAMPTZ"], ["closedAt", "TIMESTAMPTZ"], ["lastSeenTime", "TIMESTAMPTZ"],
    ["birth_date", "DATE"], ["posted_on", "DATE"], ["startDate", "DATE"], ["createdOn", "DATE"],
    ["is_active", "BOOLEAN"], ["has_children", "BOOLEAN"], ["isActive", "BOOLEAN"], ["hasMore", "BOOLEAN"],
    ["name", "VARCHAR"], ["format", "VARCHAR"], ["chat", "VARCHAR"], ["island", "VARCHAR"], ["hash", "VARCHAR"],
    ["history", "VARCHAR"], ["date", "VARCHAR"], ["at", "VARCHAR"],
  ])("%s → %s", (name, type) => {
    expect(placeholderType(name)).toBe(type);
  });

  test("a NULL-only column is pending and warned about", () => {
    const t = newColumnType(["null"], "refunded_at");
    expect(t).toMatchObject({ type: "TIMESTAMPTZ", pending: true });
    expect(codes(t.warnings)).toEqual(["NULL_ONLY_COLUMN"]);
    expect(newColumnType({}, "note")).toMatchObject({ type: "VARCHAR", pending: true });
  });
});

describe("type of a new column (§7 table)", () => {
  const cases: [string, ValueKind[], string, string[]][] = [
    ["all booleans", ["boolean", "null"], "BOOLEAN", []],
    ["integers within int64", ["integer"], "BIGINT", []],
    ["integers beyond int64", ["integer", "bigint"], "HUGEINT", []],
    ["only fractions", ["float"], "DOUBLE", []],
    ["integers and fractions", ["integer", "float"], "DOUBLE", []],
    ["big integers and fractions", ["bigint", "float"], "VARCHAR", ["MIXED_TYPES"]],
    ["ISO with Z or offset", ["iso_instant"], "TIMESTAMPTZ", []],
    ["ISO without offset", ["iso_naive"], "TIMESTAMP", []],
    ["YYYY-MM-DD", ["iso_date"], "DATE", []],
    ["dates and zoned date-times", ["iso_date", "iso_instant"], "TIMESTAMPTZ", []],
    ["dates and naive date-times", ["iso_date", "iso_naive"], "TIMESTAMP", []],
    ["naive and zoned date-times", ["iso_naive", "iso_instant"], "VARCHAR", ["MIXED_TYPES"]],
    ["other strings (zip 02134 stays text)", ["string"], "VARCHAR", []],
    ["ISO strings mixed with text", ["iso_date", "string"], "VARCHAR", []],
    ["objects", ["object"], "JSON", []],
    ["arrays", ["array"], "JSON", []],
    ["objects and strings", ["object", "string"], "JSON", []],
    ["integers and text", ["integer", "string"], "VARCHAR", ["MIXED_TYPES"]],
    ["booleans and integers", ["boolean", "integer"], "VARCHAR", ["MIXED_TYPES"]],
    ["numbers and timestamps", ["float", "iso_instant"], "VARCHAR", ["MIXED_TYPES"]],
  ];
  test.each(cases)("%s", (_label, kinds, type, warns) => {
    const t = newColumnType(kinds, "x");
    expect(t.type).toBe(type);
    expect(t.pending).toBe(false);
    expect(codes(t.warnings)).toEqual(warns);
  });

  test("integers beyond ±2^53 cannot share a DOUBLE with fractions", () => {
    expect(newColumnType({ integer: 3, float: 1 }, "x", { unsafeIntegers: 1 })).toMatchObject({ type: "VARCHAR" });
    expect(newColumnType({ integer: 3, float: 1 }, "x", { unsafeIntegers: 0 })).toMatchObject({ type: "DOUBLE" });
    expect(newColumnType({ integer: 3 }, "x", { unsafeIntegers: 3 })).toMatchObject({ type: "BIGINT" }); // exact in BIGINT
  });

  test("counts and lists give the same answer; zero counts are ignored", () => {
    expect(newColumnType({ integer: 5, float: 0, null: 2 }, "x").type).toBe("BIGINT");
  });
});

describe("the cast whitelist", () => {
  test("same kind in another format only", () => {
    expect(castAllowed("iso_date", "TIMESTAMPTZ")).toBe(true);
    expect(castAllowed("iso_date", "TIMESTAMP")).toBe(true);
    expect(castAllowed("iso_naive", "TIMESTAMPTZ")).toBe(false);
    expect(castAllowed("iso_instant", "TIMESTAMP")).toBe(false);
    expect(castAllowed("float", "BIGINT")).toBe(false);
    expect(castAllowed("string", "BIGINT")).toBe(false);
    expect(castAllowed("integer", "DOUBLE")).toBe(true);
    expect(castAllowed("integer", "VARCHAR")).toBe(true);
    expect(castAllowed("object", "VARCHAR")).toBe(false);
    expect(castAllowed("string", "JSON")).toBe(true);
    expect(castAllowed("boolean", "BIGINT")).toBe(false);
    expect(castAllowed("null", "BOOLEAN")).toBe(true);
  });

  test("widen targets", () => {
    expect(widenTarget("BIGINT", ["integer", "bigint"])).toBe("HUGEINT");
    expect(widenTarget("BIGINT", ["float"])).toBe("DOUBLE");
    expect(widenTarget("HUGEINT", ["float"])).toBe("DOUBLE");
    expect(widenTarget("DATE", ["iso_naive"])).toBe("TIMESTAMP");
    expect(widenTarget("DATE", ["iso_instant", "iso_date"])).toBe("TIMESTAMPTZ");
    expect(widenTarget("DATE", ["iso_instant", "iso_naive"])).toBeNull();
    expect(widenTarget("TIMESTAMP", ["iso_instant"])).toBeNull();
    expect(widenTarget("VARCHAR", ["object"])).toBeNull();
  });
});

describe("evolution of an existing column (§7 table)", () => {
  test("new field → add", () => {
    const d = planColumn(undefined, inc("n", ["integer"]));
    expect(d).toMatchObject({ decision: "add", target: "BIGINT", existing: null, present: true, pending: false });
  });

  test("field disappears → kept; absent columns have no incoming kinds", () => {
    const d = planColumn(known("n", "BIGINT"), undefined);
    expect(d).toMatchObject({ decision: "keep", target: "BIGINT", present: false, incoming: [] });
  });

  test("present but all NULL is not absent", () => {
    const d = planColumn(known("n", "BIGINT"), inc("n", { null: 4 }));
    expect(d).toMatchObject({ decision: "keep", present: true, incoming: ["null"] });
  });

  test("a pending column gets real values → retype_pending", () => {
    const d = planColumn(known("closed_at", "TIMESTAMPTZ", { pending: true }), inc("closed_at", { null: 3, string: 1 }));
    expect(d).toMatchObject({ decision: "retype_pending", target: "VARCHAR", pending: false, existing: "TIMESTAMPTZ" });
    const same = planColumn(known("closed_at", "TIMESTAMPTZ", { pending: true }), inc("closed_at", ["iso_instant"]));
    expect(same).toMatchObject({ decision: "retype_pending", target: "TIMESTAMPTZ" });
    const still = planColumn(known("closed_at", "TIMESTAMPTZ", { pending: true }), inc("closed_at", ["null"]));
    expect(still).toMatchObject({ decision: "keep", pending: true });
  });

  test("BIGINT receives integers beyond int64 → HUGEINT + TYPE_WIDENED", () => {
    const d = planColumn(known("n", "BIGINT"), inc("n", ["integer", "bigint"]));
    expect(d).toMatchObject({ decision: "widen", target: "HUGEINT", existing: "BIGINT" });
    expect(d.proof).toBeUndefined();
    expect(codes(d.warnings)).toEqual(["TYPE_WIDENED"]);
  });

  test("BIGINT receives fractions → DOUBLE after the lossless proof", () => {
    const d = planColumn(known("n", "BIGINT"), inc("n", ["integer", "float"]));
    expect(d).toMatchObject({ decision: "widen", target: "DOUBLE", proof: "double" });
  });

  test("DATE receives date-times → TIMESTAMP or TIMESTAMPTZ", () => {
    expect(planColumn(known("d", "DATE"), inc("d", ["iso_date", "iso_naive"]))).toMatchObject({ decision: "widen", target: "TIMESTAMP" });
    const z = planColumn(known("d", "DATE"), inc("d", ["iso_instant"]));
    expect(z).toMatchObject({ decision: "widen", target: "TIMESTAMPTZ" });
    expect(z.warnings[0]!.message).toContain("midnight in the project time zone");
    expect(planColumn(known("d", "DATE"), inc("d", ["iso_instant", "iso_naive"]))).toMatchObject({ decision: "conflict" });
  });

  test("same kind in another format → kept or cast on insert", () => {
    expect(planColumn(known("t", "TIMESTAMPTZ"), inc("t", ["iso_instant"])).decision).toBe("keep");
    expect(planColumn(known("t", "TIMESTAMPTZ"), inc("t", ["iso_date"])).decision).toBe("cast");
    expect(planColumn(known("x", "DOUBLE"), inc("x", ["integer"])).decision).toBe("cast");
  });

  test("VARCHAR receives numbers or booleans → stored as text", () => {
    expect(planColumn(known("v", "VARCHAR"), inc("v", ["integer", "boolean", "float", "string"]))).toMatchObject({ decision: "cast", target: "VARCHAR" });
    expect(planColumn(known("v", "VARCHAR"), inc("v", ["iso_instant", "string"]))).toMatchObject({ decision: "keep" });
  });

  test("JSON receives anything → stored as JSON, JSON_KIND_CHANGED on a new kind", () => {
    const d = planColumn(known("user", "JSON", { kinds: ["object"] }), inc("user", ["object", "string"]));
    expect(d).toMatchObject({ decision: "cast", target: "JSON" });
    expect(codes(d.warnings)).toEqual(["JSON_KIND_CHANGED"]);
    expect(planColumn(known("user", "JSON", { kinds: ["object"] }), inc("user", ["object"])).warnings).toEqual([]);
    expect(planColumn(known("user", "JSON"), inc("user", ["array"])).warnings).toEqual([]); // no stored kinds yet
  });

  const conflicts: [string, string, ValueKind[], ValueKind[]][] = [
    ["number ← text ('02134' into BIGINT)", "BIGINT", ["integer", "string"], ["string"]],
    ["text-only into DOUBLE", "DOUBLE", ["string"], ["string"]],
    ["boolean ← number", "BOOLEAN", ["integer"], ["integer"]],
    ["number ← boolean", "BIGINT", ["boolean"], ["boolean"]],
    ["naive ← zoned (+02:00 into TIMESTAMP)", "TIMESTAMP", ["iso_instant"], ["iso_instant"]],
    ["zoned ← naive", "TIMESTAMPTZ", ["iso_naive"], ["iso_naive"]],
    ["text ← object", "VARCHAR", ["object"], ["object"]],
    ["integers beyond int64 and text into BIGINT", "BIGINT", ["bigint", "string"], ["string"]],
    ["DECIMAL ← text", "DECIMAL(18,2)", ["string"], ["string"]],
  ];
  test.each(conflicts)("anything else → TYPE_CONFLICT: %s", (_l, type, kinds, bad) => {
    const d = planColumn(known("c", type), inc("c", kinds));
    expect(d.decision).toBe("conflict");
    expect(d.conflictKinds).toEqual(bad);
    expect(d.target).toBe(normalizeType(type));
  });

  test("BIGINT receiving fractions and text: widening to DOUBLE would still not take the text", () => {
    const d = planColumn(known("c", "BIGINT"), inc("c", ["float", "string"]));
    expect(d).toMatchObject({ decision: "conflict", conflictKinds: ["string"] });
  });

  describe("pinned columns are never widened", () => {
    const pins = normalizePins({ amount: "decimal(18,2)", Day: { type: "DATE", format: "%d/%m/%Y" }, "Price ($)": "DOUBLE" });

    test("pins normalize and match by column name (case-insensitive) or source name", () => {
      expect(pins.amount).toEqual({ type: "DECIMAL(18,2)" });
      expect(pinFor(pins, "AMOUNT")).toEqual({ type: "DECIMAL(18,2)" });
      expect(pinFor(pins, "day")).toEqual({ type: "DATE", format: "%d/%m/%Y" });
      expect(pinFor(pins, "Price", "Price ($)")).toEqual({ type: "DOUBLE" });
      expect(pinFor(pins, "other", "other")).toBeUndefined();
    });

    test("a new pinned column takes the pin, even when NULL-only", () => {
      expect(planColumn(undefined, inc("amount", ["null"]), pins.amount)).toMatchObject({ decision: "add", target: "DECIMAL(18,2)", pinned: true, pending: false });
      expect(planColumn(undefined, inc("day", ["string"]), pins.Day)).toMatchObject({ target: "DATE", format: "%d/%m/%Y" });
    });

    test("a pinned column casts every kind; the loss check decides", () => {
      const d = planColumn(known("amount", "DECIMAL(18,2)", { pinned: true }), inc("amount", ["integer", "float", "string"]), pins.amount);
      expect(d).toMatchObject({ decision: "cast", target: "DECIMAL(18,2)", pinned: true });
      const bigint = planColumn(known("n", "BIGINT", { pinned: true }), inc("n", ["float"]), { type: "BIGINT" });
      expect(bigint).toMatchObject({ decision: "cast", target: "BIGINT" }); // no widening to DOUBLE
    });

    test("a changed pin retypes the column", () => {
      expect(planColumn(known("amount", "DOUBLE"), inc("amount", ["float"]), pins.amount)).toMatchObject({ decision: "widen", target: "DECIMAL(18,2)", pinned: true });
      expect(planColumn(known("amount", "VARCHAR", { pending: true }), inc("amount", ["float"]), pins.amount)).toMatchObject({ decision: "retype_pending", target: "DECIMAL(18,2)" });
    });

    test("an unpinned column once pinned follows the current code", () => {
      const d = planColumn(known("n", "BIGINT", { pinned: true }), inc("n", ["float"]));
      expect(d).toMatchObject({ decision: "widen", pinned: false });
    });
  });

  test("evolve: batch columns in batch order, then stored columns absent from the batch; pins by name", () => {
    const plan = evolve(
      [known("id", "BIGINT"), known("gone", "VARCHAR"), known("Amount", "DOUBLE", { sourceName: "Amount ($)" })],
      [inc("new_col", ["string"]), inc("ID", ["integer"]), inc("Amount", ["float"], { sourceName: "Amount ($)" })],
      normalizePins({ "Amount ($)": "DECIMAL(18,2)" }),
    );
    expect(plan.map((d) => [d.column, d.decision, d.target])).toEqual([
      ["new_col", "add", "VARCHAR"],
      ["id", "keep", "BIGINT"],
      ["Amount", "widen", "DECIMAL(18,2)"],
      ["gone", "keep", "VARCHAR"],
    ]);
    expect(plan[3]!.present).toBe(false);
  });
});

describe("value classification helpers", () => {
  test("integer kinds at the int64 and int128 edges", () => {
    expect(integerKind("9223372036854775807")).toBe("integer");
    expect(integerKind("9223372036854775808")).toBe("bigint");
    expect(integerKind("-9223372036854775808")).toBe("integer");
    expect(integerKind("-9223372036854775809")).toBe("bigint");
    expect(integerKind("170141183460469231731687303715884105728")).toBeNull();
    expect(withinDouble("9007199254740992")).toBe(true);
    expect(withinDouble("9007199254740993")).toBe(false);
  });

  test("ISO string sub-kinds", () => {
    expect(stringKind("2024-01-01T10:00:00Z")).toBe("iso_instant");
    expect(stringKind("2024-01-01 10:00:00.123+02:00")).toBe("iso_instant");
    expect(stringKind("2024-01-01T10:00:00-0800")).toBe("iso_instant");
    expect(stringKind("2024-01-01T10:00Z")).toBe("string"); // DuckDB cannot cast a zoned time without seconds
    expect(stringKind("2024-01-01t10:00:00z")).toBe("string");
    expect(stringKind("2024-01-01T10:00")).toBe("iso_naive");
    expect(stringKind("2024-01-01T10:00:00.5")).toBe("iso_naive");
    expect(stringKind("2024-01-01")).toBe("iso_date");
    expect(stringKind("2024-1-1")).toBe("string");
    expect(stringKind("02134")).toBe("string");
  });
});

describe("CSV text rules", () => {
  test.each([
    ["", "empty"], ["  ", "empty"], [null, "empty"],
    ["42", "integer"], ["-7", "integer"], ["0", "integer"], ["02134", "string"], ["+5", "string"],
    ["9223372036854775808", "bigint"],
    ["3.25", "decimal"], ["-0.5", "decimal"], [".5", "string"], ["1e5", "string"],
    ["true", "boolean"], ["FALSE", "boolean"], ["yes", "string"],
    ["$1,234.50", "money"], ["($3.00)", "money"], ["-$5", "money"], ["$-5.00", "money"], ["1,234", "money"], ["€12", "money"],
    ["1.234,50", "string"], ["12,34", "string"],
    ["03/25/2026", "day_month"], ["25.03.2026", "day_month"], ["3-5-2026", "day_month"], ["03/25-2026", "string"], ["13/13/2026", "string"],
    ["2026-03-25", "iso_date"], ["2026-03-25T10:00:00Z", "iso_instant"], ["hello", "string"],
  ] as const)("csvKind(%p) = %s", (text, kind) => {
    expect(csvKind(text)).toBe(kind);
  });

  const typeOf = (values: (string | null)[], tz = "UTC") => csvColumnType(csvStats(values), "col", { timezone: tz });

  test("integers, decimals, booleans; empty cells are NULL", () => {
    expect(typeOf(["1", "", "3"])).toMatchObject({ type: "BIGINT" });
    expect(typeOf(["1", "2.5", null])).toMatchObject({ type: "DOUBLE" });
    expect(typeOf(["true", "false", ""])).toMatchObject({ type: "BOOLEAN" });
    expect(typeOf(["", "  "])).toMatchObject({ type: "VARCHAR", pending: true });
    expect(typeOf(["1", "99999999999999999999"])).toMatchObject({ type: "HUGEINT" });
    const unsafe = typeOf(["9007199254740993", "1.5"]);
    expect(unsafe.type).toBe("VARCHAR");
    expect(codes(unsafe.warnings)).toEqual(["MIXED_TYPES"]);
  });

  test("money and thousands separators → DECIMAL(18,s) with the format recorded", () => {
    expect(typeOf(["$1,234.50", "($3.00)", "12"])).toMatchObject({ type: "DECIMAL(18,2)", format: "money" });
    expect(typeOf(["1,234", "5"])).toMatchObject({ type: "DECIMAL(18,0)", format: "money" });
    expect(typeOf(["$1.005", "$2"])).toMatchObject({ type: "DECIMAL(18,3)" });
    expect(typeOf(["1.234,50", "2,00"])).toMatchObject({ type: "VARCHAR" }); // comma decimals need a pin
  });

  test("the zip code 02134 stays text", () => {
    expect(typeOf(["02134", "10001"])).toMatchObject({ type: "VARCHAR" });
  });

  test("dates: a day above 12 first means day-first, second means month-first", () => {
    expect(typeOf(["25/03/2026", "01/02/2026"])).toMatchObject({ type: "DATE", format: "%d/%m/%Y" });
    expect(typeOf(["03/25/2026", "01/02/2026"])).toMatchObject({ type: "DATE", format: "%m/%d/%Y" });
    expect(typeOf(["25.03.2026", "01.02.2026"])).toMatchObject({ type: "DATE", format: "%d.%m.%Y" });
  });

  test("dates: both orders → VARCHAR + MIXED_DATE_FORMATS; mixed separators too", () => {
    const both = typeOf(["25/03/2026", "03/25/2026"]);
    expect(both.type).toBe("VARCHAR");
    expect(codes(both.warnings)).toEqual(["MIXED_DATE_FORMATS"]);
    expect(codes(typeOf(["01/02/2026", "01.02.2026"]).warnings)).toEqual(["MIXED_DATE_FORMATS"]);
  });

  test("dates: ambiguous → month-first in the Americas, day-first elsewhere, with AMBIGUOUS_DATE_FORMAT", () => {
    const us = typeOf(["01/02/2026", "03/04/2026"], "America/Los_Angeles");
    expect(us).toMatchObject({ type: "DATE", format: "%m/%d/%Y" });
    expect(codes(us.warnings)).toEqual(["AMBIGUOUS_DATE_FORMAT"]);
    expect(us.warnings[0]!.message).toContain("month-first");
    expect(us.warnings[0]!.hint).toContain('format: "%d/%m/%Y"');
    const eu = typeOf(["01/02/2026"], "Europe/Berlin");
    expect(eu).toMatchObject({ type: "DATE", format: "%d/%m/%Y" });
    expect(eu.warnings[0]!.hint).toContain('format: "%m/%d/%Y"');
  });

  test("mixed families warn; text with dates does not", () => {
    expect(codes(typeOf(["1", "n/a"]).warnings)).toEqual(["MIXED_TYPES"]);
    expect(typeOf(["01/02/2026", "unknown"])).toMatchObject({ type: "VARCHAR", warnings: [] });
    expect(typeOf(["2026-01-02", "2026-01-02T10:00:00Z"])).toMatchObject({ type: "TIMESTAMPTZ" });
  });

  test("csvValueKinds maps onto value kinds for evolve()", () => {
    expect(csvValueKinds(csvStats(["1", "", "$2.00", "03/04/2026", "x", "true"]))).toEqual({
      null: 1, integer: 1, float: 1, iso_date: 1, string: 1, boolean: 1,
    });
  });

  test("isAmericas", () => {
    expect(isAmericas("America/New_York")).toBe(true);
    expect(isAmericas("US/Pacific")).toBe(true);
    expect(isAmericas("Europe/London")).toBe(false);
    expect(isAmericas("UTC")).toBe(false);
  });
});

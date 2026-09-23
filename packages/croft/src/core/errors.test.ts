import { describe, expect, test } from "bun:test";
import { CODES, CroftError, EXIT, exitCodeFor, problem } from "./errors.ts";

describe("error registry", () => {
  test("every code has a category, severity and exit", () => {
    for (const [code, info] of Object.entries(CODES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(["error", "warning", "info"]).toContain(info.severity);
      expect(typeof info.exit).toBe("number");
    }
  });

  test("exits DESIGN pins down outside the registry's categories", () => {
    // §8 "Backfills": a --from that cannot apply is a usage error, not a failed asset.
    expect(CODES.BACKFILL_WOULD_DUPLICATE.exit).toBe(EXIT.INVALID);
    expect(CODES.BACKFILL_UNSUPPORTED.exit).toBe(EXIT.INVALID);
    expect(exitCodeFor([problem("BACKFILL_UNSUPPORTED", { message: "x", hint: "y" })])).toBe(EXIT.INVALID);
    expect(exitCodeFor([problem("BACKFILL_WOULD_DUPLICATE", { message: "x", hint: "y" }), problem("HTTP_ERROR", { message: "x", hint: "y" })])).toBe(EXIT.FAILED);
  });

  test("CroftError carries a full problem", () => {
    const e = new CroftError("SHRINK_GUARD", { message: "would remove 265 of 265 rows", hint: "find out why" });
    expect(e.problem).toMatchObject({ severity: "error", code: "SHRINK_GUARD", docs: "croft docs SHRINK_GUARD" });
    expect(e.exit).toBe(EXIT.FAILED);
  });

  test("exit precedence: checks-only is 3, any other failure is 1", () => {
    const check = problem("CHECK_FAILED", { message: "x", hint: "y" });
    const http = problem("HTTP_ERROR", { message: "x", hint: "y" });
    const warn = problem("MIXED_TYPES", { message: "x", hint: "y" });
    expect(exitCodeFor([check])).toBe(EXIT.CHECKS_FAILED);
    expect(exitCodeFor([check, http])).toBe(EXIT.FAILED);
    expect(exitCodeFor([warn])).toBe(EXIT.OK);
    expect(exitCodeFor([], { pendingConfirmation: true })).toBe(EXIT.NEEDS_HUMAN);
    expect(exitCodeFor([], { stillRunning: true })).toBe(EXIT.STILL_RUNNING);
  });

  test("CHECK_FAILED mixed with another failure is 1, unless the others are all busy (4) or needs-a-human (5)", () => {
    const p = (code: keyof typeof CODES) => problem(code, { message: "x", hint: "y" });
    const check = p("CHECK_FAILED");
    // §4.3: 3 only when every failure is CHECK_FAILED. Exit-2 codes must not be hidden behind the 3.
    expect(exitCodeFor([check, p("SECRET_MISSING")])).toBe(EXIT.FAILED);
    expect(exitCodeFor([check, p("SQL_SYNTAX")])).toBe(EXIT.FAILED);
    expect(exitCodeFor([p("UNKNOWN_COLUMN"), check, check])).toBe(EXIT.FAILED);
    expect(exitCodeFor([check, p("QUERY_TOO_MANY_ROWS")])).toBe(EXIT.FAILED);           // coordination, but exit 2
    expect(exitCodeFor([check, p("TYPE_CONFLICT")])).toBe(EXIT.FAILED);
    expect(exitCodeFor([check, { severity: "error", code: "NOT_REGISTERED", message: "x", hint: "y", docs: "d" }])).toBe(EXIT.FAILED);
    // Coordination and safety outcomes keep their own codes: retry later, or ask a human.
    expect(exitCodeFor([check, p("DB_BUSY")])).toBe(EXIT.BUSY);
    expect(exitCodeFor([check, p("CONFIRMATION_REQUIRED")])).toBe(EXIT.NEEDS_HUMAN);
    expect(exitCodeFor([check, p("ASSET_BUSY"), p("REQUIRES_HUMAN")])).toBe(EXIT.NEEDS_HUMAN);
    expect(exitCodeFor([check, p("DB_BUSY"), p("SQL_SYNTAX")])).toBe(EXIT.FAILED);
    // Warnings never count; INTERRUPTED and still-running win as before.
    expect(exitCodeFor([check, p("MIXED_TYPES")])).toBe(EXIT.CHECKS_FAILED);
    expect(exitCodeFor([check, p("INTERRUPTED")])).toBe(EXIT.INTERRUPTED);
    // Without CHECK_FAILED nothing changes.
    expect(exitCodeFor([p("SQL_SYNTAX")])).toBe(EXIT.INVALID);
    expect(exitCodeFor([p("SQL_SYNTAX"), p("DB_BUSY")])).toBe(EXIT.BUSY);
    expect(exitCodeFor([p("SQL_SYNTAX"), p("HTTP_ERROR")])).toBe(EXIT.FAILED);
  });
});

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
});

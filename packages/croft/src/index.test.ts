import { describe, expect, test } from "bun:test";
import { CroftError, EXIT, exitCodeFor, problem } from "./core/errors.ts";
import { fail } from "./index.ts";

function caught(fn: () => never): CroftError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("fail() returned");
}

describe("fail()", () => {
  test("KEYSET_STUCK passes through, with a hint that says what to do", () => {
    const e = caught(() => fail("KEYSET_STUCK", "100+ issues share one updated_at"));
    expect(e.code).toBe("KEYSET_STUCK");
    expect(e.message).toBe("100+ issues share one updated_at");
    expect(e.problem.hint).not.toMatch(/^croft docs/);
    expect(e.problem.hint).toContain("page");
    expect(e.problem.docs).toBe("croft docs KEYSET_STUCK");
    expect(e.exit).toBe(EXIT.FAILED);
  });

  test("control-flow, safety and check codes cannot be raised by asset code", () => {
    for (const code of ["INTERRUPTED", "CHECK_FAILED", "CONFIRMATION_REQUIRED", "DB_BUSY", "SQL_SYNTAX", "TYPE_CONFLICT"]) {
      const e = caught(() => fail(code, "nope"));
      expect(e.code).toBe("ASSET_CODE_ERROR");
      expect(e.problem.details).toEqual({ requestedCode: code });
      expect(e.message).toBe(`${code}: nope`);
      expect(e.exit).toBe(EXIT.FAILED);
    }
    // An asset's fail("INTERRUPTED") no longer outranks every other failure of the run, and
    // fail("CHECK_FAILED") no longer reads as "only blocking checks failed".
    const typeConflict = problem("TYPE_CONFLICT", { message: "x", hint: "y" });
    expect(exitCodeFor([caught(() => fail("INTERRUPTED", "x")).problem, typeConflict])).toBe(EXIT.FAILED);
    expect(exitCodeFor([caught(() => fail("CHECK_FAILED", "x")).problem])).toBe(EXIT.FAILED);
  });

  test("an unregistered code is the asset's own: ASSET_CODE_ERROR naming it", () => {
    const e = caught(() => fail("RATE_PLAN_EXPIRED", "the API plan ran out"));
    expect(e.code).toBe("ASSET_CODE_ERROR");
    expect(e.message).toBe("RATE_PLAN_EXPIRED: the API plan ran out");
    expect(e.problem.details).toEqual({ requestedCode: "RATE_PLAN_EXPIRED" });
  });
});

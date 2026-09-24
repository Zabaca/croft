// Every registered code (core/errors.ts, DESIGN.md §9 "The codes") is raised somewhere in croft's source, or
// listed in NOT_YET_RAISED with the later phase that raises it. So the registry cannot promise a code no build
// reports, and a phase cannot ship with its codes unraised.
//
// "Raised" means the code's name is a string in a value position of a non-test source file other than the
// registry itself: new CroftError("X", …), problem("X", …), `code: "X"`, `?? "X"`, a table of codes. Not
// counted: comparisons (`p.code === "X"`), case labels, `[…].includes()` lists, types and property names.
//
// NOT_YET_RAISED only shrinks. Whoever raises a listed code removes it here in the same change (this is an
// orchestrator file: ask for it in needed_shared_changes); the test fails until they do.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";
import { sourceFiles, SRC } from "../agent/contract-testkit.ts";
import { CODES, type Code, isCode } from "./errors.ts";
import { PHASE } from "./phase.ts";

/** Codes no source raises yet, with the phase (DESIGN.md §11) that raises them. */
const NOT_YET_RAISED: Partial<Record<Code, number>> = {
  // Phase 3: the scheduler.
  SCHEDULE_HELD: 3,
  SCHEDULER_STALE: 3,
  // Phase 4: rename, config and pin changes, drift.
  ASSET_RENAMED: 4,
  INGEST_CONFIG_CHANGED: 4,
  PIN_CHANGES_DATA: 4,
  EMPTY_EXTRACT: 4,
};

const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** Whether a code string only tests for the code instead of raising it. */
function onlyTests(n: ts.StringLiteralLike): boolean {
  const p = n.parent;
  if (ts.isBinaryExpression(p) && EQUALITY.has(p.operatorToken.kind)) return true;
  if (ts.isCaseClause(p)) return true;
  // ["A", "B"].includes(code)
  if (ts.isArrayLiteralExpression(p) && ts.isPropertyAccessExpression(p.parent) && p.parent.expression === p
    && p.parent.name.text === "includes") return true;
  return false;
}

/** Registered codes raised in `text`, with where. */
function raisedIn(file: string, text: string): { code: Code; line: number }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: { code: Code; line: number }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isLiteralTypeNode(n)) return;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && isCode(n.text)) {
      const p = n.parent;
      const isName = (ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === n;
      if (!isName && !onlyTests(n)) out.push({ code: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function raisedCodes(): Map<Code, string[]> {
  const out = new Map<Code, string[]>();
  for (const file of sourceFiles()) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (rel === "core/errors.ts") continue;
    for (const r of raisedIn(file, readFileSync(file, "utf8"))) {
      const at = out.get(r.code) ?? [];
      at.push(`src/${rel}:${r.line}`);
      out.set(r.code, at);
    }
  }
  return out;
}

describe("every registered code is raised, or listed for a later phase", () => {
  const raised = raisedCodes();

  test("the scan counts raising, not testing", () => {
    const text = `throw new CroftError("CYCLE", x); problem("CHECK_INVALID", y); const c = o.code ?? "SQL_NOT_SELECT";
if (p.code === "CHECK_FAILED" || "LARGE_REPROCESS" !== q) {}
switch (c) { case "VOLATILE_SQL": break; }
if (["INPUT_NOT_BUILT", "CYCLE"].includes(c)) {}
type T = "UNDECLARED_INPUT"; const m = { "QUOTE_IDENTIFIER": 1 };`;
    expect(raisedIn("x.ts", text).map((r) => r.code)).toEqual(["CYCLE", "CHECK_INVALID", "SQL_NOT_SELECT"]);
  });

  test("every code is raised in the source or listed in NOT_YET_RAISED", () => {
    const missing = (Object.keys(CODES) as Code[]).filter((c) => !raised.has(c) && NOT_YET_RAISED[c] === undefined);
    expect(missing).toEqual([]);
  });

  test("a listed code is registered, and comes in a phase after this one", () => {
    for (const [code, phase] of Object.entries(NOT_YET_RAISED)) {
      expect(isCode(code), code).toBe(true);
      expect(phase, `${code} is listed for phase ${phase}, but this build is phase ${PHASE}: raise it`).toBeGreaterThan(PHASE);
    }
  });

  test("a listed code is still unraised: the list only shrinks", () => {
    const stale = Object.keys(NOT_YET_RAISED).filter((c) => raised.has(c as Code)).map((c) => `${c} (${raised.get(c as Code)!.join(", ")})`);
    expect(stale, "these codes are raised now; remove them from NOT_YET_RAISED").toEqual([]);
  });
});

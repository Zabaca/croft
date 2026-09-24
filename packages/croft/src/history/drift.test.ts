// Recent drift (history/drift.ts, DESIGN.md §7 "Drift that does not fail a load is still reported"): the
// COLUMN_STOPPED_ARRIVING, JSON_KIND_CHANGED and TYPE_WIDENED warnings runs recorded in their summaries, read back for
// status, context and doctor without opening the warehouse.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Problem } from "../core/types.ts";
import { DRIFT_CODES, driftChange, driftNote, driftText, recentDrift } from "./drift.ts";
import { RunsDb } from "./runs-db.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function db(): { runs: RunsDb; at: (iso: string) => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-drift-")));
  dirs.push(dir);
  let clock = new Date("2026-09-20T00:00:00Z");
  const runs = RunsDb.open(dir, { now: () => clock });
  return { runs, at: (iso) => (clock = new Date(iso)) };
}

const warn = (code: string, asset: string, details: Record<string, unknown>, extra: Partial<Problem> = {}): Problem =>
  ({ severity: "warning", code, message: `${code} message`, hint: "h", docs: "", asset, details, ...extra });

/** A finished run whose summary is the run engine's command result, with these problems. */
function run(d: ReturnType<typeof db>, iso: string, problems: Problem[], o: { running?: boolean } = {}): string {
  d.at(iso);
  const r = d.runs.createRun({ trigger: "manual", human: true, argv: ["run"] });
  if (!o.running) d.runs.finishRun(r.id, "succeeded", { data: { runId: r.id, status: "succeeded", steps: [] }, problems, next: [], exit: 0, ok: true });
  return r.id;
}

describe("driftText", () => {
  test("a few words per warning", () => {
    expect(driftText("COLUMN_STOPPED_ARRIVING", { column: "login" })).toBe("login stopped arriving");
    expect(driftText("JSON_KIND_CHANGED", { column: "user", before: ["object"], added: ["string", "number"] })).toBe("user now also string, number");
    expect(driftText("TYPE_WIDENED", { column: "amount", from: "BIGINT", to: "DOUBLE" })).toBe("amount BIGINT → DOUBLE");
    expect(driftText("TYPE_WIDENED", {})).toBe("a column widened");
  });
});

describe("recentDrift", () => {
  test("no runs.sqlite, no drift", () => {
    expect(recentDrift(null, new Date(0))).toEqual([]);
  });

  test("the three codes of runs since `since`, newest first, one per asset, code and column (the latest)", () => {
    const d = db();
    run(d, "2026-09-10T00:00:00Z", [warn("COLUMN_STOPPED_ARRIVING", "issues", { column: "old" })]);           // before since
    const r1 = run(d, "2026-09-21T09:00:00Z", [
      warn("COLUMN_STOPPED_ARRIVING", "issues", { column: "login", readBy: ["open_issues"] }),
      warn("CHECK_FAILED", "issues", {}),                                                                     // not drift
      warn("JSON_KIND_CHANGED", "issues", { column: "user", before: ["object"], added: ["string"] }),
    ]);
    const r2 = run(d, "2026-09-22T09:00:00Z", [
      warn("COLUMN_STOPPED_ARRIVING", "issues", { column: "login", readBy: ["open_issues"] }),
      warn("TYPE_WIDENED", "orders", { column: "amount", from: "BIGINT", to: "DOUBLE" }),
      warn("TYPE_WIDENED", "orders", { column: "amount", from: "BIGINT", to: "DOUBLE" }),                    // repeated in one run
      { ...warn("JSON_KIND_CHANGED", "x", { column: "c" }), asset: undefined },                               // no asset: skipped
    ]);
    run(d, "2026-09-23T09:00:00Z", [warn("JSON_KIND_CHANGED", "issues", { column: "user" })], { running: true });  // no summary yet
    const out = recentDrift(d.runs, new Date("2026-09-15T00:00:00Z"));
    expect(out.map((e) => [e.asset, e.code, e.column, e.runId, e.text])).toEqual([
      ["issues", "COLUMN_STOPPED_ARRIVING", "login", r2, "login stopped arriving"],
      ["orders", "TYPE_WIDENED", "amount", r2, "amount BIGINT → DOUBLE"],
      ["issues", "JSON_KIND_CHANGED", "user", r1, "user now also string"],
    ]);
    expect(out[0]).toMatchObject({ at: "2026-09-22T09:00:00.000Z", readBy: ["open_issues"] });
    expect(new Set(out.map((e) => e.code))).toEqual(new Set(DRIFT_CODES));
  });
});

describe("driftNote and driftChange", () => {
  const e = (column: string, code: (typeof DRIFT_CODES)[number] = "COLUMN_STOPPED_ARRIVING") =>
    ({ asset: "a", code, column, text: `${column} stopped arriving`, at: "2026-09-22T09:00:00.000Z", runId: "r", readBy: [], details: {} });
  test("a short note: the first three, then a count", () => {
    expect(driftNote([e("a")])).toBe("drift: a stopped arriving");
    expect(driftNote([e("a"), e("b"), e("c"), e("d"), e("f")])).toBe("drift: a stopped arriving, b stopped arriving, c stopped arriving (+2 more)");
    expect(driftNote([])).toBe("");
  });
  test("as a schema change of context.recentSchemaChanges", () => {
    expect(driftChange(e("login"))).toEqual({ kind: "column_stopped_arriving", column: "login" });
    expect(driftChange({ ...e("user", "JSON_KIND_CHANGED"), details: { before: ["object"], added: ["string"] } }))
      .toEqual({ kind: "json_kind_changed", column: "user", from: "object", to: "object, string" });
    expect(driftChange({ ...e("amount", "TYPE_WIDENED"), details: { from: "BIGINT", to: "DOUBLE" } }))
      .toEqual({ kind: "widen", column: "amount", from: "BIGINT", to: "DOUBLE" });
  });
});

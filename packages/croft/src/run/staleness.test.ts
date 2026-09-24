import { describe, expect, test } from "bun:test";
import type { CatalogAsset, InputSeen } from "../history/catalog.ts";
import { editedProblem, noteTimeZoneChange, type StaleView, staleReasons, timeZoneChange } from "./staleness.ts";

// Stamps: microseconds apart matter (a Date would lose them).
const S1 = "2026-09-22T10:00:00.000001Z";
const S2 = "2026-09-22T10:00:00.000002Z";
const S3 = "2026-09-22T11:30:00.000000Z";

function entry(asset: string, o: Partial<CatalogAsset> = {}): CatalogAsset {
  return {
    asset, kind: "sql", behavior: "replace", write: "replace", key: [], rows: 10, columns: [], cursor: null,
    lastLoadedAt: S1, lastReplacedAt: null, lastRunId: "r_1", codeHash: "h1", ...o,
  };
}

const seen = (inputLastLoadedAt: string | null, seenLoadedAt: string | null = inputLastLoadedAt): InputSeen => ({ seenLoadedAt, seenKey: null, inputLastLoadedAt });

function view(o: Partial<StaleView> = {}): StaleView {
  return {
    asset: "daily_revenue", file: "assets/daily_revenue.sql", kind: "sql", incremental: false, inputs: ["charges"], codeHash: "h1",
    entry: entry("daily_revenue", { inputsSeen: { charges: seen(S1) } }),
    inputEntries: { charges: entry("charges", { kind: "ingest", lastLoadedAt: S1 }) },
    ...o,
  };
}

const withInput = (o: Partial<CatalogAsset> | null, s?: InputSeen | null) => view({
  inputEntries: { charges: o === null ? null : entry("charges", { kind: "ingest", ...o }) },
  entry: entry("daily_revenue", s === null ? {} : { inputsSeen: { charges: s ?? seen(S1) } }),
});

describe("staleReasons", () => {
  test("fresh: built with this code, every input read at its current version", () => {
    expect(staleReasons(view())).toEqual([]);
  });

  test("never built", () => {
    expect(staleReasons(view({ entry: null }))).toEqual(["never_built"]);
    expect(staleReasons(view({ kind: "ingest", inputs: [], entry: null }))).toEqual(["never_built"]);
    expect(staleReasons(view({ kind: "ts", incremental: true, entry: null }))).toEqual(["never_built"]);
  });

  test("ingests are only ever never_built: code and inputs do not make them run", () => {
    expect(staleReasons(view({ kind: "ingest", inputs: [], codeHash: "h2" }))).toEqual([]);
  });

  test("code_changed for SQL and full-refresh TS; incremental TS is forward-only", () => {
    expect(staleReasons(view({ codeHash: "h2" }))).toEqual(["code_changed"]);
    expect(staleReasons(view({ kind: "ts", codeHash: "h2" }))).toEqual(["code_changed"]);
    expect(staleReasons(view({ kind: "ts", incremental: true, codeHash: "h2" }))).toEqual([]);
  });

  test("an unknown code hash is not a change", () => {
    expect(staleReasons(view({ codeHash: undefined }))).toEqual([]);
    expect(staleReasons(view({ entry: entry("daily_revenue", { codeHash: null, inputsSeen: { charges: seen(S1) } }) }))).toEqual([]);
  });

  test("input_changed: the input's lastLoadedAt is newer than what the transform read, by a microsecond too", () => {
    expect(staleReasons(withInput({ lastLoadedAt: S2 }))).toEqual(["input_changed"]);
    expect(staleReasons(withInput({ lastLoadedAt: S1 }))).toEqual([]);
    // An input restamped backwards (not croft's doing) is not a change.
    expect(staleReasons(withInput({ lastLoadedAt: "2026-09-22T09:00:00Z" }))).toEqual([]);
    // Offsets and precision are compared as instants.
    expect(staleReasons(withInput({ lastLoadedAt: "2026-09-22T03:00:00.000001-07:00" }))).toEqual([]);
    expect(staleReasons(withInput({ lastLoadedAt: "2026-09-22T03:00:00.000002-07:00" }))).toEqual(["input_changed"]);
  });

  test("input_changed: never read in full, or never read at all, while the input has rows", () => {
    // An incremental transform that committed part of a snapshot.
    expect(staleReasons(withInput({ lastLoadedAt: S1 }, seen(null, S1)))).toEqual(["input_changed"]);
    // An input added to the transform since it last ran.
    expect(staleReasons(withInput({ lastLoadedAt: S1 }, null))).toEqual(["input_changed"]);
  });

  test("an input that never had rows, or is not built, changes nothing", () => {
    expect(staleReasons(withInput({ lastLoadedAt: null }, null))).toEqual([]);
    expect(staleReasons(withInput(null, null))).toEqual([]);
    expect(staleReasons(view({ inputs: ["charges", "refunds"] }))).toEqual([]);
  });

  test("input_replaced: the input was replaced after the transform last read it", () => {
    expect(staleReasons(withInput({ lastLoadedAt: S1, lastReplacedAt: S3 }))).toEqual(["input_replaced"]);
    // Replaced with a write: both.
    expect(staleReasons(withInput({ lastLoadedAt: S3, lastReplacedAt: S3 }))).toEqual(["input_changed", "input_replaced"]);
    // Read again since: fresh.
    expect(staleReasons(withInput({ lastLoadedAt: S1, lastReplacedAt: S3 }, seen(S3, S1)))).toEqual([]);
    expect(staleReasons(withInput({ lastLoadedAt: S3, lastReplacedAt: S2 }, seen(S3)))).toEqual([]);
  });

  test("reasons come in core/types.ts Reason order, each once, over several inputs", () => {
    const v = view({
      codeHash: "h2", inputs: ["a", "b", "c"],
      entry: entry("daily_revenue", { inputsSeen: { a: seen(S1), b: seen(S1), c: seen(S1) } }),
      inputEntries: {
        a: entry("a", { lastLoadedAt: S2, lastReplacedAt: S2 }),
        b: entry("b", { lastLoadedAt: S3 }),
        c: entry("c", { lastLoadedAt: S1 }),
      },
    });
    expect(staleReasons(v)).toEqual(["code_changed", "input_changed", "input_replaced"]);
  });

  test("input names match without regard to case when that is unambiguous", () => {
    const v = view({ inputs: ["Charges"], entry: entry("daily_revenue", { inputsSeen: { charges: seen(S1) } }), inputEntries: { charges: entry("charges", { lastLoadedAt: S2 }) } });
    expect(staleReasons(v)).toEqual(["input_changed"]);
  });

  test("incremental TS transforms still run for new input rows", () => {
    const v = view({ kind: "ts", incremental: true, asset: "issue_triage", codeHash: "h2" });
    expect(staleReasons({ ...v, inputEntries: { charges: entry("charges", { lastLoadedAt: S2 }) } })).toEqual(["input_changed"]);
  });
});

describe("editedProblem", () => {
  test("null when unedited, never built, or the hash is unknown", () => {
    expect(editedProblem(view())).toBeNull();
    expect(editedProblem(view({ entry: null, codeHash: "h2" }))).toBeNull();
    expect(editedProblem(view({ codeHash: undefined }))).toBeNull();
  });

  test("an incremental TS transform: how many rows older code built, and no command that does not exist", () => {
    const p = editedProblem(view({ asset: "issue_triage", file: "assets/issue_triage.ts", kind: "ts", incremental: true, codeHash: "h2", entry: entry("issue_triage", { rows: 18556 }) }))!;
    expect(p).toMatchObject({
      code: "EDITED_SINCE_LAST_RUN", severity: "warning", asset: "issue_triage", file: "assets/issue_triage.ts",
      message: "issue_triage edited since its last run; 18,556 rows were built by older code",
      details: { codeHash: "h2", builtWith: "h1", rows: 18556 },
    });
    expect(p.fix).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("--");
    expect(editedProblem(view({ kind: "ts", incremental: true, codeHash: "h2", entry: entry("x", { rows: 1 }) }))!.message).toEndWith("1 row was built by older code");
  });

  test("SQL and full-refresh TS transforms: the next run rebuilds them", () => {
    const p = editedProblem(view({ codeHash: "h2" }))!;
    expect(p).toMatchObject({
      code: "EDITED_SINCE_LAST_RUN", asset: "daily_revenue", file: "assets/daily_revenue.sql",
      fix: { kind: "command", command: "croft run daily_revenue" },
    });
    expect(p.message).toBe("daily_revenue edited since its last run; its table still holds what the previous code built");
  });

  test("ingests: the next run fetches with the new code", () => {
    const p = editedProblem(view({ asset: "charges", kind: "ingest", inputs: [], codeHash: "h2", entry: entry("charges", { kind: "ingest" }) }))!;
    expect(p).toMatchObject({ message: "charges edited since its last run", fix: { kind: "command", command: "croft run charges" } });
  });
});

describe("time zone changes", () => {
  // The code hash includes croft.json's timezone (§8), so changing it changes every hash: the transform rebuilds
  // (code_changed), but nothing was edited.
  test("a hash that differs only by the project time zone still rebuilds, and is no edit", () => {
    const v = view({ codeHash: "h2", builtInZone: "America/Los_Angeles" });
    expect(timeZoneChange(v)).toBe("America/Los_Angeles");
    expect(staleReasons(v)).toEqual(["code_changed"]);
    expect(editedProblem(v)).toBeNull();
    expect(editedProblem({ ...v, kind: "ts", incremental: true })).toBeNull();
    expect(editedProblem({ ...v, kind: "ingest", inputs: [] })).toBeNull();
    expect(timeZoneChange(view({ codeHash: "h2" }))).toBeNull();
    // Unchanged code has no time zone change to report.
    expect(timeZoneChange(view({ builtInZone: "America/Los_Angeles" }))).toBeNull();
  });

  test("what resolveProject found is noted by hash pair, so a view made without it (status) knows too", () => {
    noteTimeZoneChange("tz-now", "tz-then", "Asia/Tokyo");
    const v = view({ codeHash: "tz-now", entry: entry("daily_revenue", { codeHash: "tz-then", inputsSeen: { charges: seen(S1) } }) });
    expect(timeZoneChange(v)).toBe("Asia/Tokyo");
    expect(editedProblem(v)).toBeNull();
    // The same code hash against another build's hash is an edit.
    const edited = view({ codeHash: "tz-now", entry: entry("daily_revenue", { codeHash: "tz-other", inputsSeen: { charges: seen(S1) } }) });
    expect(timeZoneChange(edited)).toBeNull();
    expect(editedProblem(edited)?.code).toBe("EDITED_SINCE_LAST_RUN");
  });
});

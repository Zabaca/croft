import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CatalogAsset, type CatalogColumn, putCatalog } from "../history/catalog.ts";
import { tryAcquire } from "../history/leases.ts";
import { RunsDb } from "../history/runs-db.ts";
import { loadProject } from "../project/root.ts";
import { dryRun, formatDryRun, type DryRunInput } from "./dry-run.ts";
import { cleanupProjects, makeProject } from "./testkit.ts";

afterAll(() => cleanupProjects());

const T1 = "2026-09-22T17:00:00.000000Z";
const T2 = "2026-09-22T18:00:00.000000Z";
const NOW = new Date("2026-09-22T19:00:00.000Z");
const col = (name: string, type: string): CatalogColumn => ({ name, type, sourceName: name, pinned: false, pending: false, format: null });

function entry(asset: string, o: Partial<CatalogAsset> = {}): CatalogAsset {
  return {
    asset, kind: "ingest", behavior: "", write: "replace", key: [], rows: 10, columns: [], cursor: null,
    lastLoadedAt: T1, lastReplacedAt: null, lastRunId: "r_0922_1000_aaaa", codeHash: null, ...o,
  };
}

const ingest = (config: string) => `import { ingest } from "@zabaca/croft";\nexport default ingest({ ${config} async *rows() {} });\n`;

const FILES = {
  "assets/charges.ts": ingest(`key: "id", incremental: { field: "created", unit: "s", lookback: "30 days" },`),
  "assets/issues.ts": ingest(`key: "id", incremental: "updated_at",`),
  "assets/fresh.ts": ingest(`key: "id", incremental: "updated_at",`),
  "assets/zones.ts": ingest(""),
  "assets/sales.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/sales/*.csv", incremental: true, key: "order_id" });\n`,
  "assets/consts.sql": "SELECT 1 AS x\n",
};

const FILES_EVENTS = ingest(`write: "append", incremental: "seq",`);

const CATALOG: CatalogAsset[] = [
  entry("charges", { write: "merge", key: ["id"], rows: 1130, cursor: { field: "created", value: "1758600000", type: "integer", unit: "s" } }),
  entry("issues", {
    write: "merge", key: ["id"], rows: 5000, columns: [col("id", "BIGINT"), col("title", "VARCHAR"), col("_loaded_at", "TIMESTAMPTZ")],
    cursor: { field: "updated_at", value: "2026-09-22T17:58:03Z", type: "timestamp", unit: null },
  }),
  entry("zones", { rows: 265 }),
];

/** A project with runs.sqlite holding `catalog`, and a dry run over it. */
function setup(files: Record<string, string>, catalog: CatalogAsset[] = CATALOG, seed?: (db: RunsDb) => void) {
  const root = makeProject(files);
  const project = loadProject({ root });
  const db = RunsDb.open(project.paths.stateDir, { now: () => new Date(T2) });
  try {
    for (const c of catalog) putCatalog(db, c);
    seed?.(db);
  } finally {
    db.close();
  }
  const run = (i: Partial<DryRunInput> = {}) => dryRun({ project, selectors: [], now: NOW, ...i });
  return { root, project, run };
}

const stepsOf = (d: { steps: { asset: string }[] }) => Object.fromEntries(d.steps.map((s) => [s.asset, s])) as Record<string, any>;

describe("croft run --dry-run", () => {
  test("windows: the saved cursor minus the lookback, echoed with the project offset; a first load fetches everything", async () => {
    const { run } = setup(FILES);
    const out = await run();
    expect(out.exit).toBe(0);
    expect(out.data.dryRun).toBe(true);
    expect(out.data.order).toEqual(["charges", "consts", "fresh", "issues", "sales", "zones"]);
    const s = stepsOf(out.data);
    // An epoch cursor: seconds, echoed as an instant; the 30-day lookback comes off the saved value.
    expect(s.charges).toMatchObject({
      kind: "rows", action: "fetch", behavior: "merge by id",
      window: { sinceValue: 1756008000, sinceType: "integer", sinceAt: "2025-08-23T21:00:00-07:00", source: "saved", saved: "1758600000", lookback: "30 days" },
      reason: "merge by id, since 1756008000 (2025-08-23T21:00:00-07:00) = saved − 30 days",
    });
    // A keyed timestamp cursor re-reads 1 s by default (§3a "Boundary rows").
    expect(s.issues.window).toEqual({
      sinceValue: "2026-09-22T17:58:02Z", sinceType: "timestamp", sinceAt: "2026-09-22T10:58:02-07:00", source: "saved", saved: "2026-09-22T17:58:03Z", lookback: "1 second",
    });
    expect(s.fresh).toMatchObject({ reason: "merge by id, first load: fetches everything" });
    expect(s.fresh.window).toBeUndefined();
    expect(s.zones).toMatchObject({ reason: "replace", reasons: ["requested"] });
    expect(s.sales).toMatchObject({ kind: "file", reason: "merge by order_id, new and changed files only" });
    expect(s.consts).toMatchObject({ kind: "sql", action: "rebuild", reason: "never built" });
    expect(out.next).toEqual([{ command: "croft run", reason: "run it" }]);
  });

  test("--from: converted to the cursor's type and echoed; refused as the run refuses it; skipped where it does not apply", async () => {
    const { run } = setup({ ...FILES, "assets/events.ts": FILES_EVENTS },
      [...CATALOG, entry("events", { write: "append", cursor: { field: "seq", value: "5", type: "integer", unit: null } })]);
    const out = await run({ selectors: ["charges", "issues"], from: "-7d" });
    const s = stepsOf(out.data);
    expect(s.charges.window).toEqual({ sinceValue: 1789498800, sinceType: "integer", sinceAt: "2026-09-15T12:00:00-07:00", source: "from", saved: "1758600000" });
    expect(s.charges.reason).toBe("merge by id, since 1789498800 (2026-09-15T12:00:00-07:00) from --from -7d");
    expect(s.issues.window).toMatchObject({ sinceValue: "2026-09-15T19:00:00Z", source: "from" });
    expect(out.next).toEqual([{ command: "croft run charges issues --from -7d", reason: "run it" }]);

    await expect(run({ selectors: ["consts"], from: "-7d" })).rejects.toMatchObject({ code: "BACKFILL_UNSUPPORTED" });
    await expect(run({ selectors: ["events"], from: "3" })).rejects.toMatchObject({ code: "BACKFILL_WOULD_DUPLICATE" });
    await expect(run({ selectors: ["charges"], from: "not a date" })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    // A bare run skips what --from does not apply to, with the reason, and still plans the rest. (A --from the
    // cursor's type cannot take refuses the whole command, as it does for the run.)
    await expect(run({ from: "3" })).rejects.toMatchObject({ code: "USAGE_ERROR", message: expect.stringContaining('--from "3"') });
    const small = setup({ "assets/events.ts": FILES_EVENTS, "assets/zones.ts": FILES["assets/zones.ts"], "assets/consts.sql": FILES["assets/consts.sql"] },
      [entry("zones", { rows: 265 }), entry("events", { write: "append", cursor: { field: "seq", value: "5", type: "integer", unit: null } })]);
    const bare = stepsOf((await small.run({ from: "3" })).data);
    expect(bare.zones).toMatchObject({ action: "skip", skippedBecause: "--from applies to merge ingests" });
    expect(bare.consts).toMatchObject({ action: "skip", skippedBecause: "--from applies to merge ingests" });
    expect(bare.events.action).toBe("skip");
    expect(bare.events.skippedBecause).toContain("before its saved position 5");
  });

  test("--allow-shrink: the rows that would go to the trash, and no token; allowShrink in code needs none", async () => {
    const { run, project } = setup({ ...FILES, "assets/lax.ts": ingest("allowShrink: true,") }, [...CATALOG, entry("lax", { rows: 40 })]);
    const out = await run({ selectors: ["zones"], allowShrink: true });
    expect(out.data.steps.map((s) => s.asset)).toEqual(["zones"]);
    expect(out.data.steps[0]!.confirmation).toMatchObject({
      action: "allow_shrink", command: "croft run zones --allow-shrink", impact: { asset: "zones", rows: 265, downstream: [] },
    });
    expect(out.data.steps[0]!.confirmation!.impact.trashPath).toContain(join(".croft", "trash", "zones"));
    // A destructive command never appears in next (§4.3).
    expect(out.next).toEqual([]);
    const db = RunsDb.open(project.paths.stateDir);
    try {
      expect(db.sqlite.query("SELECT count(*) AS n FROM confirmations").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    expect((await run({ selectors: ["lax"], allowShrink: true })).data.steps[0]!.confirmation).toBeUndefined();
    // The run's own flag rules apply: exactly one replace ingest.
    await expect(run({ selectors: ["issues"], allowShrink: true })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(run({ selectors: ["zones", "charges"], allowShrink: true })).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  test("the cost guard: an incremental transform that makes requests shows its pending rows, estimated from runs.sqlite", async () => {
    const triage = (above = "") => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"], key: "id", incremental: true, ${above}
  async *rows({ newRows, http }) { for await (const r of newRows("issues")) { await http.get("https://example.test/" + r.id); yield r; } },
});
`;
    // Never built: every row of issues is pending.
    const first = setup({ ...FILES, "assets/triage.ts": triage() });
    const s = stepsOf((await first.run({ selectors: ["triage"] })).data);
    expect(s.triage).toMatchObject({ action: "update", reason: "never built" });
    expect(s.triage.confirmation).toEqual({
      action: "large_reprocess", command: "croft run triage",
      impact: { asset: "triage", action: "incremental transform; LARGE_REPROCESS override", rows: 5000, downstream: [], estimatedRequests: 5000 },
    });
    expect(formatDryRun((await first.run({ selectors: ["triage"] })).data)).toContain("needs confirmation: about 5,000 input rows to process");
    expect(stepsOf((await setup({ ...FILES, "assets/triage.ts": triage("confirmAbove: 10000,") }).run({ selectors: ["triage"] })).data).triage.confirmation).toBeUndefined();

    // Built: the rows issues' steps wrote since the position triage saved.
    const built = [...CATALOG.map((c) => (c.asset === "issues" ? { ...c, lastLoadedAt: T2 } : c)),
      entry("triage", { kind: "ts", write: "merge", key: ["id"], inputsSeen: { issues: { seenLoadedAt: T1, seenKey: [7], inputLastLoadedAt: T1 } } })];
    const since = setup({ ...FILES, "assets/triage.ts": triage() }, built, (db) => {
      const r = db.createRun({ trigger: "manual", human: true, argv: ["run", "issues"] });
      db.startStep({ runId: r.id, asset: "issues", attempt: 1, reason: "requested" });
      db.finishStep(r.id, "issues", 1, { status: "ok", rows: { in: 1600, added: 1500, updated: 10 } });
    });
    const later = stepsOf((await since.run({ selectors: ["triage"] })).data).triage;
    expect(later.reason).toBe("input issues has new rows");
    expect(later.confirmation.impact).toMatchObject({ rows: 1510, estimatedRequests: 1510 });
  });

  test("a step that would fail before it runs is shown with its problem; what reads it is skipped, as the runner skips it", async () => {
    const { run } = setup({
      ...FILES,
      "assets/typo.sql": "-- key: id\nSELECT id, titel FROM issues\n",
      "assets/after.sql": "SELECT id FROM typo\n",
      "assets/last.sql": "SELECT id FROM after\n",
    });
    const out = await run({ selectors: ["typo"] });
    expect(out.data.order).toEqual(["typo", "after", "last"]);
    const s = stepsOf(out.data);
    expect(s.typo).toMatchObject({ action: "rebuild", problems: [{ code: "UNKNOWN_COLUMN", line: 2 }] });
    expect(s.after).toMatchObject({ action: "skip", skippedBecause: "input typo would fail (UNKNOWN_COLUMN)", problems: [] });
    expect(s.last).toMatchObject({ action: "skip", skippedBecause: "input after is skipped (input typo would fail (UNKNOWN_COLUMN))" });
    // The dry run itself worked: exit 0, with the problem listed for the agent to fix.
    expect(out.exit).toBe(0);
    expect(out.problems.map((p) => p.code)).toEqual(["UNKNOWN_COLUMN"]);
    expect(out.next).toEqual([{ command: "croft validate", reason: "see every problem of the project with its fix" }]);
    const text = formatDryRun(out.data);
    expect(text.split("\n")).toEqual([
      "rebuild  typo             never built",
      `                          fails before it runs: UNKNOWN_COLUMN ${s.typo.problems[0].message}`,
      "skip     after            input typo would fail (UNKNOWN_COLUMN)",
      "skip     last             input after is skipped (input typo would fail (UNKNOWN_COLUMN))",
      "dry run: 0 of 3 steps would run; nothing ran",
    ]);
  });

  test("an asset another run holds: the run would wait for it", async () => {
    const { run } = setup(FILES, CATALOG, (db) => {
      expect(tryAcquire(db, "zones", "r_0922_1150_live").ok).toBe(true);
    });
    const zones = stepsOf((await run({ selectors: ["zones"] })).data).zones;
    expect(zones).toMatchObject({ hold: "leased", reason: "replace; run r_0922_1150_live holds it now, so the run would wait for it" });
  });

  test("without runs.sqlite everything is never built, and nothing is created", async () => {
    const root = makeProject(FILES);
    const project = loadProject({ root });
    const out = await dryRun({ project, selectors: ["consts", "zones"], now: NOW });
    expect(out.data.steps.map((s) => [s.asset, s.action, s.reasons])).toEqual([["consts", "rebuild", ["requested", "never_built"]], ["zones", "fetch", ["requested", "never_built"]]]);
    expect(existsSync(join(project.paths.stateDir, "runs.sqlite"))).toBe(false);
    expect(formatDryRun({ dryRun: true, order: [], steps: [] })).toBe("dry run: nothing would run (no ingests, and no transform is stale)");
  });
});

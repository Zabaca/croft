import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CatalogAsset, type CatalogColumn, putCatalog } from "../history/catalog.ts";
import { tryAcquire } from "../history/leases.ts";
import { RunsDb } from "../history/runs-db.ts";
import { loadProject } from "../project/root.ts";
import { dryRun, formatDryRun, type DryRunInput } from "./dry-run.ts";
import { planRun } from "./plan.ts";
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

  test("--from: what reads a backfilled ingest is skipped, as the run skips it; a broken transform too", async () => {
    const { run } = setup({
      ...FILES,
      "assets/issue_count.sql": "SELECT count(*) AS n FROM issues\n",
      "assets/typo.sql": "-- check: id >\nSELECT id FROM issues\n",
    });
    expect(stepsOf((await run({ selectors: ["issues"] })).data).typo.problems.map((p: { code: string }) => p.code)).toEqual(["CHECK_INVALID"]);
    const out = await run({ selectors: ["issues"], from: "-7d" });
    const s = stepsOf(out.data);
    expect(s.issues).toMatchObject({ action: "fetch", window: { source: "from" } });
    expect(s.issue_count).toMatchObject({ action: "skip", skippedBecause: "--from applies to merge ingests", problems: [] });
    expect(s.typo).toMatchObject({ action: "skip", skippedBecause: "--from applies to merge ingests", problems: [] });
    expect(out.problems).toEqual([]);
    expect(formatDryRun(out.data)).toContain("1 of 3 steps would run");
  });

  test("a mistyped asset's did-you-mean fix repeats the dry run as typed, never a real run", async () => {
    const { run } = setup(FILES);
    await expect(run({ selectors: ["isues"] })).rejects.toMatchObject({
      code: "USAGE_ERROR", problem: { hint: "did you mean issues?", fix: { kind: "command", command: "croft run issues --dry-run" } },
    });
    await expect(run({ selectors: ["zones", "isues"], only: true, from: "-7d" })).rejects.toMatchObject({
      problem: { fix: { command: "croft run zones issues --only --from -7d --dry-run" } },
    });
    await expect(run({ selectors: ["issue*", "chargse"], upstream: true })).rejects.toMatchObject({
      problem: { fix: { command: "croft run 'issue*' charges --upstream --dry-run" } },
    });
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

  // §4.1: "dry-run: what would run and why, with windows and confirmations". --rebuild shows what would go to the
  // trash and the confirmation the run would stop for, and never offers the destructive run in next.
  test("--rebuild: what would go to the trash and be confirmed; exact names only; a rebuild that trashes is never in next", async () => {
    const triage = `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues"], key: "id", incremental: true,
  async *rows({ newRows, http }) { for await (const r of newRows("issues")) { await http.get("https://example.test/" + r.id); yield r; } },
});
`;
    const built = [...CATALOG, entry("triage", { kind: "ts", write: "merge", key: ["id"], rows: 800, inputsSeen: { issues: { seenLoadedAt: T1, seenKey: [7], inputLastLoadedAt: T1 } } })];
    const { run, project } = setup({ ...FILES, "assets/triage.ts": triage }, built);
    const out = await run({ selectors: ["issues", "triage", "fresh", "sales", "consts"], rebuild: true, only: true });
    expect(out.exit).toBe(0);
    const s = stepsOf(out.data);
    // An ingest with rows: they go to the trash first, then it is fetched from scratch (no window: no cursor).
    expect(s.issues).toMatchObject({
      action: "fetch", reasons: ["requested", "rebuild"], reason: "merge by id, from scratch (--rebuild): fetches everything",
      confirmation: {
        action: "rebuild", command: "croft run issues --rebuild",
        impact: { asset: "issues", action: "ingest; --rebuild refetches from scratch", rows: 5000, downstream: ["triage"] },
      },
    });
    expect(s.issues.window).toBeUndefined();
    expect(s.issues.confirmation.impact.trashPath).toContain(join(".croft", "trash", "issues"));
    // An incremental transform that makes requests: its rows, and every input row it would process again.
    expect(s.triage).toMatchObject({
      action: "rebuild",
      confirmation: {
        action: "rebuild", command: "croft run triage --rebuild",
        impact: { asset: "triage", action: "incremental transform; --rebuild processes every input row again", rows: 800, estimatedRequests: 5000 },
      },
    });
    expect(s.triage.reason).toStartWith("from scratch (--rebuild)");
    // Never built, nothing to trash: no confirmation. A file ingest loads every file again.
    expect(s.fresh).toMatchObject({ action: "fetch", reason: "merge by id, from scratch (--rebuild): fetches everything" });
    expect(s.fresh.confirmation).toBeUndefined();
    expect(s.sales).toMatchObject({ action: "fetch", reason: "merge by order_id, from scratch (--rebuild): loads every file" });
    expect(s.sales.confirmation).toBeUndefined();
    // SQL is recomputed as always: no trash, no confirmation.
    expect(s.consts).toMatchObject({ action: "rebuild", reason: "from scratch (--rebuild); never built" });
    expect(s.consts.confirmation).toBeUndefined();
    const text = formatDryRun(out.data);
    expect(text).toContain("needs confirmation: its 5,000 rows go to the trash first, then it is fetched from scratch");
    expect(text).toContain("needs confirmation: its 800 rows go to the trash first, then every input row is processed again (about 5,000, and its code makes requests for them)");
    // A destructive command never appears in next (§4.3); a dry run issues no token.
    expect(out.next.some((n) => n.command.includes("--rebuild"))).toBe(false);
    const db = RunsDb.open(project.paths.stateDir);
    try {
      expect(db.sqlite.query("SELECT count(*) AS n FROM confirmations").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    // A rebuild that needs no confirmation is offered as is.
    expect((await run({ selectors: ["consts"], rebuild: true })).next).toEqual([{ command: "croft run consts --rebuild", reason: "run it" }]);
    // The run's own rules: exact names, and not with --from or --allow-shrink.
    await expect(run({ selectors: [], rebuild: true })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(run({ selectors: ["iss*"], rebuild: true })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(run({ selectors: ["issues"], rebuild: true, from: "-7d" })).rejects.toMatchObject({ code: "USAGE_ERROR" });
    await expect(run({ selectors: ["zones"], rebuild: true, allowShrink: true })).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  // R41-07, R41-12: what an ingest's rebuild costs besides its own rows.
  test("--rebuild of an ingest names the paid readers that would process every row again, and a file ingest's gone files", async () => {
    const paid = (input: string) => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["${input}"], key: "id", incremental: true,
  async *rows({ newRows, http }) { for await (const r of newRows("${input}")) { await http.get("https://example.test/" + r.id); yield r; } },
});
`;
    const seen = { issues: { seenLoadedAt: T1, seenKey: [7], inputLastLoadedAt: T1 } };
    const built = [
      ...CATALOG,
      entry("triage", { kind: "ts", write: "merge", key: ["id"], rows: 800, inputsSeen: seen }),
      entry("sales", { write: "merge", key: ["order_id"], rows: 40, filesGone: ["files/sales/jan.csv"] }),
    ];
    // `later` reads issues too, but has never read it: its first build processes every row anyway.
    const { run } = setup({ ...FILES, "assets/triage.ts": paid("issues"), "assets/later.ts": paid("issues") }, built);
    const out = await run({ selectors: ["issues", "sales"], rebuild: true, only: true });
    const s = stepsOf(out.data);
    expect(s.issues.confirmation.impact).toMatchObject({
      action: "ingest; --rebuild refetches from scratch; then triage processes all 5,000 rows of issues again, and its code makes requests for them (about 5,000)",
      rows: 5000, downstream: ["later", "triage"], estimatedRequests: 5000,
    });
    expect(s.sales.confirmation.impact).toMatchObject({
      action: "file ingest; --rebuild loads every file again; the rows of 1 file no longer on disk (files/sales/jan.csv) do not come back, and stay only in the trash",
      rows: 40,
    });
    const text = formatDryRun(out.data);
    expect(text).toContain("needs confirmation: its 5,000 rows go to the trash first, then it is fetched from scratch; then triage processes all 5,000 rows of issues again");
    expect(text).toContain("needs confirmation: its 40 rows go to the trash first, then every file is loaded again; the rows of 1 file no longer on disk (files/sales/jan.csv)");
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

  test("the cost guard counts only the inputs the code reads with newRows(), as the run does: a lookup read with rows() is not", async () => {
    const triage = `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["issues", "labels"], key: "id", incremental: true,
  async *rows({ newRows, rows, http }) {
    const labels = await rows("labels");
    for await (const r of newRows("issues")) { await http.get("https://example.test/" + r.id + labels.length); yield r; }
  },
});
`;
    const files = { ...FILES, "assets/labels.ts": ingest(`key: "name",`), "assets/triage.ts": triage };
    const labels = entry("labels", { key: ["name"], rows: 1200 });
    // Built, and no issue is new since: nothing to process, whatever the size of the lookup.
    const built = [...CATALOG, labels,
      entry("triage", { kind: "ts", write: "merge", key: ["id"], inputsSeen: { issues: { seenLoadedAt: T1, seenKey: [7], inputLastLoadedAt: T1 } } })];
    expect(stepsOf((await setup(files, built).run({ selectors: ["triage"], only: true })).data).triage.confirmation).toBeUndefined();
    // Never built: every issue is pending (5,000), and the 1,200 labels are not counted.
    const first = stepsOf((await setup(files, [...CATALOG, labels]).run({ selectors: ["triage"], only: true })).data).triage;
    expect(first.confirmation.impact).toMatchObject({ rows: 5000, estimatedRequests: 5000 });
  });

  // R2.2: the dry run's estimate skipped inputs not built yet, so the first build of a paid transform (its input
  // built by the same run) showed no confirmation, and the run then stopped to ask (exit 5).
  test("the cost guard on a first build whose input the run builds first: the rows are unknown until then, and the run may ask", async () => {
    const triage = `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["fresh"], key: "id", incremental: true,
  async *rows({ newRows, http }) { for await (const r of newRows("fresh")) { await http.get("https://example.test/" + r.id); yield r; } },
});
`;
    const { run } = setup({ ...FILES, "assets/triage.ts": triage });
    const out = await run({ selectors: ["fresh"] });
    expect(out.data.order).toEqual(["fresh", "triage"]);
    const s = stepsOf(out.data).triage;
    expect(s.action).toBe("update");
    expect(s.confirmation).toBeUndefined();
    expect(s.reason).toBe("never built; may need confirmation: the rows it would process are unknown until fresh is built, first in this run (LARGE_REPROCESS above 1,000)");
    expect(out.next).toEqual([{ command: "croft run fresh", reason: "run it; it may stop to ask before triage, whose input rows are unknown until fresh is built" }]);
    expect(formatDryRun(out.data)).toContain("update   triage           never built; may need confirmation: the rows it would process are unknown until fresh is built");
    // An input already built gives its rows, as before: a confirmation, not a maybe.
    const built = stepsOf((await setup({ ...FILES, "assets/triage.ts": triage.replaceAll("fresh", "issues") }).run({ selectors: ["issues"] })).data).triage;
    expect(built.confirmation.impact).toMatchObject({ rows: 5000 });
    expect(built.reason).toBe("never built");
  });

  // R2.2: `croft run clean` when its input was never built and the run does not build it: the dry run said it would
  // run, and the run failed with UNKNOWN_TABLE "no table named fresh".
  test("an input never built that the run does not build: the step is skipped with INPUT_NOT_BUILT, and next builds the input", async () => {
    const { run } = setup({ ...FILES, "assets/clean.sql": "-- key: id\nSELECT id FROM fresh\n" });
    const out = await run({ selectors: ["clean"] });
    const s = stepsOf(out.data).clean;
    expect(s).toMatchObject({ action: "skip", skippedBecause: "input fresh has never been built, and this run does not build it (croft run fresh does)", problems: [] });
    expect(out.problems).toMatchObject([{ code: "INPUT_NOT_BUILT", severity: "warning", asset: "clean", fix: { kind: "command", command: "croft run fresh" } }]);
    expect(out.next).toEqual([{ command: "croft run fresh", reason: "build fresh first: clean reads it, and it has never been built" }]);
    expect(out.exit).toBe(0);
    expect(formatDryRun(out.data).split("\n")).toEqual([
      "skip     clean            input fresh has never been built, and this run does not build it (croft run fresh does)",
      "dry run: 0 of 1 step would run; nothing ran",
    ]);
    // Built first in the same run: it would run.
    expect(stepsOf((await run({ selectors: ["clean"], upstream: true })).data).clean).toMatchObject({ action: "rebuild", problems: [] });
  });

  test("a TS transform whose inputs name no asset: the dry run shows UNKNOWN_TABLE with the did-you-mean edit, as the run fails it", async () => {
    const { run } = setup({
      ...FILES,
      "assets/typo.ts": `import { transform } from "@zabaca/croft";\nexport default transform({\n  inputs: ["issuez"], key: "id",\n  async *rows({ rows }) { for await (const r of rows<{ id: number }>("issuez")) yield { id: r.id }; },\n});\n`,
    });
    const out = await run({ selectors: ["typo"] });
    expect(stepsOf(out.data).typo!.problems).toMatchObject([{
      code: "UNKNOWN_TABLE", line: 3, fix: { kind: "edit", replace: { from: "issuez", to: "issues" } },
    }]);
    expect(JSON.stringify(out)).not.toContain("croft run issuez");
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

  // §6 "Behavior changes": a changed key, write mode or cursor field fails the run's step before it fetches, and an
  // append ingest gaining a key asks to convert in place. The dry run says the same, from the catalog mirror.
  test("INGEST_CONFIG_CHANGED: a changed key fails the step before it runs, and what reads it is skipped, as in the run", async () => {
    const { run } = setup({
      ...FILES, "assets/issues.ts": ingest(`key: "uuid", incremental: "updated_at",`), "assets/issue_count.sql": "SELECT count(*) AS n FROM issues\n",
    }, [...CATALOG.filter((c) => c.asset !== "issues"), { ...CATALOG[1]!, codeHash: "older-code" }]);
    const out = await run({ selectors: ["issues"] });
    const s = stepsOf(out.data);
    expect(s.issues.problems).toMatchObject([{
      code: "INGEST_CONFIG_CHANGED", severity: "error",
      message: "issues's 5000 stored rows were written as merge by id, but its code now says merge by uuid (key: id → uuid); croft does not rewrite stored rows on its own",
      fix: { kind: "edit", description: "put the key back as it was (key: id → uuid)", file: "assets/issues.ts" },
    }]);
    expect(s.issues.window).toBeUndefined();
    expect(s.issue_count).toMatchObject({ action: "skip", skippedBecause: "input issues would fail (INGEST_CONFIG_CHANGED)" });
    expect(out.problems.map((p) => p.code)).toEqual(["INGEST_CONFIG_CHANGED"]);
    expect(out.exit).toBe(0);
    expect(formatDryRun(out.data)).toContain("fails before it runs: INGEST_CONFIG_CHANGED issues's 5000 stored rows were written as merge by id");
    // No code hash recorded: unknown, so nothing to say (the run checks _croft itself).
    const same = setup(FILES, CATALOG);
    expect(stepsOf((await same.run({ selectors: ["issues"] })).data).issues.problems).toEqual([]);
  });

  test("a key added to an append ingest, or a pin that differs: the confirmation the run would ask for, and no token", async () => {
    const built = entry("events", {
      write: "append", rows: 1200, codeHash: "older-code", cursor: { field: "seq", value: "5", type: "integer", unit: null },
      columns: [col("seq", "BIGINT"), col("zip", "VARCHAR"), col("_loaded_at", "TIMESTAMPTZ")],
    });
    const keyed = ingest(`key: "id", write: "append", incremental: "seq",`);
    const { run, project } = setup({ ...FILES, "assets/events.ts": keyed, "assets/event_count.sql": "SELECT count(*) AS n FROM events\n" }, [...CATALOG, built]);
    const out = await run({ selectors: ["events"] });
    const s = stepsOf(out.data);
    expect(s.events.problems).toEqual([]);
    expect(s.events.confirmation).toMatchObject({
      action: "convert_key", command: "croft run events",
      impact: { asset: "events", action: "append ingest gains key id; duplicates removed in place", rows: 1200, downstream: ["event_count"] },
    });
    expect(s.events.confirmation.impact.trashPath).toContain(join(".croft", "trash", "events"));
    expect(out.problems).toMatchObject([{ code: "INGEST_CONFIG_CHANGED", severity: "warning", asset: "events" }]);
    expect(formatDryRun(out.data)).toContain("needs confirmation if stored rows repeat a key: its 1,200 rows go to the trash first (append ingest gains key id; duplicates removed in place)");
    // The run only asks: it is not destructive in itself, so it is offered.
    expect(out.next).toEqual([{ command: "croft run events", reason: "run it; it stops to ask before the steps that need confirmation" }]);
    const db = RunsDb.open(project.paths.stateDir);
    try {
      expect(db.sqlite.query("SELECT count(*) AS n FROM confirmations").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }

    // A pin to another type: the run tests the stored values, and asks only when some would change.
    const pinned = setup({ ...FILES, "assets/events.ts": ingest(`write: "append", incremental: "seq", columns: { zip: "BIGINT" },`) }, [...CATALOG, built]);
    const p = stepsOf((await pinned.run({ selectors: ["events"] })).data).events;
    expect(p.confirmation).toMatchObject({ action: "pin_change", command: "croft run events", impact: { action: "pin change: zip VARCHAR → BIGINT", rows: 1200 } });
    expect(formatDryRun({ dryRun: true, order: ["events"], steps: [p] }))
      .toContain("needs confirmation if the pin would change stored values: its 1,200 rows go to the trash first (pin change: zip VARCHAR → BIGINT)");
    // Both: one question, as the run asks one.
    const both = setup({ ...FILES, "assets/events.ts": ingest(`key: "id", write: "append", incremental: "seq", columns: { zip: "BIGINT" },`) }, [...CATALOG, built]);
    expect(stepsOf((await both.run({ selectors: ["events"] })).data).events.confirmation).toMatchObject({
      action: "convert_key", impact: { action: "append ingest gains key id; duplicates removed in place; pin change: zip VARCHAR → BIGINT" },
    });
    // --rebuild has no change to settle: only the rebuild's own confirmation.
    const rebuild = stepsOf((await both.run({ selectors: ["events"], rebuild: true })).data).events;
    expect(rebuild.confirmation.action).toBe("rebuild");
  });

  test("a file renamed outside croft (ASSET_RENAMED): named, it would fail before it runs; bare, it is skipped; next is the rename", async () => {
    // charges.ts renamed to payments.ts outside croft: the mirror's charges entry has the code hash of payments.ts.
    const files = { ...Object.fromEntries(Object.entries(FILES).filter(([k]) => k !== "assets/charges.ts")), "assets/payments.ts": FILES["assets/charges.ts"] };
    const renamed = setup(files, CATALOG);
    const code = (await planRun({ root: renamed.root, timezone: renamed.project.timezone, selectors: ["payments"], catalog: [] })).steps[0]!.codeHash!;
    const db = RunsDb.open(renamed.project.paths.stateDir);
    try {
      putCatalog(db, { ...CATALOG[0]!, codeHash: code });
    } finally {
      db.close();
    }
    const named = await renamed.run({ selectors: ["payments"] });
    expect(stepsOf(named.data).payments.problems).toMatchObject([{ code: "ASSET_RENAMED", fix: { command: "croft rename charges payments" } }]);
    expect(named.next[0]).toEqual({ command: "croft rename charges payments", reason: "adopt charges's table and state as payments" });
    const bare = await renamed.run();
    expect(stepsOf(bare.data).payments).toMatchObject({
      action: "skip", skippedBecause: "looks like charges renamed outside croft: croft rename charges payments adopts its table and state (a run would fetch everything again)",
    });
    expect(bare.problems).toContainEqual(expect.objectContaining({ code: "ASSET_RENAMED", severity: "warning", asset: "payments" }));
    expect(bare.next[0]).toEqual({ command: "croft rename charges payments", reason: "adopt charges's table and state as payments" });
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

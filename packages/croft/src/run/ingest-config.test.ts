// Behavior and pin changes of an ingest that has data, through runIngest (DESIGN.md §6 "Nothing implicit destroys
// ingested data": "Behavior changes", "Pin changes"; "Destructive operations need confirmation"). What fails before
// anything is fetched, what asks (action convert_key / pin_change), and what applies directly. The asset's code is
// imported once; each test changes what the planner would say (write, key, incremental, pins) on the step.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { CroftError } from "../core/errors.ts";
import type { Incremental, Problem, Reason, WriteMode } from "../core/types.ts";
import { closeAllWarehouses, type DuckWarehouse, openWarehouse } from "../db/warehouse.ts";
import { openLog } from "../history/logs.ts";
import { getCatalog } from "../history/catalog.ts";
import { RunsDb } from "../history/runs-db.ts";
import { discoverAssets } from "../project/discover.ts";
import { ProjectEnv } from "../project/env.ts";
import { loadProject, type Project } from "../project/root.ts";
import { loadTsAsset } from "../project/ts-asset.ts";
import { listTrash } from "../safety/trash.ts";
import { type IngestInput, type IngestOutcome, runIngest, StepProgress } from "./ingest.ts";
import { behaviorHash, behaviorLabel, behaviorWords, DEFAULT_TIMEOUT_MS, type PlannedStep, resolveWrite } from "./plan.ts";
import type { ConfirmDecision, ConfirmRequest } from "./step.ts";
import { cleanupProjects, makeProject } from "./testkit.ts";

const g = globalThis as Record<string, unknown>;
const opened: { runs: RunsDb }[] = [];

beforeEach(() => {
  g.__cfg_calls = 0;
  g.__cfg_rows = [];
});
afterEach(() => {
  delete g.__cfg_calls;
  delete g.__cfg_rows;
});
afterAll(async () => {
  for (const o of opened) o.runs.close();
  await closeAllWarehouses();
  cleanupProjects();
});

interface H { root: string; project: Project; env: ProjectEnv; w: DuckWarehouse; runs: RunsDb; stateDir: string }

function harness(files: Record<string, string>): H {
  const root = makeProject(files);
  const project = loadProject({ root });
  mkdirSync(project.paths.stateDir, { recursive: true });
  const w = openWarehouse({
    path: project.paths.database, mode: "read_write", timezone: project.timezone, root, stateDir: project.paths.stateDir, isTTY: false, register: false,
  });
  const h = { root, project, env: ProjectEnv.load(root, {}), w, runs: RunsDb.open(project.paths.stateDir), stateDir: project.paths.stateDir };
  opened.push(h);
  return h;
}

/** An ingest that yields globalThis.__cfg_rows and counts how often its rows() was called (__cfg_calls). */
const source = (config: string) => `import { ingest } from "@zabaca/croft";
const g = globalThis as any;
export default ingest({
${config}
  rows() {
    g.__cfg_calls = (g.__cfg_calls ?? 0) + 1;
    return g.__cfg_rows ?? [];
  },
});
`;

interface Patch {
  write?: WriteMode;
  key?: string[];
  incremental?: Incremental;
  pins?: Record<string, { type: string; format?: string }>;
  reasons?: Reason[];
  readBy?: string[];
}

/** The step the planner would make for the asset, with what the code would now say (write, key, …). */
async function plan(h: H, name: string, patch: Patch = {}): Promise<PlannedStep> {
  const a = (await discoverAssets(h.root)).assets.find((x) => x.name === name)!;
  const loaded = await loadTsAsset(a, { root: h.root, timezone: h.project.timezone });
  if (!loaded.ok || !loaded.spec) throw new Error(`${name} did not load: ${JSON.stringify(loaded.problems)}`);
  const spec = { ...loaded.spec, ...(patch.pins ? { pins: patch.pins } : {}) };
  const key = patch.key ?? spec.key;
  const incremental = patch.incremental ?? spec.incremental;
  // A key given here replaces the asset's `write: "append"` (the edit that adds a key removes it); pass write to keep it.
  const declared = patch.key ? undefined : spec.write;
  const write = patch.write ?? resolveWrite({ ...(declared ? { write: declared } : {}), key, incremental });
  return {
    asset: name, file: a.file, path: a.path, kind: "rows", action: "fetch", reasons: patch.reasons ?? ["requested"], reason: "requested",
    problems: loaded.problems, loaded, spec, inputs: [], orderAfter: [], readBy: patch.readBy ?? [], checks: [], write, key, incremental,
    behavior: behaviorLabel(write, key), words: behaviorWords(write, key, incremental), behaviorHash: behaviorHash(write, key, incremental),
    retries: 0, timeoutMs: DEFAULT_TIMEOUT_MS, ...(loaded.codeHash ? { codeHash: loaded.codeHash } : {}),
  };
}

let seq = 0;

async function ingestStep(h: H, s: PlannedStep, o: Partial<IngestInput> = {}): Promise<IngestOutcome & { runId: string }> {
  const runId = o.runId ?? `r_cfg${++seq}`;
  const log = openLog(h.stateDir, runId, s.asset, { redact: (t) => t });
  const progress = new StepProgress(s.asset);
  try {
    const out = await runIngest({
      step: s, project: h.project, env: h.env, warehouse: h.w, runs: h.runs, runId, attempt: 1, maxAttempts: 1,
      signal: new AbortController().signal, progress, log, ...o,
    });
    return { ...out, runId };
  } finally {
    progress.close();
    log.close();
  }
}

async function failure(p: Promise<unknown>): Promise<CroftError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected the step to fail");
}

const all = <T = Record<string, unknown>>(h: H, sql: string, params: unknown[] = []) =>
  h.w.read((db) => db.all<T>(sql, params), { purpose: "test" });

const assetRow = async (h: H, name: string) =>
  (await all<Record<string, unknown>>(h, `SELECT write_mode, key_columns, behavior_hash, row_count, coalesce(epoch_us(last_replaced_at), 0)::DOUBLE AS lr
    FROM _croft.assets WHERE name = $1`, [name]))[0]!;

/** A decider that records what it was asked and answers `kind`. */
function decider(kind: ConfirmDecision["kind"]) {
  const asked: ConfirmRequest[] = [];
  const fn = async (r: ConfirmRequest): Promise<ConfirmDecision> => {
    asked.push(r);
    if (kind === "pending") return { kind, confirmation: { token: "c_abc123", expiresAt: "2026-09-24T00:15:00.000Z", command: r.command, impact: r.impact } };
    return { kind };
  };
  return { fn, asked };
}

const at = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, "0")}Z`;
const APPEND = source(`  write: "append",\n  incremental: "at",`);
const MERGE = source(`  key: "id",\n  incremental: "at",`);
const CURSOR_AT: Incremental = { kind: "cursor", field: "at", lookbackMs: 0 };

/** An append ingest with 4 stored rows, id 1 twice (the later one second). */
async function appended(): Promise<H> {
  const h = harness({ "assets/events.ts": APPEND });
  g.__cfg_rows = [{ id: 1, at: at(0), v: "a" }, { id: 2, at: at(1), v: "b" }];
  expect((await ingestStep(h, await plan(h, "events"))).result.status).toBe("ok");
  g.__cfg_rows = [{ id: 1, at: at(2), v: "a2" }, { id: 3, at: at(3), v: "c" }];
  expect((await ingestStep(h, await plan(h, "events"))).result.rows.total).toBe(4);
  g.__cfg_calls = 0;
  g.__cfg_rows = [];
  return h;
}

// ---------------------------------------------------------------------------------------------------------

describe("INGEST_CONFIG_CHANGED: an ingest's key, write mode or incremental field changed while it has data", () => {
  test("a merge ingest keyed by another column fails before fetching; the fixes are revert and --rebuild", async () => {
    const h = harness({ "assets/events.ts": MERGE });
    g.__cfg_rows = [{ id: 1, at: at(0), v: "a" }, { id: 2, at: at(1), v: "b" }];
    await ingestStep(h, await plan(h, "events"));
    g.__cfg_calls = 0;
    const { fn, asked } = decider("granted");
    const e = await failure(ingestStep(h, await plan(h, "events", { key: ["v"] }), { confirmChange: fn }));
    expect(e.code).toBe("INGEST_CONFIG_CHANGED");
    expect(g.__cfg_calls).toBe(0); // nothing was fetched
    expect(asked).toEqual([]); // nothing to confirm: no conversion exists for this change
    const p = e.problem;
    expect(p.asset).toBe("events");
    expect(p.file).toBe("assets/events.ts");
    expect(p.message).toContain("key: id → v");
    expect(p.hint).toContain("croft run events --rebuild");
    expect(p.fix).toMatchObject({ kind: "edit", file: "assets/events.ts" });
    expect(p.details).toMatchObject({
      changed: ["key"], from: { write: "merge", key: ["id"] }, to: { write: "merge", key: ["v"] }, rows: 2, convertible: false,
    });
    const fixes = p.details!.fixes as { kind: string; description: string; requiresHuman?: boolean }[];
    expect(fixes.map((f) => f.kind)).toEqual(["edit", "manual"]);
    expect(fixes[1]).toMatchObject({ requiresHuman: true });
    expect(fixes[1]!.description).toContain("croft run events --rebuild");
    expect((await assetRow(h, "events")).key_columns).toEqual(["id"]);
  });

  test("a changed incremental field fails, naming the old and the new field", async () => {
    const h = harness({ "assets/events.ts": MERGE });
    g.__cfg_rows = [{ id: 1, at: at(0), at2: at(5) }];
    await ingestStep(h, await plan(h, "events"));
    const e = await failure(ingestStep(h, await plan(h, "events", { incremental: { kind: "cursor", field: "at2", lookbackMs: 0 } })));
    expect(e.code).toBe("INGEST_CONFIG_CHANGED");
    expect(e.problem.details).toMatchObject({ changed: ["incremental"] });
    expect(e.problem.message).toContain("incremental: at → at2");
  });

  test("adding a lookback applies directly, and so does any change while the table is empty", async () => {
    const h = harness({ "assets/events.ts": MERGE });
    g.__cfg_rows = [{ id: 1, at: at(0) }];
    await ingestStep(h, await plan(h, "events"));
    g.__cfg_rows = [{ id: 2, at: at(1) }];
    const lb = await ingestStep(h, await plan(h, "events", { incremental: { kind: "cursor", field: "at", lookbackMs: 60_000 } }));
    expect(lb.result).toMatchObject({ status: "ok", rows: { added: 1, total: 2 } });

    const e = harness({ "assets/empty.ts": APPEND });
    g.__cfg_rows = [];
    await ingestStep(e, await plan(e, "empty"));
    g.__cfg_rows = [{ id: 1, at: at(0) }];
    const out = await ingestStep(e, await plan(e, "empty", { key: ["id"], write: "merge" }));
    expect(out.result.status).toBe("ok");
    expect(await assetRow(e, "empty")).toMatchObject({ write_mode: "merge", key_columns: ["id"] });
  });

  test("a reordered or re-cased key is the same key", async () => {
    const h = harness({ "assets/events.ts": source(`  key: ["id", "v"],\n  incremental: "at",`) });
    g.__cfg_rows = [{ id: 1, v: "a", at: at(0) }];
    await ingestStep(h, await plan(h, "events"));
    g.__cfg_rows = [{ id: 2, v: "b", at: at(1) }];
    const out = await ingestStep(h, await plan(h, "events", { key: ["V", "id"] }));
    expect(out.result.status).toBe("ok");
  });

  test("--rebuild refetches under the new rules, so the change does not stop it", async () => {
    const h = harness({ "assets/events.ts": MERGE });
    g.__cfg_rows = [{ id: 1, at: at(0), v: "a" }];
    await ingestStep(h, await plan(h, "events"));
    g.__cfg_rows = [{ id: 1, at: at(1), v: "b" }];
    expect((await ingestStep(h, await plan(h, "events", { key: ["v"] }), { rebuild: true })).result.status).toBe("ok");
    expect((await ingestStep(h, await plan(h, "events", { key: ["at"], reasons: ["rebuild"] }))).result.status).toBe("ok");
  });
});

describe("an append ingest gaining a key is converted in place", () => {
  test("`croft run x` asks (convert_key) before fetching; pending changes nothing", async () => {
    const h = await appended();
    const { fn, asked } = decider("pending");
    const out = await ingestStep(h, await plan(h, "events", { key: ["id"], readBy: ["daily"] }), { confirmChange: fn });
    expect(g.__cfg_calls).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      asset: "events", action: "convert_key", command: "croft run events",
      impact: { asset: "events", rows: 1, downstream: ["daily"] },
      problem: { code: "INGEST_CONFIG_CHANGED" },
    });
    expect(asked[0]!.impact.trashPath).toContain("/trash/events/");
    expect(asked[0]!.problem.message).toContain("removes 1 duplicate row");
    expect(out.result).toMatchObject({ status: "skipped", reason: "needs confirmation", rows: { total: 4 } });
    expect(out.result.skippedBecause).toContain("c_abc123");
    expect(out.confirmation?.token).toBe("c_abc123");
    expect(out.problems.map((p) => p.code)).toEqual(["CONFIRMATION_REQUIRED"]);
    expect(out.problems[0]!.fix).toMatchObject({ kind: "manual", requiresHuman: true });
    expect(out.problems[0]!.hint).toContain("croft confirm c_abc123");
    expect(await all(h, `SELECT count(*)::INT AS n FROM events`)).toEqual([{ n: 4 }]);
    expect((await assetRow(h, "events")).write_mode).toBe("append");
    expect(listTrash(h.stateDir)).toEqual([]);
  });

  test("granted: the table goes to the trash first, each key keeps its latest row, then the new rows merge", async () => {
    const h = await appended();
    const before = await assetRow(h, "events");
    const { fn } = decider("granted");
    g.__cfg_rows = [{ id: 2, at: at(4), v: "b2" }, { id: 4, at: at(5), v: "d" }];
    const out = await ingestStep(h, await plan(h, "events", { key: ["id"] }), { confirmChange: fn });
    expect(out.result.status).toBe("ok");
    expect(g.__cfg_calls).toBe(1);
    const trash = listTrash(h.stateDir, "events");
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ rows: 4 });
    expect(trash[0]!.reason).toContain(out.runId);
    expect(out.result.trashed).toEqual({ path: trash[0]!.path, rows: 4 });
    expect(await all(h, `SELECT id::INT AS id, v FROM events ORDER BY id`)).toEqual([
      { id: 1, v: "a2" }, { id: 2, v: "b2" }, { id: 3, v: "c" }, { id: 4, v: "d" },
    ]);
    const after = await assetRow(h, "events");
    expect(after).toMatchObject({ write_mode: "merge", key_columns: ["id"], row_count: 4 });
    expect(after.behavior_hash).toBe(behaviorHash("merge", ["id"], CURSOR_AT));
    expect(Number(after.lr)).toBeGreaterThan(Number(before.lr));
    const note = out.warnings.find((w) => w.code === "INGEST_CONFIG_CHANGED")!;
    expect(note).toMatchObject({ severity: "warning", details: { removed: 1, trashPath: trash[0]!.path } });
    expect(out.result.reason).toContain("converted in place");
  });

  test("rows written together keep the one with the highest cursor", async () => {
    const h = harness({ "assets/events.ts": APPEND });
    g.__cfg_rows = [{ id: 1, at: at(2), v: "late" }, { id: 1, at: at(1), v: "early" }, { id: 2, at: at(0), v: "x" }];
    await ingestStep(h, await plan(h, "events"));
    g.__cfg_rows = [];
    await ingestStep(h, await plan(h, "events", { key: ["id"] }), { confirmChange: decider("granted").fn });
    expect(await all(h, `SELECT id::INT AS id, v FROM events ORDER BY id`)).toEqual([{ id: 1, v: "late" }, { id: 2, v: "x" }]);
  });

  test("declined: INGEST_CONFIG_CHANGED lists the conversion among its fixes; nothing changed", async () => {
    const h = await appended();
    const e = await failure(ingestStep(h, await plan(h, "events", { key: ["id"] }), { confirmChange: decider("declined").fn }));
    expect(e.code).toBe("INGEST_CONFIG_CHANGED");
    expect(e.problem.details).toMatchObject({ changed: ["write", "key"], convertible: true, removed: 1 });
    const fixes = e.problem.details!.fixes as { kind: string; description: string }[];
    expect(fixes.map((f) => f.kind)).toEqual(["edit", "manual", "manual"]);
    expect(fixes[2]!.description).toContain("croft run events");
    expect(g.__cfg_calls).toBe(0);
    expect(await all(h, `SELECT count(*)::INT AS n FROM events`)).toEqual([{ n: 4 }]);
    expect(listTrash(h.stateDir)).toEqual([]);
  });

  test("without a way to ask (a scheduled run), it fails the same way", async () => {
    const h = await appended();
    const e = await failure(ingestStep(h, await plan(h, "events", { key: ["id"] })));
    expect(e.code).toBe("INGEST_CONFIG_CHANGED");
    expect(e.problem.details).toMatchObject({ convertible: true });
  });

  test("a keyed append converts the same way", async () => {
    const h = await appended();
    const out = await ingestStep(h, await plan(h, "events", { key: ["id"], write: "append" }), { confirmChange: decider("granted").fn });
    expect(out.result.status).toBe("ok");
    expect(await all(h, `SELECT count(*)::INT AS n FROM events`)).toEqual([{ n: 3 }]);
    expect(await assetRow(h, "events")).toMatchObject({ write_mode: "append", key_columns: ["id"] });
  });

  test("with no duplicate stored, the key applies directly: no question, no trash", async () => {
    const h = harness({ "assets/events.ts": APPEND });
    g.__cfg_rows = [{ id: 1, at: at(0) }, { id: 2, at: at(1) }];
    await ingestStep(h, await plan(h, "events"));
    const { fn, asked } = decider("pending");
    g.__cfg_rows = [{ id: 2, at: at(2) }];
    const out = await ingestStep(h, await plan(h, "events", { key: ["id"] }), { confirmChange: fn });
    expect(asked).toEqual([]);
    expect(out.result).toMatchObject({ status: "ok", rows: { total: 2, updated: 1 } });
    expect(listTrash(h.stateDir)).toEqual([]);
    expect(await assetRow(h, "events")).toMatchObject({ write_mode: "merge", key_columns: ["id"] });
  });

  test("stored rows without the key block the conversion; the fixes are revert and --rebuild", async () => {
    const h = harness({ "assets/events.ts": APPEND });
    g.__cfg_rows = [{ id: 1, at: at(0) }, { id: null, at: at(1) }, { id: 1, at: at(2) }];
    await ingestStep(h, await plan(h, "events"));
    const { fn, asked } = decider("granted");
    const e = await failure(ingestStep(h, await plan(h, "events", { key: ["id"] }), { confirmChange: fn }));
    expect(e.code).toBe("INGEST_CONFIG_CHANGED");
    expect(asked).toEqual([]);
    expect(e.problem.details).toMatchObject({ convertible: false, nullKeys: 1 });
    expect(e.problem.message).toContain("1 stored row has no id");

    const m = harness({ "assets/events.ts": APPEND });
    g.__cfg_rows = [{ id: 1, at: at(0) }];
    await ingestStep(m, await plan(m, "events"));
    const missing = await failure(ingestStep(m, await plan(m, "events", { key: ["code"] }), { confirmChange: fn }));
    expect(missing.problem.details).toMatchObject({ convertible: false, missing: ["code"] });
  });

  test("a preview converts its own copy without asking or trashing, and says a real run asks", async () => {
    const h = await appended();
    const { fn, asked } = decider("pending");
    const out = await ingestStep(h, await plan(h, "events", { key: ["id"] }), { confirmChange: fn, preview: { rows: 100 } });
    expect(asked).toEqual([]);
    expect(out.result.status).toBe("ok");
    expect(await all(h, `SELECT count(*)::INT AS n FROM events`)).toEqual([{ n: 3 }]);
    expect(listTrash(h.stateDir)).toEqual([]);
    const w = out.warnings.find((x) => x.code === "INGEST_CONFIG_CHANGED")!;
    expect(w.severity).toBe("warning");
    expect(w.message).toContain("a real run asks for confirmation first");
  });
});

// ---------------------------------------------------------------------------------------------------------

const ZIPS = source(`  key: "id",\n  incremental: "at",`);

async function zipped(zips: (string | null)[]): Promise<H> {
  const h = harness({ "assets/people.ts": ZIPS });
  g.__cfg_rows = zips.map((zip, n) => ({ id: n + 1, at: at(n), zip }));
  await ingestStep(h, await plan(h, "people"));
  g.__cfg_calls = 0;
  g.__cfg_rows = [];
  return h;
}

const columnRow = async (h: H, asset: string, name: string) =>
  (await all<Record<string, unknown>>(h, `SELECT type, pinned, pending FROM _croft.columns WHERE asset = $1 AND name = $2`, [asset, name]))[0];
const realType = async (h: H, table: string, column: string) =>
  (await all<{ t: string }>(h, `SELECT data_type AS t FROM duckdb_columns() WHERE table_name = $1 AND column_name = $2`, [table, column]))[0]?.t;

describe("pin changes: the pins in the code are authoritative", () => {
  test("a lossless new pin applies directly (ALTER TYPE), also when the batch does not carry the column", async () => {
    const h = await zipped(["12345", "54321", null]);
    const before = await assetRow(h, "people");
    const { fn, asked } = decider("pending");
    g.__cfg_rows = [{ id: 9, at: at(9) }];
    const out = await ingestStep(h, await plan(h, "people", { pins: { zip: { type: "BIGINT" } } }), { confirmChange: fn });
    expect(asked).toEqual([]);
    expect(out.result.status).toBe("ok");
    expect(await realType(h, "people", "zip")).toBe("BIGINT");
    expect(await all(h, `SELECT id::INT AS id, zip FROM people ORDER BY id`)).toEqual([
      { id: 1, zip: 12345 }, { id: 2, zip: 54321 }, { id: 3, zip: null }, { id: 9, zip: null },
    ]);
    expect(await columnRow(h, "people", "zip")).toEqual({ type: "BIGINT", pinned: true, pending: false });
    expect(out.result.schemaChanges).toContainEqual({ kind: "widen", column: "zip", from: "VARCHAR", to: "BIGINT" });
    const w = out.warnings.filter((x) => x.code === "TYPE_WIDENED");
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("its pin");
    // Downstream reads a retyped column: it is rebuilt.
    expect(Number((await assetRow(h, "people")).lr)).toBeGreaterThan(Number(before.lr));
    // The next run finds nothing to change.
    g.__cfg_rows = [{ id: 10, at: at(10), zip: "777" }];
    const again = await ingestStep(h, await plan(h, "people", { pins: { zip: { type: "BIGINT" } } }));
    expect(again.result.schemaChanges).toEqual([]);
    expect(again.warnings.filter((x) => x.code === "TYPE_WIDENED")).toEqual([]);
  });

  test("a lossy pin asks (pin_change) with samples before fetching; pending changes nothing", async () => {
    const h = await zipped(["02134", "12345", "abc"]);
    const { fn, asked } = decider("pending");
    const out = await ingestStep(h, await plan(h, "people", { pins: { zip: { type: "BIGINT" } } }), { confirmChange: fn });
    expect(g.__cfg_calls).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: "pin_change", command: "croft run people", impact: { rows: 2 }, problem: { code: "PIN_CHANGES_DATA" } });
    expect(asked[0]!.impact.action).toContain("zip VARCHAR → BIGINT");
    const p = asked[0]!.problem;
    expect(p.message).toContain(`"02134" → 2134`);
    expect(p.message).toContain(`"abc" → NULL`);
    expect(p.details).toMatchObject({
      column: "zip", from: "VARCHAR", to: "BIGINT", changed: 2, nonNull: 3,
      samples: [{ value: "02134", becomes: "2134" }, { value: "abc", becomes: null }],
    });
    expect(out.result.status).toBe("skipped");
    expect(out.problems.map((x) => x.code)).toEqual(["CONFIRMATION_REQUIRED"]);
    expect(await realType(h, "people", "zip")).toBe("VARCHAR");
  });

  test("granted: the table goes to the trash first, then the column is retyped as shown", async () => {
    const h = await zipped(["02134", "12345", "abc"]);
    g.__cfg_rows = [{ id: 4, at: at(4), zip: "777" }];
    const out = await ingestStep(h, await plan(h, "people", { pins: { zip: { type: "BIGINT" } } }), { confirmChange: decider("granted").fn });
    expect(out.result.status).toBe("ok");
    const trash = listTrash(h.stateDir, "people");
    expect(trash).toHaveLength(1);
    expect(trash[0]!.rows).toBe(3);
    expect(out.result.trashed).toEqual({ path: trash[0]!.path, rows: 3 });
    expect(await all(h, `SELECT id::INT AS id, zip FROM people ORDER BY id`)).toEqual([
      { id: 1, zip: 2134 }, { id: 2, zip: 12345 }, { id: 3, zip: null }, { id: 4, zip: 777 },
    ]);
    expect(await columnRow(h, "people", "zip")).toEqual({ type: "BIGINT", pinned: true, pending: false });
    expect(out.result.schemaChanges).toContainEqual({ kind: "widen", column: "zip", from: "VARCHAR", to: "BIGINT" });
    const w = out.warnings.find((x) => x.code === "PIN_CHANGES_DATA")!;
    expect(w).toMatchObject({ severity: "warning", details: { trashPath: trash[0]!.path, changed: 2 } });
    expect(out.warnings.filter((x) => x.code === "TYPE_WIDENED")).toEqual([]);
  });

  test("a preview retypes its own copy without asking or trashing", async () => {
    const h = await zipped(["02134", "7"]);
    const { fn, asked } = decider("pending");
    const out = await ingestStep(h, await plan(h, "people", { pins: { zip: { type: "BIGINT" } } }), { confirmChange: fn, preview: { rows: 10 } });
    expect(asked).toEqual([]);
    expect(out.result.status).toBe("ok");
    expect(out.result.trashed).toBeUndefined();
    expect(listTrash(h.stateDir)).toEqual([]);
    expect(await all(h, `SELECT zip FROM people ORDER BY id`)).toEqual([{ zip: 2134 }, { zip: 7 }]);
    const w = out.warnings.find((x) => x.code === "PIN_CHANGES_DATA")!;
    expect(w).toMatchObject({ severity: "warning", details: { preview: true, changed: 1 } });
    expect(w.message).toContain("a real run asks for confirmation first");
  });

  test("declined: PIN_CHANGES_DATA with samples, and the fix pins the old type again", async () => {
    const h = await zipped(["02134"]);
    const e = await failure(ingestStep(h, await plan(h, "people", { pins: { zip: { type: "BIGINT" } } }), { confirmChange: decider("declined").fn }));
    expect(e.code).toBe("PIN_CHANGES_DATA");
    expect(e.problem.fix).toMatchObject({ kind: "edit", file: "assets/people.ts" });
    expect(e.problem.fix?.description).toContain("VARCHAR");
    expect(e.problem.effect).toContain("nothing was");
    expect(await realType(h, "people", "zip")).toBe("VARCHAR");
    expect(listTrash(h.stateDir)).toEqual([]);
  });

  test("a stored text read through the pin's format is not a change", async () => {
    const h = await zipped(["25/03/2026", "01/12/2025"]);
    g.__cfg_rows = [];
    const out = await ingestStep(h, await plan(h, "people", { pins: { zip: { type: "DATE", format: "%d/%m/%Y" } } }));
    expect(out.result.status).toBe("ok");
    expect(await all(h, `SELECT zip::VARCHAR AS d FROM people ORDER BY id`)).toEqual([{ d: "2026-03-25" }, { d: "2025-12-01" }]);
  });

  test("a removed pin unpins the column; its type and values stay", async () => {
    const h = harness({ "assets/people.ts": ZIPS });
    g.__cfg_rows = [{ id: 1, at: at(0), zip: 2134 }];
    await ingestStep(h, await plan(h, "people", { pins: { zip: { type: "VARCHAR" } } }));
    expect(await columnRow(h, "people", "zip")).toEqual({ type: "VARCHAR", pinned: true, pending: false });
    g.__cfg_rows = [{ id: 2, at: at(1), zip: "x" }];
    const out = await ingestStep(h, await plan(h, "people", { pins: {} }));
    expect(out.result.status).toBe("ok");
    expect(await columnRow(h, "people", "zip")).toEqual({ type: "VARCHAR", pinned: false, pending: false });
    expect(await all(h, `SELECT zip FROM people ORDER BY id`)).toEqual([{ zip: "2134" }, { zip: "x" }]);
  });

  test("a pin on a NULL-only placeholder retypes it freely", async () => {
    const h = await zipped([null, null]);
    expect(await columnRow(h, "people", "zip")).toMatchObject({ pending: true });
    g.__cfg_rows = [{ id: 5, at: at(5) }];
    const out = await ingestStep(h, await plan(h, "people", { pins: { zip: { type: "DATE" } } }), { confirmChange: decider("pending").fn });
    expect(out.result.status).toBe("ok");
    expect(await realType(h, "people", "zip")).toBe("DATE");
    expect(out.result.schemaChanges).toContainEqual({ kind: "retype_pending", column: "zip", to: "DATE" });
    expect(out.warnings.filter((x) => x.code === "TYPE_WIDENED")).toEqual([]);
  });

  test("a pin spelled another way (an alias, a length) is the same type: nothing changes", async () => {
    const h = await zipped(["a", "b"]);
    g.__cfg_rows = [];
    for (const type of ["text", "VARCHAR(10)", "string"]) {
      const out = await ingestStep(h, await plan(h, "people", { pins: { zip: { type } } }));
      expect(out.result.schemaChanges).toEqual([]);
    }
  });

  test("a pin that is not a plain SQL type is ASSET_INVALID, before anything is fetched", async () => {
    const h = await zipped(["a"]);
    for (const type of ["STRUCT(a INT)", "VARCHAR); DROP TABLE people; --", "NO_SUCH_TYPE"]) {
      const e = await failure(ingestStep(h, await plan(h, "people", { pins: { zip: { type } } })));
      expect(e.code).toBe("ASSET_INVALID");
      expect(e.problem).toMatchObject({ asset: "people", file: "assets/people.ts", fix: { kind: "edit", file: "assets/people.ts" } });
    }
    expect(g.__cfg_calls).toBe(0);
    expect(await realType(h, "people", "zip")).toBe("VARCHAR");
  });

  test("a new key and a lossy pin together ask once, and both apply", async () => {
    const h = harness({ "assets/events.ts": APPEND });
    g.__cfg_rows = [{ id: 1, at: at(0), zip: "02134" }, { id: 1, at: at(1), zip: "1" }, { id: 2, at: at(2), zip: "abc" }];
    await ingestStep(h, await plan(h, "events"));
    const { fn, asked } = decider("granted");
    g.__cfg_rows = [];
    const out = await ingestStep(h, await plan(h, "events", { key: ["id"], pins: { zip: { type: "BIGINT" } } }), { confirmChange: fn });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: "convert_key", impact: { rows: 3 } }); // 1 duplicate + 2 values
    expect(asked[0]!.impact.action).toContain("zip VARCHAR → BIGINT");
    expect(out.result.status).toBe("ok");
    expect(listTrash(h.stateDir, "events")).toHaveLength(1);
    expect(await all(h, `SELECT id::INT AS id, zip FROM events ORDER BY id`)).toEqual([{ id: 1, zip: 1 }, { id: 2, zip: null }]);
  });
});

// R41-03: the key a conversion deduplicates by is the key as its pin retypes it. Texts that differ but cast to the same
// value collide, and every value the cast turns into NULL has no key: both are counted before anything is asked, so
// the confirmed impact covers every row the conversion deletes, and nothing is deleted beyond it.
describe("a key conversion together with a pin on the key", () => {
  test("values the pin turns into NULL rule the conversion out: INGEST_CONFIG_CHANGED, nothing asked, nothing changed", async () => {
    const h = harness({ "assets/items.ts": source(`  write: "append",`) });
    g.__cfg_rows = ["1", "01", "abc", "xyz", "2"].map((id, n) => ({ id, v: `v${n}` }));
    await ingestStep(h, await plan(h, "items"));
    const { fn, asked } = decider("granted");
    const e = await failure(ingestStep(h, await plan(h, "items", { key: ["id"], write: "merge", pins: { id: { type: "BIGINT" } } }), { confirmChange: fn }));
    expect(e.code).toBe("INGEST_CONFIG_CHANGED");
    expect(asked).toEqual([]);
    expect(e.problem.details).toMatchObject({ convertible: false, nullKeys: 2 });
    expect(e.problem.message).toContain("2 stored rows would have no id once it is retyped to BIGINT, its pin");
    expect(await all(h, `SELECT count(*)::INT AS n FROM items`)).toEqual([{ n: 5 }]);
    expect(listTrash(h.stateDir)).toEqual([]);
  });

  test("texts that cast to the same key are duplicates: one convert_key question covers the rows removed and the values changed", async () => {
    const h = harness({ "assets/items.ts": source(`  write: "append",`) });
    g.__cfg_rows = [{ id: "1", v: "first" }, { id: "2", v: "two" }];
    await ingestStep(h, await plan(h, "items"));
    g.__cfg_rows = [{ id: "01", v: "second" }];
    await ingestStep(h, await plan(h, "items"));
    g.__cfg_rows = [];
    const step = await plan(h, "items", { key: ["id"], write: "merge", pins: { id: { type: "BIGINT" } } });
    const pending = decider("pending");
    await ingestStep(h, step, { confirmChange: pending.fn });
    expect(pending.asked).toHaveLength(1);
    const req = pending.asked[0]!;
    // "01" and "1" are both 1 once retyped: 1 row goes, and 1 value ("01" → 1) changes.
    expect(req).toMatchObject({ action: "convert_key", impact: { rows: 2 }, problem: { code: "INGEST_CONFIG_CHANGED" } });
    expect(req.impact.action).toBe("append ingest gains key id; duplicates removed in place; pin change: id VARCHAR → BIGINT");
    expect(req.problem.message).toContain("retypes id to BIGINT, its pin, then keeps the latest row of each id and removes 1 duplicate row (e.g. id=1 ×2)");
    expect(req.problem.message).toContain(`its pin BIGINT would change 1 of 3 stored values (e.g. "01" → 1)`);
    expect(await all(h, `SELECT count(*)::INT AS n FROM items`)).toEqual([{ n: 3 }]);

    const { fn } = decider("granted");
    const out = await ingestStep(h, step, { confirmChange: fn });
    expect(out.result.status).toBe("ok");
    expect(await all(h, `SELECT id::INT AS id, v FROM items ORDER BY id`)).toEqual([{ id: 1, v: "second" }, { id: 2, v: "two" }]);
    expect(listTrash(h.stateDir, "items")).toHaveLength(1);
    // The catalog mirror follows the table.
    expect(getCatalog(h.runs, "items")).toMatchObject({ rows: 2, write: "merge", key: ["id"] });
  });

  test("with no collision and no NULL, a lossy key pin asks pin_change and removes nothing", async () => {
    const h = harness({ "assets/items.ts": source(`  write: "append",`) });
    g.__cfg_rows = [{ id: "01", v: "a" }, { id: "2", v: "b" }];
    await ingestStep(h, await plan(h, "items"));
    g.__cfg_rows = [];
    const { fn, asked } = decider("granted");
    const out = await ingestStep(h, await plan(h, "items", { key: ["id"], write: "merge", pins: { id: { type: "BIGINT" } } }), { confirmChange: fn });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: "pin_change", impact: { rows: 1 } });
    expect(out.result.status).toBe("ok");
    expect(await all(h, `SELECT id::INT AS id FROM items ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await assetRow(h, "items")).toMatchObject({ write_mode: "merge", key_columns: ["id"] });
  });

  test("a change that committed before the fetch failed is in the catalog mirror", async () => {
    const h = harness({ "assets/items.ts": `import { ingest } from "@zabaca/croft";
const g = globalThis as any;
export default ingest({
  write: "append",
  rows() {
    if (g.__cfg_fail) throw new Error("token expired");
    return g.__cfg_rows ?? [];
  },
});
` });
    g.__cfg_rows = [{ id: 1, v: "a" }, { id: 1, v: "b" }, { id: 2, v: "c" }];
    await ingestStep(h, await plan(h, "items"));
    expect(getCatalog(h.runs, "items")).toMatchObject({ rows: 3 });
    g.__cfg_fail = true;
    try {
      await failure(ingestStep(h, await plan(h, "items", { key: ["id"], write: "merge" }), { confirmChange: decider("granted").fn }));
    } finally {
      delete g.__cfg_fail;
    }
    expect(await all(h, `SELECT count(*)::INT AS n FROM items`)).toEqual([{ n: 2 }]);
    expect(getCatalog(h.runs, "items")).toMatchObject({ rows: 2, write: "merge", key: ["id"] });
  });
});

describe("the problems read as croft's other problems do", () => {
  test("every problem has a hint and a fix, and no fix is a destructive command", async () => {
    const h = await appended();
    const seen: Problem[] = [];
    seen.push((await failure(ingestStep(h, await plan(h, "events", { key: ["id"] })))).problem);
    seen.push((await failure(ingestStep(h, await plan(h, "events", { incremental: { kind: "cursor", field: "v", lookbackMs: 0 } })))).problem);
    seen.push(...(await ingestStep(h, await plan(h, "events", { key: ["id"] }), { confirmChange: decider("pending").fn })).problems);
    for (const p of seen) {
      expect(p.hint.length).toBeGreaterThan(0);
      expect(p.fix).toBeDefined();
      if (p.fix?.kind === "command") expect(p.fix.command).not.toMatch(/--rebuild|croft confirm/);
    }
  });
});

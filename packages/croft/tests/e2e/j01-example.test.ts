// Journey 1: croft init → run example_sales → query, status, describe, context (the §4.3 JSON shapes) → run
// again: nothing changed, so every row keeps its _loaded_at; one edited CSV row is the only row restamped.
import { afterAll, expect, test } from "bun:test";
import { cleanupAll, envelopeKeys, initProject, ISO_WITH_OFFSET, RUN_ID, show } from "./harness.ts";

afterAll(cleanupAll);

const ENVELOPE = ["command", "croftVersion", "data", "database", "durationMs", "next", "ok", "problems", "schemaVersion", "timezone"];

test("journey 1: init → run example_sales → query/status/describe/context → run again keeps _loaded_at", async () => {
  const { project: p, init } = await initProject("my-data");
  expect(init.json).toMatchObject({ ok: true, command: "init" });
  for (const f of ["croft.json", "package.json", "tsconfig.json", ".env", ".env.example", ".gitignore", "CLAUDE.md", ".claude/skills/croft/SKILL.md", "assets/example_sales.ts", "files/example_sales.csv"]) {
    expect(p.exists(f)).toBe(true);
  }
  const cfg = JSON.parse(p.read("croft.json"));
  expect(cfg).toMatchObject({ database: "warehouse.duckdb" });
  expect(typeof cfg.timezone).toBe("string");

  // run (off a TTY: detached and followed; the example finishes well within --follow)
  const run = await p.json(["run", "example_sales"]);
  expect(run.code, show(run)).toBe(0);
  expect(envelopeKeys(run.json)).toEqual(ENVELOPE);
  expect(run.json).toMatchObject({ schemaVersion: 1, ok: true, command: "run", database: "warehouse.duckdb", timezone: cfg.timezone });
  expect(run.json.data.runId).toMatch(RUN_ID);
  expect(run.json.data.status).toBe("succeeded");
  const step = run.json.data.steps[0];
  expect(step).toMatchObject({ asset: "example_sales", status: "ok", attempt: 1, rows: { in: 120, added: 120, updated: 0, unchanged: 0, deleted: 0, total: 120 } });
  for (const k of ["asset", "status", "reason", "behavior", "attempt", "maxAttempts", "rows", "schemaChanges", "checks", "logsCommand", "durationMs"]) expect(step).toHaveProperty(k);
  expect(run.json.next.map((n: { command: string }) => n.command)).toContain(`croft query "from example_sales limit 5"`);

  // query
  const q = await p.json(["query", "select * from example_sales order by order_id", "--limit", "500"]);
  expect(q.code, show(q)).toBe(0);
  expect(envelopeKeys(q.json)).toEqual(ENVELOPE);
  expect(Object.keys(q.json.data).sort()).toEqual(["columns", "rowCount", "rows", "truncatedRows", "truncatedValues"]);
  expect(q.json.data.rowCount).toBe(120);
  expect(q.json.data.truncatedRows).toBe(0);
  const cols = Object.fromEntries(q.json.data.columns.map((c: { name: string; type: string }) => [c.name, c.type]));
  expect(cols).toMatchObject({ order_id: "BIGINT", order_date: "DATE", customer: "VARCHAR", quantity: "BIGINT", _file: "VARCHAR", _loaded_at: "TIMESTAMPTZ" });
  const first = q.json.data.rows as Record<string, unknown>[];
  expect(first[0]).toMatchObject({ order_id: 1001, order_date: "2026-01-02", customer: "Willow Yoga", _file: "files/example_sales.csv" });
  expect(String(first[0]!._loaded_at)).toMatch(ISO_WITH_OFFSET);

  // The default cap is 50 rows, and truncatedRows says so.
  const capped = await p.json(["query", "from example_sales"]);
  expect(capped.json.data.rows).toHaveLength(50);
  expect(capped.json.data.truncatedRows).toBe(70);

  // status (§4.3)
  const st = await p.json(["status"]);
  expect(st.code, show(st)).toBe(0);
  expect(Object.keys(st.json.data)).toEqual(expect.arrayContaining(["healthy", "running", "assets", "scheduling"]));
  expect(st.json.data.healthy).toBe(true);
  expect(st.json.data.running).toEqual([]);
  expect(st.json.data.scheduling).toEqual({ state: "off", via: null, lastTickAt: null });
  const sa = st.json.data.assets.find((a: { asset: string }) => a.asset === "example_sales");
  expect(sa).toMatchObject({ asset: "example_sales", kind: "ingest", rows: 120, stale: false, staleReasons: [], held: false, edited: false });
  expect(sa.lastRun).toMatchObject({ runId: run.json.data.runId, status: "ok", code: null });
  expect(sa.lastRun.at).toMatch(ISO_WITH_OFFSET);
  expect(sa.next).toHaveProperty("at");
  expect(sa.next).toHaveProperty("reason");

  // describe (§4.3)
  const d = await p.json(["describe", "example_sales"]);
  expect(d.code, show(d)).toBe(0);
  for (const k of ["asset", "kind", "file", "behavior", "reads", "readBy", "columns", "inputsSeen", "builtWithCodeHash", "checks", "recentWrites", "samples"]) {
    expect(d.json.data).toHaveProperty(k);
  }
  expect(d.json.data).toMatchObject({ asset: "example_sales", kind: "ingest", file: "assets/example_sales.ts", reads: [], readBy: [] });
  expect(d.json.data.behavior).toMatchObject({ write: "replace", key: ["order_id"], incremental: null });
  expect(typeof d.json.data.behavior.words).toBe("string");
  const orderId = d.json.data.columns.find((c: { name: string }) => c.name === "order_id");
  for (const k of ["name", "type", "pinned", "pending", "sourceName", "format", "addedAt", "jsonKeys", "kinds"]) expect(orderId).toHaveProperty(k);
  expect(orderId).toMatchObject({ type: "BIGINT", pinned: false, pending: false });
  expect(d.json.data.recentWrites[0]).toMatchObject({ runId: run.json.data.runId, added: 120 });
  expect(d.json.data.samples.length).toBeGreaterThan(0);
  expect(d.json.data.samples.length).toBeLessThanOrEqual(3);

  // context (§4.3)
  const c = await p.json(["context"]);
  expect(c.code, show(c)).toBe(0);
  for (const k of ["project", "assets", "running", "held", "recentFailures", "recentSchemaChanges"]) expect(c.json.data).toHaveProperty(k);
  expect(c.json.data.truncated).toBe(false);
  expect(c.json.data.assets.map((a: { asset: string }) => a.asset)).toEqual(["example_sales"]);
  expect(c.json.data.assets[0]).toMatchObject({ asset: "example_sales", rows: 120, key: ["order_id"] });
  expect(Buffer.byteLength(c.stdout)).toBeLessThan(20 * 1024 + 2048);

  // run again: nothing changed, every row keeps its _loaded_at
  const stamps = new Map(first.map((r) => [r.order_id, r._loaded_at]));
  const again = await p.json(["run", "example_sales"]);
  expect(again.code, show(again)).toBe(0);
  expect(again.json.data.steps[0].status === "unchanged" || again.json.data.steps[0].rows.unchanged === 120, show(again)).toBe(true);
  expect(again.json.data.steps[0].rows).toMatchObject({ added: 0, updated: 0, deleted: 0, total: 120 });
  const after = await p.rows("select order_id, _loaded_at from example_sales order by order_id");
  expect(after).toHaveLength(120);
  for (const r of after) expect(r._loaded_at).toBe(stamps.get(r.order_id));

  // One edited row: only that row gets a new stamp.
  const csv = p.read("files/example_sales.csv").split("\n");
  const i = csv.findIndex((l) => l.startsWith("1002,"));
  csv[i] = csv[i]!.replace("Cedar Books", "Cedar Books & Co");
  p.write("files/example_sales.csv", csv.join("\n"));
  const edited = await p.json(["run", "example_sales"]);
  expect(edited.code, show(edited)).toBe(0);
  expect(edited.json.data.steps[0].rows).toMatchObject({ added: 0, updated: 1, unchanged: 119, deleted: 0, total: 120 });
  const restamped = await p.rows("select order_id, customer, _loaded_at from example_sales order by order_id");
  for (const r of restamped) {
    if (r.order_id === 1002) {
      expect(r.customer).toBe("Cedar Books & Co");
      expect(r._loaded_at).not.toBe(stamps.get(1002));
    } else expect(r._loaded_at).toBe(stamps.get(r.order_id));
  }
}, 120_000);

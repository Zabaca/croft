// Journey 16: SQL transforms (DESIGN §3c, §3d, §3f, §5 "Transforms" and "Versions, staleness and atomicity",
// §8 "What a code change does"). A file ingest of shop orders (raw), an SQL transform that cleans it, and a
// daily revenue report over the clean table, each with checks:
//
//   raw_orders (files/orders.csv) → clean_orders.sql → daily_revenue.sql
//                                          regions.sql ┘ (read only by a check of daily_revenue)
//
// - a bare first run builds everything in dependency order; regions is read only in a `-- check:` subquery of
//   daily_revenue and sorts after it by name, so running first proves the check's table orders the steps;
// - a run with nothing new rebuilds nothing, and every row keeps its _loaded_at;
// - a blocking check that fails exits 3, writes nothing (the table keeps its old rows, _croft.writes has no
//   row for it), and the downstream report is skipped with skippedBecause;
// - `run raw_orders --only` leaves the transforms stale; the next bare run updates them;
// - an SQL edit that changes no output rebuilds with every row keeping its stamp, and wakes nothing downstream;
//   a shape change recreates the table (every row restamped), yet the report's unchanged rows keep theirs;
// - a regions edit and an order in the new region: the check passes only because regions is rebuilt first;
// - a time zone change in croft.json rebuilds every transform (::DATE days move), unchanged rows keep stamps;
// - a failed ingest skips its downstream transitively; so does a transform that fails at run time;
// - a transform left stale by `run <its input> --only` is rebuilt by the next bare run, though its input is
//   up to date by then.
// Product bugs found on the way are bugTest()s at the bottom.
import { afterAll, expect, test } from "bun:test";
import { bugTest, cleanupAll, type Envelope, initProject, ISO_WITH_OFFSET, type Project, RUN_ID, show } from "./harness.ts";

afterAll(cleanupAll);

// ---------------------------------------------------------------------------------------------------------
// The project

const RAW = `// assets/raw_orders.ts: the shop's order export, as it arrives
import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Order exports from the shop",
  file: "files/orders.csv",
  key: "order_id",
});
`;

const HEADER = "order_id,ordered_at,email,region,status,amount,refunded";
const ROW = {
  1: "1,2026-03-01T07:30:00Z, Ann@Example.com ,East,paid,20.00,0.00",   // 2026-02-28 in Los Angeles
  2: "2,2026-03-01T18:00:00Z,bob@example.com,West,paid,15.50,5.50",
  3: "3,2026-03-02T05:30:00Z,CARL@example.com,East,paid,40.00,0.00",    // 2026-03-01 in Los Angeles
  4: "4,2026-03-02T20:00:00Z,dee@example.com,West,cancelled,99.00,0.00",
  5: "5,2026-03-03T09:15:00Z,eve@example.com,East,paid,12.25,0.00",
  6: "6,2026-03-04T12:00:00Z,fay@example.com,West,paid,8.00,0.00",
} as const;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";
const FIRST = csv(ROW[1], ROW[2], ROW[3], ROW[4], ROW[5]);

const CLEAN = `-- description: Paid orders with normalized emails
-- key: order_id
-- check: amount >= 0
-- check: refunded <= amount
SELECT
  order_id,
  ordered_at,
  lower(trim(email)) AS email,
  region,
  amount,
  refunded
FROM raw_orders
WHERE status <> 'cancelled'
`;

const DAILY = `-- description: Revenue per day (project time zone) and region
-- key: day, region
-- check: net <= gross
-- check: region IN (SELECT region FROM regions)
SELECT
  ordered_at::DATE        AS day,         -- project time zone days
  region,
  sum(amount)             AS gross,
  sum(amount - refunded)  AS net,
  count(*)                AS orders
FROM clean_orders
GROUP BY ALL
`;

const REGIONS = `-- description: The regions the shop sells in
-- key: region
SELECT * FROM (VALUES ('East'), ('West')) AS t(region)
`;

async function shopProject(): Promise<Project> {
  const { project: p } = await initProject("shop");
  p.remove("assets/example_sales.ts");
  p.remove("files/example_sales.csv");
  p.write("assets/raw_orders.ts", RAW);
  p.write("files/orders.csv", FIRST);
  p.write("assets/clean_orders.sql", CLEAN);
  p.write("assets/daily_revenue.sql", DAILY);
  p.write("assets/regions.sql", REGIONS);
  return p;
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

type Step = Record<string, any>;

function stepOf(env: Envelope, asset: string): Step {
  const s = (env.data.steps as Step[]).find((x) => x.asset === asset);
  if (!s) throw new Error(`no step for ${asset}: ${JSON.stringify(env.data.steps.map((x: Step) => x.asset))}`);
  return s;
}

const statusOf = (env: Envelope) => Object.fromEntries((env.data.steps as Step[]).map((s) => [s.asset, s.status]));

/** `_loaded_at` of each row of a table (as epoch microseconds: the instant, whatever the project time zone), by
 *  its key columns joined with "|". */
async function stamps(p: Project, table: string, key: string): Promise<Map<string, string>> {
  const rows = await p.rows(`select concat_ws('|', ${key}) AS k, epoch_us(_loaded_at) AS at from ${table} order by k`);
  return new Map(rows.map((r) => [String(r.k), String(r.at)]));
}

const revenue = (p: Project) => p.rows("select day, region, gross, net, orders from daily_revenue order by day, region");

async function statusAssets(p: Project): Promise<Record<string, Step>> {
  const st = await p.json(["status"]);
  expect(st.code, show(st)).toBe(0);
  return Object.fromEntries((st.json.data.assets as Step[]).map((a) => [a.asset, a]));
}

// The state the bug tests below read.
let checkFailedRun: Envelope | undefined;
let rebuildRun: Envelope | undefined;
let tzDryRun: Envelope | undefined;

// ---------------------------------------------------------------------------------------------------------
// The journey

test("journey 16: raw → clean → report with checks; check failures, staleness, rebuilds that keep _loaded_at, time zones", async () => {
  const p = await shopProject();

  // ---- First build: a bare run takes everything, in dependency order.
  const first = await p.json(["run"]);
  expect(first.code, show(first)).toBe(0);
  expect(first.json.data.status).toBe("succeeded");
  // regions ("r") sorts after daily_revenue ("d"), and only daily_revenue's check reads it: it runs first
  // because the check's table orders the steps (§3f).
  expect(first.json.data.steps.map((s: Step) => s.asset)).toEqual(["raw_orders", "clean_orders", "regions", "daily_revenue"]);
  expect(statusOf(first.json)).toEqual({ raw_orders: "ok", clean_orders: "ok", regions: "ok", daily_revenue: "ok" });
  expect(stepOf(first.json, "raw_orders").rows).toMatchObject({ in: 5, added: 5, total: 5 });
  const clean1 = stepOf(first.json, "clean_orders");
  expect(clean1).toMatchObject({ reason: "never built", behavior: "replace; key order_id", rows: { in: 4, added: 4, total: 4 }, created: { columns: 6 } });
  // The key implies unique and not_null; every check ran and passed.
  expect(clean1.checks.map((c: Step) => [c.check, c.ok])).toEqual([
    ["unique(order_id)", true], ["not_null(order_id)", true], ["amount >= 0", true], ["refunded <= amount", true],
  ]);
  expect(clean1.inputs).toEqual([expect.objectContaining({ input: "raw_orders", seenBefore: null, rows: 5 })]);
  const daily1 = stepOf(first.json, "daily_revenue");
  expect(daily1.checks.map((c: Step) => c.check)).toEqual(["unique(day, region)", "not_null(day, region)", "net <= gross", "region IN (SELECT region FROM regions)"]);
  expect(daily1.checks.every((c: Step) => c.ok)).toBe(true);

  // The clean table: cancelled order gone, emails normalized, croft's _file not copied from the ingest.
  const cleanRows = await p.rows("select * from clean_orders order by order_id");
  expect(cleanRows.map((r) => r.order_id)).toEqual([1, 2, 3, 5]);
  expect(cleanRows[0]).toMatchObject({ email: "ann@example.com", region: "East", amount: 20, refunded: 0, ordered_at: "2026-02-28T23:30:00-08:00" });
  expect(Object.keys(cleanRows[0]!).sort()).toEqual(["_loaded_at", "amount", "email", "order_id", "ordered_at", "refunded", "region"]);
  // Days are Los Angeles days (the project time zone).
  expect(await revenue(p)).toEqual([
    { day: "2026-02-28", region: "East", gross: 20, net: 20, orders: 1 },
    { day: "2026-03-01", region: "East", gross: 40, net: 40, orders: 1 },
    { day: "2026-03-01", region: "West", gross: 15.5, net: 10, orders: 1 },
    { day: "2026-03-03", region: "East", gross: 12.25, net: 12.25, orders: 1 },
  ]);

  // The check's table orders the steps, but it is not an input: validate, describe and status agree.
  const v = await p.json(["validate"]);
  expect(v.code, show(v)).toBe(0);
  expect(v.json.data.order).toEqual(["raw_orders", "clean_orders", "regions", "daily_revenue"]);
  const vDaily = v.json.data.assets.find((a: Step) => a.name === "daily_revenue");
  expect(vDaily).toMatchObject({ kind: "sql", inputs: ["clean_orders"], behavior: "replace; key day, region", codeChanged: false });
  expect(vDaily.outputColumns).toEqual([
    { name: "day", type: "DATE" }, { name: "region", type: "VARCHAR" }, { name: "gross", type: "DOUBLE" },
    { name: "net", type: "DOUBLE" }, { name: "orders", type: "BIGINT" },
  ]);
  const dRegions = await p.json(["describe", "regions"]);
  expect(dRegions.json.data).toMatchObject({ reads: [], readBy: [] });
  const dClean = await p.json(["describe", "clean_orders"]);
  expect(dClean.json.data).toMatchObject({ kind: "sql", reads: ["raw_orders"], readBy: ["daily_revenue"] });

  // ---- Nothing new: the ingest is unchanged, so no transform rebuilds and every row keeps its stamp.
  const cleanStamps1 = await stamps(p, "clean_orders", "order_id");
  const dailyStamps1 = await stamps(p, "daily_revenue", "day, region");
  const again = await p.json(["run"]);
  expect(again.code, show(again)).toBe(0);
  expect(statusOf(again.json)).toEqual({ raw_orders: "unchanged", clean_orders: "skipped", daily_revenue: "skipped" });
  expect(stepOf(again.json, "clean_orders").skippedBecause).toBe("up to date: raw_orders did not change");
  expect(stepOf(again.json, "daily_revenue").skippedBecause).toBe("up to date: clean_orders did not change");
  expect(await stamps(p, "clean_orders", "order_id")).toEqual(cleanStamps1);
  expect(await stamps(p, "daily_revenue", "day, region")).toEqual(dailyStamps1);

  // ---- A blocking check fails: exit 3, nothing written, the report downstream is skipped.
  // Order 2 is re-exported with a refund larger than its amount, and order 6 arrives.
  p.write("files/orders.csv", csv(ROW[1], ROW[2].replace(",5.50", ",25.50"), ROW[3], ROW[4], ROW[5], ROW[6]));
  const failed = await p.json(["run"]);
  checkFailedRun = failed.json;
  expect(failed.code, show(failed)).toBe(3);
  expect(failed.json.ok).toBe(false);
  expect(failed.json.data.status).toBe("failed");
  const runId = failed.json.data.runId as string;
  expect(runId).toMatch(RUN_ID);
  expect(statusOf(failed.json)).toEqual({ raw_orders: "ok", clean_orders: "failed", daily_revenue: "skipped" });
  expect(stepOf(failed.json, "raw_orders").rows).toMatchObject({ added: 1, updated: 1, total: 6 });
  const bad = stepOf(failed.json, "clean_orders");
  expect(bad.error).toMatchObject({
    code: "CHECK_FAILED", severity: "error", asset: "clean_orders", file: "assets/clean_orders.sql", runId,
    effect: "nothing was written; clean_orders keeps its previous 4 rows",
    fix: { kind: "manual", description: "correct assets/clean_orders.sql or the data, then: croft run clean_orders" },
    docs: "croft docs CHECK_FAILED",
  });
  expect(bad.error.message).toStartWith("refunded <= amount: 1 of ");
  expect(bad.error.details).toMatchObject({ check: "refunded <= amount", failing: 1 });
  expect(bad.error.details.sample).toEqual([expect.objectContaining({ order_id: 2, amount: 15.5, refunded: 25.5 })]);
  expect(bad.checks.find((c: Step) => c.check === "refunded <= amount")).toMatchObject({ ok: false, failing: 1 });
  expect(failed.json.problems.map((x: Step) => x.code)).toEqual(["CHECK_FAILED"]);
  // DESIGN §5 "Atomicity": its downstream shows `skipped: input clean_orders failed (r_…)`.
  expect(stepOf(failed.json, "daily_revenue")).toMatchObject({ status: "skipped", skippedBecause: `input clean_orders failed (${runId})` });
  // Nothing was written: the old rows, their stamps, and no _croft.writes row for this run.
  const kept = await p.rows("select order_id, refunded from clean_orders order by order_id");
  expect(kept).toEqual([{ order_id: 1, refunded: 0 }, { order_id: 2, refunded: 5.5 }, { order_id: 3, refunded: 0 }, { order_id: 5, refunded: 0 }]);
  expect(await stamps(p, "clean_orders", "order_id")).toEqual(cleanStamps1);
  expect(await stamps(p, "daily_revenue", "day, region")).toEqual(dailyStamps1);
  const writes = await p.rows(`select asset from _croft.writes where run_id = '${runId}' order by asset`);
  expect(writes.map((r) => r.asset)).toEqual(["raw_orders"]);
  // status and logs say what happened; the transform is still stale (the input it failed on is unseen).
  const st1 = await statusAssets(p);
  expect(st1.clean_orders).toMatchObject({ status: "failed", lastRun: { runId, status: "failed", code: "CHECK_FAILED" }, stale: true, staleReasons: ["input_changed"], rows: 4 });
  expect(st1.daily_revenue).toMatchObject({ status: "skipped", stale: false });
  const logs = await p.json(["logs", "clean_orders", "--failed"]);
  expect(logs.code, show(logs)).toBe(0);
  expect(logs.json.data.steps[0]).toMatchObject({ runId, status: "failed", error: { code: "CHECK_FAILED" } });
  // The human output: the failed step, the skipped one, and the check's fix.
  const human = await p.croft(["run"]);
  expect(human.code, show(human)).toBe(3);
  expect(human.stdout).toMatch(/failed\s+clean_orders\s+CHECK_FAILED: refunded <= amount: 1 of /);
  expect(human.stdout).toMatch(/skipped\s+daily_revenue\s+input clean_orders failed \(r_\d{4}_\d{4}_[0-9a-z]{4}\)/);
  expect(human.stdout).toContain("fix: correct assets/clean_orders.sql or the data, then: croft run clean_orders");
  expect(human.stdout).toContain("effect: nothing was written; clean_orders keeps its previous 4 rows");

  // ---- The export is corrected, but only the ingest runs: the transforms are left stale ...
  p.write("files/orders.csv", csv(ROW[1], ROW[2], ROW[3], ROW[4], ROW[5], ROW[6]));
  const only = await p.json(["run", "raw_orders", "--only"]);
  expect(only.code, show(only)).toBe(0);
  expect(only.json.data.steps.map((s: Step) => s.asset)).toEqual(["raw_orders"]);
  const st2 = await statusAssets(p);
  expect(st2.clean_orders).toMatchObject({ stale: true, staleReasons: ["input_changed"] });
  expect(st2.daily_revenue).toMatchObject({ stale: false, staleReasons: [] });
  // ... and the next bare run updates them (a stale transform, then what reads it).
  const dry = await p.croft(["run", "--dry-run"]);
  expect(dry.code, show(dry)).toBe(0);
  expect(dry.stdout).toMatch(/^rebuild\s+clean_orders\s+input raw_orders has new rows$/m);
  const bare = await p.json(["run"]);
  expect(bare.code, show(bare)).toBe(0);
  expect(statusOf(bare.json)).toEqual({ raw_orders: "unchanged", clean_orders: "ok", daily_revenue: "ok" });
  expect(stepOf(bare.json, "clean_orders")).toMatchObject({ reason: "input raw_orders has new rows", rows: { in: 5, added: 1, updated: 0, unchanged: 4, deleted: 0, total: 5 } });
  expect(stepOf(bare.json, "daily_revenue").rows).toMatchObject({ added: 1, updated: 0, unchanged: 4, deleted: 0, total: 5 });
  // Rebuilds are written as a diff: only the new rows carry a new stamp.
  const cleanStamps2 = await stamps(p, "clean_orders", "order_id");
  for (const [k, at] of cleanStamps1) expect(cleanStamps2.get(k)).toBe(at);
  expect(cleanStamps2.get("6")).not.toBe(cleanStamps1.get("1"));
  const dailyStamps2 = await stamps(p, "daily_revenue", "day, region");
  for (const [k, at] of dailyStamps1) expect(dailyStamps2.get(k)).toBe(at);
  expect((await revenue(p)).at(-1)).toEqual({ day: "2026-03-04", region: "West", gross: 8, net: 8, orders: 1 });
  const st3 = await statusAssets(p);
  for (const a of ["raw_orders", "clean_orders", "regions", "daily_revenue"]) expect(st3[a], a).toMatchObject({ status: "ok", stale: false });

  // ---- An SQL edit that changes no output: rebuilt, every row keeps its stamp, nothing downstream wakes.
  p.write("assets/clean_orders.sql", CLEAN.replace("lower(trim(email))", "trim(lower(email))"));
  const st4 = await statusAssets(p);
  expect(st4.clean_orders).toMatchObject({ stale: true, staleReasons: ["code_changed"], edited: true });
  const same = await p.json(["run", "clean_orders"]);
  rebuildRun = same.json;
  expect(same.code, show(same)).toBe(0);
  expect(stepOf(same.json, "clean_orders")).toMatchObject({ status: "ok", reason: "requested; SQL changed (assets/clean_orders.sql)", rows: { in: 5, added: 0, updated: 0, unchanged: 5, deleted: 0, total: 5 } });
  expect(stepOf(same.json, "daily_revenue")).toMatchObject({ status: "skipped", skippedBecause: "up to date: clean_orders did not change" });
  expect(await stamps(p, "clean_orders", "order_id")).toEqual(cleanStamps2);
  expect((await statusAssets(p)).clean_orders).toMatchObject({ stale: false, edited: false });

  // ---- A shape change recreates the table: every row gets a new stamp. The report reads no new column, so
  // its rebuild changes no row and its stamps survive.
  p.write("assets/clean_orders.sql", CLEAN.replace("  refunded\n", "  refunded,\n  status\n"));
  const shape = await p.json(["run", "clean_orders"]);
  expect(shape.code, show(shape)).toBe(0);
  const reshaped = stepOf(shape.json, "clean_orders");
  expect(reshaped.schemaChanges).toEqual([{ kind: "recreate", reason: "shape_changed" }]);
  expect(reshaped.rows).toMatchObject({ added: 5, deleted: 5, total: 5 });
  const cleanStamps3 = await stamps(p, "clean_orders", "order_id");
  for (const [k, at] of cleanStamps2) expect(cleanStamps3.get(k), k).not.toBe(at);
  expect((await p.rows("select distinct status from clean_orders")).map((r) => r.status)).toEqual(["paid"]);
  expect(stepOf(shape.json, "daily_revenue")).toMatchObject({ status: "ok", rows: { added: 0, updated: 0, deleted: 0, unchanged: 5 } });
  expect(await stamps(p, "daily_revenue", "day, region")).toEqual(dailyStamps2);

  // ---- A new region and an order in it, in one bare run: daily_revenue's check reads regions, so it passes
  // only because regions is rebuilt before daily_revenue.
  p.write("assets/regions.sql", REGIONS.replace("('West')", "('West'), ('North')"));
  p.write("files/orders.csv", csv(ROW[1], ROW[2], ROW[3], ROW[4], ROW[5], ROW[6], "7,2026-03-05T20:00:00Z,gus@example.com,North,paid,30.00,0.00"));
  const north = await p.json(["run"]);
  expect(north.code, show(north)).toBe(0);
  expect(north.json.data.steps.map((s: Step) => [s.asset, s.status])).toEqual([
    ["raw_orders", "ok"], ["clean_orders", "ok"], ["regions", "ok"], ["daily_revenue", "ok"],
  ]);
  expect(stepOf(north.json, "regions").reason).toBe("SQL changed (assets/regions.sql)");
  expect((await revenue(p)).at(-1)).toEqual({ day: "2026-03-05", region: "North", gross: 30, net: 30, orders: 1 });

  // ---- The project time zone changes: every transform is rebuilt (::DATE gives UTC days now).
  const cleanStamps4 = await stamps(p, "clean_orders", "order_id");
  const dailyStamps4 = await stamps(p, "daily_revenue", "day, region");
  const cfg = JSON.parse(p.read("croft.json")) as Record<string, unknown>;
  p.write("croft.json", JSON.stringify({ ...cfg, timezone: "UTC" }, null, 2) + "\n");
  const st5 = await statusAssets(p);
  for (const a of ["clean_orders", "regions", "daily_revenue"]) expect(st5[a], a).toMatchObject({ stale: true, staleReasons: ["code_changed"] });
  const tz = await p.json(["run", "--dry-run"]);
  tzDryRun = tz.json;
  expect(tz.code, show(tz)).toBe(0);
  expect(tz.json.data.steps.map((s: Step) => [s.asset, s.action])).toEqual([
    ["raw_orders", "fetch"], ["clean_orders", "rebuild"], ["regions", "rebuild"], ["daily_revenue", "rebuild"],
  ]);
  for (const s of (tz.json.data.steps as Step[]).slice(1)) expect(s.reasons as string[], s.asset).toContain("code_changed");
  const utc = await p.json(["run"]);
  expect(utc.code, show(utc)).toBe(0);
  expect(utc.json.timezone).toBe("UTC");
  expect(statusOf(utc.json)).toEqual({ raw_orders: "unchanged", clean_orders: "ok", regions: "ok", daily_revenue: "ok" });
  // The instants did not move: every clean row (and region) is unchanged and keeps its stamp.
  expect(stepOf(utc.json, "clean_orders").rows).toMatchObject({ added: 0, updated: 0, deleted: 0, unchanged: 6 });
  expect(stepOf(utc.json, "regions").rows).toMatchObject({ added: 0, updated: 0, deleted: 0, unchanged: 3 });
  expect(await stamps(p, "clean_orders", "order_id")).toEqual(cleanStamps4);
  // Orders 1 and 3 fall on UTC days now; the other days' rows are unchanged and keep their stamps.
  expect(stepOf(utc.json, "daily_revenue").rows).toMatchObject({ added: 1, updated: 1, deleted: 1, unchanged: 4, total: 6 });
  expect(await revenue(p)).toEqual([
    { day: "2026-03-01", region: "East", gross: 20, net: 20, orders: 1 },
    { day: "2026-03-01", region: "West", gross: 15.5, net: 10, orders: 1 },
    { day: "2026-03-02", region: "East", gross: 40, net: 40, orders: 1 },
    { day: "2026-03-03", region: "East", gross: 12.25, net: 12.25, orders: 1 },
    { day: "2026-03-04", region: "West", gross: 8, net: 8, orders: 1 },
    { day: "2026-03-05", region: "North", gross: 30, net: 30, orders: 1 },
  ]);
  const dailyStamps5 = await stamps(p, "daily_revenue", "day, region");
  for (const k of ["2026-03-01|West", "2026-03-03|East", "2026-03-04|West", "2026-03-05|North"]) expect(dailyStamps5.get(k), k).toBe(dailyStamps4.get(k));
  expect(dailyStamps5.get("2026-03-01|East")).not.toBe(dailyStamps4.get("2026-03-01|East"));
  // Timestamps now render in UTC.
  expect((await p.rows("select ordered_at from clean_orders where order_id = 1"))[0]!.ordered_at).toBe("2026-03-01T07:30:00+00:00");
  // And then nothing is stale.
  const settled = await p.json(["run"]);
  expect(settled.code, show(settled)).toBe(0);
  expect(statusOf(settled.json)).toEqual({ raw_orders: "unchanged", clean_orders: "skipped", daily_revenue: "skipped" });
}, 180_000);

test("journey 16b: a failed ingest skips everything downstream of it, transitively, and every table keeps its rows", async () => {
  const p = await shopProject();
  const first = await p.json(["run"]);
  expect(first.code, show(first)).toBe(0);
  const before = await stamps(p, "daily_revenue", "day, region");

  // The shop's export comes back empty: the replace ingest refuses to shrink (SHRINK_GUARD, exit 1).
  p.write("files/orders.csv", csv());
  const r = await p.json(["run"]);
  expect(r.code, show(r)).toBe(1);
  const runId = r.json.data.runId as string;
  expect(statusOf(r.json)).toEqual({ raw_orders: "failed", clean_orders: "skipped", daily_revenue: "skipped" });
  expect(stepOf(r.json, "raw_orders").error.code).toBe("SHRINK_GUARD");
  expect(stepOf(r.json, "clean_orders").skippedBecause).toBe(`input raw_orders failed (${runId})`);
  expect(stepOf(r.json, "daily_revenue").skippedBecause).toBe(`input clean_orders was not built: input raw_orders failed (${runId})`);
  expect(r.json.problems.map((x: Step) => x.code)).toEqual(["SHRINK_GUARD"]);
  expect((await p.rows("select count(*) n from raw_orders"))[0]!.n).toBe(5);
  expect((await p.rows("select count(*) n from clean_orders"))[0]!.n).toBe(4);
  expect(await stamps(p, "daily_revenue", "day, region")).toEqual(before);
  const st = await statusAssets(p);
  expect(st.clean_orders).toMatchObject({ status: "skipped", rows: 4 });
  expect(st.daily_revenue).toMatchObject({ status: "skipped", rows: 4 });

  // A transform that fails at run time (a cast of text to a number) also skips what reads it; exit 2 (an SQL
  // error is the project's to fix).
  p.write("files/orders.csv", FIRST);
  p.write("assets/clean_orders.sql", CLEAN.replace("  amount,\n", "  amount,\n  CAST(email AS INTEGER) AS email_number,\n"));
  const cast = await p.json(["run"]);
  expect(cast.code, show(cast)).toBe(2);
  expect(statusOf(cast.json)).toEqual({ raw_orders: "unchanged", clean_orders: "failed", daily_revenue: "skipped" });
  expect(stepOf(cast.json, "clean_orders").error).toMatchObject({ code: "QUERY_FAILED", file: "assets/clean_orders.sql", effect: "nothing was written" });
  expect(stepOf(cast.json, "daily_revenue").skippedBecause).toBe(`input clean_orders failed (${cast.json.data.runId})`);
  expect((await p.rows("select count(*) n from clean_orders"))[0]!.n).toBe(4);
}, 120_000);

test("journey 16c: a transform left stale by `--only` upstream of it is updated by the next bare run", async () => {
  const p = await shopProject();
  const first = await p.json(["run"]);
  expect(first.code, show(first)).toBe(0);
  const before = await revenue(p);

  // The clean table changes (amounts in cents now), but only it runs: the report reads stale numbers.
  p.write("assets/clean_orders.sql", CLEAN.replace("  amount,\n  refunded\n", "  amount * 100 AS amount,\n  refunded * 100 AS refunded\n"));
  const only = await p.json(["run", "clean_orders", "--only"]);
  expect(only.code, show(only)).toBe(0);
  expect(only.json.data.steps.map((s: Step) => [s.asset, s.status])).toEqual([["clean_orders", "ok"]]);
  expect(stepOf(only.json, "clean_orders").rows).toMatchObject({ updated: 4, unchanged: 0 });
  expect(await revenue(p)).toEqual(before);
  const st = await statusAssets(p);
  expect(st.clean_orders).toMatchObject({ stale: false });
  expect(st.daily_revenue).toMatchObject({ stale: true, staleReasons: ["input_changed"] });
  const status = await p.json(["status"]);
  expect(status.json.data.healthy).toBe(false);
  expect(status.json.next[0]).toMatchObject({ command: "croft run --dry-run" });

  // A bare run: the ingest has nothing new and clean_orders is up to date, but the stale report is rebuilt.
  const dry = await p.croft(["run", "--dry-run"]);
  expect(dry.stdout).toMatch(/^rebuild\s+daily_revenue\s+input clean_orders has new rows$/m);
  const bare = await p.json(["run"]);
  expect(bare.code, show(bare)).toBe(0);
  expect(statusOf(bare.json)).toEqual({ raw_orders: "unchanged", clean_orders: "skipped", daily_revenue: "ok" });
  expect(stepOf(bare.json, "clean_orders").skippedBecause).toBe("up to date: raw_orders did not change");
  expect(stepOf(bare.json, "daily_revenue")).toMatchObject({ reason: "input clean_orders has new rows", rows: { updated: 4, unchanged: 0 } });
  expect((await revenue(p)).map((r) => [r.day, r.region, r.gross, r.net])).toEqual(before.map((r) => [r.day, r.region, Number(r.gross) * 100, Number(r.net) * 100]));
  const settled = await statusAssets(p);
  for (const a of ["raw_orders", "clean_orders", "regions", "daily_revenue"]) expect(settled[a], a).toMatchObject({ stale: false });
}, 120_000);

// ---------------------------------------------------------------------------------------------------------
// Product bugs (reported). Each keeps its assertions in bugTest(): flip to test() once fixed.

// BUG (reported): a table read only in a check's subquery is ordered first (§3f), but `croft run <asset>
// --upstream` does not build it when it was never built, so the asset fails with CHECK_INVALID and the hint
// "correct the check in assets/daily_revenue.sql". The check is correct: its table is just not built yet. Either
// --upstream builds it (it runs first anyway), or the problem says to build the table (croft run regions).
bugTest("journey 16d: `run <asset> --upstream` builds, or at least names, the never-built table a check reads", async () => {
  const p = await shopProject();
  const r = await p.json(["run", "daily_revenue", "--upstream"]);
  const daily = stepOf(r.json, "daily_revenue");
  const namesRegions = [daily.error?.hint, daily.error?.fix?.command, daily.error?.fix?.description]
    .some((t) => typeof t === "string" && t.includes("croft run regions"));
  expect(daily.status === "ok" || namesRegions, show(r)).toBe(true);
  expect(daily.error?.hint ?? "", show(r)).not.toContain("correct the check");
}, 60_000);

// Fixed (was a reported bug): DESIGN §4 Conventions: "Timestamps in JSON are ISO-8601 with the project offset", so they agree
// with ::DATE and with `croft query`. CHECK_FAILED's details.sample (and StepResult.checks[].sample, and the
// rendered sample line) show a TIMESTAMPTZ as UTC with microseconds ("2026-03-01T18:00:00.000000Z"), while
// `croft query` shows the same value as "2026-03-01T10:00:00-08:00".
test("journey 16e: CHECK_FAILED samples render timestamps with the project offset, as croft query does", () => {
  expect(checkFailedRun).toBeDefined();
  const bad = stepOf(checkFailedRun!, "clean_orders");
  const sample = bad.error.details.sample[0];
  expect(sample.ordered_at, JSON.stringify(sample)).toMatch(ISO_WITH_OFFSET);
  expect(sample.ordered_at).toBe("2026-03-01T10:00:00-08:00");
  expect(bad.error.message).toContain('ordered_at="2026-03-01T10:00:00-08:00"');
});

// Fixed (was a reported bug): the same convention for StepResult.inputs (§4.3 `inputs?: [{input, seenBefore, seenAfter,
// rows}]`): seenBefore/seenAfter are UTC ("2026-09-24T15:28:38.925000Z"), while describe's inputsSeen shows
// the same positions with the project offset.
test("journey 16f: a transform step's inputs[].seenBefore/seenAfter carry the project offset", () => {
  expect(rebuildRun).toBeDefined();
  const inputs = stepOf(rebuildRun!, "clean_orders").inputs as Step[];
  expect(inputs.length).toBe(1);
  expect(inputs[0]!.seenBefore, JSON.stringify(inputs)).toMatch(ISO_WITH_OFFSET);
  expect(inputs[0]!.seenAfter, JSON.stringify(inputs)).toMatch(ISO_WITH_OFFSET);
});

// BUG (reported): after only croft.json's timezone changed, the run reason (dry run, run output) says
// "SQL changed (assets/clean_orders.sql)" for every SQL transform, and status reports EDITED_SINCE_LAST_RUN
// ("edited since its last run") for every asset, though no asset file was edited. An agent reading it looks for
// an edit that does not exist; the reason should name the time zone (§8: "Changing timezone in croft.json
// rebuilds every transform").
bugTest("journey 16g: a time zone change is the reason given, not an SQL change", () => {
  expect(tzDryRun).toBeDefined();
  const clean = stepOf(tzDryRun!, "clean_orders");
  expect(clean.reason, JSON.stringify(clean)).toMatch(/time ?zone/i);
  expect(clean.reason).not.toContain("SQL changed");
});

// Fixed (was a reported bug): the run output counts a failing *warning* as a failed check: "checks 2/3 ok" on an ok step,
// where §4.2 shows blocking checks and warnings apart ("checks 3/3 ok · 1 warning").
test("journey 16h: human run output counts warnings apart from checks (checks 2/2 ok · 1 warning)", async () => {
  const { project: p } = await initProject();
  p.write("assets/numbers.sql", "-- key: n\n-- warn: n < 2\nSELECT * FROM (VALUES (1), (2), (3)) AS t(n)\n");
  const r = await p.croft(["run", "numbers"]);
  expect(r.code, show(r)).toBe(0);
  expect(r.stdout, show(r)).toContain("checks 2/2 ok · 1 warning");
  expect(r.stdout).not.toContain("checks 2/3 ok");
}, 60_000);

// Fixed (was a reported bug): a failed step's multi-line error (CHECK_FAILED with its sample rows) is printed as is under the
// step, so its sample rows start at column 3 and break the run table; §3f shows them indented under the step.
test("journey 16i: a failed step's sample rows are indented under the step in human run output", async () => {
  const { project: p } = await initProject();
  p.write("assets/numbers.sql", "-- key: n\n-- check: n < 3\nSELECT * FROM (VALUES (1), (2), (3)) AS t(n)\n");
  const r = await p.croft(["run", "numbers"]);
  expect(r.code, show(r)).toBe(3);
  const block = r.stdout.split("\n");
  const start = block.findIndex((l) => /^failed\s+numbers\s/.test(l));
  const end = block.findIndex((l, i) => i > start && /^(done|interrupted) /.test(l));
  expect(start, show(r)).toBeGreaterThanOrEqual(0);
  const sampleLines = block.slice(start + 1, end).filter((l) => l.includes("n=3"));
  expect(sampleLines.length, show(r)).toBeGreaterThan(0);
  for (const l of sampleLines) expect(l, show(r)).toMatch(/^ {9,}/);
}, 60_000);

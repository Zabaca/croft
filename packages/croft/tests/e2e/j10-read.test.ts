// Journey 10: an app reads project data with `import { query } from "@zabaca/croft/read"` (DESIGN §5), from a
// Node script (when node is installed) and from Bun, in the project after a run. Rows must match what
// `croft query --json` shows, value for value: HUGEINT and DECIMAL as strings, timestamps with the project
// offset, JSON columns as parsed values. The helper ships as built JavaScript (dist/read.js), so the package's
// build:read script runs first, as it would before publishing (dist/ is git-ignored).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cleanupAll, initProject, PKG, type Project, rawJson, type MockApi, mockApi, show } from "./harness.ts";

const NODE = Bun.which("node");
let api: MockApi;
let built: { code: number | null; out: string };

beforeAll(() => {
  api = mockApi();
  const r = spawnSync(process.execPath, [join(PKG, "scripts", "build-read.ts")], { cwd: PKG, encoding: "utf8" });
  built = { code: r.status, out: `${r.stdout}${r.stderr}` };
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const READER = `// An app script: read croft data the way the skill says apps must.
import { query } from "@zabaca/croft/read";

const out = {};
for (const [name, sql] of JSON.parse(process.argv[2])) {
  out[name] = await query(sql, [], { limit: 5000 });
}
try {
  await query("delete from example_sales");
  out.refused = null;
} catch (e) {
  out.refused = e.code;
}
process.stdout.write(JSON.stringify(out));
`;

const QUERIES: [string, string][] = [
  ["sales", "select * from example_sales order by order_id"],
  ["events", "select * from events order by id"],
  ["money", "select * from money order by id"],
  ["agg", "select region, count(*) n, sum(amount) total, min(order_date) first_day from example_sales group by region order by region"],
];

let project: Project;

async function setup(): Promise<void> {
  api.route("/events", () => rawJson(`[
    {"id": 1, "big": 12345678901234567890, "ratio": 0.1, "at": "2026-09-20T10:00:00Z", "local": "2026-09-20T10:00:00", "day": "2026-09-20", "payload": {"a": 1, "b": [1, 2]}, "ok": true, "note": null},
    {"id": 2, "big": 9007199254740993, "ratio": 2.5, "at": "2026-09-21T23:30:00+02:00", "local": "2026-09-21T08:15:30.5", "day": "2026-09-21", "payload": {"a": "x"}, "ok": false, "note": "héllo"}
  ]`));
  const { project: p } = await initProject();
  project = p;
  p.write("assets/events.ts", `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${api.url}/events")).json<Record<string, unknown>[]>();
  },
});
`);
  p.write("files/money.csv", `id,price,when\n1,"$1,234.50",03/25/2026\n2,$0.99,04/01/2026\n3,"$10,000.00",12/31/2025\n`);
  p.write("assets/money.ts", `import { ingest } from "@zabaca/croft";
export default ingest({ file: "files/money.csv", key: "id" });
`);
  const r = await p.json(["run"]);
  if (r.code !== 0) throw new Error(`run failed\n${show(r)}`);
}

async function croftRows(sql: string): Promise<unknown[]> {
  const r = await project.json(["query", sql, "--limit", "5000"]);
  if (r.code !== 0) throw new Error(show(r));
  return r.json.data.rows as unknown[];
}

function runReader(runtime: string): { code: number | null; stdout: string; stderr: string } {
  project.write("app/read-check.mjs", READER);
  const r = spawnSync(runtime, [join(project.root, "app", "read-check.mjs"), JSON.stringify(QUERIES)], {
    cwd: project.root, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" }, timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("journey 10: @zabaca/croft/read", () => {
  test("build:read builds dist/read.js", async () => {
    expect(built.code, built.out).toBe(0);
    await setup();
    const types = await project.json(["query", "describe events"]);
    const t = Object.fromEntries(types.json.data.rows.map((r: { column_name: string; column_type: string }) => [r.column_name, r.column_type]));
    expect(t).toMatchObject({ big: "HUGEINT", ratio: "DOUBLE", at: "TIMESTAMP WITH TIME ZONE", local: "TIMESTAMP", day: "DATE", payload: "JSON", ok: "BOOLEAN" });
    const m = await project.json(["query", "describe money"]);
    const mt = Object.fromEntries(m.json.data.rows.map((r: { column_name: string; column_type: string }) => [r.column_name, r.column_type]));
    expect(mt.price).toMatch(/^DECIMAL\(18,\s?2\)$/);
    expect(mt.when).toBe("DATE");
  }, 120_000);

  test("from Bun: rows match croft query --json", async () => {
    const r = runReader(process.execPath);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    const got = JSON.parse(r.stdout);
    for (const [name, sql] of QUERIES) expect(got[name], name).toEqual(await croftRows(sql));
    expect(got.sales).toHaveLength(120);
    expect(got.events[0]).toMatchObject({ big: "12345678901234567890", payload: { a: 1, b: [1, 2] } });
    expect(got.events[1].big).toBe("9007199254740993");
    expect(got.money[0].price).toBe("1234.50");
    expect(got.refused).toBe("QUERY_NOT_SELECT");
  }, 120_000);

  test.skipIf(!NODE)(`from Node (${NODE ?? "not installed"}): rows match croft query --json`, async () => {
    const r = runReader(NODE!);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    const got = JSON.parse(r.stdout);
    for (const [name, sql] of QUERIES) expect(got[name], name).toEqual(await croftRows(sql));
    expect(got.events[0].big).toBe("12345678901234567890");
    expect(got.refused).toBe("QUERY_NOT_SELECT");
  }, 120_000);
});

// Journey 39: moving an existing project into a lake (DESIGN.md D155 to D161; option 07, slice 4), on the lake of the job that runs it. It runs only
// when the journeys are run on a lake (CROFT_E2E_LAKE=local or postgres; the two lake jobs of ci.yml): it moves a real-sized project (thousands of
// rows, several assets of every kind, a trash with versions, a run history), and the jobs that run every test on every platform have no time to spare.
//
// The project is a file project whose croft.json already names the lake, with "enabled": false. The real croft CLI throughout:
//   a. before: what a person can see of the project (rows, bookkeeping, status, the plan of the next run, the file's bytes);
//   b. croft move-to-lake off a terminal changes nothing and asks (exit 5, a token); the impact says what moves, what stays and what does not come
//      along, and the way back; the file, the lake and croft.json are as they were (acceptance 3);
//   c. croft confirm: the project is in the lake; every table, row and bookkeeping row equal, status the same, the next run does what it would have
//      done on the file, the file is byte for byte unchanged (acceptance 1 and 2), and the move is refused a second time (acceptance 3);
//   d. the lake works as any lake: a run merges, the trash of the file's days restores into the lake, a backup covers it;
//   e. going back is "lake.enabled": false: the file is exactly as it was, and status reads it again;
//   f. the refusals, each with its fix: a lake that holds tables, a column a lake cannot store, server mode, a croft serve that is running;
//   g. a kill -9 at each point of the move leaves the project on the file, and the next move finishes it without copying twice.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { golden } from "../golden/kit.ts";
import { localLakeBlock } from "../../src/db/lake-testkit.ts";
import { at as stamp, githubAsset, githubRoute, issue, TOKEN } from "./fixtures.ts";
import { cleanupAll, type Envelope, initProject, LAKE, lakeRig, type MockApi, mockApi, type Project, show } from "./harness.ts";

afterAll(cleanupAll);

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A SQL asset of every column type a lake stores (300 rows), deterministic so that a second run changes nothing. */
const KITCHEN = `-- description: one column of every type a lake stores
-- key: id
SELECT range AS id,
  (range * 7 % 128 - 64)::TINYINT AS t8, (range * 31)::SMALLINT AS t16, (range * 100003)::INTEGER AS t32, (range * 10000000019)::BIGINT AS t64,
  (range::HUGEINT * 1000000007)::DECIMAL(38, 0) AS t128, (range * 12345678901234567890123)::DECIMAL(38, 0) AS d0, CAST(TIMETZ '10:11:12.345678+02' AS VARCHAR) AS tt, (range % 200)::UTINYINT AS u8, (range * 3)::UBIGINT AS u64,
  (range / 7.0)::FLOAT AS f32, (range / 3.0)::DOUBLE AS f64, (range / 7.0)::DECIMAL(18, 3) AS d18, (range * 12345678901.123456789)::DECIMAL(38, 10) AS d38,
  'name ' || range || ' ünïcode' AS s, encode('blob' || range) AS b, DATE '2026-01-01' + range::INTEGER AS dt, TIME '10:11:12.345678' AS tm,
  TIMESTAMP '2026-01-02 03:04:05.123456' + INTERVAL (range) MINUTE AS ts, TIMESTAMPTZ '2026-01-02 03:04:05.123456+00' + INTERVAL (range) HOUR AS tz,
  CAST(INTERVAL (range) DAY + INTERVAL (range * 1003) MICROSECOND AS VARCHAR) AS iv, CAST(md5(range::VARCHAR) AS UUID) AS u, ('{"n": ' || range || ', "tags": ["a", "b"]}')::JSON AS j,
  [range, range + 1, NULL] AS lst, {'a': range, 'b': 'x' || range} AS st, map {'k' || (range % 5): range} AS mp, range % 3 = 0 AS flag,
  CASE WHEN range % 4 = 0 THEN NULL ELSE range END AS maybe
FROM range(300)
`;

const ordersAsset = (base: string) => `import { ingest } from "@zabaca/croft";
export default ingest({
  description: "orders from the shop's API, paged by 2000",
  key: "id",
  incremental: "updated_at",
  async *rows({ since, http }) {
    for (let page = 0; ; page++) {
      const res = await http.get("${base}/orders", { query: { since, page } });
      const body = res.json<{ rows: Record<string, unknown>[]; more: boolean }>();
      yield body.rows;
      if (!body.more) return;
    }
  },
});
`;

interface Order { id: number; customer: string; amount: number; status: string; updated_at: string; meta: { n: number; tags: string[] } }
const order = (id: number, minute = id): Order => ({
  id, customer: `customer ${id % 97}`, amount: Math.round(id * 1.37 * 100) / 100, status: id % 5 === 0 ? "refunded" : "paid",
  updated_at: new Date(Date.UTC(2026, 5, 1, 0, 0, 0) + minute * 60_000).toISOString(), meta: { n: id, tags: ["a", id % 2 ? "odd" : "even"] },
});

function ordersRoute(api: MockApi, state: { orders: Order[] }): void {
  api.route("/orders", (_req, url) => {
    const since = url.searchParams.get("since");
    const page = Number(url.searchParams.get("page") ?? 0);
    const rows = [...state.orders].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id)
      .filter((r) => since === null || Date.parse(r.updated_at) >= Date.parse(since));
    return new Response(JSON.stringify({ rows: rows.slice(page * 2000, page * 2000 + 2000), more: rows.length > (page + 1) * 2000 }), { headers: { "content-type": "application/json" } });
  });
}

const TRANSFORM = `import { transform } from "@zabaca/croft";
type Order = { id: number; amount: number };
export default transform({
  description: "a size bucket for every order, computed in TypeScript",
  inputs: ["orders"],
  key: "order_id",
  incremental: true,
  async *rows({ newRows }) {
    for await (const o of newRows<Order>("orders")) yield { order_id: o.id, bucket: Number(o.amount) > 4000 ? "large" : "small" };
  },
});
`;

if (!LAKE) {
  test.skip("journey 39 runs on a lake: CROFT_E2E_LAKE=local or postgres (the lake jobs of ci.yml)", () => {});
} else {
  /** The croft.json of a project that names its lake and is not in it: "enabled": false (the lake is the job's own kind). */
  const idleLake = async (p: Project): Promise<void> => {
    const cfg = JSON.parse(p.read("croft.json")) as Record<string, any>;
    const block = LAKE === "local" ? localLakeBlock() : cfg.lake;
    cfg.lake = { enabled: false, ...block };
    p.write("croft.json", `${JSON.stringify(cfg, null, 2)}\n`);
  };
  const config = (p: Project): Record<string, any> => JSON.parse(p.read("croft.json"));
  const warehouse = (p: Project): string => join(p.root, "warehouse.duckdb");
  /** Everything a person can read of the project through croft: every table in order, every bookkeeping table, by key. */
  const readAll = async (p: Project): Promise<Record<string, unknown>> => {
    const tables = (await p.rows("select table_name from duckdb_tables() where schema_name = 'main' order by 1")).map((r) => r.table_name as string);
    const out: Record<string, unknown> = {};
    for (const t of tables) out[t] = await p.rows(`select * from "${t}" order by all`);
    out["_croft.assets"] = await p.rows("select * from _croft.assets order by name");
    out["_croft.columns"] = await p.rows("select * from _croft.columns order by asset, name");
    out["_croft.inputs"] = await p.rows("select * from _croft.inputs order by asset, input");
    out["_croft.files"] = await p.rows("select * from _croft.files order by asset, path");
    out["_croft.writes"] = await p.rows("select * from _croft.writes order by asset, loaded_at");
    return out;
  };
  /** `status --json`'s data without the words that name where the warehouse is, and without each asset's last run (the run history is the
   *  project's own and not the warehouse's: runs made in the lake are runs). */
  const statusOf = async (p: Project): Promise<unknown> => {
    const r = await p.json(["status"]);
    expect(r.code, show(r)).toBe(0);
    const { lake: _l, lakeMove: _m, serverMode: _s, ...rest } = r.json.data;
    const data = JSON.parse(JSON.stringify(rest));
    for (const a of data.assets ?? []) delete a.lastRun;
    return data;
  };
  const planOf = async (p: Project): Promise<unknown> => {
    const r = await p.json(["run", "--dry-run"]);
    expect(r.code, show(r)).toBe(0);
    return r.json.data.steps.map((s: Envelope) => ({ asset: s.asset, status: s.status, reason: s.reason }));
  };
  const confirmed = async (p: Project, args: string[]): Promise<Envelope> => {
    const asked = await p.json(args);
    expect(asked.code, show(asked)).toBe(5);
    const done = await p.json(["confirm", asked.json.confirmation.token]);
    expect(done.code, show(done)).toBe(0);
    return done.json;
  };

  describe(`journey 39 (${LAKE} lake): moving a project into a lake`, () => {
    let api: MockApi;
    const orders = { orders: Array.from({ length: 5000 }, (_, i) => order(i + 1)) };
    const issues = { issues: [1, 2, 3, 4, 5, 6, 7].map((id) => issue(id, id)), limited: 0 };
    let p: Project;

    /** Before the move, everything a person can see. */
    const before: { rows?: Record<string, unknown>; status?: unknown; plan?: unknown; fileSha?: string; trash?: string[]; config?: string } = {};

    beforeAll(async () => {
      api = mockApi();
      ordersRoute(api, orders);
      githubRoute(api, issues);
      p = (await initProject("movable")).project;
      await idleLake(p);
      p.write("assets/orders.ts", ordersAsset(api.url));
      p.write("assets/github_issues.ts", githubAsset(api.url));
      p.secret("GITHUB_TOKEN", TOKEN);
      p.write("assets/order_totals.ts", TRANSFORM);
      p.write("assets/kitchen.sql", KITCHEN);
      p.write("assets/by_status.sql", "-- description: orders by status\n-- key: status\nSELECT status, count(*) AS n, sum(amount) AS amount FROM orders GROUP BY status\n");
      // A run history: the first build, an API that grew, a table deleted and brought back, rows deleted from another.
      for (let i = 0; i < 3; i++) {
        const r = await p.json(["run"]);
        expect(r.code, show(r)).toBe(0);
        if (i === 0) {
          orders.orders.push(...Array.from({ length: 1500 }, (_, k) => order(5001 + k)));
          orders.orders[10] = { ...order(11, 7000), status: "disputed" };
        }
      }
      await confirmed(p, ["delete", "kitchen"]);
      await confirmed(p, ["restore", "kitchen"]);
      await confirmed(p, ["delete", "github_issues", "--where", "id > 5"]);
      expect((await p.json(["run"])).code).toBe(0);
    }, 600_000);

    afterAll(() => api?.stop());

    test("a. the project before: thousands of rows, assets of every kind, a trash and a run history, on the file", async () => {
      const counts = Object.fromEntries((await p.rows("select name, row_count::INT as n from _croft.assets order by name")).map((r) => [r.name, r.n]));
      expect(counts).toMatchObject({ orders: 6500, kitchen: 300, example_sales: 120, github_issues: expect.any(Number) });
      expect(existsSync(warehouse(p))).toBe(true);
      expect(config(p).lake.enabled).toBe(false);
      const versions = readdirSync(join(p.stateDir, "trash"), { recursive: true }).filter((f) => String(f).endsWith(".duckdb"));
      expect(versions.length).toBeGreaterThanOrEqual(2);
      const runs = await p.json(["logs", "--runs"]);
      expect(runs.code, show(runs)).toBe(0);
      before.rows = await readAll(p);
      before.status = await statusOf(p);
      before.plan = await planOf(p);
      before.fileSha = sha(warehouse(p));
      before.trash = readdirSync(join(p.stateDir, "trash"), { recursive: true }).map(String).sort();
      before.config = p.read("croft.json");
      // The lake the block names has never been written.
      expect(existsSync(join(p.root, "lake"))).toBe(false);
    }, 300_000);

    test("b. without croft confirm nothing is written: the question says what moves, what stays, what does not come along, and the way back", async () => {
      const r = await p.croft(["move-to-lake", "--json"]);
      const env = golden("move-to-lake", r, { exit: 5 });
      expect(env.data).toMatchObject({ status: "needs_confirmation", mode: "copy", switched: false, backup: null, file: null, verified: null });
      expect(env.data.tables.map((t: { name: string }) => t.name)).toEqual(["by_status", "example_sales", "github_issues", "kitchen", "order_totals", "orders"]);
      expect(env.data.rows).toBeGreaterThan(7000);
      expect(env.data.bookkeeping.map((b: { table: string }) => b.table)).toEqual(["assets", "columns", "inputs", "files", "writes"]);
      expect(env.confirmation).toMatchObject({ command: "croft move-to-lake", impact: { asset: "the warehouse", action: expect.stringContaining("move into the lake") } });
      const text = env.problems[0].message + env.problems[0].hint;
      expect(text).toContain("not one byte changed");
      expect(text).toContain('"lake.enabled" to false');
      expect(text).toContain("what is written in the lake after the move is not carried back");
      expect(text).toContain("time travel");
      expect(env.problems[0]).toMatchObject({ code: "CONFIRMATION_REQUIRED", effect: "nothing was changed" });
      // Human words on a terminal-less run too.
      const human = await p.croft(["move-to-lake"]);
      expect(human.code, show(human)).toBe(5);
      expect(human.stdout).toContain("needs confirmation: move the warehouse into the lake");
      // Nothing changed: the file, croft.json, the trash, and the lake was not made.
      expect(sha(warehouse(p))).toBe(before.fileSha!);
      expect(p.read("croft.json")).toBe(before.config!);
      expect(existsSync(join(p.root, "lake"))).toBe(false);
      expect(existsSync(join(p.stateDir, "backups")) ? readdirSync(join(p.stateDir, "backups")).length : 0).toBe(0);
    }, 300_000);

    let moved: Envelope;
    test("c. croft confirm moves it: proved equal, switched, the file untouched", async () => {
      const asked = await p.json(["move-to-lake"]);
      expect(asked.code, show(asked)).toBe(5);
      const done = await p.croft(["confirm", asked.json.confirmation.token, "--json"]);
      expect(done.code, show(done)).toBe(0);
      moved = JSON.parse(done.stdout);
      expect(moved.data.outcome).toBe("used");
      const data = moved.data.result;
      expect(data).toMatchObject({ status: "moved", mode: "copy", switched: true, file: { unchanged: true }, verified: { tables: 6 } });
      expect(data.verified.rows).toBe(data.rows);
      expect(data.backup.path).toContain(join(".croft", "backups"));
      // The file: byte for byte, and the backup holds the same bytes.
      expect(sha(warehouse(p))).toBe(before.fileSha!);
      expect(data.file.sha256).toBe(before.fileSha!);
      expect(sha(join(data.backup.path, "warehouse.duckdb"))).toBe(before.fileSha!);
      expect(existsSync(join(data.backup.path, "runs.sqlite"))).toBe(true);
      // croft.json: one token changed.
      expect(p.read("croft.json")).toBe(before.config!.replace('"enabled": false', '"enabled": true'));
      expect(config(p).lake.enabled).toBe(true);
      // The trash did not move.
      expect(readdirSync(join(p.stateDir, "trash"), { recursive: true }).map(String).sort()).toEqual(before.trash!);
    }, 600_000);

    test("c. every table, row and bookkeeping row is equal, status shows the same staleness, and the next run does what it would have done on the file (acceptance 1)", async () => {
      expect(await readAll(p)).toEqual(before.rows!);
      expect(await statusOf(p)).toEqual(before.status!);
      expect(await planOf(p)).toEqual(before.plan!);
      const meta = Object.fromEntries((await p.rows("select key, value from _croft.meta")).map((r) => [r.key, r.value]));
      expect(meta).toMatchObject({ format_version: "4", bookkeeping: "log", moved_into_lake: expect.any(String) });
      const status = await p.json(["status"]);
      expect(status.json.database).toMatch(/^lake /);
    }, 300_000);


    test("c. a second move is refused: the project is in the lake", async () => {
      const again = await p.json(["move-to-lake"]);
      expect(again.code, show(again)).toBe(2);
      expect(again.json.problems[0]).toMatchObject({ code: "MOVE_NEEDS_LAKE", details: { reason: "already_in_lake" }, effect: "nothing was changed" });
    });

    let lakeDays: Record<string, unknown>;
    test("d. the lake works as a lake: the next run does what it would have done on the file, and the file's trash restores into it", async () => {
      orders.orders.push(...Array.from({ length: 300 }, (_, k) => order(6501 + k, 8000 + k)));
      orders.orders[20] = { ...order(21, 9000), status: "disputed", amount: 1.5 };
      const r = await p.json(["run"]);
      expect(r.code, show(r)).toBe(0);
      const steps = Object.fromEntries(r.json.data.steps.map((s: Envelope) => [s.asset, s]));
      expect(steps.orders.rows).toMatchObject({ added: 300, updated: 1 });
      expect(steps.order_totals.rows).toMatchObject({ added: 300 });
      // As on the file: the ingests run, what reads the new orders is rebuilt, and the SQL table nothing changed under is left alone.
      expect(Object.keys(steps).sort()).toEqual(["by_status", "example_sales", "github_issues", "order_totals", "orders"]);
      expect(steps.example_sales.status).toBe("unchanged");
      expect(r.json.problems.map((x: { code: string }) => x.code)).not.toContain("OUT_OF_BAND_CHANGE");
      const again = await p.json(["run"]);
      expect(again.code, show(again)).toBe(0);
      expect(again.json.data.steps.map((s: Envelope) => [s.asset, s.status, s.rows.added, s.rows.updated]), show(again)).toEqual(again.json.data.steps.map((s: Envelope) => [s.asset, s.status, 0, 0]));
      // The trash of the file's days works in the lake: a whole table (kitchen) and the rows a delete --where removed (github_issues).
      const k = await confirmed(p, ["restore", "kitchen"]);
      expect(k.data.result.status).toBe("restored");
      expect(await p.rows('select * from "kitchen" order by all')).toEqual(before.rows!.kitchen as Record<string, unknown>[]);
      const gi = await confirmed(p, ["restore", "github_issues"]);
      expect(["restored"]).toContain(gi.data.result.status);
      // A backup of the lake, and the maintenance plan, work on what the move made.
      const backup = await p.json(["backup"]);
      expect(backup.code, show(backup)).toBe(0);
      expect(backup.json.data.lake).toMatchObject({ kind: LAKE });
      const plan = await p.json(["maintain", "--dry-run"]);
      expect(plan.code, show(plan)).toBe(0);
      expect(plan.json.data.status).toBe("planned");
      lakeDays = await readAll(p);
      expect((lakeDays.orders as unknown[]).length).toBe(6800);
    }, 600_000);

    test("e. going back is the setting: the file is exactly as it was, status and the plan read it again, and the lake keeps its days", async () => {
      p.edit("croft.json", '"enabled": true', '"enabled": false');
      expect(sha(warehouse(p))).toBe(before.fileSha!);
      expect(await readAll(p)).toEqual(before.rows!);
      expect(await statusOf(p)).toEqual(before.status!);
      expect(await planOf(p)).toEqual(before.plan!);
      // The file works again: a run on it does what it would have done before the move (the 300 new orders are the lake's, so it fetches them).
      const r = await p.json(["run", "orders"]);
      expect(r.code, show(r)).toBe(0);
      expect(r.json.data.steps[0].rows).toMatchObject({ added: 300, updated: 1 });
      expect(sha(warehouse(p))).not.toBe(before.fileSha!);
    }, 600_000);

    test("f. back on the file, a move into the lake that has been written since is refused: nothing is merged and nothing is overwritten", async () => {
      // The lake holds the copy of the move and the days since; the file has moved on too. The lake is not empty, so the move is refused.
      const asked = await p.json(["move-to-lake"]);
      expect(asked.code, show(asked)).toBe(2);
      expect(asked.json.problems[0]).toMatchObject({ code: "MOVE_LAKE_NOT_EMPTY", effect: "nothing was changed" });
      expect(asked.json.problems[0].message).toMatch(/written since|not this one/);
    }, 300_000);
  });

  // ---- Small projects, for what can go wrong ----------------------------------------------------------------------------------------------

  /** A file project with its lake named and switched off, and the example built (120 rows). */
  const small = async (name: string, o: { assets?: Record<string, string>; run?: boolean; config?: (c: Record<string, any>) => void } = {}): Promise<Project> => {
    const { project: q } = await initProject(name);
    await idleLake(q);
    for (const [file, text] of Object.entries(o.assets ?? {})) q.write(`assets/${file}`, text);
    if (o.run !== false) {
      const r = await q.json(["run"]);
      expect(r.code, show(r)).toBe(0);
    }
    // The settings that stop a move are set once the project has been built.
    if (o.config) {
      const cfg = config(q);
      o.config(cfg);
      q.write("croft.json", `${JSON.stringify(cfg, null, 2)}\n`);
    }
    return q;
  };
  const enabled = (q: Project): boolean => config(q).lake.enabled;
  const moveAndConfirm = async (q: Project, env: Record<string, string> = {}): Promise<Awaited<ReturnType<Project["croft"]>>> => {
    const asked = await q.json(["move-to-lake"]);
    expect(asked.code, show(asked)).toBe(5);
    return q.croft(["confirm", asked.json.confirmation.token, "--json"], { env });
  };

  describe(`journey 39 (${LAKE} lake): what stops a move, each with its fix`, () => {
    test("a. columns a lake cannot store, and values it would store inexactly, are found before anything starts, table by table, and the fixes work", async () => {
      const q = await small("types", {
        assets: {
          "mood.sql": "-- description: an enum\n-- key: id\nSELECT 1 AS id, CAST('a' AS ENUM('a', 'b')) AS e\n",
          "pair.sql": "-- description: a fixed-size array and bits\n-- key: id\nSELECT 1 AS id, [1, 2]::INTEGER[2] AS pair, '1010'::BIT AS bits\n",
          "big.sql": "-- description: past 2^53\n-- key: id\nSELECT range AS id, range::HUGEINT * 9007199254740993 AS huge, 1 AS small FROM range(5)\n",
          "gap.sql": "-- description: microseconds, an offset\n-- key: id\nSELECT 1 AS id, (TIMESTAMP '2026-01-02 00:00:01.000003' - TIMESTAMP '2026-01-01') AS gap, TIMETZ '10:11:12+02' AS tzt\n",
        },
      });
      const sha0 = sha(warehouse(q));
      const cfg0 = q.read("croft.json");
      const first = await q.json(["move-to-lake"]);
      expect(first.code, show(first)).toBe(1);
      const p1 = first.json.problems[0];
      expect(p1).toMatchObject({ code: "LAKE_TYPE_UNSUPPORTED", effect: expect.stringContaining("nothing was changed") });
      expect(p1.details.tables.map((t: { table: string }) => t.table)).toEqual(["mood", "pair"]);
      expect(p1.hint).toContain("CAST(e AS VARCHAR) AS e");
      expect(p1.hint).toContain("CAST(pair AS INTEGER[]) AS pair");
      expect(p1.hint).toContain("CAST(bits AS VARCHAR) AS bits");
      expect(p1.hint).toContain("assets/mood.sql");
      // Nothing was touched: the file, croft.json, no backup, no lake.
      expect(sha(warehouse(q))).toBe(sha0);
      expect(q.read("croft.json")).toBe(cfg0);
      expect(existsSync(join(q.stateDir, "backups"))).toBe(false);
      // Fixed in the SELECT and run again (a SQL asset is rebuilt at no cost): the next refusal is the values a lake would change.
      q.write("assets/mood.sql", "-- description: an enum\n-- key: id\nSELECT 1 AS id, CAST(CAST('a' AS ENUM('a', 'b')) AS VARCHAR) AS e\n");
      q.write("assets/pair.sql", "-- description: a list and text\n-- key: id\nSELECT 1 AS id, [1, 2] AS pair, '1010' AS bits\n");
      expect((await q.json(["run", "mood", "pair"])).code).toBe(0);
      const second = await q.json(["move-to-lake"]);
      expect(second.code, show(second)).toBe(2);
      const p2 = second.json.problems[0];
      expect(p2).toMatchObject({ code: "LAKE_VALUES_INEXACT", effect: expect.stringContaining("nothing was changed") });
      expect(p2.details.columns.map((c: { table: string; column: string; kind?: string }) => `${c.table}.${c.column}`)).toEqual(["big.huge", "gap.gap", "gap.tzt"]);
      expect(p2.details.columns[0]).toMatchObject({ values: 4, example: expect.stringMatching(/^\d{16,}$/) });
      expect(p2.hint).toContain("CAST(huge AS DECIMAL(38,0)) AS huge");
      // The fixes the message gives, applied: the move goes through, and the proof holds the exact values.
      q.write("assets/big.sql", "-- description: past 2^53, exact\n-- key: id\nSELECT range AS id, CAST(range::HUGEINT * 9007199254740993 AS DECIMAL(38, 0)) AS huge, 1 AS small FROM range(5)\n");
      q.write("assets/gap.sql", "-- description: microseconds and an offset, as text\n-- key: id\nSELECT 1 AS id, CAST(TIMESTAMP '2026-01-02 00:00:01.000003' - TIMESTAMP '2026-01-01' AS VARCHAR) AS gap, CAST(TIMETZ '10:11:12+02' AS VARCHAR) AS tzt\n");
      expect((await q.json(["run", "big", "gap"])).code).toBe(0);
      const rows = await q.rows("select * from big order by id");
      const done = await moveAndConfirm(q);
      expect(done.code, show(done)).toBe(0);
      expect(JSON.parse(done.stdout).data.result.status).toBe("moved");
      expect(await q.rows("select * from big order by id")).toEqual(rows);
      expect((await q.rows("select huge::VARCHAR as h from big where id = 4"))[0]).toEqual({ h: "36028797018963972" });
    }, 600_000);

    test("a2. a trashed version with a column a lake would store inexactly is named in the question, and is refused on restore, not changed", async () => {
      const q = await small("trashy", { assets: { "h.sql": "-- description: a HUGEINT\n-- key: id\nSELECT range AS id, range::HUGEINT AS v FROM range(3)\n" } });
      await confirmed(q, ["delete", "h"]);
      q.write("assets/h.sql", "-- description: an integer\n-- key: id\nSELECT range AS id, range::INTEGER AS v FROM range(3)\n");
      expect((await q.json(["run", "h"])).code).toBe(0);
      const asked = await q.json(["move-to-lake"]);
      expect(asked.code, show(asked)).toBe(5);
      expect(asked.json.data.trash.cannotRestore).toEqual([expect.objectContaining({ asset: "h", columns: ["v"] })]);
      expect(asked.json.problems[0].hint).toContain("would store inexactly");
      const done = await q.croft(["confirm", asked.json.confirmation.token, "--json"]);
      expect(done.code, show(done)).toBe(0);
      const restore = await q.json(["restore", "h"]);
      expect(restore.code, show(restore)).not.toBe(0);
      expect(restore.json.problems[0]).toMatchObject({ code: "LAKE_VALUES_INEXACT" });
      expect((await q.rows("select count(*)::INT as n from h"))[0]).toEqual({ n: 3 });
    }, 300_000);

    test("b. a lake that holds anything is refused, and so is one that holds the copy of another file", async () => {
      const a = await small("lake-a");
      const done = await moveAndConfirm(a);
      expect(done.code, show(done)).toBe(0);
      // b points at a's lake: it holds a's copy, which is the copy of another file.
      const b = await small("lake-b", {
        config: (cfg) => {
          cfg.lake = { ...config(a).lake, enabled: false };
          if (LAKE === "local") cfg.lake = { enabled: false, catalog: { kind: "sqlite", path: join(a.root, "lake", "catalog.sqlite") }, dataPath: join(a.root, "lake", "data") };
        },
      });
      const sha0 = sha(warehouse(b));
      const cfg0 = b.read("croft.json");
      const r = await b.json(["move-to-lake"]);
      expect(r.code, show(r)).toBe(2);
      expect(r.json.problems[0]).toMatchObject({ code: "MOVE_LAKE_NOT_EMPTY", effect: "nothing was changed" });
      expect(r.json.problems[0].message).toContain("a copy that a move made");
      expect(r.json.problems[0].message).toContain("not this one");
      expect(sha(warehouse(b))).toBe(sha0);
      expect(b.read("croft.json")).toBe(cfg0);
      // Written since: a's lake gets a run, and the lake holds tables a move did not make as they were.
      a.write("assets/more.sql", "-- description: more\n-- key: id\nSELECT range AS id FROM range(10)\n");
      expect((await a.json(["run", "more"])).code).toBe(0);
      const again = await b.json(["move-to-lake"]);
      expect(again.code, show(again)).toBe(2);
      expect(again.json.problems[0].message).toContain("written since");
      expect(again.json.problems[0].hint).toContain("name a new catalog database and bucket folder");
    }, 600_000);

    test("c. server mode on keeps its keys and settings: the move is refused until server mode over a lake exists", async () => {
      const q = await small("server", { config: (cfg) => { cfg.serverMode = { enabled: true }; cfg.serve = { sharedTables: ["example_sales"] }; } });
      const cfg0 = q.read("croft.json");
      const sha0 = sha(warehouse(q));
      const r = await q.json(["move-to-lake"]);
      expect(r.code, show(r)).toBe(2);
      expect(r.json.problems[0]).toMatchObject({ code: "MOVE_BLOCKED", effect: "nothing was changed" });
      expect(r.json.problems[0].message).toContain("server mode");
      expect(r.json.problems[0].hint).toContain("its keys and settings stay as they are");
      expect(q.read("croft.json")).toBe(cfg0);
      expect(sha(warehouse(q))).toBe(sha0);
    }, 300_000);

    test("d. a croft serve that is running, and a croft.json that cannot be rewritten, stop it before anything is touched", async () => {
      const q = await small("serving");
      const cfg0 = q.read("croft.json");
      q.write(".croft/serve.json", JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 7447, token: "t" }));
      const r = await q.json(["move-to-lake"]);
      expect(r.code, show(r)).toBe(2);
      expect(r.json.problems[0]).toMatchObject({ code: "MOVE_BLOCKED" });
      expect(r.json.problems[0].message).toContain("croft serve is running");
      q.remove(".croft/serve.json");
      expect(q.read("croft.json")).toBe(cfg0);
      // A croft.json croft cannot rewrite would fail the move at its last step, so it is said before the first.
      if (process.getuid?.() !== 0) {
        chmodSync(join(q.root, "croft.json"), 0o444);
        const ro = await q.json(["move-to-lake"]);
        chmodSync(join(q.root, "croft.json"), 0o644);
        expect(ro.code, show(ro)).toBe(2);
        expect(ro.json.problems[0].message).toContain("cannot rewrite croft.json");
      }
    }, 300_000);

    test("e. a file that is written while it is being moved is noticed: the copy is taken out of the lake, and nothing is switched", async () => {
      const q = await small("touched");
      const sha0 = sha(warehouse(q));
      const cfg0 = q.read("croft.json");
      const done = await moveAndConfirm(q, { CROFT_FAULT: "move_touch_file" });
      expect(done.code, show(done)).toBe(1);
      const out = JSON.parse(done.stdout);
      expect(out.problems[0]).toMatchObject({ code: "MOVE_FILE_CHANGED", effect: expect.stringContaining("still keeps its warehouse in the file") });
      expect(out.problems[0].details.undone).toBe(true);
      expect(q.read("croft.json")).toBe(cfg0);
      expect(sha(warehouse(q))).not.toBe(sha0); // the test itself wrote it, as the something else
    }, 300_000);
  });

  describe(`journey 39 (${LAKE} lake): a kill -9 at each point of the move`, () => {
    for (const point of ["move_after_backup", "move_after_copy", "move_before_switch", "move_after_switch"] as const) {
      test(`${point}: the project is on the file or in the lake, never between, and the next move finishes it without copying twice`, async () => {
        const q = await small(`kill-${point}`);
        const sha0 = sha(warehouse(q));
        const rowsBefore = await readAll(q);
        const killed = await moveAndConfirm(q, { CROFT_FAULT: point });
        expect(killed.signal === "SIGKILL" || killed.code === 137, show(killed)).toBe(true); // killed, as a crash would
        expect(sha(warehouse(q))).toBe(sha0);
        if (point === "move_after_switch") {
          // The switch was the last step: the project is in the lake, equal to the file.
          expect(enabled(q)).toBe(true);
          expect(await readAll(q)).toEqual(rowsBefore);
          const again = await q.json(["move-to-lake"]);
          expect(again.json.problems[0]).toMatchObject({ code: "MOVE_NEEDS_LAKE", details: { reason: "already_in_lake" } });
          return;
        }
        expect(enabled(q)).toBe(false);
        // The next move: the lake holds nothing after the backup, and the whole copy after the copy.
        const next = await q.json(["move-to-lake"]);
        expect(next.code, show(next)).toBe(5);
        expect(next.json.data.mode).toBe(point === "move_after_backup" ? "copy" : "finish");
        const tag = point === "move_after_backup" ? null : "present";
        const done = await q.json(["confirm", next.json.confirmation.token]);
        expect(done.code, show(done)).toBe(0);
        expect(done.json.data.result).toMatchObject({ status: "moved", mode: next.json.data.mode, switched: true });
        expect(enabled(q)).toBe(true);
        expect(await readAll(q)).toEqual(rowsBefore);
        // One copy: the marker is there once, and the bookkeeping holds each row once.
        const markers = await q.rows("select key from _croft.meta where key = 'moved_into_lake'");
        expect(markers.length).toBe(1);
        expect((await q.rows("select count(*)::INT as n from _croft.assets_log"))[0]!.n).toBe((rowsBefore["_croft.assets"] as unknown[]).length);
        void tag;
      }, 600_000);
    }
  });
}

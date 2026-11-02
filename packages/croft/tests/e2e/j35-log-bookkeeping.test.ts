// Journey 35: croft's bookkeeping as an append-only log (DESIGN.md §5 "Where state lives", D-L1; option 07, slice 1). The
// journeys run on the log adapter whatever the suite's adapter is (the child croft processes are given
// CROFT_BOOKKEEPING=log), and each looks at the log itself as well as at what `_croft.<table>` reads, because the point of a
// log is how a key written twice, closed and written again, or moved, ends up:
//   a. the tables are logs, with a view over each, and the meta table says so, in format 4;
//   b. a --from after the saved cursor writes the asset twice in one transaction: the held-back cursor is the latest row;
//   c. a --rebuild deletes the asset's rows and writes them again, then sets its replaced time: the new row is the latest;
//   d. a rename moves every key once: only the new name reads, the old keys are closed in the log;
//   e. a delete closes the asset's keys, a restore writes them again after the closing rows (newest last).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupAll, type Envelope, findProblem, initProject, json, type MockApi, mockApi, type Project, show } from "./harness.ts";

let api: MockApi;
let before: string | undefined;
beforeAll(() => {
  before = process.env.CROFT_BOOKKEEPING;
  process.env.CROFT_BOOKKEEPING = "log";
  api = mockApi();
});
afterAll(async () => {
  if (before === undefined) delete process.env.CROFT_BOOKKEEPING;
  else process.env.CROFT_BOOKKEEPING = before;
  api.stop();
  await cleanupAll();
});

interface Order { id: number; status: string; amount: number; updated_at: string }
const at = (min: number) => `2026-09-20T10:${String(min).padStart(2, "0")}:00Z`;
const order = (id: number, updated_at = at(id)): Order => ({ id, status: "paid", amount: id * 10, updated_at });

const ordersAsset = (url: string) => `import { ingest } from "@zabaca/croft";

type Order = { id: number; updated_at: string };

export default ingest({
  description: "Orders from the shop API",
  key: "id",
  incremental: "updated_at",
  async *rows({ since, http }) {
    const res = await http.get("${url}", { query: { since } });
    yield res.json<Order[]>();
  },
});
`;

const TOTALS_SQL = `-- description: orders and revenue by status
-- key: status
SELECT status, count(*) AS orders, sum(amount) AS revenue FROM orders GROUP BY status
`;

interface Shop { p: Project; state: { orders: Order[] } }

async function shop(prefix: string, orders: Order[]): Promise<Shop> {
  const state = { orders };
  const path = `${prefix}/orders`;
  api.route(path, (_req, url) => {
    const since = url.searchParams.get("since");
    return json([...state.orders].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
      .filter((o) => !since || Date.parse(o.updated_at) >= Date.parse(since)));
  });
  const { project: p } = await initProject();
  p.remove("assets/example_sales.ts");
  p.write("assets/orders.ts", ordersAsset(`${api.url}${path}`));
  p.write("assets/order_totals.sql", TOTALS_SQL);
  const first = await p.json(["run"]);
  expect(first.code, show(first)).toBe(0);
  return { p, state };
}

/** The log rows of one key of `table`, oldest first. */
const logOf = (p: Project, table: string, column: string, value: string, select: string) =>
  p.rows(`SELECT ${select}, seq::INT AS seq, coalesce(closed, false) AS closed FROM _croft.${table}_log WHERE ${column} = '${value}' ORDER BY seq`);

const confirmed = async (p: Project, args: string[]): Promise<Envelope> => {
  const asked = await p.json(args);
  expect(asked.code, show(asked)).toBe(5);
  const done = await p.json(["confirm", asked.json.confirmation.token]);
  expect(done.code, show(done)).toBe(0);
  return done;
};

describe("journey 35: the bookkeeping as a log", () => {
  test("a. every keyed table is a log with a view over it, and meta says so", async () => {
    const { p } = await shop("/a", [1, 2, 3].map((id) => order(id)));
    const objects = await p.rows(`SELECT table_name AS name, 'table' AS kind FROM duckdb_tables() WHERE schema_name = '_croft'
      UNION ALL SELECT view_name, 'view' FROM duckdb_views() WHERE schema_name = '_croft' AND NOT internal ORDER BY 1`);
    expect(objects.map((o) => `${o.kind} ${o.name}`)).toEqual([
      "view assets", "table assets_log", "view columns", "table columns_log", "view files", "table files_log", "view inputs", "table inputs_log",
      "table meta", "view writes", "table writes_log",
    ]);
    expect(await p.rows(`SELECT value FROM _croft.meta WHERE key = 'bookkeeping'`)).toEqual([{ value: "log" }]);
    // Format 4, so a croft that predates the log refuses the warehouse instead of failing at its first write.
    expect(await p.rows(`SELECT value FROM _croft.meta WHERE key = 'format_version'`)).toEqual([{ value: "4" }]);
    expect((await p.rows(`SELECT name FROM _croft.assets ORDER BY name`)).map((r) => r.name)).toEqual(["order_totals", "orders"]);
    // croft's own reads (status, describe) see the view.
    const d = await p.json(["describe", "orders"]);
    expect(d.code, show(d)).toBe(0);
    expect(d.json.data).toMatchObject({ asset: "orders", rows: 3, kind: "ingest" });
    // A second run changes nothing and adds rows to the log only for what it wrote.
    const again = await p.json(["run"]);
    expect(again.code, show(again)).toBe(0);
    expect(await p.rows(`SELECT count(*)::INT AS n FROM _croft.assets`)).toEqual([{ n: 2 }]);
  }, 120_000);

  test("b. a --from after the saved cursor: written twice in one transaction, the held-back cursor is the latest row", async () => {
    const { p, state } = await shop("/b", [1, 2, 3].map((id) => order(id)));
    state.orders.push(order(7, "2026-12-05T10:00:00Z"));
    const held = await p.json(["run", "orders", "--from", "2026-12-01"]);
    expect(held.code, show(held)).toBe(0);
    expect(held.json.data.steps[0].reason).toContain(`the saved position stays at ${at(3)}`);
    expect(held.json.data.steps[0].rows).toMatchObject({ added: 1, total: 4 });
    // What reads: the held-back cursor, on the asset and on the write.
    expect(await p.rows(`SELECT cursor_value FROM _croft.assets WHERE name = 'orders'`)).toEqual([{ cursor_value: at(3) }]);
    const writes = await p.rows(`SELECT cursor_after FROM _croft.writes WHERE asset = 'orders' ORDER BY loaded_at`);
    expect(writes).toEqual([{ cursor_after: at(3) }, { cursor_after: at(3) }]);
    // What the log holds: the first run's row, the write's own row (cursor moved on), then the held-back one, in that order.
    const log = await logOf(p, "assets", "name", "orders", "cursor_value");
    expect(log.map((r) => r.cursor_value)).toEqual([at(3), "2026-12-05T10:00:00Z", at(3)]);
    expect(log.map((r) => r.closed)).toEqual([false, false, false]);
    expect(log.map((r) => r.seq)).toEqual([...log.map((r) => r.seq)].sort((a, b) => (a as number) - (b as number)));
    // The next run goes on from the held position: it fetches the rows in between (here, the one it already has).
    const next = await p.json(["run", "orders"]);
    expect(next.code, show(next)).toBe(0);
    expect(await p.rows(`SELECT cursor_value FROM _croft.assets WHERE name = 'orders'`)).toEqual([{ cursor_value: "2026-12-05T10:00:00Z" }]);
  }, 120_000);

  test("c. --rebuild: the asset's rows are closed and written again, and the replaced time is on the new row", async () => {
    const { p, state } = await shop("/c", [1, 2, 3].map((id) => order(id)));
    const loaded = String((await p.rows(`SELECT last_loaded_at::VARCHAR AS loaded FROM _croft.assets WHERE name = 'orders'`))[0]!.loaded);
    state.orders = [2, 3, 4].map((id) => order(id));
    const done = await confirmed(p, ["run", "orders", "--rebuild"]);
    expect(done.json.data.result.steps[0]).toMatchObject({ status: "ok", rows: { added: 3, total: 3 } });
    const [row] = await p.rows(`SELECT row_count::INT AS n, last_replaced_at::VARCHAR AS replaced, last_loaded_at::VARCHAR AS loaded FROM _croft.assets WHERE name = 'orders'`);
    expect(row!.n).toBe(3);
    expect(row!.replaced).not.toBeNull();
    expect(Date.parse(String(row!.replaced))).toBeGreaterThanOrEqual(Date.parse(loaded));
    // The log: the first write, a closing row for the reset, the rebuild's write, and the same key again with its replaced time.
    const log = await p.rows(`SELECT row_count::INT AS n, last_replaced_at IS NOT NULL AS replaced, coalesce(closed, false) AS closed FROM _croft.assets_log WHERE name = 'orders' ORDER BY seq`);
    expect(log.at(-1)).toMatchObject({ n: 3, replaced: true, closed: false });
    expect(log.some((r) => r.closed === true)).toBe(true);
    expect(log.findIndex((r) => r.closed === true)).toBeLessThan(log.length - 1);
    // The columns were closed and written again too, and read as the table now is.
    expect((await p.rows(`SELECT name FROM _croft.columns WHERE asset = 'orders' ORDER BY name`)).map((r) => r.name)).toEqual(["amount", "id", "status", "updated_at"]);
  }, 180_000);

  test("d. a rename moves every key once: only the new name reads, the old keys are closed", async () => {
    const { p } = await shop("/d", [1, 2, 3].map((id) => order(id)));
    const r = await p.json(["rename", "orders", "purchases"]);
    expect(r.code, show(r)).toBe(0);
    expect((await p.rows(`SELECT name FROM _croft.assets ORDER BY name`)).map((x) => x.name)).toEqual(["order_totals", "purchases"]);
    for (const table of ["columns", "writes", "files"]) {
      expect(await p.rows(`SELECT count(*)::INT AS n FROM _croft.${table} WHERE asset = 'orders'`), table).toEqual([{ n: 0 }]);
    }
    expect((await p.rows(`SELECT asset, input FROM _croft.inputs ORDER BY asset`))).toEqual([{ asset: "order_totals", input: "purchases" }]);
    // In the log the old key has a closing row after its last row, and the new key has its rows.
    const old = await logOf(p, "assets", "name", "orders", "row_count::INT AS n");
    expect(old.at(-1)).toMatchObject({ closed: true });
    const moved = await logOf(p, "assets", "name", "purchases", "row_count::INT AS n");
    expect(moved.at(-1)).toMatchObject({ n: 3, closed: false });
    const d = await p.json(["describe", "purchases"]);
    expect(d.code, show(d)).toBe(0);
    expect(d.json.data).toMatchObject({ asset: "purchases", rows: 3 });
    expect(findProblem(d.json, "NAME_CONFLICT")).toBeUndefined();
  }, 120_000);

  test("e. a delete closes the asset's keys; a restore writes them again, after the closing rows", async () => {
    const { p } = await shop("/e", [1, 2, 3, 4].map((id) => order(id)));
    const was = (await p.rows(`SELECT cursor_value, row_count::INT AS n FROM _croft.assets WHERE name = 'orders'`))[0]!;
    const writesBefore = Number((await p.rows(`SELECT count(*)::INT AS n FROM _croft.writes WHERE asset = 'orders'`))[0]!.n);
    await confirmed(p, ["delete", "orders"]);
    // Gone from what reads.
    for (const [table, col] of [["assets", "name"], ["columns", "asset"], ["writes", "asset"], ["files", "asset"]] as const) {
      expect(await p.rows(`SELECT count(*)::INT AS n FROM _croft.${table} WHERE ${col} = 'orders'`), table).toEqual([{ n: 0 }]);
    }
    expect((await logOf(p, "assets", "name", "orders", "row_count::INT AS n")).at(-1)).toMatchObject({ closed: true });
    // Restore: the table and its state come back as they were.
    await confirmed(p, ["restore", "orders"]);
    expect(await p.rows(`SELECT cursor_value, row_count::INT AS n FROM _croft.assets WHERE name = 'orders'`)).toEqual([was]);
    expect(await p.rows(`SELECT count(*)::INT AS n FROM _croft.writes WHERE asset = 'orders'`)).toEqual([{ n: writesBefore }]);
    const log = await logOf(p, "assets", "name", "orders", "row_count::INT AS n");
    // The first write, the closing row, then the restored row and the restore's update of it: nothing closed after the closing row.
    expect(log.map((r) => r.closed)).toEqual([false, true, false, false]);
    expect(log[2]!.seq).toBeGreaterThan(log[1]!.seq as number);
    // And the restored asset runs on from its saved cursor.
    const next = await p.json(["run", "orders"]);
    expect(next.code, show(next)).toBe(0);
    expect(next.json.data.steps[0].rows).toMatchObject({ added: 0, total: 4 });
  }, 180_000);
});

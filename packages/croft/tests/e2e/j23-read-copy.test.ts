// Journey 23: the read copy for GUIs (DESIGN.md §5 "The read copy is opt-in"). With "readCopy": true, a run that
// wrote data leaves warehouse.read.duckdb next to the warehouse, holding what the warehouse holds (the WAL
// checkpointed first). A GUI keeping the copy open never blocks the next run: the run succeeds, the copy is replaced
// under the GUI (which keeps the file it opened), and a fresh open sees the new rows. Readers here are programs
// that are not croft: @duckdb/node-api in their own processes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, type Envelope, holdDuckDb, initProject, json, type MockApi, mockApi, readDuckDb, schedulerEnv, show } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

const QUERIES = {
  orders: "select id, amount from orders order by id",
  total: "select n, total from order_total",
  assets: "select name, write_mode from _croft.assets order by name",
};

describe("journey 23: readCopy", () => {
  test("the copy matches after a run, a GUI holding it does not block the next run, and it refreshes", async () => {
    const state = { orders: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }] };
    api.route("/orders", () => json(state.orders));
    const { project: p } = await initProject();
    p.remove("assets/example_sales.ts");
    p.write("assets/orders.ts", `import { ingest } from "@zabaca/croft";

export default ingest({
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${api.url}/orders")).json<Record<string, unknown>[]>();
  },
});
`);
    p.write("assets/order_total.sql", "SELECT count(*) AS n, sum(amount) AS total FROM orders\n");
    p.write("croft.json", JSON.stringify({ ...JSON.parse(p.read("croft.json")), readCopy: true }, null, 2));
    const home = { env: schedulerEnv() };
    const copy = join(p.root, "warehouse.read.duckdb");
    // What croft itself says the warehouse holds, in the copy's rendering (integers as strings).
    const warehouse = async () => ({
      orders: (await p.rows(QUERIES.orders)).map((r) => ({ id: String(r.id), amount: String(r.amount) })),
      total: (await p.rows(QUERIES.total)).map((r) => ({ n: String(r.n), total: String(r.total) })),
      assets: (await p.rows(QUERIES.assets)).map((r) => ({ name: r.name, write_mode: r.write_mode })),
    });

    expect(existsSync(copy)).toBe(false);
    const first = await p.json(["run"], home);
    expect(first.code, show(first)).toBe(0);
    expect(first.json.data.steps.map((s: Envelope) => s.status)).toEqual(["ok", "ok"]);
    // After the run, the copy exists and holds what the warehouse holds: the tables and croft's own state.
    expect(existsSync(copy)).toBe(true);
    const before = readDuckDb(copy, QUERIES);
    expect(before).toEqual(await warehouse());
    expect(before.orders).toHaveLength(2);
    const firstInode = statSync(copy).ino;

    // A GUI opens the copy (read-write, as the DuckDB UI and DBeaver do) and keeps it open.
    const gui = await holdDuckDb(copy);
    expect(await gui.query("select count(*)::INTEGER AS n from orders")).toEqual([{ n: 2 }]);

    // The next run is not blocked by it, and refreshes the copy: a new file renamed into place.
    state.orders.push({ id: 3, amount: 30 });
    const second = await p.json(["run"], home);
    expect(second.code, show(second)).toBe(0);
    expect(second.json.data.status).toBe("succeeded");
    expect(second.json.data.steps.map((s: Envelope) => [s.asset, s.status])).toEqual([["orders", "ok"], ["order_total", "ok"]]);
    expect(statSync(copy).ino).not.toBe(firstInode);
    const after = readDuckDb(copy, QUERIES);
    expect(after).toEqual(await warehouse());
    expect(after.orders).toEqual([{ id: "1", amount: "10" }, { id: "2", amount: "20" }, { id: "3", amount: "30" }]);
    expect(after.total).toEqual([{ n: "3", total: "60" }]);
    // The GUI keeps the copy it opened until it reopens.
    expect(await gui.query("select count(*)::INTEGER AS n from orders")).toEqual([{ n: 2 }]);

    // Every run that writes refreshes it again, while the GUI still holds its old copy.
    state.orders[0]!.amount = 15;
    const third = await p.json(["run", "orders"], home);
    expect(third.code, show(third)).toBe(0);
    expect(readDuckDb(copy, QUERIES)).toEqual(await warehouse());
    expect(readDuckDb(copy, QUERIES).total).toEqual([{ n: "3", total: "65" }]);
    await gui.close();
    expect(existsSync(join(p.stateDir, "readcopy.log"))).toBe(false);
    // The warehouse itself was never touched by the GUI.
    expect((await p.rows("select count(*) AS n from orders"))[0]!.n).toBe(3);

    // status and doctor show the copy, current after the last run that wrote data (R32-11). A run's process may
    // still be finishing its refresh when its result is out: that reads as refreshing, never as a warning.
    let st = await p.json(["status"], home);
    for (let i = 0; i < 50 && st.json.data.readCopy?.health === "refreshing"; i++) {
      await Bun.sleep(100);
      st = await p.json(["status"], home);
    }
    expect(st.json.data.readCopy, show(st)).toMatchObject({ path: copy, exists: true, health: "ok", lastError: null, lastWrite: { runId: third.json.data.runId } });
    const doctor = await p.json(["doctor"], home);
    expect(doctor.json.data.checks.find((c: Envelope) => c.id === "readcopy"), show(doctor)).toMatchObject({ section: "environment", status: "ok", details: { health: "ok" } });
    expect(doctor.json.data.checks.find((c: Envelope) => c.id === "readcopy").text).toMatch(/^read copy warehouse\.read\.duckdb · as of \d\d:\d\d \(/);
  }, 120_000);
});

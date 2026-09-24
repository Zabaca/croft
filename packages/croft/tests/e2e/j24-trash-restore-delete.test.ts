// Journey 24: the trash, croft delete and croft restore (DESIGN.md §6 "Destructive operations need confirmation",
// "Trash, restore and delete"; §5 "Versions, staleness and atomicity"). An orders ingest (keyed, incremental) feeds an
// SQL transform. Off a TTY, every destructive command exits 5 with a token and changes nothing; only croft confirm
// carries it out, after the table or rows are in the trash.
//   a. delete --where "<condition>": a token, then croft confirm; the rows are in the trash, the transform reading
//      the table goes stale and rebuilds; croft restore puts the rows back;
//   b. delete the whole table: the asset shows as never built; croft restore brings back the table with its cursor
//      and state, so the next run fetches only what is new;
//   c. rows that change between the token and croft confirm: CONFIRMATION_STALE, and nothing is deleted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupAll, codes, destructiveNext, type Envelope, findProblem, initProject, json, type MockApi, mockApi, type Project, show, trashVersions,
} from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

interface Order { id: number; customer: string; status: string; amount: number; updated_at: string }

const at = (min: number) => `2026-09-20T10:${String(min).padStart(2, "0")}:00Z`;
const order = (id: number, o: Partial<Order> = {}): Order => ({ id, customer: `c${id}`, status: "paid", amount: id * 10, updated_at: at(id), ...o });

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

interface Shop { p: Project; state: { orders: Order[] }; path: string }

/** A project whose orders ingest reads the mock shop under `prefix` (ascending by updated_at, since inclusive), and
 *  order_totals reads orders. Both built once. */
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
  return { p, state, path };
}

const count = async (p: Project, table = "orders") => Number((await p.rows(`select count(*) AS n from ${table}`))[0]!.n);
const totals = async (p: Project) => (await p.rows("select status, orders::INT AS orders from order_totals order by status"));

async function asset(p: Project, name: string): Promise<Envelope> {
  const st = await p.json(["status"]);
  expect(st.code, show(st)).toBe(0);
  const a = st.json.data.assets.find((x: { asset: string }) => x.asset === name);
  if (!a) throw new Error(`no ${name} in status\n${show(st)}`);
  return a;
}

/** A destructive command off a TTY: exit 5, a token and its impact, CONFIRMATION_REQUIRED for a human, and nothing
 *  destructive in next[]. */
function needsConfirmation(r: { code: number | null; json: Envelope }, command: string | RegExp): Envelope {
  expect(r.code, JSON.stringify(r.json).slice(0, 3000)).toBe(5);
  expect(r.json.ok).toBe(false);
  const c = r.json.confirmation;
  expect(c.token).toMatch(/^c_[0-9a-f]{6}$/);
  if (typeof command === "string") expect(c.command).toBe(command);
  else expect(c.command).toMatch(command);
  const p = findProblem(r.json, "CONFIRMATION_REQUIRED");
  expect(p?.fix).toMatchObject({ kind: "manual", requiresHuman: true });
  expect(p?.hint ?? "").toContain(`croft confirm ${c.token}`);
  expect(destructiveNext(r.json)).toEqual([]);
  return c;
}

describe("journey 24: the trash, delete and restore", () => {
  test("a. delete --where → confirm → the rows are in the trash, downstream rebuilds → restore puts them back", async () => {
    const orders = [1, 2, 3, 4, 5, 6].map((id) => order(id, id === 2 || id === 5 ? { customer: "test", status: "test", amount: 0 } : {}));
    const { p } = await shop("/a", orders);
    expect(await count(p)).toBe(6);
    expect(await totals(p)).toEqual([{ status: "paid", orders: 4 }, { status: "test", orders: 2 }]);

    // Off a TTY: a token, nothing deleted.
    const asked = await p.json(["delete", "orders", "--where", "customer = 'test'"]);
    const c = needsConfirmation(asked, /^croft delete orders --where /);
    expect(c.impact).toMatchObject({ asset: "orders", rows: 2, downstream: ["order_totals"] });
    expect(String(c.impact.trashPath)).toContain(join(".croft", "trash", "orders"));
    expect(asked.json.data).toMatchObject({ asset: "orders", where: "customer = 'test'", status: "needs_confirmation", rows: 2, rowsBefore: 6 });
    expect(await count(p)).toBe(6);
    expect(trashVersions(p, "orders")).toEqual([]);
    expect(await asset(p, "orders")).toMatchObject({ status: "ok", rows: 6, stale: false });

    // The human output says what would happen, and how to go ahead.
    const human = await p.croft(["delete", "orders", "--where", "customer = 'test'"]);
    expect(human.code, show(human)).toBe(5);
    expect(human.stdout).toContain([
      "needs confirmation: delete 2 rows of orders (of 6) where customer = 'test'",
      "  first: the 2 rows go to the trash (croft restore orders brings them back)",
      "  then:  order_totals go stale: the next croft run rebuilds them",
    ].join("\n"));
    expect(human.stdout).toMatch(/ask the user; if they agree: croft confirm c_[0-9a-f]{6}/);

    // croft confirm carries it out: the rows go to the trash first, then out of the table.
    const done = await p.json(["confirm", c.token]);
    expect(done.code, show(done)).toBe(0);
    expect(done.json.data).toMatchObject({ token: c.token, outcome: "used" });
    expect(done.json.data.result).toMatchObject({ asset: "orders", status: "deleted", rows: 2, rowsAfter: 4, trashed: { rows: 2 } });
    expect(await count(p)).toBe(4);
    expect(await p.rows("select count(*)::INT AS n from orders where customer = 'test'")).toEqual([{ n: 0 }]);
    expect(trashVersions(p, "orders")).toHaveLength(1);
    const list = await p.json(["restore"]);
    expect(list.code, show(list)).toBe(0);
    expect(list.json.data.versions).toEqual([expect.objectContaining({ asset: "orders", kind: "rows", where: "customer = 'test'", rows: 2 })]);
    expect(list.json.data.retention).toEqual({ days: 30, versions: 5 });

    // The table was replaced under its readers: order_totals is stale until it runs again.
    expect(await asset(p, "orders")).toMatchObject({ status: "ok", rows: 4 });
    const stale = await asset(p, "order_totals");
    expect(stale.stale, JSON.stringify(stale)).toBe(true);
    expect(stale.staleReasons).toContain("input_replaced");
    const described = await p.json(["describe", "orders"]);
    expect(described.code, show(described)).toBe(0);
    expect(described.json.data).toMatchObject({ asset: "orders", rows: 4, readBy: ["order_totals"] });
    const rebuilt = await p.json(["run", "order_totals"]);
    expect(rebuilt.code, show(rebuilt)).toBe(0);
    expect(await totals(p)).toEqual([{ status: "paid", orders: 4 }]);
    expect((await asset(p, "order_totals")).stale).toBe(false);

    // Spent: the token cannot delete again.
    const again = await p.json(["confirm", c.token]);
    expect(again.code, show(again)).toBe(5);
    expect(codes(again.json)).toContain("CONFIRMATION_STALE");

    // croft restore orders: the newest version is the deleted rows; they go back into the table as it is now.
    const back = await p.json(["restore", "orders"]);
    const r = needsConfirmation(back, /^croft restore orders --at /);
    expect(back.json.data).toMatchObject({ asset: "orders", status: "needs_confirmation", rows: 2, replacedRows: 4 });
    expect(back.json.data.version).toMatchObject({ kind: "rows", where: "customer = 'test'" });
    expect(await count(p)).toBe(4);
    const restored = await p.json(["confirm", r.token]);
    expect(restored.code, show(restored)).toBe(0);
    expect(restored.json.data.result).toMatchObject({ asset: "orders", status: "restored", rows: 2, rowsAfter: 6 });
    expect(await count(p)).toBe(6);
    expect(await p.rows("select id::INT AS id from orders where customer = 'test' order by id")).toEqual([{ id: 2 }, { id: 5 }]);
    // The table the restore replaced went to the trash first.
    expect(trashVersions(p, "orders")).toHaveLength(2);
    expect((await asset(p, "order_totals")).staleReasons).toContain("input_replaced");
    expect((await p.json(["run", "order_totals"])).code).toBe(0);
    expect(await totals(p)).toEqual([{ status: "paid", orders: 4 }, { status: "test", orders: 2 }]);
  }, 180_000);

  test("b. delete the whole table → never built; restore brings back the table, its cursor and its state", async () => {
    const { p, state, path } = await shop("/b", [1, 2, 3, 4].map((id) => order(id)));
    const cursor = (await p.json(["describe", "orders"])).json.data.behavior.incremental.cursorValue as string;
    expect(Date.parse(cursor)).toBe(Date.parse(at(4)));

    const asked = await p.json(["delete", "orders"]);
    const c = needsConfirmation(asked, "croft delete orders");
    expect(c.impact).toMatchObject({ asset: "orders", rows: 4, downstream: ["order_totals"] });
    const done = await p.json(["confirm", c.token]);
    expect(done.code, show(done)).toBe(0);
    expect(done.json.data.result).toMatchObject({ status: "deleted", rows: 4, rowsAfter: 0, trashed: { rows: 4 } });

    // The asset file stays; the asset is never built, and its reader keeps its table.
    expect(p.exists("assets/orders.ts")).toBe(true);
    expect(await asset(p, "orders")).toMatchObject({ status: "never_run", rows: null, stale: true, staleReasons: ["never_built"] });
    const none = await p.json(["describe", "orders"]);
    expect(none.code, show(none)).toBe(0);
    expect(none.json.data).toMatchObject({ asset: "orders", kind: "ingest", file: "assets/orders.ts", rows: null, readBy: ["order_totals"] });
    expect(await count(p, "order_totals")).toBe(1);
    const gone = await p.json(["query", "select count(*) from orders"]);
    expect(gone.code, show(gone)).not.toBe(0);
    const list = await p.json(["restore"]);
    expect(list.json.data.versions).toEqual([expect.objectContaining({ asset: "orders", kind: "table", rows: 4 })]);

    // Restore: the table and croft's state for it (its cursor) come back; nothing is fetched.
    const before = api.requests(path).length;
    const back = await p.json(["restore", "orders"]);
    const r = needsConfirmation(back, /^croft restore orders --at /);
    expect(r.impact).toMatchObject({ asset: "orders", rows: 0 });
    const restored = await p.json(["confirm", r.token]);
    expect(restored.code, show(restored)).toBe(0);
    expect(restored.json.data.result).toMatchObject({ status: "restored", rows: 4, rowsAfter: 4, trashed: null });
    expect(api.requests(path).length).toBe(before);
    expect(await count(p)).toBe(4);
    expect(await asset(p, "orders")).toMatchObject({ status: "ok", rows: 4 });
    const d = await p.json(["describe", "orders"]);
    expect(d.json.data.behavior.incremental.cursorValue).toBe(cursor);

    // The next run continues from the restored cursor: only what is new is fetched.
    state.orders.push(order(5));
    const next = await p.json(["run", "orders"]);
    expect(next.code, show(next)).toBe(0);
    expect(Date.parse(api.requests(path).at(-1)!.query.since!)).toBeGreaterThanOrEqual(Date.parse(at(4)) - 1000);
    expect(next.json.data.steps.find((s: { asset: string }) => s.asset === "orders").rows).toMatchObject({ added: 1, total: 5 });
  }, 180_000);

  test("c. rows that change between the token and croft confirm: CONFIRMATION_STALE, nothing deleted", async () => {
    const { p, state } = await shop("/c", [1, 2, 3].map((id) => order(id, id === 3 ? { status: "test" } : {})));
    const asked = await p.json(["delete", "orders", "--where", "status = 'test'"]);
    const c = needsConfirmation(asked, /^croft delete orders --where /);
    expect(c.impact.rows).toBe(1);

    // Meanwhile a run brings another row the condition matches.
    state.orders.push(order(4, { status: "test" }));
    expect((await p.json(["run", "orders"])).code).toBe(0);
    expect(await count(p)).toBe(4);

    const stale = await p.json(["confirm", c.token]);
    expect(stale.code, show(stale)).toBe(5);
    const s = findProblem(stale.json, "CONFIRMATION_STALE");
    expect(s, show(stale)).toBeDefined();
    expect(s!.details).toMatchObject({ reason: "impact_changed" });
    expect(s!.message).toContain("2 rows");
    expect(await count(p)).toBe(4);
    expect(trashVersions(p, "orders")).toEqual([]);

    // A new token counts the rows as they are now.
    const fresh = await p.json(["delete", "orders", "--where", "status = 'test'"]);
    expect(needsConfirmation(fresh, /^croft delete orders --where /).impact.rows).toBe(2);
  }, 180_000);
});

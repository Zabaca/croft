// Journey 8: an incremental file ingest over a glob, written from DESIGN §3b ("every CSV dropped into
// files/sales/ is loaded once; changed files are reloaded").
// - a second CSV with an extra column: only the new file loads, and the column is added (old rows NULL);
// - a changed file is reloaded (only its rows, by key); unchanged rows keep their _loaded_at;
// - a deleted file's rows are kept, and status says the file is gone.
import { afterAll, expect, test } from "bun:test";
import { bugTest, cleanupAll, initProject, type Project, show } from "./harness.ts";

let shared: Project | undefined;
afterAll(cleanupAll);

const SALES = `// assets/sales.ts (DESIGN.md §3b): every CSV dropped into files/sales/ is loaded once; changed files are reloaded
import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Daily order exports from the shop",
  file: "files/sales/*.csv",
  incremental: true,
  key: "order_id",                                        // exports overlap; the key removes repeats
  map: (row) => ({ ...row, email: String(row.email ?? "").trim().toLowerCase() }),
  checks: ["amount >= 0"],
});
`;

const JAN = `order_id,order_date,email,amount
1,2026-01-03, Ann@Example.com ,12.50
2,2026-01-04,bob@example.com,8.00
3,2026-01-05,CARL@example.com,19.99
4,2026-01-06,dee@example.com,5.25
5,2026-01-07,eve@example.com,40.00
`;

const FEB = `order_id,order_date,email,amount,coupon
6,2026-02-01,fay@example.com,10.00,WINTER10
7,2026-02-02,gus@example.com,22.00,
8,2026-02-03,hal@example.com,7.50,FEB5
`;

test("journey 8: file glob, incremental: new file only, extra column added, changed file reloaded, deleted file kept", async () => {
  const { project: p } = await initProject();
  shared = p;
  p.write("assets/sales.ts", SALES);
  p.write("files/sales/2026-01.csv", JAN);

  const first = await p.json(["run", "sales"]);
  expect(first.code, show(first)).toBe(0);
  expect(first.json.data.steps[0]).toMatchObject({ status: "ok", rows: { in: 5, added: 5, total: 5 } });
  const rows1 = await p.rows("select order_id, order_date, email, amount, _file, _loaded_at from sales order by order_id");
  expect(rows1[0]).toMatchObject({ order_id: 1, order_date: "2026-01-03", email: "ann@example.com", amount: 12.5, _file: "files/sales/2026-01.csv" });
  expect(rows1[2]!.email).toBe("carl@example.com");
  const stamp1 = rows1[0]!._loaded_at;

  // Nothing changed: the step is a no-op.
  const same = await p.json(["run", "sales"]);
  expect(same.code, show(same)).toBe(0);
  expect(same.json.data.steps[0].status).toBe("unchanged");

  // A second export with an extra coupon column: only it loads, and the column is added.
  p.write("files/sales/2026-02.csv", FEB);
  const second = await p.json(["run", "sales"]);
  expect(second.code, show(second)).toBe(0);
  const s2 = second.json.data.steps[0];
  expect(s2).toMatchObject({ status: "ok", rows: { in: 3, added: 3, updated: 0, deleted: 0, total: 8 } });
  expect(s2.schemaChanges.some((c: { column?: string; kind?: string }) => c.column === "coupon" && c.kind === "add_column"), JSON.stringify(s2.schemaChanges)).toBe(true);
  const rows2 = await p.rows("select order_id, coupon, _file, _loaded_at from sales order by order_id");
  expect(rows2).toHaveLength(8);
  expect(rows2[0]).toMatchObject({ order_id: 1, coupon: null, _file: "files/sales/2026-01.csv", _loaded_at: stamp1 });
  expect(rows2[5]).toMatchObject({ order_id: 6, coupon: "WINTER10", _file: "files/sales/2026-02.csv" });
  expect(rows2[6]!.coupon).toBeNull();
  const d = await p.json(["describe", "sales"]);
  expect(d.json.data.columns.find((c: { name: string }) => c.name === "coupon")).toMatchObject({ type: "VARCHAR" });

  // January's export is re-exported with one amount corrected: only that file reloads, one row updates.
  p.write("files/sales/2026-01.csv", JAN.replace("2,2026-01-04,bob@example.com,8.00", "2,2026-01-04,bob@example.com,8.80"));
  const third = await p.json(["run", "sales"]);
  expect(third.code, show(third)).toBe(0);
  expect(third.json.data.steps[0].rows).toMatchObject({ in: 5, added: 0, updated: 1, unchanged: 4, deleted: 0, total: 8 });
  const rows3 = await p.rows("select order_id, amount, _loaded_at from sales order by order_id");
  expect(rows3[1]).toMatchObject({ order_id: 2, amount: 8.8 });
  expect(rows3[1]!._loaded_at).not.toBe(stamp1);
  expect(rows3[0]!._loaded_at).toBe(stamp1);

  // A row removed from a changed file is deleted (the reload is limited to that file's rows).
  p.write("files/sales/2026-01.csv", JAN.replace("2,2026-01-04,bob@example.com,8.00", "2,2026-01-04,bob@example.com,8.80").replace("5,2026-01-07,eve@example.com,40.00\n", ""));
  const fourth = await p.json(["run", "sales"]);
  expect(fourth.code, show(fourth)).toBe(0);
  expect(fourth.json.data.steps[0].rows).toMatchObject({ in: 4, deleted: 1, total: 7 });

  // February's export is deleted: its rows are kept.
  p.remove("files/sales/2026-02.csv");
  const fifth = await p.json(["run", "sales"]);
  expect(fifth.code, show(fifth)).toBe(0);
  expect(fifth.json.data.steps[0].rows.total).toBe(7);
  expect((await p.rows("select count(*) n from sales where _file = 'files/sales/2026-02.csv'"))[0]!.n).toBe(3);
}, 120_000);

// §3b's sales.ts expects exports to overlap ("the key removes repeats"). A key's row comes from the latest file
// that provided it, and a changed file that drops a key never deletes a row another file still has.
test("journey 8f: overlapping exports: a key another export still has survives a re-export without it", async () => {
  const { project: p } = await initProject();
  p.write("assets/sales.ts", SALES);
  p.write("files/sales/2026-01.csv", "order_id,order_date,email,amount\n1,2026-01-03,a@x.com,10.00\n2,2026-01-04,b@x.com,20.00\n3,2026-01-31,c@x.com,30.00\n");
  p.write("files/sales/2026-02.csv", "order_id,order_date,email,amount\n3,2026-01-31,c@x.com,33.00\n4,2026-02-01,d@x.com,40.00\n");
  const first = await p.json(["run", "sales"]);
  expect(first.code, show(first)).toBe(0);
  expect(first.json.data.steps[0].rows).toMatchObject({ in: 5, added: 4, total: 4 });
  const table = () => p.rows("select order_id, amount, _file from sales order by order_id");
  expect((await table())[2]).toEqual({ order_id: 3, amount: 33, _file: "files/sales/2026-02.csv" });

  // February is re-exported without order 3; January still has it, so the row stays (January's now).
  p.write("files/sales/2026-02.csv", "order_id,order_date,email,amount\n4,2026-02-01,d@x.com,40.00\n");
  const second = await p.json(["run", "sales"]);
  expect(second.code, show(second)).toBe(0);
  expect(second.json.data.steps[0].rows).toEqual({ in: 1, added: 0, updated: 1, unchanged: 1, deleted: 0, total: 4 });
  expect((await table()).map((r) => [r.order_id, r.amount, r._file])).toEqual([
    [1, 10, "files/sales/2026-01.csv"], [2, 20, "files/sales/2026-01.csv"], [3, 30, "files/sales/2026-01.csv"], [4, 40, "files/sales/2026-02.csv"],
  ]);
  const third = await p.json(["run", "sales"]);
  expect(third.json.data.steps[0].status, show(third)).toBe("unchanged");

  // January drops order 3 too: no export has it any more, so it is deleted.
  p.write("files/sales/2026-01.csv", "order_id,order_date,email,amount\n1,2026-01-03,a@x.com,10.00\n2,2026-01-04,b@x.com,20.00\n");
  const fourth = await p.json(["run", "sales"]);
  expect(fourth.code, show(fourth)).toBe(0);
  expect(fourth.json.data.steps[0].rows).toMatchObject({ in: 2, deleted: 1, total: 3 });
  expect((await table()).map((r) => r.order_id)).toEqual([1, 2, 4]);
}, 120_000);

// Fixed: when the only change is a deleted file, the step is "unchanged", and it now still records the gone files
// in the catalog mirror, which `status` reads; DESIGN §3b says rows of a deleted file are kept "and status says
// '2 files gone'".
test("journey 8b: after a file is deleted, status lists it as gone", async () => {
  expect(shared).toBeDefined();
  const st = await shared!.json(["status"]);
  const sa = st.json.data.assets.find((a: { asset: string }) => a.asset === "sales");
  expect(sa.filesGone, show(st)).toEqual(["files/sales/2026-02.csv"]);
  const human = await shared!.croft(["status"]);
  expect(human.stdout).toContain("1 file gone");
}, 60_000);

test("journey 8c: status lists a gone file once a later run also loads a changed file", async () => {
  expect(shared).toBeDefined();
  const p = shared!;
  p.write("files/sales/2026-03.csv", "order_id,order_date,email,amount\n9,2026-03-01,ivy@example.com,3.00\n");
  const r = await p.json(["run", "sales"]);
  expect(r.code, show(r)).toBe(0);
  expect(r.json.data.steps[0].rows).toMatchObject({ in: 1, added: 1, total: 8 });
  const st = await p.json(["status"]);
  const sa = st.json.data.assets.find((a: { asset: string }) => a.asset === "sales");
  expect(sa.filesGone, show(st)).toEqual(["files/sales/2026-02.csv"]);
  const ctx = await p.json(["context"]);
  expect(ctx.json.data.assets.find((a: { asset: string }) => a.asset === "sales").filesGone).toEqual(["files/sales/2026-02.csv"]);
  // context reports the coupon column added earlier.
  expect(ctx.json.data.recentSchemaChanges).toEqual(expect.arrayContaining([expect.objectContaining({ asset: "sales", kind: "add_column", column: "coupon" })]));
}, 60_000);

// BUG (reported): status never sets schemaChangedAt ("schema changed today", §4.2/§4.3/§7): status.ts reads
// runs.summary.steps[].schemaChanges, but the run engine stores the whole envelope result, so the steps are at
// runs.summary.data.steps. context (which reads the warehouse) does list the change. Flip to test() once fixed.
test("journey 8d: status says the schema changed after a column was added", async () => {
  expect(shared).toBeDefined();
  const st = await shared!.json(["status"]);
  const sa = st.json.data.assets.find((a: { asset: string }) => a.asset === "sales");
  expect(sa.schemaChangedAt, show(st)).toBeDefined();
  const human = await shared!.croft(["status"]);
  expect(human.stdout).toContain("schema changed");
}, 60_000);

// BUG (reported): §3b "Preview and the first run always print the header they used" (header detection is
// what saves a header-less export from losing its first row); the first run's output never mentions it.
test("journey 8e: the first run of a CSV ingest prints the header it used", async () => {
  const { project: p } = await initProject();
  const human = await p.croft(["run", "example_sales"]);
  expect(human.code, show(human)).toBe(0);
  expect(human.stdout.toLowerCase()).toContain("header");
}, 60_000);

// Golden: the commands that change or remove data (DESIGN.md §4.3, §6), each --json envelope validated against its
// schema: delete (rows and a whole table) and restore, each asking for a token off a TTY, confirm carrying the token
// out (and refusing a spent one), a shrink and a rebuild confirmed through croft run, and rename.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cleanupAll, initProject, type Project, schedulerEnv } from "../e2e/harness.ts";
import { golden } from "./kit.ts";

let p: Project;
let env: Record<string, string>;

const SALES_BY_REGION = `-- description: Orders and revenue per region
-- key: region
SELECT region, count(*) AS orders, sum(amount) AS amount
FROM example_sales
GROUP BY ALL
`;

beforeAll(async () => {
  env = schedulerEnv();
  p = (await initProject("golden-safety")).project;
  p.write("assets/sales_by_region.sql", SALES_BY_REGION);
  golden("run", await p.croft(["run", "--json"], { env }));
}, 120_000);
afterAll(cleanupAll);

/** A command that stops for a person's yes: exit 5, its data, and a confirmation. */
function asks(command: "delete" | "restore" | "run", r: Awaited<ReturnType<Project["croft"]>>): string {
  const env = golden(command, r, { exit: 5 });
  expect(env.confirmation.token).toMatch(/^c_[0-9a-f]{6}$/);
  return env.confirmation.token as string;
}

test("delete --where: a token, confirm, and a --where that matches nothing", async () => {
  const token = asks("delete", await p.croft(["delete", "example_sales", "--where", "region = 'West'", "--json"], { env }));
  const done = golden("confirm", await p.croft(["confirm", token, "--json"], { env }));
  expect(done.data).toMatchObject({ token, outcome: "used", result: { status: "deleted" } });
  golden("confirm", await p.croft(["confirm", token, "--json"], { env }), { failed: true, exit: 5 });
  const none = golden("delete", await p.croft(["delete", "example_sales", "--where", "region = 'Nowhere'", "--json"], { env }));
  expect(none.data.status).toBe("nothing_matched");
  golden("delete", await p.croft(["delete", "example_sales", "--where", "no_such_column = 1", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("restore: the trash, then a version back through confirm", async () => {
  const list = golden("restore", await p.croft(["restore", "--json"], { env })).data;
  expect(list.versions.length).toBe(1);
  const token = asks("restore", await p.croft(["restore", "example_sales", "--json"], { env }));
  const done = golden("confirm", await p.croft(["confirm", token, "--json"], { env }));
  expect(done.data.result).toMatchObject({ asset: "example_sales", status: "restored" });
  golden("restore", await p.croft(["restore", "sales_by_region", "--json"], { env }), { failed: true, exit: 2 });
}, 120_000);

test("delete a whole table, and restore it with --at", async () => {
  const token = asks("delete", await p.croft(["delete", "sales_by_region", "--json"], { env }));
  expect(golden("confirm", await p.croft(["confirm", token, "--json"], { env })).data.result.status).toBe("deleted");
  golden("status", await p.croft(["status", "--json"], { env }));
  const list = golden("restore", await p.croft(["restore", "--json"], { env })).data;
  const version = list.versions.find((v: { asset: string }) => v.asset === "sales_by_region");
  const again = asks("restore", await p.croft(["restore", "sales_by_region", "--at", version.trashedAt, "--json"], { env }));
  expect(golden("confirm", await p.croft(["confirm", again, "--json"], { env })).data.result.status).toBe("restored");
}, 120_000);

test("a shrink and a rebuild confirmed through croft run", async () => {
  const csv = p.read("files/example_sales.csv").split("\n");
  p.write("files/example_sales.csv", `${csv.slice(0, 4).join("\n")}\n`);
  golden("run", await p.croft(["run", "example_sales", "--json"], { env }), { exit: 1 });
  const token = asks("run", await p.croft(["run", "example_sales", "--allow-shrink", "--json"], { env }));
  // The example's min_rows(100) check fails the confirmed run: its result is a failed run (exit 3).
  const shrunk = golden("confirm", await p.croft(["confirm", token, "--json"], { env }), { exit: 3 });
  expect(shrunk.data).toMatchObject({ outcome: "used", result: { status: "failed" } });
  p.write("files/example_sales.csv", csv.join("\n"));
  const rebuild = asks("run", await p.croft(["run", "example_sales", "--rebuild", "--json"], { env }));
  golden("run", await p.croft(["run", "example_sales", "--rebuild", "--dry-run", "--json"], { env }));
  expect(golden("confirm", await p.croft(["confirm", rebuild, "--json"], { env })).data.result.status).toBe("succeeded");
}, 120_000);

test("rename, and a rename onto a name that is taken", async () => {
  const r = golden("rename", await p.croft(["rename", "sales_by_region", "region_sales", "--json"], { env })).data;
  expect(r).toMatchObject({ from: "sales_by_region", to: "region_sales" });
  golden("rename", await p.croft(["rename", "region_sales", "example_sales", "--json"], { env }), { failed: true, exit: 2 });
  golden("describe", await p.croft(["describe", "region_sales", "--json"], { env }));
}, 120_000);

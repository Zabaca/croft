// Golden: croft new --json (DESIGN.md §4.1, §4.3, §10), every shape it prints: --list, a template of every kind and
// pagination style (the api default included, and a file ingest whose folder exists already), and every refusal
// (the envelope with data null): NAME_CONFLICT for a file and for a table whose file is gone, NAME_INVALID,
// NAME_RESERVED, INPUT_NEEDS_KEY, and USAGE_ERROR for a missing kind or name, a kind croft does not have, a bad
// --pagination and --pagination on a kind without pages, and an sql template with nothing to read. Each is validated
// against schemas/new.schema.json and the envelope schema. Every run gets a temporary HOME.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, type Envelope, initProject, type Project, schedulerEnv } from "../e2e/harness.ts";
import { golden } from "./kit.ts";

let p: Project;
let env: Record<string, string>;
beforeAll(async () => {
  env = schedulerEnv();
  p = (await initProject("golden-new")).project;
}, 120_000);
afterAll(cleanupAll);

const made = async (args: string[], project = p): Promise<Envelope> => golden("new", await project.croft([...args, "--json"], { env }));
const refused = async (args: string[], code: string, project = p): Promise<Envelope> => {
  const e = golden("new", await project.croft([...args, "--json"], { env }), { failed: true, exit: 2 });
  expect(e.problems.map((x: { code: string }) => x.code)).toEqual([code]);
  return e;
};

test("--list: every template", async () => {
  const d = (await made(["new", "--list"])).data;
  expect(d.templates.length).toBe(7);
}, 60_000);

test("api: every pagination style, and the default", async () => {
  for (const style of ["keyset", "cursor", "link", "page"]) {
    expect((await made(["new", "api", `golden_${style}`, "--pagination", style])).data).toMatchObject({ kind: "api", pagination: style });
  }
  expect((await made(["new", "api", "golden_default"])).data).toMatchObject({ kind: "api", pagination: "cursor", secrets: [{ status: "missing" }] });
  p.secret("GOLDEN_KEY", "golden-secret-value");
  expect((await made(["new", "api", "golden_items"])).data.secrets).toEqual([{ name: "GOLDEN_KEY", status: "set" }]);
}, 60_000);

test("file: a new folder, and a folder that exists already", async () => {
  expect((await made(["new", "file", "golden_files"])).data.created).toEqual(["assets/golden_files.ts", "files/golden_files/"]);
  mkdirSync(join(p.root, "files", "golden_drop"), { recursive: true });
  p.write("files/golden_drop/a.csv", "id\n1\n");
  expect((await made(["new", "file", "golden_drop"])).data.created).toEqual(["assets/golden_drop.ts"]);
}, 60_000);

test("sql and transform: the asset they read", async () => {
  p.write("assets/example_sales.ts", p.read("assets/example_sales.ts"));
  expect((await made(["new", "sql", "golden_report"])).data).toMatchObject({ kind: "sql", reads: "example_sales", file: "assets/golden_report.sql" });
  p.write("assets/example_sales.ts", p.read("assets/example_sales.ts"));
  expect((await made(["new", "transform", "golden_enriched"])).data).toMatchObject({ kind: "transform", reads: "example_sales" });
}, 60_000);

test("refusals: the name, the kind, the pagination", async () => {
  await refused(["new", "sql", "golden_report"], "NAME_CONFLICT");
  await refused(["new", "api", "assets/golden_x.ts"], "NAME_INVALID");
  await refused(["new", "api", "Golden-X"], "NAME_INVALID");
  await refused(["new", "sql", "_golden"], "NAME_RESERVED");
  await refused(["new", "sql", "select"], "NAME_RESERVED");
  await refused(["new"], "USAGE_ERROR");
  await refused(["new", "api"], "USAGE_ERROR");
  await refused(["new", "golden_only_a_name"], "USAGE_ERROR");
  await refused(["new", "ingest", "golden_x"], "USAGE_ERROR");
  await refused(["new", "api", "golden_x", "--pagination", "offset"], "USAGE_ERROR");
  await refused(["new", "sql", "golden_x", "--pagination", "page"], "USAGE_ERROR");
}, 60_000);

test("refusals: a table whose file is gone; nothing to read; no input with a key", async () => {
  const { project: q } = await initProject("golden-new-2");
  golden("run", await q.croft(["run", "example_sales", "--json"], { env }));
  q.remove("assets/example_sales.ts");
  await refused(["new", "file", "example_sales"], "NAME_CONFLICT", q);
  await refused(["new", "sql", "golden_empty"], "USAGE_ERROR", q);
  q.write("assets/keyless.ts", 'import { ingest } from "@zabaca/croft";\n\nexport default ingest({\n  async *rows() {\n    yield [{ n: 1 }];\n  },\n});\n');
  await refused(["new", "transform", "golden_needs_key"], "INPUT_NEEDS_KEY", q);
}, 120_000);

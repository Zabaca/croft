// Extra journeys around the phase-1 surface that an agent hits early: the launcher from a subfolder, .env
// isolation, the query sandbox and zero-asset path, asset code errors and null keys, and init inside an app.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bugTest, cleanupAll, croftIn, findProblem, initProject, json, type MockApi, mockApi, Project, rawJson, show, tempDir } from "./harness.ts";

let api: MockApi;
beforeAll(() => {
  api = mockApi();
});
afterAll(async () => {
  api.stop();
  await cleanupAll();
});

describe("edges", () => {
  test("the launcher finds the project from a subfolder; the zero-asset path reads files/ directly", async () => {
    const { project: p } = await initProject();
    const run = await croftIn(join(p.root, "assets"), ["run", "example_sales", "--json"]);
    expect(run.code, show(run)).toBe(0);
    const st = await croftIn(join(p.root, "files"), ["status", "--json"]);
    expect(st.code, show(st)).toBe(0);
    expect(st.json!.data.assets[0]).toMatchObject({ asset: "example_sales", rows: 120 });
    // §3b "Zero-asset path": croft query "from 'files/…'" looks at a file without making an asset.
    const zero = await p.json(["query", "select count(*) n from 'files/example_sales.csv'"]);
    expect(zero.code, show(zero)).toBe(0);
    expect(zero.json.data.rows[0].n).toBe(120);
    // …also from a subfolder: the path is the project's files/, not the caller's.
    const sub = await croftIn(join(p.root, "assets"), ["query", "select count(*) n from 'files/example_sales.csv'", "--json"]);
    expect(sub.code, show(sub)).toBe(0);
    expect(sub.json!.data.rows[0].n).toBe(120);
  }, 60_000);

  test("query is one sandboxed SELECT: no exports, no reading .env or the state folder, no writes", async () => {
    const { project: p } = await initProject();
    p.secret("GITHUB_TOKEN", "ghp_neverShownInQuery123");
    expect((await p.json(["run", "example_sales"])).code).toBe(0);

    const copy = await p.json(["query", "copy example_sales to 'out.csv'"]);
    expect(copy.code, show(copy)).toBe(2);
    expect(findProblem(copy.json, "QUERY_NOT_SELECT"), show(copy)).toBeDefined();
    expect(p.exists("out.csv")).toBe(false);

    const del = await p.json(["query", "delete from example_sales"]);
    expect(del.code, show(del)).toBe(2);
    expect((await p.rows("select count(*) n from example_sales"))[0]!.n).toBe(120);

    const two = await p.json(["query", "select 1; select 2"]);
    expect(two.code, show(two)).toBe(2);

    const env = await p.json(["query", "select * from read_text('.env')"]);
    expect(env.code, show(env)).toBe(2);
    expect(findProblem(env.json, "QUERY_PATH_DENIED"), show(env)).toBeDefined();
    expect(env.stdout).not.toContain("ghp_neverShownInQuery123");

    const state = await p.json(["query", "select * from read_text('.croft/runs.sqlite')"]);
    expect(state.code, show(state)).toBe(2);
    expect(findProblem(state.json, "QUERY_PATH_DENIED"), show(state)).toBeDefined();

    const unknown = await p.json(["query", "select * from exmaple_sales"]);
    expect(unknown.code, show(unknown)).toBe(2);
    expect(findProblem(unknown.json, "UNKNOWN_TABLE"), show(unknown)).toBeDefined();

    const col = await p.json(["query", "select custmer from example_sales"]);
    expect(col.code, show(col)).toBe(2);
    expect(findProblem(col.json, "UNKNOWN_COLUMN"), show(col)).toBeDefined();
  }, 60_000);

  test(".env values never reach process.env of asset code; ctx.secret() still hands out a declared one", async () => {
    api.route("/echo", () => json([{ id: 1 }]));
    const { project: p } = await initProject();
    p.secret("GITHUB_TOKEN", "ghp_processEnvLeakCheck77");
    p.secret("UNDECLARED_THING", "undeclared-value-xyz-99");
    p.write("assets/envcheck.ts", `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  secrets: ["GITHUB_TOKEN"],
  async *rows({ http, secret }) {
    const base = (await http.get("${api.url}/echo")).json<{ id: number }[]>();
    yield base.map((r) => ({
      ...r,
      from_env: process.env.GITHUB_TOKEN ?? null,
      undeclared_env: process.env.UNDECLARED_THING ?? null,
      token_len: secret("GITHUB_TOKEN").length,
    }));
  },
});
`);
    const r = await p.json(["run", "envcheck"]);
    expect(r.code, show(r)).toBe(0);
    const rows = await p.rows("select id, from_env, undeclared_env, token_len from envcheck");
    expect(rows).toEqual([{ id: 1, from_env: null, undeclared_env: null, token_len: "ghp_processEnvLeakCheck77".length }]);
  }, 60_000);

  test("an asset that throws: ASSET_CODE_ERROR with the asset's own stack frame; nothing written", async () => {
    api.route("/boom", () => json([{ id: 1, v: "a" }]));
    const { project: p } = await initProject();
    p.write("assets/boom.ts", `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  retries: 0,
  async *rows({ http }) {
    const page = (await http.get("${api.url}/boom")).json<{ id: number }[]>();
    yield page;
    throw new TypeError("cannot read properties of undefined (reading 'next')");
  },
});
`);
    const r = await p.json(["run", "boom"]);
    expect(r.code, show(r)).toBe(1);
    const e = findProblem(r.json, "ASSET_CODE_ERROR");
    expect(e, show(r)).toBeDefined();
    expect(e!.message).toContain("TypeError");
    expect(JSON.stringify(e!.details?.stack ?? [])).toContain("assets/boom.ts");
    const t = await p.json(["query", "select count(*) n from duckdb_tables() where table_name = 'boom'"]);
    expect(t.json.data.rows[0].n).toBe(0);
    const logs = await p.json(["logs", "boom", "--failed"]);
    expect(logs.json.data.steps[0].error.code).toBe("ASSET_CODE_ERROR");
  }, 60_000);

  test("a NULL key fails with KEY_NULL before anything is written", async () => {
    api.route("/nullkey", () => json([{ id: 1, v: "a" }, { id: null, v: "b" }]));
    const { project: p } = await initProject();
    p.write("assets/nullkey.ts", `import { ingest } from "@zabaca/croft";
export default ingest({
  key: "id",
  async *rows({ http }) {
    yield (await http.get("${api.url}/nullkey")).json<Record<string, unknown>[]>();
  },
});
`);
    const r = await p.json(["run", "nullkey"]);
    expect(r.code, show(r)).toBe(1);
    expect(findProblem(r.json, "KEY_NULL"), show(r)).toBeDefined();
    const t = await p.json(["query", "select count(*) n from duckdb_tables() where table_name = 'nullkey'"]);
    expect(t.json.data.rows[0].n).toBe(0);
  }, 60_000);

  test("usage mistakes: a misspelled asset or command gets a did-you-mean, exit 2", async () => {
    const { project: p } = await initProject();
    const run = await p.json(["run", "example_sale"]);
    expect(run.code, show(run)).toBe(2);
    expect(findProblem(run.json, "USAGE_ERROR")?.hint).toContain("example_sales");
    const d = await p.json(["describe", "example_sale"]);
    expect(d.code, show(d)).toBe(2);
    expect(JSON.stringify(d.json.problems)).toContain("example_sales");
    const cmd = await p.json(["stauts"]);
    expect(cmd.code, show(cmd)).toBe(2);
    expect(findProblem(cmd.json, "USAGE_ERROR")?.hint).toContain("status");
    // Outside a project, a data command says there is no project.
    const outside = await croftIn(tempDir(), ["status", "--json"]);
    expect(outside.code, show(outside)).toBe(2);
    expect(findProblem(outside.json!, "PROJECT_NOT_FOUND"), show(outside)).toBeDefined();
  }, 60_000);

  test("init refuses to overwrite a project; init inside an existing app makes data/ and leaves the app's files alone", async () => {
    const { project: p } = await initProject();
    const again = await croftIn(p.root, ["init", "--no-install", "--json"]);
    expect(again.code, show(again)).toBe(2);
    expect(JSON.stringify(again.json?.problems ?? [])).toContain("init --claude");

    const app = join(tempDir(), "my-app");
    mkdirSync(app, { recursive: true });
    const pkg = JSON.stringify({ name: "my-app", private: true, dependencies: { next: "15.0.0" } }, null, 2);
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, exclude: ["node_modules"] }, null, 2);
    writeFileSync(join(app, "package.json"), pkg);
    writeFileSync(join(app, "tsconfig.json"), tsconfig);
    writeFileSync(join(app, "CLAUDE.md"), "# My app\n\nOwn notes.\n");
    const r = await croftIn(join(app, ".."), ["init", app, "--no-install", "--json"]);
    expect(r.code, show(r)).toBe(0);
    const root = new Project(app);
    expect(root.read("package.json")).toBe(pkg);
    expect(root.exists("data/croft.json")).toBe(true);
    expect(root.exists("data/package.json")).toBe(true);
    expect(root.exists("data/assets/example_sales.ts")).toBe(true);
    expect(root.read("CLAUDE.md")).toContain("Own notes.");
    expect(root.read("CLAUDE.md")).toContain("@zabaca/croft/read");
    expect(root.exists(".claude/skills/croft/SKILL.md")).toBe(true);
    // Off a TTY the tsconfig edit is printed, not applied.
    expect(root.read("tsconfig.json")).toBe(tsconfig);
    expect(r.stdout + r.stderr).toContain("data");
  }, 60_000);
});

describe("edges: reported bugs", () => {
  // Fixed: the zero-asset path (§3b: `croft query "from 'files/sales/*.csv'"` to look at a file without making an
  // asset) used to fail with DB_NOT_FOUND in a project that had not run anything, with a bare `croft run` (which
  // fetches every ingest) as its fix. With no warehouse, query now runs on a sandboxed in-memory DuckDB and
  // creates nothing; a table named before its first run is DB_NOT_FOUND with the run that builds that asset.
  test("the zero-asset path works in a fresh project, before any run", async () => {
    const { project: p } = await initProject();
    const r = await p.json(["query", "select count(*) n from 'files/example_sales.csv'"]);
    expect(r.code, show(r)).toBe(0);
    expect(r.json.data.rows[0].n).toBe(120);
    expect(p.exists("warehouse.duckdb")).toBe(false);
    const table = await p.json(["query", "select count(*) n from example_sales"]);
    expect(table.code, show(table)).toBe(2);
    expect(findProblem(table.json, "DB_NOT_FOUND"), show(table)).toMatchObject({ fix: { command: "croft run example_sales" } });
    expect(p.exists("warehouse.duckdb")).toBe(false);
  }, 60_000);

  // Fixed: `croft run order` with assets/order.ts present said "there is no asset named order" (and listed the
  // other assets) instead of NAME_RESERVED with the rename fix, so an agent that had just written the file was
  // told it did not exist. A selector naming a file discovery refused now reports that file's own problem.
  test("running an asset whose file name is reserved reports NAME_RESERVED, not 'no asset named'", async () => {
    api.route("/orders", () => json([{ id: 1 }]));
    const { project: p } = await initProject();
    p.write("assets/order.ts", `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", async *rows({ http }) { yield (await http.get("${api.url}/orders")).json<Record<string, unknown>[]>(); } });
`);
    const r = await p.json(["run", "order"]);
    expect(r.code, show(r)).toBe(2);
    expect(findProblem(r.json, "NAME_RESERVED"), show(r)).toBeDefined();
  }, 60_000);

  // BUG (reported): §4.3 says a number in a JSON column that DOUBLE cannot hold (1e400) keeps its source text,
  // but res.json() turns it into Infinity and staging then fails the whole load with UNSERIALIZABLE_VALUE, whose
  // hint blames the asset code ("yield null (or a string)") for valid JSON the API sent. Flip to test() once fixed.
  bugTest("an API number beyond DOUBLE inside a JSON column keeps its source text", async () => {
    api.route("/huge", () => rawJson(`[{"id": 1, "payload": {"k": 1, "huge": 1e400}}]`));
    const { project: p } = await initProject();
    p.write("assets/huge.ts", `import { ingest } from "@zabaca/croft";
export default ingest({ key: "id", async *rows({ http }) { yield (await http.get("${api.url}/huge")).json<Record<string, unknown>[]>(); } });
`);
    const r = await p.json(["run", "huge"]);
    expect(r.code, show(r)).toBe(0);
    const q = await p.json(["query", "select payload from huge"]);
    expect(q.stdout).toContain("1e400");
  }, 60_000);
});

// croft new (DESIGN.md §4.1, §4.2 "croft new api stripe_charges --pagination cursor", §3): the output, the --json data,
// next[], the input an sql or transform template reads, and every refusal (NAME_CONFLICT, NAME_INVALID, NAME_RESERVED,
// USAGE_ERROR with a did-you-mean, INPUT_NEEDS_KEY). The templates themselves are tested in agent/new.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateFor } from "../../agent/new.ts";
import { putCatalog } from "../../history/catalog.ts";
import { cleanup, cli, ISSUES_CATALOG, makeProject, runsDb, SRC, type TestProject } from "./inspect-testkit.ts";
import { formatList, type NewAssetData, type NewListData } from "./new.ts";

afterAll(async () => {
  await cleanup();
});

const EXAMPLE_TS = readFileSync(join(SRC, "agent/project/assets/example_sales.ts"), "utf8");
const KEYED = (key: string) => `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/x.csv", key: "${key}" });\n`;
const KEYLESS = `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/y.csv" });\n`;

/** A project as croft init leaves it: example_sales. */
function newProject(files: Record<string, string> = {}): TestProject {
  return makeProject({ timezone: "UTC", files: { "assets/example_sales.ts": EXAMPLE_TS, ...files } });
}

/** Set a file's modification time, seconds after an arbitrary start: which asset changed most recently. */
function touch(p: TestProject, rel: string, second: number): void {
  const t = new Date(Date.UTC(2026, 8, 22, 12, 0, second));
  utimesSync(join(p.root, rel), t, t);
}

describe("croft new <kind> <name>", () => {
  test("§4.2: Created, Edit, and next asks the user for the secret first", async () => {
    const p = newProject();
    const r = await cli(["new", "api", "stripe_charges", "--pagination", "cursor"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "Created assets/stripe_charges.ts (cursor pagination: starting_after/has_more).",
      "Edit: the URL, the cursor field and whether records change after creation (see comments).",
      "next: croft secrets  # ask the user to add STRIPE_KEY=... to .env (or to run croft secrets set STRIPE_KEY in their terminal); "
      + "never read .env yourself. Once croft secrets shows it set and your edits pass croft validate: croft preview stripe_charges",
    ]);
    expect(readFileSync(join(p.root, "assets/stripe_charges.ts"), "utf8")).toBe(templateFor("api", "stripe_charges", { pagination: "cursor" }).content);
  });

  test("--json: the data, and croft preview next once the secret is set", async () => {
    const p = newProject({ ".env": "STRIPE_KEY=sk_test_abcdefgh\n" });
    const r = await cli(["new", "api", "stripe_charges", "--pagination", "cursor", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "new", problems: [] });
    const d = r.json.data as NewAssetData;
    expect(Object.keys(d)).toEqual(["asset", "kind", "pagination", "file", "what", "edit", "reads", "secrets", "created"]);
    expect(d).toEqual({
      asset: "stripe_charges", kind: "api", pagination: "cursor", file: "assets/stripe_charges.ts",
      what: "cursor pagination: starting_after/has_more",
      edit: "the URL, the cursor field and whether records change after creation (see comments)",
      reads: null, secrets: [{ name: "STRIPE_KEY", status: "set" }], created: ["assets/stripe_charges.ts"],
    });
    expect(r.json.next).toEqual([{
      command: "croft preview stripe_charges",
      reason: "after your edits pass croft validate: fetches up to 1,000 rows into a sandbox; nothing is saved and the cursor does not move",
    }]);
    expect(r.stdout).not.toContain("sk_test_abcdefgh");
  });

  test("a secret set in the shell counts as set", async () => {
    const p = newProject();
    const r = await cli(["new", "api", "github_issues", "--pagination", "keyset", "--json"], { cwd: p.root, env: { GITHUB_KEY: "ghp_shell_value_1" } });
    expect(r.json.data.secrets).toEqual([{ name: "GITHUB_KEY", status: "set" }]);
    expect(r.json.next[0].command).toBe("croft preview github_issues");
  });

  test("api without --pagination writes the cursor style and says it chose the default", async () => {
    const p = newProject();
    const r = await cli(["new", "api", "orders"], { cwd: p.root });
    expect(r.exit).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("Created assets/orders.ts (cursor pagination: starting_after/has_more).");
    expect(lines[1]).toBe("Pagination: cursor, the default; croft new --list says when keyset, link or page fits the API better.");
    expect(readFileSync(join(p.root, "assets/orders.ts"), "utf8")).toContain("secrets: [\"ORDERS_KEY\"],");
  });

  test("each api style writes its own template", async () => {
    const p = newProject();
    for (const style of ["keyset", "cursor", "link", "page"] as const) {
      const r = await cli(["new", "api", `${style}_items`, `--pagination=${style}`, "--json"], { cwd: p.root });
      expect(r.exit, style).toBe(0);
      expect(r.json.data.pagination).toBe(style);
      expect(readFileSync(join(p.root, `assets/${style}_items.ts`), "utf8")).toBe(templateFor("api", `${style}_items`, { pagination: style }).content);
    }
  });

  test("file: writes the ingest and makes its folder under files/; next is the preview", async () => {
    const p = newProject();
    const r = await cli(["new", "file", "sales", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data).toMatchObject({ asset: "sales", kind: "file", pagination: null, reads: null, secrets: [], created: ["assets/sales.ts", "files/sales/"] });
    expect(existsSync(join(p.root, "files/sales"))).toBe(true);
    expect(r.json.next).toEqual([{
      command: "croft preview sales",
      reason: "after putting CSV files in files/sales/ and setting key (croft validate checks the edit): loads them into a sandbox; nothing is saved",
    }]);
    const human = await cli(["new", "file", "returns"], { cwd: p.root });
    expect(human.stdout.split("\n").slice(0, 3)).toEqual([
      "Created assets/returns.ts (file ingest: the CSV files in files/returns/, new and changed files only).",
      "Created files/returns/ (put the CSV files here).",
      "Edit: put the CSV files in files/returns/, then set key to the column that identifies a row (see comments).",
    ]);
  });

  test("file: a folder that already holds CSV files is kept, and next skips putting files there", async () => {
    const p = newProject({ "files/orders/2026-01.csv": "id,amount\n1,10\n" });
    const r = await cli(["new", "file", "orders", "--json"], { cwd: p.root });
    expect(r.json.data.created).toEqual(["assets/orders.ts"]);
    expect(r.json.next[0]).toEqual({
      command: "croft preview orders",
      reason: "after setting key to the column that identifies a row (croft validate checks the edit): loads files/orders/ into a sandbox; nothing is saved",
    });
  });

  test("sql: reads the asset changed most recently, keeps its key, and validates as written", async () => {
    const p = newProject({ "assets/customers.ts": KEYED("customer_id") });
    touch(p, "assets/example_sales.ts", 1);
    touch(p, "assets/customers.ts", 2);
    const r = await cli(["new", "sql", "customer_list", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data).toMatchObject({
      asset: "customer_list", kind: "sql", file: "assets/customer_list.sql", reads: "customers",
      what: "SQL transform over customers",
      edit: "the SELECT (it reads customers, the asset changed most recently), the key and the check (see comments)",
      created: ["assets/customer_list.sql"],
    });
    const text = readFileSync(join(p.root, "assets/customer_list.sql"), "utf8");
    expect(text).toContain("-- key: customer_id\n");
    expect(text).toContain("FROM customers\n");
    expect(r.json.next).toEqual([{
      command: "croft preview customer_list",
      reason: "after editing the SELECT (croft validate binds it against the columns of customers): builds it in a sandbox and diffs it; nothing real changes",
    }]);
    const v = await cli(["validate", "--json"], { cwd: p.root });
    expect(v.json.problems.filter((x: { severity: string }) => x.severity !== "info")).toEqual([]);
    expect(v.exit).toBe(0);
  }, 30_000);

  test("sql: an asset file that is neither an ingest nor a transform is not read, however recent", async () => {
    const p = newProject({ "assets/scratch.ts": "export const x = 1;\n" });
    touch(p, "assets/example_sales.ts", 1);
    touch(p, "assets/scratch.ts", 2);
    const r = await cli(["new", "sql", "sales_list", "--json"], { cwd: p.root });
    expect(r.json.data).toMatchObject({ reads: "example_sales" });
    expect(r.json.data.edit).toContain("the project's only asset");
  }, 30_000);

  test("sql: an input without a key gets no key line; the only asset is named as such", async () => {
    const p = makeProject({ timezone: "UTC", files: { "assets/events.ts": KEYLESS } });
    const r = await cli(["new", "sql", "event_list", "--json"], { cwd: p.root });
    expect(r.json.data.reads).toBe("events");
    expect(r.json.data.edit).toBe("the SELECT (it reads events, the project's only asset), the key and the check (see comments)");
    const text = readFileSync(join(p.root, "assets/event_list.sql"), "utf8");
    expect(text).not.toMatch(/^-- key:/m);
    expect(text).toContain("events has no key.");
  }, 30_000);

  test("transform: reads the most recent asset with a key (newRows() needs one), and validates as written", async () => {
    const p = newProject({ "assets/events.ts": KEYLESS, "assets/customers.ts": KEYED("customer_id") });
    touch(p, "assets/customers.ts", 1);
    touch(p, "assets/example_sales.ts", 2);
    touch(p, "assets/events.ts", 3);
    const r = await cli(["new", "transform", "sale_labels", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect(r.json.data).toMatchObject({ kind: "transform", reads: "example_sales", secrets: [] });
    expect(r.json.data.edit).toContain("they read example_sales, the asset with a key changed most recently");
    const only = newProject({ "assets/events.ts": KEYLESS });
    const o = await cli(["new", "transform", "sale_labels", "--json"], { cwd: only.root });
    expect(o.json.data.edit).toContain("they read example_sales, the project's only asset with a key");
    expect(readFileSync(join(p.root, "assets/sale_labels.ts"), "utf8")).toContain("newRows<Input>(\"example_sales\")");
    expect(r.json.next).toEqual([{
      command: "croft preview sale_labels --rows 20",
      reason: "after your edits pass croft validate: at most 20 input rows reach the code (keep --rows small once it makes paid calls); nothing real changes",
    }]);
    const v = await cli(["validate", "--json"], { cwd: p.root });
    expect(v.json.problems.filter((x: { severity: string }) => x.severity !== "info")).toEqual([]);
  }, 30_000);

  test("transform: refused with INPUT_NEEDS_KEY when no asset has a key", async () => {
    const p = makeProject({ timezone: "UTC", files: { "assets/events.ts": KEYLESS } });
    const r = await cli(["new", "transform", "event_labels", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    const x = r.json.problems[0];
    expect(x).toMatchObject({
      code: "INPUT_NEEDS_KEY",
      message: "a TypeScript transform reads its input with newRows(), which needs a key, and no asset of this project has one (events)",
      fix: { kind: "edit", file: "assets/events.ts" }, effect: "nothing was written",
    });
    expect(x.hint).toContain("croft new transform event_labels");
    expect(existsSync(join(p.root, "assets/event_labels.ts"))).toBe(false);
  }, 30_000);

  test("sql and transform: refused when assets/ has nothing to read", async () => {
    const p = makeProject({ timezone: "UTC" });
    for (const kind of ["sql", "transform"]) {
      const r = await cli(["new", kind, "x_items", "--json"], { cwd: p.root });
      expect(r.exit, kind).toBe(2);
      expect(r.json.problems[0]).toMatchObject({
        code: "USAGE_ERROR", fix: { kind: "command", command: "croft new --list" }, effect: "nothing was written",
      });
      expect(r.json.problems[0].message).toContain("assets/ has none yet");
      expect(r.json.problems[0].hint).toBe("bring data in first: croft new api <name> for an API, or croft new file <name> for files");
    }
  });

  test("makes assets/ when the project has none", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "croft-new-")));
    try {
      writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "UTC" }));
      const r = await cli(["new", "api", "orders", "--json"], { cwd: root });
      expect(r.exit).toBe(0);
      expect(existsSync(join(root, "assets/orders.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refusals: nothing is written", () => {
  test("NAME_CONFLICT: a file of that name exists (any extension, any folder), with a free name as the fix", async () => {
    const p = newProject({ "assets/stripe/charges.sql": "SELECT 1 AS id\n" });
    const before = readFileSync(join(p.root, "assets/example_sales.ts"), "utf8");
    const same = await cli(["new", "api", "example_sales", "--pagination", "page", "--json"], { cwd: p.root });
    expect(same.exit).toBe(2);
    expect(same.json.problems[0]).toMatchObject({
      code: "NAME_CONFLICT", file: "assets/example_sales.ts",
      message: "assets/example_sales.ts already defines the asset example_sales; croft new never overwrites a file",
      hint: "edit assets/example_sales.ts instead, or choose another name: croft new api example_sales_2 --pagination page",
      fix: { kind: "command", command: "croft new api example_sales_2 --pagination page" }, effect: "nothing was written",
    });
    expect(readFileSync(join(p.root, "assets/example_sales.ts"), "utf8")).toBe(before);
    const other = await cli(["new", "transform", "charges", "--json"], { cwd: p.root });
    expect(other.json.problems[0]).toMatchObject({ code: "NAME_CONFLICT", file: "assets/stripe/charges.sql" });
    expect(existsSync(join(p.root, "assets/charges.ts"))).toBe(false);
  });

  test("NAME_CONFLICT: a table of that name exists whose asset file is gone", async () => {
    const p = newProject();
    const db = runsDb(p.stateDir);
    putCatalog(db, ISSUES_CATALOG);
    db.close();
    const r = await cli(["new", "api", "github_issues", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    expect(r.json.problems[0]).toMatchObject({
      code: "NAME_CONFLICT",
      message: "github_issues already names a table (18,556 rows) whose asset file is gone; a new asset of that name would write into it",
      fix: { kind: "command", command: "croft new api github_issues_2" },
      details: { name: "github_issues", rows: 18556 },
    });
    expect(r.json.problems[0].hint).toContain("ask the user what should become of the table github_issues");
    expect(existsSync(join(p.root, "assets/github_issues.ts"))).toBe(false);
  });

  test("NAME_INVALID and NAME_RESERVED, each with a usable name in the fix", async () => {
    const p = newProject();
    const cases: [string, string, string][] = [
      ["Stripe-Charges", "NAME_INVALID", "stripe_charges"],
      ["2024_orders", "NAME_INVALID", "t_2024_orders"],
      ["order", "NAME_RESERVED", "orders"],
      ["new", "NAME_RESERVED", "new_data"],
      ["_staging", "NAME_RESERVED", "staging"],
    ];
    for (const [name, code, to] of cases) {
      const r = await cli(["new", "sql", name, "--json"], { cwd: p.root });
      expect(r.exit, name).toBe(2);
      expect(r.json.problems[0], name).toMatchObject({
        code, fix: { kind: "command", command: `croft new sql ${to}` }, effect: "nothing was written", details: { name, suggestion: to },
      });
      expect(r.json.problems[0].hint, name).toBe(`use a name that works as a table name: croft new sql ${to}`);
    }
    // A file name or a path means the name inside it.
    for (const [name, to] of [["stripe_charges.ts", "stripe_charges"], ["assets/daily.sql", "daily"], ["orders.csv", "orders_csv"]]) {
      const r = await cli(["new", "sql", name!, "--json"], { cwd: p.root });
      expect(r.json.problems[0], name).toMatchObject({ code: "NAME_INVALID", fix: { command: `croft new sql ${to}` }, details: { name, suggestion: to } });
    }
    const keyword = await cli(["new", "api", "order", "--pagination", "keyset", "--json"], { cwd: p.root });
    expect(keyword.json.problems[0].message).toBe("\"order\" is an SQL keyword, so `FROM order` would be a syntax error in every asset that reads it; use orders");
    expect(keyword.json.problems[0].fix.command).toBe("croft new api orders --pagination keyset");
    expect(existsSync(join(p.root, "assets/order.ts"))).toBe(false);
  });

  test("a bad --pagination is USAGE_ERROR with a did-you-mean", async () => {
    const p = newProject();
    const typo = await cli(["new", "api", "stripe_charges", "--pagination", "curser", "--json"], { cwd: p.root });
    expect(typo.exit).toBe(2);
    expect(typo.json.problems[0]).toMatchObject({
      code: "USAGE_ERROR", message: "unknown pagination \"curser\"; the styles are keyset, cursor, link and page",
      hint: "did you mean croft new api stripe_charges --pagination cursor?",
      fix: { kind: "command", command: "croft new api stripe_charges --pagination cursor" },
    });
    const far = await cli(["new", "api", "stripe_charges", "--pagination", "offset", "--json"], { cwd: p.root });
    expect(far.json.problems[0]).toMatchObject({ code: "USAGE_ERROR", fix: { kind: "command", command: "croft new --list" } });
    expect(far.json.problems[0].hint).toBe("croft new --list says when each style applies");
    const notApi = await cli(["new", "file", "sales", "--pagination", "page", "--json"], { cwd: p.root });
    expect(notApi.json.problems[0]).toMatchObject({
      code: "USAGE_ERROR", message: "--pagination is for api templates; a file template has no pages",
      fix: { kind: "command", command: "croft new file sales" },
    });
    expect(existsSync(join(p.root, "assets/stripe_charges.ts")) || existsSync(join(p.root, "assets/sales.ts"))).toBe(false);
  });

  test("a bad kind or a missing argument is USAGE_ERROR that shows the way", async () => {
    const p = newProject();
    const run = async (...args: string[]) => (await cli(["new", ...args, "--json"], { cwd: p.root })).json.problems[0];
    expect(await run("trasnform", "labels")).toMatchObject({
      code: "USAGE_ERROR", message: "croft new has no kind \"trasnform\"; the kinds are api, file, sql and transform",
      hint: "did you mean croft new transform labels?", fix: { kind: "command", command: "croft new transform labels" },
    });
    expect(await run("ingest", "orders")).toMatchObject({
      code: "USAGE_ERROR", hint: "an ingest is croft new api orders (from an API) or croft new file orders (from files)",
      fix: { kind: "command", command: "croft new --list" },
    });
    expect(await run("csv", "orders")).toMatchObject({ fix: { kind: "command", command: "croft new file orders" } });
    expect(await run("api")).toMatchObject({
      code: "USAGE_ERROR", message: "croft new api needs the new asset's name",
      hint: "e.g. croft new api stripe_charges; the name becomes the table's name", fix: { kind: "command", command: "croft new --list" },
    });
    expect(await run("stripe_charges")).toMatchObject({
      code: "USAGE_ERROR", message: "croft new needs a kind before the name: api, file, sql or transform",
      hint: "e.g. croft new api stripe_charges (croft new --list says when each applies)", fix: { kind: "command", command: "croft new --list" },
    });
    expect(await run()).toMatchObject({ code: "USAGE_ERROR", message: "croft new needs a kind and a name", fix: { kind: "command", command: "croft new --list" } });
  });

  test("outside a project: PROJECT_NOT_FOUND", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-new-none-")));
    try {
      const r = await cli(["new", "api", "orders", "--json"], { cwd: dir });
      expect(r.exit).toBe(2);
      expect(r.json.problems[0].code).toBe("PROJECT_NOT_FOUND");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("croft new --list", () => {
  test("--json: every kind and style with its command and when it applies; works outside a project", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-new-list-")));
    try {
      const r = await cli(["new", "--list", "--json"], { cwd: dir });
      expect(r.exit).toBe(0);
      const d = r.json.data as NewListData;
      expect(d.templates.map((t) => t.command)).toEqual([
        "croft new api <name> --pagination keyset", "croft new api <name> --pagination cursor", "croft new api <name> --pagination link",
        "croft new api <name> --pagination page", "croft new file <name>", "croft new sql <name>", "croft new transform <name>",
      ]);
      expect(d.templates[1]).toMatchObject({ kind: "api", pagination: "cursor", default: true });
      expect(d.templates[4]).toMatchObject({ kind: "file", pagination: null, default: false });
      expect(r.json.next).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("human: one line per template, the default marked", async () => {
    const p = newProject();
    const r = await cli(["new", "--list"], { cwd: p.root });
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("croft new writes a commented, working template to assets/<name>.ts (.sql for sql); edit it, then croft validate.");
    expect(lines).toContain(`  croft new api <name> --pagination cursor   (the default for api) newest first, paged by the API's own cursor (starting_after/has_more, next_page_token): Stripe and most list endpoints`);
    expect(lines.at(-1)).toBe("  croft new transform <name>                 per-row TypeScript over another asset, such as one API or LLM call per row; incremental");
    expect(formatList((await cli(["new", "--list", "--json"], { cwd: p.root })).json.data).split("\n").length).toBe(8);
  });
});

describe("the docs pages point at croft new", () => {
  test("ingest, sql and transforms name the command that writes their templates", async () => {
    const page = async (name: string) => (await cli(["docs", name, "--json"], { cwd: tmpdir() })).json.data.page as string;
    const ingest = await page("ingest");
    for (const s of ["croft new api <name> --pagination keyset", "croft new api <name> --pagination cursor", "croft new api <name> --pagination link",
      "croft new api <name> --pagination page", "croft new file <name>", "croft new --list"]) expect(ingest, s).toContain(s);
    expect(await page("sql")).toContain("croft new sql <name>");
    expect(await page("transforms")).toContain("croft new transform <name>");
  });
});


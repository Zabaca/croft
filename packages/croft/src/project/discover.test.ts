import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverAssets, nameProblem, plural, sqlKeywordNames, suggestName } from "./discover.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-discover-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>): string {
  const root = join(base, `p${n++}`);
  mkdirSync(root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe("sqlKeywordNames", () => {
  test("has DuckDB's 75 reserved keywords plus the type_function keywords that break FROM", async () => {
    const kw = await sqlKeywordNames();
    for (const w of ["order", "end", "limit", "window", "group", "select", "table", "pivot", "qualify"]) expect(kw.has(w)).toBe(true);
    // Not reserved, but `FROM left` / `FROM join` are syntax errors all the same.
    for (const w of ["left", "join", "like", "cross", "natural"]) expect(kw.has(w)).toBe(true);
    // Keywords that work unquoted as table names are not rejected.
    for (const w of ["user", "type", "position", "map", "struct", "columns", "orders", "new", "croft"]) expect(kw.has(w)).toBe(false);
    expect(kw.size).toBe(75 + 30);
  });

  test("is cached per process", async () => {
    expect(await sqlKeywordNames()).toBe(await sqlKeywordNames());
  });
});

describe("name rules", () => {
  const kw = new Set(["order", "group", "end", "limit", "window", "left", "class"]);
  const check = (name: string, file = `assets/${name}.ts`) => nameProblem(name, file, kw);

  test("valid names pass", () => {
    for (const name of ["github_issues", "a", "t2", "stripe_charges_v2", "x_"]) expect(check(name)).toBeNull();
  });

  test("NAME_INVALID for uppercase, dashes, dots, leading digits", () => {
    const p = check("GitHub-Issues")!;
    expect(p.code).toBe("NAME_INVALID");
    expect(p.message).toContain('"GitHub-Issues" is not a valid asset name');
    expect(p.hint).toBe("rename the file to git_hub_issues.ts");
    expect(p.fix).toEqual({ kind: "manual", description: "rename assets/GitHub-Issues.ts to assets/git_hub_issues.ts (and update assets that read GitHub-Issues)" });
    expect(check("2024_sales")!.details).toMatchObject({ suggestion: "t_2024_sales" });
    expect(check("stripeCharges")!.details).toMatchObject({ suggestion: "stripe_charges" });
    const dotted = check("issues.test", "assets/github/issues.test.ts")!;
    expect(dotted.code).toBe("NAME_INVALID");
    expect(dotted.hint).toContain("put tests and shared code in lib/");
    expect(dotted.fix).toMatchObject({ description: expect.stringContaining("to assets/github/issues_test.ts") });
  });

  test("NAME_RESERVED for new, croft and leading underscores", () => {
    for (const name of ["new", "croft"]) {
      const p = check(name)!;
      expect(p.code).toBe("NAME_RESERVED");
      expect(p.details).toMatchObject({ suggestion: `${name}_data`, reason: "reserved" });
    }
    const u = check("_staging", "assets/_staging.sql")!;
    expect(u.code).toBe("NAME_RESERVED");
    expect(u.message).toContain('cannot start with "_"');
    expect(u.hint).toBe("rename the file to staging.sql");
    // "_Foo" is reserved first, whatever else is wrong with it.
    expect(check("_Foo")!.code).toBe("NAME_RESERVED");
  });

  test("NAME_RESERVED for SQL keywords, with a suggested plural", () => {
    const p = check("order", "assets/shop/order.sql")!;
    expect(p.code).toBe("NAME_RESERVED");
    expect(p.message).toBe('"order" is an SQL keyword, so `FROM order` would be a syntax error in every asset that reads it; rename to orders');
    expect(p.fix).toEqual({ kind: "manual", description: "rename assets/shop/order.sql to assets/shop/orders.sql (and update assets that read order)" });
    expect(check("window")!.details).toMatchObject({ suggestion: "windows" });
    expect(check("class")!.details).toMatchObject({ suggestion: "classes" });
    expect(check("left")!.code).toBe("NAME_RESERVED");
  });

  test("suggestName and plural", () => {
    expect(suggestName("Sales Report (2024)")).toBe("sales_report_2024");
    expect(suggestName("---")).toBe("asset");
    expect(suggestName("order", new Set(["order"]))).toBe("orders");
    expect(suggestName("new")).toBe("new_data");
    expect(plural("entry")).toBe("entries");
    expect(plural("day")).toBe("days");
    expect(plural("box")).toBe("boxes");
    expect(plural("match")).toBe("matches");
  });
});

describe("discoverAssets", () => {
  test("finds .ts and .sql at any depth, sorted by name, with root-relative files", async () => {
    const root = project({
      "assets/github/github_issues.ts": "",
      "assets/open_issues.sql": "",
      "assets/reports/daily/daily_revenue.sql": "",
      "assets/README.md": "",
      "assets/types.d.ts": "",
      "assets/.scratch.ts": "",
      "lib/triage.ts": "",
    });
    const d = await discoverAssets(root);
    expect(d.problems).toEqual([]);
    expect(d.assets).toEqual([
      { name: "daily_revenue", file: "assets/reports/daily/daily_revenue.sql", path: join(root, "assets/reports/daily/daily_revenue.sql"), kind: "sql" },
      { name: "github_issues", file: "assets/github/github_issues.ts", path: join(root, "assets/github/github_issues.ts"), kind: "ts" },
      { name: "open_issues", file: "assets/open_issues.sql", path: join(root, "assets/open_issues.sql"), kind: "sql" },
    ]);
  });

  test("a project without assets/ has no assets and no problems", async () => {
    expect(await discoverAssets(project({ "croft.json": "{}" }))).toEqual({ assets: [], problems: [] });
  });

  test("NAME_CONFLICT for a .ts and a .sql with the same name; neither is returned", async () => {
    const root = project({ "assets/orders_clean.ts": "", "assets/orders_clean.sql": "", "assets/ok.sql": "" });
    const d = await discoverAssets(root);
    expect(d.assets.map((a) => a.name)).toEqual(["ok"]);
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0]).toMatchObject({
      code: "NAME_CONFLICT",
      severity: "error",
      message: "assets/orders_clean.sql and assets/orders_clean.ts both define the asset orders_clean; a .ts and a .sql file cannot share a name",
      details: { name: "orders_clean", files: ["assets/orders_clean.sql", "assets/orders_clean.ts"] },
    });
  });

  test("NAME_CONFLICT for the same name in two folders", async () => {
    const root = project({ "assets/a/events.sql": "", "assets/b/events.sql": "" });
    const d = await discoverAssets(root);
    expect(d.assets).toEqual([]);
    expect(d.problems[0]!.code).toBe("NAME_CONFLICT");
    expect(d.problems[0]!.message).toContain("unique across assets/, whatever the folder");
  });

  test("invalid and reserved names are reported and skipped; the rest still load", async () => {
    const root = project({
      "assets/order.sql": "",
      "assets/Bad-Name.ts": "",
      "assets/_private.sql": "",
      "assets/new.sql": "",
      "assets/good.ts": "",
    });
    const d = await discoverAssets(root);
    expect(d.assets.map((a) => a.name)).toEqual(["good"]);
    expect(d.problems.map((p) => [p.code, p.file])).toEqual([
      ["NAME_INVALID", "assets/Bad-Name.ts"],
      ["NAME_RESERVED", "assets/_private.sql"],
      ["NAME_RESERVED", "assets/new.sql"],
      ["NAME_RESERVED", "assets/order.sql"],
    ]);
  });

  test("uses the real DuckDB keyword list by default", async () => {
    const root = project({ "assets/limit.sql": "", "assets/join.sql": "", "assets/user.sql": "" });
    const d = await discoverAssets(root);
    expect(d.assets.map((a) => a.name)).toEqual(["user"]);
    expect(d.problems.map((p) => p.details?.suggestion)).toEqual(["joins", "limits"]);
  });
});

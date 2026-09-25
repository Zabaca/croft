// The templates `croft new` writes (agent/new.ts; DESIGN.md §3a–§3e, §4.2): each says when it applies, uses the
// public API the way §3 does, names only commands and flags this build has, type-checks against the real API, and
// passes croft validate as written in a project.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { putCatalog, type CatalogAsset } from "../history/catalog.ts";
import { renderTypes, type TypeSource } from "../project/types-gen.ts";
import { ProjectEnv } from "../project/env.ts";
import { parseSqlHeader } from "../project/sql-asset.ts";
import { validateProject } from "../cli/commands/validate.ts";
import { cleanup, makeProject, runsDb, SRC, writeFiles } from "../cli/commands/inspect-testkit.ts";
import { scan } from "./contract-testkit.ts";
import {
  DEFAULT_PAGINATION, EXAMPLE_INPUT, NEW_KINDS, type NewKind, type Pagination, PAGINATIONS, secretNameFor, type Template,
  TEMPLATE_KINDS, templateFor, titleWords,
} from "./new.ts";
import { tsconfigJson } from "./templates.ts";
import type { AssetDefinition, Http, HttpInit, HttpResponse, Row } from "../types.ts";

afterAll(async () => {
  await cleanup();
});

/** Every template: each api style, then file, sql and transform. */
function every(name: (kind: NewKind, pagination?: Pagination) => string): Template[] {
  return [
    ...PAGINATIONS.map((p) => templateFor("api", name("api", p), { pagination: p })),
    templateFor("file", name("file")),
    templateFor("sql", name("sql")),
    templateFor("transform", name("transform")),
  ];
}

const named = (kind: NewKind, pagination?: Pagination) => (pagination ? `${pagination}_items` : `${kind}_items`);

describe("the kinds and styles", () => {
  test("--list covers every kind and every api style once, and cursor is the default", () => {
    expect(TEMPLATE_KINDS.map((k) => `${k.kind}${k.pagination ? ` ${k.pagination}` : ""}`)).toEqual([
      "api keyset", "api cursor", "api link", "api page", "file", "sql", "transform",
    ]);
    expect(TEMPLATE_KINDS.filter((k) => k.default).map((k) => k.pagination)).toEqual([DEFAULT_PAGINATION]);
    expect(DEFAULT_PAGINATION).toBe("cursor");
    expect(new Set(TEMPLATE_KINDS.map((k) => k.kind))).toEqual(new Set(NEW_KINDS));
    for (const k of TEMPLATE_KINDS) expect(k.description.length, k.description).toBeLessThanOrEqual(120);
    expect(templateFor("api", "x_items").pagination).toBe("cursor");
  });

  test("names in templates: the secret after the name's first word (§4.2), and a readable description", () => {
    expect(secretNameFor("stripe_charges")).toBe("STRIPE_KEY");
    expect(secretNameFor("github_issues")).toBe("GITHUB_KEY");
    expect(secretNameFor("orders")).toBe("ORDERS_KEY");
    expect(secretNameFor("hn_stories")).toBe("HN_STORIES_KEY");
    expect(titleWords("stripe_charges")).toBe("Stripe charges");
    expect(titleWords("t2024_q1")).toBe("T2024 q1");
  });
});

describe("every template", () => {
  test("is named after its file, says when it applies and what to edit, and summarizes itself in one line", () => {
    for (const t of every(named)) {
      const name = named(t.kind, t.pagination);
      const first = t.content.split("\n")[0]!;
      if (t.kind === "sql") {
        expect(t.path).toBe(`assets/${name}.sql`);
        expect(first).toStartWith(`-- assets/${name}.sql: `);
      } else {
        expect(t.path).toBe(`assets/${name}.ts`);
        expect(first).toStartWith(`// assets/${name}.ts: `);
      }
      expect(first).toContain(`(croft new ${t.kind} ${name}${t.kind === "api" ? ` --pagination ${t.pagination}` : ""})`);
      expect(t.content, name).toContain("When this applies: ");
      expect(t.content, name).toContain("To edit: ");
      expect(t.content.endsWith("\n") && !t.content.endsWith("\n\n"), name).toBe(true);
      expect(t.summary).toBe(`${t.what}. Edit: ${t.edit}`);
      expect(t.what.includes("\n") || t.edit.includes("\n")).toBe(false);
      expect(t.edit, name).toEndWith("(see comments)");
    }
  });

  test("names only commands and flags this build has (the agent contract)", () => {
    for (const t of every(named)) {
      expect(scan(t.path, t.content), t.path).toEqual([]);
      expect(scan(t.path, `${t.what} ${t.edit}`), t.path).toEqual([]);
    }
    expect(TEMPLATE_KINDS.flatMap((k) => scan("TEMPLATE_KINDS", k.description))).toEqual([]);
  });

  test("keeps comment lines within the width, and never splits a croft command over two lines", () => {
    for (const t of every(named)) {
      for (const line of t.content.split("\n")) {
        if (/^\s*(\/\/|--)/.test(line) && !/^(\/\/|--) assets\//.test(line)) expect(line.length, line).toBeLessThanOrEqual(120);
        expect(line, t.path).not.toMatch(/\bcroft$/);
      }
    }
  });
});

describe("api templates (§3a)", () => {
  const api = (p: Pagination) => templateFor("api", "stripe_charges", { pagination: p });

  test("read their secret with ctx.secret, fetch with ctx.http, parse with res.json(), and set a key", () => {
    for (const p of PAGINATIONS) {
      const t = api(p);
      expect(t.secrets).toEqual(["STRIPE_KEY"]);
      expect(t.content).toContain("secrets: [\"STRIPE_KEY\"],");
      expect(t.content).toContain("Authorization: `Bearer ${secret(\"STRIPE_KEY\")}`");
      expect(t.content).toContain("http.get(\"https://api.example.com/v1/charges\"");
      expect(t.content).toMatch(/res\.json<[A-Za-z[\]]+>\(\)/);
      expect(t.content).toContain("key: \"id\",");
      expect(t.content).toContain("description: \"Stripe charges\",");
      expect(t.content).toContain("// schedule: ");
      expect(t.content).not.toMatch(/\bfetch\(|JSON\.parse/);
      expect(t.content).toContain("add STRIPE_KEY=... there");
    }
  });

  test("keyset: ascending since, re-queried from the newest value seen, and KEYSET_STUCK when a page cannot move", () => {
    const t = api("keyset");
    expect(t.what).toBe("keyset pagination: ascending since");
    expect(t.content).toContain("import { fail, ingest } from \"@zabaca/croft\";");
    expect(t.content).toContain("incremental: \"updated_at\",");
    expect(t.content).toContain("query: { sort: \"updated_at\", direction: \"asc\", per_page: PAGE_SIZE, since: from },");
    expect(t.content).toContain("if (last === from) fail(\"KEYSET_STUCK\"");
    expect(t.content).toContain("from = last;");
    expect(t.content).toContain("use the cursor style instead (croft new --list)");
  });

  test("cursor: starting_after/has_more over a newest-first list, filtered by since, an epoch cursor with unit and lookback", () => {
    const t = api("cursor");
    expect(t.what).toBe("cursor pagination: starting_after/has_more");
    // DESIGN.md §4.2's Edit line, word for word.
    expect(t.edit).toBe("the URL, the cursor field and whether records change after creation (see comments)");
    expect(t.content).toContain("incremental: { field: \"created\", unit: \"s\", lookback: \"30 days\" },");
    expect(t.content).toContain("query: { limit: 100, \"created[gte]\": since, starting_after: after },");
    expect(t.content).toContain("if (!page.has_more || page.data.length === 0) return;");
    expect(t.content).toContain("after = page.data.at(-1)!.id;");
  });

  test("link: follows res.next from the Link header, filtered by an updated-since parameter", () => {
    const t = api("link");
    expect(t.what).toBe("Link header pagination: res.next");
    expect(t.content).toContain("incremental: \"updated_at\",");
    expect(t.content).toContain("query: { per_page: 100, updated_after: since },");
    expect(t.content).toContain("if (!res.next) return;");
    expect(t.content).toContain("res = await http.get(res.next, { headers });");
  });

  test("page: page/per_page until an empty page, re-read in full (no cursor), and says when that is safe", () => {
    const t = api("page");
    expect(t.what).toBe("page pagination: page/per_page until an empty page");
    expect(t.content).not.toContain("incremental");
    expect(t.content).toContain("for (let page = 1; ; page++) {");
    expect(t.content).toContain("query: { page, per_page: PAGE_SIZE },");
    expect(t.content).toContain("if (items.length === 0) return;");
    expect(t.content).toContain("use this only for data that does not change while it is read");
  });
});

describe("file, sql and transform templates", () => {
  test("file (§3b): a CSV glob in files/<name>/, incremental, with a key", () => {
    const t = templateFor("file", "sales");
    expect(t).toMatchObject({ kind: "file", path: "assets/sales.ts", secrets: [], folder: "files/sales/" });
    expect(t.content).toContain("file: \"files/sales/*.csv\",");
    expect(t.content).toContain("incremental: true,");
    expect(t.content).toContain("key: \"id\",");
    expect(t.edit).toBe("put the CSV files in files/sales/, then set key to the column that identifies a row (see comments)");
  });

  test("sql (§3c): a header with description, key and a check, then one SELECT over its input; the header parses clean", () => {
    const t = templateFor("sql", "daily_revenue", { input: { asset: "stripe_charges", key: ["id"], why: "the asset changed most recently" } });
    expect(t).toMatchObject({ kind: "sql", path: "assets/daily_revenue.sql", reads: "stripe_charges", secrets: [] });
    expect(t.what).toBe("SQL transform over stripe_charges");
    expect(t.edit).toBe("the SELECT (it reads stripe_charges, the asset changed most recently), the key and the check (see comments)");
    const { header, body, problems } = parseSqlHeader(t.content, t.path);
    expect(problems).toEqual([]);
    expect(header).toMatchObject({ description: "Daily revenue", key: ["id"], checks: ["min_rows(1)"], warnings: [] });
    expect(body.trim().split("\n")).toEqual([
      "SELECT",
      "  *                        -- list the columns it needs instead; rename them with AS",
      "FROM stripe_charges",
      "-- WHERE …                 -- keep only the rows it needs",
    ]);
    // Without an input, it reads what croft init makes.
    expect(templateFor("sql", "x_items").content).toContain("FROM example_sales");
  });

  test("sql: composite, quoted and missing keys; long names never wrap a plain comment into a header line", () => {
    const composite = parseSqlHeader(templateFor("sql", "by_region", { input: { asset: "daily_sales", key: ["day", "region"] } }).content, "x.sql");
    expect(composite.header.key).toEqual(["day", "region"]);
    expect(composite.problems).toEqual([]);
    const quoted = parseSqlHeader(templateFor("sql", "zones", { input: { asset: "taxi_zones", key: ["LocationID"] } }).content, "x.sql");
    expect(quoted.header.key).toEqual(["LocationID"]);
    const keyless = templateFor("sql", "events_daily", { input: { asset: "events", key: [] } });
    const parsed = parseSqlHeader(keyless.content, "x.sql");
    expect(parsed.problems).toEqual([]);
    expect(parsed.header.key).toEqual([]);
    expect(keyless.content).toContain("events has no key.");
    for (let n = 1; n <= 60; n++) {
      const name = `a${"b".repeat(n)}`;
      const input = { asset: `i${"n".repeat(n)}`, key: ["id"], why: "the asset changed most recently" };
      const t = templateFor("sql", name, { input });
      const r = parseSqlHeader(t.content, t.path);
      expect(r.problems, name).toEqual([]);
      expect(r.header.key, name).toEqual(["id"]);
      expect(r.header.description, name).toBe(titleWords(name));
    }
  });

  test("transform (§3e): keyed, incremental, newRows() over its input, confirmAbove, and the paid call as a comment", () => {
    const t = templateFor("transform", "charge_labels", { input: { asset: "stripe_charges", key: ["id"], why: "the asset changed most recently" } });
    expect(t).toMatchObject({ kind: "transform", reads: "stripe_charges", secrets: [] });
    for (const s of [
      "inputs: [\"stripe_charges\"],", "key: \"id\",", "incremental: true,", "confirmAbove: 1000,",
      "for await (const row of newRows(\"stripe_charges\")) {", "yield { id: row.id, result };", "checks: [\"not_null(result)\"],",
      "//   const res = await http.post(", "croft preview charge_labels --rows 20",
    ]) expect(t.content, s).toContain(s);
    // The paid call is only a comment: as written it makes no request, so it reads no secret and is not paid work.
    const code = t.content.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s+\/\/.*$/, "")).join("\n");
    expect(code).not.toMatch(/\bhttp\b|\bsecret\(|fetch\(/);
    expect(templateFor("transform", "x_items").content).toContain("newRows(\"example_sales\")");
  });

  test("transform: newRows() without a type argument, so rows get the input's generated row type, and it says so", () => {
    const t = templateFor("transform", "charge_labels", { input: { asset: "stripe_charges", key: ["id"] } });
    const code = t.content.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s+\/\/.*$/, "")).join("\n");
    // An explicit type argument picks the untyped overload: validate --types would never see a rename (R51-01).
    expect(code).not.toMatch(/newRows\s*</);
    expect(code).not.toMatch(/\btype Input\b/);
    const text = t.content.replace(/\n\/\/ /g, " ");
    expect(text).toContain("croft validate --types");
    expect(text).toContain(".croft/types/stripe_charges.d.ts");
    expect(text).toContain("croft describe stripe_charges");
    expect(t.edit).not.toContain("Input");
  });

  test("transform: a composite key is copied column by column, odd names are quoted, and result never shadows the key", () => {
    const composite = templateFor("transform", "t_items", { input: { asset: "daily_sales", key: ["day", "region"] } }).content;
    expect(composite).toContain("key: [\"day\", \"region\"],");
    expect(composite).toContain("yield { day: row.day, region: row.region, result };");
    const odd = templateFor("transform", "t_items", { input: { asset: "zones", key: ["Location ID"] } }).content;
    expect(odd).toContain("yield { \"Location ID\": row[\"Location ID\"], result };");
    const clash = templateFor("transform", "t_items", { input: { asset: "scores", key: ["result"] } }).content;
    expect(clash).toContain("yield { result: row.result, result_value };");
    expect(clash).toContain("checks: [\"not_null(result_value)\"],");
    expect(() => templateFor("transform", "t_items", { input: { asset: "events", key: [] } })).toThrow(/has no key/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// As written, in a project

/** example_sales as croft init makes it, and as a run catalogs it: its columns, so an SQL template binds. */
const EXAMPLE_TS = readFileSync(join(SRC, "agent/project/assets/example_sales.ts"), "utf8");
const EXAMPLE_CATALOG: CatalogAsset = {
  asset: "example_sales", kind: "ingest", behavior: "replaces the table", write: "replace", key: ["order_id"], rows: 120,
  columns: [
    ...[["order_id", "BIGINT"], ["order_date", "DATE"], ["customer", "VARCHAR"], ["region", "VARCHAR"], ["product", "VARCHAR"],
      ["quantity", "BIGINT"], ["unit_price", "DOUBLE"], ["amount", "DOUBLE"], ["_file", "VARCHAR"], ["_loaded_at", "TIMESTAMPTZ"]]
      .map(([name, type]) => ({ name: name!, type: type!, sourceName: name!.startsWith("_") ? null : name!, pinned: false, pending: false, format: null })),
  ],
  cursor: null, lastLoadedAt: "2026-09-22T18:00:00.000000Z", lastReplacedAt: null, lastRunId: "r_0922_1100_aaaa", codeHash: "hash-example",
};

/** An input's row type as a run leaves it (project/types-gen.ts renderTypes). */
const source = (asset: string, key: string[], columns: [string, string][]): TypeSource =>
  ({ asset, key, from: "run", columns: columns.map(([name, type]) => ({ name, type })) });

/** tsc over the files in a project with the tsconfig croft init writes, with .croft/types rendered from `types`
 *  (none: the folder does not exist yet). Each error as "<file>: <message>". */
function typeErrors(files: Record<string, string>, types: TypeSource[] = []): string[] {
  const p = makeProject({ timezone: "UTC", files });
  const rendered = renderTypes(types).files;
  for (const [name, text] of rendered) writeFiles(p.root, { [`.croft/types/${name}`]: text });
  const paths = Object.keys(files).filter((f) => f.endsWith(".ts")).map((f) => join(p.root, f));
  writeFileSync(join(p.root, "tsconfig.json"), tsconfigJson());
  const options = {
    ...(JSON.parse(tsconfigJson()).compilerOptions as object),
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    typeRoots: [join(SRC, "..", "node_modules", "@types")],
  } as ts.CompilerOptions;
  const program = ts.createProgram([...paths, ...[...rendered.keys()].map((n) => join(p.root, ".croft", "types", n))], options);
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.file && paths.includes(d.file.fileName))
    .map((d) => `${d.file!.fileName.split("/").pop()}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

describe("the transform template reads its input's generated row type, so validate --types sees a rename (R51-01)", () => {
  const t = templateFor("transform", "labels", { input: { asset: "orders", key: ["order_id"] } });
  /** The template edited the way its comments say: the result computed from a column of the input. */
  const edited = t.content.replace(/^( *)const result = `.*$/m, "$1const result = String(row.region).toUpperCase();");
  const orders = (region: string) => source("orders", ["order_id"], [["order_id", "BIGINT"], [region, "VARCHAR"], ["_loaded_at", "TIMESTAMPTZ"]]);

  test("as written and edited, it type-checks before the input has types (first run) and after", () => {
    expect(edited).toContain("String(row.region)");
    for (const text of [t.content, edited]) {
      expect(typeErrors({ [t.path]: text })).toEqual([]);
      expect(typeErrors({ [t.path]: text }, [orders("region")])).toEqual([]);
    }
  }, 60_000);

  test("a column renamed upstream is a type error on the generated row type", () => {
    expect(typeErrors({ [t.path]: edited }, [orders("area")])).toEqual([
      "labels.ts: Property 'region' does not exist on type 'OrdersRow'.",
    ]);
  }, 60_000);
});

describe("every template passes croft validate as written", () => {
  test("in a new project (example_sales built): no error, and the only warning is the api secret not set yet", async () => {
    const templates = every(named);
    const p = makeProject({ timezone: "UTC", files: { "assets/example_sales.ts": EXAMPLE_TS, ...Object.fromEntries(templates.map((t) => [t.path, t.content])) } });
    const db = runsDb(p.stateDir);
    putCatalog(db, EXAMPLE_CATALOG);
    db.close();

    const unset = await validateProject({ project: p.project, env: ProjectEnv.load(p.root, {}), now: new Date("2026-09-22T19:00:00Z") });
    const byAsset = (name: string) => unset.problems.filter((x) => x.asset === name).map((x) => `${x.severity} ${x.code}: ${x.message}`);
    expect(unset.problems.filter((x) => !x.asset)).toEqual([]);
    for (const t of templates) {
      const name = named(t.kind, t.pagination);
      expect(byAsset(name), name).toEqual(t.secrets.map((s) => `warning SECRET_MISSING: secret ${s} is not set (used by ${name})`));
    }
    expect(unset.data.order).toEqual(expect.arrayContaining([...templates.map((t) => named(t.kind, t.pagination)), "example_sales"]));
    const assets = new Map(unset.data.assets.map((a) => [a.name, a]));
    expect(assets.get("sql_items")).toMatchObject({ kind: "sql", inputs: ["example_sales"], behavior: "replace; key order_id" });
    expect(assets.get("sql_items")!.outputColumns!.map((c) => c.name)).toEqual(["order_id", "order_date", "customer", "region", "product", "quantity", "unit_price", "amount"]);
    expect(assets.get("transform_items")).toMatchObject({ kind: "ts", inputs: ["example_sales"], behavior: "merge by order_id" });
    expect(assets.get("cursor_items")).toMatchObject({ kind: "ingest", behavior: "merge by id" });
    expect(assets.get("page_items")).toMatchObject({ kind: "ingest", behavior: "replace; key id" });
    expect(assets.get("file_items")).toMatchObject({ kind: "ingest", behavior: "merge by id" });

    // With the secrets set, nothing at all.
    const secrets = Object.fromEntries(templates.flatMap((t) => t.secrets).map((s) => [s, "sk_test_value"]));
    const set = await validateProject({ project: p.project, env: ProjectEnv.load(p.root, secrets), now: new Date("2026-09-22T19:00:00Z") });
    expect(set.problems.map((x) => `${x.asset}: ${x.code} ${x.message}`)).toEqual([]);
  }, 60_000);

  test("over inputs with a composite or a quoted key, built or not", async () => {
    const daily = "-- description: Sales per day and region\n-- key: day, region\nSELECT order_date AS day, region, sum(amount) AS amount FROM example_sales GROUP BY ALL\n";
    const inputs = [{ asset: "daily_sales", key: ["day", "region"] }, { asset: "zones", key: ["LocationID"] }];
    const zones = `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/zones.csv", key: "LocationID" });\n`;
    const files: Record<string, string> = { "assets/example_sales.ts": EXAMPLE_TS, "assets/daily_sales.sql": daily, "assets/zones.ts": zones };
    for (const input of inputs) {
      for (const kind of ["sql", "transform"] as const) {
        const t = templateFor(kind, `${kind}_over_${input.asset}`, { input });
        files[t.path] = t.content;
      }
    }
    const p = makeProject({ timezone: "UTC", files });
    const db = runsDb(p.stateDir);
    putCatalog(db, EXAMPLE_CATALOG);
    db.close();
    const r = await validateProject({ project: p.project, env: ProjectEnv.load(p.root, {}), now: new Date("2026-09-22T19:00:00Z") });
    // zones was never built: its readers' bind is skipped (info), which is no failure.
    expect(r.problems.filter((x) => x.severity !== "info").map((x) => `${x.asset}: ${x.code} ${x.message}`)).toEqual([]);
    const assets = new Map(r.data.assets.map((a) => [a.name, a]));
    expect(assets.get("sql_over_daily_sales")!.outputColumns!.map((c) => c.name)).toEqual(["day", "region", "amount"]);
    expect(assets.get("transform_over_daily_sales")).toMatchObject({ behavior: "merge by day, region" });
    expect(assets.get("sql_over_zones")).toMatchObject({ behavior: "replace; key LocationID" });
  }, 60_000);

  test("every TypeScript template type-checks against the real API with the project's tsconfig, before and after the input types exist", () => {
    const templates = [
      ...every(named).filter((t) => t.kind !== "sql"),
      templateFor("transform", "composite_items", { input: { asset: "daily_sales", key: ["day", "region"] } }),
      templateFor("transform", "odd_items", { input: { asset: "zones", key: ["Location ID"] } }),
    ];
    const files = Object.fromEntries(templates.map((t) => [t.path, t.content]));
    // The first run: no .croft/types yet, so every input row is a Row.
    expect(typeErrors(files)).toEqual([]);
    // After the inputs were run or previewed: each transform's rows are its input's generated row type.
    expect(typeErrors(files, [
      source("example_sales", ["order_id"], [["order_id", "BIGINT"], ["region", "VARCHAR"], ["amount", "DOUBLE"]]),
      source("daily_sales", ["day", "region"], [["day", "DATE"], ["region", "VARCHAR"], ["amount", "DOUBLE"]]),
      source("zones", ["Location ID"], [["Location ID", "BIGINT"], ["Zone", "VARCHAR"]]),
    ])).toEqual([]);
  }, 60_000);

  test("the default input is what croft init makes", () => {
    expect(EXAMPLE_INPUT).toEqual({ asset: "example_sales", key: ["order_id"] });
    expect(EXAMPLE_TS).toContain("key: \"order_id\"");
  });
});

// ---------------------------------------------------------------------------------------------------------
// The code works: each paging loop against a fake ctx.http

interface Call { url: string; query: Record<string, unknown>; headers: Record<string, string> }
type Reply = { body: unknown; next?: string };

/** A ctx.http that answers from `reply` and records every request. */
function fakeHttp(reply: (call: Call, n: number) => Reply): { http: Http; calls: Call[] } {
  const calls: Call[] = [];
  const get = async (url: string, init: HttpInit = {}): Promise<HttpResponse> => {
    const call = { url, query: { ...init.query }, headers: { ...init.headers } };
    calls.push(call);
    const r = reply(call, calls.length);
    return { status: 200, url, headers: new Headers(), text: JSON.stringify(r.body), json: <T>() => r.body as T, ...(r.next ? { next: r.next } : {}) };
  };
  return { http: { get, post: () => Promise.reject(new Error("no POST in these templates")) }, calls };
}

/** Import a written template and run its rows() with a fake context; every batch, flattened. */
async function rowsOf(p: { root: string }, t: Template, ctx: Record<string, unknown>): Promise<Row[]> {
  const mod = await import(join(p.root, t.path)) as { default: AssetDefinition };
  const out: Row[] = [];
  const cfg = mod.default.config as { rows(ctx: unknown): AsyncIterable<Row | Row[]> };
  for await (const batch of cfg.rows({ secret: (n: string) => `value-of-${n}`, log: () => {}, ...ctx })) {
    out.push(...(Array.isArray(batch) ? batch : [batch]));
  }
  return out;
}

const items = (from: number, n: number, f: (i: number) => Row) => Array.from({ length: n }, (_, k) => f(from + k));
const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString().replace(".000", "");

describe("every api template pages correctly as written", () => {
  const files = Object.fromEntries(PAGINATIONS.map((p) => [`assets/${p}_run.ts`, templateFor("api", `${p}_run`, { pagination: p }).content]));
  const project = () => makeProject({ timezone: "UTC", files });
  const api = (p: Pagination) => templateFor("api", `${p}_run`, { pagination: p });

  test("keyset: asks again from the newest value seen until a short page, and stops with KEYSET_STUCK on a tie", async () => {
    const p = project();
    const { http, calls } = fakeHttp((c) => (c.query.since === undefined
      ? { body: items(1, 100, (i) => ({ id: i, updated_at: stamp(i) })) }
      : { body: items(101, 30, (i) => ({ id: i, updated_at: stamp(i) })) }));
    const rows = await rowsOf(p, api("keyset"), { http, since: undefined });
    expect(rows.length).toBe(130);
    expect(calls.map((c) => c.query)).toEqual([
      { sort: "updated_at", direction: "asc", per_page: 100, since: undefined },
      { sort: "updated_at", direction: "asc", per_page: 100, since: stamp(100) },
    ]);
    expect(calls[0]!.headers).toEqual({ Authorization: "Bearer value-of-KEYSET_KEY" });

    const tied = fakeHttp(() => ({ body: items(1, 100, (i) => ({ id: i, updated_at: "2026-09-01T00:00:00Z" })) }));
    const stuck = await rowsOf(p, api("keyset"), { http: tied.http, since: "2026-09-01T00:00:00Z" }).catch((e: unknown) => e);
    expect(stuck).toMatchObject({ code: "KEYSET_STUCK" });
    expect(tied.calls.length).toBe(1);
  });

  test("cursor: follows starting_after while has_more, filtered by since", async () => {
    const p = project();
    const { http, calls } = fakeHttp((c) => (c.query.starting_after === undefined
      ? { body: { data: items(1, 100, (i) => ({ id: `ch_${i}`, created: 1_756_000_000 + i })), has_more: true } }
      : { body: { data: items(101, 5, (i) => ({ id: `ch_${i}`, created: 1_756_000_000 + i })), has_more: false } }));
    const rows = await rowsOf(p, api("cursor"), { http, since: 1_756_000_000 });
    expect(rows.length).toBe(105);
    expect(calls.map((c) => c.query)).toEqual([
      { limit: 100, "created[gte]": 1_756_000_000, starting_after: undefined },
      { limit: 100, "created[gte]": 1_756_000_000, starting_after: "ch_100" },
    ]);
    const empty = fakeHttp(() => ({ body: { data: [], has_more: true } }));
    expect(await rowsOf(p, api("cursor"), { http: empty.http, since: undefined })).toEqual([]);
    expect(empty.calls.length).toBe(1);
  });

  test("link: follows res.next, sending the filter only on the first request", async () => {
    const p = project();
    const { http, calls } = fakeHttp((_, n) => ({
      body: items(n * 10, 2, (i) => ({ id: i, updated_at: stamp(i) })),
      ...(n < 3 ? { next: `https://api.example.com/v1/run?page=${n + 1}` } : {}),
    }));
    const rows = await rowsOf(p, api("link"), { http, since: "2026-09-01T00:00:00Z" });
    expect(rows.length).toBe(6);
    expect(calls.map((c) => [c.url, c.query])).toEqual([
      ["https://api.example.com/v1/run", { per_page: 100, updated_after: "2026-09-01T00:00:00Z" }],
      ["https://api.example.com/v1/run?page=2", {}],
      ["https://api.example.com/v1/run?page=3", {}],
    ]);
    expect(calls.every((c) => c.headers.Authorization === "Bearer value-of-LINK_KEY")).toBe(true);
  });

  test("page: page/per_page until an empty page", async () => {
    const p = project();
    const { http, calls } = fakeHttp((c) => ({ body: c.query.page === 3 ? [] : items(Number(c.query.page) * 1000, c.query.page === 1 ? 100 : 40, (i) => ({ id: i })) }));
    const rows = await rowsOf(p, api("page"), { http });
    expect(rows.length).toBe(140);
    expect(calls.map((c) => c.query)).toEqual([{ page: 1, per_page: 100 }, { page: 2, per_page: 100 }, { page: 3, per_page: 100 }]);
  });

  test("transform: one output row per input row from newRows(), keyed like its input", async () => {
    const t = templateFor("transform", "t_run", { input: { asset: "daily_sales", key: ["day", "region"] } });
    const p = makeProject({ timezone: "UTC", files: { [t.path]: t.content } });
    const input = [{ day: "2026-09-01", region: "East", amount: 3 }, { day: "2026-09-01", region: "West", amount: 4 }];
    const asked: string[] = [];
    const newRows = async function* (name: string) {
      asked.push(name);
      yield* input;
    };
    expect(await rowsOf(p, t, { newRows })).toEqual([
      { day: "2026-09-01", region: "East", result: "2026-09-01 East" },
      { day: "2026-09-01", region: "West", result: "2026-09-01 West" },
    ]);
    expect(asked).toEqual(["daily_sales"]);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { ingest, transform } from "../index.ts";
import type { FileIngest, RowsIngest, TransformConfig } from "../types.ts";
import { discoverAssets } from "./discover.ts";
import {
  bundleTs, cursorTypeOfPin, detectRequests, loadTsAsset, loadTsAssets, locateKey, normalizeBundle, opensDatabase,
  packageName, parseDuration, scanImportGraph, stripLiterals, trimStack, tsFingerprint, validateDefinition,
  type ValidateOptions,
} from "./ts-asset.ts";

// ---------------------------------------------------------------------------------------------------
// Fixture projects: a temp folder with node_modules/@zabaca/croft linked to this package, so asset
// files import "@zabaca/croft" exactly as they do in a user's project.

const PKG = resolve(import.meta.dir, "../..");
const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-ts-asset-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>): string {
  const root = join(base, `p${n++}`);
  mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
  symlinkSync(PKG, join(root, "node_modules", "@zabaca", "croft"));
  write(root, files);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const TZ = "America/Los_Angeles";

async function load(root: string, name: string, o: Parameters<typeof loadTsAsset>[2] = {}) {
  const file = `assets/${name}.ts`;
  return loadTsAsset({ name, file, path: join(root, file) }, { root, timezone: TZ }, o);
}

const codes = (ps: Problem[]) => ps.map((p) => p.code);

const TRIAGE_ASSET = `// assets/issue_triage.ts
import { transform } from "@zabaca/croft";
import { triage } from "../lib/triage.ts";

type Issue = { id: number; title: string; body: string | null; labels: { name: string }[] };

export default transform({
  description: "Priority and reason for every issue",
  inputs: ["github_issues"],
  key: "issue_id",
  incremental: true,
  checks: ["priority IN ('p0', 'p1', 'p2')"],
  async *rows({ newRows, log }) {
    let n = 0;
    for await (const issue of newRows<Issue>("github_issues")) {
      const { priority, reason } = triage(issue.title, issue.body ?? "", issue.labels.map((l) => l.name));
      yield { issue_id: issue.id, priority, reason };
      if (++n % 1000 === 0) log(\`\${n} issues triaged\`);
    }
  },
});
`;

const TRIAGE_LIB = `export function triage(title: string, body: string, labels: string[]) {
  if (labels.includes("crash") || /segfault|panic/i.test(title + body)) return { priority: "p0", reason: "crash" };
  if (labels.includes("bug")) return { priority: "p1", reason: "bug label" };
  return { priority: "p2", reason: "default" };
}

export function unused() {
  return "not reachable from any asset";
}
`;

// ---------------------------------------------------------------------------------------------------

describe("loading", () => {
  test("a valid transform loads with a spec, a hash and its lib/ files", async () => {
    const root = project({ "assets/issue_triage.ts": TRIAGE_ASSET, "lib/triage.ts": TRIAGE_LIB });
    const a = await load(root, "issue_triage");
    expect(a.problems).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.definition?.__croft).toBe("transform");
    expect(a.spec).toEqual({
      role: "transform", source: "transform", key: ["issue_id"], incremental: { kind: "new-rows", inputs: ["github_issues"] },
      secrets: [], inputs: ["github_issues"], checks: ["priority IN ('p0', 'p1', 'p2')"], warnings: [], pins: {}, allowShrink: false,
    });
    expect(a.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.localFiles).toEqual(["assets/issue_triage.ts", "lib/triage.ts"]);
    expect(a.usesHttp).toBe(false);
    expect(a.packages).toEqual({});                    // @zabaca/croft does not count
  });

  test("a broken file fails only its own asset", async () => {
    const root = project({
      "assets/good.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/x.csv" });\n`,
      "assets/syntax.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({\n  file: ,\n});\n`,
      "assets/throws.ts": `import { ingest } from "@zabaca/croft";\nimport { boom } from "../lib/boom.ts";\nboom();\nexport default ingest({ file: "files/y.csv" });\n`,
      "lib/boom.ts": `export function boom() {\n  throw new Error("config service unreachable");\n}\n`,
      "assets/missing_import.ts": `import { x } from "../lib/nope.ts";\nexport default x;\n`,
      "assets/no_default.ts": `export const config = {};\n`,
      "assets/zz_good.ts": `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: "files/z.csv" });\n`,
    });
    const { assets } = await discoverAssets(root);
    const loaded = await loadTsAssets(assets, { root, timezone: TZ });
    const byName = Object.fromEntries(loaded.map((a) => [a.name, a]));
    expect(loaded.map((a) => [a.name, a.ok])).toEqual([
      ["good", true], ["missing_import", false], ["no_default", false], ["syntax", false], ["throws", false], ["zz_good", true],
    ]);

    const syntax = byName.syntax!.problems[0]!;
    expect(syntax).toMatchObject({ code: "ASSET_INVALID", asset: "syntax", file: "assets/syntax.ts", line: 3 });
    expect(syntax.message).toContain("assets/syntax.ts does not compile: Unexpected , at assets/syntax.ts:3:");

    const throws = byName.throws!.problems[0]!;
    expect(throws).toMatchObject({ code: "ASSET_INVALID", asset: "throws", file: "lib/boom.ts", line: 2 });
    expect(throws.message).toBe("assets/throws.ts failed while loading: Error: config service unreachable");
    const stack = String(throws.details!.stack);
    expect(stack.split("\n")[0]).toBe("Error: config service unreachable");
    expect(stack).toContain("lib/boom.ts:2");
    expect(stack).toContain("assets/throws.ts:3");
    expect(stack).not.toContain(root);                // paths are project-relative
    expect(stack).not.toContain("node_modules");
    expect(throws.hint).toContain("keep work inside rows()");

    expect(byName.missing_import!.problems[0]!.message).toContain('Could not resolve: "../lib/nope.ts"');
    expect(byName.no_default!.problems[0]!.message).toBe("assets/no_default.ts has no default export");
    expect(byName.good!.spec?.source).toBe("file");
  });

  test("top-level code that never finishes fails the asset after the import timeout", async () => {
    const root = project({
      "assets/hangs.ts": `import { ingest } from "@zabaca/croft";\nawait new Promise(() => {});\nexport default ingest({ file: "x.csv" });\n`,
    });
    const a = await load(root, "hangs", { importTimeoutMs: 100 });
    expect(a.ok).toBe(false);
    expect(a.problems[0]!.message).toBe("assets/hangs.ts did not finish loading within 0.1 s; its top-level code is still running");
  });

  test("a plain config object gets told to wrap it in ingest()", async () => {
    const root = project({ "assets/plain.ts": `export default { file: "files/x.csv" };\n` });
    const a = await load(root, "plain");
    expect(a.problems[0]!.message).toBe("the default export is a plain object, not an asset definition");
    expect(a.problems[0]!.hint).toContain('export default ingest({ ... }), with import { ingest } from "@zabaca/croft"');
  });

  test("validation problems point at the line of the key", async () => {
    const root = project({
      "assets/github_issues.ts": `import { ingest } from "@zabaca/croft";

export default ingest({
  description: "Issues",
  schedule: "every hour",
  incremental: "updated_at",
  async *rows({ http }) {
    yield [];
  },
});
`,
    });
    const a = await load(root, "github_issues", {});
    expect(codes(a.problems)).toEqual(["INCREMENTAL_WITHOUT_KEY"]);
    expect(a.problems[0]).toMatchObject({ line: 6, file: "assets/github_issues.ts", asset: "github_issues" });
    expect(a.spec).toBeUndefined();
    expect(a.codeHash).toBeDefined();                 // the hash does not depend on validity
  });
});

// ---------------------------------------------------------------------------------------------------

describe("import scan", () => {
  test("importing @duckdb/node-api is ASSET_OPENS_DATABASE and the file is never imported", async () => {
    const root = project({
      "assets/sneaky.ts": `import { ingest } from "@zabaca/croft";
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(base, "sneaky-ran"))}, "top-level code ran");
export default ingest({ file: "files/x.csv" });
`,
    });
    const a = await load(root, "sneaky");
    expect(codes(a.problems)).toEqual(["ASSET_OPENS_DATABASE"]);
    expect(a.problems[0]).toMatchObject({
      asset: "sneaky", file: "assets/sneaky.ts", line: 2,
      hint: "remove the import and use ctx.query(sql) for read-only lookups",
      fix: { kind: "edit", file: "assets/sneaky.ts", line: 2, description: "remove the @duckdb/node-api import and use ctx.query(sql) instead" },
    });
    expect(a.problems[0]!.message).toContain("assets/sneaky.ts imports @duckdb/node-api; asset code must never open the database itself");
    expect(existsSync(join(base, "sneaky-ran"))).toBe(false);
    expect(a.definition).toBeUndefined();
  });

  test("a lib/ file importing @zabaca/croft/read is reported at the lib file and line", async () => {
    const root = project({
      "assets/lookup.ts": `import { ingest } from "@zabaca/croft";\nimport { known } from "../lib/db.ts";\nexport default ingest({ async *rows() { yield await known(); } });\n`,
      "lib/db.ts": `// helper\nexport async function known() {\n  const { query } = await import("@zabaca/croft/read");\n  return query("select 1");\n}\n`,
    });
    const a = await load(root, "lookup");
    expect(codes(a.problems)).toEqual(["ASSET_OPENS_DATABASE"]);
    expect(a.problems[0]).toMatchObject({ file: "lib/db.ts", line: 3, details: { specifier: "@zabaca/croft/read", importedBy: "lib/db.ts" } });
    expect(a.localFiles).toEqual(["assets/lookup.ts", "lib/db.ts"]);
  });

  test("require() and nested lib imports are followed; type-only imports are not code", () => {
    const root = project({
      "assets/a.ts": `import type { DuckDBInstance } from "@duckdb/node-api";\nimport { b } from "../lib/b.ts";\nexport default b;\n`,
      "lib/b.ts": `export { c as b } from "./nested/c";\n`,
      "lib/nested/c.ts": `const duck = require("duckdb");\nexport const c = duck;\n`,
    });
    const g = scanImportGraph(join(root, "assets/a.ts"), root);
    expect(g.files.map((f) => f.slice(root.length + 1))).toEqual(["assets/a.ts", "lib/b.ts", "lib/nested/c.ts"]);
    expect(g.opensDatabase.map((r) => [r.specifier, r.from.slice(root.length + 1), r.line])).toEqual([["duckdb", "lib/nested/c.ts", 1]]);
  });

  test("an import cycle between lib files terminates", () => {
    const root = project({
      "assets/a.ts": `import { x } from "../lib/x.ts";\nexport default x;\n`,
      "lib/x.ts": `import { y } from "./y.ts";\nexport const x = () => y;\n`,
      "lib/y.ts": `import { x } from "./x.ts";\nexport const y = () => x;\n`,
    });
    expect(scanImportGraph(join(root, "assets/a.ts"), root).files).toHaveLength(3);
  });

  test("opensDatabase and packageName", () => {
    for (const s of ["@duckdb/node-api", "@duckdb/node-api/lib/x", "@duckdb/node-bindings-darwin-arm64", "duckdb", "duckdb-async", "@zabaca/croft/read"]) {
      expect(opensDatabase(s)).toBe(true);
    }
    for (const s of ["@zabaca/croft", "duckdb-helpers", "@duckdb/duckdb-wasm", "lodash"]) expect(opensDatabase(s)).toBe(false);
    expect(packageName("@scope/pkg/sub/path")).toBe("@scope/pkg");
    expect(packageName("pkg/sub")).toBe("pkg");
  });
});

// ---------------------------------------------------------------------------------------------------

describe("ctx.http detection", () => {
  const transformUsing = (body: string, incremental = false) => `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["github_issues"],
  key: "issue_id",${incremental ? "\n  incremental: true," : ""}
  async *rows(ctx) {
${body}
  },
});
`;

  test("a full-refresh transform that uses ctx.http gets TRANSFORM_MAKES_REQUESTS", async () => {
    const root = project({
      "assets/enrich.ts": transformUsing(`    for await (const r of ctx.rows("github_issues")) {\n      const res = await ctx.http.post("https://llm.example.com/v1", { text: r.title });\n      yield { issue_id: r.id, label: res.json() };\n    }`),
    });
    const a = await load(root, "enrich");
    expect(a.usesHttp).toBe(true);
    expect(a.ok).toBe(true);                          // a warning, not an error
    expect(a.problems).toHaveLength(1);
    expect(a.problems[0]).toMatchObject({ code: "TRANSFORM_MAKES_REQUESTS", severity: "warning", details: { via: ["ctx.http"] } });
    expect(a.problems[0]!.message).toBe("enrich rebuilds in full whenever an input changes, and it makes requests (ctx.http); every rebuild pays for every row again");
  });

  test("an incremental transform may use ctx.http", async () => {
    const root = project({
      "assets/enrich.ts": transformUsing(`    for await (const r of ctx.newRows("github_issues")) {\n      yield { issue_id: r.id, x: (await ctx.http.get("https://x.test")).text };\n    }`, true),
    });
    const a = await load(root, "enrich");
    expect(a.usesHttp).toBe(true);
    expect(a.problems).toEqual([]);
  });

  test("http handed to a lib/ helper counts; a URL string does not", async () => {
    const root = project({
      "assets/viahelper.ts": `import { transform } from "@zabaca/croft";
import { label } from "../lib/llm.ts";
export default transform({
  inputs: ["github_issues"],
  async *rows({ rows, http }) {
    for await (const r of rows("github_issues")) yield { id: r.id, label: await label(http, String(r.title)) };
  },
});
`,
      "lib/llm.ts": `import type { Http } from "@zabaca/croft";\nexport async function label(client: Http, text: string) {\n  return (await client.post("https://llm.example.com", { text })).text;\n}\n`,
      "assets/urlonly.ts": `import { transform } from "@zabaca/croft";
export default transform({
  inputs: ["github_issues"],
  async *rows({ rows }) {
    // ctx.http is not used here, only mentioned in a comment
    for await (const r of rows("github_issues")) yield { id: r.id, link: "http://example.com/" + r.id, re: /http/.source, t: \`http \${r.id}\` };
  },
});
`,
    });
    expect((await load(root, "viahelper")).usesHttp).toBe(true);
    const url = await load(root, "urlonly");
    expect(url.usesHttp).toBe(false);
    expect(url.problems).toEqual([]);
  });

  test("detectRequests: fetch and HTTP client packages", () => {
    expect(detectRequests(`async function f(){await fetch("https://x.test")}`)).toEqual(["fetch"]);
    expect(detectRequests(`globalThis.fetch(u)`)).toEqual(["fetch"]);
    expect(detectRequests(`obj.fetch(u);prefetch(u)`)).toEqual([]);
    expect(detectRequests(`import OpenAI from"openai";new OpenAI`, ["openai"])).toEqual(["package openai"]);
    expect(detectRequests(`import*as h from"node:https"`, ["node:https"])).toEqual(["package https"]);
    expect(detectRequests(`let{newRows:n,http:h}=ctx`)).toEqual(["ctx.http"]);
    expect(detectRequests(`let x={https:1};x.httpClient=2;`)).toEqual([]);
  });

  test("stripLiterals blanks strings, templates, regexes and comments but keeps template expressions", () => {
    expect(stripLiterals(`a("http") + 'x' // http\n/* http */ b`).replace(/\s+/g, " ")).toBe(`a("") + '' b`);
    expect(stripLiterals("`http ${ctx.http} ${`nested ${http}`}`")).toBe("`${ctx.http}${`${http}`}`");
    expect(stripLiterals(`x = /http\\/[a-z/]+/g.test(s); y = a / b / c`)).toBe(`x = /./.test(s); y = a / b / c`);
    expect(stripLiterals(`return /http/.test(u)`)).toBe(`return /./.test(u)`);
    expect(stripLiterals(`{a:1};/http/`)).toBe(`{a:1};/./`);
  });
});

// ---------------------------------------------------------------------------------------------------

describe("fingerprint", () => {
  test("stable under comment and whitespace edits in the asset and lib/", async () => {
    const root = project({ "assets/issue_triage.ts": TRIAGE_ASSET, "lib/triage.ts": TRIAGE_LIB });
    const entry = join(root, "assets/issue_triage.ts");
    const before = await tsFingerprint(entry, { root, timezone: TZ });
    write(root, {
      "assets/issue_triage.ts": TRIAGE_ASSET
        .replace("// assets/issue_triage.ts", "// assets/issue_triage.ts, edited: more notes here\n/* a block comment */")
        .replace("key: \"issue_id\",", "key:   \"issue_id\",    // the output key")
        .replace("  async *rows", "\n\n  async *rows"),
      "lib/triage.ts": `// triage rules, documented\n${TRIAGE_LIB.replace("return { priority: \"p2\"", "  // fall through\n  return {   priority: \"p2\"")}`,
    });
    expect(await tsFingerprint(entry, { root, timezone: TZ })).toBe(before);
  });

  test("changed by a lib/ edit, but not by an edit to lib/ code the asset never reaches", async () => {
    const root = project({ "assets/issue_triage.ts": TRIAGE_ASSET, "lib/triage.ts": TRIAGE_LIB });
    const entry = join(root, "assets/issue_triage.ts");
    const before = await tsFingerprint(entry, { root, timezone: TZ });
    write(root, { "lib/triage.ts": TRIAGE_LIB.replace('"not reachable from any asset"', '"still not reachable"') });
    expect(await tsFingerprint(entry, { root, timezone: TZ })).toBe(before);
    write(root, { "lib/triage.ts": TRIAGE_LIB.replace("segfault|panic", "segfault|panic|abort") });
    expect(await tsFingerprint(entry, { root, timezone: TZ })).not.toBe(before);
  });

  test("changed by the project time zone", async () => {
    const root = project({ "assets/issue_triage.ts": TRIAGE_ASSET, "lib/triage.ts": TRIAGE_LIB });
    const entry = join(root, "assets/issue_triage.ts");
    expect(await tsFingerprint(entry, { root, timezone: "UTC" })).not.toBe(await tsFingerprint(entry, { root, timezone: TZ }));
  });

  test("the same when the file is renamed or the project moves", async () => {
    const root = project({ "assets/issue_triage.ts": TRIAGE_ASSET, "lib/triage.ts": TRIAGE_LIB });
    const before = await tsFingerprint(join(root, "assets/issue_triage.ts"), { root, timezone: TZ });
    renameSync(join(root, "assets/issue_triage.ts"), join(root, "assets/triage_v2.ts"));
    expect(await tsFingerprint(join(root, "assets/triage_v2.ts"), { root, timezone: TZ })).toBe(before);
    const moved = join(base, `moved${n++}`);
    cpSync(root, moved, { recursive: true, verbatimSymlinks: true });
    expect(await tsFingerprint(join(moved, "assets/triage_v2.ts"), { root: moved, timezone: TZ })).toBe(before);
  });

  test("changed by the version of an imported package, not by croft's own", async () => {
    const root = project({
      "assets/padded.ts": `import { transform } from "@zabaca/croft";\nimport pad from "leftpad";\nexport default transform({ inputs: ["a"], async *rows() { yield { v: pad("x", 3) }; } });\n`,
      "node_modules/leftpad/package.json": JSON.stringify({ name: "leftpad", version: "1.0.0", main: "index.js" }),
      "node_modules/leftpad/index.js": "module.exports = (s, n) => s.padStart(n);\n",
    });
    const a = await load(root, "padded");
    expect(a.packages).toEqual({ leftpad: "1.0.0" });
    // loadTsAsset and tsFingerprint compute the same hash.
    expect(await tsFingerprint(join(root, "assets/padded.ts"), { root, timezone: TZ })).toBe(a.codeHash!);
    write(root,{ "node_modules/leftpad/package.json": JSON.stringify({ name: "leftpad", version: "1.0.1", main: "index.js" }) });
    const b = await tsFingerprint(join(root, "assets/padded.ts"), { root, timezone: TZ });
    expect(b).not.toBe(a.codeHash);
  });

  test("a file that does not compile throws ASSET_INVALID", async () => {
    const root = project({ "assets/bad.ts": "export default {\n  a: ,\n};\n" });
    const e = await tsFingerprint(join(root, "assets/bad.ts"), { root, timezone: TZ }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(CroftError);
    expect((e as CroftError).code).toBe("ASSET_INVALID");
    expect((e as CroftError).problem).toMatchObject({ file: "assets/bad.ts", line: 2 });
  });

  test("normalizeBundle hides the file-derived default export name", async () => {
    const root = project({ "assets/some_name.ts": "export default function () { return 1; }\nexport const some_name_default_x = 2;\n" });
    const b = await bundleTs(join(root, "assets/some_name.ts"));
    if (!b.ok) throw new Error("expected a bundle");
    expect(b.code).toContain("some_name_default");
    const norm = normalizeBundle(b.code, join(root, "assets/some_name.ts"));
    expect(norm).not.toMatch(/some_name_default(?![\w$])/);
    expect(norm).toContain("some_name_default_x");
  });
});

// ---------------------------------------------------------------------------------------------------
// Config validation: every message, through validateDefinition on in-memory definitions.

const O: ValidateOptions = { name: "things", file: "assets/things.ts" };
const rowsFn = async function* () { /* rows */ };

function problemsOf(value: unknown, o: Partial<ValidateOptions> = {}): Problem[] {
  return validateDefinition(value, { ...O, ...o }).problems;
}
function one(value: unknown, o: Partial<ValidateOptions> = {}): Problem {
  const ps = problemsOf(value, o);
  expect(ps.map((p) => `${p.code}: ${p.message}`)).toHaveLength(1);
  return ps[0]!;
}
const api = (extra: Record<string, unknown>) => ingest({ rows: rowsFn, ...extra } as unknown as RowsIngest);
const files = (extra: Record<string, unknown>) => ingest({ file: "files/x.csv", ...extra } as unknown as FileIngest);
const xform = (extra: Record<string, unknown>) => transform({ inputs: ["github_issues"], rows: rowsFn, ...extra } as unknown as TransformConfig);

describe("validateDefinition: the export itself", () => {
  test.each([
    [undefined, { hasDefault: false }, "assets/things.ts has no default export"],
    [null, {}, "the default export of assets/things.ts is null"],
    [42, {}, "the default export is 42, not an asset definition"],
    [{ rows: rowsFn }, {}, "the default export is a plain object, not an asset definition"],
    [{ __croft: "sensor", config: {} }, {}, 'the default export has an unknown kind "sensor"'],
    [{ __croft: "ingest", config: "files/x.csv" }, {}, 'ingest() was called with "files/x.csv"; it takes a config object'],
  ] as [unknown, Partial<ValidateOptions>, string][])("%p", (value, o, message) => {
    const p = one(value, o);
    expect(p.code).toBe("ASSET_INVALID");
    expect(p.message).toBe(message);
    expect(p.asset).toBe("things");
  });
});

describe("validateDefinition: ingests", () => {
  test("valid API and file ingests normalize", () => {
    const a = validateDefinition(api({
      key: ["id"], incremental: { field: "created", unit: "s", lookback: "30 days" }, schedule: " every hour ",
      secrets: ["STRIPE_KEY"], checks: ["amount >= 0"], warnings: ["min_rows(1)"], columns: { amount: "DECIMAL(18,2)", day: { type: "DATE", format: "%d/%m/%Y" } },
      retries: 3, timeout: "15m", allowShrink: true, description: "charges",
    }), O);
    expect(a.problems).toEqual([]);
    expect(a.spec).toEqual({
      role: "ingest", source: "rows", key: ["id"], incremental: { kind: "cursor", field: "created", unit: "s", lookbackMs: 30 * 86_400_000 },
      schedule: "every hour", secrets: ["STRIPE_KEY"], inputs: [], checks: ["amount >= 0"], warnings: ["min_rows(1)"],
      pins: { amount: { type: "DECIMAL(18,2)" }, day: { type: "DATE", format: "%d/%m/%Y" } }, allowShrink: true, retries: 3, timeoutMs: 900_000,
    });
    const f = validateDefinition(files({ incremental: true, key: "order_id", format: "csv", csv: { header: true, delimiter: ";", skip: 1, encoding: "latin-1" }, map: (r: object) => r }), O);
    expect(f.problems).toEqual([]);
    expect(f.spec).toMatchObject({ source: "file", incremental: { kind: "files" }, key: ["order_id"] });
    // `file?: never` invites `file: undefined`; it counts as absent.
    expect(problemsOf(api({ file: undefined, map: undefined }))).toEqual([]);
  });

  test.each([
    ["rows and file", ingest({ rows: rowsFn, file: "x.csv" } as unknown as RowsIngest), "file", "an ingest reads from an API with rows() or from files with file, not both"],
    ["neither", ingest({ description: "x" } as unknown as RowsIngest), null, "an ingest needs rows() (an API) or file (a path, glob or URL)"],
    ["rows not a function", api({ rows: [{ id: 1 }] }), "rows", "rows must be a function, got a list"],
    ["unknown key with a suggestion", api({ incremntal: "updated_at" }), "incremntal", 'unknown key "incremntal"; did you mean "incremental"?'],
    ["unknown key without one", api({ zzz: 1 }), "zzz", 'unknown key "zzz"'],
    ["inputs on an ingest", api({ inputs: ["a"] }), "inputs", "inputs is for transforms; an ingest brings data in with rows() or file"],
    ["map on an API ingest", api({ map: (r: object) => r }), "map", "map is for file ingests; clean values inside rows() before yielding them"],
    ["csv on an API ingest", api({ csv: { header: true } }), "csv", "csv describes input files, so it belongs to file ingests"],
    ["confirmAbove on an ingest", api({ confirmAbove: 10 }), "confirmAbove", "confirmAbove is the cost guard of incremental transforms, not ingests"],
    ["allowShrink not boolean", api({ allowShrink: "yes" }), "allowShrink", 'allowShrink must be true or false, got "yes"'],
    ["incremental: true on an API ingest", api({ incremental: true }), "incremental", "an API ingest's incremental names its cursor field, got true"],
    ["empty incremental", api({ incremental: "" }), "incremental", "incremental is empty"],
    ["incremental a number", api({ incremental: 5 }), "incremental", "incremental must name the cursor field, got 5"],
    ["cursor spec unknown key", api({ key: "id", incremental: { field: "t", lookbak: "1 day" } }), "incremental", 'unknown key "lookbak" in incremental; did you mean "lookback"?'],
    ["cursor spec without field", api({ key: "id", incremental: { unit: "s" } }), "incremental", "incremental.field must name the cursor column, got nothing"],
    ["cursor unit spelled out", api({ key: "id", incremental: { field: "t", unit: "seconds" } }), "unit", 'incremental.unit must be "s" or "ms" (epoch seconds or milliseconds), got "seconds"'],
    ["lookback unreadable", api({ key: "id", incremental: { field: "t", lookback: "a while" } }), "lookback", 'incremental.lookback must be a duration such as "30 days" or "10 minutes", got "a while"'],
    ["lookback in months", api({ key: "id", incremental: { field: "t", lookback: "3 months" } }), "lookback", 'incremental.lookback must be a duration such as "30 days" or "10 minutes", got "3 months"'],
    ["file empty", files({ file: "" }), "file", "file is empty"],
    ["file list empty", files({ file: [] }), "file", "file is an empty list"],
    ["file list entry", files({ file: ["a.csv", 3] }), "file", "file[1] must be a path, glob or URL, got 3"],
    ["file a number", files({ file: 3 }), "file", "file must be a path, glob or URL (or a list of them), got 3"],
    ["format unknown", files({ format: "cvs" }), "format", 'format must be one of csv, tsv, json, ndjson, parquet, got "cvs"; did you mean "csv"?'],
    ["csv not an object", files({ csv: true }), "csv", "csv must be an object of CSV options, got true"],
    ["csv unknown key", files({ csv: { headers: true } }), "csv", 'unknown key "headers" in csv; did you mean "header"?'],
    ["csv delimiter", files({ csv: { delimiter: "" } }), "delimiter", 'csv.delimiter must be a character such as ";" or "|", got ""'],
    ["csv header", files({ csv: { header: "yes" } }), "header", 'csv.header must be true or false, got "yes"'],
    ["csv skip", files({ csv: { skip: -1 } }), "skip", "csv.skip must be a whole number of lines, got -1"],
    ["csv encoding", files({ csv: { encoding: "latin1" } }), "encoding", 'csv.encoding must be one of utf-8, latin-1, utf-16, got "latin1"'],
    ["map not a function", files({ map: "trim" }), "map", 'map must be a function from a row to a row (or null to drop it), got "trim"'],
    ["file incremental a field", files({ incremental: "updated_at" }), "incremental", 'a file ingest\'s incremental is true or false, got "updated_at"'],
  ] as [string, unknown, string | null, string][])("%s", (_label, value, key, message) => {
    const p = one(value);
    expect(p.code).toBe("ASSET_INVALID");
    expect(p.message).toBe(message);
    expect(p.details?.key).toBe(key);
  });

  test("hints that carry the fix", () => {
    expect(one(api({ incremntal: "x", key: "id" })).hint).toBe("rename incremntal to incremental");
    expect(one(api({ key: "id", incremental: { field: "t", unit: "seconds" } })).hint).toBe('unit: "s"');
    expect(one(api({ key: "id", incremental: { field: "t", lookback: "3 months" } })).hint).toBe('months and years have no fixed length: write days, e.g. lookback: "90 days"');
    expect(one(files({ csv: { encoding: "latin1" } })).hint).toBe('encoding: "latin-1"');
    expect(one(files({ format: ".parquet" })).hint).toBe('format: "parquet"');
  });

  test("schedule must be a non-empty string (phrases are parsed later)", () => {
    for (const bad of ["", "   ", 60, ["every hour"]]) {
      const p = one(api({ schedule: bad }));
      expect(p.code).toBe("SCHEDULE_INVALID");
      expect(p.message).toStartWith("schedule must be a non-empty string, got ");
    }
    expect(problemsOf(api({ schedule: "whenever you like" }))).toEqual([]);
  });
});

describe("validateDefinition: transforms", () => {
  test.each([
    ["no inputs", transform({ rows: rowsFn } as unknown as TransformConfig), null, "a transform needs inputs: the assets its code reads"],
    ["inputs a string", xform({ inputs: "github_issues" }), "inputs", "inputs is a list of asset names, got a single string"],
    ["inputs not a list", xform({ inputs: 3 }), "inputs", "inputs must be a list of asset names, got 3"],
    ["inputs empty", xform({ inputs: [] }), "inputs", "inputs is empty; a transform computes a table from other assets"],
    ["input not a name", xform({ inputs: ["GitHub Issues"] }), "inputs", 'inputs[0] must be an asset name (lowercase letters, digits and _), got "GitHub Issues"'],
    ["input is itself", xform({ inputs: ["things"] }), "inputs", "things lists itself in inputs; a transform cannot read its own table"],
    ["duplicate inputs", xform({ inputs: ["a", "a"] }), "inputs", "inputs lists a more than once"],
    ["no rows", transform({ inputs: ["a"] } as unknown as TransformConfig), "rows", "a transform needs rows(): the code that turns its inputs into rows"],
    ["rows not a function", xform({ rows: "select 1" }), "rows", 'rows must be a function, got "select 1"'],
    ["incremental not boolean", xform({ incremental: "updated_at" }), "incremental", 'a transform\'s incremental is true or false, got "updated_at"'],
    ["confirmAbove", xform({ confirmAbove: 1.5 }), "confirmAbove", "confirmAbove must be a whole number of input rows, got 1.5"],
    ["schedule on a transform", xform({ schedule: "hourly" }), "schedule", "transforms have no schedule: they run when their inputs change"],
    ["file on a transform", xform({ file: "x.csv" }), "file", "file belongs to file ingests: use ingest({ file: ... })"],
    ["map on a transform", xform({ map: (r: object) => r }), "map", "map is for file ingests; shape rows inside rows()"],
    ["allowShrink on a transform", xform({ allowShrink: true }), "allowShrink", "allowShrink is for ingests; a transform's size follows its inputs"],
    ["format on a transform", xform({ format: "csv" }), "format", "format describes input files, so it belongs to file ingests"],
  ] as [string, unknown, string | null, string][])("%s", (_label, value, key, message) => {
    const p = one(value);
    expect(p.code).toBe("ASSET_INVALID");
    expect(p.message).toBe(message);
    expect(p.details?.key).toBe(key);
  });
});

describe("validateDefinition: common keys", () => {
  test.each([
    ["description", api({ description: 3 }), "description", "description must be a string, got 3"],
    ["key empty", api({ key: "" }), "key", "key is empty"],
    ["key empty list", api({ key: [] }), "key", "key is an empty list"],
    ["key list entry", api({ key: ["day", 2] }), "key", "key[1] must be a column name, got 2"],
    ["key duplicate", api({ key: ["day", "day"] }), "key", 'key lists "day" more than once'],
    ["key object", api({ key: { id: 1 } }), "key", "key must be a column name or a list of them, got an object"],
    ["write typo", api({ write: "upsert" }), "write", 'write must be "replace", "append" or "merge", got "upsert"'],
    ["write close typo", api({ write: "apend" }), "write", 'write must be "replace", "append" or "merge", got "apend"; did you mean "append"?'],
    ["checks a string", api({ checks: "unique(id)" }), "checks", "checks is a list of rules, got a single string"],
    ["checks not a list", api({ checks: { id: "unique" } }), "checks", "checks must be a list of rules written as strings, got an object"],
    ["checks entry a function", api({ checks: [(r: { a: number }) => r.a > 0] }), "checks", 'checks[0] must be a rule written as a string, such as "amount >= 0", got a function'],
    ["warnings entry empty", api({ warnings: ["min_rows(1)", " "] }), "warnings", 'warnings[1] must be a rule written as a string, such as "amount >= 0", got " "'],
    ["columns not an object", api({ columns: ["amount"] }), "columns", "columns must map column names to types, got a list"],
    ["columns empty type", api({ columns: { amount: "" } }), "columns", "columns.amount is an empty type"],
    ["columns pin unknown key", api({ columns: { day: { type: "DATE", formt: "%d" } } }), "columns", 'unknown key "formt" in columns.day; did you mean "format"?'],
    ["columns pin without type", api({ columns: { day: { format: "%d" } } }), "columns", "columns.day.type must be a DuckDB type name, got nothing"],
    ["columns pin format", api({ columns: { day: { type: "DATE", format: 1 } } }), "columns", 'columns.day.format must be a strptime pattern such as "%d/%m/%Y", got 1'],
    ["columns pin a number", api({ columns: { day: 1 } }), "columns", "columns.day must be a type name or { type, format }, got 1"],
    ["secrets a string", api({ secrets: "GITHUB_TOKEN" }), "secrets", 'secrets is a list of .env names, got "GITHUB_TOKEN"'],
    ["secrets a value", api({ secrets: ["ghp_abc-123"] }), "secrets", 'secrets[0] must be an environment variable name such as GITHUB_TOKEN, got "ghp_abc-123"'],
    ["secrets duplicate", api({ secrets: ["A", "A"] }), "secrets", "secrets lists A more than once"],
    ["retries", api({ retries: 20 }), "retries", "retries must be a whole number from 0 to 10, got 20"],
    ["timeout", api({ timeout: "soon" }), "timeout", 'timeout must be a duration such as "10m" or "2 hours", got "soon"'],
  ] as [string, unknown, string, string][])("%s", (_label, value, key, message) => {
    const p = one(value);
    expect(p.code).toBe("ASSET_INVALID");
    expect(p.message).toBe(message);
    expect(p.details?.key).toBe(key);
  });

  test("secrets hint for a single string", () => {
    expect(one(api({ secrets: "GITHUB_TOKEN" })).hint).toBe('secrets: ["GITHUB_TOKEN"]');
    expect(one(api({ checks: "unique(id)" })).hint).toBe('checks: ["unique(id)"]');
  });
});

describe("validateDefinition: rules across keys", () => {
  test("INCREMENTAL_WITHOUT_KEY for cursor ingests and incremental transforms, unless write: append", () => {
    const p = one(api({ incremental: "updated_at" }));
    expect(p).toMatchObject({ code: "INCREMENTAL_WITHOUT_KEY", severity: "error" });
    expect(p.message).toBe("things is incremental but has no key; an incremental API ingest re-fetches rows on purpose (lookback, boundary rows), and without a key every re-read row would be stored twice");
    expect(p.hint).toBe('add key: "id" (the column that identifies a record), or write: "append" for append-only sources such as event logs');
    expect(one(xform({ incremental: true })).code).toBe("INCREMENTAL_WITHOUT_KEY");
    expect(problemsOf(api({ incremental: "updated_at", write: "append" }))).toEqual([]);
    expect(problemsOf(xform({ incremental: true, write: "append" }))).toEqual([]);
    expect(problemsOf(api({ incremental: "updated_at", key: "id" }))).toEqual([]);
    // Incremental file ingests replace changed files by _file; a key is optional there.
    expect(problemsOf(files({ incremental: true }))).toEqual([]);
  });

  test("merge needs a key; replace cannot be incremental", () => {
    expect(one(api({ write: "merge" })).message).toBe('write: "merge" updates rows by key, and this asset has no key');
    expect(one(api({ key: "id", incremental: "t", write: "replace" })).message)
      .toBe('write: "replace" with incremental would replace the whole table with only the newly fetched rows');
    expect(one(files({ incremental: true, write: "replace" })).code).toBe("ASSET_INVALID");
  });

  test("CURSOR_TYPE_MISMATCH: lookback without unit on an integer cursor", () => {
    const pinned = one(api({ key: "id", incremental: { field: "created", lookback: "30 days" }, columns: { created: "BIGINT" } }));
    expect(pinned.code).toBe("CURSOR_TYPE_MISMATCH");
    expect(pinned.message).toBe('lookback "30 days" on an integer cursor needs a unit: croft cannot tell how much 30 days is in created without knowing it holds epoch time (columns pins created as BIGINT)');
    expect(pinned.hint).toBe('add unit: "s" (epoch seconds) or unit: "ms" (milliseconds) to incremental');
    const saved = one(api({ key: "id", incremental: { field: "created", lookback: "30 days" } }), { cursorType: "integer" });
    expect(saved.code).toBe("CURSOR_TYPE_MISMATCH");
    expect(saved.message).toEndWith("(created was loaded as an integer cursor)");
    // With a unit it is fine; with an unknown cursor type nothing can be said yet.
    expect(problemsOf(api({ key: "id", incremental: { field: "created", unit: "s", lookback: "30 days" }, columns: { created: "BIGINT" } }))).toEqual([]);
    expect(problemsOf(api({ key: "id", incremental: { field: "created", lookback: "30 days" } }))).toEqual([]);
  });

  test("CURSOR_TYPE_MISMATCH: lookback on a text cursor, unit on a timestamp cursor", () => {
    const text = one(api({ key: "id", incremental: { field: "page_token", lookback: "1 day" }, columns: { page_token: "VARCHAR" } }));
    expect(text.code).toBe("CURSOR_TYPE_MISMATCH");
    expect(text.message).toBe('a text cursor has no lookback: "1 day" cannot be subtracted from page_token (columns pins page_token as VARCHAR)');
    const unit = one(api({ key: "id", incremental: { field: "updated_at", unit: "s" } }), { cursorType: "timestamp" });
    expect(unit.code).toBe("CURSOR_TYPE_MISMATCH");
    expect(unit.message).toBe('unit "s" is for integer cursors holding epoch time, but updated_at is a timestamp cursor (updated_at was loaded as a timestamp cursor)');
  });

  test("TRANSFORM_MAKES_REQUESTS only for full-refresh transforms", () => {
    const w = one(xform({ key: "id" }), { usesHttp: true, requests: ["ctx.http", "package openai"] });
    expect(w).toMatchObject({ code: "TRANSFORM_MAKES_REQUESTS", severity: "warning" });
    expect(w.message).toContain("it makes requests (ctx.http, package openai)");
    expect(w.hint).toBe("make it incremental: incremental: true, a key, and newRows() so each input row is processed once");
    expect(problemsOf(xform({ key: "id", incremental: true }), { usesHttp: true })).toEqual([]);
    expect(problemsOf(api({}), { usesHttp: true })).toEqual([]);
    // A warning does not withhold the spec.
    expect(validateDefinition(xform({ key: "id" }), { ...O, usesHttp: true }).spec).toBeDefined();
  });

  test("no spec when there is any error", () => {
    const v = validateDefinition(api({ write: "merge" }), O);
    expect(v.spec).toBeUndefined();
    expect(v.definition).toBeUndefined();
  });

  test("every problem carries asset, file, docs and an edit fix", () => {
    const ps = problemsOf(api({ key: "", zzz: 1, retries: -1 }), { source: "export default ingest({\n  key: \"\",\n  zzz: 1,\n  retries: -1,\n});\n" });
    expect(ps.map((p) => [p.code, p.line])).toEqual([["ASSET_INVALID", 3], ["ASSET_INVALID", 2], ["ASSET_INVALID", 4]]);
    for (const p of ps) {
      expect(p).toMatchObject({ asset: "things", file: "assets/things.ts", docs: "croft docs ASSET_INVALID" });
      expect(p.fix).toMatchObject({ kind: "edit", file: "assets/things.ts", line: p.line });
    }
  });
});

// ---------------------------------------------------------------------------------------------------

describe("helpers", () => {
  test("parseDuration", () => {
    expect(parseDuration("30 days")).toBe(30 * 86_400_000);
    expect(parseDuration("10 minutes")).toBe(600_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("1 second")).toBe(1000);
    expect(parseDuration("2 weeks")).toBe(14 * 86_400_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("3 months")).toBeNull();
    expect(parseDuration("days")).toBeNull();
    expect(parseDuration("-1 day")).toBeNull();
  });

  test("cursorTypeOfPin", () => {
    expect(cursorTypeOfPin("BIGINT")).toBe("integer");
    expect(cursorTypeOfPin("ubigint")).toBe("integer");
    expect(cursorTypeOfPin("TIMESTAMPTZ")).toBe("timestamp");
    expect(cursorTypeOfPin("TIMESTAMP")).toBe("timestamp");
    expect(cursorTypeOfPin("DATE")).toBe("date");
    expect(cursorTypeOfPin("VARCHAR")).toBe("string");
    expect(cursorTypeOfPin("DOUBLE")).toBeUndefined();
    expect(cursorTypeOfPin("DECIMAL(18,2)")).toBeUndefined();
  });

  test("locateKey skips comments and matches methods", () => {
    const src = "// key: nope\nexport default ingest({\n  key: \"id\",\n  async *rows({ http }) {},\n});\n";
    expect(locateKey(src, "key")).toBe(3);
    expect(locateKey(src, "rows")).toBe(4);
    expect(locateKey(src, "missing")).toBeUndefined();
    expect(locateKey(undefined, "key")).toBeUndefined();
  });

  test("trimStack keeps project frames and makes them relative", () => {
    const root = "/Users/me/my-data";
    const stack = [
      "TypeError: x is not a function",
      "    at boom (/Users/me/my-data/lib/util.ts:4:9)",
      "    at /Users/me/my-data/node_modules/somepkg/index.js:10:2",
      "    at /Users/me/my-data/assets/a.ts:2:1",
      "    at moduleEvaluation (native)",
      "    at processTicksAndRejections (native:7:39)",
    ].join("\n");
    expect(trimStack(stack, root)).toBe([
      "TypeError: x is not a function",
      "    at boom (lib/util.ts:4:9)",
      "    at assets/a.ts:2:1",
    ].join("\n"));
    // No project frames: keep the first three so there is something to go on.
    expect(trimStack("Error: e\n    at a (native)\n    at b (native)\n    at c (native)\n    at d (native)", root).split("\n")).toHaveLength(4);
  });
});

// The agent contract: every command, flag and recipe croft tells an agent to use exists in this build.
//
// CLAUDE.md is always in the agent's context and SKILL.md is its manual; `croft docs` pages, and each
// problem's hint and fix and each next[] entry, are what it acts on next. A `croft <command>` or `--flag` in
// any of them that this build lacks sends the agent into a USAGE_ERROR at the step it was told to take. So
// this test scans all of them against the registry (cli/commands/index.ts) and the phase manifest
// (core/phase.ts):
//
// - `croft <word>` where <word> is a croft command of any phase (so "croft is not dbt" is prose) must be a
//   command of this build;
// - a `--flag` after `croft <command>` in the same command span must be one of that command's options (or a
//   global one), and not one a later phase adds;
// - a `--flag` on its own must be an option of some command of this build.
//
// The source scan (agent/contract-testkit.ts) reads every string and template literal in src/**/*.ts (tests
// and test kits aside) with the TypeScript parser, not only hints, fixes and next[] entries: a message, a
// docs line or a log line reaches the agent just the same. core/phase.ts is exempt: it names every phase's
// commands on purpose (the SKILL.md notes it renders are checked below).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { analyzeChecks, parseChecks, probeSql } from "../checks/parse.ts";
import { type Code, CODES, isCode } from "../core/errors.ts";
import type { Problem } from "../core/types.ts";
import { openMemory } from "../db/connect.ts";
import { quoteIdent } from "../load/evolve.ts";
import { type LoadedSqlAsset, loadSqlAsset } from "../project/sql-asset.ts";
import { loadTsAsset } from "../project/ts-asset.ts";
import { ShadowCatalog, type ShadowColumn } from "../sql/bind.ts";
import { LATER_COMMANDS, laterFlags, SHIPPED_COMMANDS, versionNotes } from "../core/phase.ts";
import type { Ctx } from "../cli/command.ts";
import { docs } from "../cli/commands/docs.ts";
import { COMMANDS } from "../cli/commands/index.ts";
import { EXEMPT, type Finding, registered, scan, sourceFiles, sourceStrings, SRC } from "./contract-testkit.ts";
import { claudeBlock, CROFT_VERSION, scaffold, skillMd, tsconfigJson } from "./templates.ts";

// ---------------------------------------------------------------------------------------------------------
// What the agent reads

/** SKILL.md without its "This version" section, which names the missing commands on purpose (it is rendered
 *  from the manifest; a test below checks it). */
function skillBody(): string {
  const text = skillMd();
  const notes = versionNotes(CROFT_VERSION);
  expect(text).toContain(notes);
  return text.replace(notes, "");
}

async function docsPage(name: string): Promise<string> {
  const r = await docs.run({ positionals: [name], values: {} } as unknown as Ctx);
  return (r.data as { page: string }).page;
}

async function allDocs(): Promise<{ name: string; page: string }[]> {
  const list = (await docs.run({ positionals: [], values: { list: true } } as unknown as Ctx)).data as { topics: { name: string }[] };
  const names = [...list.topics.map((t) => t.name), ...Object.keys(CODES)];
  return Promise.all(names.map(async (name) => ({ name, page: await docsPage(name) })));
}

// Known findings still to be reworded, in files outside the agent-contract fix (other areas' owners). Each
// entry must still be found, so fixing one fails this test until its entry is removed: the list only shrinks.
// Suggested rewording: croft serve → "a later croft version's read server" (or drop it; apps read the file
// directly); croft new --list → croft docs ingest; croft restore → "the trash in .croft/trash/"; and
// croft run X --rebuild → a text without the flag (this version has no rebuild).
const ELSEWHERE: { file: string; text: string }[] = [];

describe("the phase manifest matches the registry", () => {
  test("the registry has exactly this phase's commands", () => {
    expect([...registered.keys()].sort()).toEqual([...SHIPPED_COMMANDS].sort());
    for (const c of LATER_COMMANDS) expect(registered.has(c)).toBe(false);
  });

  test("no later-phase flag is registered", async () => {
    const leaks = COMMANDS.flatMap((c) => laterFlags(c.name).filter((f) => f in c.options).map((f) => `${c.name} --${f}`));
    expect(leaks).toEqual([]);
  });

  test("this phase's flags are registered", () => {
    const flags = (name: string) => Object.keys(registered.get(name)?.options ?? {});
    expect(flags("run")).toEqual(expect.arrayContaining(["dry-run", "only", "upstream"]));
    expect(flags("query")).toContain("preview");
    expect(flags("validate")).toEqual(["types"]);
    expect(flags("preview")).toEqual(["rows", "rebuild"]);
  });

  test("SKILL.md says what this version has and lacks, from the manifest", () => {
    const notes = versionNotes(CROFT_VERSION);
    expect(skillMd()).toContain(notes);
    for (const c of SHIPPED_COMMANDS) if (c !== "tick") expect(notes).toContain(c);
    expect(notes).not.toMatch(/\btick\b/);   // internal: croft runs it, an agent never does
    for (const c of LATER_COMMANDS) expect(notes).toContain(c);
    expect(notes).not.toContain("--rebuild");
    expect(notes).not.toContain("--due");
    expect(notes).toContain("validate --hook");
    expect(notes).not.toContain("--dry-run");
  });
});

describe("croft tells the agent to use only what this build has", () => {
  test("the scanner catches what it is meant to", () => {
    expect(scan("t", "Loop: edit → `croft new api x` → `croft run <asset>`").map((f) => f.problem))
      .toEqual(["croft new is phase 5; this build is phase 4"]);
    expect(scan("t", "croft rename a b; croft restore a --at 2026-09-01; croft run a --rebuild")).toEqual([]);
    expect(scan("t", "croft schedule on, then croft serve --port 7447")).toEqual([]);
    expect(scan("t", "Redo: croft run <asset> --rebuild --from -90d, then the same with --with-hook.").map((f) => f.problem))
      .toEqual(["no command of this build has --with-hook"]);
    expect(scan("t", "croft validate --hook").map((f) => f.problem)).toEqual(["croft validate --hook comes in a later phase"]);
    expect(scan("t", "croft preview x --rows 10 --dry-run").map((f) => f.problem)).toEqual(["croft preview has no option --dry-run"]);
    expect(scan("t", "croft logs x --failed → croft run x --from 2026-01-01; croft status --check")).toEqual([]);
    expect(scan("t", "`croft validate --json` → `croft preview x --rebuild` → croft run x --dry-run --upstream; croft query --preview \"from x\"")).toEqual([]);
    expect(scan("t", "croft is not dbt; croft keeps its own logs")).toEqual([]);
    expect(scan("t", "the project's own tsc --noEmit; croft validate --types")).toEqual([]);
  });

  test("CLAUDE.md (project and app) and SKILL.md", () => {
    const findings = [
      ...scan("CLAUDE.md", claudeBlock("project")),
      ...scan("CLAUDE.md (app)", claudeBlock("app")),
      ...scan("SKILL.md", skillBody()),
    ];
    expect(findings).toEqual([]);
  });

  test("the loop is edit → validate → preview → run → query, and a backfill starts with a dry run", () => {
    for (const block of [claudeBlock("project"), claudeBlock("app")]) {
      const loop = block.split("\n").find((l) => l.startsWith("Loop:"))!;
      expect([...loop.matchAll(/`(croft [^`]+)`/g)].map((m) => m[1])).toEqual([
        "croft validate --json", "croft preview <asset>", "croft run <asset>", 'croft query "..."',
      ]);
    }
    const skill = skillMd();
    for (const step of ["2. `croft validate --json` after EVERY edit", "3. `croft preview <name>`", "4. `croft run <name>`"]) {
      expect(skill).toContain(step);
    }
    expect(skill).toContain("croft run <asset> --dry-run --from -90d, then the same without --dry-run");
  });

  test("every croft docs page the texts name exists", async () => {
    // Placeholders (croft docs <topic>, the X a template literal's substitution reads as) name no page.
    const PLACEHOLDERS = new Set(["X", "CODE", "ERROR_CODE"]);
    const texts: { where: string; text: string }[] = [
      { where: "CLAUDE.md", text: claudeBlock("project") },
      { where: "CLAUDE.md (app)", text: claudeBlock("app") },
      { where: "SKILL.md", text: skillMd() },
      ...(await allDocs()).map((p) => ({ where: `croft docs ${p.name}`, text: p.page })),
    ];
    for (const file of sourceFiles()) {
      const rel = relative(SRC, file).split("\\").join("/");
      for (const s of sourceStrings(file, readFileSync(file, "utf8"))) texts.push({ where: `src/${rel}:${s.line}`, text: s.text });
    }
    const missing: string[] = [];
    for (const t of texts) {
      for (const m of t.text.matchAll(/\bcroft docs ([A-Za-z_][\w-]*)/g)) {
        if (PLACEHOLDERS.has(m[1]!)) continue;
        try {
          await docsPage(m[1]!);
        } catch {
          missing.push(`${t.where}: croft docs ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the scaffold's files", () => {
    const notes = versionNotes(CROFT_VERSION);
    const findings = scaffold({ timezone: "UTC" }).flatMap((f) => scan(f.path, f.text.replace(notes, "")));
    expect(findings).toEqual([]);
  });

  test("every croft docs page: topics and every error code", async () => {
    const pages = await allDocs();
    expect(pages.length).toBeGreaterThan(Object.keys(CODES).length);
    expect(pages.flatMap((p) => scan(`croft docs ${p.name}`, p.page))).toEqual([]);
  });

  test("every string in the source: hints, fixes, next[] entries, messages, docs", () => {
    const findings: Finding[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (EXEMPT.has(rel)) continue;
      for (const s of sourceStrings(file, readFileSync(file, "utf8"))) findings.push(...scan(`src/${rel}:${s.line}`, s.text));
    }
    const known = (f: Finding) => ELSEWHERE.some((e) => f.where.startsWith(`src/${e.file}:`) && f.text.includes(e.text));
    expect(findings.filter((f) => !known(f))).toEqual([]);
    for (const e of ELSEWHERE) expect(findings.some((f) => f.where.startsWith(`src/${e.file}:`) && f.text.includes(e.text)), `${e.file}: ${e.text} is fixed; drop it from ELSEWHERE`).toBe(true);
  });

  test("the source scan reads every string and template literal, but not names, types or module paths", () => {
    const text = `import { a } from "./a.ts";
type Mode = "--not-text";
const a = { hint: \`run croft x \${y ? "in" : "out"} --z\`, fix: { kind: "command", description: "d1", command: "c1" }, message: "m", "quoted-name": 1 };
next.push({ command: "c2", reason: cond ? "r1" : "r2" });
log(\`plain\`);`;
    expect(sourceStrings("x.ts", text).map((s) => s.text)).toEqual(["run croft x X --z", "in", "out", "command", "d1", "c1", "m", "c2", "r1", "r2", "plain"]);
    expect(sourceStrings("x.ts", text).map((s) => s.line)).toEqual([3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 5]);
    const spec = `lazyCommand({ name: "q", description: "not an option", options: { preview: { type: "boolean", description: "o1" } } });`;
    expect(sourceStrings("y.ts", spec).map((s) => s.text)).toEqual(["q", "not an option", "boolean", "o1"]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Pages for the codes, and the templates in the pages

/** The codes phase 2 brings (DESIGN.md §11: SQL assets, the bind check, checks, TS transforms, staleness), and
 *  the older ones its SQL assets and bind check raise most. Each has a page of its own. */
const PHASE_2_CODES: Code[] = [
  "HEADER_UNKNOWN_KEY", "SQL_SYNTAX", "SQL_NOT_SELECT", "SQL_NOT_ONE_STATEMENT", "PIVOT_NEEDS_VALUES", "CATALOG_PREFIX",
  "SQL_READS_FILES", "VOLATILE_SQL", "DUPLICATE_OUTPUT_COLUMN", "UNKNOWN_TABLE", "UNKNOWN_COLUMN", "QUOTE_IDENTIFIER",
  "NULL_ONLY_COLUMN", "INPUT_NOT_BUILT", "CYCLE", "CHECK_INVALID", "CHECK_FAILED", "INPUT_NEEDS_KEY", "UNDECLARED_INPUT",
  "UNKNOWN_INPUT_COLUMN", "LARGE_REPROCESS", "TRANSFORM_MAKES_REQUESTS", "EDITED_SINCE_LAST_RUN",
];

describe("croft docs pages", () => {
  test("every code phase 2 brings has a page of its own, titled with the code", async () => {
    for (const code of PHASE_2_CODES) {
      const d = (await docs.run({ positionals: [code], values: {} } as unknown as Ctx)).data as { source: string; page: string };
      expect(d.source, code).toBe("file");
      expect(d.page, code).toMatch(new RegExp(`^# ${code}: \\S`));
    }
  });

  test("a page named after a code is that code's page", async () => {
    for (const p of await allDocs()) {
      if (!isCode(p.name) || !p.page.startsWith("# ")) continue;
      expect(p.page.split("\n")[0]!.startsWith(`# ${p.name}: `), p.name).toBe(true);
    }
  });

  test("the topics for writing assets are listed", async () => {
    const list = (await docs.run({ positionals: [], values: { list: true } } as unknown as Ctx)).data as { topics: { name: string; summary: string }[] };
    const topics = new Map(list.topics.map((t) => [t.name, t.summary]));
    for (const name of ["ingest", "sql", "transforms", "checks"]) {
      expect(topics.get(name), name).toBeDefined();
      expect(topics.get(name)!.length, name).toBeLessThanOrEqual(100);
    }
  });
});

/** A fenced template in a docs page: ```ts whose first line is `// assets/<name>.ts`, or ```sql whose first
 *  line is `-- assets/<name>.sql`. Pages use no other fences, so every fenced block is checked. */
interface Template { page: string; lang: "ts" | "sql"; name: string; code: string }

async function docsTemplates(): Promise<Template[]> {
  const out: Template[] = [];
  for (const p of await allDocs()) {
    for (const m of p.page.matchAll(/```([a-z]*)\n([\s\S]*?)```/g)) {
      const [, lang, code] = m as unknown as [string, string, string];
      const name = (lang === "ts" ? /^\/\/ assets\/([a-z][a-z0-9_]*)\.ts\b/ : /^-- assets\/([a-z][a-z0-9_]*)\.sql\b/).exec(code)?.[1];
      if ((lang !== "ts" && lang !== "sql") || !name) throw new Error(`croft docs ${p.name}: a \`\`\`${lang} block that is not a template: ${code.slice(0, 80)}`);
      out.push({ page: p.name, lang, name, code });
    }
  }
  return out;
}

/** The columns of the ingests the SQL templates read, as a run types them: example_sales of a new project, and
 *  github_issues of croft docs ingest. */
const TEMPLATE_INPUTS: Record<string, ShadowColumn[]> = {
  example_sales: [
    { name: "order_id", type: "BIGINT" }, { name: "order_date", type: "DATE" }, { name: "customer", type: "VARCHAR" },
    { name: "region", type: "VARCHAR" }, { name: "product", type: "VARCHAR" }, { name: "quantity", type: "BIGINT" },
    { name: "unit_price", type: "DOUBLE" }, { name: "amount", type: "DOUBLE" }, { name: "_file", type: "VARCHAR" },
  ],
  github_issues: [
    { name: "id", type: "BIGINT" }, { name: "number", type: "BIGINT" }, { name: "title", type: "VARCHAR" },
    { name: "body", type: "VARCHAR" }, { name: "state", type: "VARCHAR" }, { name: "user", type: "JSON" },
    { name: "labels", type: "JSON" }, { name: "comments", type: "BIGINT" }, { name: "pull_request", type: "JSON" },
    { name: "created_at", type: "TIMESTAMPTZ" }, { name: "updated_at", type: "TIMESTAMPTZ" },
  ],
};

describe("the templates in croft docs pages are valid assets", () => {
  // Without `croft new` in this version, these templates are what the skill sends the agent to ("start from the
  // closest template; don't invent APIs"), so they must be the public API exactly, and SQL that DuckDB binds:
  // tsc with the scaffold's options and croft's own loaders, in a project whose node_modules has this package.
  let templates: Template[] = [];
  let dir = "";
  const pathOf = (t: Template) => join(dir, "assets", `${t.name}.${t.lang}`);

  beforeAll(async () => {
    templates = await docsTemplates();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-docs-templates-")));
    mkdirSync(join(dir, "assets"));
    mkdirSync(join(dir, "node_modules", "@zabaca"), { recursive: true });
    symlinkSync(join(SRC, ".."), join(dir, "node_modules", "@zabaca", "croft"));
    for (const t of templates) writeFileSync(pathOf(t), t.code);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the pages have their templates, each named after its file, each name once", () => {
    const count = (page: string, lang: string) => templates.filter((t) => t.page === page && t.lang === lang).length;
    expect(count("ingest", "ts")).toBeGreaterThanOrEqual(5);
    expect(count("transforms", "ts")).toBeGreaterThanOrEqual(3);
    expect(count("sql", "sql")).toBeGreaterThanOrEqual(3);
    expect(count("checks", "ts") + count("checks", "sql")).toBeGreaterThanOrEqual(2);
    const names = templates.map((t) => t.name);
    expect(names.length).toBe(new Set(names).size);
  });

  test("every TypeScript template type-checks against the real API and loads with no problem", async () => {
    const files = templates.filter((t) => t.lang === "ts");
    const options: ts.CompilerOptions = {
      ...(JSON.parse(tsconfigJson()).compilerOptions as object),
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      typeRoots: [join(SRC, "..", "node_modules", "@types")],
    } as ts.CompilerOptions;
    const program = ts.createProgram(files.map(pathOf), options);
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter((d) => d.file && files.some((f) => pathOf(f) === d.file!.fileName))
      .map((d) => `${d.file!.fileName.split("/").pop()}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    expect(diagnostics).toEqual([]);

    const db = await openMemory({ timezone: "UTC" });
    try {
      const conn = await db.connect();
      let paid = 0;
      for (const t of files) {
        const a = await loadTsAsset({ name: t.name, file: `assets/${t.name}.ts`, path: pathOf(t) }, { root: dir, timezone: "UTC" });
        expect(a.problems, `croft docs ${t.page}: ${t.name}`).toEqual([]);
        const spec = a.spec!;
        expect(spec, t.name).toBeDefined();
        const parsed = parseChecks({ asset: t.name, file: a.file, key: spec.key, checks: spec.checks, warnings: spec.warnings });
        expect(parsed.problems, t.name).toEqual([]);
        expect((await analyzeChecks(conn, t.name, parsed.checks)).problems, t.name).toEqual([]);
        // SKILL.md: a TS transform that calls an API per row keeps `incremental: true` + `newRows()`, "the template
        // default"; so a template that makes requests is incremental, and the cost guard covers it.
        if (spec.role === "transform" && a.usesHttp) {
          paid++;
          expect(spec.incremental.kind, t.name).toBe("new-rows");
        }
      }
      expect(paid).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  }, 60_000);

  test("every SQL template loads, binds against what it reads, and its checks bind to its output", async () => {
    const sql = templates.filter((t) => t.lang === "sql");
    const assetNames = [...templates.map((t) => t.name), ...Object.keys(TEMPLATE_INPUTS)];
    const db = await openMemory({ timezone: "UTC" });
    const shadow = await ShadowCatalog.open("UTC");
    try {
      const conn = await db.connect();
      const loaded = new Map<string, LoadedSqlAsset>();
      for (const t of sql) {
        const a = await loadSqlAsset({ name: t.name, file: `assets/${t.name}.sql`, path: pathOf(t) }, { root: dir, timezone: "UTC", conn, assetNames });
        expect(a.problems, `croft docs ${t.page}: ${t.name}`).toEqual([]);
        loaded.set(t.name, a);
      }
      for (const [table, columns] of Object.entries(TEMPLATE_INPUTS)) await shadow.define(table, columns);
      // In dependency order: an asset binds once what it reads has columns, and its output feeds its readers.
      const defined = new Set(Object.keys(TEMPLATE_INPUTS));
      const pending = new Set(loaded.keys());
      while (pending.size) {
        const next = [...pending].find((n) => loaded.get(n)!.astInputs.every((i) => defined.has(i)));
        if (!next) throw new Error(`no SQL template can bind: ${[...pending].map((n) => `${n} reads ${loaded.get(n)!.astInputs.join(", ")}`).join("; ")}`);
        const a = loaded.get(next)!;
        const r = await shadow.bind(a);
        expect(r.problems, a.name).toEqual([]);
        await shadow.define(a.name, r.outputColumns!);
        defined.add(a.name);
        pending.delete(a.name);
        const parsed = parseChecks({ asset: a.name, file: a.file, key: a.header.key, checks: a.header.checks, warnings: a.header.warnings });
        expect(parsed.problems, a.name).toEqual([]);
        expect((await analyzeChecks(conn, a.name, parsed.checks)).problems, a.name).toEqual([]);
        const bindProblems: Problem[] = [];
        for (const c of parsed.checks) {
          if (c.kind === "min_rows") continue;
          const body = c.kind === "rule" ? probeSql(a.name, c.sql) : `SELECT ${c.sql} FROM ${quoteIdent(a.name)}`;
          bindProblems.push(...(await shadow.bind({ ...a, body, headerLines: 0, astInputs: [a.name, ...c.reads], problems: [] })).problems);
        }
        expect(bindProblems, a.name).toEqual([]);
      }
    } finally {
      shadow.close();
      db.close();
    }
  }, 60_000);
});

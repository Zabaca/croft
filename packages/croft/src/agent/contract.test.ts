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
// The source scan (agent/contract-testkit.ts) reads the string literals of every hint, command, reason and
// todo property, every description inside a fix, and every command option's description, in src/**/*.ts
// (tests and test kits aside), with the TypeScript parser.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { CODES } from "../core/errors.ts";
import { validateDefinition } from "../project/ts-asset.ts";
import { LATER_COMMANDS, laterFlags, SHIPPED_COMMANDS, versionNotes } from "../core/phase.ts";
import type { Ctx } from "../cli/command.ts";
import { docs } from "../cli/commands/docs.ts";
import { COMMANDS } from "../cli/commands/index.ts";
import { agentStrings, type Finding, registered, scan, sourceFiles, SRC } from "./contract-testkit.ts";
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
const ELSEWHERE: { file: string; text: string }[] = [
  { file: "cli/commands/index.ts", text: "(comes with croft preview)" },                   // query --preview's help
  { file: "db/warehouse.ts", text: "apps should query through `croft serve`" },
  { file: "read/direct.ts", text: "run `croft serve` and query through it" },
  { file: "read/direct.ts", text: "query through croft serve (set CROFT_URL" },
  { file: "read/direct.ts", text: "apps should query through `croft serve`" },
  { file: "read/locate.ts", text: "to use a croft serve instead, set CROFT_URL" },
  { file: "read/locate.ts", text: "or where croft serve listens" },
  { file: "read/locate.ts", text: "use the URL croft serve printed" },
  { file: "read/server.ts", text: "as croft serve wrote it" },
  { file: "read/server.ts", text: "points at croft serve" },
  { file: "read/server.ts", text: "for the app and for croft serve" },
  { file: "read/server.ts", text: "start croft serve in the project folder" },
  { file: "read/server.ts", text: "the token croft serve uses" },
  { file: "run/ingest.ts", text: "(croft restore X)" },                                   // the --allow-shrink confirmation
  { file: "run/plan.ts", text: "croft new --list shows templates" },                        // unknown asset, no assets
  { file: "run/plan.ts", text: "croft run X --rebuild" },                                   // BACKFILL_UNSUPPORTED
  { file: "safety/guards.ts", text: "--rebuild" },                                          // OUT_OF_BAND_CHANGE
  { file: "safety/guards.ts", text: "croft run X --rebuild" },                              // TABLE_MODIFIED_OUTSIDE_CROFT
];

describe("the phase manifest matches the registry", () => {
  test("the registry has exactly this phase's commands", () => {
    expect([...registered.keys()].sort()).toEqual([...SHIPPED_COMMANDS].sort());
    for (const c of LATER_COMMANDS) expect(registered.has(c)).toBe(false);
  });

  test("no later-phase flag is registered, except query --preview, which refuses", async () => {
    const leaks = COMMANDS.flatMap((c) => laterFlags(c.name).filter((f) => f in c.options).map((f) => `${c.name} --${f}`));
    expect(leaks).toEqual(["query --preview"]);
  });

  test("SKILL.md says what this version has and lacks, from the manifest", () => {
    const notes = versionNotes(CROFT_VERSION);
    expect(skillMd()).toContain(notes);
    for (const c of SHIPPED_COMMANDS) expect(notes).toContain(c);
    for (const c of LATER_COMMANDS) expect(notes).toContain(c);
    expect(notes).toContain("run --dry-run");
  });
});

describe("croft tells the agent to use only what this build has", () => {
  test("the scanner catches what it is meant to", () => {
    expect(scan("t", "Loop: edit → `croft validate --json` → `croft run <asset>`").map((f) => f.problem))
      .toEqual(["croft validate is phase 2; this build is phase 1"]);
    expect(scan("t", "Backfill: croft run <asset> --dry-run --from -90d, then the same without --dry-run.").map((f) => f.problem))
      .toEqual(["croft run --dry-run comes in a later phase", "no command of this build has --dry-run"]);
    expect(scan("t", "croft query --preview").map((f) => f.problem)).toEqual(["croft query --preview comes in a later phase"]);
    expect(scan("t", "croft logs x --failed → croft run x --from 2026-01-01; croft status --check")).toEqual([]);
    expect(scan("t", "croft is not dbt; croft keeps its own logs")).toEqual([]);
  });

  test("CLAUDE.md (project and app) and SKILL.md", () => {
    const findings = [
      ...scan("CLAUDE.md", claudeBlock("project")),
      ...scan("CLAUDE.md (app)", claudeBlock("app")),
      ...scan("SKILL.md", skillBody()),
    ];
    expect(findings).toEqual([]);
  });

  test("the loop is edit → croft run → croft query / describe / logs, and backfill is croft run --from", () => {
    for (const block of [claudeBlock("project"), claudeBlock("app")]) {
      const loop = block.split("\n").find((l) => l.startsWith("Loop:"))!;
      expect(loop).toContain("`croft run <asset>`");
      expect(loop).toContain('`croft query "..."`');
      expect(loop).toContain("`croft describe <asset>`");
      expect(loop).toContain("`croft logs <asset>`");
    }
    expect(skillMd()).toContain("croft run <asset> --from -90d");
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

  test("every hint, fix and next[] in the source", () => {
    const findings: Finding[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(SRC, file);
      for (const s of agentStrings(file, readFileSync(file, "utf8"))) findings.push(...scan(`src/${rel}:${s.line}`, s.text));
    }
    const known = (f: Finding) => ELSEWHERE.some((e) => f.where.startsWith(`src/${e.file}:`) && f.text.includes(e.text));
    expect(findings.filter((f) => !known(f))).toEqual([]);
    for (const e of ELSEWHERE) expect(findings.some((f) => f.where.startsWith(`src/${e.file}:`) && f.text.includes(e.text)), `${e.file}: ${e.text} is fixed; drop it from ELSEWHERE`).toBe(true);
  });

  test("croft docs ingest: every template type-checks against the real API and is a valid asset", async () => {
    // Without `croft new` in this version, these templates are what the skill sends the agent to ("don't
    // invent APIs"), so they must be exactly the public API: tsc with the scaffold's options, then the
    // loader's own validation.
    const page = await docsPage("ingest");
    const blocks = [...page.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "croft-docs-ingest-")));
    try {
      const files = blocks.map((code) => {
        const name = /^\/\/ assets\/([a-z][a-z0-9_]*)\.ts/.exec(code)?.[1];
        expect(name, code.slice(0, 80)).toBeDefined();
        const path = join(dir, `${name}.ts`);
        writeFileSync(path, code.replace('from "@zabaca/croft"', `from ${JSON.stringify(join(SRC, "index.ts"))}`));
        return { name: name!, path, code };
      });
      const options: ts.CompilerOptions = {
        ...(JSON.parse(tsconfigJson()).compilerOptions as object),
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        typeRoots: [join(SRC, "..", "node_modules", "@types")],
      } as ts.CompilerOptions;
      const program = ts.createProgram(files.map((f) => f.path), options);
      const diagnostics = ts.getPreEmitDiagnostics(program)
        .filter((d) => d.file && files.some((f) => f.path === d.file!.fileName))
        .map((d) => `${d.file!.fileName.split("/").pop()}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
      expect(diagnostics).toEqual([]);
      for (const f of files) {
        const mod = await import(f.path);
        const v = validateDefinition(mod.default, { name: f.name, file: `assets/${f.name}.ts`, source: f.code, hasDefault: "default" in mod });
        expect(v.problems.filter((p) => p.severity === "error"), f.name).toEqual([]);
        expect(v.spec, f.name).toBeDefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the source scan reads hints, fixes and next[] entries", () => {
    const text = `const a = { hint: \`run croft x \${y} --z\`, fix: { kind: "command", description: "d1", command: "c1" }, message: "m" };
next.push({ command: "c2", reason: cond ? "r1" : "r2" });`;
    expect(agentStrings("x.ts", text).map((s) => s.text)).toEqual(["run croft x X --z", "d1", "c1", "c2", "r1", "r2"]);
    const spec = `lazyCommand({ name: "q", description: "not an option", options: { preview: { type: "boolean", description: "o1" } } });`;
    expect(agentStrings("y.ts", spec).map((s) => s.text)).toEqual(["o1"]);
  });
});

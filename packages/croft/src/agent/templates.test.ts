import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import pkg from "../../package.json" with { type: "json" };
import { LATER_COMMANDS, LATER_FLAGS, laterFlags } from "../core/phase.ts";
import { initProject } from "../project/init.ts";
import { parseConfig } from "../project/root.ts";
import { parseDotenv } from "../project/env.ts";
import {
  BLOCK_END, BLOCK_START, claudeBlock, croftJson, CROFT_VERSION, findBlock, gitignorePatterns, packageJson, scaffold,
  SKILL_PATH, skillMd, skillStamp, tsconfigJson, UnbalancedBlock, upsertBlock,
} from "./templates.ts";

const DESIGN = readFileSync(new URL("../../../../DESIGN.md", import.meta.url), "utf8");

/** The body of the first ```markdown fence after `marker` in DESIGN.md. */
function designBlock(marker: string): string {
  const at = DESIGN.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const open = DESIGN.indexOf("```markdown\n", at) + "```markdown\n".length;
  return DESIGN.slice(open, DESIGN.indexOf("\n```\n", open) + 1);
}

const CLAUDE_MD_9 = designBlock("**1. The `CLAUDE.md` managed block:**");
const SKILL_MD_9 = designBlock("**2. `.claude/skills/croft/SKILL.md`:**");

// Phase 5 ships every command and flag DESIGN.md §9 names, so both texts ship word for word: no line is cut or
// reworded, and SKILL.md has no "This version" section (earlier phases rendered one from core/phase.ts to name what
// they lacked). Where the shipped SKILL.md grew beyond §9 in earlier phases (the Schedule recipe, a second Backfill
// line, the missing-warehouse recipe, the status line in the command's own words), §9 took the shipped text in, so
// a byte comparison covers every line. agent/contract.test.ts checks that each command and flag they name exists.
describe("the Claude files are DESIGN.md §9, word for word", () => {
  test("CLAUDE.md managed block", () => {
    expect(claudeBlock("project")).toBe(CLAUDE_MD_9);
  });

  test("SKILL.md, stamped with the version", () => {
    expect(skillMd("0.1.0")).toBe(SKILL_MD_9);
    expect(skillMd()).toBe(SKILL_MD_9.replace("<!-- croft 0.1.0 -->", `<!-- croft ${CROFT_VERSION} -->`));
    expect(skillMd()).not.toMatch(/\{\{\w*\}\}/);
  });

  test("phase 5 has every command and flag, so SKILL.md has no This version section", () => {
    expect(LATER_COMMANDS).toEqual([]);
    for (const command of Object.keys(LATER_FLAGS)) expect(laterFlags(command), command).toEqual([]);
    const text = skillMd();
    expect(text).not.toContain("## This version");
    expect(text.split("\n").filter((l) => /this version|not built|later (phase|version)|phase \d/i.test(l))).toEqual([]);
  });

  test("a new asset starts from croft new: the header, loop step 1, files in SQL assets, cursor paging", () => {
    const lines = skillMd().split("\n");
    for (const line of [
      "`croft docs <ERROR_CODE>`, `croft docs --list`, `croft new --list`. Every command takes `--json` →",
      "1. New asset: `croft new api|file|sql|transform <name>`; edit the template, don't invent APIs.",
      "- SQL assets read assets, never files: to use a file, make a file ingest (`croft new file x`).",
      "  (`croft new api x --pagination cursor`).",
    ]) {
      expect(lines).toContain(line);
    }
    // What stood in for croft new in phases 1–4 is gone.
    expect(skillMd()).not.toMatch(/croft help <command>|the cursor template in|closest template in `croft docs/);
  });

  test("TS transforms are checked with validate --types: the loop says when, the conventions say how (R51-02)", () => {
    const lines = skillMd().split("\n");
    const step2 = lines.findIndex((l) => l.startsWith("2. `croft validate --json` after EVERY edit"));
    expect(step2).toBeGreaterThan(-1);
    expect(`${lines[step2]} ${lines[step2 + 1]}`).toContain("add `--types`");
    expect(lines[step2 + 2]).toStartWith("3. ");
    const ts = lines.findIndex((l) => l.startsWith("- TS transforms read `newRows(\"x\")`"));
    expect(ts).toBeGreaterThan(lines.findIndex((l) => l.startsWith("- TS transforms that call an API or LLM per row")));
    expect(`${lines[ts]} ${lines[ts + 1]}`).toContain("`croft validate --types`");
    expect(`${lines[ts]} ${lines[ts + 1]}`).toContain("`Number(row.x)`");
    for (const l of [...lines.slice(step2, step2 + 2), ...lines.slice(ts, ts + 2)]) expect(l.length, l).toBeLessThanOrEqual(116);
  });

  test("what earlier phases added to SKILL.md is in §9 too, in its place", () => {
    const lines = skillMd().split("\n");
    const at = (start: string) => {
      const i = lines.findIndex((l) => l.startsWith(start));
      expect(i, start).toBeGreaterThan(-1);
      return i;
    };
    // Orient: status in the command's own words.
    expect(lines).toContain("croft status                # failed, stale, held, never run, edited since its last run, no asset file");
    // Recipes: Failed run, Held asset, Schedule, Backfill (two lines), Rename, Wrong number, API changed, Missing
    // secret, Warehouse file missing.
    const order = ["- Failed run:", "- Held asset:", "- Schedule:", "- Backfill:", "- Rename:", "- Wrong number:",
      "- API changed:", "- Missing secret:", "- Warehouse file missing"].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(lines[at("- Schedule:") + 1]).toBe("  run it by hand once (new code is held until then), then ask the user before `croft schedule on`.");
    expect(lines[at("- Backfill:") + 1]).toBe("  Then run the transforms it skipped (its next[] names them), or they stay stale.");
    expect(lines[at("- Backfill:") + 2]).toBe("  A date works too (--from 2026-06-24); a text cursor takes a value in its own format. The saved cursor never moves back.");
    expect(lines[at("- Warehouse file missing") + 1]).toBe("  builds a new, empty one and refetches from the sources.");
    expect(at("## Output")).toBeGreaterThan(at("- Warehouse file missing"));
  });

  test("the app block differs from the project block only where the project lives in data/", () => {
    const project = claudeBlock("project").split("\n");
    const app = claudeBlock("app").split("\n");
    for (const line of ["<!-- croft:start (managed by `croft init --claude`) -->", project.find((l) => l.startsWith("Loop:"))!,
      "Ask the user before any command in the skill's \"Ask the user first\" list, including every `croft confirm`."]) {
      expect(app).toContain(line);
    }
  });

  test("skill front matter names the skill croft", () => {
    const text = skillMd();
    expect(text.startsWith("---\nname: croft\ndescription: ")).toBe(true);
    expect(text.split("\n").indexOf("---", 1)).toBeGreaterThan(1);
  });

  test("the app block points at data/ and at @zabaca/croft/read", () => {
    const app = claudeBlock("app");
    expect(app.startsWith(BLOCK_START)).toBe(true);
    expect(app.trimEnd().endsWith(BLOCK_END)).toBe(true);
    expect(app).toContain("data/");
    expect(app).toContain('import { query } from "@zabaca/croft/read"');
    expect(app).toContain("never open the .duckdb file directly");
  });
});

describe("skillStamp", () => {
  test("reads the version line, or null", () => {
    expect(skillStamp(skillMd("9.8.7"))).toBe("9.8.7");
    expect(skillStamp("---\nname: croft\n---\nno stamp\n")).toBeNull();
  });
});

describe("managed block", () => {
  const block = claudeBlock();

  test("created, appended, replaced in place, unchanged", () => {
    expect(upsertBlock(null, block)).toEqual({ text: block, action: "created" });
    expect(upsertBlock("", block)).toEqual({ text: block, action: "appended" });
    expect(upsertBlock("# My app\n", block)).toEqual({ text: `# My app\n\n${block}`, action: "appended" });
    expect(upsertBlock("# My app", block).text).toBe(`# My app\n\n${block}`);
    expect(upsertBlock("# My app\n\n", block).text).toBe(`# My app\n\n${block}`);

    const old = `# Mine\n\nbefore\n<!-- croft:start (managed by an older croft) -->\nold text\n<!-- croft:end -->\nafter\n`;
    const r = upsertBlock(old, block);
    expect(r.action).toBe("replaced");
    expect(r.text).toBe(`# Mine\n\nbefore\n${block}after\n`);
    expect(upsertBlock(r.text, block)).toEqual({ text: r.text, action: "unchanged" });
  });

  test("a block at the very end without a newline stays that way", () => {
    const old = "intro\n<!-- croft:start -->\nx\n<!-- croft:end -->";
    const r = upsertBlock(old, block);
    expect(r.text).toBe(`intro\n${block.slice(0, -1)}`);
    expect(upsertBlock(r.text, block).action).toBe("unchanged");
  });

  test("unbalanced markers refuse rather than guess", () => {
    expect(() => upsertBlock("a\n<!-- croft:start -->\nno end\n", block)).toThrow(UnbalancedBlock);
    expect(() => upsertBlock(`${block}\n${block}`, block)).toThrow("more than once");
    expect(findBlock("nothing here")).toBeNull();
  });
});

describe("project templates", () => {
  test("croft.json validates, with and without relocation", () => {
    const plain = parseConfig(croftJson({ timezone: "Asia/Tokyo" }));
    expect(plain).toMatchObject({ ok: true, config: { database: "warehouse.duckdb", timezone: "Asia/Tokyo", stateDir: null } });
    expect(JSON.parse(croftJson({ timezone: "UTC" }))).toEqual({
      $schema: "./node_modules/@zabaca/croft/croft.schema.json", database: "warehouse.duckdb", timezone: "UTC",
    });
    const moved = parseConfig(croftJson({ timezone: "UTC", relocated: { database: "~/.local/share/croft/x-1/warehouse.duckdb", stateDir: "~/.local/share/croft/x-1/.croft" } }));
    expect(moved).toMatchObject({ ok: true, config: { database: "~/.local/share/croft/x-1/warehouse.duckdb", stateDir: "~/.local/share/croft/x-1/.croft" } });
  });

  test("package.json pins croft and the dev tools exactly", () => {
    const p = JSON.parse(packageJson({ version: "0.1.0" }));
    expect(p).toEqual({
      private: true, type: "module",
      dependencies: { "@zabaca/croft": "0.1.0" },
      devDependencies: { "@types/bun": pkg.devDependencies["@types/bun"], typescript: pkg.devDependencies.typescript },
    });
    for (const v of [...Object.values(p.dependencies), ...Object.values(p.devDependencies)] as string[]) expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.parse(packageJson()).dependencies["@zabaca/croft"]).toBe(CROFT_VERSION);
  });

  test("tsconfig.json is strict, bundler-resolved, Bun-typed and covers assets, lib and the generated input types", () => {
    const t = JSON.parse(tsconfigJson());
    expect(t.compilerOptions).toMatchObject({ strict: true, moduleResolution: "bundler", types: ["bun"], allowImportingTsExtensions: true, noEmit: true });
    expect(t.include).toEqual(["assets", "lib", ".croft/types/**/*.d.ts"]);
  });

  test(".gitignore has exactly the four patterns", () => {
    expect(gitignorePatterns()).toEqual(["warehouse*.duckdb*", ".croft/", ".env", "node_modules/"]);
  });

  test(".env and .env.example hold only a comment", () => {
    const files = scaffold({ timezone: "UTC" });
    const env = files.find((f) => f.path === ".env")!;
    expect(env.mode).toBe(0o600);
    expect(env.text).toBe("# Secrets for your assets, e.g. GITHUB_TOKEN=...\n");
    expect(files.find((f) => f.path === ".env.example")!.text).toBe(env.text);
    expect(parseDotenv(env.text).values.size).toBe(0);
  });

  test("the scaffold file list", () => {
    expect(scaffold({ timezone: "UTC" }).map((f) => f.path)).toEqual([
      "croft.json", "package.json", "tsconfig.json", ".gitignore", ".env", ".env.example", "CLAUDE.md",
      SKILL_PATH, "assets/example_sales.ts", "files/example_sales.csv",
    ]);
  });

  test("example_sales.csv: a header and 120 rows with unique ids, ISO dates and consistent amounts", () => {
    const csv = scaffold({ timezone: "UTC" }).find((f) => f.path === "files/example_sales.csv")!.text;
    const [header, ...rows] = csv.trimEnd().split("\n");
    expect(header).toBe("order_id,order_date,customer,region,product,quantity,unit_price,amount");
    expect(rows).toHaveLength(120);
    const ids = new Set<string>();
    for (const row of rows) {
      const cells = row.split(",");
      expect(cells).toHaveLength(8);
      const [id, date, customer, , , qty, price, amount] = cells as [string, string, string, string, string, string, string, string];
      ids.add(id);
      expect(date).toMatch(/^2026-\d\d-\d\d$/);
      expect(customer.length).toBeGreaterThan(0);
      expect(Number(qty)).toBeGreaterThan(0);
      expect(Number(amount)).toBeCloseTo(Number(qty) * Number(price), 2);
    }
    expect(ids.size).toBe(120);
  });

  test("the example asset is a file ingest of files/example_sales.csv, and points at croft new for more", async () => {
    const text = scaffold({ timezone: "UTC" }).find((f) => f.path === "assets/example_sales.ts")!.text;
    expect(text).toContain('import { ingest } from "@zabaca/croft";');
    expect(text).toContain("croft new api <name>");
    expect(text).toContain("croft new file <name>");
    // It also type-checks against the real API: tsconfig includes src/agent/project/assets.
    const mod = (await import("./project/assets/example_sales.ts")).default;
    expect(mod.__croft).toBe("ingest");
    expect(mod.config).toMatchObject({ file: "files/example_sales.csv", key: "order_id" });
  });
});

// The input types croft generates for TS transforms live in .croft/types (DESIGN.md §11 phase 5; project/types-gen.ts).
// The project's own tsconfig.json takes them in, so an editor, Claude and `croft validate --types` (the project's tsc)
// all check a transform's rows against its inputs' columns. These tests type-check a project exactly as croft init
// writes it, with the TypeScript this package pins, against this package's own source.
describe("the tsconfig.json croft init writes takes in .croft/types", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-tsconfig-")));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const PKG = fileURLToPath(new URL("../../", import.meta.url));
  let n = 0;

  /** A project from initProject (no install), with node_modules linked to this package and its Bun types. */
  async function project(): Promise<string> {
    const root = join(base, `p${n++}`);
    await initProject({ target: root, install: false, timezone: "UTC", synced: () => null });
    mkdirSync(join(root, "node_modules", "@zabaca"), { recursive: true });
    symlinkSync(PKG, join(root, "node_modules", "@zabaca", "croft"));
    symlinkSync(join(PKG, "node_modules", "@types"), join(root, "node_modules", "@types"));
    return root;
  }

  const write = (root: string, path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  /** `tsc --noEmit -p <root>`: the project files the tsconfig takes in, and every error (croft's own source too). */
  function typecheck(root: string): { files: string[]; errors: string[] } {
    const read = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
    expect(read.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
    const rel = (f: string) => relative(root, f).split(sep).join("/");
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const errors = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((d) =>
      `${d.file ? rel(d.file.fileName) : "tsconfig.json"}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    return { files: parsed.fileNames.map(rel).sort(), errors };
  }

  // What types-gen writes, and how rows() picks it up, is its builder's. What the tsconfig owes it: a declaration
  // under .croft/types is part of the project, so a type it declares checks an asset's reads. The transform casts
  // its rows so this holds whatever rows() itself returns.
  const salesType = (region: string) => `// Generated by croft from the catalog: the columns of example_sales.
type ExampleSalesRow = { order_id: number; order_date: string; customer: string; ${region}: string; amount: number };
`;
  const byRegion = `import { transform } from "@zabaca/croft";

export default transform({
  inputs: ["example_sales"],
  async *rows(ctx) {
    for await (const row of ctx.rows("example_sales")) {
      const r = row as ExampleSalesRow;
      yield { region: r.region, amount: r.amount };
    }
  },
});
`;

  test("init writes it, in a new project and in an app's data/", async () => {
    const root = await project();
    expect(readFileSync(join(root, "tsconfig.json"), "utf8")).toBe(tsconfigJson());
    const app = join(base, `app${n++}`);
    write(app, "package.json", "{}\n");
    await initProject({ target: app, install: false, timezone: "UTC", synced: () => null });
    expect(readFileSync(join(app, "data", "tsconfig.json"), "utf8")).toBe(tsconfigJson());
  });

  test("a new project type-checks, before any types are generated", async () => {
    const root = await project();
    expect(typecheck(root)).toEqual({ files: ["assets/example_sales.ts"], errors: [] });
  }, 60_000);

  test("a transform typed by a generated row type type-checks, and a renamed column is a type error", async () => {
    const root = await project();
    write(root, ".croft/types/example_sales.d.ts", salesType("region"));
    write(root, "assets/by_region.ts", byRegion);
    expect(typecheck(root)).toEqual({
      files: [".croft/types/example_sales.d.ts", "assets/by_region.ts", "assets/example_sales.ts"], errors: [],
    });

    // The column is renamed upstream and the types are generated again: tsc names the transform's stale read.
    write(root, ".croft/types/example_sales.d.ts", salesType("sales_region"));
    const { errors } = typecheck(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("assets/by_region.ts: Property 'region' does not exist on type 'ExampleSalesRow'.");
  }, 60_000);

  test("only declaration files under .croft/types: croft's other state is never compiled", async () => {
    const root = await project();
    write(root, ".croft/types/example_sales.d.ts", salesType("region"));
    write(root, ".croft/types/stray.ts", "export const x: number = 'not a number';\n");
    write(root, ".croft/preview/notes.d.ts", "declare const broken: ;\n");
    expect(typecheck(root)).toEqual({ files: [".croft/types/example_sales.d.ts", "assets/example_sales.ts"], errors: [] });
  }, 60_000);

  test("without the include, the generated types are not seen", async () => {
    const root = await project();
    write(root, ".croft/types/example_sales.d.ts", salesType("region"));
    write(root, "assets/by_region.ts", byRegion);
    const t = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ ...t, include: ["assets", "lib"] }));
    expect(typecheck(root).errors).toEqual(["assets/by_region.ts: Cannot find name 'ExampleSalesRow'."]);
  }, 60_000);
});

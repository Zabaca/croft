import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import pkg from "../../package.json" with { type: "json" };
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
  const open = DESIGN.indexOf("```markdown\n", at) + "```markdown\n".length;
  return DESIGN.slice(open, DESIGN.indexOf("\n```\n", open) + 1);
}

// DESIGN.md §9 holds the v1 texts, for all five phases. This build ships phase 2, so its texts leave out or
// reword every line that sends the agent to a command, flag or feature phase 2 lacks (agent/contract.test.ts
// checks the commands and flags). Every other §9 line ships word for word, and each line that does not is
// listed here with the reason, so no rule of §9 disappears unnoticed. Match: the start of the §9 line.
const CUT_FROM_CLAUDE_MD: [string, string][] = [];
const CUT_FROM_SKILL: [string, string][] = [
  ["  source, writing SQL or TypeScript transforms, adding checks, scheduling,", "description: scheduling is phase 3"],
  ["  renaming, or answering", "description: rename is phase 4"],
  ["`croft docs <ERROR_CODE>`, `croft docs --list`, `croft new --list`.", "new is phase 5: croft help <command> instead"],
  ["croft context --json        # assets, columns, behavior, schedules, running, held,", "no schedules or holds before phase 3"],
  ["croft status                # failed, stale, held, edited, orphaned", "no holds before phase 3; orphaned is worded as status says it"],
  ["1. New asset: `croft new api|file|sql|transform <name>`", "new is phase 5: the templates are croft docs ingest, sql and transforms"],
  ["  SQL transforms are always rebuilt in full", "schedules are phase 3: the sentence on them is left out"],
  ["- SQL assets read assets, never files", "new is phase 5: the file ingest template is in croft docs ingest"],
  ["- Apps read with `import { query } from \"@zabaca/croft/read\"`. It talks to `croft serve`", "serve is phase 3: direct reads only"],
  ["- `croft serve` runs until stopped", "serve is phase 3"],
  ["- For a GUI (DuckDB UI, DBeaver), set \"readCopy\": true", "readCopy is phase 3: merged into the Apps line (never open the file)"],
  ["  (`croft new api x --pagination cursor`).", "new is phase 5: the cursor template in croft docs ingest"],
  ["- `croft confirm <token>` (every destructive action ends here: rebuild of an ingest", "rebuild, delete, restore, pin changes and key conversion are phase 4: phase 2 confirms --allow-shrink and LARGE_REPROCESS"],
  ["  --allow-shrink, delete, restore, lossy pin changes,", "second line of the confirm rule"],
  ["- Renaming or deleting files in assets/ (use `croft rename`); `croft schedule", "rename is phase 4, schedule phase 3"],
  ["- `croft serve` (it runs scheduled work unattended", "serve is phase 3"],
  ["- Deleting .croft/ or warehouse*.duckdb, or `git clean -X` (the trash and backups live", "no pre-upgrade backups until phase 4"],
  ["- Held asset:", "holds come with the scheduler (phase 3)"],
  ["- Rename: croft rename", "rename is phase 4"],
];

/** The §9 lines missing from `shipped`, each matched to exactly one entry of `cuts` (and each entry used). */
function checkCuts(design: string, shipped: string, cuts: [string, string][]): void {
  const lines = new Set(shipped.split("\n"));
  const missing = design.split("\n").filter((l) => !lines.has(l));
  const unexplained = missing.filter((l) => cuts.filter(([start]) => l.startsWith(start)).length !== 1);
  expect(unexplained).toEqual([]);
  const unused = cuts.filter(([start]) => missing.filter((l) => l.startsWith(start)).length !== 1).map(([start]) => start);
  expect(unused).toEqual([]);
}

describe("the Claude files are DESIGN.md §9, cut to what this build ships", () => {
  test("CLAUDE.md managed block", () => {
    checkCuts(designBlock("**1. The `CLAUDE.md` managed block:**"), claudeBlock("project"), CUT_FROM_CLAUDE_MD);
    expect(claudeBlock("project").split("\n")).toHaveLength(designBlock("**1. The `CLAUDE.md` managed block:**").split("\n").length);
    // Phase 2 has every command the block names, so it ships word for word.
    if (CUT_FROM_CLAUDE_MD.length === 0) expect(claudeBlock("project")).toBe(designBlock("**1. The `CLAUDE.md` managed block:**"));
  });

  test("SKILL.md, stamped with the version", () => {
    checkCuts(designBlock("**2. `.claude/skills/croft/SKILL.md`:**"), skillMd("0.1.0"), CUT_FROM_SKILL);
    expect(skillMd()).toContain(`<!-- croft ${CROFT_VERSION} -->`);
    expect(skillMd()).not.toContain("{{version}}");
    expect(skillMd()).not.toContain("{{phase}}");
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

  test("tsconfig.json is strict, bundler-resolved, Bun-typed and covers assets and lib", () => {
    const t = JSON.parse(tsconfigJson());
    expect(t.compilerOptions).toMatchObject({ strict: true, moduleResolution: "bundler", types: ["bun"], allowImportingTsExtensions: true, noEmit: true });
    expect(t.include).toEqual(["assets", "lib"]);
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

  test("the example asset is a file ingest of files/example_sales.csv", async () => {
    const text = scaffold({ timezone: "UTC" }).find((f) => f.path === "assets/example_sales.ts")!.text;
    expect(text).toContain('import { ingest } from "@zabaca/croft";');
    // It also type-checks against the real API: tsconfig includes src/agent/project/assets.
    const mod = (await import("./project/assets/example_sales.ts")).default;
    expect(mod.__croft).toBe("ingest");
    expect(mod.config).toMatchObject({ file: "files/example_sales.csv", key: "order_id" });
  });
});

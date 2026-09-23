import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CroftError } from "../core/errors.ts";
import { isValidTimeZone } from "../core/time.ts";
import { claudeBlock, CROFT_VERSION, SKILL_PATH, skillMd, skillStamp } from "../agent/templates.ts";
import { appInstructions, appRootOf, detectTimeZone, initProject, relocationPlan, type InitOptions } from "./init.ts";
import { loadProject, relocationDir } from "./root.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-init-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
function fresh(files: Record<string, string> = {}): string {
  const d = join(base, `t${n++}`);
  mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), text);
  }
  return d;
}

/** Every file and folder under dir, "/"-separated and sorted (folders end in "/"). */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (e.isDirectory()) { out.push(`${rel}/`); walk(p); } else out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

const read = (p: string) => readFileSync(p, "utf8");
const opts = (target: string, o: Partial<InitOptions> = {}): InitOptions =>
  ({ target, install: false, timezone: "Asia/Tokyo", synced: () => null, ...o });

async function refusal(p: Promise<unknown>): Promise<CroftError> {
  try { await p; } catch (e) { if (e instanceof CroftError) return e; throw e; }
  throw new Error("expected a CroftError");
}

describe("croft init in an empty folder", () => {
  test("creates the scaffold (file list and key contents)", async () => {
    const target = join(fresh(), "my-data");
    const r = await initProject(opts(target));
    expect(r).toMatchObject({ mode: "new", root: target, base: target, timezone: "Asia/Tokyo", relocation: null, tsconfig: null, appSteps: [] });
    expect(tree(target)).toEqual([
      ".claude/", ".claude/skills/", ".claude/skills/croft/", ".claude/skills/croft/SKILL.md", ".croft/", ".env", ".env.example",
      ".gitignore", "CLAUDE.md", "assets/", "assets/example_sales.ts", "croft.json", "files/", "files/example_sales.csv",
      "package.json", "tsconfig.json",
    ]);
    expect(r.files.map((f) => f.path)).toEqual([
      "croft.json", "package.json", "tsconfig.json", ".gitignore", ".env", ".env.example", "CLAUDE.md", SKILL_PATH,
      "assets/example_sales.ts", "files/example_sales.csv",
    ]);
    expect(r.files.every((f) => f.action === "created")).toBe(true);

    expect(JSON.parse(read(join(target, "croft.json")))).toEqual({
      $schema: "./node_modules/@zabaca/croft/croft.schema.json", database: "warehouse.duckdb", timezone: "Asia/Tokyo",
    });
    expect(JSON.parse(read(join(target, "package.json"))).dependencies).toEqual({ "@zabaca/croft": CROFT_VERSION });
    expect(read(join(target, ".gitignore"))).toContain("warehouse*.duckdb*\n.croft/\n.env\nnode_modules/\n");
    expect(read(join(target, "CLAUDE.md"))).toBe(claudeBlock("project"));
    expect(skillStamp(read(join(target, SKILL_PATH)))).toBe(CROFT_VERSION);
    expect(read(join(target, "files/example_sales.csv")).trimEnd().split("\n")).toHaveLength(121);
    expect(statSync(join(target, ".env")).mode & 0o777).toBe(0o600);
    // The result is a valid project.
    expect(loadProject({ root: target }).paths.database).toBe(join(target, "warehouse.duckdb"));
    expect(r.install).toEqual({ ran: false, reason: "skipped (--no-install)" });
    expect(r.example.ran).toBe(false);
  });

  test("an existing empty folder works the same; .croft/ is created", async () => {
    const target = fresh();
    const r = await initProject(opts(target));
    expect(r.mode).toBe("new");
    expect(existsSync(join(target, ".croft"))).toBe(true);
  });

  test("a folder with other files keeps them; .gitignore and CLAUDE.md are merged, not replaced", async () => {
    const target = fresh({ "README.md": "# hi\n", ".gitignore": "dist/\n.env\n", "CLAUDE.md": "# House rules\nBe nice.\n", "tsconfig.json": "{}\n" });
    const r = await initProject(opts(target));
    expect(read(join(target, "README.md"))).toBe("# hi\n");
    expect(read(join(target, "tsconfig.json"))).toBe("{}\n");
    expect(read(join(target, ".gitignore"))).toBe("dist/\n.env\n# croft\nwarehouse*.duckdb*\n.croft/\nnode_modules/\n");
    expect(read(join(target, "CLAUDE.md"))).toBe(`# House rules\nBe nice.\n\n${claudeBlock("project")}`);
    const byPath = Object.fromEntries(r.files.map((f) => [f.path, f.action]));
    expect(byPath).toMatchObject({ ".gitignore": "merged", "CLAUDE.md": "appended", "tsconfig.json": "skipped", "croft.json": "created" });
  });

  test("an existing .env is never touched", async () => {
    const target = fresh({ ".env": "STRIPE_KEY=sk_live_keep\n" });
    await initProject(opts(target));
    expect(read(join(target, ".env"))).toBe("STRIPE_KEY=sk_live_keep\n");
  });

  test("refuses an existing project, a file, and leaves the disk alone", async () => {
    const target = fresh();
    await initProject(opts(target));
    const e = await refusal(initProject(opts(target, { displayTarget: "my-data" })));
    expect(e.code).toBe("USAGE_ERROR");
    expect(e.problem.message).toContain("is already a croft project");
    expect(e.problem.fix).toEqual({ kind: "command", description: "refresh the Claude files", command: "croft init my-data --claude" });

    const file = join(fresh(), "f.txt");
    writeFileSync(file, "x");
    expect((await refusal(initProject(opts(file)))).problem.message).toContain("is a file");
  });

  test("the time zone defaults to this machine's, as a valid IANA name", async () => {
    expect(isValidTimeZone(detectTimeZone())).toBe(true);
    const target = fresh();
    const { timezone: _, ...rest } = opts(target);
    const r = await initProject(rest);
    expect(r.timezone).toBe(detectTimeZone());
    expect(loadProject({ root: target }).timezone).toBe(detectTimeZone());
  });
});

describe("croft init in an existing app repo", () => {
  const APP_TSCONFIG = `{\n  "compilerOptions": { "strict": true },\n  "include": ["**/*.ts", "**/*.tsx"],\n  "exclude": ["node_modules"]\n}\n`;
  const APP = {
    "package.json": JSON.stringify({ name: "shop", dependencies: { next: "15.0.0", react: "19.0.0" } }, null, 2),
    "tsconfig.json": APP_TSCONFIG,
    "CLAUDE.md": "# Shop\n\nUse pnpm.\n",
    "README.md": "readme\n",
    "bun.lock": "{}\n",
    "src/page.tsx": "export default 1;\n",
  };

  test("creates data/, never overwrites app files, appends the root CLAUDE.md block, prints the tsconfig edit", async () => {
    const app = fresh(APP);
    const before = Object.fromEntries(Object.keys(APP).map((f) => [f, read(join(app, f))]));
    const r = await initProject(opts(app));
    expect(r).toMatchObject({ mode: "app", base: app, root: join(app, "data") });

    for (const f of ["package.json", "tsconfig.json", "README.md", "bun.lock", "src/page.tsx"]) expect(read(join(app, f))).toBe(before[f]!);
    expect(read(join(app, "CLAUDE.md"))).toBe(`# Shop\n\nUse pnpm.\n\n${claudeBlock("app")}`);
    expect(read(join(app, SKILL_PATH))).toBe(skillMd());

    expect(tree(join(app, "data"))).toEqual([
      ".claude/", ".claude/skills/", ".claude/skills/croft/", ".claude/skills/croft/SKILL.md", ".croft/", ".env", ".env.example",
      ".gitignore", "CLAUDE.md", "assets/", "assets/example_sales.ts", "croft.json", "files/", "files/example_sales.csv",
      "package.json", "tsconfig.json",
    ]);
    expect(read(join(app, "data", "CLAUDE.md"))).toBe(claudeBlock("project"));
    expect(r.files.map((f) => `${f.path}:${f.action}`)).toEqual([
      "data/croft.json:created", "data/package.json:created", "data/tsconfig.json:created", "data/.gitignore:created",
      "data/.env:created", "data/.env.example:created", "data/CLAUDE.md:created", `data/${SKILL_PATH}:created`,
      "data/assets/example_sales.ts:created", "data/files/example_sales.csv:created", "CLAUDE.md:appended", `${SKILL_PATH}:created`,
    ]);

    expect(r.tsconfig).toEqual({
      file: "tsconfig.json", status: "suggested", reason: "tsconfig.json would type-check data/, which needs Bun's types",
      diff: `--- tsconfig.json\n+++ tsconfig.json\n@@ line 4 @@\n-  "exclude": ["node_modules"]\n+  "exclude": ["node_modules", "data"]`,
    });
    expect(r.appSteps).toEqual([
      `bun add @zabaca/croft@${CROFT_VERSION}`,
      "Next.js: add serverExternalPackages: ['@duckdb/node-api'] to next.config",
      'read data in app code with import { query } from "@zabaca/croft/read"; never open the .duckdb file directly',
    ]);
    // The app's root still finds the project (findRoot checks ./data/croft.json).
    expect(loadProject({ cwd: app }).root).toBe(join(app, "data"));
  });

  test("the tsconfig edit is applied only after a yes", async () => {
    const yes = fresh(APP);
    const asked: string[] = [];
    const r = await initProject(opts(yes, { confirmEdit: async (e) => { asked.push(e.diff); return true; } }));
    expect(asked).toHaveLength(1);
    expect(r.tsconfig?.status).toBe("applied");
    expect(read(join(yes, "tsconfig.json"))).toBe(APP_TSCONFIG.replace(`["node_modules"]`, `["node_modules", "data"]`));

    const no = fresh(APP);
    const r2 = await initProject(opts(no, { confirmEdit: async () => false }));
    expect(r2.tsconfig?.status).toBe("declined");
    expect(read(join(no, "tsconfig.json"))).toBe(APP_TSCONFIG);
  });

  test("no tsconfig, or one that already excludes data: nothing to suggest", async () => {
    const plain = fresh({ "package.json": "{}" });
    expect((await initProject(opts(plain))).tsconfig).toBeNull();
    const done = fresh({ "package.json": "{}", "tsconfig.json": `{"exclude": ["node_modules", "data"]}` });
    expect((await initProject(opts(done))).tsconfig).toBeNull();
  });

  test("refuses a second init, and a data/ that holds other files, without writing anything", async () => {
    const app = fresh(APP);
    await initProject(opts(app));
    const again = await refusal(initProject(opts(app)));
    expect(again.problem.message).toContain("already has a croft project in data/");

    const busy = fresh({ ...APP, "data/fixtures.json": "[]" });
    const e = await refusal(initProject(opts(busy)));
    expect(e.code).toBe("USAGE_ERROR");
    expect(read(join(busy, "CLAUDE.md"))).toBe(APP["CLAUDE.md"]);
    expect(existsSync(join(busy, SKILL_PATH))).toBe(false);
  });

  test("unbalanced croft markers in the app's CLAUDE.md: refuse before writing", async () => {
    const app = fresh({ ...APP, "CLAUDE.md": "# Shop\n<!-- croft:start -->\nhalf a block\n" });
    const e = await refusal(initProject(opts(app)));
    expect(e.code).toBe("USAGE_ERROR");
    expect(e.problem.message).toContain("has no matching");
    expect(existsSync(join(app, "data"))).toBe(false);
  });

  test("app instructions follow the lockfile and the framework", () => {
    expect(appInstructions(fresh({ "package.json": "{}", "pnpm-lock.yaml": "" }), "1.2.3")[0]).toBe("pnpm add @zabaca/croft@1.2.3");
    expect(appInstructions(fresh({ "package.json": "{}", "yarn.lock": "" }), "1.2.3")[0]).toBe("yarn add @zabaca/croft@1.2.3");
    const npm = appInstructions(fresh({ "package.json": "{}" }), "1.2.3");
    expect(npm).toHaveLength(2);
    expect(npm[0]).toBe("npm install @zabaca/croft@1.2.3");
  });
});

describe("croft init --claude", () => {
  test("is idempotent and replaces only the managed block", async () => {
    const root = fresh();
    await initProject(opts(root));
    const again = await initProject(opts(root, { claudeOnly: true }));
    expect(again.mode).toBe("claude");
    expect(again.files).toEqual([{ path: "CLAUDE.md", action: "unchanged" }, { path: SKILL_PATH, action: "unchanged" }]);

    // An older croft wrote these: a different block and an older stamp. The user's own text stays.
    writeFileSync(join(root, "CLAUDE.md"), "# Mine\n\n<!-- croft:start (managed by `croft init --claude`) -->\nold\n<!-- croft:end -->\n\n## More of mine\n");
    writeFileSync(join(root, SKILL_PATH), skillMd("0.0.1"));
    const refreshed = await initProject(opts(root, { claudeOnly: true }));
    expect(refreshed.files).toEqual([{ path: "CLAUDE.md", action: "replaced" }, { path: SKILL_PATH, action: "replaced" }]);
    expect(read(join(root, "CLAUDE.md"))).toBe(`# Mine\n\n${claudeBlock("project")}\n## More of mine\n`);
    expect(skillStamp(read(join(root, SKILL_PATH)))).toBe(CROFT_VERSION);
    const third = await initProject(opts(root, { claudeOnly: true }));
    expect(third.files.every((f) => f.action === "unchanged")).toBe(true);
    // Nothing else was touched.
    expect(existsSync(join(root, "warehouse.duckdb"))).toBe(false);
  });

  test("recreates missing Claude files; works from a subfolder; refuses outside a project", async () => {
    const root = fresh();
    await initProject(opts(root));
    rmSync(join(root, ".claude"), { recursive: true });
    rmSync(join(root, "CLAUDE.md"));
    const r = await initProject(opts(join(root, "assets"), { claudeOnly: true }));
    expect(r.root).toBe(root);
    expect(r.files).toEqual([{ path: "CLAUDE.md", action: "created" }, { path: SKILL_PATH, action: "created" }]);

    const e = await refusal(initProject(opts(fresh(), { claudeOnly: true })));
    expect(e.code).toBe("PROJECT_NOT_FOUND");
  });

  test("in an app repo it refreshes data/ and the app root", async () => {
    const app = fresh({ "package.json": "{}", "CLAUDE.md": "# App\n" });
    await initProject(opts(app));
    writeFileSync(join(app, SKILL_PATH), skillMd("0.0.1"));
    const r = await initProject(opts(app, { claudeOnly: true }));
    expect(r.root).toBe(join(app, "data"));
    expect(r.files).toEqual([
      { path: "data/CLAUDE.md", action: "unchanged" }, { path: `data/${SKILL_PATH}`, action: "unchanged" },
      { path: "CLAUDE.md", action: "unchanged" }, { path: SKILL_PATH, action: "replaced" },
    ]);
    expect(read(join(app, "CLAUDE.md"))).toBe(`# App\n\n${claudeBlock("app")}`);
  });

  test("a project that is merely called data/ under some package.json leaves the parent alone", async () => {
    const parent = fresh({ "package.json": "{}", "CLAUDE.md": "# Monorepo\n" });
    await initProject(opts(join(parent, "data")));                  // package.json is in the parent, not in data/
    expect(appRootOf(join(parent, "data"))).toBeNull();
    const r = await initProject(opts(join(parent, "data"), { claudeOnly: true }));
    expect(r.files.map((f) => f.path)).toEqual(["CLAUDE.md", SKILL_PATH]);
    expect(read(join(parent, "CLAUDE.md"))).toBe("# Monorepo\n");
    expect(existsSync(join(parent, SKILL_PATH))).toBe(false);
  });
});

describe("relocation off synced folders", () => {
  test("a synced location moves the database and .croft/ under ~/.local/share/croft and records it", async () => {
    const home = fresh();
    const target = join(home, "Documents", "My Data");
    const seen: string[] = [];
    const r = await initProject(opts(target, { home, synced: (p) => { seen.push(p); return p.includes("/Documents/") ? "iCloud Drive" : null; } }));
    expect(seen).toEqual([target]);
    const dir = relocationDir(target, home);
    expect(dir).toMatch(/\/\.local\/share\/croft\/my-data-[0-9a-f]{8}$/);
    const rel = relative(home, dir).split(sep).join("/");
    expect(r.relocation).toEqual({ reason: "iCloud Drive", dir, database: `~/${rel}/warehouse.duckdb`, stateDir: `~/${rel}/.croft` });
    expect(JSON.parse(read(join(target, "croft.json")))).toMatchObject({ database: `~/${rel}/warehouse.duckdb`, stateDir: `~/${rel}/.croft` });
    expect(existsSync(join(dir, ".croft"))).toBe(true);
    expect(existsSync(join(target, ".croft"))).toBe(false);
    // Asset files stay in the project folder; loadProject resolves the moved paths.
    expect(existsSync(join(target, "assets", "example_sales.ts"))).toBe(true);
    const p = loadProject({ root: target, home });
    expect(p.paths.database).toBe(join(dir, "warehouse.duckdb"));
    expect(p.paths.stateDir).toBe(join(dir, ".croft"));
    expect(p.paths.filesDir).toBe(join(target, "files"));
    expect(p.relocated).toBe(true);
  });

  test("a local folder is not relocated", async () => {
    const r = await initProject(opts(fresh(), { synced: () => null }));
    expect(r.relocation).toBeNull();
  });

  test("the default detector relocates a project under ~/Documents on macOS", async () => {
    if (process.platform !== "darwin") return;
    const home = fresh();
    const { synced: _, ...rest } = opts(join(home, "Documents", "sales"), { home });
    const r = await initProject(rest);
    expect(r.relocation?.reason).toContain("iCloud");
  });

  test("a relocation dir outside home is recorded as an absolute path", () => {
    const plan = relocationPlan("/srv/data", "a network filesystem (nfs)", "/home/ada");
    expect(plan.database.startsWith("/home/ada/.local/share/croft/")).toBe(false);
    expect(plan.database).toBe("~/.local/share/croft/data-" + plan.dir.slice(-8) + "/warehouse.duckdb");
    const odd = relocationPlan("/srv/data", "nfs", "/");
    expect(odd.database.startsWith("/")).toBe(true);
  });
});

describe("install and the example hook", () => {
  test("runs the installer in the project root, then the example runner", async () => {
    const target = fresh({ "package.json": "{}" });
    const calls: string[] = [];
    const r = await initProject(opts(target, {
      install: true,
      runInstall: (root) => { calls.push(`install ${root}`); return { ran: true, ok: true, command: "bun install", ms: 12 }; },
      runExample: async (root) => { calls.push(`example ${root}`); return { ran: true, ok: true, asset: "example_sales", rows: 120, checks: "ok" }; },
    }));
    expect(calls).toEqual([`install ${join(target, "data")}`, `example ${join(target, "data")}`]);
    expect(r.install).toEqual({ ran: true, ok: true, command: "bun install", ms: 12 });
    expect(r.example).toMatchObject({ ran: true, rows: 120 });
  });

  test("a failed install skips the example", async () => {
    let ran = false;
    const r = await initProject(opts(fresh(), {
      install: true,
      runInstall: () => ({ ran: true, ok: false, command: "bun install", ms: 5, output: "error: offline" }),
      runExample: async () => { ran = true; return { ran: true, ok: true, asset: "example_sales", rows: 0, checks: "ok" }; },
    }));
    expect(ran).toBe(false);
    expect(r.example).toEqual({ ran: false, reason: "dependencies are not installed" });
  });
});

test("a new project type-checks with its own tsconfig against the installed croft", async () => {
  const target = fresh();
  await initProject(opts(target));
  const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
  mkdirSync(join(target, "node_modules", "@zabaca"), { recursive: true });
  symlinkSync(pkgRoot, join(target, "node_modules", "@zabaca", "croft"));
  symlinkSync(join(pkgRoot, "node_modules", "@types"), join(target, "node_modules", "@types"));
  const tsc = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
  const ok = Bun.spawnSync([process.execPath, tsc, "--noEmit", "-p", target], { stdout: "pipe", stderr: "pipe" });
  expect(ok.stdout.toString() + ok.stderr.toString()).toBe("");
  expect(ok.exitCode).toBe(0);

  // And a mistake in an asset is caught.
  writeFileSync(join(target, "assets", "broken.ts"), `import { ingest } from "@zabaca/croft";\nexport default ingest({ file: 42 });\n`);
  const bad = Bun.spawnSync([process.execPath, tsc, "--noEmit", "-p", target], { stdout: "pipe", stderr: "pipe" });
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stdout.toString()).toContain("assets/broken.ts");
}, 30_000);

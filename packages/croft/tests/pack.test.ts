// The npm package as published (DESIGN.md §2, §10). dist/ is git-ignored, so a clean checkout has no
// dist/read.js although package.json exports "./read" from it: `npm pack` (and publish) must build it through
// prepack. The tarball ships the CLI, its schema and the built read helper, and no tests, test kits or fixtures.
//
// Runs `npm pack --dry-run --json` on a copy of the package without dist/ and node_modules, as a clean checkout
// has it. Skipped, with a note, where npm is not installed.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const PKG = resolve(import.meta.dir, "..");
const NPM = Bun.which("npm");
if (!NPM) console.warn("tests/pack.test.ts: npm is not installed; skipping the check of what `npm pack` ships");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** The package as a clean checkout has it: no dist/ (git-ignored, built by prepack) and no node_modules. */
function cleanCheckout(): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "croft-pack-"))), "croft");
  made.push(dirname(dir));
  cpSync(PKG, dir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(PKG, src);
      const top = rel.split(sep)[0];
      return top !== "node_modules" && top !== "dist" && !rel.endsWith(".tgz");
    },
  });
  return dir;
}

test("package.json builds @zabaca/croft/read on pack and for the workspace build", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  expect(pkg.scripts.prepack).toBe("bun scripts/build-read.ts");
  expect(pkg.scripts.build).toBe("bun scripts/build-read.ts");
  expect(pkg.exports["./read"]).toEqual({ types: "./dist/read.d.ts", default: "./dist/read.js" });
});

test.skipIf(!NPM)("npm pack from a clean checkout ships bin, the schema and the built read helper, and no tests or fixtures", () => {
  const dir = cleanCheckout();
  expect(existsSync(join(dir, "dist"))).toBe(false);
  const r = spawnSync(NPM!, ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      // prepack runs `bun scripts/build-read.ts`: the bun running this test comes first on PATH.
      PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin"].join(":"),
      HOME: process.env.HOME ?? dirname(dir),
      npm_config_cache: join(dirname(dir), "npm-cache"),
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      NO_COLOR: "1",
    },
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  // prepack's own output comes first on stdout; the report is the JSON array after it.
  const at = r.stdout.search(/^\[/m);
  expect(at, r.stdout).toBeGreaterThanOrEqual(0);
  const report = JSON.parse(r.stdout.slice(at)) as { files: { path: string }[] }[];
  const files = report[0]!.files.map((f) => f.path);

  for (const f of ["package.json", "bin/croft.mjs", "croft.schema.json", "dist/read.js", "dist/read.d.ts", "src/index.ts", "src/cli/main.ts"]) {
    expect(files, f).toContain(f);
  }
  // Direct mode is a chunk read.js imports on first use; it ships too.
  const chunks = files.filter((f) => /^dist\/read-[a-z0-9]+\.js$/.test(f));
  expect(chunks.length).toBeGreaterThan(0);
  const readJs = readFileSync(join(dir, "dist", "read.js"), "utf8");
  for (const m of readJs.matchAll(/["']\.\/(read-[a-z0-9]+\.js)["']/g)) expect(files).toContain(`dist/${m[1]}`);
  // init's templates are runtime files, not fixtures.
  expect(files).toContain("src/agent/project/files/example_sales.csv");

  const shipped = (re: RegExp) => files.filter((f) => re.test(f));
  expect(shipped(/\.test\.ts$/)).toEqual([]);
  expect(shipped(/(^|\/)fixtures\//)).toEqual([]);
  expect(shipped(/testkit\.ts$/)).toEqual([]);
  expect(shipped(/^tests\//)).toEqual([]);
  expect(shipped(/^scripts\//)).toEqual([]);
  expect(shipped(/^node_modules\//)).toEqual([]);
}, 180_000);

// What can publish to npm from this repository (DESIGN.md D135; option 06, slice 5). Two workflows publish, each its own package set,
// and nothing else does: a release of @zabaca/croft is the `croft-v*` tag (and publish-npm.yml's manual run from a tag's ref), the
// add-on packages are publish-addons.yml's manual run behind a typed confirmation, and no tag, push or pull request reaches the
// second. This test reads the workflow files and the scripts they run, so adding a trigger that publishes, or a third workflow that
// does (by npm, Bun, pnpm, Yarn, a release tool, a publishing action or a script), fails here and has to be decided.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const WORKFLOWS = join(REPO, ".github/workflows");
const withoutComments = (text: string) => text.replace(/^\s*#.*$/gm, "").replace(/\s#\s.*$/gm, "");
/** What publishes: a package manager or release tool told to publish, or an action that publishes. */
const PUBLISHES = /\b(?:npm|bun|bunx|pnpm|yarn|npx)\b[^\n]*\bpublish\b|\byarn\s+npm\s+publish\b|\blerna\s+publish\b|\bchangesets?\b|semantic-release|release-it|uses:\s*\S*(?:publish|release)\S*/i;
/** The same, as a script spells it: a command in a string or a spawned argument list. */
const SCRIPT_PUBLISHES = /\b(?:npm|bun|pnpm|yarn)\s+publish\b|["'`]publish["'`]/;
/** The scripts a workflow runs, by the paths it names, read from the repository. */
function scriptsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of withoutComments(text).matchAll(/(?:packages\/[\w-]+\/)?scripts\/[\w./-]+\.(?:ts|sh|mjs|js)/g)) {
    for (const base of [REPO, join(REPO, "packages/croft")]) {
      const file = join(base, m[0]);
      if (existsSync(file)) out.push(withoutComments(readFileSync(file, "utf8")));
    }
  }
  return out;
}
const canPublish = (text: string) => PUBLISHES.test(withoutComments(text)) || scriptsOf(text).some((t) => SCRIPT_PUBLISHES.test(t));
const load = (file: string) => {
  const text = readFileSync(join(WORKFLOWS, file), "utf8");
  return { text, doc: Bun.YAML.parse(text) as { on: Record<string, any>; jobs: Record<string, any> } };
};

describe("which workflows can publish", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

  test("only publish-npm.yml and publish-addons.yml can publish, by npm, Bun, pnpm, Yarn, a release tool, an action or a script", () => {
    expect(files.filter((f) => canPublish(load(f).text)).sort()).toEqual(["publish-addons.yml", "publish-npm.yml"]);
  });

  test("the detector sees each way of publishing it is meant to", () => {
    for (const run of ["npm publish --access public x.tgz", "bun publish", "pnpm publish --no-git-checks", "yarn npm publish", "npx changeset publish", "bunx semantic-release", "uses: JS-DevTools/npm-publish@v3"]) {
      expect(canPublish(`steps:\n  - ${run.startsWith("uses") ? run : `run: ${run}`}`), run).toBe(true);
    }
    expect(canPublish("steps:\n  - run: bun test\n  # npm publish is for the other file\n"), "a comment").toBe(false);
    expect(SCRIPT_PUBLISHES.test('spawnSync(npm, ["publish", "--access", "public"])'), "a spawned publish").toBe(true);
    expect(SCRIPT_PUBLISHES.test("// publishes nothing\nconst x = 1"), "a word").toBe(false);
  });

  test("every job of ci.yml, the log run of the suite (test-log) included, publishes nothing, mints no token and holds no secret", () => {
    const { doc } = load("ci.yml");
    expect(Object.keys(doc.jobs)).toEqual(expect.arrayContaining(["test", "test-log", "test-lake-local", "test-lake-postgres", "alpine", "windows", "site"]));
    expect(doc.on.push.tags).toEqual(["phase-*", "croft-v*"]); // ci.yml runs on the release tag, so it must be unable to publish it
    for (const [name, job] of Object.entries<any>(doc.jobs)) {
      const text = JSON.stringify(job);
      expect(canPublish(`${name}:\n${JSON.stringify(job, null, 1)}`), name).toBe(false);
      expect(text, name).not.toMatch(/id-token|secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/);
      expect(job.permissions ?? {}, name).not.toHaveProperty("id-token");
      expect(job.environment, name).toBeUndefined();
    }
    // The log run sets CROFT_BOOKKEEPING and nothing that reaches a registry; it needs the extension files like the matrix does.
    const log = doc.jobs["test-log"];
    expect(log.needs).toBe("changes");
    expect(JSON.stringify(log)).toContain("fetch-extensions.ts");
    expect(JSON.stringify(log)).toContain("CROFT_EXTENSION_DIR");
  });

  test("the jobs of the suite run in shards: the matrix lists 1 to N, the name says which, and the test step runs that one of N (DESIGN.md §10)", () => {
    const { doc } = load("ci.yml");
    for (const name of ["test", "test-log", "test-lake-local", "test-lake-postgres"]) {
      const job = doc.jobs[name];
      const shards: number[] = job.strategy.matrix.shard;
      expect(shards.length, name).toBeGreaterThan(1);
      expect(shards, name).toEqual(shards.map((_, i) => i + 1));
      expect(job.strategy["fail-fast"], `${name}: one shard failing must not hide the other's result`).toBe(false);
      expect(job.name, name).toContain(`shard \${{ matrix.shard }}/${shards.length}`);
      const steps: { name?: string; run?: string; if?: string }[] = job.steps;
      const sharded = steps.filter((st) => /--shard=/.test(st.run ?? ""));
      expect(sharded.length, `${name}: one step runs the shard`).toBe(1);
      expect(sharded[0]!.run, name).toContain(`--shard=\${{ matrix.shard }}/${shards.length}`);
      expect(sharded[0]!.run, name).toContain("--timeout 60000");
      // What does not depend on the shard (the typecheck, the run against an older DuckDB) is done once, by shard 1.
      for (const st of steps.filter((x) => x !== sharded[0] && /\bbun (test|run typecheck)\b/.test(x.run ?? ""))) expect(st.if, `${name}: ${st.name}`).toBe("matrix.shard == 1");
    }
    // Both shards of every platform are in the matrix, so the whole suite runs on each.
    expect(doc.jobs.test.strategy.matrix.os).toEqual(["ubuntu-24.04", "ubuntu-24.04-arm", "macos-15"]);
    expect(doc.jobs.test.strategy.matrix.bun).toEqual(["1.3.14", "latest"]);
  });

  test("the journeys run on a lake of each kind in jobs of their own, beside the others, each with its own timeout (DESIGN.md D146)", () => {
    const { doc } = load("ci.yml");
    for (const [job, kind] of [["test-lake-local", "local"], ["test-lake-postgres", "postgres"]] as const) {
      const j = doc.jobs[job];
      expect(j.needs, job).toBe("changes");
      expect(typeof j["timeout-minutes"], job).toBe("number");
      const text = JSON.stringify(j);
      expect(text, job).toContain(`"CROFT_E2E_LAKE":"${kind}"`);
      expect(text, job).toContain("tests/e2e");
      expect(text, job).toContain("fetch-extensions.ts");
      expect(text, job).toContain("check-mode-tools.ts");
    }
    // The DuckDB 1.5 read of a lake (acceptance 11) is run in the Postgres job, with the older DuckDB fetched there.
    expect(JSON.stringify(doc.jobs["test-lake-postgres"])).toContain("fetch-old-duckdb.ts");
    expect(JSON.stringify(doc.jobs["test-lake-postgres"])).toContain("CROFT_TEST_OLD_DUCKDB");
  });

  test("no workflow but those two can mint an OIDC token, which is what trusted publishing publishes with", () => {
    const withToken = files.filter((f) => /id-token:\s*write/.test(withoutComments(load(f).text)));
    expect(withToken.sort()).toEqual(["publish-addons.yml", "publish-npm.yml"]);
  });

  test("@zabaca/croft's release path is the croft-v* tag, and a manual run from a tag's ref; a branch publishes nothing", () => {
    const { doc } = load("publish-npm.yml");
    expect(Object.keys(doc.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(doc.on.push).toEqual({ tags: ["croft-v*"] });
    expect(Object.keys(doc.jobs)).toEqual(["pack", "publish"]);
    // The release runs the whole suite in this one job (ci.yml splits it in shards): its limit leaves room to grow.
    expect(doc.jobs.pack["timeout-minutes"]).toBeGreaterThanOrEqual(75);
    // The check that a tag names package.json's version cannot protect a branch, so a manual run from one is skipped whole.
    expect(doc.jobs.pack.if).toBe("github.ref_type == 'tag'");
    expect(doc.jobs.publish.if).toContain("github.ref_type == 'tag'");
    expect(doc.jobs.publish.needs).toBe("pack");
  });

  test("the add-ons publish from a manual run and nothing else: no tag, push or pull request, and the croft-v* tag does not reach them", () => {
    const { doc } = load("publish-addons.yml");
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    expect(doc.on.workflow_dispatch.inputs.publish.default).toBe("build-only");
    expect(doc.on.workflow_dispatch.inputs.publish.options).toEqual(["build-only", "publish"]);
    // A tag glob that would match the add-ons' own would be the way to fire it by accident.
    expect(JSON.stringify(doc.on)).not.toContain("tags");
  });

  test("the add-ons' publish job needs the typed confirmation, the exact version, main, and the approval environment", () => {
    const { doc } = load("publish-addons.yml");
    expect(Object.keys(doc.jobs)).toEqual(["build", "publish"]);
    const job = doc.jobs.publish;
    expect(job.needs).toBe("build");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("inputs.publish == 'publish'");
    expect(job.if).toContain("inputs.confirm == format('publish croft add-ons {0}', inputs.version)");
    expect(job.environment).toBe("npm-addons");
    // The build job, which a plain run does, publishes nothing and has no token or OIDC permission.
    const build = doc.jobs.build;
    expect(JSON.stringify(build)).not.toMatch(/npm publish|id-token/);
  });

  test("neither workflow carries an npm token: they publish by trusted publishing only", () => {
    for (const f of ["publish-npm.yml", "publish-addons.yml"]) {
      const text = load(f).text;
      expect(text, f).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|secrets\./);
      expect(text, f).toContain("id-token: write");
    }
  });

  test("the version a run asks for is read from the same line the code defines it on", () => {
    const code = readFileSync(resolve(import.meta.dir, "../src/db/addons.ts"), "utf8");
    expect(code).toMatch(/^export const ADDON_VERSION = "\d+\.\d+\.\d+";$/m);
    expect(load("publish-addons.yml").text).toContain("s/^export const ADDON_VERSION = ");
  });
});

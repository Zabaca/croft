// What can publish to npm from this repository (DESIGN.md D133; option 06, slice 5). Two workflows publish, each its own package set,
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

  test("no workflow but those two can mint an OIDC token, which is what trusted publishing publishes with", () => {
    const withToken = files.filter((f) => /id-token:\s*write/.test(withoutComments(load(f).text)));
    expect(withToken.sort()).toEqual(["publish-addons.yml", "publish-npm.yml"]);
  });

  test("@zabaca/croft's release path is the croft-v* tag, and a manual run from a tag's ref; a branch publishes nothing", () => {
    const { doc } = load("publish-npm.yml");
    expect(Object.keys(doc.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(doc.on.push).toEqual({ tags: ["croft-v*"] });
    expect(Object.keys(doc.jobs)).toEqual(["pack", "publish"]);
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

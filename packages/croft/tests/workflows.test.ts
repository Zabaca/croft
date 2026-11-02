// What can publish to npm from this repository (DESIGN.md D133; option 06, slice 5). Two workflows publish, each its own package set,
// and nothing else does: a release of @zabaca/croft is the `croft-v*` tag (and publish-npm.yml's own manual run), the add-on packages are
// publish-addons.yml's manual run behind a typed confirmation, and no tag, push or pull request reaches the second. This test reads
// the workflow files, so adding a trigger that publishes, or a third workflow that does, fails here and has to be decided.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKFLOWS = resolve(import.meta.dir, "../../../.github/workflows");
const load = (file: string) => {
  const text = readFileSync(join(WORKFLOWS, file), "utf8");
  return { text, doc: Bun.YAML.parse(text) as { on: Record<string, any>; jobs: Record<string, any> } };
};

describe("which workflows can publish", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

  test("only publish-npm.yml and publish-addons.yml run `npm publish`", () => {
    const publishing = files.filter((f) => /npm\s+publish/.test(load(f).text.replace(/^\s*#.*$/gm, "")));
    expect(publishing.sort()).toEqual(["publish-addons.yml", "publish-npm.yml"]);
  });

  test("@zabaca/croft's release path is as it was: the croft-v* tag, and a manual run", () => {
    const { doc } = load("publish-npm.yml");
    expect(Object.keys(doc.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(doc.on.push).toEqual({ tags: ["croft-v*"] });
    expect(Object.keys(doc.jobs)).toEqual(["pack", "publish"]);
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

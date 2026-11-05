// What can publish to npm from this repository (DESIGN.md D135, D195). One workflow publishes, one package, and nothing else does: a
// release of @zabaca/croft is the `croft-v*` tag (and publish-npm.yml's manual run from a tag's ref). The DuckDB extension files are
// DuckDB's own, fetched from DuckDB's servers (D195), so no other package is published. This test reads the workflow files and the
// scripts they run, so adding a trigger that publishes, or a second workflow that does (by npm, Bun, pnpm, Yarn, a release tool, a
// publishing action or a script), fails here and has to be decided.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { GRACE_SECONDS, judge, type CiRun } from "../scripts/release-gate.ts";

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
  return { text, doc: Bun.YAML.parse(text) as { on: Record<string, any>; concurrency: { group: string }; jobs: Record<string, any> } };
};

describe("which workflows can publish", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

  test("only publish-npm.yml can publish, by npm, Bun, pnpm, Yarn, a release tool, an action or a script", () => {
    expect(files.filter((f) => canPublish(load(f).text)).sort()).toEqual(["publish-npm.yml"]);
  });

  test("the detector sees each way of publishing it is meant to", () => {
    for (const run of ["npm publish --access public x.tgz", "bun publish", "pnpm publish --no-git-checks", "yarn npm publish", "npx changeset publish", "bunx semantic-release", "uses: JS-DevTools/npm-publish@v3"]) {
      expect(canPublish(`steps:\n  - ${run.startsWith("uses") ? run : `run: ${run}`}`), run).toBe(true);
    }
    expect(canPublish("steps:\n  - run: bun test\n  # npm publish is for the other file\n"), "a comment").toBe(false);
    expect(SCRIPT_PUBLISHES.test('spawnSync(npm, ["publish", "--access", "public"])'), "a spawned publish").toBe(true);
    expect(SCRIPT_PUBLISHES.test("// publishes nothing\nconst x = 1"), "a word").toBe(false);
  });

  test("every job of ci.yml, the log run of the suite (test-log) and the smoke included, publishes nothing, mints no token and holds no secret", () => {
    const { doc } = load("ci.yml");
    expect(Object.keys(doc.jobs)).toEqual(["changes", "test", "test-platforms", "smoke", "test-log", "test-lake-local", "test-lake-postgres", "alpine", "windows", "site"]);
    // ci.yml does not run on the release tag: the commit was tested by the push to main, and publish-npm.yml refuses without that run (D196).
    expect(doc.on.push.tags).toEqual(["phase-*"]);
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

  // DESIGN.md D191: what a pull request waits for, and what waits for a push to main and the daily run.
  const onPullRequest = (job: any) => !/github\.event_name\s*!=\s*'pull_request'/.test(job.if ?? "");

  test("a pull request runs the suite once, on Linux x64 and the Bun floor, in 6 to 8 shards with the typecheck in one (D191)", () => {
    const { doc } = load("ci.yml");
    const job = doc.jobs.test;
    expect(job.strategy.matrix.os).toEqual(["ubuntu-24.04"]);
    expect(job.strategy.matrix.bun).toEqual(["1.3.14"]);
    expect(job.strategy.matrix.shard.length).toBeGreaterThanOrEqual(6);
    expect(job.strategy.matrix.shard.length).toBeLessThanOrEqual(8);
    expect(onPullRequest(job)).toBe(true);
    expect(job.steps.filter((st: any) => /bun run typecheck/.test(st.run ?? "")).length).toBe(1);
    // No macOS job (DESIGN.md D190): GitHub's hosted Mac runners were dropping jobs unstarted.
    for (const [name, j] of Object.entries<any>(doc.jobs)) expect(JSON.stringify([j["runs-on"], j.strategy?.matrix]), name).not.toMatch(/macos/i);
  });

  test("the other platforms and Bun versions run the suite on a push to main and daily, and a smoke on a pull request (D191)", () => {
    const { doc } = load("ci.yml");
    const more = doc.jobs["test-platforms"];
    expect(onPullRequest(more)).toBe(false);
    expect(more.strategy.matrix.os).toEqual(["ubuntu-24.04", "ubuntu-24.04-arm"]);
    expect(more.strategy.matrix.bun).toEqual(["1.3.14", "latest"]);
    // With `test`, the four combinations of the old matrix: x64 on the floor is `test`, the other three are here.
    expect(more.strategy.matrix.exclude).toEqual([{ os: "ubuntu-24.04", bun: "1.3.14" }]);
    expect(doc.on.schedule, "a daily run").toHaveLength(1);
    expect(doc.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(doc.on.push.branches).toEqual(["main"]);
    expect(doc.concurrency.group, "a push to main and the daily run share main's ref and must not cancel each other").toContain("github.event_name");
    // The smoke covers exactly those three combinations, runs the script, and runs on a pull request.
    const smoke = doc.jobs.smoke;
    expect(onPullRequest(smoke)).toBe(true);
    expect(smoke.strategy.matrix.include).toEqual([{ os: "ubuntu-24.04", bun: "latest" }, { os: "ubuntu-24.04-arm", bun: "1.3.14" }, { os: "ubuntu-24.04-arm", bun: "latest" }]);
    expect(smoke["timeout-minutes"]).toBeLessThanOrEqual(15);
    expect(JSON.stringify(smoke)).toContain("bun scripts/smoke.ts");
    expect(JSON.stringify(smoke)).toContain("fetch-extensions.ts");
    // The Alpine and Windows smokes stay on every run.
    for (const name of ["alpine", "windows"]) expect(onPullRequest(doc.jobs[name]), name).toBe(true);
  });

  test("on a pull request the log run is the test files that touch the bookkeeping, chosen by script; elsewhere it is the whole suite (D191)", () => {
    const { doc } = load("ci.yml");
    const log = doc.jobs["test-log"];
    expect(onPullRequest(log)).toBe(true);
    const steps: { if?: string; run?: string }[] = log.steps.filter((st: any) => /--shard=/.test(st.run ?? ""));
    expect(steps.map((st) => st.if)).toEqual(["github.event_name == 'pull_request'", "github.event_name != 'pull_request'"]);
    expect(steps[0]!.run).toMatch(/files=\$\(bun scripts\/bookkeeping-tests\.ts\)\n/); // made first, so that a failing script stops the step
    expect(steps[0]!.run).toContain("$files");
    expect(steps[1]!.run).not.toContain("bookkeeping-tests");
    expect(JSON.stringify(log)).toContain('"CROFT_BOOKKEEPING":"log"');
  });

  test("the jobs of the suite run in shards: the matrix lists 1 to N, the name says which, and the test step runs that one of N (DESIGN.md §10)", () => {
    const { doc } = load("ci.yml");
    for (const name of ["test", "test-platforms", "test-log", "test-lake-local", "test-lake-postgres"]) {
      const job = doc.jobs[name];
      const shards: number[] = job.strategy.matrix.shard;
      expect(shards.length, name).toBeGreaterThan(1);
      expect(shards, name).toEqual(shards.map((_, i) => i + 1));
      expect(job.strategy["fail-fast"], `${name}: one shard failing must not hide the other's result`).toBe(false);
      expect(job.name, name).toContain(`shard \${{ matrix.shard }}/${shards.length}`);
      const steps: { name?: string; run?: string; if?: string }[] = job.steps;
      // The pull request's run of the whole suite deals its files by the seconds each took (scripts/shard-files.ts, D196); the others are Bun's own `--shard`.
      const dealt = name === "test";
      const sharded = steps.filter((st) => (dealt ? /shard-files\.ts/ : /--shard=/).test(st.run ?? ""));
      // One step runs the shard; the log run has two, one for a pull request and one for the rest (above).
      expect(sharded.length, `${name}: one step runs the shard`).toBe(name === "test-log" ? 2 : 1);
      for (const st of sharded) {
        expect(st.run, name).toContain(dealt ? `shard-files.ts \${{ matrix.shard }} ${shards.length}` : `--shard=\${{ matrix.shard }}/${shards.length}`);
        expect(st.run, name).toContain("--timeout 60000");
      }
      // What does not depend on the shard (the typecheck, the run against an older DuckDB) is done once, by shard 1.
      for (const st of steps.filter((x) => !sharded.includes(x) && /\bbun (test|run typecheck)\b/.test(x.run ?? ""))) expect(st.if, `${name}: ${st.name}`).toBe("matrix.shard == 1");
    }
  });

  test("the pull request's shards list their files first, so that a failing script stops the step and does not leave `bun test` with no filter (D196)", () => {
    const run: string = load("ci.yml").doc.jobs.test.steps.find((st: any) => /shard-files\.ts/.test(st.run ?? "")).run;
    expect(run).toMatch(/^files=\$\(bun scripts\/shard-files\.ts \$\{\{ matrix\.shard \}\} 7\)\n/);
    expect(run).toMatch(/\n\s*bun test --timeout 60000 \$files\s*$/);
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

  test("no workflow but publish-npm.yml can mint an OIDC token, which is what trusted publishing publishes with", () => {
    const withToken = files.filter((f) => /id-token:\s*write/.test(withoutComments(load(f).text)));
    expect(withToken.sort()).toEqual(["publish-npm.yml"]);
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

  // DESIGN.md D196: a release publishes what main already tested, and refuses without proof that it did.
  describe("a release publishes what main's CI tested", () => {
    const steps = (): { name?: string; run?: string; env?: Record<string, string>; if?: string; uses?: string }[] => load("publish-npm.yml").doc.jobs.pack.steps;
    const at = (re: RegExp) => steps().findIndex((st) => re.test(`${st.name ?? ""} ${st.run ?? ""} ${st.uses ?? ""}`));

    test("the pack job does not run the suite again: no test run, no extension files, no Postgres", () => {
      const { doc, text } = load("publish-npm.yml");
      for (const st of doc.jobs.pack.steps) expect(st.run ?? "", st.name).not.toMatch(/\bbun test\b|fetch-extensions|check-mode-tools|postgresql/);
      expect(withoutComments(text)).not.toMatch(/CROFT_CI|croft-extensions/);
      // So its time is a typecheck, a pack and the wait for main's CI (scripts/release-gate.ts), not the suite's 40 minutes.
      expect(doc.jobs.pack["timeout-minutes"]).toBeLessThanOrEqual(60);
    });

    test("it refuses unless ci.yml passed on a push to main at the tagged commit, before it packs, with a read-only token", () => {
      const { doc } = load("publish-npm.yml");
      const gate = at(/release-gate\.ts/);
      expect(gate, "a step runs scripts/release-gate.ts").toBeGreaterThan(-1);
      expect(gate, "after the tag and the already-published checks").toBeGreaterThan(at(/already on npm\?/));
      expect(gate, "before the pack").toBeLessThan(at(/npm pack/));
      expect(gate, "before the artifact is uploaded").toBeLessThan(at(/upload-artifact/));
      const st = steps()[gate]!;
      expect(st.env?.GH_TOKEN, "the job's own token").toBe("${{ github.token }}");
      expect(st.if, "skipped only for a version already on npm, which publishes nothing").toBe("steps.state.outputs.publish == 'yes'");
      expect(doc.jobs.pack.permissions).toEqual({ contents: "read", actions: "read" });
      // The publish job holds the OIDC token and no more.
      expect(doc.jobs.publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    });

    test("the typecheck, the tag-equals-version check, the tarball checks, the manifest refusal and the OIDC publish stay", () => {
      const { text } = load("publish-npm.yml");
      expect(at(/bun run typecheck/)).toBeGreaterThan(-1);
      expect(text).toContain('"${GITHUB_REF_NAME}" != "croft-v${VERSION}"');
      expect(text).toContain("the tarball holds test files");
      expect(text).toContain("auto-corrected|was invalid and removed");
      expect(text).toContain("npm publish --access public --loglevel verbose");
    });

    const SHA = "a".repeat(40);
    const run = (over: Partial<CiRun> = {}): CiRun => ({ id: 1, status: "completed", conclusion: "success", event: "push", head_branch: "main", head_sha: SHA, html_url: "https://github.com/Zabaca/croft/actions/runs/1", ...over });

    test("the gate lets a release through on a completed, successful push run to main at the tagged commit", () => {
      expect(judge([run()], SHA, 0).state).toBe("pass");
      expect(judge([run({ conclusion: "failure", id: 2 }), run()], SHA, 0).state, "a re-run that passed").toBe("pass");
    });

    test("the gate stops a release when the run failed, was cancelled or does not exist, and waits while it runs", () => {
      expect(judge([run({ conclusion: "failure" })], SHA, 0).state).toBe("fail");
      expect(judge([run({ conclusion: "cancelled" })], SHA, 0).state).toBe("fail");
      expect(judge([run({ status: "in_progress", conclusion: null })], SHA, 0).state).toBe("wait");
      expect(judge([run({ status: "queued", conclusion: null })], SHA, 0).state).toBe("wait");
      expect(judge([], SHA, 0).state, "a push whose run GitHub has not made yet").toBe("wait");
      expect(judge([], SHA, GRACE_SECONDS + 1).state, "no run, once it should exist").toBe("fail");
    });

    test("the gate counts only the push to main at that commit: not a pull request, the daily run, a tag's run, another branch or another commit", () => {
      for (const other of [{ event: "pull_request" }, { event: "schedule" }, { event: "workflow_dispatch" }, { head_branch: "croft-v0.5.1" }, { head_branch: "release-051" }, { head_sha: "b".repeat(40) }]) {
        expect(judge([run(other)], SHA, GRACE_SECONDS + 1).state, JSON.stringify(other)).toBe("fail");
      }
    });
  });

  test("the workflow carries no npm token: it publishes by trusted publishing only", () => {
    const text = load("publish-npm.yml").text;
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|secrets\./);
    expect(text).toContain("id-token: write");
  });

  test("no workflow publishes the extension files: they are DuckDB's, fetched from DuckDB's servers (D195)", () => {
    expect(files).not.toContain("publish-addons.yml");
    for (const f of files) expect(load(f).text, f).not.toMatch(/croft-addon|croft-ext-|npm-addons/);
  });
});

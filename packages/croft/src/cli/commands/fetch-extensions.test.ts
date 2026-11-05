// croft fetch-extensions (DESIGN.md D195): the command EXTENSION_MISSING names as its fix. Against a stand-in repository and small
// files pinned in place of DuckDB's (extension-repo-testkit.ts); no test reaches DuckDB's servers.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionPath, hostPlatform } from "../../db/extension-files.ts";
import { pinStandIn, repoPath, type StandInRepo, startStandInRepo } from "../../db/extension-repo-testkit.ts";
import { loadProject } from "../../project/root.ts";
import { cleanup, cli, makeProject, type TestProject } from "./inspect-testkit.ts";

const platform = hostPlatform();
const t = platform ? test : test.skip;
const made: string[] = [];
const restores: (() => void)[] = [];
const repos: StandInRepo[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
afterAll(async () => {
  for (const r of repos) r.stop();
  for (const d of made) rmSync(d, { recursive: true, force: true });
  await cleanup();
});

const CONTENT = Buffer.from("a stand-in extension file, pinned for this test\n".repeat(40));

/** A repository serving every extension a mode loads as CONTENT, each pinned to it. */
function repo(): StandInRepo {
  const r = startStandInRepo();
  repos.push(r);
  for (const n of ["quack", "httpfs", "ducklake", "postgres"] as const) {
    restores.push(pinStandIn(n, platform!, CONTENT));
    r.files.set(repoPath(n, platform!), CONTENT);
  }
  return r;
}

function envFor(r: StandInRepo, dir: string): Record<string, string> {
  return { CROFT_EXTENSION_DIR: dir, CROFT_EXTENSION_REPO: r.url, CROFT_NO_FETCH: "1", HOME: dir };
}

function folder(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-fetchcmd-")));
  made.push(d);
  return d;
}

function projectWith(o: { serverMode: boolean }): TestProject {
  const p = makeProject();
  writeFileSync(join(p.root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "America/Los_Angeles", ...(o.serverMode ? { serverMode: { enabled: true } } : {}) }));
  return { ...p, project: loadProject({ root: p.root }) };
}

describe("croft fetch-extensions", () => {
  t("in a server-mode project it fetches quack and httpfs and nothing else, and says so in the text and in --json", async () => {
    const r = repo();
    const dir = folder();
    const p = projectWith({ serverMode: true });
    const out = await cli(["fetch-extensions", "--json"], { cwd: p.root, env: envFor(r, dir) });
    expect(out.exit, out.stdout).toBe(0);
    expect(out.json.data).toMatchObject({ platform, dir, repository: r.url, files: [{ name: "httpfs", downloaded: true }, { name: "quack", downloaded: true }] });
    expect(r.requests.sort()).toEqual([repoPath("httpfs", platform!), repoPath("quack", platform!)]);
    expect(existsSync(extensionPath(dir, "ducklake", platform!))).toBe(false);
    const again = await cli(["fetch-extensions"], { cwd: p.root, env: envFor(r, dir) });
    expect(again.exit).toBe(0);
    expect(again.stdout).toContain("already there");
    expect(r.requests).toHaveLength(2);
  });

  t("the fix EXTENSION_MISSING names is this command, and after it croft validate is clean", async () => {
    const r = repo();
    const dir = folder();
    const p = projectWith({ serverMode: true });
    const env = envFor(r, dir);
    const before = await cli(["validate", "--json"], { cwd: p.root, env });
    expect(before.exit).toBe(2);
    const fix = before.json.problems.find((x: { code: string }) => x.code === "EXTENSION_MISSING").fix;
    expect(fix.command).toBe("croft fetch-extensions httpfs quack");
    // An agent runs the fix: everything after "croft".
    const ran = await cli(fix.command.split(" ").slice(1).concat("--json"), { cwd: p.root, env });
    expect(ran.exit, ran.stdout).toBe(0);
    const after = await cli(["validate", "--json"], { cwd: p.root, env });
    expect(after.exit, after.stdout).toBe(0);
    expect(after.json.data.extensionFiles[0]).toMatchObject({ ok: true, fetch: null });
  });

  t("named extensions are fetched whatever the project needs, and outside a project it fetches every one a mode loads", async () => {
    const r = repo();
    const dir = folder();
    const named = await cli(["fetch-extensions", "ducklake", "--json"], { cwd: projectWith({ serverMode: false }).root, env: envFor(r, dir) });
    expect(named.exit, named.stdout).toBe(0);
    expect(r.requests).toEqual([repoPath("ducklake", platform!)]);
    const bare = folder();
    const outside = await cli(["fetch-extensions", "--json"], { cwd: bare, env: envFor(r, dir) });
    expect(outside.exit, outside.stdout).toBe(0);
    expect(outside.json.data.files.map((f: { name: string }) => f.name)).toEqual(["httpfs", "quack", "postgres", "ducklake"]);
  });

  t("a project with no mode on needs nothing: no request, and next says how to fetch everything", async () => {
    const r = repo();
    const p = projectWith({ serverMode: false });
    const out = await cli(["fetch-extensions", "--json"], { cwd: p.root, env: envFor(r, folder()) });
    expect(out.exit).toBe(0);
    expect(out.json.data.files).toEqual([]);
    expect(out.json.next[0].command).toBe("croft fetch-extensions --all");
    expect(r.requests).toEqual([]);
  });

  t("an extension croft does not pin is a usage error, and nothing is fetched", async () => {
    const r = repo();
    const out = await cli(["fetch-extensions", "spatial", "--json"], { cwd: projectWith({ serverMode: true }).root, env: envFor(r, folder()) });
    expect(out.exit).toBe(2);
    expect(out.json.problems[0]).toMatchObject({ code: "USAGE_ERROR" });
    expect(r.requests).toEqual([]);
  });

  t("a tampered file is refused by its checksum (exit 2) and nothing is written", async () => {
    const r = repo();
    r.files.set(repoPath("quack", platform!), Buffer.from("not what croft pins"));
    const dir = folder();
    const out = await cli(["fetch-extensions", "quack", "--json"], { cwd: projectWith({ serverMode: true }).root, env: envFor(r, dir) });
    expect(out.exit).toBe(2);
    expect(out.json.problems[0]).toMatchObject({ code: "EXTENSION_CHECKSUM_MISMATCH", details: { kind: "download" } });
    expect(existsSync(extensionPath(dir, "quack", platform!))).toBe(false);
  });

  t("a repository that cannot be reached is EXTENSION_FETCH_FAILED (exit 2), with the command as the fix", async () => {
    const r = repo();
    const out = await cli(["fetch-extensions", "quack", "--json"], { cwd: projectWith({ serverMode: true }).root, env: { ...envFor(r, folder()), CROFT_EXTENSION_REPO: "http://127.0.0.1:9" } });
    expect(out.exit).toBe(2);
    expect(out.json.problems[0]).toMatchObject({ code: "EXTENSION_FETCH_FAILED", retryable: true, fix: { kind: "command", command: "croft fetch-extensions quack" } });
  });

  t("a folder where the file goes is a croft error (exit 2) naming the path, not a raw rename error", async () => {
    const r = repo();
    const dir = folder();
    mkdirSync(extensionPath(dir, "quack", platform!), { recursive: true });
    const out = await cli(["fetch-extensions", "quack", "--json"], { cwd: projectWith({ serverMode: true }).root, env: envFor(r, dir) });
    expect(out.exit).toBe(2);
    expect(out.json.problems[0]).toMatchObject({ code: "EXTENSION_FETCH_FAILED", retryable: false, details: { kind: "write", path: extensionPath(dir, "quack", platform!) } });
  });
});

// Fetching the pinned extension files from DuckDB's extension servers (DESIGN.md D195). Every test talks to a stand-in repository on
// 127.0.0.1 (extension-repo-testkit.ts) and to small files pinned in place of DuckDB's; the real servers are reached by hand, once
// (DESIGN.md D195's record), and never by a test.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { DEFAULT_REPOSITORY, extensionUrl, fetchExtension, fetchExtensions, fetchingOff, fetchMissingModeFiles, repositoryOf } from "./extension-fetch.ts";
import { extensionPath, hostPlatform, verifyExtension } from "./extension-files.ts";
import { DUCKDB_VERSION } from "./extension-names.ts";
import { pinStandIn, repoPath, type StandInRepo, startStandInRepo } from "./extension-repo-testkit.ts";

const platform = hostPlatform();
const t = platform ? test : test.skip;
const made: string[] = [];
const restores: (() => void)[] = [];
const repos: StandInRepo[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
afterAll(() => {
  for (const r of repos) r.stop();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const folder = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-fetch-")));
  made.push(d);
  return d;
};

/** A stand-in repository that serves `content` as the quack and httpfs files, which are pinned to it. */
function repoServing(content = Buffer.from("a stand-in extension file, pinned for this test\n".repeat(40))): { repo: StandInRepo; content: Buffer } {
  const repo = startStandInRepo();
  repos.push(repo);
  for (const n of ["quack", "httpfs"] as const) {
    restores.push(pinStandIn(n, platform!, content));
    repo.files.set(repoPath(n, platform!), content);
  }
  return { repo, content };
}

describe("where files come from", () => {
  test("DuckDB's own repository, at the URL DuckDB uses for this version and platform; $CROFT_EXTENSION_REPO names another", () => {
    expect(DEFAULT_REPOSITORY).toBe("https://extensions.duckdb.org");
    expect(extensionUrl("quack", "osx_arm64")).toBe(`https://extensions.duckdb.org/v${DUCKDB_VERSION}/osx_arm64/quack.duckdb_extension.gz`);
    expect(extensionUrl("postgres", "linux_amd64", "http://mirror.test")).toBe(`http://mirror.test/v${DUCKDB_VERSION}/linux_amd64/postgres_scanner.duckdb_extension.gz`);
    expect(repositoryOf({})).toBe(DEFAULT_REPOSITORY);
    expect(repositoryOf({ CROFT_EXTENSION_REPO: "http://mirror.test/" })).toBe("http://mirror.test");
  });

  test("fetching is off only when $CROFT_NO_FETCH says so", () => {
    expect(fetchingOff({})).toBe(false);
    expect(fetchingOff({ CROFT_NO_FETCH: "" })).toBe(false);
    expect(fetchingOff({ CROFT_NO_FETCH: "0" })).toBe(false);
    expect(fetchingOff({ CROFT_NO_FETCH: "1" })).toBe(true);
  });
});

describe("fetching a file", () => {
  t("downloads, unpacks, checks the pin and writes the file in DuckDB's layout; a second call finds it and downloads nothing", async () => {
    const { repo, content } = repoServing();
    const dir = folder();
    const env = { CROFT_EXTENSION_REPO: repo.url };
    const first = await fetchExtension("quack", { dir, env, log: () => {} });
    expect(first).toMatchObject({ name: "quack", path: extensionPath(dir, "quack", platform!), downloaded: true, bytes: content.length });
    expect(readFileSync(first.path).equals(content)).toBe(true);
    expect(repo.requests).toEqual([repoPath("quack", platform!)]);
    expect(verifyExtension(dir, "quack", platform)).toBe(first.path);
    const second = await fetchExtension("quack", { dir, env, log: () => {} });
    expect(second.downloaded).toBe(false);
    expect(repo.requests).toHaveLength(1);
  });

  t("says what it is fetching, once per file, and from where", async () => {
    const { repo } = repoServing();
    const lines: string[] = [];
    await fetchExtensions(["httpfs", "quack"], { dir: folder(), env: { CROFT_EXTENSION_REPO: repo.url }, log: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("httpfs");
    expect(lines[0]).toContain(repo.url);
  });

  t("a tampered file is refused by its checksum and nothing is written: no file, no partial file", async () => {
    const { repo } = repoServing();
    repo.files.set(repoPath("quack", platform!), Buffer.from("something else entirely, of another size"));
    const dir = folder();
    const err = await fetchExtension("quack", { dir, env: { CROFT_EXTENSION_REPO: repo.url }, log: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("EXTENSION_CHECKSUM_MISMATCH");
    expect((err as CroftError).problem.details).toMatchObject({ kind: "download", extension: "quack", url: `${repo.url}/${repoPath("quack", platform!)}` });
    expect(existsSync(extensionPath(dir, "quack", platform!))).toBe(false);
    const leftovers = existsSync(dirname(extensionPath(dir, "quack", platform!))) ? readdirSync(dirname(extensionPath(dir, "quack", platform!))) : [];
    expect(leftovers).toEqual([]);
  });

  t("a file the same size as the pinned one with one byte changed is refused too", async () => {
    const { repo, content } = repoServing();
    const changed = Buffer.from(content);
    changed[10]! ^= 0xff;
    repo.files.set(repoPath("httpfs", platform!), changed);
    const dir = folder();
    const err = await fetchExtension("httpfs", { dir, env: { CROFT_EXTENSION_REPO: repo.url }, log: () => {} }).catch((e: unknown) => e);
    expect((err as CroftError).code).toBe("EXTENSION_CHECKSUM_MISMATCH");
    expect(existsSync(extensionPath(dir, "httpfs", platform!))).toBe(false);
  });

  t("a body far larger than the file, and a small gzip that unpacks far larger, are refused as not the pinned file, with nothing written", async () => {
    const { content } = repoServing();
    const { gzipSync, randomBytes } = { gzipSync: (await import("node:zlib")).gzipSync, randomBytes: (await import("node:crypto")).randomBytes };
    const big = randomBytes(4_000_000);
    const bomb = gzipSync(Buffer.alloc(50_000_000));
    expect(bomb.length).toBeLessThan(200_000);
    for (const body of [big, bomb]) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
      const dir = folder();
      try {
        const err = (await fetchExtension("quack", { dir, env: { CROFT_EXTENSION_REPO: `http://127.0.0.1:${server.port}` }, log: () => {} }).catch((e: unknown) => e)) as CroftError;
        expect(err.code).toBe("EXTENSION_CHECKSUM_MISMATCH");
        expect(err.problem.details).toMatchObject({ kind: "download", bytes: null, expectedBytes: content.length });
        expect(existsSync(dirname(extensionPath(dir, "quack", platform!)))).toBe(false);
      } finally {
        void server.stop(true);
      }
    }
  });

  t("the temporary file has a random name and is opened exclusively: a symlink planted at the old predictable name is not written through", async () => {
    const { repo, content } = repoServing();
    const dir = folder();
    const path = extensionPath(dir, "quack", platform!);
    mkdirSync(dirname(path), { recursive: true });
    const victim = join(folder(), "victim");
    symlinkSync(victim, `${path}.part-${process.pid}`);
    await fetchExtension("quack", { dir, env: { CROFT_EXTENSION_REPO: repo.url }, log: () => {} });
    expect(existsSync(victim)).toBe(false);
    expect(readFileSync(path).equals(content)).toBe(true);
  });

  t("an answer that is not gzip is a failed fetch, not a crash", async () => {
    const repo = startStandInRepo();
    repos.push(repo);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>a captive portal</html>") });
    try {
      const err = await fetchExtension("quack", { dir: folder(), env: { CROFT_EXTENSION_REPO: `http://127.0.0.1:${server.port}` }, log: () => {} }).catch((e: unknown) => e);
      expect((err as CroftError).code).toBe("EXTENSION_FETCH_FAILED");
      expect((err as CroftError).message).toContain("not a gzip file");
    } finally {
      void server.stop(true);
    }
  });

  t("a repository that answers 404 or 500 is EXTENSION_FETCH_FAILED, retryable, with the command to run again as the fix", async () => {
    const { repo } = repoServing();
    repo.files.delete(repoPath("quack", platform!));
    repo.files.set(repoPath("httpfs", platform!), 500);
    const env = { CROFT_EXTENSION_REPO: repo.url };
    for (const [name, status] of [["quack", 404], ["httpfs", 500]] as const) {
      const err = (await fetchExtension(name, { dir: folder(), env, log: () => {} }).catch((e: unknown) => e)) as CroftError;
      expect(err.code).toBe("EXTENSION_FETCH_FAILED");
      expect(err.problem.retryable).toBe(true);
      expect(err.problem.details).toMatchObject({ kind: "fetch", extension: name, status });
      expect(err.problem.fix).toMatchObject({ kind: "command", command: `croft fetch-extensions ${name}` });
    }
  });

  t("a repository nothing answers at is EXTENSION_FETCH_FAILED too", async () => {
    const err = (await fetchExtension("quack", { dir: folder(), env: { CROFT_EXTENSION_REPO: "http://127.0.0.1:9" }, log: () => {} }).catch((e: unknown) => e)) as CroftError;
    expect(err.code).toBe("EXTENSION_FETCH_FAILED");
    expect(err.problem.retryable).toBe(true);
  });

  t("a file that is there and wrong is replaced by the right one; a right one is left alone", async () => {
    const { repo, content } = repoServing();
    const dir = folder();
    const path = extensionPath(dir, "quack", platform!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "damaged");
    const env = { CROFT_EXTENSION_REPO: repo.url };
    expect((await fetchExtension("quack", { dir, env, log: () => {} })).downloaded).toBe(true);
    expect(readFileSync(path).equals(content)).toBe(true);
    expect((await fetchExtension("quack", { dir, env, log: () => {} })).downloaded).toBe(false);
    expect(repo.requests).toHaveLength(1);
  });

  t("two fetches of one file at once download it once", async () => {
    const { repo } = repoServing();
    const dir = folder();
    const env = { CROFT_EXTENSION_REPO: repo.url };
    await Promise.all([fetchExtension("quack", { dir, env, log: () => {} }), fetchExtension("quack", { dir, env, log: () => {} })]);
    expect(repo.requests).toHaveLength(1);
  });

  test("a platform croft pins nothing for is EXTENSION_MISSING with kind platform, and nothing is asked of the network", async () => {
    const err = (await fetchExtension("quack", { dir: folder(), platform: null, env: { CROFT_EXTENSION_REPO: "http://127.0.0.1:9" } }).catch((e: unknown) => e)) as CroftError;
    expect(err.code).toBe("EXTENSION_MISSING");
    expect(err.problem.details).toMatchObject({ kind: "platform" });
  });
});

describe("fetching what a mode lacks, before it starts", () => {
  t("fetches only the files that are absent", async () => {
    const { repo, content } = repoServing();
    const dir = folder();
    const path = extensionPath(dir, "httpfs", platform!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    await fetchMissingModeFiles(["httpfs", "quack"], { dir, env: { CROFT_EXTENSION_REPO: repo.url }, log: () => {} });
    expect(repo.requests).toEqual([repoPath("quack", platform!)]);
    expect(existsSync(extensionPath(dir, "quack", platform!))).toBe(true);
  });

  t("does not replace a file that is there and wrong: the check that follows refuses it", async () => {
    const { repo } = repoServing();
    const dir = folder();
    const path = extensionPath(dir, "quack", platform!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "tampered");
    await fetchMissingModeFiles(["quack"], { dir, env: { CROFT_EXTENSION_REPO: repo.url }, log: () => {} });
    expect(repo.requests).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("tampered");
  });

  t("does nothing when $CROFT_NO_FETCH is set, so the missing file is the check's EXTENSION_MISSING", async () => {
    const { repo } = repoServing();
    const dir = folder();
    await fetchMissingModeFiles(["quack"], { dir, env: { CROFT_EXTENSION_REPO: repo.url, CROFT_NO_FETCH: "1" }, log: () => {} });
    expect(repo.requests).toEqual([]);
    expect(existsSync(extensionPath(dir, "quack", platform!))).toBe(false);
  });

  test("does nothing on a platform croft pins nothing for", async () => {
    await fetchMissingModeFiles(["quack"], { dir: folder(), platform: null, env: { CROFT_EXTENSION_REPO: "http://127.0.0.1:9" } });
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CroftError } from "../core/errors.ts";
import { bootId, procStart } from "../core/proc.ts";
import { explicitUrl, findProject, isServeAlive, liveServer, readServeRecord, tokenFor } from "./locate.ts";
import { cleanup, makeProject, spawnIdle, writeServeJson } from "./testkit.ts";

afterAll(cleanup);

function thrown(fn: () => unknown): CroftError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
}

describe("findProject", () => {
  test("{ project } wins over CROFT_PROJECT and the working directory", async () => {
    const a = await makeProject();
    const b = await makeProject();
    const c = await makeProject();
    expect(findProject({ project: a.root }, { CROFT_PROJECT: b.root }, c.root).root).toBe(a.root);
    expect(findProject({}, { CROFT_PROJECT: b.root }, c.root).root).toBe(b.root);
    expect(findProject({}, {}, c.root).root).toBe(c.root);
  });

  test("walks up from a subfolder, and finds ./data/croft.json in an app repo", async () => {
    const p = await makeProject();
    mkdirSync(join(p.root, "assets", "deep"), { recursive: true });
    expect(findProject({}, {}, join(p.root, "assets", "deep")).root).toBe(p.root);
    const app = await makeProject({ sub: "data" });
    const appRoot = join(app.root, "..");
    writeFileSync(join(appRoot, "package.json"), "{}");
    expect(findProject({}, {}, appRoot).root).toBe(app.root);
    // An explicit project may name the app repo root too.
    expect(findProject({ project: appRoot }, {}, "/").root).toBe(app.root);
  });

  test("a relative CROFT_PROJECT resolves against the working directory; blank values are ignored", async () => {
    const p = await makeProject();
    const cwd = realpathSync(join(p.root, ".."));
    expect(findProject({}, { CROFT_PROJECT: relative(cwd, p.root) }, cwd).root).toBe(p.root);
    expect(findProject({ project: "  " }, { CROFT_PROJECT: "" }, p.root).root).toBe(p.root);
  });

  test("reads timezone, database and a relocated state folder from croft.json", async () => {
    const elsewhere = await makeProject();
    const p = await makeProject({ timezone: "Asia/Tokyo", config: { database: "data.duckdb", stateDir: join(elsewhere.root, "state") } });
    const found = findProject({}, {}, p.root);
    expect(found.timezone).toBe("Asia/Tokyo");
    expect(found.paths.database).toBe(join(p.root, "data.duckdb"));
    expect(found.paths.stateDir).toBe(join(elsewhere.root, "state"));
  });

  test("PROJECT_NOT_FOUND tells an app what to do", async () => {
    const p = await makeProject();
    const nowhere = realpathSync(join(p.root, ".."));
    const e = thrown(() => findProject({}, {}, "/"));
    expect(e.code).toBe("PROJECT_NOT_FOUND");
    expect(e.problem.hint).toContain("CROFT_PROJECT");
    expect(e.problem.hint).toContain("CROFT_URL");
    const e2 = thrown(() => findProject({}, { CROFT_PROJECT: nowhere }, p.root));
    expect(e2.code).toBe("PROJECT_NOT_FOUND");
    expect(e2.message).toContain("CROFT_PROJECT");
  });

  test("an invalid croft.json is CONFIG_INVALID", async () => {
    const p = await makeProject();
    writeFileSync(join(p.root, "croft.json"), '{"timezone": "Mars/Olympus"}');
    expect(thrown(() => findProject({ project: p.root }, {}, "/")).code).toBe("CONFIG_INVALID");
  });
});

describe("serve.json", () => {
  test("parses url, token and process identity; builds a URL from host and port", async () => {
    const p = await makeProject();
    expect(readServeRecord(p.stateDir)).toBeNull();
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", token: "tok", pid: process.pid });
    expect(readServeRecord(p.stateDir)).toEqual({ url: "http://127.0.0.1:7447", token: "tok", pid: process.pid, procStart: procStart(process.pid), bootId: bootId() });
    writeFileSync(join(p.stateDir, "serve.json"), JSON.stringify({ host: "::1", port: 7448, pid: 12 }));
    expect(readServeRecord(p.stateDir)).toMatchObject({ url: "http://[::1]:7448", token: null, pid: 12 });
    for (const bad of ["not json", "[]", '{"url": "http://x"}', '{"url": "ftp://x", "pid": 1}', '{"url": "http://x", "pid": -1}']) {
      writeFileSync(join(p.stateDir, "serve.json"), bad);
      expect(readServeRecord(p.stateDir)).toBeNull();
    }
  });

  test("liveness uses pid + process start + boot id, like write intents", async () => {
    const p = await makeProject();
    const server = spawnIdle();
    await server.waitFor("up");
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: server.pid });
    expect(liveServer(p.stateDir)?.pid).toBe(server.pid);
    // Same PID, different start time: a reused PID is not our server.
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: server.pid, procStart: "Mon Jan  1 00:00:00 2001" });
    expect(liveServer(p.stateDir)).toBeNull();
    // Another boot.
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: server.pid, bootId: "other-boot" });
    expect(liveServer(p.stateDir)).toBeNull();
    // Without start time and boot id, the PID alone decides.
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: server.pid, procStart: null, bootId: null });
    expect(isServeAlive(readServeRecord(p.stateDir)!)).toBe(true);
    server.proc.kill("SIGKILL");
    await server.exited;
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: server.pid, procStart: "gone", bootId: bootId() });
    expect(liveServer(p.stateDir)).toBeNull();
    writeServeJson(p.stateDir, { url: "http://127.0.0.1:7447", pid: server.pid, procStart: null, bootId: null });
    expect(liveServer(p.stateDir)).toBeNull();
  });
});

describe("explicit URLs and tokens", () => {
  test("{ url } beats CROFT_URL; anything but http(s) is USAGE_ERROR", () => {
    expect(explicitUrl({}, {})).toBeNull();
    expect(explicitUrl({ url: "http://a:1" }, { CROFT_URL: "http://b:2" })).toMatchObject({ source: "option" });
    expect(explicitUrl({}, { CROFT_URL: " http://b:2 " })!.url.href).toBe("http://b:2/");
    expect(explicitUrl({ url: "" }, { CROFT_URL: "http://b:2" })!.source).toBe("CROFT_URL");
    expect(thrown(() => explicitUrl({ url: "127.0.0.1:7447" }, {})).code).toBe("USAGE_ERROR");
    expect(thrown(() => explicitUrl({}, { CROFT_URL: "file:///etc/passwd" })).message).toContain("CROFT_URL");
  });

  test("token: { token }, then CROFT_SERVE_TOKEN, then serve.json for its own origin only", () => {
    const rec = { url: "http://127.0.0.1:7447", token: "local", pid: 1, procStart: null, bootId: null };
    const local = new URL("http://127.0.0.1:7447/");
    const remote = new URL("https://croft.example.com");
    expect(tokenFor(local, { token: "opt" }, { CROFT_SERVE_TOKEN: "env" }, rec)).toEqual({ token: "opt", source: "option" });
    expect(tokenFor(local, {}, { CROFT_SERVE_TOKEN: "env\n" }, rec)).toEqual({ token: "env", source: "CROFT_SERVE_TOKEN" });
    expect(tokenFor(local, {}, {}, rec)).toEqual({ token: "local", source: "serve.json" });
    // Never send the local server's token to another host.
    expect(tokenFor(remote, {}, {}, rec)).toBeNull();
    expect(tokenFor(new URL("http://127.0.0.1:9999"), {}, {}, rec)).toBeNull();
    expect(tokenFor(local, {}, {}, null)).toBeNull();
    // The serve.json lookup is lazy: a given token never touches the project.
    const never = () => {
      throw new Error("serve.json looked up although a token was given");
    };
    expect(tokenFor(remote, { token: "opt" }, {}, never)).toEqual({ token: "opt", source: "option" });
    expect(tokenFor(remote, {}, { CROFT_SERVE_TOKEN: "env" }, never)).toEqual({ token: "env", source: "CROFT_SERVE_TOKEN" });
    expect(tokenFor(local, {}, {}, () => rec)).toEqual({ token: "local", source: "serve.json" });
  });
});

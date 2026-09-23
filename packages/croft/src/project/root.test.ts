import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { scanJson } from "./json-locate.ts";
import {
  configProblems, findRoot, loadProject, parseConfig, physicalPath, readConfig, relocationDir, syncedLocation, type ConfigIssue,
} from "./root.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "croft-root-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function project(config: unknown, sub = ""): string {
  const dir = join(base, `p${n++}`, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "croft.json"), typeof config === "string" ? config : JSON.stringify(config, null, 2));
  return dir;
}

function issues(text: string): ConfigIssue[] {
  const r = parseConfig(text);
  if (r.ok) throw new Error("expected issues");
  return r.issues;
}

const MIN = { database: "warehouse.duckdb", timezone: "America/Los_Angeles" };

describe("findRoot", () => {
  test("finds croft.json in the folder or any parent", () => {
    const root = project(MIN);
    mkdirSync(join(root, "assets", "github"), { recursive: true });
    expect(findRoot(root)).toBe(root);
    expect(findRoot(join(root, "assets", "github"))).toBe(root);
  });

  test("finds ./data/croft.json from an app repo root", () => {
    const app = join(base, `app${n++}`);
    const data = project(MIN, "");
    mkdirSync(app, { recursive: true });
    const dataDir = join(app, "data");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "croft.json"), JSON.stringify(MIN));
    expect(findRoot(app)).toBe(dataDir);
    expect(findRoot(join(dataDir))).toBe(dataDir);
    expect(data).not.toBe(dataDir);
  });

  test("does not look in data/ of parent folders", () => {
    const app = join(base, `app${n++}`);
    mkdirSync(join(app, "data"), { recursive: true });
    mkdirSync(join(app, "src"));
    writeFileSync(join(app, "data", "croft.json"), JSON.stringify(MIN));
    expect(findRoot(join(app, "src"))).toBeNull();
  });

  test("returns null outside a project", () => {
    const empty = join(base, `empty${n++}`);
    mkdirSync(empty);
    expect(findRoot(empty)).toBeNull();
  });
});

describe("loadProject", () => {
  test("applies defaults and resolves paths", () => {
    const root = project({ $schema: "./node_modules/@zabaca/croft/croft.schema.json", timezone: "Asia/Tokyo" });
    const p = loadProject({ cwd: root });
    expect(p.root).toBe(root);
    expect(p.timezone).toBe("Asia/Tokyo");
    expect(p.config).toEqual({
      database: "warehouse.duckdb", timezone: "Asia/Tokyo", readCopy: false,
      notify: { desktop: true, webhook: null }, concurrency: 4,
      serve: { port: 7447, host: "127.0.0.1", queryTimeoutMs: 30000, maxConcurrent: 4, maxBytes: 67108864, allowOrigins: [] },
      stateDir: null,
    });
    expect(p.paths).toEqual({
      root, config: join(root, "croft.json"), database: join(root, "warehouse.duckdb"),
      readCopy: join(root, "warehouse.read.duckdb"), stateDir: join(root, ".croft"), filesDir: join(root, "files"),
      assetsDir: join(root, "assets"), libDir: join(root, "lib"), envFile: join(root, ".env"),
    });
    expect(p.databaseLabel).toBe("warehouse.duckdb");
    expect(p.relocated).toBe(false);
  });

  test("honors a relocated database and stateDir, with ~ expansion", () => {
    const home = join(base, "home");
    const root = project({ ...MIN, database: "~/.local/share/croft/x-1/warehouse.duckdb", stateDir: "~/.local/share/croft/x-1/.croft" });
    const p = loadProject({ cwd: root, home });
    expect(p.paths.database).toBe(join(home, ".local/share/croft/x-1/warehouse.duckdb"));
    expect(p.paths.stateDir).toBe(join(home, ".local/share/croft/x-1/.croft"));
    expect(p.paths.readCopy).toBe(join(home, ".local/share/croft/x-1/warehouse.read.duckdb"));
    expect(p.paths.filesDir).toBe(join(root, "files"));
    expect(p.databaseLabel).toBe(p.paths.database);
    expect(p.relocated).toBe(true);
  });

  test("a relative stateDir resolves against the root", () => {
    const root = project({ ...MIN, stateDir: "state" });
    expect(loadProject({ cwd: root }).paths.stateDir).toBe(join(root, "state"));
  });

  test("outside a project throws PROJECT_NOT_FOUND", () => {
    const empty = join(base, `none${n++}`);
    mkdirSync(empty);
    let err: unknown;
    try { loadProject({ cwd: empty }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CroftError);
    expect((err as CroftError).code).toBe("PROJECT_NOT_FOUND");
    expect((err as CroftError).message).toContain(empty);
    expect((err as CroftError).problem.hint).toContain("croft init");
  });

  test("an invalid croft.json throws CONFIG_INVALID listing every problem", () => {
    const root = project('{\n  "timezone": "Pacific",\n  "readCopy": "yes",\n  "serve": { "port": 0 }\n}\n');
    let err: unknown;
    try { readConfig(root); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CroftError);
    const e = err as CroftError;
    expect(e.code).toBe("CONFIG_INVALID");
    expect(e.exit).toBe(2);
    expect(e.message).toBe([
      "croft.json has 3 problems:",
      'line 2: "timezone" is "Pacific", which croft cannot use: it is not an IANA time zone name',
      'line 3: "readCopy" must be true or false; found "yes"',
      'line 4: "serve.port" must be a whole number from 1 to 65535; found 0',
    ].join("\n"));
    expect(e.problem).toMatchObject({ file: "croft.json", line: 2, column: 3 });
    expect((e.problem.details?.issues as unknown[]).length).toBe(3);
  });
});

describe("stateDir and database locations", () => {
  // stateDir goes into the warehouse sandbox's allowed_directories, and files/ into croft query's, so a
  // careless location would let SQL read .env, serve.json (the serve token), runs.sqlite or the warehouse.
  const home = join(base, "home");
  const bad = (config: Record<string, unknown>): ConfigIssue[] => {
    const root = project({ ...MIN, ...config });
    let err: unknown;
    try {
      loadProject({ root, home });
    } catch (e) {
      err = e;
    }
    if (!(err instanceof CroftError)) throw new Error(`accepted ${JSON.stringify(config)}`);
    expect(err.code).toBe("CONFIG_INVALID");
    return err.problem.details?.issues as ConfigIssue[];
  };

  test("stateDir must not be or contain the project folder, home, files/, assets/, lib/ or the database", () => {
    mkdirSync(home, { recursive: true });
    for (const [stateDir, what] of [
      [".", "project folder"],
      ["./", "project folder"],
      ["..", "project folder"],
      ["files/..", "project folder"],
      ["/", "project folder"],
      ["~", "home folder"],
      [home, "home folder"],
      ["files", "files/"],
      ["files/state", "files/"],
      ["assets", "assets/"],
      ["lib/state", "lib/"],
      ["warehouse.duckdb", "database"],
    ] as const) {
      const [i, ...rest] = bad({ stateDir });
      expect([stateDir, i!.path, rest.length]).toEqual([stateDir, "stateDir", 0]);
      expect(i!.message).toContain(what);
      expect(i!.line).toBeGreaterThan(0);
    }
  });

  test("a symlink cannot smuggle stateDir onto the project folder", () => {
    const root = project(MIN);
    symlinkSync(root, join(root, "state"));
    writeFileSync(join(root, "croft.json"), JSON.stringify({ ...MIN, stateDir: "state" }));
    let err: unknown;
    try { loadProject({ root, home }); } catch (e) { err = e; }
    expect((err as CroftError).code).toBe("CONFIG_INVALID");
    expect((err as CroftError).message).toContain("project folder");
  });

  test("the database must not sit in files/ or the state folder, or use a reserved name", () => {
    for (const [config, what] of [
      [{ database: "files/warehouse.duckdb" }, "files/"],
      [{ database: ".croft/warehouse.duckdb" }, "state folder"],
      [{ database: "state/w.duckdb", stateDir: "state" }, "state folder"],
      [{ database: ".croft/preview.duckdb" }, "state folder"],
      [{ database: "preview.duckdb" }, "reserved"],
      [{ database: "warehouse.read.duckdb" }, "reserved"],
      [{ database: "data/x.read.duckdb" }, "reserved"],
    ] as const) {
      const issues = bad(config);
      expect([JSON.stringify(config), issues.map((i) => i.path)]).toEqual([JSON.stringify(config), [("stateDir" in config ? "stateDir" : "database")]]);
      expect(issues[0]!.message).toContain(what);
    }
  });

  test("ordinary and relocated layouts are fine", () => {
    for (const config of [
      {},
      { stateDir: "state" },
      { stateDir: ".croft" },
      { database: "data/warehouse.duckdb" },
      { database: "~/.local/share/croft/x-1/warehouse.duckdb", stateDir: "~/.local/share/croft/x-1/.croft" },
    ]) {
      const root = project({ ...MIN, ...config });
      expect(loadProject({ root, home }).root).toBe(root);
    }
  });

  test("parseConfig without a project root checks only the text", () => {
    expect(parseConfig(JSON.stringify({ ...MIN, stateDir: "." })).ok).toBe(true);
  });
});

describe("physicalPath", () => {
  test("follows symlinks one component at a time, so .. after a symlink leaves its target", () => {
    const dir = join(base, `phys${n++}`);
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "secret"), "s");
    symlinkSync(join(dir, "a", "b"), join(dir, "other", "link"));
    // other/link/.. is a/, physically; lexically it would be other/.
    expect(physicalPath(join(dir, "other")).path).toBe(join(dir, "other"));
    expect(physicalPath(`${dir}/other/link/../b`)).toEqual({ path: join(dir, "a", "b"), exists: true });
    expect(physicalPath("link/../../secret", join(dir, "other"))).toEqual({ path: join(dir, "secret"), exists: true });
    symlinkSync("../secret", join(dir, "a", "rel"));
    expect(physicalPath(join(dir, "a", "rel"))).toEqual({ path: join(dir, "secret"), exists: true });
    expect(physicalPath(`${dir}/other/link/missing/x`)).toEqual({ path: join(dir, "a", "b", "missing", "x"), exists: false });
    expect(physicalPath(`${dir}/secret/x`)).toEqual({ path: join(dir, "secret", "x"), exists: false });
    symlinkSync(join(dir, "loop"), join(dir, "loop"));
    expect(() => physicalPath(join(dir, "loop", "x"))).toThrow("too many symbolic links");
  });
});

describe("croft.json validation messages", () => {
  test("syntax errors point at the line and column", () => {
    const [i] = issues('{\n  "database": "warehouse.duckdb",\n  "timezone": "UTC",\n}\n');
    expect(i).toMatchObject({ line: 4, column: 1, message: 'croft.json is not valid JSON: trailing comma before "}" is not allowed in JSON' });
    expect(issues('{"timezone": \'UTC\'}')[0]!.message).toBe("croft.json is not valid JSON: strings need double quotes in JSON");
    expect(issues('{"a": 1 "b": 2}')[0]!.message).toBe('croft.json is not valid JSON: expected "," or "}" after the value of "a", found """');
    expect(issues("")[0]!.message).toBe("croft.json is not valid JSON: the file is empty; it needs a JSON object");
    expect(issues('{"timezone": "UTC"')[0]!.message).toContain("found the end of the file");
  });

  test("the top level must be an object", () => {
    expect(issues("[]")[0]!.message).toMatch(/^croft.json must hold a JSON object like .*; found a list$/);
  });

  test("a missing timezone suggests this machine's zone as an insert fix", () => {
    const [i] = issues('{"database": "warehouse.duckdb"}');
    expect(i!.message).toBe('croft.json has no "timezone"; croft needs it for schedules, ::DATE and JSON timestamps');
    expect(i!.fix).toMatchObject({ kind: "edit", file: "croft.json" });
    expect((i!.fix as { insert: string }).insert).toMatch(/^"timezone": ".+"$/);
  });

  test("unknown keys get a did-you-mean with an edit fix", () => {
    const [i] = issues('{\n  "timeZone": "UTC",\n  "timezone": "UTC"\n}');
    expect(i).toMatchObject({
      path: "timeZone", line: 2, column: 3, message: 'unknown key "timeZone"; did you mean "timezone"?',
      fix: { kind: "edit", file: "croft.json", line: 2, replace: { from: '"timeZone"', to: '"timezone"' } },
    });
    const [j] = issues('{"timezone": "UTC", "serve": {"prot": 1}}');
    expect(j!.message).toBe('unknown key "serve.prot"; did you mean "serve.port"?');
    const [k] = issues('{"timezone": "UTC", "colour": 1}');
    expect(k!.message).toBe('unknown key "colour"; croft.json takes "database", "timezone", "readCopy", "notify", "concurrency", "serve", "stateDir"');
  });

  test("time zones: misspelled case, a city, and a fixed offset", () => {
    const [a] = issues('{"timezone": "america/los_angeles"}');
    expect(a!.message).toBe('"timezone" is "america/los_angeles", which croft cannot use: it is spelled "America/Los_Angeles"');
    expect(a!.fix).toMatchObject({ replace: { from: '"america/los_angeles"', to: '"America/Los_Angeles"' } });
    const [b] = issues('{"timezone": "Tokyo"}');
    expect(b!.hint).toBe('use "Asia/Tokyo"');
    const [c] = issues('{"timezone": "+09:00"}');
    expect(c!.message).toContain("a fixed offset is not a time zone");
    const [d] = issues('{"timezone": 9}');
    expect(d!.message).toBe('"timezone" must be a string like "America/Los_Angeles"; found 9');
  });

  test("quoted numbers and booleans get an unquote fix", () => {
    const list = issues('{"timezone": "UTC", "concurrency": "8", "readCopy": "true"}');
    expect(list.map((i) => i.message)).toEqual([
      '"readCopy" must be true or false; found "true"',
      '"concurrency" must be a whole number from 1 to 64; found "8"',
    ]);
    expect(list[1]!.fix).toMatchObject({ replace: { from: '"8"', to: "8" } });
  });

  test("database, notify and serve values", () => {
    expect(issues('{"timezone": "UTC", "database": "data.db"}')[0]!.message).toBe('"database" must end in .duckdb; found "data.db"');
    expect(issues('{"timezone": "UTC", "database": ":memory:"}')[0]!.message).toContain("would lose every table");
    expect(issues('{"timezone": "UTC", "notify": {"webhook": "hooks.slack.com"}}')[0]!.message)
      .toBe('"notify.webhook" must be an http(s) URL or null; found "hooks.slack.com"');
    expect(issues('{"timezone": "UTC", "notify": true}')[0]!.message).toBe('"notify" must be an object; found true');
    const origins = issues('{"timezone": "UTC", "serve": {"allowOrigins": ["http://localhost:3000/app", "*"]}}');
    expect(origins.map((i) => i.message)).toEqual([
      '"serve.allowOrigins[0]" must be an origin without a path; found "http://localhost:3000/app"',
      '"serve.allowOrigins[1]" must be an origin like "http://localhost:3000"; found "*"',
    ]);
    expect(origins[0]!.fix).toMatchObject({ replace: { to: '"http://localhost:3000"' } });
  });

  test("a full valid config", () => {
    const r = parseConfig(JSON.stringify({
      ...MIN, readCopy: true, concurrency: 2, notify: { desktop: false, webhook: "https://hooks.example.com/x" },
      serve: { port: 8080, host: "0.0.0.0", queryTimeoutMs: 5000, maxConcurrent: 2, maxBytes: 1_000_000, allowOrigins: ["http://localhost:3000"] },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.serve.allowOrigins).toEqual(["http://localhost:3000"]);
  });

  test("configProblems gives one CONFIG_INVALID per issue", () => {
    const ps = configProblems(issues('{\n  "timezone": "Pacific",\n  "concurrency": 0\n}'));
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({ severity: "error", code: "CONFIG_INVALID", file: "croft.json", line: 2, column: 3, docs: "croft docs CONFIG_INVALID" });
    expect(ps[1]!.fix).toEqual({ kind: "manual", description: 'set "concurrency" to a number like 4' });
  });
});

describe("scanJson", () => {
  test("records key positions by path", () => {
    const r = scanJson('{\n  "serve": {\n    "allowOrigins": ["a", "b"]\n  }\n}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.paths.get("serve")).toMatchObject({ line: 2, column: 3 });
      expect(r.paths.get("serve.allowOrigins")).toMatchObject({ line: 3, column: 5 });
      expect(r.paths.get("serve.allowOrigins[1]")).toMatchObject({ line: 3, column: 27 });
    }
  });

  test("accepts everything JSON.parse accepts in a sample", () => {
    for (const t of ['{"a": [1, -2.5e3, true, false, null, "x\\"\\u00e9"]}', "﻿{}", " 0 ", '"s"']) {
      expect(scanJson(t).ok).toBe(true);
    }
    for (const t of ["{a: 1}", "[1,]", "01", '"\n"', "{} {}", "tru"]) expect(scanJson(t).ok).toBe(false);
  });
});

describe("relocation helpers", () => {
  test("syncedLocation flags iCloud, cloud folders and WSL drives", () => {
    const home = "/Users/ada";
    expect(syncedLocation("/Users/ada/Documents/my-data", { home, platform: "darwin" })).toContain("iCloud");
    expect(syncedLocation("/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/x", { home, platform: "darwin" })).toBe("iCloud Drive");
    expect(syncedLocation("/Users/ada/Dropbox/x", { home, platform: "darwin" })).toBe("Dropbox");
    expect(syncedLocation("/Users/ada/OneDrive - Acme/x", { home, platform: "darwin" })).toBe("OneDrive");
    expect(syncedLocation("/Users/ada/code/my-data", { home, platform: "darwin" })).toBeNull();
    expect(syncedLocation("/mnt/c/Users/ada/data", { home: "/home/ada", platform: "linux", wsl: true })).toContain("WSL");
    expect(syncedLocation(base, { home: "/nonexistent", platform: process.platform === "linux" ? "linux" : "darwin", wsl: false })).toBeNull();
  });

  test("relocationDir is stable and per project", () => {
    const a = relocationDir("/Users/ada/Documents/My Data", "/Users/ada");
    expect(a).toMatch(/^\/Users\/ada\/\.local\/share\/croft\/my-data-[0-9a-f]{8}$/);
    expect(relocationDir("/Users/ada/Documents/My Data", "/Users/ada")).toBe(a);
    expect(relocationDir("/Users/ada/Desktop/My Data", "/Users/ada")).not.toBe(a);
  });
});

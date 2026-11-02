// croft serve key add|list|remove <name> (DESIGN.md §4.1, D122): a key per person, from the CLI, with --json, for a person
// and for an agent. The key is printed once; only its hash is kept; list never shows it; remove takes effect at once.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunsDb } from "../../history/runs-db.ts";
import { KeyStore } from "../../serve/keys.ts";
import { cleanup, cli, makeProject } from "./inspect-testkit.ts";

afterAll(() => cleanup());

const KEY = /croftkey_[A-Za-z0-9_-]{43}/;
const share = (root: string, tables: string[]) =>
  writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "America/Los_Angeles", serve: { sharedTables: tables } }));
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile())
  .map((e) => join(e.parentPath, e.name));

describe("croft serve key add", () => {
  test("golden --json: the key once, with when it was made, the tables it reads and where its hash is kept", async () => {
    const p = makeProject();
    share(p.root, ["orders", "customers"]);
    const r = await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root, env: { CROFT_NOW: "2026-11-01T18:00:00Z" } });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: "serve", problems: [] });
    const d = (r.json as { data: Record<string, unknown> }).data;
    expect(Object.keys(d)).toEqual(["action", "name", "key", "createdAt", "sharedTables", "unknownTables", "file", "serverMode"]);
    expect(d).toMatchObject({
      action: "add", name: "alice", createdAt: "2026-11-01T10:00:00-08:00", sharedTables: ["orders", "customers"], unknownTables: ["orders", "customers"],
      file: ".croft/serve-keys.json", serverMode: false,
    });
    expect(d.key).toMatch(new RegExp(`^${KEY.source}$`));
    // The key opens exactly one door: the one the server checks.
    expect(new KeyStore(p.stateDir).verify(d.key as string)).toBe("alice");
  });

  test("human: the key is shown once, with how to use it, what it reads and how to take it away", async () => {
    const p = makeProject();
    share(p.root, ["orders"]);
    const r = await cli(["serve", "key", "add", "alice"], { cwd: p.root });
    expect(r.exit).toBe(0);
    const key = KEY.exec(r.stdout)![0];
    expect(r.stdout.match(new RegExp(key, "g"))).toHaveLength(1);
    expect(r.stdout).toContain("shown once");
    expect(r.stdout).toContain("This key reads orders, read-only");
    expect(r.stdout).toContain("croft serve key remove alice");
    expect(r.stderr).not.toContain(key);
  });

  test("with no table shared it says so: every query of the key is refused until the project names some", async () => {
    const p = makeProject();
    const r = await cli(["serve", "key", "add", "alice"], { cwd: p.root });
    expect(r.stdout).toContain("serve.sharedTables in croft.json names no table yet");
    const j = await cli(["serve", "key", "add", "bob", "--json"], { cwd: p.root });
    expect((j.json as { data: { sharedTables: string[] } }).data.sharedTables).toEqual([]);
  });

  test("only a hash is kept: the key is in no file of the project, its state folder or runs.sqlite, and the file is private", async () => {
    const p = makeProject();
    const r = await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root });
    const key = (r.json as { data: { key: string } }).data.key;
    for (const f of everyFile(p.root)) {
      if (f.includes("node_modules")) continue;
      expect(readFileSync(f).includes(key), f).toBe(false);
    }
    expect(statSync(join(p.stateDir, "serve-keys.json")).mode & 0o777).toBe(0o600);
    const runs = RunsDb.open(p.stateDir);
    try {
      expect(JSON.stringify(runs.sqlite.query("SELECT * FROM runs").all())).not.toContain(key);
    } finally {
      runs.close();
    }
  });

  test("the key shows in no other command's output: list, status, doctor, serve's own help", async () => {
    const p = makeProject();
    const key = (await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root })).json as { data: { key: string } };
    for (const argv of [["serve", "key", "list"], ["serve", "key", "list", "--json"], ["status"], ["status", "--json"], ["doctor", "--json"], ["serve", "--help"]]) {
      const r = await cli(argv, { cwd: p.root });
      expect(r.stdout + r.stderr, argv.join(" ")).not.toContain(key.data.key);
    }
  }, 60_000);

  test("a name has one key; a bad name is a usage error; both change nothing", async () => {
    const p = makeProject();
    await cli(["serve", "key", "add", "alice"], { cwd: p.root });
    const before = readFileSync(join(p.stateDir, "serve-keys.json"), "utf8");
    const twice = await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root });
    expect(twice.exit).toBe(2);
    expect((twice.json as { problems: { code: string }[] }).problems[0]!.code).toBe("SERVE_KEY_EXISTS");
    const bad = await cli(["serve", "key", "add", "Alice B", "--json"], { cwd: p.root });
    expect(bad.exit).toBe(2);
    expect((bad.json as { problems: { code: string }[] }).problems[0]!.code).toBe("USAGE_ERROR");
    expect(readFileSync(join(p.stateDir, "serve-keys.json"), "utf8")).toBe(before);
  });
});

describe("a key without server mode (D128)", () => {
  const WARN = /server mode is off in croft\.json, so (this key|every key) is refused until server mode is on/;

  test("is made all the same, so a person can be set up first, and the output says it is refused until server mode is on, in the data too", async () => {
    const p = makeProject();
    share(p.root, ["orders"]);
    const human = await cli(["serve", "key", "add", "alice"], { cwd: p.root });
    expect(human.exit).toBe(0);
    expect(human.stdout).toMatch(KEY);
    expect(human.stdout).toContain('server mode is off in croft.json, so this key is refused until server mode is on ("serverMode": {"enabled": true}, which the user decides: croft docs keys)');
    const json = (await cli(["serve", "key", "add", "bob", "--json"], { cwd: p.root })).json as { data: { serverMode: boolean }; problems: unknown[] };
    expect(json.data.serverMode).toBe(false);
    expect(json.problems).toEqual([]); // a warning in the data, as unknownTables is, not a problem: nothing failed
    const list = await cli(["serve", "key", "list"], { cwd: p.root });
    expect(list.stdout).toContain("alice");
    expect(list.stdout).toMatch(WARN);
    expect(list.stdout).toContain("every key is refused");
    expect(((await cli(["serve", "key", "list", "--json"], { cwd: p.root })).json as { data: { serverMode: boolean } }).data.serverMode).toBe(false);
    // remove needs no warning: taking access away is always fine.
    expect((await cli(["serve", "key", "remove", "bob"], { cwd: p.root })).stdout).not.toMatch(WARN);
  });

  test("with server mode on there is no warning and the data says so", async () => {
    const p = makeProject();
    writeFileSync(join(p.root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "America/Los_Angeles", serverMode: { enabled: true }, serve: { sharedTables: ["orders"] } }));
    const human = await cli(["serve", "key", "add", "alice"], { cwd: p.root });
    expect(human.stdout).not.toMatch(WARN);
    const json = (await cli(["serve", "key", "list", "--json"], { cwd: p.root })).json as { data: { serverMode: boolean } };
    expect(json.data.serverMode).toBe(true);
    expect((await cli(["serve", "key", "list"], { cwd: p.root })).stdout).not.toMatch(WARN);
  });
});

describe("how a person's DuckDB attaches over Quack (D125)", () => {
  const serverMode = (root: string, sm: Record<string, unknown>, tables = ["orders", "customers"]) =>
    writeFileSync(join(root, "croft.json"), JSON.stringify({ database: "warehouse.duckdb", timezone: "America/Los_Angeles", serverMode: { enabled: true, ...sm }, serve: { sharedTables: tables } }));
  type Added = { data: { key: string; quack?: { uri: string | null; loopback: boolean; attach: string | null; asOfView: string } } };

  test("without server mode there is no Quack and the data has no quack", async () => {
    const p = makeProject();
    share(p.root, ["orders"]);
    const added = (await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root })).json as Added;
    expect(added.data).not.toHaveProperty("quack");
    expect((await cli(["serve", "key", "add", "bob"], { cwd: p.root })).stdout).not.toContain("Quack");
    expect(((await cli(["serve", "key", "list", "--json"], { cwd: p.root })).json as Added).data).not.toHaveProperty("quack");
  });

  test("in server mode --json has the address, the ATTACH statement with the key in it and the as-of view's name; the human text prints them", async () => {
    const p = makeProject();
    serverMode(p.root, {});
    const added = (await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root })).json as Added;
    expect(added.data.quack).toEqual({
      uri: "quack:127.0.0.1:9494", loopback: true, asOfView: "_croft_as_of", attach: `ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN '${added.data.key}')`,
    });
    const human = await cli(["serve", "key", "add", "bob"], { cwd: p.root });
    const key = KEY.exec(human.stdout)![0];
    expect(human.stdout).toContain(`ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN '${key}');`);
    expect(human.stdout).toContain("SELECT * FROM croft.orders;");
    expect(human.stdout).toContain("SELECT as_of FROM croft._croft_as_of;");
    expect(human.stdout).not.toContain("HTTPS reverse proxy");
    // list never holds a key: the statement has <key> in its place.
    const list = (await cli(["serve", "key", "list", "--json"], { cwd: p.root })).json as { data: { quack: { attach: string } } };
    expect(list.data.quack.attach).toBe("ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN '<key>')");
    expect(JSON.stringify(list)).not.toContain(key);
  });

  test("a port of 0 is only known to a running croft serve: its record gives the address, and without one the data says so", async () => {
    const p = makeProject();
    serverMode(p.root, { quackPort: 0 });
    const cold = (await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root })).json as Added;
    expect(cold.data.quack).toMatchObject({ uri: null, attach: null });
    expect((await cli(["serve", "key", "add", "bob"], { cwd: p.root })).stdout).toContain("croft serve picks the port");
    // A record of a live process (this one) with the address it bound.
    writeFileSync(join(p.stateDir, "serve.json"), JSON.stringify({
      url: "http://127.0.0.1:7447", host: "127.0.0.1", port: 7447, token: "t", pid: process.pid, procStart: null, bootId: null, startedAt: "2026-11-01T18:00:00Z", version: "x",
      serverMode: true, quack: { uri: "quack:127.0.0.1:55001" },
    }));
    const warm = (await cli(["serve", "key", "add", "carol", "--json"], { cwd: p.root })).json as Added;
    expect(warm.data.quack).toMatchObject({ uri: "quack:127.0.0.1:55001", attach: `ATTACH 'quack:127.0.0.1:55001' AS croft (TOKEN '${warm.data.key}')` });
  });

  test("an address that is not loopback is said to need an HTTPS reverse proxy, and a client is told to write the machine's name", async () => {
    const p = makeProject();
    serverMode(p.root, { quackHost: "0.0.0.0", quackPort: 9500 });
    const added = (await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root })).json as Added;
    expect(added.data.quack).toMatchObject({ uri: "quack:0.0.0.0:9500", loopback: false });
    expect(added.data.quack!.attach).toBe(`ATTACH 'quack:<this machine>:9500' AS croft (TOKEN '${added.data.key}')`);
    expect((await cli(["serve", "key", "add", "bob"], { cwd: p.root })).stdout).toContain("HTTPS reverse proxy");
  });
});

describe("a shared table that no asset makes", () => {
  test("is named where a typo would otherwise go unnoticed: key add, key list and the banner's data; a real asset is not", async () => {
    const p = makeProject({ files: { "assets/orders.sql": "SELECT 1 AS id\n" } });
    share(p.root, ["orders", "custmers"]);
    const added = await cli(["serve", "key", "add", "alice"], { cwd: p.root });
    expect(added.stdout).toContain("serve.sharedTables names no asset called custmers (a typo?): a key cannot read it");
    expect(added.stdout).not.toContain("called orders");
    const json = await cli(["serve", "key", "list", "--json"], { cwd: p.root });
    expect((json.json as { data: { unknownTables: string[] } }).data.unknownTables).toEqual(["custmers"]);
    expect((await cli(["serve", "key", "list"], { cwd: p.root })).stdout).toContain("names no asset called custmers");
    share(p.root, ["orders"]);
    expect(((await cli(["serve", "key", "list", "--json"], { cwd: p.root })).json as { data: { unknownTables: string[] } }).data.unknownTables).toEqual([]);
    expect((await cli(["serve", "key", "list"], { cwd: p.root })).stdout).not.toContain("typo");
  });
});

describe("croft serve key list", () => {
  test("golden --json: names, when each was made and last used, in the project offset; never a key", async () => {
    const p = makeProject();
    share(p.root, ["orders"]);
    const a = (await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root, env: { CROFT_NOW: "2026-11-01T18:00:00Z" } })).json as { data: { key: string } };
    await cli(["serve", "key", "add", "bob", "--json"], { cwd: p.root, env: { CROFT_NOW: "2026-11-01T19:30:00Z" } });
    // croft serve notes a use; the next list shows it.
    const server = new KeyStore(p.stateDir, { now: () => new Date("2026-11-02T08:00:00Z"), usedEveryMs: 0 });
    expect(server.verify(a.data.key)).toBe("alice");
    server.flush();
    const r = await cli(["serve", "key", "list", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect((r.json as { data: unknown }).data).toEqual({
      action: "list",
      keys: [
        { name: "alice", createdAt: "2026-11-01T10:00:00-08:00", lastUsedAt: "2026-11-02T00:00:00-08:00" },
        { name: "bob", createdAt: "2026-11-01T11:30:00-08:00", lastUsedAt: null },
      ],
      sharedTables: ["orders"],
      unknownTables: ["orders"], // this project has no assets: nothing makes the table
      file: ".croft/serve-keys.json",
      serverMode: false,
    });
    expect(r.stdout).not.toContain(a.data.key);
    const human = await cli(["serve", "key", "list"], { cwd: p.root });
    expect(human.stdout).toContain("alice");
    expect(human.stdout).toContain("never");
    expect(human.stdout).toContain("keys read: orders");
  });

  test("no keys yet is not an error", async () => {
    const p = makeProject();
    const r = await cli(["serve", "key", "list", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect((r.json as { data: { keys: unknown[] } }).data.keys).toEqual([]);
    expect((await cli(["serve", "key", "list"], { cwd: p.root })).stdout).toContain("no keys yet");
  });

  test("a damaged keys file is SERVE_KEYS_UNREADABLE with the fix, and is never overwritten", async () => {
    const p = makeProject();
    writeFileSync(join(p.stateDir, "serve-keys.json"), "{ nope");
    const r = await cli(["serve", "key", "list", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    const prob = (r.json as { problems: { code: string; fix?: { requiresHuman?: boolean } }[] }).problems[0]!;
    expect(prob.code).toBe("SERVE_KEYS_UNREADABLE");
    expect(prob.fix?.requiresHuman).toBe(true);
    expect((await cli(["serve", "key", "add", "x"], { cwd: p.root })).exit).toBe(2);
    expect(readFileSync(join(p.stateDir, "serve-keys.json"), "utf8")).toBe("{ nope");
  });
});

describe("croft serve key remove", () => {
  test("golden --json, and the key is refused at once", async () => {
    const p = makeProject();
    const a = (await cli(["serve", "key", "add", "alice", "--json"], { cwd: p.root, env: { CROFT_NOW: "2026-11-01T18:00:00Z" } })).json as { data: { key: string } };
    const b = (await cli(["serve", "key", "add", "bob", "--json"], { cwd: p.root })).json as { data: { key: string } };
    const server = new KeyStore(p.stateDir, { now: () => new Date("2026-11-02T08:00:00Z") });
    expect(server.verify(a.data.key)).toBe("alice");
    const r = await cli(["serve", "key", "remove", "alice", "--json"], { cwd: p.root });
    expect(r.exit).toBe(0);
    expect((r.json as { data: unknown }).data).toEqual({ action: "remove", name: "alice", createdAt: "2026-11-01T10:00:00-08:00", lastUsedAt: "2026-11-02T00:00:00-08:00", remaining: 1 });
    expect(server.verify(a.data.key)).toBeNull();
    expect(server.verify(b.data.key)).toBe("bob");
    const human = await cli(["serve", "key", "remove", "bob"], { cwd: p.root });
    expect(human.stdout).toContain("removed the key for bob");
    expect(human.stdout).toContain("0 keys left");
  });

  test("an unknown name is SERVE_KEY_NOT_FOUND and says which keys there are", async () => {
    const p = makeProject();
    await cli(["serve", "key", "add", "alice"], { cwd: p.root });
    const r = await cli(["serve", "key", "remove", "bob", "--json"], { cwd: p.root });
    expect(r.exit).toBe(2);
    const prob = (r.json as { problems: { code: string; hint: string }[] }).problems[0]!;
    expect(prob.code).toBe("SERVE_KEY_NOT_FOUND");
    expect(prob.hint).toContain("alice");
  });
});

describe("the usage", () => {
  test("croft serve key needs add, list or remove, with a did-you-mean; a name where there is none, or none where it is needed, is refused", async () => {
    const p = makeProject();
    const usage = async (argv: string[]) => {
      const r = await cli([...argv, "--json"], { cwd: p.root });
      expect(r.exit, argv.join(" ")).toBe(2);
      return (r.json as { problems: { code: string; message: string; hint: string }[] }).problems[0]!;
    };
    expect((await usage(["serve", "key"])).message).toContain("needs add, list or remove");
    expect((await usage(["serve", "key", "ad", "alice"])).hint).toContain('did you mean "add"');
    expect((await usage(["serve", "key", "add"])).message).toContain("exactly one name");
    expect((await usage(["serve", "key", "list", "alice"])).message).toContain("takes no name");
    expect((await usage(["serve", "key", "remove", "a", "b"])).message).toContain("at most 3 arguments");
    expect((await usage(["serve", "keys"])).message).toContain("croft serve takes no");
    expect(existsSync(join(p.stateDir, "serve-keys.json"))).toBe(false);
  });
});

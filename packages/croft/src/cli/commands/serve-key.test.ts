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
    expect(Object.keys(d)).toEqual(["action", "name", "key", "createdAt", "sharedTables", "file"]);
    expect(d).toMatchObject({ action: "add", name: "alice", createdAt: "2026-11-01T10:00:00-08:00", sharedTables: ["orders", "customers"], file: ".croft/serve-keys.json" });
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
      file: ".croft/serve-keys.json",
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

// A key per person (serve/keys.ts, D122): made once and shown once, kept as a hash, checked on every request, removed at
// once, and never in a file or a log in readable form. Real files in a temporary state folder.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { hashKey, KEY_NAME, KEY_PREFIX, KeyStore, KEYS_FILE, KEYS_USED_FILE, newKey } from "./keys.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const stateDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "croft-keys-")));
  dirs.push(d);
  return d;
};
const clock = (start = "2026-11-01T10:00:00Z") => {
  let t = Date.parse(start);
  return { now: () => new Date(t), tick: (ms: number) => { t += ms; } };
};
const failure = (fn: () => unknown): CroftError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CroftError) return e;
    throw e;
  }
  throw new Error("expected a CroftError");
};
const contents = (dir: string) => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

describe("a key", () => {
  test("is 32 random bytes behind a prefix, and differs every time", () => {
    const a = newKey();
    const b = newKey();
    expect(a).toStartWith(KEY_PREFIX);
    expect(a).toMatch(/^croftkey_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashKey(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("is named in lower case letters, digits, dots, dashes and underscores", () => {
    for (const ok of ["alice", "reports-bot", "a.b_c-1", "0day", "x".repeat(64)]) expect(KEY_NAME.test(ok), ok).toBe(true);
    for (const bad of ["", "Alice", "-bob", "a b", "a/b", "é", "x".repeat(65), ".hidden"]) expect(KEY_NAME.test(bad), bad).toBe(false);
    expect(failure(() => new KeyStore(stateDir()).add("Alice")).code).toBe("USAGE_ERROR");
  });
});

describe("adding and removing", () => {
  test("add returns the key once; the state folder holds its hash and not the key, in a file only the owner reads", () => {
    const dir = stateDir();
    const c = clock();
    const store = new KeyStore(dir, { now: c.now });
    const { key, info } = store.add("alice");
    expect(info).toEqual({ name: "alice", createdAt: "2026-11-01T10:00:00.000Z", lastUsedAt: null });
    expect(contents(dir)).not.toContain(key);
    expect(contents(dir)).not.toContain(key.slice(KEY_PREFIX.length));
    expect(contents(dir)).toContain(hashKey(key));
    expect(statSync(join(dir, KEYS_FILE)).mode & 0o777).toBe(0o600);
    // No temporary file or lock is left behind.
    expect(readdirSync(dir)).toEqual([KEYS_FILE]);
  });

  test("a name has one key; adding it again is SERVE_KEY_EXISTS and changes nothing", () => {
    const dir = stateDir();
    const store = new KeyStore(dir);
    const first = store.add("alice");
    const before = readFileSync(join(dir, KEYS_FILE), "utf8");
    const e = failure(() => store.add("alice"));
    expect(e.code).toBe("SERVE_KEY_EXISTS");
    expect(e.problem.fix?.kind).toBe("command");
    expect(readFileSync(join(dir, KEYS_FILE), "utf8")).toBe(before);
    expect(store.verify(first.key)).toBe("alice");
  });

  test("remove drops one key and leaves the others; an unknown name is SERVE_KEY_NOT_FOUND naming the keys there are", () => {
    const dir = stateDir();
    const store = new KeyStore(dir);
    const a = store.add("alice");
    const b = store.add("bob");
    const gone = store.remove("alice");
    expect(gone.name).toBe("alice");
    expect(store.list().map((k) => k.name)).toEqual(["bob"]);
    expect(store.verify(a.key)).toBeNull();
    expect(store.verify(b.key)).toBe("bob");
    const e = failure(() => store.remove("alice"));
    expect(e.code).toBe("SERVE_KEY_NOT_FOUND");
    expect(e.problem.hint).toContain("bob");
  });

  test("two adds at once, from two stores on one folder, lose neither key", () => {
    const dir = stateDir();
    const a = new KeyStore(dir);
    const b = new KeyStore(dir);
    const keys = ["a1", "b1", "a2", "b2", "a3", "b3"].map((n, i) => (i % 2 ? b : a).add(n));
    expect(new KeyStore(dir).list().map((k) => k.name).sort()).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
    for (const k of keys) expect(new KeyStore(dir).verify(k.key)).toBe(k.info.name);
  });

  test("eight processes adding at the same moment lose no key", async () => {
    const dir = stateDir();
    const module = join(import.meta.dir, "keys.ts");
    const procs = Array.from({ length: 8 }, (_, i) => Bun.spawn(
      [process.execPath, "--no-env-file", "-e", `import { KeyStore } from ${JSON.stringify(module)}; console.log(new KeyStore(${JSON.stringify(dir)}).add("p${i}").key)`],
      { stdout: "pipe", stderr: "pipe" },
    ));
    const keys: string[] = [];
    for (const p of procs) {
      expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
      keys.push((await new Response(p.stdout).text()).trim());
    }
    const store = new KeyStore(dir);
    expect(store.list().map((k) => k.name).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `p${i}`));
    keys.forEach((k, i) => expect(store.verify(k)).toBe(`p${i}`));
    expect(readdirSync(dir).filter((f) => f !== KEYS_USED_FILE)).toEqual([KEYS_FILE]); // no temporary file, no lock left
  }, 60_000);

  test("a lock left by a process that died is not waited for forever", () => {
    const dir = stateDir();
    mkdirSync(join(dir, "serve-keys.lock"));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "serve-keys.lock"), old, old);
    expect(new KeyStore(dir).add("alice").info.name).toBe("alice");
  });
});

describe("checking a key", () => {
  test("only the key made for a name opens it; anything else, the empty string and a key with no prefix are refused", () => {
    const store = new KeyStore(stateDir());
    const { key } = store.add("alice");
    expect(store.verify(key)).toBe("alice");
    for (const bad of [null, "", "alice", key.slice(0, -1), `${key}x`, key.toUpperCase(), `${KEY_PREFIX}${"A".repeat(43)}`, key.slice(KEY_PREFIX.length)]) {
      expect(store.verify(bad), String(bad)).toBeNull();
    }
  });

  test("a key removed by another process is refused on the very next call, with no restart and no wait", () => {
    const dir = stateDir();
    const server = new KeyStore(dir); // croft serve's copy
    const cli = new KeyStore(dir); // the command's
    const alice = cli.add("alice");
    const bob = cli.add("bob");
    expect(server.verify(alice.key)).toBe("alice");
    expect(server.verify(bob.key)).toBe("bob");
    cli.remove("alice");
    expect(server.verify(alice.key)).toBeNull();
    expect(server.verify(bob.key)).toBe("bob");
    // A key added meanwhile is accepted at once too.
    const carol = cli.add("carol");
    expect(server.verify(carol.key)).toBe("carol");
  });

  test("a keys file that is deleted, damaged or not a keys file means no key is valid (it fails closed), and a repaired one works again", () => {
    const dir = stateDir();
    const store = new KeyStore(dir);
    const { key } = store.add("alice");
    const good = readFileSync(join(dir, KEYS_FILE), "utf8");
    expect(store.verify(key)).toBe("alice");
    writeFileSync(join(dir, KEYS_FILE), "{ not json");
    expect(store.verify(key)).toBeNull();
    expect(failure(() => store.list()).code).toBe("SERVE_KEYS_UNREADABLE");
    expect(failure(() => store.add("bob")).code).toBe("SERVE_KEYS_UNREADABLE"); // never overwritten
    expect(readFileSync(join(dir, KEYS_FILE), "utf8")).toBe("{ not json");
    writeFileSync(join(dir, KEYS_FILE), JSON.stringify({ version: 2, keys: [] }));
    expect(store.verify(key)).toBeNull();
    writeFileSync(join(dir, KEYS_FILE), JSON.stringify({ version: 1, keys: [{ name: "alice", hash: "plain", createdAt: "x" }] }));
    expect(store.verify(key)).toBeNull();
    writeFileSync(join(dir, KEYS_FILE), good);
    expect(store.verify(key)).toBe("alice");
    rmSync(join(dir, KEYS_FILE));
    expect(store.verify(key)).toBeNull();
    expect(store.list()).toEqual([]);
  });
});

describe("listing", () => {
  test("names, when each was made and when it was last used, never the key", () => {
    const dir = stateDir();
    const c = clock();
    const store = new KeyStore(dir, { now: c.now, usedEveryMs: 0 });
    const alice = store.add("alice");
    c.tick(60_000);
    store.add("bob");
    c.tick(60_000);
    expect(store.verify(alice.key)).toBe("alice");
    store.flush();
    const listed = new KeyStore(dir).list();
    expect(listed).toEqual([
      { name: "alice", createdAt: "2026-11-01T10:00:00.000Z", lastUsedAt: "2026-11-01T10:02:00.000Z" },
      { name: "bob", createdAt: "2026-11-01T10:01:00.000Z", lastUsedAt: null },
    ]);
    expect(JSON.stringify(listed)).not.toContain(alice.key);
    expect(contents(dir)).not.toContain(alice.key);
    expect(readdirSync(dir).sort()).toEqual([KEYS_FILE, KEYS_USED_FILE].sort());
  });

  test("a name made again after its key was removed does not inherit the old key's last use", () => {
    const dir = stateDir();
    const c = clock();
    const store = new KeyStore(dir, { now: c.now, usedEveryMs: 0 });
    const old = store.add("alice");
    c.tick(1000);
    store.verify(old.key);
    store.flush();
    store.remove("alice");
    c.tick(1000);
    store.add("alice");
    expect(new KeyStore(dir).list()).toEqual([{ name: "alice", createdAt: "2026-11-01T10:00:02.000Z", lastUsedAt: null }]);
  });

  test("last use is written at most once in a while, and when the server stops", () => {
    const dir = stateDir();
    const c = clock();
    const server = new KeyStore(dir, { now: c.now, usedEveryMs: 10_000 });
    const alice = server.add("alice");
    for (let i = 0; i < 5; i++) {
      server.verify(alice.key);
      c.tick(1000);
    }
    server.flush();
    expect(new KeyStore(dir).list()[0]!.lastUsedAt).toBe("2026-11-01T10:00:04.000Z");
  });
});

// A key per person (DESIGN.md D122, §5 "Server mode, apps and GUIs", "Security"): the keys croft serve accepts besides
// the app token. A key reads the tables the project shares (serve.sharedTables), read-only, over the HTTP API; the app
// token keeps its reach.
//
// - A key is 32 random bytes, base64url, behind the prefix `croftkey_`. `croft serve key add <name>` prints it once;
//   croft keeps only its SHA-256, in <state>/serve-keys.json (mode 0600) next to the name and the time it was made. The
//   state folder is never in git, and a key is never in the project's settings or the warehouse. The digest is a plain
//   SHA-256 and not a slow password hash because a key is 256 random bits, not something a person chose.
// - Who writes what: the key commands (`key add`, `key remove`) rewrite serve-keys.json, under a lock, atomically (a
//   temporary file renamed into place). croft serve only reads it, and writes serve-keys-used.json, the last time each key
//   was used, so the two never write one file.
// - The check runs on every request, not only at sign-in: verify() looks at the file's identity (device, inode, time and
//   size; a rename changes the inode) before it compares, and reads the file again when it changed. A key removed while
//   croft serve runs is refused on its very next request, with no restart and no polling interval in between. A file that
//   is missing or cannot be read means no key is valid: it fails closed.
// - Keys never reach a log: the one log line per key query (serve/server.ts) names the key, not its value, and the commands
//   print the value once, to stdout, and nowhere else.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";

export const KEYS_FILE = "serve-keys.json";
export const KEYS_USED_FILE = "serve-keys-used.json";
const LOCK_DIR = "serve-keys.lock";
/** Written in front of every key, so a key found in a file or a chat is known for one (and a secret scanner can match it). */
export const KEY_PREFIX = "croftkey_";
/** A key's name: lower case letters, digits, dots, dashes and underscores; it starts with a letter or a digit. */
export const KEY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** What `key list` shows about a key: never the key. Times are UTC ISO-8601. */
export interface KeyInfo {
  name: string;
  createdAt: string;
  /** The last request that carried the key, as croft serve last wrote it (up to ten seconds late); null if none yet. */
  lastUsedAt: string | null;
}

interface StoredKey { name: string; hash: string; createdAt: string }
interface KeysFile { version: 1; keys: StoredKey[] }
type Used = Record<string, { at: string; since: string }>;
interface Identity { dev: number; ino: number; mtimeMs: number; size: number }

/** A new key: the prefix and 32 random bytes as base64url (52 characters in all). */
export function newKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The digest croft stores for a key. */
export function hashKey(key: string): string {
  return `sha256:${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

const digestBytes = (hash: string) => Buffer.from(hash.slice("sha256:".length), "hex");

export function invalidName(name: string): CroftError {
  return new CroftError("USAGE_ERROR", {
    message: `${JSON.stringify(name.slice(0, 80))} is not a name for a key: use lower case letters, digits, dots, dashes and underscores (up to 64), starting with a letter or a digit`,
    hint: "name the person or the program the key is for, like alice or reports-bot",
    details: { name: name.slice(0, 80) },
  });
}

function unreadable(path: string, why: string): CroftError {
  return new CroftError("SERVE_KEYS_UNREADABLE", {
    message: `croft cannot read its keys file ${path}: ${why}`,
    hint: "croft serve accepts no key until the file is readable; restore it from a backup of the state folder, or remove it and make the keys again with croft serve key add",
    fix: { kind: "manual", description: `restore or remove ${path}, then run croft serve key add <name> for each person`, requiresHuman: true },
    details: { file: path },
  });
}

function identityOf(path: string): Identity | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

const same = (a: Identity | null, b: Identity | null) =>
  a === b || (a !== null && b !== null && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size);

/** The keys file's text as a list, or a reason it is not one. */
function parse(text: string): { keys: StoredKey[] } | { why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { why: `it is not valid JSON (${(e as Error).message.slice(0, 100)})` };
  }
  const list = (raw as KeysFile | null)?.keys;
  if (!raw || typeof raw !== "object" || (raw as KeysFile).version !== 1 || !Array.isArray(list)) return { why: 'it is not a croft keys file ({"version": 1, "keys": [...]})' };
  const keys: StoredKey[] = [];
  for (const k of list as unknown[]) {
    const e = k as Partial<StoredKey> | null;
    if (!e || typeof e.name !== "string" || typeof e.createdAt !== "string" || typeof e.hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(e.hash)) {
      return { why: "one of its keys has no name, creation time or SHA-256 digest" };
    }
    keys.push({ name: e.name, hash: e.hash, createdAt: e.createdAt });
  }
  return { keys };
}

export interface KeyStoreOptions {
  /** Defaults to the clock. */
  now?: () => Date;
  /** Fewest milliseconds between two writes of the last-used file; default 10_000. */
  usedEveryMs?: number;
}

export class KeyStore {
  private readonly now: () => Date;
  private readonly usedEveryMs: number;
  /** What verify() last read, and the file's identity then; null identity: no file. */
  private keys: StoredKey[] = [];
  private seen: Identity | null = null;
  private seenOnce = false;
  private polled = false;
  private polledIdentity: Identity | null = null;
  private used: Used | null = null;
  private dirty = false;
  private lastFlush = 0;

  constructor(readonly stateDir: string, o: KeyStoreOptions = {}) {
    this.now = o.now ?? (() => new Date());
    this.usedEveryMs = o.usedEveryMs ?? 10_000;
  }

  get path(): string {
    return join(this.stateDir, KEYS_FILE);
  }

  private get usedPath(): string {
    return join(this.stateDir, KEYS_USED_FILE);
  }

  /** Every key, oldest first. Throws SERVE_KEYS_UNREADABLE when the file is damaged. */
  list(): KeyInfo[] {
    const stored = this.read();
    const used = this.readUsed();
    return stored.map((k) => ({ name: k.name, createdAt: k.createdAt, lastUsedAt: used[k.name]?.since === k.createdAt ? used[k.name]!.at : null }));
  }

  /**
   * Make a key for `name`. Returns the key itself, the only time it exists in readable form. Throws USAGE_ERROR for a
   * name that is not one, SERVE_KEY_EXISTS when the name has a key, SERVE_KEYS_UNREADABLE for a damaged file.
   */
  add(name: string): { key: string; info: KeyInfo } {
    if (!KEY_NAME.test(name)) throw invalidName(name);
    mkdirSync(this.stateDir, { recursive: true });
    return this.locked(() => {
      const keys = this.read();
      if (keys.some((k) => k.name === name)) {
        throw new CroftError("SERVE_KEY_EXISTS", {
          message: `a key named ${name} already exists`,
          hint: "give the new key another name, or remove the old one first (croft serve key remove) when it should stop working",
          fix: { kind: "command", description: `remove the key named ${name}, then add it again`, command: `croft serve key remove ${name}`, requiresHuman: true },
          details: { name },
        });
      }
      const key = newKey();
      const createdAt = this.now().toISOString();
      this.write([...keys, { name, hash: hashKey(key), createdAt }]);
      return { key, info: { name, createdAt, lastUsedAt: null } };
    });
  }

  /** Remove the key named `name`: it is refused on its next request. Throws SERVE_KEY_NOT_FOUND when there is none. */
  remove(name: string): KeyInfo {
    return this.locked(() => {
      const keys = this.read();
      const found = keys.find((k) => k.name === name);
      if (!found) {
        throw new CroftError("SERVE_KEY_NOT_FOUND", {
          message: `there is no key named ${JSON.stringify(name.slice(0, 80))}`,
          hint: keys.length ? `the keys are: ${keys.map((k) => k.name).join(", ")} (croft serve key list)` : "no key has been made yet (croft serve key add <name>)",
          details: { name: name.slice(0, 80), keys: keys.map((k) => k.name) },
        });
      }
      const used = this.readUsed()[name];
      const info = { name: found.name, createdAt: found.createdAt, lastUsedAt: used?.since === found.createdAt ? used.at : null };
      this.write(keys.filter((k) => k.name !== name));
      return info;
    });
  }

  /**
   * The name of the key `given` is, or null. Called on every request: the file is read again whenever it changed since
   * the last call, so a removed key is refused at once. Never throws; a file it cannot read means no key is valid. A
   * valid key is noted as used.
   */
  verify(given: string | null): string | null {
    if (given === null || !given.startsWith(KEY_PREFIX)) return null;
    this.refresh();
    const want = digestBytes(hashKey(given));
    let name: string | null = null;
    // Every stored digest is compared, so the time taken does not say where in the list a match was.
    for (const k of this.keys) {
      if (timingSafeEqual(want, digestBytes(k.hash))) name = k.name;
    }
    if (name !== null) this.touch(name);
    return name;
  }

  /**
   * The keys as the readers' process holds them (name and digest, never a key), when the keys file changed since the last
   * call; null when it did not. The first call returns the list. A Quack session outlives a request, so the process cannot
   * look at the file on every request as verify() does: croft serve calls this on its poll (every 250 ms) and sends the
   * list over when it comes back (D126). Like verify(), it fails closed: a file that is missing or cannot be read is no keys.
   */
  changes(): { name: string; hash: string }[] | null {
    const id = identityOf(this.path);
    if (this.polled && same(id, this.polledIdentity)) return null;
    this.polled = true;
    this.polledIdentity = id;
    try {
      return id ? this.read().map((k) => ({ name: k.name, hash: k.hash })) : [];
    } catch {
      return [];
    }
  }

  /** Note that the key named `name` was used just now, for a use verify() did not see (a Quack session, D125). Never throws. */
  noteUsed(name: string): void {
    this.refresh();
    this.touch(name);
  }

  /** Write the last-used times now. croft serve calls it as it stops. Never throws. */
  flush(): void {
    if (!this.dirty || !this.used) return;
    try {
      this.writeAtomic(this.usedPath, `${JSON.stringify(this.used)}\n`);
      this.dirty = false;
      this.lastFlush = Date.now();
    } catch {
      // The last-used time is a convenience; a full disk must not stop the server answering.
    }
  }

  // ---- reading ---------------------------------------------------------------------------------------------

  /** The keys, for the commands: throws when the file is damaged. A file that does not exist holds no key. */
  private read(): StoredKey[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw unreadable(this.path, (e as Error).message.split("\n")[0]!);
    }
    const parsed = parse(text);
    if ("why" in parsed) throw unreadable(this.path, parsed.why);
    return parsed.keys;
  }

  /** verify()'s copy of the keys, read again when the file's identity changed. Damaged or missing: none. */
  private refresh(): void {
    const id = identityOf(this.path);
    if (this.seenOnce && same(id, this.seen)) return;
    this.seenOnce = true;
    this.seen = id;
    try {
      this.keys = id ? this.read() : [];
    } catch {
      this.keys = [];
    }
  }

  private readUsed(): Used {
    try {
      const raw = JSON.parse(readFileSync(this.usedPath, "utf8")) as unknown;
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Used) : {};
    } catch {
      return {};
    }
  }

  private touch(name: string): void {
    const created = this.keys.find((k) => k.name === name)?.createdAt;
    if (!created) return;
    this.used ??= this.readUsed();
    this.used[name] = { at: this.now().toISOString(), since: created };
    this.dirty = true;
    if (Date.now() - this.lastFlush >= this.usedEveryMs) this.flush();
  }

  // ---- writing ---------------------------------------------------------------------------------------------

  private write(keys: StoredKey[]): void {
    const file: KeysFile = { version: 1, keys };
    this.writeAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** A temporary file, 0600, renamed into place: a reader sees the old file or the new one, never half of one. */
  private writeAtomic(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600); // whatever the umask
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** `fn` under a lock on the keys file: two `key add` at once must not each read the file and lose the other's key. */
  private locked<T>(fn: () => T): T {
    const lock = join(this.stateDir, LOCK_DIR);
    const give = Date.now() + 5000;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // A lock older than a few seconds belongs to a process that died inside the lock.
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
        } catch {
          // gone already
        }
        if (Date.now() > give) {
          throw new CroftError("USAGE_ERROR", {
            message: `another croft process is changing the keys (${lock})`,
            hint: "wait a moment and run the command again; if nothing is running, remove that folder",
            retryable: true,
          });
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return fn();
    } finally {
      try {
        rmdirSync(lock);
      } catch {
        // already gone
      }
    }
  }
}

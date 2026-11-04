// Locating and verifying the pinned DuckDB extension files croft's modes load (DESIGN.md §5 "Pinned extensions", D117, D195).
//
// croft never runs INSTALL. A mode loads exactly the files it names, by absolute path, after checking each against the
// sha256 pinned in extension-pins.ts. The files live in one folder on the machine, in DuckDB's own layout: the one the
// caller names, else $CROFT_EXTENSION_DIR, else croft's cache (`resolveExtensionDir`). Where a file comes from when the
// folder lacks it is extension-fetch.ts: DuckDB's own extension servers, before any lockdown, checked against the same pin.
// This file only finds and checks what is already there.
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import type { Fix } from "../core/types.ts";
import { DUCKDB_VERSION, EXTENSIONS, type ExtensionName, PLATFORMS, type Platform } from "./extension-names.ts";
import { EXTENSION_PINS } from "./extension-pins.ts";

/** What detectMusl looks at; tests stub it. */
export interface LibcProbe {
  /** The first bytes of the running executable (its ELF header holds the dynamic loader's path), or null. */
  head(): Buffer | null;
  /** The names in /lib and /lib64. */
  loaders(): string[];
}

const realProbe: LibcProbe = {
  head() {
    try {
      const fd = openSync(process.execPath, "r");
      try {
        const buf = Buffer.alloc(4096);
        const n = readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, n);
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  },
  loaders() {
    const out: string[] = [];
    for (const dir of ["/lib", "/lib64", "/usr/lib"]) {
      try { out.push(...readdirSync(dir)); } catch { /* absent */ }
    }
    return out;
  },
};

/**
 * Whether this Linux uses musl (Alpine) rather than glibc. DuckDB's musl extension builds are different files and croft
 * pins none, so a musl machine is an unpinned platform. The running executable names its dynamic loader in its ELF
 * header (`/lib/ld-musl-x86_64.so.1` or `/lib64/ld-linux-x86-64.so.2`), which is what decides; when it cannot be read,
 * a musl loader on disk with no glibc loader beside it does.
 */
export function detectMusl(probe: LibcProbe = realProbe): boolean {
  const head = probe.head()?.toString("latin1") ?? "";
  if (head.includes("ld-musl")) return true;
  if (head.includes("ld-linux")) return false;
  const loaders = probe.loaders();
  return loaders.some((n) => n.startsWith("ld-musl-")) && !loaders.some((n) => n.startsWith("ld-linux"));
}

let muslOfThisMachine: boolean | undefined;
/** detectMusl for this machine, read once. */
const hostIsMusl = (): boolean => (muslOfThisMachine ??= detectMusl());

/** DuckDB's platform name for this machine, or null where croft pins nothing (musl, Windows, other CPUs). */
export function hostPlatform(os: string = process.platform, arch: string = process.arch, musl: () => boolean = hostIsMusl): Platform | null {
  if (os === "darwin") return arch === "arm64" ? "osx_arm64" : arch === "x64" ? "osx_amd64" : null;
  if (os === "linux") {
    if (musl()) return null;
    return arch === "x64" ? "linux_amd64" : arch === "arm64" ? "linux_arm64" : null;
  }
  return null;
}

/** The folder of extension files: $CROFT_EXTENSION_DIR when set (an image that baked them in, croft's tests and CI), else croft's cache. */
export function resolveExtensionDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CROFT_EXTENSION_DIR || cacheDir(env);
}

/** croft's own cache folder, shared by every project and worktree on the machine: `$XDG_CACHE_HOME` or `~/.cache`, then `croft/extensions`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "croft", "extensions");
}

/** Where `name` lives under an extension folder: `<dir>/v<duckdb>/<platform>/<file>.duckdb_extension`, DuckDB's own layout. */
export function extensionPath(dir: string, name: ExtensionName, platform: Platform): string {
  return join(dir, `v${DUCKDB_VERSION}`, platform, `${EXTENSIONS[name]}.duckdb_extension`);
}

/**
 * The metadata DuckDB appends to every extension file: the last 512 bytes are eight 32-byte fields, then a 256-byte
 * signature; the fields run backwards in the file, so the last of the eight is the start magic "4", before it the
 * platform, the DuckDB version the file was built for ("v2.0.0"), the extension build, and the ABI type ("CPP").
 */
export interface ExtensionFooter { platform: string; duckdb: string; version: string }

export function readFooter(path: string): ExtensionFooter | null {
  const size = statSync(path).size;
  if (size < 512) return null;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(512);
    readSync(fd, buf, 0, 512, size - 512);
    // The metadata is the first 256 bytes of the footer, in reverse field order (the start magic is last).
    const field = (i: number) => buf.subarray(i * 32, i * 32 + 32).toString("latin1").replace(/\0+$/, "");
    if (field(7) !== "4") return null;
    return { platform: field(6), duckdb: field(5), version: field(4) };
  } finally {
    closeSync(fd);
  }
}

// Files already verified in this process, by identity (size, mtime, ctime, inode), so opening several instances hashes each file once.
const verified = new Map<string, string>();

/** The command that fetches `names` into this machine's folder, as an agent can run it. */
export function fetchCommand(names: readonly ExtensionName[]): string {
  return `croft fetch-extensions ${names.join(" ")}`;
}

/** The fix for a file that is missing or is not the pinned one: fetch it from DuckDB, which replaces a file that fails its check. */
export function fetchFix(names: readonly ExtensionName[], what: string): Fix {
  return { kind: "command", description: `${what}: fetch DuckDB's pinned ${names.join(" and ")} extension from DuckDB's extension servers (needs the network once)`, command: fetchCommand(names) };
}

const PLATFORM_FIX: Fix = {
  kind: "manual",
  description: "run the mode on macOS, or on Linux with glibc, on an x64 or arm64 CPU; ask the user, since croft cannot change the machine",
  requiresHuman: true,
};

export function platformError(name: ExtensionName): CroftError {
  return new CroftError("EXTENSION_MISSING", {
    message: `croft pins no ${name} extension for ${process.platform} ${process.arch}${process.platform === "linux" && hostIsMusl() ? " (musl)" : ""}`,
    hint: `croft's modes run on macOS and Linux with glibc, on x64 and arm64: ${PLATFORMS.join(", ")}`,
    fix: PLATFORM_FIX,
    retryable: false,
    details: { kind: "platform", extension: name, os: process.platform, arch: process.arch },
  });
}

/** Check one file against its pin and return its path; throws a CroftError with a stable code when it is missing or not the pinned file. */
function checkFile(path: string, name: ExtensionName, platform: Platform): string {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new CroftError("EXTENSION_MISSING", {
      message: `the ${name} extension file is missing: ${path}`,
      hint: `croft fetches it from DuckDB's extension servers the first time a mode needs it; to fetch it ahead of time, or on a machine with no network when croft runs, run: ${fetchCommand([name])}`,
      fix: fetchFix([name], "the file is not on this machine"),
      retryable: false,
      details: { kind: "file", extension: name, platform, duckdb: DUCKDB_VERSION, path, fetch: fetchCommand([name]) },
    });
  }
  const pin = EXTENSION_PINS[platform][name];
  const identity = `${path}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}`;
  if (verified.get(path) === identity) return path;
  const sha256 = st.size === pin.bytes ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
  if (sha256 === pin.sha256) {
    verified.set(path, identity);
    return path;
  }
  // Not the pinned file. Say what it is when its own footer says it was built for another DuckDB or platform.
  const footer = safeFooter(path);
  const command = fetchCommand([name]);
  const fix = fetchFix([name], "the file on this machine is not the pinned one");
  if (footer && (footer.duckdb !== `v${DUCKDB_VERSION}` || footer.platform !== platform)) {
    throw new CroftError("EXTENSION_WRONG_BUILD", {
      message: `the ${name} extension file was built for DuckDB ${footer.duckdb} on ${footer.platform}, not DuckDB v${DUCKDB_VERSION} on ${platform}: ${path}`,
      hint: `croft loads only the pinned file for this DuckDB version and platform; ${command} replaces it`,
      fix,
      retryable: false,
      details: { kind: "build", extension: name, platform, duckdb: DUCKDB_VERSION, path, built: footer, fetch: command },
    });
  }
  throw new CroftError("EXTENSION_CHECKSUM_MISMATCH", {
    message: `the ${name} extension file is not the pinned file (its checksum differs): ${path}`,
    hint: `croft loads only the files it pins; ${command} replaces it with DuckDB's`,
    fix,
    retryable: false,
    details: { kind: "checksum", extension: name, platform, duckdb: DUCKDB_VERSION, path, bytes: st.size, expectedBytes: pin.bytes, fetch: command },
  });
}

/** Check one pinned file in a folder and return its absolute path; throws a CroftError with a stable code when it is not the pinned file. */
export function verifyExtension(dir: string, name: ExtensionName, platform: Platform | null = hostPlatform()): string {
  if (!platform) throw platformError(name);
  return checkFile(extensionPath(dir, name, platform), name, platform);
}

/**
 * Verify a set of extensions in a folder, in the order given, before any of them is loaded: nothing loads unless every file checks.
 * When several are missing or wrong, the first one's error is thrown with the fetch command for all of them, so one command mends the set.
 */
export function verifyExtensions(dir: string, names: readonly ExtensionName[], platform: Platform | null = hostPlatform()): Map<ExtensionName, string> {
  const out = new Map<ExtensionName, string>();
  const failed: { name: ExtensionName; error: CroftError }[] = [];
  for (const n of names) {
    try {
      out.set(n, verifyExtension(dir, n, platform));
    } catch (e) {
      if (!(e instanceof CroftError) || e.problem.details?.kind === "platform") throw e;
      failed.push({ name: n, error: e });
    }
  }
  if (!failed.length) return out;
  const first = failed[0]!.error;
  if (failed.length === 1) throw first;
  const all = failed.map((f) => f.name);
  const command = fetchCommand(all);
  throw new CroftError(first.code, {
    message: first.problem.message,
    hint: `${first.problem.hint ?? ""} (${all.join(", ")} are all missing or not the pinned files: ${command} fetches them together)`.trim(),
    fix: fetchFix(all, "the files on this machine are missing or not the pinned ones"),
    retryable: false,
    details: { ...first.problem.details, missing: all, fetch: command },
  });
}

function safeFooter(path: string): ExtensionFooter | null {
  try { return readFooter(path); } catch { return null; }
}

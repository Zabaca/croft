// Locating and verifying the pinned DuckDB extension files croft's modes load (DESIGN.md §5 "Pinned extensions", D117).
//
// croft never runs INSTALL and never reaches DuckDB's extension repository from a croft process (a test asserts it).
// A mode loads exactly the files it names, by absolute path, after checking each against the sha256 pinned in
// extension-pins.ts. Where the files come from, in order (D132): a folder the caller names, or $CROFT_EXTENSION_DIR
// (croft's tests and builders fill one with scripts/fetch-extensions.ts); else the add-on package for the mode in the
// project's node_modules, which is how a user gets them (addons.ts); else the cache folder builders share. Whichever
// it is, the file is checked against the pin before it is used.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CroftError } from "../core/errors.ts";
import type { Fix } from "../core/types.ts";
import { ADDON_VERSION, ADDONS, type AddonName, addonPackage, extensionPackage, installCommand, packagedFile } from "./addons.ts";
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

/**
 * The folder of extension files builders and tests use: $CROFT_EXTENSION_DIR, else a cache folder (`$XDG_CACHE_HOME` or
 * `~/.cache`, then `croft/test-extensions`) shared by every project and, for builders, every worktree: the one
 * scripts/fetch-extensions.ts fills. It is not where a user's files come from: that is the add-on package (addons.ts).
 */
export function resolveExtensionDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CROFT_EXTENSION_DIR || cacheDir(env);
}

/** The cache folder alone, whether or not $CROFT_EXTENSION_DIR is set. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "croft", "test-extensions");
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

/** Where a verified file came from: a folder named by the caller or $CROFT_EXTENSION_DIR, an add-on package in node_modules, or the builders' cache. */
export type ExtensionSource = "dir" | "addon" | "cache";

/** Where to look for the files, besides the pins. Everything optional: the defaults are a user's. */
export interface ExtensionSearch {
  /** A folder in DuckDB's layout (extensionPath). When given it is the only place looked; croft's tests pass one. */
  dir?: string;
  /** The project's root: add-on packages are looked for in its node_modules, and in the ones above it. */
  from?: string;
  /** The environment ($CROFT_EXTENSION_DIR, $XDG_CACHE_HOME, $HOME); the process's by default. */
  env?: NodeJS.ProcessEnv;
  /** Where this croft is installed, whose node_modules is looked in too; the package this file is in by default. */
  croftRoot?: string;
}

/** A checked file, and where it was found. */
export interface ExtensionFile { path: string; source: ExtensionSource }

const SELF_PACKAGE = fileURLToPath(new URL("../../", import.meta.url));

/** The folder of an installed package, found the way `require` finds it from `origin`, or null. Hoisted, nested and isolated installs all resolve. */
function packageDir(pkg: string, origin: string): string | null {
  try {
    return dirname(createRequire(join(origin, "croft-resolve.js")).resolve(`${pkg}/package.json`));
  } catch {
    return null;
  }
}

/**
 * The add-on's file for `name` on `platform`: from each origin, the extension package itself (installed on its own or
 * hoisted), else the one the installed add-on depends on, resolved from the add-on's own place so that an isolated
 * install, where the add-on's dependencies are not at the top of node_modules, finds it. `installed` is whether the
 * add-on package itself was there, which tells a missing add-on from one whose file for this machine did not install.
 */
function findInAddon(addon: AddonName, name: ExtensionName, platform: Platform, origins: readonly string[]): { path: string | null; installed: boolean } {
  const pkg = extensionPackage(name, platform);
  let installed = false;
  for (const origin of origins) {
    const own = packageDir(pkg, origin);
    if (own && existsSync(join(own, packagedFile(name)))) return { path: join(own, packagedFile(name)), installed: true };
    const meta = packageDir(addonPackage(addon), origin);
    if (!meta) continue;
    installed = true;
    const dep = packageDir(pkg, meta);
    if (dep && existsSync(join(dep, packagedFile(name)))) return { path: join(dep, packagedFile(name)), installed };
  }
  return { path: null, installed };
}

const addonOrigins = (s: ExtensionSearch): string[] => [...new Set([s.from, s.croftRoot ?? SELF_PACKAGE].filter((x): x is string => !!x))];

const DIR_FIX = "fill the extensions folder with DuckDB's pinned files using scripts/fetch-extensions.ts from the croft repository; it checks each file against the pinned checksum before writing it";

/** The fix for a file that is there and wrong, by where it came from: a reinstall of the add-on, or the folder's own refill. */
function wrongFileFix(source: ExtensionSource, addon: AddonName | null, root: string | undefined): Fix {
  if (source === "addon" && addon) {
    return { kind: "command", description: `reinstall the ${addon} add-on, which carries the pinned file (${addonPackage(addon)}@${ADDON_VERSION})`, command: installCommand(addon, root) };
  }
  return { kind: "manual", description: DIR_FIX };
}

const PLATFORM_FIX: Fix = {
  kind: "manual",
  description: "run the mode on macOS, or on Linux with glibc, on an x64 or arm64 CPU; ask the user, since croft cannot change the machine",
  requiresHuman: true,
};

function platformError(name: ExtensionName): CroftError {
  return new CroftError("EXTENSION_MISSING", {
    message: `croft pins no ${name} extension for ${process.platform} ${process.arch}${process.platform === "linux" && hostIsMusl() ? " (musl)" : ""}`,
    hint: `croft's modes run on macOS and Linux with glibc, on x64 and arm64: ${PLATFORMS.join(", ")}`,
    fix: PLATFORM_FIX,
    retryable: false,
    details: { kind: "platform", extension: name, os: process.platform, arch: process.arch },
  });
}

interface How { source: ExtensionSource; addon: AddonName | null; root: string | undefined }

/** Check one file against its pin and return its path; throws a CroftError with a stable code when it is not the pinned file. */
function checkFile(path: string, name: ExtensionName, platform: Platform, how: How): string {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new CroftError("EXTENSION_MISSING", {
      message: `the ${name} extension file is missing: ${path}`,
      hint: how.source === "dir" && how.addon
        ? `put DuckDB's pinned extension files in the extensions folder, or unset $CROFT_EXTENSION_DIR and install the ${how.addon} add-on: ${installCommand(how.addon, how.root)}`
        : "put DuckDB's pinned extension files in the extensions folder",
      fix: { kind: "manual", description: DIR_FIX },
      retryable: false,
      details: { kind: "file", extension: name, platform, duckdb: DUCKDB_VERSION, path },
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
  const fix = wrongFileFix(how.source, how.addon, how.root);
  const again = fix.kind === "command" ? ` ${fix.command}` : "";
  if (footer && (footer.duckdb !== `v${DUCKDB_VERSION}` || footer.platform !== platform)) {
    throw new CroftError("EXTENSION_WRONG_BUILD", {
      message: `the ${name} extension file was built for DuckDB ${footer.duckdb} on ${footer.platform}, not DuckDB v${DUCKDB_VERSION} on ${platform}: ${path}`,
      hint: fix.kind === "command" ? `reinstall the add-on at the version this croft needs:${again}` : "replace it with the pinned file for this DuckDB version and platform",
      fix,
      retryable: false,
      details: { kind: "build", extension: name, platform, duckdb: DUCKDB_VERSION, path, built: footer, source: how.source },
    });
  }
  throw new CroftError("EXTENSION_CHECKSUM_MISMATCH", {
    message: `the ${name} extension file is not the pinned file (its checksum differs): ${path}`,
    hint: fix.kind === "command" ? `croft loads only the files it pins; reinstall the add-on to replace it:${again}` : "croft loads only the files it pins; replace it with the pinned file",
    fix,
    retryable: false,
    details: { kind: "checksum", extension: name, platform, duckdb: DUCKDB_VERSION, path, bytes: st.size, expectedBytes: pin.bytes, source: how.source },
  });
}

/** Check one pinned file in a folder and return its absolute path; throws a CroftError with a stable code when it is not the pinned file. */
export function verifyExtension(dir: string, name: ExtensionName, platform: Platform | null = hostPlatform()): string {
  if (!platform) throw platformError(name);
  return checkFile(extensionPath(dir, name, platform), name, platform, { source: "dir", addon: null, root: undefined });
}

/** Verify a set of extensions in a folder, in the order given, before any of them is loaded: nothing loads unless every file checks. */
export function verifyExtensions(dir: string, names: readonly ExtensionName[], platform: Platform | null = hostPlatform()): Map<ExtensionName, string> {
  const out = new Map<ExtensionName, string>();
  for (const n of names) out.set(n, verifyExtension(dir, n, platform));
  return out;
}

/**
 * Find and check one extension the way a mode does (D132). A folder the caller names, or $CROFT_EXTENSION_DIR, is the
 * only place looked. Otherwise the add-on that carries the extension is looked for in the project's node_modules (and
 * croft's own), and failing that the builders' cache. No file anywhere is EXTENSION_MISSING with kind "addon" and the
 * install command as its fix: the user turned a mode on, and the add-on is what that needs.
 */
export function verifyModeExtension(name: ExtensionName, addon: AddonName | null, s: ExtensionSearch = {}, platform: Platform | null = hostPlatform()): ExtensionFile {
  if (!platform) throw platformError(name);
  const env = s.env ?? process.env;
  const how = (source: ExtensionSource): How => ({ source, addon, root: s.from });
  const dir = s.dir ?? (env.CROFT_EXTENSION_DIR || undefined);
  if (dir) return { path: checkFile(extensionPath(dir, name, platform), name, platform, how("dir")), source: "dir" };
  const origins = addonOrigins(s);
  const found = addon ? findInAddon(addon, name, platform, origins) : { path: null, installed: false };
  if (found.path) return { path: checkFile(found.path, name, platform, how("addon")), source: "addon" };
  const cached = extensionPath(cacheDir(env), name, platform);
  if (existsSync(cached)) return { path: checkFile(cached, name, platform, how("cache")), source: "cache" };
  if (!addon) {
    throw new CroftError("EXTENSION_MISSING", {
      message: `the ${name} extension file is missing: ${cached}`,
      hint: "put DuckDB's pinned extension files in the extensions folder",
      fix: { kind: "manual", description: DIR_FIX },
      retryable: false,
      details: { kind: "file", extension: name, platform, duckdb: DUCKDB_VERSION, path: cached },
    });
  }
  const command = installCommand(addon, s.from);
  const pkg = extensionPackage(name, platform);
  throw new CroftError("EXTENSION_MISSING", {
    message: found.installed
      ? `the ${ADDONS[addon].mode} add-on is installed, but its ${name} file for ${platform} is not (${pkg})`
      : `${ADDONS[addon].mode} is on, but its add-on is not installed: croft found no ${name} extension file for ${platform}`,
    hint: found.installed
      ? `install the ${addon} add-on again so its ${platform} files arrive: ${command}`
      : `install the ${addon} add-on in this project: ${command}. It carries DuckDB's pinned ${(ADDONS[addon].extensions as readonly string[]).join(" and ")} files for this machine; plain croft downloads nothing`,
    fix: { kind: "command", description: `install the ${addon} add-on (${addonPackage(addon)}@${ADDON_VERSION})`, command },
    retryable: false,
    details: {
      kind: "addon", addon, package: addonPackage(addon), version: ADDON_VERSION, extension: name, extensionPackage: pkg, platform,
      duckdb: DUCKDB_VERSION, installed: found.installed, searched: origins, install: command,
    },
  });
}

/** Check every extension a mode loads before the first is loaded, as verifyExtensions does for a folder. */
export function verifyModeExtensions(
  names: readonly ExtensionName[], addonOf: (name: ExtensionName) => AddonName | null, s: ExtensionSearch = {}, platform: Platform | null = hostPlatform(),
): Map<ExtensionName, string> {
  const out = new Map<ExtensionName, string>();
  for (const n of names) out.set(n, verifyModeExtension(n, addonOf(n), s, platform).path);
  return out;
}

function safeFooter(path: string): ExtensionFooter | null {
  try { return readFooter(path); } catch { return null; }
}

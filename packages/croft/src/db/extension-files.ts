// Locating and verifying the pinned DuckDB extension files croft's modes load (DESIGN.md §5 "Pinned extensions", D117).
//
// croft never runs INSTALL and never reaches DuckDB's extension repository from a croft process (a test asserts it).
// A mode loads exactly the files it names, by absolute path, after checking each against the sha256 pinned in
// extension-pins.ts. Where the files come from is the caller's `dir`: this slice's tests and builders fill one with
// scripts/fetch-extensions.ts; how users get them is a later decision (option 06, slice 5).
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, readFileSync, statSync } from "node:fs";
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

// How a user gets the files is not built yet (option 06, slice 5), so the fix points at the croft repository's script.
const FIX: Fix = {
  kind: "manual",
  description: "fill the extensions folder with DuckDB's pinned files using scripts/fetch-extensions.ts from the croft repository; it checks each file against the pinned checksum before writing it",
};

const PLATFORM_FIX: Fix = {
  kind: "manual",
  description: "run the mode on macOS, or on Linux with glibc, on an x64 or arm64 CPU; ask the user, since croft cannot change the machine",
  requiresHuman: true,
};

/** Check one pinned file and return its absolute path; throws a CroftError with a stable code when it is not the pinned file. */
export function verifyExtension(dir: string, name: ExtensionName, platform: Platform | null = hostPlatform()): string {
  if (!platform) {
    throw new CroftError("EXTENSION_MISSING", {
      message: `croft pins no ${name} extension for ${process.platform} ${process.arch}${process.platform === "linux" && hostIsMusl() ? " (musl)" : ""}`,
      hint: `croft's modes run on macOS and Linux with glibc, on x64 and arm64: ${PLATFORMS.join(", ")}`,
      fix: PLATFORM_FIX,
      retryable: false,
      details: { kind: "platform", extension: name, os: process.platform, arch: process.arch },
    });
  }
  const path = extensionPath(dir, name, platform);
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new CroftError("EXTENSION_MISSING", {
      message: `the ${name} extension file is missing: ${path}`,
      hint: "put DuckDB's pinned extension files in the extensions folder",
      fix: FIX,
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
  if (footer && (footer.duckdb !== `v${DUCKDB_VERSION}` || footer.platform !== platform)) {
    throw new CroftError("EXTENSION_WRONG_BUILD", {
      message: `the ${name} extension file was built for DuckDB ${footer.duckdb} on ${footer.platform}, not DuckDB v${DUCKDB_VERSION} on ${platform}: ${path}`,
      hint: "replace it with the pinned file for this DuckDB version and platform",
      fix: FIX,
      retryable: false,
      details: { kind: "build", extension: name, platform, duckdb: DUCKDB_VERSION, path, built: footer },
    });
  }
  throw new CroftError("EXTENSION_CHECKSUM_MISMATCH", {
    message: `the ${name} extension file is not the pinned file (its checksum differs): ${path}`,
    hint: "croft loads only the files it pins; replace it with the pinned file",
    fix: FIX,
    retryable: false,
    details: { kind: "checksum", extension: name, platform, duckdb: DUCKDB_VERSION, path, bytes: st.size, expectedBytes: pin.bytes },
  });
}

function safeFooter(path: string): ExtensionFooter | null {
  try { return readFooter(path); } catch { return null; }
}

/** Verify a set of extensions, in the order given, before any of them is loaded: nothing loads unless every file checks. */
export function verifyExtensions(dir: string, names: readonly ExtensionName[], platform: Platform | null = hostPlatform()): Map<ExtensionName, string> {
  const out = new Map<ExtensionName, string>();
  for (const n of names) out.set(n, verifyExtension(dir, n, platform));
  return out;
}

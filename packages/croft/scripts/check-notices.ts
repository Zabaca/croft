// Fails when an extension file shows a third-party component that its package's notices do not cover (DESIGN.md D135).
//
//   bun scripts/check-notices.ts <folder of extension files in DuckDB's layout>
//
// scripts/build-addons.ts runs it on the files it packs, so the publish workflow's build job does too: a new DuckDB build that links
// something new fails the build until the component is added to scripts/notices.ts with its license text. It looks in three ways,
// and a file fails on any of them:
//   1. Source files (Linux files only). The Linux builds keep the names of the source files they were compiled from (the ELF symbol
//      table's file entries, scripts/elf-files.ts). Every name must have an owner in scripts/notices/source-owners.json, which
//      scripts/build-source-owners.ts builds from the git trees DuckDB v2.0.0 and the extensions were built from (DuckDB's own
//      sources, each third_party directory, the extension's own repository and the libraries' trees), and the owner must be DuckDB,
//      this extension, the toolchain, or a component listed for this extension. A name nobody owns, or one owned only by a library
//      this extension's package does not list, is a finding. This is what finds a new library with no namespace and no marker
//      (jemalloc's `duckdb_je_` is C; FSST, nanoarrow, SkipList, fastpforlib and zlib have none either).
//   2. Markers. Each component has a marker (a namespace, banner, function or file name, scripts/notices.ts); one that shows in a
//      file whose package does not list the component is a finding. This is the only look at a macOS file.
//   3. Namespaces. DuckDB wraps each C++ library it vendors in a `duckdb_<name>` namespace; one that no component covers is a finding.
// What it cannot do: the macOS files are stripped of source-file names and most symbols, so a library there that has no namespace and
// no marker is not found, but the Linux files of the same extension, built from the same sources, are checked by name and would
// show it; a name that two projects share (hash.c) is accepted when either owner is allowed; and it proves nothing about code that
// leaves no name. A component listed for an extension that no file shows is not a failure; it is reported.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLATFORMS, type ExtensionName, type Platform } from "../src/db/extension-names.ts";
import { extensionPath } from "../src/db/extension-files.ts";
import { SHIPPED_EXTENSIONS } from "../src/db/addons.ts";
import { elfSourceFiles } from "./elf-files.ts";
import { COMPONENTS, CORE_NAMESPACES, componentsFor } from "./notices.ts";

export interface Finding {
  extension: ExtensionName;
  platform: Platform;
  /** Components a marker found in the file whose package does not list them. */
  missing: string[];
  /** `duckdb_` namespaces in the file that no component covers. */
  unknown: string[];
  /** Source-file names (Linux files) that nobody owns, or that only a component the package does not list owns. */
  sources: string[];
}

/** The ids of the components whose marker shows in `bytes`. */
export function componentsIn(bytes: Buffer): Set<string> {
  const text = bytes.toString("latin1");
  return new Set(COMPONENTS.filter((c) => c.marker.test(text)).map((c) => c.id));
}

/** The vendored-library namespaces in `bytes`: mangled names carry each identifier after its length, `14duckdb_mbedtls`. */
export function namespacesIn(bytes: Buffer): Set<string> {
  const text = bytes.toString("latin1");
  const out = new Set<string>();
  for (const m of text.matchAll(/(\d{1,3})duckdb_/g)) {
    const n = Number(m[1]);
    const start = m.index! + m[1]!.length;
    const ident = text.slice(start, start + n);
    if (ident.startsWith("duckdb_") && /^[A-Za-z0-9_]+$/.test(ident)) out.add(ident);
  }
  return out;
}

/** The namespaces some component's marker covers. A marker for a namespace is `duckdb_<name>`; the others cover none. */
function covered(namespace: string): boolean {
  return CORE_NAMESPACES.includes(namespace) || COMPONENTS.some((c) => c.marker.test(namespace));
}

interface OwnerFile { duckdb: string; refs: Record<string, string>; owners: Record<string, string[]> }
let ownerMap: Map<string, string[]> | undefined;
/** The owners of each compiled source-file name (scripts/notices/source-owners.json). */
export function sourceOwners(): Map<string, string[]> {
  if (!ownerMap) {
    const file = JSON.parse(readFileSync(fileURLToPath(new URL("./notices/source-owners.json", import.meta.url)), "utf8")) as OwnerFile;
    ownerMap = new Map();
    for (const [owner, names] of Object.entries(file.owners)) for (const n of names) ownerMap.set(n, [...(ownerMap.get(n) ?? []), owner]);
  }
  return ownerMap;
}

/** Names no tree has: the unity-build files DuckDB's build generates (`ub_duckdb_*.cpp`, nanoarrow's the one that is a library) and the toolchain's. */
function generatedOwners(name: string): string[] {
  if (name === "ub_duckdb_adbc_nanoarrow.cpp") return ["nanoarrow"];
  if (/^ub_duckdb_.+\.cpp$/.test(name)) return ["duckdb"];
  if (name === "crtstuff.c") return ["toolchain"];
  return [];
}

/** The source-file names of a Linux file that nobody owns, or that only a library this extension's package does not list owns. */
export function sourceFindings(names: readonly string[], extension: ExtensionName, listed: Iterable<string> = componentsFor(extension).map((c) => c.id)): string[] {
  const allowed = new Set<string>(["duckdb", "toolchain", `ext:${extension}`, ...listed]);
  const owners = sourceOwners();
  const out: string[] = [];
  for (const name of [...names].sort()) {
    const o = [...(owners.get(name) ?? []), ...generatedOwners(name)];
    if (!o.length) out.push(`${name} (nobody owns it)`);
    else if (!o.some((x) => allowed.has(x))) out.push(`${name} (owned by ${o.join(", ")}, not listed for ${extension})`);
  }
  return out;
}

/** Check one file's bytes against the components its extension's package lists (`listedIds`, for a test that wants another list). */
export function checkBytes(bytes: Buffer, extension: ExtensionName, platform: Platform, listedIds: readonly string[] = componentsFor(extension).map((c) => c.id)): Finding {
  const listed = new Set(listedIds);
  const names = platform.startsWith("linux") ? elfSourceFiles(bytes) : null;
  return {
    extension, platform,
    missing: [...componentsIn(bytes)].filter((id) => !listed.has(id)).sort(),
    unknown: [...namespacesIn(bytes)].filter((n) => !covered(n)).sort(),
    // A Linux file whose source names cannot be read is a failure too: the check would otherwise pass blind.
    sources: platform.startsWith("linux") ? (names ? sourceFindings(names, extension, listed) : ["the ELF symbol table cannot be read, so the source files cannot be checked"]) : [],
  };
}

/** Check every file of the folder (this machine's platform, or all four); a file that is not there is skipped. */
export function checkNotices(folder: string, platforms: readonly Platform[] = PLATFORMS): { findings: Finding[]; checked: number; listedButNotSeen: Record<string, string[]> } {
  const findings: Finding[] = [];
  const seen = new Map<ExtensionName, Set<string>>();
  let checked = 0;
  for (const platform of platforms) {
    for (const extension of SHIPPED_EXTENSIONS) {
      const file = extensionPath(folder, extension, platform);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      checked++;
      const ids = seen.get(extension) ?? new Set<string>();
      for (const id of componentsIn(bytes)) ids.add(id);
      seen.set(extension, ids);
      const f = checkBytes(bytes, extension, platform);
      if (f.missing.length || f.unknown.length || f.sources.length) findings.push(f);
    }
  }
  const listedButNotSeen: Record<string, string[]> = {};
  for (const [extension, ids] of seen) {
    const unseen = componentsFor(extension).filter((c) => !ids.has(c.id)).map((c) => c.id);
    if (unseen.length) listedButNotSeen[extension] = unseen;
  }
  return { findings, checked, listedButNotSeen };
}

/** The findings as lines a person can act on. */
export function describe(findings: readonly Finding[]): string[] {
  return findings.map((f) => `${f.extension} on ${f.platform}: ${[
    f.missing.length ? `shows ${f.missing.join(", ")}, which scripts/notices.ts does not list for ${f.extension}` : "",
    f.unknown.length ? `has namespaces no component covers: ${f.unknown.join(", ")}` : "",
    f.sources.length ? `was compiled from source files that no listed component owns: ${f.sources.slice(0, 8).join("; ")}${f.sources.length > 8 ? `; and ${f.sources.length - 8} more` : ""}` : "",
  ].filter(Boolean).join("; ")}`);
}

if (import.meta.main) {
  const folder = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!folder) {
    console.error("usage: bun scripts/check-notices.ts <folder of extension files>");
    process.exit(1);
  }
  const { findings, checked, listedButNotSeen } = checkNotices(folder);
  for (const line of describe(findings)) console.error(`MISSING NOTICE  ${line}`);
  for (const [ext, ids] of Object.entries(listedButNotSeen)) console.log(`listed, not seen in any file checked: ${ext}: ${ids.join(", ")}`);
  console.log(`${checked} files checked, ${findings.length} with a component no notice covers`);
  process.exit(findings.length || !checked ? 1 : 0);
}

// Fails when an extension file shows a third-party component that its package's notices do not cover (DESIGN.md D135).
//
//   bun scripts/check-notices.ts <folder of extension files in DuckDB's layout>
//
// scripts/build-addons.ts runs it on the files it packs, so the publish workflow's build job does too: a new DuckDB build that links
// something new fails the build until the component is added to scripts/notices.ts with its license text. For every file it looks for
// each component's marker (a library's namespace, banner, function or source file name, scripts/notices.ts) in the file's bytes, and it
// fails when
//   - a marker shows in a file of an extension whose package does not list that component, or
//   - the file has a `duckdb_<name>` namespace that is neither a component's nor a DuckDB core name: DuckDB wraps each library it
//     vendors in such a namespace, so a new one is a new library.
// A component listed for an extension that no file shows is not a failure (the notices may be wider than the files); it is reported.
// This can only find what leaves a marker; it does not prove a file has nothing else in it.
import { existsSync, readFileSync } from "node:fs";
import { PLATFORMS, type ExtensionName, type Platform } from "../src/db/extension-names.ts";
import { extensionPath } from "../src/db/extension-files.ts";
import { SHIPPED_EXTENSIONS } from "../src/db/addons.ts";
import { COMPONENTS, CORE_NAMESPACES, componentsFor } from "./notices.ts";

export interface Finding {
  extension: ExtensionName;
  platform: Platform;
  /** Components a marker found in the file whose package does not list them. */
  missing: string[];
  /** `duckdb_` namespaces in the file that no component covers. */
  unknown: string[];
}

/** The ids of the components whose marker shows in `bytes`. */
export function componentsIn(bytes: Buffer): Set<string> {
  const text = bytes.toString("latin1");
  return new Set(COMPONENTS.filter((c) => c.marker?.test(text)).map((c) => c.id));
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
  return CORE_NAMESPACES.includes(namespace) || COMPONENTS.some((c) => c.marker?.test(namespace));
}

/** Check one file's bytes against the components its extension's package lists. */
export function checkBytes(bytes: Buffer, extension: ExtensionName, platform: Platform): Finding {
  const listed = new Set(componentsFor(extension).map((c) => c.id));
  return {
    extension, platform,
    missing: [...componentsIn(bytes)].filter((id) => !listed.has(id)).sort(),
    unknown: [...namespacesIn(bytes)].filter((n) => !covered(n)).sort(),
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
      if (f.missing.length || f.unknown.length) findings.push(f);
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
  ].filter(Boolean).join("; ")}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith("--"));
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

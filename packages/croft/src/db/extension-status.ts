// What croft validate, croft doctor and croft status say about the DuckDB extension files the project's modes need (DESIGN.md D195):
// for each mode, whether its files are on this machine and match the pins, and, when one is not, the command that fetches it. The
// same checks the mode makes when it starts (extension-files.ts), run ahead of it and on every extension rather than stopping at
// the first, so the project hears about it before `croft serve` has to fetch or fail.
//
// Nothing here opens DuckDB or touches the network (a missing file is reported, never fetched); it hashes at most the files a mode
// would load, once per process.
import { CroftError } from "../core/errors.ts";
import type { ExtensionFilesView, ExtensionView, Problem } from "../core/types.ts";
import { fetchCommand, hostPlatform, resolveExtensionDir, verifyExtension } from "./extension-files.ts";
import { type ExtensionName, type Platform } from "./extension-names.ts";
import { MODE_EXTENSIONS } from "./modes.ts";

/** The settings that load DuckDB extensions, each with the files its mode loads (MODE_EXTENSIONS, so the two cannot drift): server mode, and lake mode (a `lake` block). */
export const MODE_FILES = {
  server: { label: "server mode", extensions: MODE_EXTENSIONS.readers },
  lake: { label: "lake mode", extensions: MODE_EXTENSIONS.lake },
} as const satisfies Record<string, { label: string; extensions: readonly ExtensionName[] }>;

export type ModeName = keyof typeof MODE_FILES;

/** Every extension a mode can ask a user's machine for, in the order `croft fetch-extensions --all` fetches them. */
export const FETCHABLE: readonly ExtensionName[] = [...new Set(Object.values(MODE_FILES).flatMap((m) => m.extensions))];

/** The modes a project's settings turn on: server mode (`serverMode.enabled`) and lake mode (a `lake` block). Neither: none, and a project that names no mode loads nothing. */
export function modesNeeded(config: { serverMode: { enabled: boolean }; lake?: unknown }): ModeName[] {
  return [...(config.serverMode.enabled ? ["server" as const] : []), ...(config.lake ? ["lake" as const] : [])];
}

/** The extensions those modes load, once each. */
export function extensionsOfModes(modes: readonly ModeName[]): ExtensionName[] {
  return [...new Set(modes.flatMap((m) => MODE_FILES[m].extensions))];
}

/** Where the files are looked for; tests point it at a folder or an empty environment. */
export interface ExtensionSearch {
  /** A folder in DuckDB's layout; default resolveExtensionDir(env). */
  dir?: string;
  /** The environment ($CROFT_EXTENSION_DIR, $XDG_CACHE_HOME, $HOME); the process's by default. */
  env?: NodeJS.ProcessEnv;
}

/** The views, and one problem for each mode whose files are not whole (its details.mode names it). */
export interface ExtensionFilesReport { views: ExtensionFilesView[]; problems: Problem[] }

/**
 * Look for every extension of each mode, as the mode would, and report them. One problem per mode that is not whole: the first
 * failing extension's, with every failing extension named in its details, and the fetch command that covers them all as its fix.
 */
export function inspectExtensionFiles(modes: readonly ModeName[], s: ExtensionSearch = {}, platform: Platform | null = hostPlatform()): ExtensionFilesReport {
  const dir = s.dir ?? resolveExtensionDir(s.env ?? process.env);
  const views: ExtensionFilesView[] = [];
  const problems: Problem[] = [];
  for (const mode of modes) {
    const extensions: ExtensionView[] = [];
    const failures: CroftError[] = [];
    for (const name of MODE_FILES[mode].extensions) {
      try {
        extensions.push({ name, ok: true, path: verifyExtension(dir, name, platform), code: null });
      } catch (e) {
        if (!(e instanceof CroftError)) throw e;
        failures.push(e);
        extensions.push({ name, ok: false, path: null, code: e.code });
      }
    }
    const missing = extensions.filter((x) => !x.ok).map((x) => x.name);
    // The command is offered where it can help: not on a platform with no files.
    const fetch = platform && missing.length ? fetchCommand(missing) : null;
    views.push({ mode, label: MODE_FILES[mode].label, platform, ok: failures.length === 0, fetch, extensions });
    if (failures.length) {
      const first = failures[0]!.problem;
      problems.push({
        ...first,
        ...(fetch && first.fix?.kind === "command" ? { fix: { ...first.fix, command: fetch } } : {}),
        details: { ...first.details, mode, missing, ...(fetch ? { fetch } : {}) },
      });
    }
  }
  return { views, problems };
}

/** One line for a view, for doctor and status: what is found, or what to run. */
export function extensionFilesLine(v: ExtensionFilesView): string {
  if (v.ok) return `${v.label} extension files: ${v.extensions.map((x) => x.name).join(" and ")} found and match the pins`;
  if (!v.platform) return `${v.label} extension files: croft pins no extension files for this machine, so ${v.label} cannot run here`;
  const bad = v.extensions.filter((x) => !x.ok);
  const wrong = bad.some((x) => x.code === "EXTENSION_CHECKSUM_MISMATCH" || x.code === "EXTENSION_WRONG_BUILD");
  return `${v.label} extension files: ${wrong ? "a file is not the pinned one" : "not on this machine yet"}; ${v.fetch} (croft also fetches them the first time ${v.label} starts)`;
}

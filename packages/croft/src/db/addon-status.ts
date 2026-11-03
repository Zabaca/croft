// What croft validate, croft doctor and croft status say about the add-ons the project's modes need (DESIGN.md D134):
// for each, whether its extension files are found and match the pins, where they came from, and, when one is not there,
// the install command. The same checks the mode makes when it starts (extension-files.ts), run ahead of it and on every
// extension rather than stopping at the first, so the project hears about it before `croft serve` fails to start.
//
// Nothing here opens DuckDB or touches the network; it hashes at most the files a mode would load, once per process.
import { CroftError } from "../core/errors.ts";
import type { AddonView, ExtensionView, Problem } from "../core/types.ts";
import { ADDON_VERSION, ADDONS, type AddonName, addonPackage, extensionsOf, installCommand } from "./addons.ts";
import { type ExtensionName, type Platform } from "./extension-names.ts";
import { type ExtensionSearch, hostPlatform, verifyModeExtension } from "./extension-files.ts";

/** The views, and one problem for each add-on that is not whole (its details.addon names it). */
export interface AddonReport { views: AddonView[]; problems: Problem[] }

/** The add-ons a project's settings need: server mode needs the server add-on, lake mode (a `lake` block, shared or local) the lake
 *  add-on. Neither: none, and a project that names no mode installs and loads nothing. */
export function addonsNeeded(config: { serverMode: { enabled: boolean }; lake?: unknown }): AddonName[] {
  return [...(config.serverMode.enabled ? ["server" as const] : []), ...(config.lake ? ["lake" as const] : [])];
}

/**
 * Look for every extension of each add-on, as the mode would, and report them. One problem per add-on that is not whole:
 * the first extension's, with every failing extension named in its details, so the install command comes up once.
 */
export function inspectAddons(addons: readonly AddonName[], s: ExtensionSearch = {}, platform: Platform | null = hostPlatform()): AddonReport {
  const views: AddonView[] = [];
  const problems: Problem[] = [];
  for (const addon of addons) {
    const extensions: ExtensionView[] = [];
    const failures: CroftError[] = [];
    for (const name of extensionsOf(addon)) {
      try {
        const f = verifyModeExtension(name, addon, s, platform);
        extensions.push({ name, ok: true, source: f.source, path: f.path, code: null });
      } catch (e) {
        if (!(e instanceof CroftError)) throw e;
        failures.push(e);
        extensions.push({ name, ok: false, source: null, path: null, code: e.code });
      }
    }
    views.push({
      addon, mode: ADDONS[addon].mode, package: addonPackage(addon), version: ADDON_VERSION, platform,
      ok: failures.length === 0,
      // Installed: every file is there (a wrong one is there: that is another failure), or the add-on's own package was found and
      // a file for this machine did not come with it. Nothing is installed where files are missing and no package says otherwise:
      // an unpinned platform, an empty folder, a wrong file in the builders' cache, one file found alone that another add-on shares.
      // With every file found, the add-on is installed only when its own package supplied them: files from $CROFT_EXTENSION_DIR or the builders'
      // cache work, and that is not the add-on being installed (D164).
      installed: failures.length === 0 ? extensions.every((x) => x.source === "addon")
        : failures.some((f) => (f.problem.details as { installed?: boolean } | undefined)?.installed === true)
        || failures.every((f) => {
          const d = f.problem.details as { kind?: string; source?: string } | undefined;
          // A wrong file is there, but not in the builders' cache: that is not where a user installs an add-on.
          return ["checksum", "build"].includes(d?.kind ?? "") && d?.source !== "cache";
        }),
      // The command is offered where it can help: not on a platform with no files, and not while a folder is the only place looked.
      install: platform && !folderInForce(s) ? installCommand(addon, s.from) : null,
      extensions,
    });
    if (failures.length) {
      const first = failures[0]!.problem;
      problems.push({
        ...first,
        details: { ...first.details, addon, missing: extensions.filter((x) => !x.ok).map((x) => x.name) },
      });
    }
  }
  return { views, problems };
}

/** Whether a folder, named by the caller or $CROFT_EXTENSION_DIR, is the only place the files are looked for. */
function folderInForce(s: ExtensionSearch): boolean {
  return !!(s.dir ?? (s.env ?? process.env).CROFT_EXTENSION_DIR);
}

/** One line for a view, for doctor and status: what is found and where from, or what to run. */
export function addonLine(v: AddonView): string {
  if (v.ok) {
    const sources = [...new Set(v.extensions.map((x) => x.source === "addon" ? `${v.package}` : x.source === "dir" ? "$CROFT_EXTENSION_DIR" : "the builders' cache"))];
    // Files from a folder or the cache run the mode; the add-on's package is still not installed, and a machine without that folder needs it.
    const elsewhere = v.installed ? "" : `; the ${v.package} package is not installed in this project`;
    return `${v.mode} add-on: ${v.extensions.map((x) => x.name).join(" and ")} found (${sources.join(", ")}) and match the pins${elsewhere}`;
  }
  if (!v.platform) return `${v.mode} add-on: croft pins no extension files for this machine, so ${v.mode} cannot run here`;
  const bad = v.extensions.filter((x) => !x.ok);
  const wrong = bad.some((x) => x.code === "EXTENSION_CHECKSUM_MISMATCH" || x.code === "EXTENSION_WRONG_BUILD");
  const what = wrong ? "a file is not the pinned one" : v.installed ? "not whole" : "not installed";
  // With a folder in force the add-on is not looked for, so its command alone would change nothing.
  return `${v.mode} add-on: ${what}; ${v.install ?? "a folder is named ($CROFT_EXTENSION_DIR) and is the only place looked: fill it, or unset it and install the add-on"}`;
}

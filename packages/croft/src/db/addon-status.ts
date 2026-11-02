// What croft validate, croft doctor and croft status say about the add-ons the project's modes need (DESIGN.md D132):
// for each, whether its extension files are found and match the pins, where they came from, and, when one is not there,
// the install command. The same checks the mode makes when it starts (extension-files.ts), run ahead of it and on every
// extension rather than stopping at the first, so the project hears about it before `croft serve` fails to start.
//
// Nothing here opens DuckDB or touches the network; it hashes at most the files a mode would load, once per process.
import { CroftError } from "../core/errors.ts";
import type { AddonView, ExtensionView, Problem } from "../core/types.ts";
import { ADDON_VERSION, ADDONS, type AddonName, addonPackage, installCommand } from "./addons.ts";
import { type ExtensionName, type Platform } from "./extension-names.ts";
import { type ExtensionSearch, hostPlatform, verifyModeExtension } from "./extension-files.ts";

/** The views, and one problem for each add-on that is not whole (its details.addon names it). */
export interface AddonReport { views: AddonView[]; problems: Problem[] }

/** The add-ons a project's settings need: server mode needs the server add-on. Lake mode's setting adds its own line here when it exists. */
export function addonsNeeded(config: { serverMode: { enabled: boolean } }): AddonName[] {
  return config.serverMode.enabled ? ["server"] : [];
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
    for (const name of ADDONS[addon].extensions as readonly ExtensionName[]) {
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
      // Installed: every file was found (some of them wrong, which is another failure), or the add-on's own package was found
      // and a file for this machine did not come with it. A file found alone, from another add-on, does not make this one installed.
      installed: failures.every((f) => (f.problem.details as { kind?: string } | undefined)?.kind !== "addon")
        || failures.some((f) => (f.problem.details as { installed?: boolean } | undefined)?.installed === true),
      install: platform ? installCommand(addon, s.from) : null,
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

/** One line for a view, for doctor and status: what is found and where from, or what to run. */
export function addonLine(v: AddonView): string {
  if (v.ok) {
    const sources = [...new Set(v.extensions.map((x) => x.source === "addon" ? `${v.package}` : x.source === "dir" ? "$CROFT_EXTENSION_DIR" : "the builders' cache"))];
    return `${v.mode} add-on: ${v.extensions.map((x) => x.name).join(" and ")} found (${sources.join(", ")}) and match the pins`;
  }
  if (!v.platform) return `${v.mode} add-on: croft pins no extension files for this machine, so ${v.mode} cannot run here`;
  const bad = v.extensions.filter((x) => !x.ok);
  const wrong = bad.some((x) => x.code === "EXTENSION_CHECKSUM_MISMATCH" || x.code === "EXTENSION_WRONG_BUILD");
  return `${v.mode} add-on: ${wrong ? "a file is not the pinned one" : v.installed ? "not whole" : "not installed"}; ${v.install}`;
}

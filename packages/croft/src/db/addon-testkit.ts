// A project folder with an add-on "installed" in its node_modules, for tests (DESIGN.md D132). The extension files are symlinks to a
// folder of real ones (extension-dir-testkit.ts), so no test copies 100 MB; the packages are laid out as a package manager does,
// hoisted or in the isolated layout where the add-on's dependencies are not at the top of node_modules.
// Test support, left out of the published package (package.json "files").
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ADDON_VERSION, type AddonName, addonPackage, extensionPackage, extensionsOf, packagedFile } from "./addons.ts";
import { extensionPath, hostPlatform } from "./extension-files.ts";
import { type ExtensionName, type Platform } from "./extension-names.ts";

export interface FakeAddon {
  /** A folder of extension files in DuckDB's layout, whose files the packages link to; null makes stand-ins. */
  from: string | null;
  /** Which of the add-on's extensions get a package. Default: all of them. */
  only?: readonly ExtensionName[];
  /** The extension packages sit beside the add-on in node_modules (hoisted, the default) or in the add-on's own store (isolated). */
  layout?: "hoisted" | "isolated";
  /** Write the add-on package itself (default true); false leaves just the extension packages. */
  meta?: boolean;
  /** The platform the extension packages are for. Default: this machine's. */
  platform?: Platform;
  /** What a stand-in file holds when `from` is null. */
  content?: string;
}

/** Install `addon` into `root`'s node_modules. Returns the path of each extension file as the packages hold it. */
export function installFakeAddon(root: string, addon: AddonName, o: FakeAddon): Map<ExtensionName, string> {
  const platform = o.platform ?? hostPlatform();
  if (!platform) throw new Error("no pinned platform here");
  const layout = o.layout ?? "hoisted";
  const scope = join(root, "node_modules", "@zabaca");
  // Isolated: the add-on is a link to a folder of the store, and its extension packages are in that folder's own node_modules.
  const metaDir = layout === "isolated" ? join(root, "node_modules", ".store", `croft-addon-${addon}@${ADDON_VERSION}`, "node_modules", "@zabaca", `croft-addon-${addon}`) : join(scope, `croft-addon-${addon}`);
  const extRoot = layout === "isolated" ? join(dirname(metaDir)) : scope;
  const files = new Map<ExtensionName, string>();
  for (const name of o.only ?? extensionsOf(addon)) {
    const dir = join(extRoot, extensionPackage(name, platform).replace("@zabaca/", ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: extensionPackage(name, platform), version: ADDON_VERSION }));
    const file = join(dir, packagedFile(name));
    if (o.from) symlinkSync(extensionPath(o.from, name, platform), file);
    else writeFileSync(file, o.content ?? "x".repeat(600));
    files.set(name, file);
  }
  if (o.meta !== false) {
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "package.json"), JSON.stringify({ name: addonPackage(addon), version: ADDON_VERSION }));
    if (layout === "isolated") {
      mkdirSync(scope, { recursive: true });
      symlinkSync(metaDir, join(scope, `croft-addon-${addon}`));
    }
  }
  return files;
}

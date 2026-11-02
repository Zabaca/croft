// The add-on packages as files (DESIGN.md D132, D133): what each package.json says, which file each carries, and the checks that
// no file goes into a package unless it is the one croft pins. Pure planning plus a writer; scripts/build-addons.ts is the command,
// and tests/addons.test.ts drives it with small stand-in files.
//
// Nothing is committed: the packages are written from the pins (src/db/extension-pins.ts) and the version (src/db/addons.ts) each
// time, into a folder outside the workspaces, so they cannot drift from what croft checks.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADDON_NAMES, ADDON_VERSION, ADDONS, type AddonName, addonPackage, extensionPackage, PLATFORM_NPM, packagedFile, SHIPPED_EXTENSIONS,
} from "../src/db/addons.ts";
import { DUCKDB_VERSION, type ExtensionName, PLATFORMS, type Platform } from "../src/db/extension-names.ts";
import { extensionPath } from "../src/db/extension-files.ts";
import { EXTENSION_PINS } from "../src/db/extension-pins.ts";

/** One package to write. */
export interface PlannedPackage {
  name: string;
  version: string;
  kind: "extension" | "addon";
  /** The folder name under the output: the package's name without its scope. */
  folder: string;
  manifest: Record<string, unknown>;
  readme: string;
  /** An extension package carries one file. */
  file?: { extension: ExtensionName; platform: Platform; name: string };
}

const REPOSITORY = { type: "git", url: "git+https://github.com/Zabaca/croft.git", directory: "packages/croft" };

/** DuckDB's own license for its extensions (MIT, the same text in each extension's repository). */
export const LICENSE_TEXT = `Copyright 2018-2025 Stichting DuckDB Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

const folderOf = (name: string): string => name.replace(/^@[^/]+\//, "");

/** Every package, extension packages first and each add-on after the packages it depends on: the order to publish in. */
export function planPackages(): PlannedPackage[] {
  const out: PlannedPackage[] = [];
  for (const extension of SHIPPED_EXTENSIONS) {
    for (const platform of PLATFORMS) {
      const name = extensionPackage(extension, platform);
      const npm = PLATFORM_NPM[platform];
      const pin = EXTENSION_PINS[platform][extension];
      out.push({
        name, version: ADDON_VERSION, kind: "extension", folder: folderOf(name),
        file: { extension, platform, name: packagedFile(extension) },
        manifest: {
          name, version: ADDON_VERSION,
          description: `DuckDB ${DUCKDB_VERSION}'s ${extension} extension for ${platform}, for croft's modes. Not for direct use: install the add-on that needs it.`,
          license: "MIT", homepage: "https://croft.zabaca.com", repository: REPOSITORY,
          os: [npm.os], cpu: [npm.cpu], ...(npm.libc ? { libc: [npm.libc] } : {}),
          files: [packagedFile(extension), "LICENSE", "README.md"],
          publishConfig: { access: "public" },
          croft: { extension, platform, duckdb: DUCKDB_VERSION, sha256: pin.sha256, bytes: pin.bytes },
        },
        readme: extensionReadme(extension, platform),
      });
    }
  }
  for (const addon of ADDON_NAMES) {
    const name = addonPackage(addon);
    const extensions = ADDONS[addon].extensions as readonly ExtensionName[];
    const optionalDependencies: Record<string, string> = {};
    for (const extension of extensions) for (const platform of PLATFORMS) optionalDependencies[extensionPackage(extension, platform)] = ADDON_VERSION;
    out.push({
      name, version: ADDON_VERSION, kind: "addon", folder: folderOf(name),
      manifest: {
        name, version: ADDON_VERSION,
        description: `The DuckDB ${DUCKDB_VERSION} extension files croft's ${ADDONS[addon].mode} loads (${extensions.join(", ")}), for macOS and Linux (glibc) on x64 and arm64.`,
        license: "MIT", homepage: "https://croft.zabaca.com", repository: REPOSITORY,
        files: ["LICENSE", "README.md"],
        optionalDependencies,
        publishConfig: { access: "public" },
        croft: { addon, mode: ADDONS[addon].mode, extensions: [...extensions], duckdb: DUCKDB_VERSION },
      },
      readme: addonReadme(addon),
    });
  }
  return out;
}

function addonReadme(addon: AddonName): string {
  const { mode, extensions } = ADDONS[addon];
  return `# ${addonPackage(addon)}

The DuckDB ${DUCKDB_VERSION} extension files that [croft](https://croft.zabaca.com)'s ${mode} loads: ${(extensions as readonly string[]).join(", ")}.

Install it in a project that turns ${mode} on, next to \`@zabaca/croft\`:

    bun add ${addonPackage(addon)}@${ADDON_VERSION}

This package holds no code. Its optional dependencies are one extension package per platform
(macOS and Linux with glibc, x64 and arm64); your package manager installs only the one for your machine.
croft finds the file in your project's \`node_modules\`, checks it against the checksum it pins, and loads it
by path. A project that does not turn ${mode} on does not need this package, and croft itself never
downloads an extension. \`croft doctor\` and \`croft validate\` say whether the files are found.

The extensions are built and signed by the DuckDB project (MIT license, see LICENSE).
`;
}

function extensionReadme(extension: ExtensionName, platform: Platform): string {
  return `# ${extensionPackage(extension, platform)}

DuckDB ${DUCKDB_VERSION}'s \`${extension}\` extension for ${platform}, as published by the DuckDB project, unchanged.
croft checks its sha256 against the one it pins before loading it. You do not install this package yourself:
it is an optional dependency of the add-on that needs it (${ADDON_NAMES.filter((a) => (ADDONS[a].extensions as readonly string[]).includes(extension)).map(addonPackage).join(", ")}).
See https://croft.zabaca.com.
`;
}

/** The folder a package is written to. */
export const packageDir = (out: string, p: PlannedPackage): string => join(out, p.folder);

/** Check a file is the pinned one: its size and sha256. Throws with what differs; nothing unpinned goes into a package. */
export function assertPinned(path: string, extension: ExtensionName, platform: Platform): void {
  const pin = EXTENSION_PINS[platform][extension];
  const size = statSync(path).size;
  if (size !== pin.bytes) throw new Error(`${path} is ${size} bytes; croft pins ${pin.bytes} for ${extension} on ${platform}`);
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (sha !== pin.sha256) throw new Error(`${path} has sha256 ${sha}; croft pins ${pin.sha256} for ${extension} on ${platform}`);
}

/** The packed packages whose tarball is over the limit. The limit is ours, far below what npm has been seen to take (D133). */
export function oversize<T extends { packedBytes: number }>(packed: readonly T[], maxBytes: number): T[] {
  return packed.filter((p) => p.packedBytes > maxBytes);
}

export interface WriteOptions {
  /** A folder of extension files in DuckDB's layout (extensionPath), which scripts/fetch-extensions.ts fills. */
  source: string;
  /** Check each file against the pin before it is copied (always, except in tests that use stand-in files). Default true. */
  verify?: boolean;
}

/** Write every package under `out`, copying each extension file from `source`. Returns the plan. */
export function writePackages(out: string, o: WriteOptions): PlannedPackage[] {
  const plan = planPackages();
  for (const p of plan) {
    const dir = packageDir(out, p);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(p.manifest, null, 2)}\n`);
    writeFileSync(join(dir, "README.md"), p.readme);
    writeFileSync(join(dir, "LICENSE"), LICENSE_TEXT);
    if (p.file) {
      const from = extensionPath(o.source, p.file.extension, p.file.platform);
      if (!existsSync(from)) {
        throw new Error(`${from} is missing; fill the folder with: bun scripts/fetch-extensions.ts "${o.source}" --all-platforms --only ${SHIPPED_EXTENSIONS.join(",")}`);
      }
      if (o.verify !== false) assertPinned(from, p.file.extension, p.file.platform);
      copyFileSync(from, join(dir, p.file.name));
    }
  }
  return plan;
}

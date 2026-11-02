// The add-on packages that carry DuckDB's extension files to the projects that turn a mode on (DESIGN.md D132, D133;
// option 06, slice 5, decision a). Plain croft ships none of them and never downloads code: a project that turns server
// mode on installs the server add-on with its own package manager, and croft finds the files in the project's
// node_modules and checks each against the checksum it pins (extension-files.ts) before it loads one.
//
// Two layers, so a user installs one name and npm sends only the files for the machine:
//   - an add-on per mode (`@zabaca/croft-addon-server`, `@zabaca/croft-addon-lake`): no files of its own, optional
//     dependencies on the extension packages its mode loads, for every platform;
//   - an extension package per extension and platform (`@zabaca/croft-ext-quack-darwin-arm64`): one file, and the
//     `os` and `cpu` that make npm and Bun skip it everywhere else.
// scripts/build-addons.ts writes and packs them from the pins; nothing here is generated.
import type { ExtensionName, Platform } from "./extension-names.ts";
import { EXTENSIONS } from "./extension-names.ts";
import type { ModeKind } from "./modes.ts";

/** The version every add-on package carries. One line for all of them: the add-on and every extension package publish
 *  together, and a change to the files they hold (a new DuckDB version, a new pin) is a new major. croft's own version
 *  is independent of it. */
export const ADDON_VERSION = "1.0.0";

/** The mode each add-on is for, and the extensions it carries, in load order. */
export const ADDONS = {
  server: { mode: "server mode", extensions: ["httpfs", "quack"] },
  lake: { mode: "lake mode", extensions: ["httpfs", "postgres", "ducklake"] },
} as const satisfies Record<string, { mode: string; extensions: readonly ExtensionName[] }>;

export type AddonName = keyof typeof ADDONS;
export const ADDON_NAMES = Object.keys(ADDONS) as AddonName[];
/** The extensions an add-on carries, in load order. */
export const extensionsOf = (a: AddonName): readonly ExtensionName[] => ADDONS[a].extensions;

/** The add-ons a mode's extensions come from. The lake test mode loads sqlite, which only croft's own suite needs, from a folder. */
export const MODE_ADDONS: Readonly<Record<ModeKind, readonly AddonName[]>> = {
  readers: ["server"],
  lake: ["lake"],
  "lake-readers": ["server", "lake"],
  "lake-test": [],
};

/** The npm names for each platform: the `os`, `cpu` and, on Linux, `libc` fields that make a package install only where it runs. */
export const PLATFORM_NPM: Readonly<Record<Platform, { slug: string; os: "darwin" | "linux"; cpu: "arm64" | "x64"; libc?: "glibc" }>> = {
  osx_arm64: { slug: "darwin-arm64", os: "darwin", cpu: "arm64" },
  osx_amd64: { slug: "darwin-x64", os: "darwin", cpu: "x64" },
  linux_amd64: { slug: "linux-x64", os: "linux", cpu: "x64", libc: "glibc" },
  linux_arm64: { slug: "linux-arm64", os: "linux", cpu: "arm64", libc: "glibc" },
};

/** The extensions that ship in an add-on at all: sqlite is the lake's test suite only and is not published. */
export const SHIPPED_EXTENSIONS: readonly ExtensionName[] = [...new Set(ADDON_NAMES.flatMap(extensionsOf))];

export const addonPackage = (a: AddonName): string => `@zabaca/croft-addon-${a}`;
export const extensionPackage = (name: ExtensionName, platform: Platform): string => `@zabaca/croft-ext-${name}-${PLATFORM_NPM[platform].slug}`;
/** The file's name inside its extension package: the repository's own, at the package's top. */
export const packagedFile = (name: ExtensionName): string => `${EXTENSIONS[name]}.duckdb_extension`;

/** The add-on a mode's extension comes from (the first of the mode's add-ons that carries it), or null for one no add-on carries. */
export function addonFor(kind: ModeKind, name: ExtensionName): AddonName | null {
  return MODE_ADDONS[kind].find((a) => extensionsOf(a).includes(name)) ?? null;
}

/** The command that installs an add-on into a project, as an agent can run it. */
export function installCommand(a: AddonName, root: string | undefined): string {
  const add = `bun add ${addonPackage(a)}@${ADDON_VERSION}`;
  return root ? `cd ${shellWord(root)} && ${add}` : add;
}

function shellWord(s: string): string {
  return /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

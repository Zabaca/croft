// The add-on packages as built (DESIGN.md D132, D133; option 06, slice 5): scripts/addon-packages.ts writes them from the pins, with
// stand-in files here (the real ones are over 100 MB per platform) and `verify: false`; the check that only a pinned file goes in is
// tested on its own. `npm pack --dry-run` says what each tarball would hold, skipped where npm is not installed.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ADDON_VERSION, ADDONS, addonPackage, extensionPackage, PLATFORM_NPM, SHIPPED_EXTENSIONS } from "../src/db/addons.ts";
import { extensionPath } from "../src/db/extension-files.ts";
import { DUCKDB_VERSION, type ExtensionName, PLATFORMS } from "../src/db/extension-names.ts";
import { EXTENSION_PINS } from "../src/db/extension-pins.ts";
import { assertPinned, oversize, packageDir, planPackages, writePackages } from "../scripts/addon-packages.ts";

const PKG = resolve(import.meta.dir, "..");
const NPM = Bun.which("npm");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function folder(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `croft-${prefix}-`)));
  made.push(d);
  return d;
}

/** A folder of stand-in extension files in DuckDB's layout, one per shipped extension and platform. */
function standIns(): string {
  const dir = folder("standins");
  for (const platform of PLATFORMS) {
    for (const name of SHIPPED_EXTENSIONS) {
      const file = extensionPath(dir, name, platform);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `stand-in ${name} ${platform}`);
    }
  }
  return dir;
}

describe("the plan", () => {
  const plan = planPackages();
  const byName = new Map(plan.map((p) => [p.name, p]));

  test("sixteen extension packages and two add-ons, extension packages first so an add-on publishes after what it depends on", () => {
    expect(plan).toHaveLength(18);
    expect(plan.filter((p) => p.kind === "extension")).toHaveLength(16);
    expect(plan.slice(0, 16).every((p) => p.kind === "extension")).toBe(true);
    expect(plan.slice(16).map((p) => p.name).sort()).toEqual(["@zabaca/croft-addon-lake", "@zabaca/croft-addon-server"]);
    expect(new Set(plan.map((p) => p.name)).size).toBe(18);
    expect(new Set(plan.map((p) => p.folder)).size).toBe(18);
  });

  test("an extension package is one file for one platform, with the os, cpu and (on Linux) libc that keep npm and Bun from installing it elsewhere", () => {
    for (const extension of SHIPPED_EXTENSIONS) {
      for (const platform of PLATFORMS) {
        const p = byName.get(extensionPackage(extension, platform))!;
        const m = p.manifest as Record<string, any>;
        const npm = PLATFORM_NPM[platform];
        expect(m.version).toBe(ADDON_VERSION);
        expect(m.os).toEqual([npm.os]);
        expect(m.cpu).toEqual([npm.cpu]);
        expect(m.libc).toEqual(npm.libc ? [npm.libc] : undefined);
        expect(m.license).toBe("MIT");
        expect(m.files).toEqual([`${extension === "postgres" ? "postgres_scanner" : extension}.duckdb_extension`, "LICENSE", "README.md"]);
        // The pin it carries is the one croft checks.
        expect(m.croft).toEqual({ extension, platform, duckdb: DUCKDB_VERSION, sha256: EXTENSION_PINS[platform][extension].sha256, bytes: EXTENSION_PINS[platform][extension].bytes });
        expect(m.dependencies).toBeUndefined();
        expect(m.scripts, "no install script: the package runs nothing").toBeUndefined();
      }
    }
  });

  test("an add-on holds no file and no code: optional dependencies on exactly the extension packages its mode loads, at its own version", () => {
    for (const addon of ["server", "lake"] as const) {
      const m = byName.get(addonPackage(addon))!.manifest as Record<string, any>;
      const expected = (ADDONS[addon].extensions as readonly ExtensionName[]).flatMap((e) => PLATFORMS.map((p) => extensionPackage(e, p))).sort();
      expect(Object.keys(m.optionalDependencies).sort()).toEqual(expected);
      expect(Object.values(m.optionalDependencies).every((v) => v === ADDON_VERSION)).toBe(true);
      expect(m.dependencies).toBeUndefined();
      expect(m.scripts).toBeUndefined();
      expect(m.bin).toBeUndefined();
      expect(m.files).toEqual(["LICENSE", "README.md"]);
      expect(m.os).toBeUndefined();
    }
    expect(Object.keys((byName.get(addonPackage("server"))!.manifest as any).optionalDependencies)).toHaveLength(8);
    expect(Object.keys((byName.get(addonPackage("lake"))!.manifest as any).optionalDependencies)).toHaveLength(12);
  });

  test("sqlite, which only croft's own suite uses, is in no package", () => {
    expect(plan.some((p) => p.name.includes("sqlite"))).toBe(false);
  });

  test("every package says the install command and does not claim to be anything it is not", () => {
    for (const p of plan) {
      expect(p.readme.length).toBeGreaterThan(100);
      expect(p.readme).not.toContain("\u2014");
      expect(JSON.stringify(p.manifest)).not.toContain("\u2014");
    }
    expect(byName.get(addonPackage("server"))!.readme).toContain(`bun add @zabaca/croft-addon-server@${ADDON_VERSION}`);
  });
});

describe("writing the packages", () => {
  test("writes each package's folder with its manifest, readme, license and (an extension package) its one file, copied from the source", () => {
    const out = folder("addons-out");
    const plan = writePackages(out, { source: standIns(), verify: false });
    const server = plan.find((p) => p.name === "@zabaca/croft-addon-server")!;
    expect(JSON.parse(readFileSync(join(packageDir(out, server), "package.json"), "utf8")).name).toBe("@zabaca/croft-addon-server");
    const ext = plan.find((p) => p.name === extensionPackage("quack", "osx_arm64"))!;
    expect(readFileSync(join(packageDir(out, ext), "quack.duckdb_extension"), "utf8")).toBe("stand-in quack osx_arm64");
    expect(readFileSync(join(packageDir(out, ext), "LICENSE"), "utf8")).toContain("Stichting DuckDB Foundation");
    expect(readFileSync(join(packageDir(out, ext), "package.json"), "utf8").endsWith("\n")).toBe(true);
  });

  test("a missing source file stops the build and says how to fill the folder", () => {
    const source = standIns();
    rmSync(extensionPath(source, "quack", "linux_arm64"));
    expect(() => writePackages(folder("addons-out"), { source, verify: false })).toThrow(/linux_arm64.*quack.*fetch-extensions\.ts.*--all-platforms/s);
  });

  test("a file that is not the pinned one never goes into a package", () => {
    expect(() => writePackages(folder("addons-out"), { source: standIns() })).toThrow(/croft pins/);
    const file = join(folder("one"), "quack.duckdb_extension");
    writeFileSync(file, "x".repeat(EXTENSION_PINS.osx_arm64.quack.bytes));
    expect(() => assertPinned(file, "quack", "osx_arm64")).toThrow(/has sha256/);
    writeFileSync(file, "short");
    expect(() => assertPinned(file, "quack", "osx_arm64")).toThrow(/is 5 bytes; croft pins/);
  });

  test("a tarball over the limit is reported by name", () => {
    const packed = [{ name: "a", packedBytes: 10_000_000 }, { name: "b", packedBytes: 60_000_000 }];
    expect(oversize(packed, 50_000_000).map((p) => p.name)).toEqual(["b"]);
    expect(oversize(packed, 100_000_000)).toEqual([]);
  });

  test.skipIf(!NPM)("npm pack takes each tarball's files from the manifest: the extension file, the license, the readme and the manifest, nothing else", () => {
    const out = folder("addons-out");
    const plan = writePackages(out, { source: standIns(), verify: false });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? out, npm_config_cache: join(out, ".npm"), npm_config_update_notifier: "false" };
    for (const name of [extensionPackage("quack", "linux_amd64"), extensionPackage("postgres", "osx_arm64"), addonPackage("server"), addonPackage("lake")]) {
      const p = plan.find((x) => x.name === name)!;
      const r = spawnSync(NPM!, ["pack", "--dry-run", "--json"], { cwd: packageDir(out, p), encoding: "utf8", env, timeout: 60_000 });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      const files = (JSON.parse(r.stdout) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path).sort();
      const file = p.file ? [`${p.file.extension === "postgres" ? "postgres_scanner" : p.file.extension}.duckdb_extension`] : [];
      expect(files, name).toEqual([...file, "LICENSE", "README.md", "package.json"].sort());
    }
  }, 120_000);
});

describe("plain croft", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as Record<string, any>;

  test("depends on no add-on and no extension package: a default install is the same size as before", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["@duckdb/node-api"]);
    for (const k of ["optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) expect(pkg[k], k).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain("croft-addon");
    expect(JSON.stringify(pkg)).not.toContain("croft-ext");
  });

  test("ships none of the build scripts for the add-ons, and the one workflow that publishes them is a separate file", () => {
    expect(pkg.files).not.toContain("scripts");
    expect(pkg.files.some((f: string) => f.includes("addon"))).toBe(false);
  });
});

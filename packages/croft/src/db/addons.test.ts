// How a user gets the extension files (DESIGN.md D134; option 06, slice 5, decision a): the add-on packages in the project's
// node_modules, found and checked against the pins. Plain croft downloads nothing and a mode that finds no add-on says which
// command installs it. Most tests use stand-in packages (a wrong file under the right name); the ones that need DuckDB's
// real files link them in (extension-dir-testkit.ts) and skip locally, or fail in CI, when they are not there.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { inspectAddons, addonLine, addonsNeeded } from "./addon-status.ts";
import { installFakeAddon } from "./addon-testkit.ts";
import {
  ADDON_NAMES, ADDON_VERSION, ADDONS, addonFor, addonPackage, extensionPackage, extensionsOf, installCommand, MODE_ADDONS, PLATFORM_NPM, SHIPPED_EXTENSIONS,
} from "./addons.ts";
import { extensionsReady } from "./extension-dir-testkit.ts";
import { extensionPath, hostPlatform, verifyModeExtension, verifyModeExtensions } from "./extension-files.ts";
import { DUCKDB_VERSION, type ExtensionName, PLATFORMS } from "./extension-names.ts";
import { MODE_EXTENSIONS, type ModeKind } from "./modes.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function folder(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `croft-${prefix}-`)));
  made.push(d);
  return d;
}
/** A project folder, and an environment that knows no extension folder and has an empty cache. */
function fresh() {
  const root = folder("addon-project");
  const env = { XDG_CACHE_HOME: folder("addon-cache"), HOME: folder("addon-home") };
  // Nothing above the project or inside it is searched but what the test puts there.
  return { root, env, search: { from: root, env, croftRoot: folder("addon-croft") } };
}
function caught(fn: () => unknown): CroftError {
  try {
    fn();
  } catch (e) {
    return e as CroftError;
  }
  throw new Error("expected a refusal");
}

const platform = hostPlatform();
const here = platform ? test : test.skip;

describe("what the add-ons are", () => {
  test("every extension a mode loads comes from an add-on, except sqlite, which a local lake loads from a folder", () => {
    expect(MODE_ADDONS["lake-local"]).toEqual(["lake"]);
    for (const kind of Object.keys(MODE_EXTENSIONS) as ModeKind[]) {
      for (const name of MODE_EXTENSIONS[kind]) {
        if (name === "sqlite") expect(addonFor(kind, name), `${kind}/${name}`).toBeNull();
        else expect(addonFor(kind, name), `${kind}/${name}`).not.toBeNull();
      }
      // A mode's add-ons carry no extension the mode does not load, so installing one never installs a file the mode ignores.
      // A local lake is the one exception: it is lake mode with a SQLite catalog and a local folder, so it loads ducklake from the
      // lake add-on and needs neither httpfs nor postgres, but the add-on is the one install lake mode asks for.
      if (kind === "lake-local") continue;
      const carried = new Set(MODE_ADDONS[kind].flatMap(extensionsOf));
      for (const name of carried) expect(MODE_EXTENSIONS[kind], `${kind} carries ${name}`).toContain(name);
    }
  });

  test("server mode's add-on is quack and httpfs; lake mode's is ducklake, httpfs and postgres; sqlite ships in neither", () => {
    expect([...ADDONS.server.extensions].sort()).toEqual(["httpfs", "quack"]);
    expect([...ADDONS.lake.extensions].sort()).toEqual(["ducklake", "httpfs", "postgres"]);
    expect([...SHIPPED_EXTENSIONS].sort()).toEqual(["ducklake", "httpfs", "postgres", "quack"]);
    expect(ADDON_NAMES.sort()).toEqual(["lake", "server"]);
  });

  test("every platform croft pins has an npm os and cpu, Linux with glibc only, and the package names are unique", () => {
    expect(Object.keys(PLATFORM_NPM).sort()).toEqual([...PLATFORMS].sort());
    for (const p of PLATFORMS) {
      expect(PLATFORM_NPM[p].libc === "glibc", p).toBe(PLATFORM_NPM[p].os === "linux");
      expect(PLATFORM_NPM[p].os === "darwin" || PLATFORM_NPM[p].os === "linux").toBe(true);
    }
    const names = SHIPPED_EXTENSIONS.flatMap((e) => PLATFORMS.map((p) => extensionPackage(e, p)));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(16);
    expect(extensionPackage("quack", "osx_arm64")).toBe("@zabaca/croft-ext-quack-darwin-arm64");
    expect(extensionPackage("postgres", "linux_amd64")).toBe("@zabaca/croft-ext-postgres-linux-x64");
    expect(addonPackage("server")).toBe("@zabaca/croft-addon-server");
  });

  test("the install command names the exact version, in the project's folder", () => {
    expect(ADDON_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installCommand("server", undefined)).toBe(`bun add @zabaca/croft-addon-server@${ADDON_VERSION}`);
    expect(installCommand("lake", "/work/my app")).toBe(`cd '/work/my app' && bun add @zabaca/croft-addon-lake@${ADDON_VERSION}`);
    expect(installCommand("lake", "/work/app")).toBe(`cd /work/app && bun add @zabaca/croft-addon-lake@${ADDON_VERSION}`);
  });

  test("only server mode's setting turns an add-on on so far", () => {
    expect(addonsNeeded({ serverMode: { enabled: true } })).toEqual(["server"]);
    expect(addonsNeeded({ serverMode: { enabled: false } })).toEqual([]);
  });
});

describe("a mode whose add-on is not installed", () => {
  here("server mode: EXTENSION_MISSING says the add-on and the command that installs it (a fix an agent can run)", () => {
    const { search, root } = fresh();
    const e = caught(() => verifyModeExtension("quack", "server", search));
    expect(e.code).toBe("EXTENSION_MISSING");
    expect(e.message).toContain("server mode is on, but its add-on is not installed");
    expect(e.problem.fix).toMatchObject({ kind: "command", command: `cd ${root} && bun add @zabaca/croft-addon-server@${ADDON_VERSION}` });
    expect(e.problem.fix && "requiresHuman" in e.problem.fix ? e.problem.fix.requiresHuman : false).toBeFalsy();
    expect(e.problem.hint).toContain("bun add @zabaca/croft-addon-server");
    expect(e.problem.retryable).toBe(false);
    expect(e.problem.details).toMatchObject({
      kind: "addon", addon: "server", package: "@zabaca/croft-addon-server", version: ADDON_VERSION, extension: "quack",
      extensionPackage: extensionPackage("quack", platform!), platform, installed: false,
    });
  });

  here("lake mode: the same, naming the lake add-on", () => {
    const { search } = fresh();
    for (const name of ["ducklake", "postgres", "httpfs"] as const) {
      const e = caught(() => verifyModeExtension(name, "lake", search));
      expect(e.code, name).toBe("EXTENSION_MISSING");
      expect(e.message, name).toContain("lake mode is on, but its add-on is not installed");
      expect(e.problem.fix, name).toMatchObject({ kind: "command" });
      expect((e.problem.fix as { command: string }).command, name).toContain("bun add @zabaca/croft-addon-lake@");
      expect(e.problem.details, name).toMatchObject({ kind: "addon", addon: "lake" });
    }
  });

  here("a mode loading several extensions checks them all first and names the first one missing", () => {
    const { search } = fresh();
    const e = caught(() => verifyModeExtensions(["httpfs", "quack"], () => "server", search));
    expect(e.problem.details).toMatchObject({ extension: "httpfs" });
  });

  here("the add-on is installed but its file for this machine did not arrive: it says so, and the install again", () => {
    const { search, root } = fresh();
    installFakeAddon(root, "server", { from: null, only: [] });
    const e = caught(() => verifyModeExtension("quack", "server", search));
    expect(e.code).toBe("EXTENSION_MISSING");
    expect(e.message).toContain("add-on is installed, but its quack file");
    expect(e.problem.details).toMatchObject({ installed: true });
    expect(e.problem.hint).toContain("install the server add-on again");
  });

  test("an unpinned platform (musl, Windows) is EXTENSION_MISSING with kind platform, whatever is installed, and no install is offered", () => {
    const { search, root } = fresh();
    installFakeAddon(root, "server", { from: null, platform: "linux_amd64" });
    const e = caught(() => verifyModeExtension("quack", "server", search, null));
    expect(e.code).toBe("EXTENSION_MISSING");
    expect(e.problem.details).toMatchObject({ kind: "platform" });
    expect(e.problem.fix?.kind).toBe("manual");
    const report = inspectAddons(["server"], search, null);
    expect(report.views[0]).toMatchObject({ ok: false, platform: null, install: null, installed: false });
    expect(addonLine(report.views[0]!)).toContain("cannot run here");
  });
});

describe("what is installed and what to run", () => {
  here("an empty $CROFT_EXTENSION_DIR installs nothing and offers no command, since the add-on is not looked for while a folder is named", () => {
    const { search, env } = fresh();
    const empty = folder("addon-dir");
    const report = inspectAddons(["server"], { ...search, env: { ...env, CROFT_EXTENSION_DIR: empty } });
    expect(report.views[0]).toMatchObject({ ok: false, installed: false, install: null });
    expect(report.problems[0]).toMatchObject({ code: "EXTENSION_MISSING", details: { kind: "file" } });
    expect(addonLine(report.views[0]!)).toContain("fill it, or unset it and install the add-on");
  });

  here("with nothing anywhere it is not installed, and the command is offered", () => {
    const { search } = fresh();
    const report = inspectAddons(["server"], search);
    expect(report.views[0]).toMatchObject({ ok: false, installed: false });
    expect(report.views[0]!.install).toContain("bun add @zabaca/croft-addon-server@");
  });

  here("a wrong file in the add-on counts as installed (it is there), and the add-on's package without our file counts as installed too", () => {
    const wrong = fresh();
    installFakeAddon(wrong.root, "server", { from: null });
    expect(inspectAddons(["server"], wrong.search).views[0]).toMatchObject({ ok: false, installed: true });
    const bare = fresh();
    installFakeAddon(bare.root, "server", { from: null, only: [] });
    expect(inspectAddons(["server"], bare.search).views[0]).toMatchObject({ ok: false, installed: true });
  });

  here("one file found alone, which another add-on shares, does not make this add-on installed", () => {
    const ready = extensionsReady(["httpfs"]);
    if (!ready.ready) return;
    const { search, root } = fresh();
    installFakeAddon(root, "server", { from: ready.dir, only: ["httpfs"], meta: false });
    const view = inspectAddons(["lake"], search).views[0]!;
    expect(view).toMatchObject({ ok: false, installed: false });
    expect(view.extensions.map((x) => [x.name, x.ok])).toEqual([["httpfs", true], ["postgres", false], ["ducklake", false]]);
  });

  here("a stale wrong file in the builders' cache does not hide the install: with no add-on the fix is the add-on's command, not a repo script", () => {
    const { search, env } = fresh();
    const cache = join(env.XDG_CACHE_HOME, "croft", "test-extensions");
    mkdirSync(join(cache, `v${DUCKDB_VERSION}`, platform!), { recursive: true });
    writeFileSync(extensionPath(cache, "httpfs", platform!), "x".repeat(600));
    const e = caught(() => verifyModeExtension("httpfs", "server", search));
    expect(e.code).toBe("EXTENSION_CHECKSUM_MISMATCH");
    expect(e.problem.details).toMatchObject({ source: "cache" });
    expect(e.problem.fix).toMatchObject({ kind: "command", command: expect.stringContaining("bun add @zabaca/croft-addon-server@") });
    expect(e.problem.hint).toContain("builders' cache");
    // And the report says the add-on is not installed, and offers its command.
    const view = inspectAddons(["server"], search).views[0]!;
    expect(view).toMatchObject({ ok: false, installed: false });
    expect(view.install).toContain("bun add @zabaca/croft-addon-server@");
    expect(e.problem.hint).toContain("bun add @zabaca/croft-addon-server@");
    // A mode with no add-on (the lake test mode's sqlite) can only be told to fill the folder.
    const lone = caught(() => verifyModeExtension("sqlite", null, { ...search, env: { ...env } }));
    expect(lone.code).toBe("EXTENSION_MISSING");
  });
});

describe("a file in an add-on that is not the pinned one", () => {
  here("is refused by its checksum, and the fix is to reinstall the add-on", () => {
    const { search, root } = fresh();
    const files = installFakeAddon(root, "server", { from: null, content: "not an extension".repeat(50) });
    const e = caught(() => verifyModeExtension("httpfs", "server", search));
    expect(e.code).toBe("EXTENSION_CHECKSUM_MISMATCH");
    expect(e.message).toContain(files.get("httpfs")!);
    expect(e.problem.details).toMatchObject({ kind: "checksum", source: "addon" });
    expect(e.problem.fix).toMatchObject({ kind: "command", command: `cd ${root} && bun add @zabaca/croft-addon-server@${ADDON_VERSION}` });
    expect(e.problem.hint).toContain("reinstall the add-on");
  });

  here("one tampered byte in a file of the right size is refused too", () => {
    const ready = extensionsReady(["httpfs"]);
    if (!ready.ready) return;
    const { search, root } = fresh();
    const files = installFakeAddon(root, "server", { from: ready.dir, only: ["httpfs"] });
    // The package holds a copy with one byte changed in place of the link.
    const bytes = readFileSync(extensionPath(ready.dir, "httpfs", platform!));
    const copy = Buffer.from(bytes);
    copy[1000] = copy[1000]! ^ 0xff;
    rmSync(files.get("httpfs")!);
    writeFileSync(files.get("httpfs")!, copy);
    const e = caught(() => verifyModeExtension("httpfs", "server", search));
    expect(e.code).toBe("EXTENSION_CHECKSUM_MISMATCH");
    expect(e.problem.details).toMatchObject({ bytes: bytes.length, expectedBytes: bytes.length, source: "addon" });
  }, 60_000);
});

describe("finding the real files", () => {
  const ready = extensionsReady(["quack", "httpfs", "ducklake", "postgres"]);
  const real = ready.ready ? test : test.skip;
  if (!ready.ready) console.warn(`[addons.test] SKIPPING the checks on real files: ${ready.skipReason}`);

  real("hoisted: both files of the server add-on are found in the project's node_modules, checked and reported as from the add-on", () => {
    const { search, root } = fresh();
    const files = installFakeAddon(root, "server", { from: ready.dir });
    const found = verifyModeExtensions(["httpfs", "quack"], () => "server", search);
    expect([...found.values()]).toEqual([files.get("httpfs")!, files.get("quack")!]);
    expect(verifyModeExtension("quack", "server", search).source).toBe("addon");
    const report = inspectAddons(["server"], search);
    expect(report.problems).toEqual([]);
    expect(report.views[0]).toMatchObject({ addon: "server", ok: true, installed: true, platform, package: "@zabaca/croft-addon-server", version: ADDON_VERSION });
    expect(report.views[0]!.extensions.map((x) => [x.name, x.source])).toEqual([["httpfs", "addon"], ["quack", "addon"]]);
    expect(addonLine(report.views[0]!)).toContain("found (@zabaca/croft-addon-server) and match the pins");
  });

  real("isolated: the add-on's own files are found through the add-on, though its dependencies are not at the top of node_modules", () => {
    const { search, root } = fresh();
    const files = installFakeAddon(root, "server", { from: ready.dir, layout: "isolated" });
    const found = verifyModeExtensions(["httpfs", "quack"], () => "server", search);
    expect([...found.values()].map((p) => realpathSync(p))).toEqual([...files.values()].map((p) => realpathSync(p)));
  });

  real("the lake add-on's three files are found the same way", () => {
    const { search, root } = fresh();
    installFakeAddon(root, "lake", { from: ready.dir });
    const found = verifyModeExtensions(MODE_EXTENSIONS.lake, (n) => addonFor("lake", n), search);
    expect([...found.keys()]).toEqual(["httpfs", "postgres", "ducklake"]);
    expect(inspectAddons(["lake"], search).problems).toEqual([]);
  });

  real("an add-on holding only some of its files is not whole: the report names what is missing", () => {
    const { search, root } = fresh();
    installFakeAddon(root, "server", { from: ready.dir, only: ["httpfs"] });
    const report = inspectAddons(["server"], search);
    expect(report.views[0]).toMatchObject({ ok: false, installed: true });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ code: "EXTENSION_MISSING", details: { addon: "server", missing: ["quack"] } });
    expect(addonLine(report.views[0]!)).toContain("not whole");
  });

  real("the order is: a folder the caller names, then $CROFT_EXTENSION_DIR, then the add-on, then the builders' cache", () => {
    const { search, root, env } = fresh();
    installFakeAddon(root, "server", { from: ready.dir, only: ["httpfs"] });
    // The builders' cache holds a wrong file; the add-on is looked in first, so it is never read.
    const cache = join(env.XDG_CACHE_HOME, "croft", "test-extensions");
    mkdirSync(join(cache, `v${DUCKDB_VERSION}`, platform!), { recursive: true });
    writeFileSync(extensionPath(cache, "httpfs", platform!), "x".repeat(600));
    expect(verifyModeExtension("httpfs", "server", search).source).toBe("addon");
    // With no add-on the cache is used, and checked like anything else.
    const none = fresh();
    const cached = join(none.env.XDG_CACHE_HOME, "croft", "test-extensions");
    mkdirSync(join(cached, `v${DUCKDB_VERSION}`, platform!), { recursive: true });
    writeFileSync(extensionPath(cached, "httpfs", platform!), "x".repeat(600));
    expect(caught(() => verifyModeExtension("httpfs", "server", none.search)).problem.details).toMatchObject({ source: "cache" });
    // $CROFT_EXTENSION_DIR is the only place looked when it is set, though the add-on is there.
    const empty = folder("addon-dir");
    const viaEnv = caught(() => verifyModeExtension("httpfs", "server", { ...search, env: { ...env, CROFT_EXTENSION_DIR: empty } }));
    expect(viaEnv.problem.details).toMatchObject({ kind: "file", path: extensionPath(empty, "httpfs", platform!) });
    expect(viaEnv.problem.hint).toContain("unset $CROFT_EXTENSION_DIR and install the server add-on");
    // A folder the caller names beats the environment.
    const found = verifyModeExtension("httpfs", "server", { ...search, dir: ready.dir, env: { ...env, CROFT_EXTENSION_DIR: empty } });
    expect(found).toEqual({ path: extensionPath(ready.dir, "httpfs", platform!), source: "dir" });
  });

  real("validate-style reporting for a file from the environment's folder says where it came from", () => {
    const { search, env } = fresh();
    const report = inspectAddons(["server"], { ...search, env: { ...env, CROFT_EXTENSION_DIR: ready.dir } });
    expect(report.views[0]!.extensions.map((x) => x.source)).toEqual(["dir", "dir"]);
    expect(addonLine(report.views[0]!)).toContain("$CROFT_EXTENSION_DIR");
  });
});

import { describe, expect, test } from "bun:test";
import { version } from "@duckdb/node-api";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { extensionsReady } from "./extension-dir-testkit.ts";
import { extensionPath, hostPlatform, readFooter, verifyExtension, verifyExtensions } from "./extension-files.ts";
import { DUCKDB_VERSION, EXTENSIONS, type ExtensionName, PLATFORMS } from "./extension-names.ts";
import { EXTENSION_PINS } from "./extension-pins.ts";

describe("the pins", () => {
  test("are for the DuckDB this croft runs on, so a DuckDB bump cannot ship with stale pins", () => {
    expect(`v${DUCKDB_VERSION}`).toBe(version());
  });

  test("cover every extension on every platform croft pins, each a sha256 and a plausible size", () => {
    expect(Object.keys(EXTENSION_PINS).sort()).toEqual([...PLATFORMS].sort());
    for (const platform of PLATFORMS) {
      expect(Object.keys(EXTENSION_PINS[platform]).sort(), platform).toEqual(Object.keys(EXTENSIONS).sort());
      for (const [name, pin] of Object.entries(EXTENSION_PINS[platform])) {
        expect(pin.sha256, `${platform}/${name}`).toMatch(/^[0-9a-f]{64}$/);
        expect(pin.bytes, `${platform}/${name}`).toBeGreaterThan(10_000_000);
      }
    }
  });

  test("the sizes option 06 measured on macOS arm64 hold (quack 46.4 MB, httpfs 19.7 MB)", () => {
    expect(EXTENSION_PINS.osx_arm64.quack.bytes).toBe(46_438_430);
    expect(EXTENSION_PINS.osx_arm64.httpfs.bytes).toBe(19_679_534);
  });

  test("a file's place is DuckDB's own layout, per version and platform", () => {
    expect(extensionPath("/x", "postgres", "linux_arm64")).toBe(`/x/v${DUCKDB_VERSION}/linux_arm64/postgres_scanner.duckdb_extension`);
    expect(extensionPath("/x", "quack", "osx_arm64")).toBe(`/x/v${DUCKDB_VERSION}/osx_arm64/quack.duckdb_extension`);
  });

  test("this machine's platform", () => {
    expect(hostPlatform("darwin", "arm64")).toBe("osx_arm64");
    expect(hostPlatform("darwin", "x64")).toBe("osx_amd64");
    expect(hostPlatform("linux", "x64")).toBe("linux_amd64");
    expect(hostPlatform("linux", "arm64")).toBe("linux_arm64");
    expect(hostPlatform("win32", "x64")).toBeNull();
    expect(hostPlatform("freebsd", "x64")).toBeNull();
  });
});

describe("checking a file", () => {
  const platform = hostPlatform();
  const t = platform ? test : test.skip;

  t("a missing file is EXTENSION_MISSING with the path, a hint and a fix", () => {
    const dir = mkdtempSync(join(tmpdir(), "croft-ext-"));
    try {
      let caught: unknown;
      try {
        verifyExtension(dir, "quack");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CroftError);
      const e = caught as CroftError;
      expect(e.code).toBe("EXTENSION_MISSING");
      expect(e.message).toContain(extensionPath(dir, "quack", platform!));
      expect(e.problem.fix?.kind).toBe("command");
      expect(e.problem.retryable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  t("a file of the right name and the wrong content is EXTENSION_CHECKSUM_MISMATCH", () => {
    const dir = mkdtempSync(join(tmpdir(), "croft-ext-"));
    try {
      const file = extensionPath(dir, "httpfs", platform!);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "x".repeat(600));
      expect(() => verifyExtension(dir, "httpfs")).toThrow(/not the pinned file/);
      try {
        verifyExtension(dir, "httpfs");
      } catch (e) {
        expect((e as CroftError).code).toBe("EXTENSION_CHECKSUM_MISMATCH");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const ext = extensionsReady(Object.keys(EXTENSIONS) as ExtensionName[]);
  const real = ext.ready ? test : test.skip;
  if (!ext.ready) console.warn(`[extension-files.test] SKIPPING the checks on real files: ${ext.skipReason}`);

  real("the real pinned files check, and their footers say this DuckDB and this platform", () => {
    const names = Object.keys(EXTENSIONS) as ExtensionName[];
    const paths = verifyExtensions(ext.dir, names);
    expect([...paths.keys()]).toEqual(names);
    for (const path of paths.values()) {
      expect(readFooter(path)).toMatchObject({ duckdb: `v${DUCKDB_VERSION}`, platform: platform! });
    }
  });
});

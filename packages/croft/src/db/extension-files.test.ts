import { describe, expect, test } from "bun:test";
import { version } from "@duckdb/node-api";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CroftError } from "../core/errors.ts";
import { extensionsReady } from "./extension-dir-testkit.ts";
import { detectMusl, extensionPath, hostPlatform, type LibcProbe, readFooter, verifyExtension, verifyExtensions } from "./extension-files.ts";
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

  test("a Linux with musl (Alpine) is an unpinned platform, EXTENSION_MISSING with kind platform, not a glibc build that fails to load", () => {
    expect(hostPlatform("linux", "x64", () => true)).toBeNull();
    expect(hostPlatform("linux", "arm64", () => true)).toBeNull();
    expect(hostPlatform("linux", "x64", () => false)).toBe("linux_amd64");
    // musl does not matter on macOS.
    expect(hostPlatform("darwin", "arm64", () => true)).toBe("osx_arm64");
    try {
      verifyExtension("/nowhere", "quack", hostPlatform("linux", "x64", () => true));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as CroftError).code).toBe("EXTENSION_MISSING");
      expect((e as CroftError).problem.details).toMatchObject({ kind: "platform" });
      expect((e as CroftError).problem.fix?.kind).toBe("manual");
      expect((e as CroftError).problem.hint.length).toBeGreaterThan(10);
    }
  });

  test("detecting musl: the executable's own dynamic loader decides, and a musl loader alone is the fallback", () => {
    const probe = (head: string | null, loaders: string[]): LibcProbe => ({ head: () => (head === null ? null : Buffer.from(`\x7fELF....${head}\0`, "latin1")), loaders: () => loaders });
    expect(detectMusl(probe("/lib/ld-musl-x86_64.so.1", []))).toBe(true);
    expect(detectMusl(probe("/lib64/ld-linux-x86-64.so.2", []))).toBe(false);
    // A glibc machine with the musl compatibility package installed is still glibc.
    expect(detectMusl(probe("/lib64/ld-linux-x86-64.so.2", ["ld-musl-x86_64.so.1", "ld-linux-x86-64.so.2"]))).toBe(false);
    // Header unreadable: a musl loader with no glibc loader is musl.
    expect(detectMusl(probe(null, ["ld-musl-aarch64.so.1"]))).toBe(true);
    expect(detectMusl(probe(null, ["ld-linux-aarch64.so.1", "ld-musl-aarch64.so.1"]))).toBe(false);
    expect(detectMusl(probe(null, []))).toBe(false);
    expect(detectMusl(probe("no interpreter here", []))).toBe(false);
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
      expect(e.problem.fix?.kind).toBe("manual");
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

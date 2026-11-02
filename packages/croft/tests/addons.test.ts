// The add-on packages as built (DESIGN.md D134, D135; option 06, slice 5): scripts/addon-packages.ts writes them from the pins, with
// stand-in files here (the real ones are over 100 MB per platform) and `verify: false`; the check that only a pinned file goes in is
// tested on its own. `npm pack --dry-run` says what each tarball would hold, skipped where npm is not installed.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ADDON_VERSION, addonPackage, extensionPackage, extensionsOf, PLATFORM_NPM, SHIPPED_EXTENSIONS } from "../src/db/addons.ts";
import { extensionPath, hostPlatform } from "../src/db/extension-files.ts";
import { DUCKDB_VERSION, type ExtensionName, PLATFORMS } from "../src/db/extension-names.ts";
import { EXTENSION_PINS } from "../src/db/extension-pins.ts";
import { assertPinned, oversize, packageDir, planPackages, writePackages } from "../scripts/addon-packages.ts";
import { checkBytes, checkNotices, componentsIn, namespacesIn } from "../scripts/check-notices.ts";
import { elfSourceFiles } from "../scripts/elf-files.ts";
import { COMPONENTS, componentsFor, licenseFor, noticesFor } from "../scripts/notices.ts";
import { extensionsReady } from "../src/db/extension-dir-testkit.ts";

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
        expect(m.license).toBe(licenseFor(extension));
        expect(m.files).toEqual([`${extension === "postgres" ? "postgres_scanner" : extension}.duckdb_extension`, "LICENSE", "THIRD_PARTY_NOTICES.txt", "README.md"]);
        // The metadata a package page shows, in the names the package names use.
        expect(m.description).toContain(npm.slug);
        expect(m.description).not.toContain(platform);
        expect(m.bugs).toEqual({ url: "https://github.com/Zabaca/croft/issues" });
        expect(m.keywords).toContain("duckdb-extension");
        expect(m.repository.directory).toBe("packages/croft/scripts");
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
      const expected = extensionsOf(addon).flatMap((e) => PLATFORMS.map((p) => extensionPackage(e, p))).sort();
      expect(Object.keys(m.optionalDependencies).sort()).toEqual(expected);
      expect(Object.values(m.optionalDependencies).every((v) => v === ADDON_VERSION)).toBe(true);
      expect(m.dependencies).toBeUndefined();
      expect(m.scripts).toBeUndefined();
      expect(m.bin).toBeUndefined();
      expect(m.files).toEqual(["LICENSE", "README.md"]);
      expect(m.os).toBeUndefined();
      expect(m.license).toBe("MIT");
      expect(m.bugs).toBeDefined();
      expect(m.keywords).toContain("duckdb");
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

describe("third-party notices", () => {
  const dir = resolve(import.meta.dir, "../scripts/notices");

  test("every component has its license file, which names the project it is for, and its source", () => {
    for (const c of COMPONENTS) {
      for (const f of c.files) expect(readFileSync(join(dir, f), "utf8").length, `${c.id}: ${f}`).toBeGreaterThan(100);
      expect(c.source, c.id).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
      expect(c.found.length, c.id).toBeGreaterThan(5);
    }
    expect(new Set(COMPONENTS.map((c) => c.id)).size).toBe(COMPONENTS.length);
  });

  test("what each extension links, as read from the files: OpenSSL in httpfs, quack and postgres; curl in httpfs; libpq in postgres; CRoaring in ducklake", () => {
    const ids = (e: ExtensionName) => componentsFor(e).map((c) => c.id);
    expect(ids("httpfs")).toEqual(expect.arrayContaining(["openssl", "curl", "mbedtls"]));
    expect(ids("quack")).toContain("openssl");
    expect(ids("quack")).not.toContain("curl");
    expect(ids("postgres")).toEqual(expect.arrayContaining(["openssl", "libpq"]));
    expect(ids("ducklake")).toContain("croaring");
    expect(ids("ducklake")).not.toContain("openssl");
    expect(ids("httpfs")).not.toContain("libpq");
  });

  test("what the Linux builds compile in beyond the macOS ones, as the review read it with nm -a, is listed for every extension: jemalloc, FSST, nanoarrow, SkipList, fastpforlib, hyperloglog, miniz, zstd", () => {
    for (const e of SHIPPED_EXTENSIONS) {
      const ids = componentsFor(e).map((c) => c.id);
      for (const id of ["jemalloc", "fsst", "nanoarrow", "skiplist", "fastpforlib", "hyperloglog", "miniz", "zstd", "mbedtls", "re2"]) expect(ids, `${e}: ${id}`).toContain(id);
    }
    expect(componentsFor("httpfs").map((c) => c.id)).toContain("zlib");
    for (const e of ["quack", "ducklake", "postgres"] as const) expect(componentsFor(e).map((c) => c.id), e).not.toContain("zlib");
    // The Apache NOTICE files travel with the licenses that ask for it.
    expect(noticesFor("quack", "linux-x64")).toContain("Apache Arrow nanoarrow\nCopyright 2023 The Apache Software Foundation");
    expect(noticesFor("quack", "linux-x64")).toContain("Jason Evans");
  });

  test("the SPDX expression of each package names every license taken, MIT first, once each", () => {
    expect(licenseFor("httpfs")).toContain("curl");
    expect(licenseFor("postgres")).toContain("PostgreSQL");
    expect(licenseFor("postgres")).not.toContain("curl");
    for (const e of SHIPPED_EXTENSIONS) for (const id of ["BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "Zlib"]) expect(licenseFor(e), `${e}: ${id}`).toContain(id);
    expect(licenseFor("httpfs")).not.toContain("BSL-1.0");
    for (const e of ["quack", "ducklake", "postgres"] as const) expect(licenseFor(e), e).toContain("BSL-1.0");
    for (const e of SHIPPED_EXTENSIONS) {
      const l = licenseFor(e);
      expect(l.startsWith("MIT AND "), e).toBe(true);
      expect(l, e).toContain("Apache-2.0");
      const parts = l.split(" AND ");
      expect(new Set(parts).size, e).toBe(parts.length);
    }
  });

  test("a package's notices carry the full text of each license it needs: OpenSSL's Apache-2.0 where OpenSSL is linked, libpq's where libpq is", () => {
    const httpfs = noticesFor("httpfs", "darwin-arm64");
    expect(httpfs).toContain("OpenSSL 3.6.0");
    expect(httpfs).toContain("Apache License");
    expect(httpfs).toContain("COPYRIGHT AND PERMISSION NOTICE");
    expect(httpfs).not.toContain("PostgreSQL Database Management System");
    const postgres = noticesFor("postgres", "linux-x64");
    expect(postgres).toContain("PostgreSQL Database Management System");
    expect(postgres).toContain("OpenSSL 3.6.0");
    expect(noticesFor("ducklake", "linux-arm64")).toContain("CRoaring");
    expect(noticesFor("ducklake", "linux-arm64")).not.toContain("OpenSSL 3.6.0");
    for (const e of SHIPPED_EXTENSIONS) expect(noticesFor(e, "darwin-x64"), e).not.toContain("\u2014");
  });
});

describe("the notices stay complete (scripts/check-notices.ts)", () => {
  const bytes = (...parts: string[]) => Buffer.from(parts.join("\0"), "latin1");

  test("a marker for a component the extension's package does not list is a finding", () => {
    // httpfs does not list libpq; a file that shows PQconnectdb is missing its notice.
    const f = checkBytes(bytes("PQconnectdb", "OpenSSL 3.6.0 1 Oct 2025"), "httpfs", "linux_amd64");
    expect(f.missing).toEqual(["libpq"]);
    expect(f.unknown).toEqual([]);
    // The same bytes in postgres's file are covered.
    expect(checkBytes(bytes("PQconnectdb", "OpenSSL 3.6.0 1 Oct 2025"), "postgres", "linux_amd64").missing).toEqual([]);
    // A component added to DuckDB's build shows by its marker too: roaring in a quack file.
    expect(checkBytes(bytes("roaring_bitmap_add"), "quack", "osx_arm64").missing).toEqual(["croaring"]);
  });

  test("a vendored namespace no component covers is a finding, and the covered and core ones are not", () => {
    const mangled = (name: string) => `N${name.length}${name}E`;
    const f = checkBytes(bytes(mangled("duckdb_newlib"), mangled("duckdb_mbedtls"), mangled("duckdb_v2_extension_input"), mangled("duckdb_httplib_openssl")), "quack", "linux_arm64");
    expect(f.unknown).toEqual(["duckdb_newlib"]);
    expect(namespacesIn(bytes(mangled("duckdb_re2"), "duckdb_extension_load")).has("duckdb_re2")).toBe(true);
    expect(namespacesIn(bytes("duckdb_extension_load", "3duckdb_x")).size).toBe(0);
  });

  test("the markers find what they were chosen for", () => {
    expect([...componentsIn(bytes("jemalloc.c", "libfsst.cpp", "SkipList.cpp", "ub_duckdb_adbc_nanoarrow.cpp", "bitpacking.cpp"))].sort())
      .toEqual(["fastpforlib", "fsst", "jemalloc", "nanoarrow", "skiplist"]);
    expect([...componentsIn(bytes("inflate 1.3.2 Copyright 1995-2026 Mark Adler", "invalid distance too far back"))]).toEqual(["zlib"]);
    expect([...componentsIn(bytes("CLIENT libcurl 8.21.0"))]).toEqual(["curl"]);
    expect(componentsIn(bytes("nothing to see", "GetDigestSize", "set_digest")).size).toBe(0);
  });

  test("t-digest is not shipped: no file has it, so no package carries its license", () => {
    expect(COMPONENTS.map((c) => c.id)).not.toContain("tdigest");
    for (const e of SHIPPED_EXTENSIONS) expect(noticesFor(e, "linux-x64").toLowerCase()).not.toContain("t-digest");
  });

  /** A little-endian ELF64 object whose symbol table has one file entry per name, which is all elfSourceFiles reads. */
  function elf(names: string[]): Buffer {
    const strtab = Buffer.from(`\0${names.join("\0")}\0`, "latin1");
    const symtab = Buffer.alloc(24 * (names.length + 1));
    let at = 1;
    names.forEach((n, i) => {
      symtab.writeUInt32LE(at, 24 * (i + 1));
      symtab[24 * (i + 1) + 4] = 4; // STT_FILE
      at += n.length + 1;
    });
    const header = Buffer.alloc(64);
    header.write("\x7fELF", 0, "latin1");
    header[4] = 2; // ELFCLASS64
    header[5] = 1; // little-endian
    const shoff = 64 + strtab.length + symtab.length;
    header.writeBigUInt64LE(BigInt(shoff), 0x28);
    header.writeUInt16LE(64, 0x3a);
    header.writeUInt16LE(3, 0x3c);
    const sections = Buffer.alloc(64 * 3);
    const set = (i: number, type: number, offset: number, size: number, link: number, entsize: number) => {
      sections.writeUInt32LE(type, 64 * i + 4);
      sections.writeBigUInt64LE(BigInt(offset), 64 * i + 0x18);
      sections.writeBigUInt64LE(BigInt(size), 64 * i + 0x20);
      sections.writeUInt32LE(link, 64 * i + 0x28);
      sections.writeBigUInt64LE(BigInt(entsize), 64 * i + 0x38);
    };
    set(1, 2, 64 + strtab.length, symtab.length, 2, 24); // .symtab, linked to section 2
    set(2, 3, 64, strtab.length, 0, 0); // .strtab
    return Buffer.concat([header, strtab, symtab, sections]);
  }

  test("the ELF reader returns the file entries of the symbol table, and null for what is not a little-endian ELF64", () => {
    expect(elfSourceFiles(elf(["a.c", "b/c.cpp"]))?.sort()).toEqual(["a.c", "b/c.cpp"]);
    expect(elfSourceFiles(Buffer.from("not an elf file at all, and long enough to be read as a header".padEnd(80)))).toBeNull();
    expect(elfSourceFiles(Buffer.alloc(10))).toBeNull();
  });

  test("a Linux file compiled from a source file nobody owns is a finding, however the library hides: no namespace, no marker, no banner", () => {
    const f = checkBytes(elf(["ub_duckdb_main.cpp", "ducklake_extension.cpp", "newlib_core.c", "brand_new_codec.cpp"]), "ducklake", "linux_amd64");
    expect(f.sources).toEqual(["brand_new_codec.cpp (nobody owns it)", "newlib_core.c (nobody owns it)"]);
    expect(f.missing).toEqual([]);
    expect(f.unknown).toEqual([]);
    // The extension's own sources are only its own: ducklake's file in a quack package is nobody's here.
    expect(checkBytes(elf(["ducklake_extension.cpp"]), "quack", "linux_arm64").sources).toEqual([expect.stringContaining("ducklake_extension.cpp (owned by ext:ducklake")]);
  });

  test("the libraries the last review found by file name, jemalloc, FSST, nanoarrow, SkipList, fastpforlib and zlib, are findings when their package does not list them", () => {
    const names = ["jemalloc.c", "arena.c", "hpa.c", "libfsst.cpp", "ub_duckdb_adbc_nanoarrow.cpp", "SkipList.cpp", "bitpacking.cpp", "inflate.c", "inftrees.c"];
    const without = componentsFor("httpfs").map((c) => c.id).filter((id) => !["jemalloc", "fsst", "nanoarrow", "skiplist", "fastpforlib", "zlib"].includes(id));
    const f = checkBytes(elf(names), "httpfs", "linux_amd64", without);
    // bitpacking.cpp is also the name of a file in DuckDB's own tree, so by name alone it is DuckDB's; the marker catches it (below).
    expect(f.sources.map((x) => x.split(" ")[0]).sort()).toEqual(names.filter((n) => n !== "bitpacking.cpp").sort());
    expect(f.missing).toContain("fastpforlib");
    for (const x of f.sources) expect(x).toContain("not listed for httpfs");
    // With the real list the same file is covered.
    expect(checkBytes(elf(names), "httpfs", "linux_amd64").sources).toEqual([]);
    expect(checkBytes(elf(names), "httpfs", "linux_amd64").missing).toEqual([]);
    // A name two projects share is accepted when either is allowed: bitpacking.cpp is DuckDB's and fastpforlib's.
    expect(checkBytes(elf(["bitpacking.cpp"]), "quack", "linux_amd64", []).sources).toEqual([]);
  });

  test("a Linux file whose symbol table cannot be read fails closed, and a macOS file is left to the markers", () => {
    expect(checkBytes(Buffer.from("PQconnectdb"), "postgres", "linux_amd64").sources).toEqual(["the ELF symbol table cannot be read, so the source files cannot be checked"]);
    expect(checkBytes(Buffer.from("not an elf"), "postgres", "osx_arm64").sources).toEqual([]);
  });

  test("the owner map is built from the tags the files were built from, and for this DuckDB", () => {
    const map = JSON.parse(readFileSync(resolve(import.meta.dir, "../scripts/notices/source-owners.json"), "utf8")) as { duckdb: string; refs: Record<string, string>; owners: Record<string, string[]> };
    expect(map.duckdb).toBe(DUCKDB_VERSION);
    expect(map.refs.duckdb).toBe(`v${DUCKDB_VERSION}`);
    expect(map.refs["ext:quack"]).toContain("f96420ed46aee9c42064bdb99ddfd1230d6c0086");
    // Every component the notices list that has source files has an owner entry of that name.
    for (const id of ["jemalloc", "fsst", "skiplist", "fastpforlib", "nanoarrow", "openssl", "curl", "zlib", "libpq", "croaring", "zstd", "mbedtls"]) expect(map.owners[id]?.length, id).toBeGreaterThan(0);
    expect(map.owners.jemalloc).toContain("arena.c");
    expect(map.owners.fsst).toContain("libfsst.cpp");
  });

  const real = extensionsReady(["quack", "httpfs", "ducklake", "postgres"]);
  (real.ready ? test : test.skip)("this machine's four real files are covered, and every component listed is one the files show", () => {
    const r = checkNotices(real.dir, [hostPlatform()!]);
    expect(r.checked).toBe(4);
    expect(r.findings).toEqual([]);
    // What only the Linux builds compile in is not in this machine's file when it is a macOS one; nothing else may be unseen.
    const linuxOnly = ["zstd", "miniz", "jemalloc", "fsst", "skiplist", "fastpforlib", "nanoarrow", "hyperloglog", "zlib"];
    for (const [e, ids] of Object.entries(r.listedButNotSeen)) expect(ids.filter((id) => !linuxOnly.includes(id)), e).toEqual([]);
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
    expect(readFileSync(join(packageDir(out, ext), "THIRD_PARTY_NOTICES.txt"), "utf8")).toContain("OpenSSL 3.6.0");
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
      expect(files, name).toEqual([...file, "LICENSE", ...(p.file ? ["THIRD_PARTY_NOTICES.txt"] : []), "README.md", "package.json"].sort());
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

// Builds the add-on packages (DESIGN.md D134, D135) into a folder and, with --pack, packs each with `npm pack`. It publishes
// nothing: publishing is .github/workflows/publish-addons.yml, which runs this and then an explicit, confirmed publish.
//
//   bun scripts/build-addons.ts --source <folder> --out <folder> [--pack] [--max-mb 50] [--json]
//
// --source is a folder of extension files in DuckDB's layout, filled by `bun scripts/fetch-extensions.ts <folder> --all-platforms
// --only quack,httpfs,ducklake,postgres`; every file is checked against croft's pin before it is copied, so a package can only
// hold the pinned file. --out is outside the workspace on purpose (a package.json under packages/ would join the workspace).
// With --pack the tarballs go to <out>/tarballs and <out>/summary.json lists each one's name, version, size and sha256, in the order
// to publish (extension packages first, then the add-ons that depend on them), and the installed size of each add-on per platform.
// Exit 1 when a tarball is over --max-mb (default 50), a figure chosen far below what npm has been seen to accept (D135), or when a
// file shows a third-party component that scripts/notices.ts does not list for its extension (scripts/check-notices.ts, D135).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ADDON_NAMES, ADDON_VERSION, addonPackage, extensionPackage, extensionsOf, PLATFORM_NPM, SHIPPED_EXTENSIONS } from "../src/db/addons.ts";
import { DUCKDB_VERSION, PLATFORMS } from "../src/db/extension-names.ts";
import { oversize, packageDir, type PlannedPackage, writePackages } from "./addon-packages.ts";
import { checkNotices, describe } from "./check-notices.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const value = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`${n}=`))?.slice(n.length + 1);
};
const fail = (msg: string): never => {
  console.error(`build-addons: ${msg}`);
  process.exit(1);
};

const source = value("--source") ?? fail("--source <folder of extension files> is required (bun scripts/fetch-extensions.ts <folder> --all-platforms)");
const outArg = value("--out") ?? fail("--out <folder> is required");
const out = resolve(outArg);
const maxMb = Number(value("--max-mb") ?? "50");
if (!(maxMb > 0)) fail("--max-mb must be a positive number");
const maxBytes = Math.round(maxMb * 1_000_000);

// The notices must cover what the files contain (scripts/check-notices.ts): a build whose files show a component with no notice stops here.
const notices = checkNotices(resolve(source));
if (notices.findings.length) fail(`the notices do not cover the extension files:\n  ${describe(notices.findings).join("\n  ")}\nadd the component to scripts/notices.ts, with its license text in scripts/notices/`);
if (notices.checked !== PLATFORMS.length * SHIPPED_EXTENSIONS.length) fail(`only ${notices.checked} of ${PLATFORMS.length * SHIPPED_EXTENSIONS.length} extension files are in ${source}, so the notices cannot be checked against all of them`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let plan: PlannedPackage[];
try {
  plan = writePackages(out, { source: resolve(source) });
} catch (e) {
  fail((e as Error).message);
  throw e;
}
const say = (s: string) => { if (!flag("--json")) console.log(s); };
say(`wrote ${plan.length} packages for DuckDB ${DUCKDB_VERSION}, version ${ADDON_VERSION}, under ${out}`);

interface Packed { name: string; version: string; kind: string; tarball: string; packedBytes: number; unpackedBytes: number; sha256: string }
const packed: Packed[] = [];
if (flag("--pack")) {
  const npm = Bun.which("npm") ?? fail("npm is not installed");
  const tarballs = join(out, "tarballs");
  mkdirSync(tarballs, { recursive: true });
  for (const p of plan) {
    const r = spawnSync(npm, ["pack", "--json", "--pack-destination", tarballs], {
      cwd: packageDir(out, p), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", NO_COLOR: "1" },
    });
    if (r.status !== 0) fail(`npm pack failed for ${p.name}: ${r.stderr || r.stdout}`);
    const info = (JSON.parse(r.stdout.slice(r.stdout.search(/^\[/m))) as { filename: string; size: number; unpackedSize: number }[])[0]!;
    const file = join(tarballs, info.filename);
    packed.push({
      name: p.name, version: p.version, kind: p.kind, tarball: file, packedBytes: info.size, unpackedBytes: info.unpackedSize,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    });
    say(`packed ${p.name}@${p.version}: ${(info.size / 1e6).toFixed(1)} MB (${(info.unpackedSize / 1e6).toFixed(1)} MB unpacked)`);
  }
}

// What a user installs: the add-on and, for one platform, its extension packages.
const sizeOf = (name: string) => packed.find((p) => p.name === name);
const perPlatform = packed.length
  ? Object.fromEntries(PLATFORMS.map((platform) => [platform, Object.fromEntries(ADDON_NAMES.map((addon) => {
    const files = extensionsOf(addon).map((e) => sizeOf(extensionPackage(e, platform))!);
    return [addon, {
      packages: files.length + 1,
      packedBytes: files.reduce((n, f) => n + f.packedBytes, 0) + sizeOf(addonPackage(addon))!.packedBytes,
      unpackedBytes: files.reduce((n, f) => n + f.unpackedBytes, 0) + sizeOf(addonPackage(addon))!.unpackedBytes,
      npm: PLATFORM_NPM[platform],
    }];
  }))]))
  : {};
const over = oversize(packed, maxBytes);
const largest = packed.reduce((m, p) => Math.max(m, p.packedBytes), 0);
const summary = { version: ADDON_VERSION, duckdb: DUCKDB_VERSION, maxPackedBytes: maxBytes, largestPackedBytes: largest, order: plan.map((p) => p.name), packages: packed, perPlatform };
if (packed.length) writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
if (flag("--json")) console.log(JSON.stringify(summary, null, 2));
else if (packed.length) say(`largest tarball ${(largest / 1e6).toFixed(1)} MB, limit ${maxMb} MB${over.length ? `; OVER: ${over.map((p) => p.name).join(", ")}` : ""}`);
if (over.length) fail(`${over.length} tarball${over.length === 1 ? " is" : "s are"} over ${maxMb} MB: ${over.map((p) => `${p.name} ${(p.packedBytes / 1e6).toFixed(1)} MB`).join(", ")}`);

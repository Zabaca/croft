// Fills a folder with an older DuckDB (1.5.5) and the extension files it loads, for the one test that reads a lake croft wrote with a DuckDB
// that is not the one croft runs on (DESIGN.md D137, D147; src/db/lake-reader-recipe.test.ts, acceptance 11). For croft's own tests and CI only:
// a user never needs it (the lake is format 1.0 so that DuckDB 1.5 can read it, and this proves that it can).
//
//   bun scripts/fetch-old-duckdb.ts <folder>
//
// It installs @duckdb/node-api at the exact version into <folder>/node (bun install, with a package.json it writes) and downloads ducklake,
// httpfs and postgres_scanner for this platform from DuckDB's official extension repository over HTTPS into <folder>/ext, writing each only
// once its sha256 matches src/db/old-extension-pins.ts (a file already there is checked the same way). It prints the two variables the test
// looks for:
//
//   CROFT_TEST_OLD_DUCKDB=<folder>/node CROFT_TEST_OLD_EXTENSIONS=<folder>/ext bun test src/db/lake-reader-recipe.test.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { hostPlatform } from "../src/db/extension-files.ts";
import { OLD_DUCKDB_VERSION, OLD_EXTENSION_PINS, OLD_NODE_API } from "../src/db/old-extension-pins.ts";

const REPO = "https://extensions.duckdb.org";
const NAMES = ["ducklake", "httpfs", "postgres_scanner"] as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const folder = process.argv[2] ? resolve(process.argv[2]) : null;
if (!folder) {
  console.error("usage: bun scripts/fetch-old-duckdb.ts <folder>");
  process.exit(1);
}
const platform = hostPlatform();
if (!platform) {
  console.error(`fetch-old-duckdb: no DuckDB extension builds are known for ${process.platform} ${process.arch}`);
  process.exit(1);
}

const node = join(folder, "node");
mkdirSync(node, { recursive: true });
writeFileSync(join(node, "package.json"), `${JSON.stringify({ name: "old-duckdb", private: true, dependencies: { "@duckdb/node-api": OLD_NODE_API } }, null, 2)}\n`);
const install = Bun.spawnSync([process.execPath, "install"], { cwd: node, stdout: "inherit", stderr: "inherit" });
if (install.exitCode !== 0) {
  console.error("fetch-old-duckdb: bun install failed");
  process.exit(1);
}

const ext = join(folder, "ext");
mkdirSync(ext, { recursive: true });
for (const name of NAMES) {
  const path = join(ext, `${name}.duckdb_extension`);
  const want = OLD_EXTENSION_PINS[platform][name].sha256;
  if (existsSync(path) && sha(readFileSync(path)) === want) {
    console.log(`ok       ${name} (already there)`);
    continue;
  }
  const url = `${REPO}/${OLD_DUCKDB_VERSION}/${platform}/${name}.duckdb_extension.gz`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAILED   ${name}: ${url} answered HTTP ${res.status}`);
    process.exit(1);
  }
  const bytes = gunzipSync(Buffer.from(await res.arrayBuffer()));
  if (sha(bytes) !== want) {
    console.error(`MISMATCH ${platform}/${name}: the repository's file has sha256 ${sha(bytes)}, croft pins ${want}; nothing written`);
    process.exit(1);
  }
  const tmp = `${path}.part-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log(`fetched  ${name} (${(bytes.length / 1e6).toFixed(1)} MB)`);
}
console.log(`CROFT_TEST_OLD_DUCKDB=${node} CROFT_TEST_OLD_EXTENSIONS=${ext}`);

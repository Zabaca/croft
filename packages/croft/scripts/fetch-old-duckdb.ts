// Fills a folder with an older DuckDB (1.5.5) and the extension files it loads, for the one test that reads a lake croft wrote with a DuckDB
// that is not the one croft runs on (DESIGN.md D137, D147; src/db/lake-reader-recipe.test.ts, acceptance 11). For croft's own tests and CI only:
// a user never needs it (the lake is format 1.0 so that DuckDB 1.5 can read it, and this proves that it can).
//
//   bun scripts/fetch-old-duckdb.ts <folder>
//
// It installs @duckdb/node-api at the exact version into <folder>/node (bun install, with a package.json it writes) and downloads ducklake,
// httpfs and postgres_scanner for this platform from DuckDB's official extension repository over HTTPS into <folder>/ext. Unlike
// fetch-extensions.ts these files are not checked against a pinned checksum (croft pins only the version it runs on); the test only reads
// with them. It prints the two variables the test looks for:
//
//   CROFT_TEST_OLD_DUCKDB=<folder>/node CROFT_TEST_OLD_EXTENSIONS=<folder>/ext bun test src/db/lake-reader-recipe.test.ts
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { hostPlatform } from "../src/db/extension-files.ts";

const NODE_API = "1.5.5-r.5";
const DUCKDB = "v1.5.5";
const REPO = "https://extensions.duckdb.org";
const NAMES = ["ducklake", "httpfs", "postgres_scanner"] as const;

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
writeFileSync(join(node, "package.json"), `${JSON.stringify({ name: "old-duckdb", private: true, dependencies: { "@duckdb/node-api": NODE_API } }, null, 2)}\n`);
const install = Bun.spawnSync([process.execPath, "install"], { cwd: node, stdout: "inherit", stderr: "inherit" });
if (install.exitCode !== 0) {
  console.error("fetch-old-duckdb: bun install failed");
  process.exit(1);
}

const ext = join(folder, "ext");
mkdirSync(ext, { recursive: true });
for (const name of NAMES) {
  const path = join(ext, `${name}.duckdb_extension`);
  if (existsSync(path)) {
    console.log(`ok       ${name} (already there)`);
    continue;
  }
  const url = `${REPO}/${DUCKDB}/${platform}/${name}.duckdb_extension.gz`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAILED   ${name}: ${url} answered HTTP ${res.status}`);
    process.exit(1);
  }
  const bytes = gunzipSync(Buffer.from(await res.arrayBuffer()));
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

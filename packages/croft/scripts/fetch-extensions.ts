// Fills a folder with the DuckDB extension files croft's modes load, and checks each against the pinned sha256
// (src/db/extension-pins.ts, DESIGN.md D117). For croft's own tests, builders and CI: how users get these files
// is a later decision (option 06, slice 5). The files are never committed (together over 100 MB per platform).
//
//   bun scripts/fetch-extensions.ts [folder] [--all-platforms] [--only quack,httpfs]
//
// The folder is, in order: the argument, $CROFT_EXTENSION_DIR, then testExtensionDir() (a cache under $XDG_CACHE_HOME
// or ~/.cache, shared by every worktree). It downloads from DuckDB's official extension repository over HTTPS (a
// machine's proxy may refuse plain HTTP), unpacks, and writes a file only once its checksum matches. A file already
// there and correct is left alone. Exit 1 on any mismatch, with nothing written for it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { extensionPath, hostPlatform, verifyExtension } from "../src/db/extension-files.ts";
import { DUCKDB_VERSION, EXTENSIONS, type ExtensionName, PLATFORMS, type Platform } from "../src/db/extension-names.ts";
import { EXTENSION_PINS } from "../src/db/extension-pins.ts";
import { testExtensionDir } from "../src/db/extension-dir-testkit.ts";

const REPO = "https://extensions.duckdb.org";
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",") ?? (args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : null);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");
const dir = positional[0] ?? process.env.CROFT_EXTENSION_DIR ?? testExtensionDir();

const platforms: readonly Platform[] = flag("--all-platforms") ? PLATFORMS : [hostPlatform() ?? fail(`croft pins no extensions for ${process.platform} ${process.arch}`)];
const names = (Object.keys(EXTENSIONS) as ExtensionName[]).filter((n) => !only || only.includes(n));

function fail(msg: string): never {
  console.error(`fetch-extensions: ${msg}`);
  process.exit(1);
}

let bad = 0;
for (const platform of platforms) {
  for (const name of names) {
    const path = extensionPath(dir, name, platform);
    if (existsSync(path)) {
      try {
        if (platform === hostPlatform()) { verifyExtension(dir, name, platform); console.log(`ok       ${platform}/${name} (already there)`); continue; }
      } catch { /* wrong or damaged: fetch again */ }
    }
    const url = `${REPO}/v${DUCKDB_VERSION}/${platform}/${EXTENSIONS[name]}.duckdb_extension.gz`;
    const res = await fetch(url);
    if (!res.ok) { console.error(`FAILED   ${platform}/${name}: ${url} answered HTTP ${res.status}`); bad++; continue; }
    const bytes = gunzipSync(Buffer.from(await res.arrayBuffer()));
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== EXTENSION_PINS[platform][name].sha256) {
      console.error(`MISMATCH ${platform}/${name}: the repository's file has sha256 ${sha}, croft pins ${EXTENSION_PINS[platform][name].sha256}; nothing written`);
      bad++;
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.part-${process.pid}`;
    try { writeFileSync(tmp, bytes); renameSync(tmp, path); } finally { rmSync(tmp, { force: true }); }
    console.log(`fetched  ${platform}/${name} (${(bytes.length / 1e6).toFixed(1)} MB)`);
  }
}
console.log(`${dir}: ${bad ? `${bad} failed` : "all files match the pins"}`);
process.exit(bad ? 1 : 0);

// Fills a folder with the DuckDB extension files croft's tests load, and checks each against the pinned sha256
// (src/db/extension-pins.ts, DESIGN.md D117). For croft's own tests, builders and CI: the files are never committed (together
// over 100 MB per platform). It is src/db/extension-fetch.ts, the code a user's machine fetches with (D195), over every extension
// croft pins, sqlite included (the lake's tests use it).
//
//   bun scripts/fetch-extensions.ts [folder]
//
// The folder is, in order: the argument, $CROFT_EXTENSION_DIR, then resolveExtensionDir() (croft's cache under $XDG_CACHE_HOME or
// ~/.cache, shared by every worktree). A file already there and correct is left alone; one that differs from the pin is never
// written. Exit 1 on any failure.
import { fetchExtension } from "../src/db/extension-fetch.ts";
import { hostPlatform, resolveExtensionDir } from "../src/db/extension-files.ts";
import { EXTENSIONS, type ExtensionName } from "../src/db/extension-names.ts";

const platform = hostPlatform();
if (!platform) {
  console.error(`fetch-extensions: croft pins no extensions for ${process.platform} ${process.arch}`);
  process.exit(1);
}
const dir = process.argv[2] ?? resolveExtensionDir();
let bad = 0;
for (const name of Object.keys(EXTENSIONS) as ExtensionName[]) {
  try {
    const f = await fetchExtension(name, { dir, platform, log: () => {} });
    console.log(`${f.downloaded ? "fetched " : "ok      "} ${platform}/${name} (${(f.bytes / 1e6).toFixed(1)} MB${f.downloaded ? "" : ", already there"})`);
  } catch (e) {
    console.error(`FAILED   ${platform}/${name}: ${e instanceof Error ? e.message : String(e)}`);
    bad++;
  }
}
console.log(`${dir}: ${bad ? `${bad} failed` : "all files match the pins"}`);
process.exit(bad ? 1 : 0);

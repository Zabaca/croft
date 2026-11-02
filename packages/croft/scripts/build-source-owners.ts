// Writes scripts/notices/source-owners.json: which project each compiled source file name belongs to. scripts/check-notices.ts uses it to
// say who owns every source-file name an extension file on Linux was compiled from (DESIGN.md D135), so that a library nobody listed is
// found by its file names, not by a marker someone thought of.
//
//   bun scripts/build-source-owners.ts [--check]
//
// The names come from git trees at the exact refs the files were built from, over the network (GITHUB_TOKEN raises the rate limit):
//   - DuckDB v2.0.0 (src/db/extension-names.ts DUCKDB_VERSION): its third_party/<lib> directories are the components of that name, its
//     src/common/adbc/nanoarrow is nanoarrow, the data generators in its tree (tpch, tpcds) and the linenoise shell are libraries
//     croft ships no notice for ("unlisted:..."), and the rest of the tree is DuckDB's own ("duckdb").
//   - Each extension's repository at the commit DuckDB v2.0.0's .github/config/extensions/<name>.cmake pins ("ext:<name>"), and the
//     submodules of it that are compiled in.
//   - OpenSSL, libcurl, zlib, PostgreSQL's libpq (with the src/common and src/port code it compiles) and CRoaring, at the versions
//     scripts/notices.ts names for them (CRoaring's version in the files is not known: the names of its latest release, v5.4.0, are read).
// It only maps names. A name in several trees maps to all its owners, and the check accepts a file if any owner is allowed, so a
// common name (hash.c) can hide behind another library's; the library's other files cannot.
// Run it when DUCKDB_VERSION or the libraries change, and commit the JSON. --check recomputes and fails if the committed file differs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DUCKDB_VERSION } from "../src/db/extension-names.ts";

const OUT = fileURLToPath(new URL("./notices/source-owners.json", import.meta.url));
// OpenSSL generates many of its .c files from .c.in templates; the compiled name drops the .in.
const SRC = /\.(c|cc|cpp|cxx|S|asm)(\.in)?$/;
const token = process.env.GITHUB_TOKEN;

async function api(path: string): Promise<any> {
  const res = await fetch(`https://api.github.com/${path}`, { headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
async function raw(repo: string, ref: string, path: string): Promise<string> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${path}`);
  if (!res.ok) throw new Error(`${repo}@${ref}:${path}: HTTP ${res.status}`);
  return res.text();
}
interface Entry { path: string; type: string; sha: string }
async function tree(repo: string, ref: string): Promise<Entry[]> {
  const t = await api(`repos/${repo}/git/trees/${ref}?recursive=1`);
  if (t.truncated) throw new Error(`${repo}@${ref}: the tree is truncated`);
  return t.tree as Entry[];
}

const owners = new Map<string, Set<string>>();
const add = (path: string, owner: string) => {
  const name = path.split("/").pop()!.replace(/\.in$/, "");
  if (!SRC.test(name)) return;
  (owners.get(name) ?? owners.set(name, new Set()).get(name)!).add(owner);
};
const refs: Record<string, string> = {};

// DuckDB's own tree.
const COMPONENT_OF_THIRD_PARTY: Record<string, string> = {
  jemalloc: "jemalloc", mbedtls: "mbedtls", re2: "re2", fmt: "fmt", yyjson: "yyjson", jaro_winkler: "jaro_winkler", concurrentqueue: "concurrentqueue",
  fast_float: "fast_float", utf8proc: "utf8proc", zstd: "zstd", httplib: "httplib", hyperloglog: "hyperloglog", pdqsort: "pdqsort", vergesort: "vergesort",
  ska_sort: "ska_sort", miniz: "miniz", fsst: "fsst", skiplist: "skiplist", fastpforlib: "fastpforlib",
};
const duck = await tree("duckdb/duckdb", `v${DUCKDB_VERSION}`);
refs.duckdb = `v${DUCKDB_VERSION}`;
for (const e of duck) {
  if (e.type !== "blob" || !SRC.test(e.path) || e.path.startsWith("test/") || e.path.startsWith("benchmark/")) continue;
  const parts = e.path.split("/");
  if (parts[0] === "third_party") add(e.path, COMPONENT_OF_THIRD_PARTY[parts[1]!] ?? `unlisted:${parts[1]}`);
  else if (e.path.startsWith("src/common/adbc/nanoarrow/")) add(e.path, "nanoarrow");
  else if (e.path.startsWith("extension/tpch/dbgen/") || e.path.startsWith("extension/tpcds/dsdgen/")) add(e.path, `unlisted:${parts[1]}`);
  else if (e.path.startsWith("tools/shell/linenoise/")) add(e.path, "unlisted:linenoise");
  else add(e.path, "duckdb");
}

// The libraries.
const LIBS: { owner: string; repo: string; ref: string; under: RegExp }[] = [
  { owner: "openssl", repo: "openssl/openssl", ref: "openssl-3.6.0", under: /^(crypto|ssl|providers|engines)\// },
  { owner: "curl", repo: "curl/curl", ref: "curl-8_21_0", under: /^lib\// },
  { owner: "zlib", repo: "madler/zlib", ref: "v1.3.2", under: /^[^/]+$/ },
  { owner: "libpq", repo: "postgres/postgres", ref: "REL_18_0", under: /^src\/(interfaces\/libpq|common|port)\// },
  { owner: "croaring", repo: "RoaringBitmap/CRoaring", ref: "v5.4.0", under: /^src\// },
];
for (const l of LIBS) {
  refs[l.owner] = `${l.repo}@${l.ref}`;
  for (const e of await tree(l.repo, l.ref)) if (e.type === "blob" && SRC.test(e.path) && l.under.test(e.path)) add(e.path, l.owner);
}

// The extensions, at the commits DuckDB v2.0.0 builds them from.
const EXTENSIONS: { name: string; cmake: string; repo: string }[] = [
  { name: "httpfs", cmake: "httpfs", repo: "duckdb/duckdb-httpfs" },
  { name: "quack", cmake: "quack", repo: "duckdb/duckdb-quack" },
  { name: "ducklake", cmake: "ducklake", repo: "duckdb/ducklake" },
  { name: "postgres", cmake: "postgres_scanner", repo: "duckdb/duckdb-postgres" },
];
for (const x of EXTENSIONS) {
  const cmake = await raw("duckdb/duckdb", `v${DUCKDB_VERSION}`, `.github/config/extensions/${x.cmake}.cmake`);
  const sha = /GIT_TAG\s+([0-9a-f]{40})/.exec(cmake)?.[1];
  if (!sha) throw new Error(`no pinned commit in ${x.cmake}.cmake`);
  refs[`ext:${x.name}`] = `${x.repo}@${sha}`;
  const entries = await tree(x.repo, sha);
  for (const e of entries) {
    if (e.type !== "blob" || !SRC.test(e.path) || e.path.startsWith("test/")) continue;
    // Anything the extension vendors outside its own src/ is a library of its own, until someone names it.
    const own = e.path.startsWith("src/") || e.path.startsWith("extension/");
    add(e.path, own ? `ext:${x.name}` : `unlisted:${x.name}:${e.path.split("/")[0]}`);
  }
  // Submodules that are compiled in (postgres's database-connector); extension-ci-tools is build tooling and duckdb is DuckDB, above.
  for (const m of entries.filter((e) => e.type === "commit" && e.path !== "extension-ci-tools" && e.path !== "duckdb")) {
    const modules = await raw(x.repo, sha, ".gitmodules");
    const url = new RegExp(`path\\s*=\\s*${m.path}\\s+url\\s*=\\s*(\\S+)`).exec(modules)?.[1]?.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!url) throw new Error(`no URL for submodule ${m.path} of ${x.repo}`);
    refs[`ext:${x.name}:${m.path}`] = `${url}@${m.sha}`;
    for (const e of await tree(url, m.sha)) if (e.type === "blob" && SRC.test(e.path) && !e.path.startsWith("test/")) add(e.path, `ext:${x.name}`);
  }
}

const byOwner: Record<string, string[]> = {};
for (const [name, set] of [...owners].sort(([a], [b]) => (a < b ? -1 : 1))) for (const o of [...set].sort()) (byOwner[o] ??= []).push(name);
const json = `${JSON.stringify({ duckdb: DUCKDB_VERSION, refs, owners: Object.fromEntries(Object.entries(byOwner).sort(([a], [b]) => (a < b ? -1 : 1))) })}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) {
    console.error("scripts/notices/source-owners.json is out of date; run: bun scripts/build-source-owners.ts");
    process.exit(1);
  }
  console.log("source-owners.json is current");
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}: ${owners.size} names, ${Object.keys(byOwner).length} owners`);
}

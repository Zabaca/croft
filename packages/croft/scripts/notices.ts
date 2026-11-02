// The third-party notices each extension package carries (DESIGN.md D135). The extension files are DuckDB's builds, and each links
// other projects' code statically: the files need nothing but the system's libc and C++ runtime (otool -L on macOS, the ELF NEEDED
// entries read with objdump -p on Linux), so everything below travels inside them and its licenses must travel with them.
//
// What is in them was read from the files themselves, not from DuckDB's manifests, with strings, `nm -a -C` and a scan of the raw
// bytes for the markers below, on all 16 files (4 extensions on osx_arm64, osx_amd64, linux_amd64 and linux_arm64):
//   - The macOS builds are stripped of file names and most local symbols: they show a library by its C++ namespace
//     (duckdb_mbedtls, duckdb_re2, ...) or an exported function (PQconnectdb, roaring_bitmap_, curl_easy_), and by banners.
//   - The Linux builds also carry the names of the source files they were compiled from (nm -a lists them), and they compile in
//     parts of DuckDB itself that the macOS builds do not: jemalloc, FSST, nanoarrow, SkipList, fastpforlib, hyperloglog, miniz
//     and zstd show by file name in all four Linux files. zlib shows by its inflate banner and message in httpfs only.
//   - A library is listed for an extension if any of the four platforms' files of it shows the library (the union), because a
//     package's notice has to cover the file of every platform it is installed on.
// The license texts are the projects' own files, fetched once from the tags named in `source` and kept in scripts/notices/.
// `used` is the license the code is taken under where the project offers a choice. Nothing here has been reviewed by a lawyer.
// scripts/check-notices.ts fails the add-on build when a file shows a component that is not listed here for its extension: by a
// marker, by a DuckDB-vendored namespace that has no component, or (Linux files) by a compiled source-file name that no listed
// component and no part of DuckDB's own tree owns.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionName } from "../src/db/extension-names.ts";

export interface Component {
  id: string;
  name: string;
  /** What the project says it is under (SPDX), and the part taken where it offers a choice. */
  offered: string;
  used: string;
  /** Where the text was fetched from. */
  source: string;
  /** The license file, and any NOTICE file the license makes travel with it, in scripts/notices/. */
  files: readonly string[];
  /** The extensions whose files contain it, on any platform. */
  in: readonly ExtensionName[];
  found: string;
  /** What shows it in a file, as a regular expression over the file's bytes read as Latin-1. */
  marker: RegExp;
}

const ALL: readonly ExtensionName[] = ["httpfs", "quack", "ducklake", "postgres"];
const SORTS: readonly ExtensionName[] = ["quack", "ducklake", "postgres"];
const DUCKDB = "https://raw.githubusercontent.com/duckdb/duckdb/v2.0.0/third_party";
const ns = (name: string) => new RegExp(`duckdb_${name}`);

export const COMPONENTS: readonly Component[] = [
  { id: "openssl", name: "OpenSSL 3.6.0", offered: "Apache-2.0", used: "Apache-2.0", files: ["openssl-3.6.0.txt"], in: ["httpfs", "quack", "postgres"],
    source: "https://raw.githubusercontent.com/openssl/openssl/openssl-3.6.0/LICENSE.txt", found: "banner and SSL_/EVP_ symbols, all four platforms",
    marker: /OpenSSL \d+\.\d+\.\d+ \d+ [A-Z][a-z]{2} \d{4}/ },
  { id: "curl", name: "libcurl 8.21.0", offered: "curl", used: "curl", files: ["curl.txt"], in: ["httpfs"],
    source: "https://raw.githubusercontent.com/curl/curl/curl-8_21_0/COPYING", found: "banner and curl_easy_ symbols, all four platforms",
    marker: /CLIENT libcurl|curl_easy_(?:init|perform|setopt)/ },
  { id: "zlib", name: "zlib 1.3.2", offered: "Zlib", used: "Zlib", files: ["zlib.txt"], in: ["httpfs"],
    source: "https://raw.githubusercontent.com/madler/zlib/v1.3.2/LICENSE", found: "inflate banner (Linux) and its error messages (all four platforms), linked by libcurl",
    marker: /invalid distance too far back/ },
  { id: "libpq", name: "libpq (PostgreSQL 18)", offered: "PostgreSQL", used: "PostgreSQL", files: ["postgresql.txt"], in: ["postgres"],
    source: "https://raw.githubusercontent.com/postgres/postgres/REL_18_0/COPYRIGHT", found: "PQconnect symbols, libpq-oauth message, all four platforms",
    marker: /PQconnectdb|PQconnectStart/ },
  { id: "croaring", name: "CRoaring", offered: "Apache-2.0 OR MIT", used: "Apache-2.0", files: ["croaring.txt"], in: ["ducklake"],
    source: "https://raw.githubusercontent.com/RoaringBitmap/CRoaring/master/LICENSE", found: "roaring_bitmap_ symbols, all four platforms",
    marker: /roaring_bitmap_/ },
  // DuckDB's own third_party sources, at the DuckDB release the extensions are built for.
  { id: "mbedtls", name: "Mbed TLS (DuckDB's copy)", offered: "Apache-2.0 OR GPL-2.0-or-later", used: "Apache-2.0", files: ["duckdb-mbedtls.txt"], in: ALL,
    source: `${DUCKDB}/mbedtls/LICENSE`, found: "duckdb_mbedtls namespace, all four platforms", marker: ns("mbedtls") },
  { id: "re2", name: "RE2", offered: "BSD-3-Clause", used: "BSD-3-Clause", files: ["duckdb-re2.txt"], in: ALL, source: `${DUCKDB}/re2/LICENSE`,
    found: "duckdb_re2 namespace, all four platforms", marker: ns("re2") },
  { id: "fmt", name: "{fmt}", offered: "MIT", used: "MIT", files: ["duckdb-fmt.txt"], in: ALL, source: `${DUCKDB}/fmt/LICENSE`,
    found: "duckdb_fmt namespace, all four platforms", marker: ns("fmt") },
  { id: "yyjson", name: "yyjson", offered: "MIT", used: "MIT", files: ["duckdb-yyjson.txt"], in: ALL, source: `${DUCKDB}/yyjson/LICENSE`,
    found: "duckdb_yyjson namespace, all four platforms", marker: ns("yyjson") },
  { id: "jaro_winkler", name: "jaro_winkler", offered: "MIT", used: "MIT", files: ["duckdb-jaro_winkler.txt"], in: ALL, source: `${DUCKDB}/jaro_winkler/LICENSE`,
    found: "duckdb_jaro_winkler namespace, all four platforms", marker: ns("jaro_winkler") },
  { id: "concurrentqueue", name: "moodycamel::ConcurrentQueue", offered: "BSD-2-Clause", used: "BSD-2-Clause", files: ["duckdb-concurrentqueue.txt"], in: ALL,
    source: `${DUCKDB}/concurrentqueue/LICENSE`, found: "duckdb_moodycamel namespace, all four platforms", marker: ns("moodycamel") },
  { id: "fast_float", name: "fast_float", offered: "MIT", used: "MIT", files: ["duckdb-fast_float.txt"], in: ALL, source: `${DUCKDB}/fast_float/LICENSE`,
    found: "duckdb_fast_float namespace, all four platforms", marker: ns("fast_float") },
  { id: "utf8proc", name: "utf8proc", offered: "MIT AND the Unicode data license", used: "MIT AND LicenseRef-Unicode-1991-2007", files: ["duckdb-utf8proc.txt"], in: ALL,
    source: `${DUCKDB}/utf8proc/LICENSE`, found: "utf8proc_ symbols, all four platforms", marker: /utf8proc_/ },
  { id: "zstd", name: "Zstandard", offered: "BSD-3-Clause", used: "BSD-3-Clause", files: ["duckdb-zstd.txt"], in: ALL, source: `${DUCKDB}/zstd/LICENSE`,
    found: "duckdb_zstd namespace and zstd source files, Linux files of all four extensions", marker: ns("zstd") },
  { id: "httplib", name: "cpp-httplib", offered: "MIT", used: "MIT", files: ["duckdb-httplib.txt"], in: ["httpfs", "quack"], source: `${DUCKDB}/httplib/LICENSE`,
    found: "duckdb_httplib_openssl namespace, all four platforms", marker: ns("httplib_openssl") },
  { id: "hyperloglog", name: "hyperloglog", offered: "MIT", used: "MIT", files: ["duckdb-hyperloglog.txt"], in: ALL, source: `${DUCKDB}/hyperloglog/LICENSE`,
    found: "duckdb_hll namespace (quack, ducklake, postgres, all platforms) and hyperloglog.cpp (all four Linux files)", marker: /duckdb_hll|hyperloglog\.cpp/ },
  { id: "pdqsort", name: "pdqsort", offered: "Zlib", used: "Zlib", files: ["duckdb-pdqsort.txt"], in: SORTS, source: `${DUCKDB}/pdqsort/LICENSE`,
    found: "duckdb_pdqsort namespace, all four platforms", marker: ns("pdqsort") },
  { id: "vergesort", name: "vergesort", offered: "MIT", used: "MIT", files: ["duckdb-vergesort.txt"], in: SORTS, source: `${DUCKDB}/vergesort/LICENSE`,
    found: "duckdb_vergesort namespace, all four platforms", marker: ns("vergesort") },
  { id: "ska_sort", name: "ska_sort", offered: "BSL-1.0", used: "BSL-1.0", files: ["duckdb-ska_sort.txt"], in: SORTS, source: `${DUCKDB}/ska_sort/LICENSE`,
    found: "duckdb_ska_sort namespace, all four platforms", marker: ns("ska_sort") },
  { id: "miniz", name: "miniz", offered: "MIT", used: "MIT", files: ["duckdb-miniz.txt"], in: ALL, source: `${DUCKDB}/miniz/LICENSE`,
    found: "duckdb_miniz namespace (ducklake, all platforms) and miniz.cpp (all four Linux files)", marker: /duckdb_miniz|miniz\.cpp/ },
  { id: "jemalloc", name: "jemalloc", offered: "BSD-2-Clause", used: "BSD-2-Clause", files: ["duckdb-jemalloc.txt"], in: ALL, source: `${DUCKDB}/jemalloc/LICENSE`,
    found: "jemalloc.c, arena.c, hpa.c and 62 more of its source files, and je_ symbols, all four Linux files; not in the macOS builds", marker: /jemalloc\.c|\bje_malloc\b|\bje_arena_/ },
  { id: "fsst", name: "FSST", offered: "MIT", used: "MIT", files: ["duckdb-fsst.txt"], in: ALL, source: `${DUCKDB}/fsst/LICENSE`,
    found: "libfsst.cpp, all four Linux files; not in the macOS builds", marker: /libfsst\.cpp|fsst_decompress|fsst_compress|fsst_create|fsst_decoder/ },
  { id: "skiplist", name: "SkipList", offered: "MIT", used: "MIT", files: ["duckdb-skiplist.txt"], in: ALL, source: `${DUCKDB}/skiplist/LICENSE`,
    found: "SkipList.cpp, all four Linux files; not in the macOS builds", marker: /SkipList\.cpp/ },
  { id: "fastpforlib", name: "FastPFor (fastpforlib)", offered: "Apache-2.0", used: "Apache-2.0", files: ["duckdb-fastpforlib.txt"], in: ALL, source: `${DUCKDB}/fastpforlib/LICENSE`,
    found: "bitpacking.cpp, all four Linux files; not in the macOS builds", marker: /fastpforlib|bitpacking\.cpp/ },
  { id: "nanoarrow", name: "Apache Arrow nanoarrow (DuckDB's ADBC copy)", offered: "Apache-2.0", used: "Apache-2.0", files: ["nanoarrow.txt", "nanoarrow-notice.txt"], in: ALL,
    source: "https://raw.githubusercontent.com/apache/arrow-nanoarrow/main/LICENSE.txt (DuckDB's tree keeps no license file for src/common/adbc/nanoarrow; the version is not known)",
    found: "ub_duckdb_adbc_nanoarrow.cpp, all four Linux files; not in the macOS builds", marker: /nanoarrow/ },
];

/** Namespaces DuckDB itself puts in its own `duckdb_` names that are not a vendored library. */
export const CORE_NAMESPACES: readonly string[] = ["duckdb_v2_extension_input"];

const NOTICES_DIR = fileURLToPath(new URL("./notices/", import.meta.url));

/** The components inside one extension's files. */
export const componentsFor = (extension: ExtensionName): Component[] => COMPONENTS.filter((c) => c.in.includes(extension));

/** The package's SPDX expression: DuckDB's own MIT and every license the components are taken under, once each. */
export function licenseFor(extension: ExtensionName): string {
  const ids = new Set<string>(["MIT"]);
  for (const c of componentsFor(extension)) for (const part of c.used.split(" AND ")) ids.add(part);
  return [...ids].join(" AND ");
}

/** THIRD_PARTY_NOTICES.txt for one extension's package. */
export function noticesFor(extension: ExtensionName, platformName: string): string {
  const parts: string[] = [
    `Third-party notices for the ${extension} extension file in this package (DuckDB's build for ${platformName}, unchanged).`,
    "",
    "The file is DuckDB's, under the MIT license in LICENSE. It links the projects below statically, so their code is in it and",
    "their licenses apply to that code. Where a project offers a choice of licenses, the one named after \"taken under\" is the one",
    "croft's packages rely on. What each file contains was read from the DuckDB builds for all four platforms (macOS and Linux,",
    "arm64 and x64), and a project is listed here if any of them shows it, so this notice covers the file of every platform; the",
    "text of each license is the project's own, as fetched from the address given.",
    "",
  ];
  for (const c of componentsFor(extension)) {
    parts.push(
      "=".repeat(78),
      `${c.name}`,
      `  offered under: ${c.offered}`,
      `  taken under:   ${c.used}`,
      `  found by:      ${c.found}`,
      `  license text:  ${c.source}`,
      "=".repeat(78),
      "",
    );
    for (const f of c.files) parts.push(readFileSync(join(NOTICES_DIR, f), "utf8").trimEnd(), "");
  }
  return `${parts.join("\n")}\n`;
}

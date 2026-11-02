// The third-party notices each extension package carries (DESIGN.md D135). The extension files are DuckDB's builds, and each links
// other projects' code statically: the files need nothing but the system's libc and C++ runtime (otool -L on macOS, the ELF NEEDED
// entries on Linux), so everything below travels inside them and its licenses must travel with them.
//
// What is linked was read from the 16 files themselves (strings and symbols, on all four platforms), not from DuckDB's manifests:
//   - OpenSSL 3.6.0 (banner "OpenSSL 3.6.0 1 Oct 2025", SSL_ and EVP_ symbols): httpfs, quack and postgres.
//   - libcurl 8.21.0 (banner "CLIENT libcurl 8.21.0", curl_easy_ symbols): httpfs only. quack's vcpkg.json lists curl, but no quack
//     file has a curl banner or a curl_easy_ symbol, so it is not listed for quack.
//   - libpq 18 (PQconnect symbols, "libpq-oauth", vcpkg's libpq install path): postgres.
//   - CRoaring (roaring_bitmap_ symbols): ducklake.
//   - DuckDB's own third_party sources, by their namespaces and symbols (duckdb_mbedtls, duckdb_re2, duckdb_fmt, duckdb_yyjson,
//     utf8proc_, ZSTD_ and the rest): the set below per extension. Which of them a given build keeps varies a little by platform
//     (zstd shows on Linux only); the notice of every one seen on any platform is in the package.
// The license texts are the projects' own files, fetched once from the tags named in `source` and kept in scripts/notices/.
// `used` is the license the code is taken under where the project offers a choice. Nothing here has been reviewed by a lawyer.
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
  file: string;
  /** The extensions whose files contain it. */
  in: readonly ExtensionName[];
  found: string;
}

const ALL: readonly ExtensionName[] = ["httpfs", "quack", "ducklake", "postgres"];
const DUCKDB = "https://raw.githubusercontent.com/duckdb/duckdb/v2.0.0/third_party";

export const COMPONENTS: readonly Component[] = [
  { id: "openssl", name: "OpenSSL 3.6.0", offered: "Apache-2.0", used: "Apache-2.0", file: "openssl-3.6.0.txt", in: ["httpfs", "quack", "postgres"],
    source: "https://raw.githubusercontent.com/openssl/openssl/openssl-3.6.0/LICENSE.txt", found: "banner and SSL_/EVP_ symbols" },
  { id: "curl", name: "libcurl 8.21.0", offered: "curl", used: "curl", file: "curl.txt", in: ["httpfs"],
    source: "https://raw.githubusercontent.com/curl/curl/curl-8_21_0/COPYING", found: "banner and curl_easy_ symbols" },
  { id: "libpq", name: "libpq (PostgreSQL 18)", offered: "PostgreSQL", used: "PostgreSQL", file: "postgresql.txt", in: ["postgres"],
    source: "https://raw.githubusercontent.com/postgres/postgres/REL_18_0/COPYRIGHT", found: "PQconnect symbols, libpq-oauth message" },
  { id: "croaring", name: "CRoaring", offered: "Apache-2.0 OR MIT", used: "Apache-2.0", file: "croaring.txt", in: ["ducklake"],
    source: "https://raw.githubusercontent.com/RoaringBitmap/CRoaring/master/LICENSE", found: "roaring_bitmap_ symbols" },
  // DuckDB's own third_party sources, at the DuckDB release the extensions are built for.
  { id: "mbedtls", name: "Mbed TLS (DuckDB's copy)", offered: "Apache-2.0 OR GPL-2.0-or-later", used: "Apache-2.0", file: "duckdb-mbedtls.txt", in: ALL,
    source: `${DUCKDB}/mbedtls/LICENSE`, found: "duckdb_mbedtls symbols" },
  { id: "re2", name: "RE2", offered: "BSD-3-Clause", used: "BSD-3-Clause", file: "duckdb-re2.txt", in: ALL, source: `${DUCKDB}/re2/LICENSE`, found: "duckdb_re2 symbols" },
  { id: "fmt", name: "{fmt}", offered: "MIT", used: "MIT", file: "duckdb-fmt.txt", in: ALL, source: `${DUCKDB}/fmt/LICENSE`, found: "duckdb_fmt symbols" },
  { id: "yyjson", name: "yyjson", offered: "MIT", used: "MIT", file: "duckdb-yyjson.txt", in: ALL, source: `${DUCKDB}/yyjson/LICENSE`, found: "duckdb_yyjson symbols" },
  { id: "jaro_winkler", name: "jaro_winkler", offered: "MIT", used: "MIT", file: "duckdb-jaro_winkler.txt", in: ALL, source: `${DUCKDB}/jaro_winkler/LICENSE`, found: "duckdb_jaro_winkler symbols" },
  { id: "concurrentqueue", name: "moodycamel::ConcurrentQueue", offered: "BSD-2-Clause", used: "BSD-2-Clause", file: "duckdb-concurrentqueue.txt", in: ALL,
    source: `${DUCKDB}/concurrentqueue/LICENSE`, found: "duckdb_moodycamel symbols" },
  { id: "fast_float", name: "fast_float", offered: "MIT", used: "MIT", file: "duckdb-fast_float.txt", in: ALL, source: `${DUCKDB}/fast_float/LICENSE`, found: "duckdb_fast_float symbols" },
  { id: "utf8proc", name: "utf8proc", offered: "MIT AND the Unicode data license", used: "MIT AND LicenseRef-Unicode-1991-2007", file: "duckdb-utf8proc.txt", in: ALL,
    source: `${DUCKDB}/utf8proc/LICENSE`, found: "utf8proc_ symbols" },
  { id: "zstd", name: "Zstandard", offered: "BSD-3-Clause", used: "BSD-3-Clause", file: "duckdb-zstd.txt", in: ALL, source: `${DUCKDB}/zstd/LICENSE`, found: "ZSTD_ symbols (Linux builds)" },
  { id: "httplib", name: "cpp-httplib", offered: "MIT", used: "MIT", file: "duckdb-httplib.txt", in: ["httpfs", "quack"], source: `${DUCKDB}/httplib/LICENSE`, found: "duckdb_httplib symbols" },
  { id: "hyperloglog", name: "hyperloglog", offered: "MIT", used: "MIT", file: "duckdb-hyperloglog.txt", in: ["quack", "ducklake", "postgres"], source: `${DUCKDB}/hyperloglog/LICENSE`, found: "duckdb_hll symbols" },
  { id: "pdqsort", name: "pdqsort", offered: "Zlib", used: "Zlib", file: "duckdb-pdqsort.txt", in: ["quack", "ducklake", "postgres"], source: `${DUCKDB}/pdqsort/LICENSE`, found: "duckdb_pdqsort symbols" },
  { id: "vergesort", name: "vergesort", offered: "MIT", used: "MIT", file: "duckdb-vergesort.txt", in: ["quack", "ducklake", "postgres"], source: `${DUCKDB}/vergesort/LICENSE`, found: "duckdb_vergesort symbols" },
  { id: "ska_sort", name: "ska_sort", offered: "BSL-1.0", used: "BSL-1.0", file: "duckdb-ska_sort.txt", in: ["quack", "ducklake", "postgres"], source: `${DUCKDB}/ska_sort/LICENSE`, found: "duckdb_ska_sort symbols" },
  { id: "miniz", name: "miniz", offered: "MIT", used: "MIT", file: "duckdb-miniz.txt", in: ["ducklake"], source: `${DUCKDB}/miniz/LICENSE`, found: "duckdb_miniz symbols" },
];

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
    "croft's packages rely on. What each file contains was read from the files themselves; the text of each license is the",
    "project's own, as fetched from the address given.",
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
      readFileSync(join(NOTICES_DIR, c.file), "utf8").trimEnd(),
      "",
    );
  }
  return `${parts.join("\n")}\n`;
}

# Add-ons: the DuckDB extension files server mode and lake mode need

Server mode (croft docs server-mode) loads two DuckDB extensions, quack and httpfs. Lake mode loads three: ducklake,
httpfs and postgres. croft never runs INSTALL and never downloads an extension, while it runs or at any other time.
The files come from an add-on: an optional npm package the project installs when it turns a mode on. A project that
turns no mode on installs nothing, and croft is the size it was.

| Mode | Add-on | Extension files |
|---|---|---|
| server mode (`"serverMode": {"enabled": true}`) | `@zabaca/croft-addon-server` | quack, httpfs |
| lake mode (a `"lake"` block in croft.json, croft docs lake) | `@zabaca/croft-addon-lake` | ducklake, httpfs, postgres |
| server mode over a lake (both settings) | both add-ons | quack, httpfs, ducklake, postgres |

A lake has a Postgres catalog. (A SQLite catalog and a local folder exist for croft's own tests only, and need DuckDB's sqlite
extension, which no add-on carries.)

## Installing one

Run it in the project's folder, once, when the mode is turned on:

    bun add @zabaca/croft-addon-server@<version>

`croft validate` and `croft doctor` say the exact command when a mode is on and its add-on is missing
(EXTENSION_MISSING, `details.install` and the fix in `--json`), so there is no need to remember it. The version is the one
this croft was tested with (`version` in `data.addons` of `croft validate --json`).

The add-on holds no code. Its optional dependencies are one package per extension and platform, such as
`@zabaca/croft-ext-quack-darwin-arm64`, each marked with the operating system, CPU and (on Linux) libc it is for, so that Bun
should install only the one for this machine (unverified: Bun did not apply those fields to packages installed from local
files, and no add-on has been published yet to try it on the registry; if every platform's file arrives, the install is
larger than the table below but works the same). The platforms are macOS and Linux with glibc, on arm64 and x64. Alpine and other musl systems and Windows are not covered: a mode there is
EXTENSION_MISSING with `details.kind` "platform", and no install changes that. What an install costs, for one platform
(download, then on disk):

| Add-on | macOS | Linux |
|---|---|---|
| server | 22 MB, 66 to 69 MB | 27 to 28 MB, 84 to 87 MB |
| lake | 35 to 36 MB, 109 to 113 MB | 43 to 45 MB, 136 to 141 MB |

## What croft does with them

croft looks for each file in the project's `node_modules` (and the ones above it, and the one beside its own install),
hashes it and compares it with the sha256 it pins for this DuckDB version and platform, then loads it by absolute path.
A file that differs is refused, however it got there: EXTENSION_CHECKSUM_MISMATCH, or EXTENSION_WRONG_BUILD when its own
footer says it is for another DuckDB or platform. After the install nothing needs the network.

`croft validate --json` has `data.addons` (one entry per add-on the project needs: `ok`, `installed`, `install`, and
each extension's `source`: "addon", "dir" or "cache"), `croft doctor --json` an `addon.<name>` check with the same under
`details`, and `croft status --json` `data.serverMode.addons` (server mode) and `data.lake.addons` (lake mode).

## Licenses

Each extension file is DuckDB's own build and is under DuckDB's MIT license (`LICENSE` in its package). The files link other
projects' code statically, so each extension package also carries `THIRD_PARTY_NOTICES.txt` with those projects' licenses,
and a `license` field that names them all as an SPDX expression. What was found in the files themselves (read with `strings`,
`nm` and a scan of the bytes, on the macOS and Linux files of all four extensions; a project is listed if any platform's
file shows it):

| Extension | Linked, besides DuckDB's own sources |
|---|---|
| httpfs | OpenSSL 3.6.0 (Apache-2.0), libcurl 8.21.0 (curl), zlib 1.3.2 (Zlib) |
| quack | OpenSSL 3.6.0 (Apache-2.0) |
| postgres | libpq 18 (PostgreSQL), OpenSSL 3.6.0 (Apache-2.0) |
| ducklake | CRoaring (Apache-2.0 OR MIT, taken under Apache-2.0) |

All four also contain parts of the third-party sources in DuckDB's own tree. The Linux builds compile in more of them than the
macOS builds (jemalloc, FSST, nanoarrow, SkipList, FastPFor), and every one seen on any platform has its notice in each
package: Mbed TLS, RE2, {fmt}, yyjson, jaro_winkler, moodycamel's queue, fast_float, utf8proc, Zstandard, hyperloglog, miniz,
jemalloc, FSST, SkipList, FastPFor and nanoarrow, cpp-httplib (httpfs, quack) and pdqsort, vergesort and ska_sort (quack,
ducklake, postgres). The notices are kept complete by a check that the add-on build runs on all 16 files
(`scripts/check-notices.ts`): it fails when a file shows a component the package does not list, by a marker, by a vendored
namespace, or, on Linux, by the name of a source file that no listed project and nothing in DuckDB's own tree owns. The
macOS files are stripped of source names, so there only markers and namespaces can show a library. This was read from the binaries and DuckDB's source tree by a person with tools, not
by a lawyer.

## Publishing the add-ons (for croft's maintainers)

The packages are published by `.github/workflows/publish-addons.yml`, a manual run that builds and measures by default and
publishes only when told to, with a typed confirmation and the version `ADDON_VERSION` holds. Two of its checks cannot be
enforced by a file in the repository, because anyone who can push a branch can edit the file and run it from there, so
before the first publish the maintainer sets up GitHub and npm:

1. On GitHub, create the `npm-addons` environment (Settings, Environments) before the first run: a run that names an
   environment that does not exist creates it with no protection. Give it a deployment-branch rule that allows `main` only
   and the maintainer as required reviewer.
2. Publish the first version of each of the 18 packages by hand from a machine logged in to npm (the build job's tarballs are
   the files to publish): npm cannot set up trusted publishing for a package that does not exist yet.
3. On npmjs.com, for each of the 18 packages, set the trusted publisher to this repository, the workflow file
   `publish-addons.yml` and the environment `npm-addons` (`npm trust github`, npm 11.15 or newer), so that npm itself refuses a
   publish from any other workflow, branch or environment.
4. Run the workflow once with `publish` left at `build-only` and read the sizes in its summary, then again to publish.

## For croft's own tests

`$CROFT_EXTENSION_DIR`, when set, is the only place croft looks, in DuckDB's own layout
(`<folder>/v<DuckDB version>/<platform>/<file>.duckdb_extension`); the croft repository's scripts/fetch-extensions.ts fills
one. With neither a folder nor an add-on, `~/.cache/croft/test-extensions` (that script's default) is used if it holds the file.
Both are checked against the same pins.

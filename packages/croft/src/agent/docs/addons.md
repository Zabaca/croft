# Add-ons: the DuckDB extension files server mode and lake mode need

Server mode (croft docs server-mode) loads two DuckDB extensions, quack and httpfs. Lake mode loads three: ducklake,
httpfs and postgres. croft never runs INSTALL and never downloads an extension, while it runs or at any other time.
The files come from an add-on: an optional npm package the project installs when it turns a mode on. A project that
turns no mode on installs nothing, and croft is the size it was.

| Mode | Add-on | Extension files |
|---|---|---|
| server mode (`"serverMode": {"enabled": true}`) | `@zabaca/croft-addon-server` | quack, httpfs |
| lake mode (no setting turns it on in this release) | `@zabaca/croft-addon-lake` | ducklake, httpfs, postgres |

## Installing one

Run it in the project's folder, once, when the mode is turned on:

    bun add @zabaca/croft-addon-server@<version>

`croft validate` and `croft doctor` say the exact command when a mode is on and its add-on is missing
(EXTENSION_MISSING, `details.install` and the fix in `--json`), so there is no need to remember it. The version is the one
this croft was tested with (`version` in `data.addons` of `croft validate --json`).

The add-on holds no code. Its optional dependencies are one package per extension and platform, such as
`@zabaca/croft-ext-quack-darwin-arm64`, and Bun installs only the one for this machine. The platforms are macOS and Linux
with glibc, on arm64 and x64. Alpine and other musl systems and Windows are not covered: a mode there is
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
`details`, and `croft status --json` `data.serverMode.addons`.

## For croft's own tests

`$CROFT_EXTENSION_DIR`, when set, is the only place croft looks, in DuckDB's own layout
(`<folder>/v<DuckDB version>/<platform>/<file>.duckdb_extension`); the croft repository's scripts/fetch-extensions.ts fills
one. With neither a folder nor an add-on, `~/.cache/croft/test-extensions` (that script's default) is used if it holds the file.
Both are checked against the same pins.

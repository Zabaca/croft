# Extension files: the DuckDB extensions server mode and lake mode load

Server mode (croft docs server-mode) loads two DuckDB extensions, quack and httpfs. Lake mode (croft docs lake) loads
three: ducklake, httpfs and postgres. A project that turns neither on loads no extension, reaches no extension server
and is the size it was.

croft publishes none of these. They are DuckDB's own signed builds, and DuckDB publishes them at
`https://extensions.duckdb.org/v<DuckDB version>/<platform>/<name>.duckdb_extension.gz`. croft fetches the files it needs
from there, checks each against a checksum it pins, keeps them on the machine and loads them by absolute path. It never
runs `INSTALL`, never autoloads, and never turns off DuckDB's signature check (a file DuckDB did not sign does not load).

| Mode | Extension files |
|---|---|
| server mode (`"serverMode": {"enabled": true}`) | quack, httpfs |
| lake mode (a `"lake"` block in croft.json) | ducklake, httpfs, postgres |
| server mode over a lake (both settings) | quack, httpfs, ducklake, postgres |

For one platform the download is about 21 MB (server mode) or 34 MB (lake mode), and the unpacked files take about 66 MB or
109 MB on disk (macOS arm64; Linux files are larger). They live in croft's cache folder, `$XDG_CACHE_HOME/croft/extensions` (else
`~/.cache/croft/extensions`), shared by every project on the machine, in DuckDB's own layout
(`v<DuckDB version>/<platform>/<file>.duckdb_extension`). `$CROFT_EXTENSION_DIR` names another folder instead (an image
that holds the files, croft's tests).

## When croft fetches

Only when a mode needs a file this machine does not have, and always before the mode locks its DuckDB instance:

- The first time `croft serve` (server mode), or a command that opens the lake, starts and finds a file absent, it
  fetches that file, says so on stderr (`croft: fetching DuckDB's quack extension ...`) and goes on. This is the one place
  croft reaches the network for a mode, once per file. A running, locked instance never fetches.
- `croft fetch-extensions` fetches ahead of time, for a machine that has no network when croft runs (an image built with
  the files in it, a server behind a firewall): run it where there is network, in the project (it fetches what the
  project's modes need), or name the extensions, or `--all`. A file already there and correct is left alone; a file that
  fails its check is replaced. `croft validate`, `croft doctor` and `croft status` fetch nothing; they report. A fetch that
  was killed can leave a `.part-` file beside the target; the next fetch of that file removes the ones over a minute old.
- `$CROFT_NO_FETCH=1` turns the first-use fetch off: a missing file is then EXTENSION_MISSING and `croft fetch-extensions`
  is the only way a file arrives. `$CROFT_EXTENSION_REPO` names another repository (a mirror); every file is still held to
  the same checksum, so a mirror cannot change what loads.

## Scheduled runs

A scheduled run (`croft schedule on`) starts from the per-user OS job, not from your shell, so it does not see your shell's
environment. The four settings that change where the files are or whether they are fetched, `$CROFT_EXTENSION_DIR`,
`$CROFT_NO_FETCH`, `$CROFT_EXTENSION_REPO` and `$XDG_CACHE_HOME`, are therefore copied into the job from the shell that ran
`croft schedule on` (a folder made absolute), and `croft schedule on` says which it carried. Without them a scheduled run would
look in the default cache folder, fetch the files a second time, or fail offline. Change a setting and run `croft schedule on`
again to give the job the new one. `croft doctor` warns, for a project with a mode on and scheduling through the OS job, when
this shell's settings are not the job's (it names the settings, never their values). The job file is readable by other users of
the machine, so keep a login out of `$CROFT_EXTENSION_REPO`.

## What the checks say

`croft validate`, `croft doctor` and `croft status` look for each file a mode loads and hash it against the sha256 croft
pins for this DuckDB version and platform. A file that is not on the machine is EXTENSION_MISSING with the command that
fetches it (`croft fetch-extensions httpfs quack`, in `fix.command` and `details.fetch`); a file that differs is
EXTENSION_CHECKSUM_MISMATCH, or EXTENSION_WRONG_BUILD when its own footer says it is for another DuckDB or platform, with
the same command as the fix (it replaces the file). A fetch that could not finish (no network, the server refusing) is
EXTENSION_FETCH_FAILED (with `details.kind` "write" when the file arrived whole but could not be stored, such as a folder
where the file goes); a download whose checksum differs from the pin is EXTENSION_CHECKSUM_MISMATCH with
`details.kind` "download", and nothing is written.

`croft validate --json` has `data.extensionFiles` (one entry per mode the project needs: `ok`, `fetch`, and each
extension's `ok`, `path` and `code`), `croft doctor --json` an `extensions.<mode>` check with the same under `details`,
and `croft status --json` `data.serverMode.extensionFiles` (server mode) and `data.lake.extensionFiles` (lake mode).

The platforms are macOS and Linux with glibc, on arm64 and x64. Alpine and other musl systems and Windows are not
covered: a mode there is EXTENSION_MISSING with `details.kind` "platform", and no fetch changes that.

## What the first use needs

The network and DuckDB's servers, once per machine and DuckDB version. After that nothing needs the network for the files.
A project that cannot have that (an air-gapped host) fetches on a machine that can, with `$CROFT_EXTENSION_DIR` pointing at
a folder it copies to the host, laid out as above.

## Licenses

croft downloads DuckDB's files straight from DuckDB and redistributes none of them. Each file is DuckDB's own build under
DuckDB's MIT license, and DuckDB's extension repository and sources carry the notices of the code each links.

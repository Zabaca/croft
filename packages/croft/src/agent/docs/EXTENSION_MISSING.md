# EXTENSION_MISSING: a DuckDB extension file croft's mode needs is not there

A croft mode (server mode, lake mode) loads exactly the DuckDB extensions it needs, from files croft pins by
checksum. It never runs INSTALL and never downloads anything while it runs. The file for this mode, this DuckDB
version and this platform was not found, so the mode did not start and nothing was loaded. `croft validate`,
`croft doctor` and `croft status` report it before `croft serve` has to fail on it. details.kind says why:

- "addon" (the usual case): the project turned a mode on and has not installed the add-on that carries its extension
  files (croft docs addons). details.addon is "server" or "lake", details.package the npm package,
  details.version the version this croft was tested with, details.extension and details.extensionPackage the file
  that was looked for, details.installed whether the add-on's own package is in node_modules (true means the file
  for this machine did not arrive with it: install it again), details.missing every extension that was not found,
  and details.install the command, which is also the fix.
- "file": a folder was named ($CROFT_EXTENSION_DIR, croft's own tests and builders) and the file is not in it.
  details.path is where croft looked. With $CROFT_EXTENSION_DIR set, the add-on is not looked for at all.
- "platform": croft pins no extension for this operating system and CPU. The modes run on macOS and on Linux with
  glibc, on x64 and arm64; Alpine and other musl systems and Windows are not covered, and no install fixes it.

The project's data was not touched.

What to do:
- For kind "addon", run the fix. It is `cd <project> && bun add @zabaca/croft-addon-server@<version>` (or
  `...-addon-lake`), run in the project's folder, and it adds one dependency to package.json: about 22 to 28 MB to
  download and 66 to 87 MB on disk for the server add-on, about 35 to 45 MB and 109 to 141 MB for the lake add-on, for
  this machine's platform only. Then run `croft validate` again; it passes when every file is found and matches its pin.
  croft needs nothing from the network after that.
- A project that does not need the mode can turn it off instead: remove `"serverMode"` from croft.json, which is the
  user's decision.
- For kind "file", fill the folder with the pinned files (the croft repository's scripts/fetch-extensions.ts), or unset
  $CROFT_EXTENSION_DIR and install the add-on.
- For kind "platform", this machine cannot run the mode; ask the user.
- Do not copy an extension file from another DuckDB install or download one by hand: croft refuses a file whose
  checksum differs (EXTENSION_CHECKSUM_MISMATCH).

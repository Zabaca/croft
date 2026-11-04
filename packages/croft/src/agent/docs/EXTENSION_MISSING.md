# EXTENSION_MISSING: a DuckDB extension file croft's mode needs is not on this machine

A croft mode (server mode, lake mode) loads exactly the DuckDB extensions it needs, from files croft pins by checksum.
It never runs INSTALL. The file for this mode, this DuckDB version and this platform is not on the machine, so the mode
did not start and nothing was loaded. `croft validate`, `croft doctor` and `croft status` report it before `croft serve`
has to fail on it. details.kind says why:

- "file" (the usual case): the project turned a mode on and croft has not fetched its extension files yet. croft fetches
  them from DuckDB's extension servers the first time the mode starts, but this run did not: fetching is off
  ($CROFT_NO_FETCH), or this is `croft validate`, `croft doctor` or `croft status`, which fetch nothing.
  details.extension is the first file missing, details.missing every one, details.path where croft looked and
  details.fetch the command, which is also the fix. details.mode ("server" or "lake") says which mode, in validate,
  doctor and status.
- "platform": croft pins no extension for this operating system and CPU. The modes run on macOS and on Linux with
  glibc, on x64 and arm64; Alpine and other musl systems and Windows are not covered, and no fetch fixes it.

The project's data was not touched.

What to do:
- For kind "file", run the fix, `croft fetch-extensions httpfs quack` (the extensions named in details.missing). It
  needs the network once, about 22 MB for server mode or 35 MB for lake mode, and keeps the files in croft's cache
  folder, shared by every project on the machine (croft docs extensions). Then run `croft validate` again; it passes
  when every file is there and matches its pin.
- A project that does not need the mode can turn it off instead: remove `"serverMode"` from croft.json, which is the
  user's decision.
- For kind "platform", this machine cannot run the mode; ask the user.
- Do not copy an extension file from another DuckDB install or download one by hand: croft refuses a file whose
  checksum differs (EXTENSION_CHECKSUM_MISMATCH).

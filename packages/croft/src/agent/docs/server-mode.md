# Server mode: croft serve answers from the read copy and never opens the warehouse

In server mode apps read while runs write, and nobody waits for anybody. croft's writes do not change: `croft run`
and the scheduler's runs still write the warehouse in short-lived processes. What changes is the reader. croft serve
stops holding the warehouse file. It answers from a readers' process that holds only the read copy, which every run
that changes data refreshes at its end. A run never waits for croft serve, and an app is never told "busy, retry"
because a run is writing. The price is freshness: an answer is as of the end of the last run that changed data, and
during a long run that can be minutes old. Every answer says as of when.

Turn it on in croft.json (the user decides; it changes what apps see):

  "serverMode": { "enabled": true }

That turns the read copy on too. Then, as before, the user starts `croft serve` in their own terminal. Nothing else
changes for apps: they keep reading with `query()` from @zabaca/croft/read and the same token. A project that never
turns server mode on is unchanged, and so is one that turns it off again.

## What an app and a person see

- The query envelope's data carries `asOf`, the read copy's time (the checkpoint it was taken at, in the project
  offset). It never carries `stale`: in server mode every answer is from the copy.
- Before the first run that changes data there is no copy: queries are DB_NOT_FOUND, and croft serve picks the copy up
  within a second of its appearing.
- `croft status` and `croft doctor` say the project is in server mode, the copy's as-of time, and whether croft serve is
  running. GET /health carries `serverMode: {state, asOf}`.
- The app token reads every table of the project, as it always did. Keys for individual people, and DuckDB clients
  over Quack, are not part of this build.

## The read copy is read-only on disk

In server mode croft marks the copy read-only (mode 0444) before it renames it into place, and croft serve attaches
it read-only. Tools that open a file read-write by default, the DuckDB UI and DBeaver, now have to be told to open
warehouse.read.duckdb read-only: attach it with `ATTACH 'warehouse.read.duckdb' (READ_ONLY)` (or open it with
access_mode READ_ONLY), or set the connection read-only in the tool. A read-write open fails on the file's
permissions. This is a change for those tools; the live warehouse.duckdb is free between writes, as it always was,
because croft serve no longer holds it. Turning server mode off leaves the copy read-only until the next refresh,
which writes it with the usual permissions.

## How it works, and what it costs

- croft serve starts a child process, the readers' process: an in-memory DuckDB that loads DuckDB's quack and httpfs
  extensions by path, attaches the read copy read-only, and locks itself down to that one file. It checks the copy's
  identity (device, inode, modification time and size) every 250 ms. When a refresh renames a new copy into place it
  detaches the old one and attaches the new one, a few milliseconds, with its connections kept.
- A query past serve.queryTimeoutMs that interrupts cannot stop ends the readers' process; a new one starts at once.
  Queries running at that moment get a retryable SERVE_UNAVAILABLE (reason "restarted"), which `query()` retries. A
  process that cannot start ends itself and is started again after a wait (none, then 250 ms doubling to 5 s).
- Stopping croft serve (Ctrl-C, SIGTERM) ends the readers' process first and exits 0, even with a query running.
- One refresh per run, at its end, so the copy shows every table at one consistent point. A run that failed partway
  still refreshes the copy when a step committed.
- Disk and time: where the filesystem can clone files (macOS APFS, btrfs, XFS with reflinks) a refresh takes
  milliseconds and about no extra disk. Elsewhere (ext4, the usual Linux filesystem) it is a full copy: as much disk
  again as the warehouse, and the run holds its write lease while it copies. `croft doctor` and `croft status` warn
  with the numbers (READ_COPY_NOT_CLONED), and server mode refuses to start there when the warehouse is over 1 GB
  (SERVER_MODE_COPY_COSTLY) unless the user accepts the cost:

  "serverMode": { "enabled": true, "acceptFullCopyCost": true }

  Accepting a cost is the user's decision: ask them first.

## The extension files

Server mode loads two DuckDB extension files, quack and httpfs, by absolute path, after checking each against a
checksum croft pins; croft never runs INSTALL and never downloads anything while it runs. In this build the files come
from a folder: $CROFT_EXTENSION_DIR, else ~/.cache/croft/test-extensions, laid out as DuckDB lays out its own
(v2.0.0/<platform>/quack.duckdb_extension). Filling the folder is `bun scripts/fetch-extensions.ts` from the croft
repository. A missing or different file is EXTENSION_MISSING, EXTENSION_CHECKSUM_MISMATCH or EXTENSION_WRONG_BUILD
and croft serve does not start (croft docs EXTENSION_MISSING). How a user gets the files without the repository is not
built yet.

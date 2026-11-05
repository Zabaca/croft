# Lake mode: the warehouse is a DuckLake, written by one machine and read by anyone given access

By default a project's warehouse is one DuckDB file on one machine. In lake mode it is a DuckLake instead: a catalog
(a Postgres database) and the table data as Parquet files in a bucket folder of an S3-compatible store (R2, S3, MinIO).
The data then outlives the machine, and readers never wait for a run: everyone reads the snapshot that was last
committed while the writer works on the next. It is opt-in, and a project that never names a lake is the file it was:
nothing is loaded, nothing changes.

You use croft as before: `croft run`, `query`, `status`, `describe`, `delete`, `restore`, `rename`, `preview`, `backup`,
the scheduler, `croft serve`; `croft maintain` for the lake's housekeeping; and `croft move-to-lake` to move a project
that keeps a file into a lake. Writes stay all-or-nothing with their bookkeeping, checks run before saving, and the trash
stays on the writing machine as local files. What lake mode adds is a setup that is more than "a first warehouse in
minutes": a Postgres, a bucket folder, two logins and two bucket keys. Turning it on is the user's decision.

## Setting it up (shared lake)

Whoever runs the Postgres and the bucket makes:
- a Postgres database for the catalog, with two logins: a writer that owns it, and a read-only login (SELECT only);
- a bucket and, in it, a folder that holds NOTHING BUT this lake: DuckLake's own cleanup deletes any file in the folder
  that it does not recognise, so never put anything else there (croft doctor says so);
- two bucket keys: one that writes the folder, one that can only read it.

The project names them in croft.json, by the NAMES of the secrets that hold the passwords and keys (never the values):

    "lake": {
      "catalog": {
        "kind": "postgres", "host": "db.example.com", "port": 5432, "database": "croft_lake",
        "writer": { "user": "croft_writer", "passwordSecret": "LAKE_WRITER_PASSWORD" },
        "reader": { "user": "croft_reader", "passwordSecret": "LAKE_READER_PASSWORD" }
      },
      "bucket": {
        "name": "my-bucket", "folder": "croft/orders/", "endpoint": "abc123.r2.cloudflarestorage.com", "region": "auto",
        "writer": { "keyIdSecret": "LAKE_WRITER_KEY_ID", "secretKeySecret": "LAKE_WRITER_KEY" },
        "reader": { "keyIdSecret": "LAKE_READER_KEY_ID", "secretKeySecret": "LAKE_READER_KEY" }
      }
    }

The catalog's connection uses TLS, and which check croft makes is a setting of the catalog block (`sslMode`, `sslRootCert`):

- `"verify-full"`: encrypt, and check that the server's certificate is signed by a certificate authority croft trusts and was
  issued for the name in `host`. This is the default for any catalog that is not on this machine, and the right choice for a
  hosted Postgres (Neon, Supabase, RDS): the password and every catalog row cross the internet, and an unchecked certificate
  lets anyone in the path read them. croft trusts this machine's CA bundle (`$SSL_CERT_FILE`, else /etc/ssl/cert.pem on macOS,
  /etc/ssl/certs/ca-certificates.crt on Debian and Ubuntu, /etc/pki/tls/certs/ca-bundle.crt on Fedora and RHEL), or the PEM file
  `"sslRootCert"` names (relative to the project folder; `~/` is the home folder). With neither, croft refuses with CONFIG_INVALID naming the setting; it
  never skips the check. Use the host name the certificate was issued for (a provider's direct endpoint, not an IP address).
- `"require"`: encrypt, and do not check the host name (libpq also verifies the certificate chain if a root.crt exists in
  the user's ~/.postgresql, which croft does not set up). `"prefer"`: encrypt when the server offers TLS, otherwise go on in plaintext (what croft did
  before this setting, and the default for `localhost` and `127.x.x.x`). `"disable"`: never encrypt. `croft doctor` warns about
  each of these on a catalog that is on another machine. A catalog with no TLS (a Postgres you run yourself) needs one of them
  written down, with the user's say-so: it is a decision that its password may be read on the network, and croft will not make it
  by itself. A failed check is LAKE_ATTACH_FAILED with `details.tls: true`, not retryable.

    "catalog": { "kind": "postgres", "host": "ep-example-123456.c-4.us-west-2.aws.neon.tech", "database": "croft_lake", "sslMode": "verify-full", … }

The secrets live in .env, the shell or the secretsFrom command, like any other (croft docs secrets). The lake loads DuckDB's
ducklake, httpfs and postgres extensions, which croft fetches from DuckDB's own extension servers the first time the lake
opens (a download of about 34 MB, about 109 MB on disk once unpacked, once per machine; croft docs extensions). To have them first, and to see what is missing, run:

    croft fetch-extensions
    croft validate && croft doctor && croft run

The store is reached over HTTPS, and croft checks its certificate against one CA file it lets DuckDB read: the file
`lake.bucket.sslRootCert` names (relative to the project folder), for a store whose certificate a private authority signed;
else the file `$SSL_CERT_FILE` names (in `.env` or the shell); else this machine's own CA bundle, which is all a store with
a public certificate (R2, S3) needs. A certificate that does not check out, or a machine with no bundle, fails every read
and write of the bucket with LAKE_STORE_TLS, in whichever command meets it. `croft doctor` lists the bucket's folder and reads the footer of one data
file with the read-only key before the first run, so a store croft cannot reach is found before `croft run` fails on it;
it writes nothing, and says whether the catalog's connection is encrypted as the client knows it: `verify-full` and `require`
make libpq end a connection the server will not encrypt, `disable` never encrypts, and under `prefer` it asks the server the
question libpq asks first (may we use TLS), because a Postgres that offers no TLS is then reached in plain text without a word
from the client. It never asks the database whether the connection is encrypted: behind a pooler or a proxy the database sees
only the last hop, and says plain text of a connection that was checked. When it cannot know it says so and does not warn.

The first `croft run` creates the lake, at DuckLake format 1.0 (so DuckDB 1.5 can read it too). croft never lets
DuckLake migrate a catalog by itself. The writer's login and key are used only by commands that write; `croft serve`,
`croft query`, `croft status`, `croft doctor` and the rest attach read-only with the read-only login and key. The
read-only key is what keeps a reader that got past the gate out of the bucket, so it must not be able to write.

## A catalog far away

A hosted catalog is a round trip away from the machine that runs croft, and DuckLake pays the catalog several round trips for
every transaction. croft keeps what a command asks of the lake in few transactions: a read is one, an ingest reads its own
state once, and `croft doctor` reads the lake once. At 41 ms, on a four-asset project, a run with nothing new takes about 5 s,
a `croft query` about 2.7 s and `croft doctor` about 5 s (see `docs/benchmarks/2026-11-03-lake-latency.md` and
`docs/benchmarks/2026-11-05-lake-start.md` in croft's source). A command on a lake costs at least 1.8 s at that distance
whatever croft does (DuckLake attaches the catalog and loads it), 2.9 s when it reads croft's own tables (DuckLake loads the
catalog a second time to read them, 1.1 s more), and a step that writes about 7 s, so put the catalog near the machine
that writes it.

`croft doctor` leaves a lake's tables out of its comparison with croft's record (each costs the catalog's round trips);
`croft doctor --tables` compares them all. If doctor warns with LAKE_BOOKKEEPING_IN_FILES, croft's own
tables are in files of the bucket and not in the catalog, where every command reads them over the network: `croft maintain` brings them back.

A catalog database that holds another lake is LAKE_CATALOG_MISMATCH: another DuckLake format, or a lake whose files are in
another bucket folder than `lake.bucket` names. croft never migrates a lake and never overrides its data path; point
`lake.catalog.database` at a database of croft's own.

## One writing machine

One machine writes a lake, one write at a time. croft takes a lock of its own on the machine (`.croft/lake-write.lock`)
in place of the file's lock: a second `croft run` waits for the first, then gets DB_BUSY naming the holder; a writer
that was killed is reclaimed by the next. Every write records which machine made it (`_croft.meta`, one row `writer.<machine>` each),
and `croft doctor` warns with LAKE_OTHER_WRITER when another machine has written since this machine's last write. Writing from two machines is not
supported: they would not know of each other's runs. Every machine keeps a record of its own, ordered by a counter that follows the
lake's commit order (never by a machine's clock, which may run behind), so one machine's write does not hide another's.
The warning stays for 7 days after the other machine's write (or after the write of this machine that found it), however
many clean writes this machine makes meanwhile, and names the other machine and when it wrote. A machine is told apart by the platform's machine id; where that changes at every start (some
containers), set CROFT_MACHINE_ID to a fixed name in the environment that runs croft. Two copies of one project folder on
one machine are one machine to croft: they share the id, and neither the lock nor the warning tells them apart.

A lost connection is mended by croft: a read whose catalog connection dropped is tried again, and a write is tried again
as a whole after croft checks by the tag its commit carries whether the commit landed (a landed commit is never run
again). What is left is LAKE_CONNECTION_LOST or LAKE_COMMIT_UNCERTAIN.

## Maintenance: croft keeps the lake short, and keeps the trash's promise

DuckLake never deletes an old data file by itself. Every commit is a snapshot, a write of a few rows is kept inside the
catalog, and a replaced file stays until a snapshot expiry and a cleanup say so: a simulated week of hourly runs over
five assets left 849 snapshots, 841 files, 176 tables of rows kept in the catalog and a 12 MB catalog. So croft runs the
lake's maintenance itself, one step at a time, in this order:

  prune     croft's own bookkeeping log loses the rows a newer row of the same key has superseded
  flush     the rows DuckLake kept inside the catalog become files (the assets' tables only: croft's own bookkeeping,
            `_croft`, stays in the catalog, where reading it is one round trip, not a listing and a read of the store)
  expire    the snapshots outside the promise go, by an explicit list croft computes
  merge     small files become fewer, larger ones (every version still reads back)
  rewrite   files that are mostly deleted rows are rewritten
  cleanup   the files nothing refers to are deleted at once (DuckLake waits 2 days by default)

What a pass keeps is the trash's promise (croft docs trash), and it is not a setting: every snapshot of the last 30
days (and an hour more, so that a clock a little off, croft's or the catalog's, does not move the edge), the newest snapshot before them (the state when the window began), each asset's 5 newest versions however old (a
version is a snapshot in which the asset's table changed), and every snapshot the trash pins (the one a trashed version
was taken from). Everything else is expired. Nothing the promise keeps is ever deleted: a kept version reads back
exactly, and a version outside both limits is gone. A person reads one with `AT (TIMESTAMP => '2026-10-20 12:00')` in
`croft query` (or their own DuckDB, where `FROM lake.snapshots()` lists the versions and `AT (VERSION => 41)` names one);
a snapshot that was expired answers "No snapshot found".

When it runs: after a run, and from the scheduler's tick, once the last pass that worked is `lake.maintenance.everyHours`
old (24; an hour after a pass that failed). A lake croft has not seen before is stamped when it is first looked at, so
a new lake is not maintained on its first day. `lake.maintenance.enabled: false` stops this, and `croft maintain` still
runs a pass by hand. A pass takes croft's lock on the lake's writes for its whole body: it never runs while a write holds
the lock, and a write waits for it (a pass takes seconds; a long one shows in the wait's message). A pass that fails
never fails a run: the failure shows in `croft status` and `croft doctor` (LAKE_MAINTENANCE_FAILED, a warning). Another
pass is due an hour after the failed one, and the next croft run, or the scheduler's next tick when `croft schedule` is
on, makes it; nothing runs by itself otherwise, so `croft maintain` makes it at once. A store that answers HTTP 500, or a connection that drops, is tried again four times first.

  croft maintain               a pass now, whatever the interval; --json has each step, the lake's counts before and after
  croft maintain --dry-run     what a pass would expire and keep, from the read-only login; nothing changes
  croft maintain --orphans     the files in the lake's folder that the lake does not own and that are older than a day (the
                               cutoff is fixed when the list is made and kept by the confirmation): listed, and deleted
                               only through croft confirm, for exactly that list

`croft maintain` removes nothing the promise keeps, so it needs no confirmation. Deleting files that are not the lake's
own does, because croft cannot vouch for them: a pass never does it, and they are gone for good.

croft never calls CHECKPOINT on a lake and never sets an option on one (a test holds both, and the warehouse refuses the
statements). CHECKPOINT runs DuckLake's maintenance from the lake's stored options, so an age-based expiry set by anyone
would expire a snapshot the trash pinned, and it deletes any file in the folder that is not the lake's. `croft doctor`
warns with LAKE_EXPIRY_OPTION when an age-based expiry is set on the lake; croft's own pass ignores it.

The prune step is croft's own housekeeping: every run appends a row for each asset's state to the bookkeeping log, and the
views croft reads show only the newest row of each key, so the older rows are read by nothing and make every read and write
scan more. The step removes them (and the rows of a key that was closed, a renamed or deleted asset's old name), so the log
is one row for each live key; what the views show is the same before and after, and the trash and restore are unaffected.

`croft doctor` and `croft status` show when maintenance last worked and what the lake holds: snapshots, files, the
tables that keep small inserts inside the catalog, and files freed but not yet deleted. What it does to a lake of five
assets run hourly: after a week the catalog held 842 snapshots, 839 files and 181 inlined tables; a pass takes about a
second and leaves, once the week is older than 30 days, 28 snapshots, 26 files and 18 tables, and in a steady state
(30 days of hourly runs kept) it takes 0.2 to 0.5 s. Those figures were measured when the flush took every schema; the
fall in tables that keep rows inside the catalog now holds for the assets' schema (`main`) only. croft's own bookkeeping
tables (`_croft`) stay inlined, so a count of such tables from `croft doctor` includes them and is that much higher than
those figures. The catalog's size on disk is Postgres's to give back (VACUUM FULL); the rows it holds are what fall.

## Backups of a lake

`croft backup` of a lake copies the catalog with pg_dump (as the read-only login) and mirrors the bucket folder (with
the read-only key), taken as one moment, with run history and the trash (croft docs backup). It needs the Postgres client
tools on the machine (LAKE_BACKUP_TOOL_MISSING says how to get them). Writes wait for the catalog's dump, which takes
seconds, and carry on while the folder is copied; a backup that is copying keeps this machine's maintenance from running.

## Reading

- `croft query`, `status`, `describe`, `context`, `doctor`: as before.
- Apps: through `croft serve` (`@zabaca/croft/read` finds it). In a lake project croft serve reads the last snapshot
  with the read-only login and key, never steps aside for a run and never answers "busy". Direct mode, which opens the
  warehouse file, refuses (LAKE_DIRECT_READ). A key (croft serve key) works in server mode only: with
  `"serverMode": {"enabled": true}` croft serve serves people over a lake too (below).
- People with a key, over HTTP or from their own DuckDB 2.0 over Quack: server mode over a lake (below). They hold no
  catalog login and no bucket key, and read only the tables the project shares.
- Analysts, from their own DuckDB 2.0, without croft: whoever runs the Postgres makes a login that can only read, and
  the bucket a key that can only read the folder. They see every table of the lake (a key, from server mode over a
  lake, limits a person to chosen tables instead). The recipe, run by the person who runs the Postgres:

```sql postgres-admin
CREATE ROLE <analyst> LOGIN PASSWORD '<analyst_password>';
GRANT CONNECT ON DATABASE <database> TO <analyst>;
GRANT USAGE ON SCHEMA public TO <analyst>;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO <analyst>;
ALTER DEFAULT PRIVILEGES FOR ROLE <writer> IN SCHEMA public GRANT SELECT ON TABLES TO <analyst>;
```

  and by the analyst, in DuckDB 2.0 (INSTALL fetches the extensions once; croft is not involved). `<data_path>` is the
  lake's folder exactly as `croft doctor` prints it, `s3://<bucket>/<folder>/`, with ONE slash at the end: a second
  slash (`.../trial-1//`) names another place in the bucket, where the catalog still answers a count but every read of
  a data file is a 404.

```sql duckdb-reader
INSTALL ducklake; INSTALL postgres; INSTALL httpfs;
CREATE SECRET lake_catalog (TYPE postgres, HOST '<host>', PORT <port>, DATABASE '<database>', USER '<analyst>', PASSWORD '<analyst_password>', SSLMODE '<sslmode>', SSLROOTCERT '<ca_file>');
CREATE SECRET lake_files (TYPE s3, KEY_ID '<key_id>', SECRET '<key_secret>', ENDPOINT '<endpoint>', URL_STYLE 'path', USE_SSL <use_ssl>, SCOPE '<data_path>');
ATTACH 'ducklake:postgres:' AS lake (META_SECRET lake_catalog, DATA_PATH '<data_path>', READ_ONLY);
USE lake;
```

  For a catalog on another machine, `<sslmode>` is `verify-full` and `<ca_file>` is a file of trusted certificate authorities
  (/etc/ssl/cert.pem on macOS, /etc/ssl/certs/ca-certificates.crt on Debian and Ubuntu): without them the analyst's DuckDB does not
  check the server it sends the password to. For a catalog on the same machine, `<sslmode>` is `prefer` and `<ca_file>` is any
  existing file. DuckDB's libpq takes both options as they are, and `sslrootcert=system` is not a form to rely on.

  INSTALL downloads each extension from DuckDB's repository, extensions.duckdb.org, over plain HTTP, and fails behind a
  proxy or firewall that refuses plain HTTP. Fetch the three files where plain HTTP is allowed, or take them
  from the folder where croft keeps them (`croft fetch-extensions` puts them in `~/.cache/croft/extensions/v2.0.0/<platform>/`,
  the same files for the same DuckDB 2.0), and `LOAD '/path/to/ducklake.duckdb_extension'` (likewise
  `postgres_scanner.duckdb_extension` and `httpfs.duckdb_extension`) in place of each INSTALL.

  They then query the tables, and `FROM lake.snapshots()` or `SELECT ... FROM t AT (VERSION => <n>)` show the lake as it
  was, for every version the maintenance keeps (30 days, and each table's 5 newest versions). An attempt to write a table, or a file in the bucket, is refused (by the attach, by the store, by Postgres).
  Never give an analyst the writer's login or key, and never put a password in the ATTACH text: it shows in errors and
  in `duckdb_databases()`.

## Server mode over a lake: people with a key, and no credentials to hand out

With `"serverMode": {"enabled": true}` in a lake project, croft serve gives each person a key (croft docs keys) instead of
the read-only catalog login and bucket key. The user decides it, as for any project (croft docs server-mode). There is no
read copy: croft serve's readers' process attaches the lake itself, read-only, with the read-only login and key, and reads
the last snapshot whenever it is asked. People see each commit on their next query, over HTTP and over Quack (croft docs
quack), and a run never waits for them. Every answer says as of when: the time of the lake's newest snapshot the process
has seen, and `_croft_as_of` holds it for a DuckDB client.

- The process has one door to the lake, its read-only attach. Its lockdown (croft docs lake, "What SQL cannot reach") allows
  the lake's bucket folder as the only remote path and no local folder; a key's SQL goes through the same gate as over a
  file, and sees only views of the shared tables in the process's in-memory database, never the lake's own names.
- The shared tables are views that read the lake, so new rows and new columns are there at once. Which tables exist is looked
  at before each HTTP query, and every 250 ms while a Quack session is signed in: a table a run just made is there for a
  Quack client within a quarter of a second, and one dropped is gone as fast.
- Over a bucket the store enforces what the lockdown also refuses: the read-only key cannot write, so even a COPY that got
  past every check would be refused (403). A local lake has no key; its folder is the user's own.
- The extension files are those of both modes (quack, httpfs, ducklake, postgres), fetched from DuckDB the first time they are
  needed (croft docs extensions), and croft doctor and validate name whichever is missing.
- Turning it on needs no copy and no 1 GB question. `readCopy` stays refused with a lake.
- A local lake (a SQLite catalog) lets a writer commit only while no reader has a transaction open, so a long query or a
  Quack client that holds a transaction open makes a run wait there. A Postgres catalog does not.

## What SQL cannot reach

The gate refuses, in a lake project, everything that reaches past the tables, for `croft query`, SQL assets, checks and
`ctx.query`: `postgres_query` and `postgres_execute` (which would let SQL rewrite the catalog), `duckdb_secrets()` and
`duckdb_databases()` (which show the bucket key and the catalogs), the lake's metadata catalog (`__ducklake_metadata_*`),
the lake's own functions and the bucket's files (`read_parquet('s3://...')` and the like). QUERY_PATH_DENIED.

## Types a lake cannot store, and types it stores inexactly

DuckLake stores no ENUM, UNION, VARINT, BIT or fixed-size ARRAY (`INTEGER[3]`) column. A result that has one fails before
anything is written, with LAKE_TYPE_UNSUPPORTED and the cast that fixes it (`CAST(col AS VARCHAR)`).

Four types it stores, but not exactly once its rows are in a Parquet file (a few rows stay in the catalog, which hides
it, and the maintenance pass then moves them into files), measured on DuckDB 2.0.0 with DuckLake 1.0: a HUGEINT or UHUGEINT is stored as a DOUBLE, so a value past 2^53 comes
back changed (9007199254740993 as 9007199254740992) and one near the top of the range cannot be read at all; an INTERVAL
keeps its milliseconds and loses the microseconds under them; a TIMETZ comes back as the same time at offset 0
(10:11:12+02 as 08:11:12+00); and so does one inside a STRUCT, a LIST or a MAP. Every other type a croft table has is
stored exactly: all the integer widths, DECIMAL (DECIMAL(38,0) holds any 38-digit whole number, so it is the cast for a
HUGEINT), FLOAT and DOUBLE with NaN and infinity, VARCHAR, BLOB, DATE, TIME, every TIMESTAMP, UUID, JSON, STRUCT, LIST and MAP.
So a lake never gets a column of those types: a run that would write one is refused by the column's type, whatever its
values are, before anything is written (LAKE_VALUES_INEXACT, with the cast: DECIMAL(38,0) or text for a HUGEINT, text for
the others), and croft's own type inference makes a column of integers past 64 bits DECIMAL(38,0), which is exact, in
place of HUGEINT; a SQL or TypeScript transform's HUGEINT column (`sum()` of integers) becomes DECIMAL(38,0) the same way. `croft move-to-lake` finds such columns in the file before it starts and proves every value equal
afterwards. A file keeps HUGEINT as it was.

## Moving an existing project into a lake

A project that keeps its warehouse in a file moves into a lake with one command, and the file stays untouched as the way
back. It is the user's decision, and it ends in `croft confirm`.

1. Whoever runs the Postgres and the bucket makes a NEW catalog database and bucket folder, as above. The lake must hold
   nothing: croft never writes into a lake that already holds tables.
2. The project names the lake in croft.json with `"enabled": false`, so that it stays on the file until the move is done:

       "lake": { "enabled": false, "catalog": { ... }, "bucket": { ... } }

   The secrets go in .env, the lake's extension files are fetched (`croft fetch-extensions`, or on first use), and croft serve is
   stopped if it runs (it would keep serving and scheduling for the file). `readCopy` must be off (a lake has no file to
   copy). Server mode may stay on: it goes with the project, its keys and serve.sharedTables are unchanged, and over the
   lake it needs no copy. The read copy it made on the file stays on disk as it was, no longer refreshed; delete it when
   nothing reads it.
3. `croft move-to-lake` prints what it would do and a token (exit 5; on a terminal it asks y/N). Show the user the
   impact, and only after an explicit yes run `croft confirm <token>`.

What the move does, in order, and what it proves:
- It backs the file up first, with croft's own backup (the file checkpointed and cloned under its lock, with run history
  and the trash, in .croft/backups/), and holds a lease on every asset so no run starts meanwhile.
- It copies from that backup, never from the live file: every table of `main` with its exact types, and every row of
  croft's own records (`_croft`: assets, columns, inputs, files, writes), which become the lake's logs. All of it is ONE
  lake transaction, so the lake holds the whole copy or nothing.
- It then proves it, with a new connection that uses the READ-ONLY login and key (so the reader's credentials are
  proved too): every table's columns and types, its row count and its rows (EXCEPT ALL against the backup's), and every
  `_croft` table (a floating-point column bit for bit, so a -0.0 that became 0.0 is a difference). Any difference takes the copy out of the lake again (MOVE_NOT_EQUAL) and the project stays on the file.
- It fingerprints the file (sha256, by a child process, never by this one) before and after: if anything wrote it
  meanwhile, the copy is taken out again (MOVE_FILE_CHANGED).
- Last, it sets `"enabled": true` in croft.json: one token replaced in your text, written whole by a rename.

What moves: the tables and their rows, and croft's records of them, so `croft status` shows the same staleness and the
next run does only what it would have done on the file. What stays where it is: the trash (local files; `croft restore`
brings a version back into the lake), run history, schedules and approvals (runs.sqlite), asset files and .env. What does
not come along: time travel (a file keeps none, so the lake's history starts with the move) and anything in the file that
is not a table of `main` (views, macros, sequences, indexes, types, tables of other schemas), which the question names.

Before it starts, the move refuses, with the fix: a column a lake cannot store (LAKE_TYPE_UNSUPPORTED, every table at
once), columns of a type a lake would store inexactly (LAKE_VALUES_INEXACT), a lake that holds anything (MOVE_LAKE_NOT_EMPTY), no
lake block or a project already in the lake (MOVE_NEEDS_LAKE), and a read copy asked for by name, a running croft serve, a
rename that did not finish, a write-ahead log the file still holds (run croft backup, which folds it in) or a croft.json
it cannot rewrite (MOVE_BLOCKED). It then changes nothing.

The way back is the setting: `"enabled": false`, and the project is on the file again, byte for byte as the move left it
(the question and the result give its sha256). Writes made in the lake since are not carried back; they stay in the lake,
and the setting `true` brings them back. croft keeps the catalog mirror in runs.sqlite for the warehouse the project is on,
so going back restores the file's own mirror and status, the plan and the next run read the file. A move into the same lake
after going back is refused (MOVE_LAKE_NOT_EMPTY), written since or not: that move finished, and croft never merges into
a lake or writes over one. To use that lake again set `"enabled": true` by hand; to move the file again, name a new lake.

If the move stops (a kill, a lost connection), the project is on the file or in the lake, never between. The next
`croft move-to-lake` recognises the copy it left in the lake (a marker row in `_croft.meta`, and its commit being the
lake's newest snapshot) and finishes by proving it and switching, without copying twice.

## Not in this release

- Moving a project from a lake back into a file (going back is the setting above).
- A lake on one machine with no Postgres (a SQLite catalog and a folder). It exists for croft's own tests, and croft.json refuses it
  otherwise; it may be offered later as its own decision.

Codes: LAKE_ATTACH_FAILED, LAKE_CATALOG_MISMATCH, LAKE_STORE_TLS, LAKE_CONNECTION_LOST, LAKE_COMMIT_UNCERTAIN, LAKE_TYPE_UNSUPPORTED, LAKE_DIRECT_READ,
LAKE_UNSUPPORTED, LAKE_OTHER_WRITER, LAKE_MAINTENANCE_FAILED, LAKE_EXPIRY_OPTION, LAKE_BACKUP_FAILED,
LAKE_BACKUP_TOOL_MISSING, LAKE_VALUES_INEXACT, MAINTAIN_NEEDS_LAKE, MOVE_NEEDS_LAKE, MOVE_BLOCKED, MOVE_LAKE_NOT_EMPTY,
MOVE_NOT_EQUAL, MOVE_FILE_CHANGED (croft docs <CODE>), and EXTENSION_MISSING when the extension files are not on the machine and fetching is off.

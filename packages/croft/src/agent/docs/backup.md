# Backups: a consistent copy of the data, and how to put it back

Some data cannot be fetched again: sources keep only recent history, and paid calls cost money twice. croft never
throws ingested data away on its own, but a disk can fail and a folder can be deleted. croft backup copies what
croft needs to carry on, as one consistent moment:

  croft backup                 a new folder in .croft/backups/
  croft backup <folder>        a new folder inside <folder> (created when missing), on another disk for example
  croft backup --json          the same as data: path, bytes, createdAt, and the size of each part

Each backup is a new folder, <project>-<time>/ (the time in UTC, to the second; -2, -3… when that name is taken).
croft never overwrites a backup and never deletes one. Inside:

  warehouse.duckdb    every table, with croft's state for it, as of createdAt (a lake: see below)
  runs.sqlite         run history, schedules and their approvals, the catalog
  trash/              the versions croft restore can bring back
  backup.json         when, which croft and DuckDB wrote it, the project's paths, and every file with its size

A lake project's backup holds the lake in two parts instead of the warehouse file (see "A lake" below). Left out: the asset files and lib/ (keep them in git), .env (secrets are never copied), files/ (the input files),
and croft's logs and other derived files under .croft/.

## Safe while croft works

Never copy warehouse.duckdb by hand: a copy made while croft serve, a run or the scheduler uses the file, or while
recent commits are still in its WAL (warehouse.duckdb.wal), can miss rows or not open at all. croft backup takes
the file the way every croft writer does: croft serve steps aside (its queries wait the moment that takes, or are
answered from the read copy while readCopy is on), and a run waits between its steps. It then checkpoints, so the
file holds every commit, copies it with runs.sqlite and the trash, and lets go.

- On macOS (APFS) and on Linux filesystems with reflinks the copy is a clone: it takes about a millisecond
  whatever the size, and shares the disk's blocks with the warehouse until either changes, so a fresh backup
  takes almost no space (the sizes croft prints are the files' own). Elsewhere croft holds the file while it
  copies.
- A backup to another disk is cloned into .croft/backups/ first and copied across after croft let go of the
  file, so croft serve and runs do not wait for the slow copy.
- During a run, the backup holds the steps the run had finished.
- A program that is not croft (the DuckDB UI, DBeaver) holding the file makes it wait, then exit 4 naming the
  program (DB_HELD_BY_OTHER_PROGRAM); close the program, or open warehouse.read.duckdb in it (croft docs read-copy).

## Where to keep it

A backup in .croft/backups/ is on the warehouse's disk: it undoes a mistake (a deleted file, a table changed
outside croft), not a lost disk. For that, give croft backup a folder on another disk, or copy the backup folder
elsewhere afterwards: it is a folder of closed files, so any copy tool, cloud storage or synced folder (iCloud
Drive, Dropbox) suits it. Only the live warehouse must stay out of synced folders (croft docs DB_ON_SYNCED_FOLDER).

croft does not make backups on a schedule or remove old ones; delete old folders by hand, after asking the user.

## A lake

A lake is a catalog (a Postgres database) and a bucket folder, so its backup has:

  catalog.dump        the catalog, from pg_dump in its custom format, as the read-only login
  lake-data/          a mirror of the lake's bucket folder, read with the read-only key
  runs.sqlite         run history, schedules and their approvals, the catalog mirror
  trash/              the versions croft restore can bring back
  backup.json         when, the lake's snapshot the catalog holds, where it came from (no credential), every file

It needs pg_dump on the machine (LAKE_BACKUP_TOOL_MISSING says how to get it; CROFT_PG_DUMP names a pg_dump that is not on the
PATH). The dump, run history and trash are taken at one moment, with the lake's writes held for the seconds that
takes; the folder is then copied with runs going on. A file of a lake never changes once written, so a backup links, as a
hard link, the same file of the last backup of this lake when its size is the same, and downloads only what is new
(data.lake.data.reused counts them): a daily backup costs what the day wrote. A backup that is copying keeps this
machine's lake maintenance from running. Files that appeared after the dump are in the mirror and not in the catalog; once
restored they are files the lake does not own, which `croft maintain --orphans` lists.

A local lake (croft's own tests) has catalog.sqlite in place of catalog.dump.

## Putting a lake backup back

Ask the user first: restoring needs a new database and a new bucket folder, made by whoever runs them (the setup in
croft docs lake: a writer and a read-only login, a writer and a read-only key). It does not touch the old lake.

1. Make an empty database with the same two logins, and an empty bucket folder.
2. Restore the catalog as the writer: pg_restore -O -h <host> -p <port> -U <writer> -d <new database> catalog.dump (the
   password in PGPASSWORD, not on the command line). Tables the writer creates are readable by the read-only login by
   the setup's default privileges; without them, GRANT SELECT again as the setup does.
3. Copy lake-data/ into the new bucket folder with the tool you use for buckets (aws s3 sync, rclone, mc), keeping the
   names; the folder must then hold the lake and nothing else.
4. The catalog stores where the data is; tell it the new place, as the writer, in the new database:
   UPDATE ducklake_metadata SET value = 's3://<new bucket>/<new folder>/' WHERE key = 'data_path';
5. Point the project at them: the lake block of croft.json (the new host, database, bucket and folder; the logins and
   keys in .env), and copy runs.sqlite into the state folder and trash/ into its trash/ if this is a new project folder.
6. croft doctor, then croft status: the tables, their rows and croft's bookkeeping are as they were at createdAt (the
   snapshot in backup.json), and the next croft run fetches what is newer.

A backup test does exactly these steps into a fresh catalog and bucket and compares every table and every bookkeeping
row.

## Putting a backup back

croft restore brings back versions from the trash, not backups. A backup goes back by hand, so ask the user first:
it replaces the warehouse with the backup's, and what was written since is lost unless it is fetched again.

1. Stop croft serve, run croft schedule off, and check with croft status that no run is going.
2. Move the current files aside rather than deleting them: the warehouse (and its .wal when there is one),
   .croft/runs.sqlite (with runs.sqlite-wal and runs.sqlite-shm) and .croft/trash.
3. Copy the backup's warehouse.duckdb to the warehouse's path (project.database in backup.json), its runs.sqlite
   into the state folder (project.stateDir), and its trash/ to the state folder's trash/.
4. croft doctor, then croft status: the assets are as they were at createdAt, and the next croft run fetches what
   is newer from the sources.
5. croft schedule on, if it was on, and start croft serve again.

A backup opens with the DuckDB of backup.json's duckdb or a newer one (a newer one backs the file up again before
it first writes, croft docs trash). To look inside one without putting it back, open its warehouse.duckdb
read-only (duckdb -readonly <file>): a tool that opens it read-write changes the backup.

# Backups: a consistent copy of the data, and how to put it back

Some data cannot be fetched again: sources keep only recent history, and paid calls cost money twice. croft never
throws ingested data away on its own, but a disk can fail and a folder can be deleted. croft backup copies what
croft needs to carry on, as one consistent moment:

  croft backup                 a new folder in .croft/backups/
  croft backup <folder>        a new folder inside <folder> (created when missing), on another disk for example
  croft backup --json          the same as data: path, bytes, createdAt, and the size of each part

Each backup is a new folder, <project>-<time>/ (the time in UTC, to the second; -2, -3… when that name is taken).
croft never overwrites a backup and never deletes one. Inside:

  warehouse.duckdb    every table, with croft's state for it, as of createdAt
  runs.sqlite         run history, schedules and their approvals, the catalog
  trash/              the versions croft restore can bring back
  backup.json         when, which croft and DuckDB wrote it, the project's paths, and every file with its size

Left out: the asset files and lib/ (keep them in git), .env (secrets are never copied), files/ (the input files),
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

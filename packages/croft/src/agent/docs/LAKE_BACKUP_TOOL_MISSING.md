# LAKE_BACKUP_TOOL_MISSING: croft backup of a lake needs pg_dump, and none was found

A lake's catalog is a Postgres database, and `croft backup` copies it with Postgres's own dump tool, `pg_dump`, as the
read-only login. The tool is part of the Postgres client programs, and it was not on this machine's PATH or in the usual
places (Homebrew, Postgres.app, /usr/lib/postgresql). Nothing was written: no partial backup is left.

The data is not at risk meanwhile. It is in the catalog and the bucket, and the trash in .croft/trash keeps working.

What to do:
- Install the Postgres client tools, at least as new as the catalog's Postgres server (an older pg_dump refuses a newer
  server): on macOS `brew install libpq`, on Debian and Ubuntu `apt install postgresql-client`. Then run croft backup
  again.
- Or name the program: set CROFT_PG_DUMP to the path of a pg_dump in the environment croft runs in.
- This is a task for the user's machine, not a setting of the project: ask before installing software.

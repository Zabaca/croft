# LAKE_BACKUP_FAILED: croft backup of a lake could not copy the catalog or the bucket

A backup of a lake is a dump of its catalog (pg_dump, as the read-only login) and a copy of its bucket folder (read with
the read-only bucket key), taken as one moment (croft docs backup). One of the two failed: the message says which and
holds the tool's or the store's first line, with every password and key taken out. The backup folder was removed: no
partial backup is left, and nothing in the lake was changed.

The usual causes, and what the hint says for them:
- pg_dump is older than the catalog's server ("server version mismatch"): install the client tools of the server's
  version or newer, and name that pg_dump in CROFT_PG_DUMP.
- The read-only login cannot read every table of the catalog ("permission denied"): the setup in croft docs lake grants
  it SELECT on all tables, now and later; ask whoever runs the Postgres.
- The store refused the read-only key, or could not be reached (details name the HTTP status and the store's error
  code): the key must list and read the lake's folder.
- A listed file came to a different size than the listing said, which a store that is changing underneath shows.

What to do:
- Check that the catalog and the bucket are reachable (croft doctor), fix what the message names, and run
  croft backup again. A backup that fails is safe to run again.
- Do not copy the bucket or dump the catalog by hand to "get a backup" while this fails without telling the user: a
  hand copy made while croft writes can be torn.

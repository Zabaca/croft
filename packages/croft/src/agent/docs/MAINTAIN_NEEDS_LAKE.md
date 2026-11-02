# MAINTAIN_NEEDS_LAKE: croft maintain is for a project whose warehouse is a lake

`croft maintain` runs the housekeeping of a lake: it flushes the rows DuckLake keeps inside its catalog into files,
expires the snapshots outside the trash's promise (30 days or 5 versions per asset), merges small files, rewrites files
that are mostly deleted rows, and deletes the files nothing refers to. This project names no `lake` in croft.json: its
warehouse is one DuckDB file, which has none of that to do. Nothing was changed.

A file needs no pass of this kind. Its trash and its backups are kept short by croft itself (croft docs trash,
croft docs backup).

What to do:
- Nothing, if the project is meant to keep a file.
- If the project is meant to keep its warehouse in a lake, that is a decision for the user: a lake needs a Postgres, a
  bucket folder, two logins and two keys (croft docs lake). Never make them yourself.

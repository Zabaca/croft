# LAKE_UNSUPPORTED: this command does not work on a lake yet

The project keeps its warehouse in a lake (a `lake` block in croft.json; croft docs lake). The command works on the
warehouse as one DuckDB file (its size, its copy, its backup), and a lake is not one: its tables live in a catalog and
a bucket. Nothing was changed.

The commands this covers are named in the message. `croft backup` is one: a backup of a lake is a dump of its catalog
and a copy of its bucket folder, which croft does not make yet. The data is not at risk meanwhile: it is in the catalog
and the bucket, and `croft restore` keeps working from the trash in the state folder.

What to do:
- Use another command, or another way: back the lake up with the tools of whoever runs the Postgres and the bucket
  (a database dump and a copy of the folder).
- Ask the user before doing without a backup of a lake that holds data nobody can fetch again.

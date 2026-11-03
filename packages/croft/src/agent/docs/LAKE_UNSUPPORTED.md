# LAKE_UNSUPPORTED: this command does not work on a lake yet

The project keeps its warehouse in a lake (a `lake` block in croft.json; croft docs lake). The command works on the
warehouse as one DuckDB file (its size, its copy, its backup), and a lake is not one: its tables live in a catalog and
a bucket. Nothing was changed.

The commands this covers are named in the message. Moving an existing project's file into a lake, and server mode over
a lake, are not built yet. The data is not at risk meanwhile: it is in the catalog and the bucket, and
`croft restore` keeps working from the trash in the state folder. (`croft backup` and `croft maintain` work on a lake.)

What to do:
- Use another command, or another way, if there is one; the message says what the command could not do.
- Ask the user before doing without something a lake that holds data nobody can fetch again needs.

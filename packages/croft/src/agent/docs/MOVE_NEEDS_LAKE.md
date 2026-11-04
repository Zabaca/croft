# MOVE_NEEDS_LAKE: croft move-to-lake needs a lake to move into, and a project that keeps its warehouse in a file

`croft move-to-lake` copies a project's file warehouse into a lake and switches the project to it. details.reason says
what is in the way:
- no_lake: croft.json has no `lake` block, so there is no lake to move into. The block that names the lake carries
  `"enabled": false` while the project is still on the file (croft docs lake lists its keys).
- already_in_lake: the project already keeps its warehouse in a lake (`lake` without `"enabled": false`), so there is
  nothing to move.

Nothing was changed.

What to do:
- no_lake: a lake needs a Postgres, a bucket folder, two logins and two keys, which are the user's to make and to
  decide on (croft docs lake). Never make them yourself. When the user has them, add the `lake` block with
  `"enabled": false`, put the secrets in .env, and run croft move-to-lake again.
- already_in_lake: nothing; the project is where it should be. If it was meant to move a different file, that is a
  different project.

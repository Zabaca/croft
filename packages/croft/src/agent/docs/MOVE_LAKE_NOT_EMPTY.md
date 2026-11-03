# MOVE_LAKE_NOT_EMPTY: the lake a project would move into already holds something

A move fills a lake that holds nothing. This lake (the catalog database and bucket folder in the lake block) holds
tables or bookkeeping rows, or the copy of an earlier move that has been written since, is the copy of another file,
or was made by a move that finished (the project was in the lake and then switched back to the file). croft never
merges into a lake or writes over one, so nothing was changed.

When the lake holds the copy of an earlier move of this same file, nothing has written the lake since, and that move
was stopped before it switched, croft does not refuse: it proves that copy again and switches to it, without copying
twice.

What to do:
- Name a new catalog database and bucket folder in the lake block (the folder holds nothing but one lake), and run
  croft move-to-lake again. Whoever runs the Postgres and the bucket makes them; never make them yourself.
- To use a lake that a move made and that has been written since, set `"enabled": true` in its block by hand: what was
  written there stays there. Moving the file again would put the file's older state over it, which croft does not do.

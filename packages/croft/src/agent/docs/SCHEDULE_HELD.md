# SCHEDULE_HELD: the scheduler waits until a person has run this asset's code

The scheduler only runs code a person has run. An asset is held when it is new, or when its code changed since
it was last run by hand: its file, the lib/ code it imports, or its packages. The tick skips it and it stays
due; croft status, croft context and croft schedule status show it as held, with how long ago it was edited.
A file that no longer loads is held too, until it is fixed and run. When croft.json names a secretsFrom command
(croft docs secrets) that is new or changed since a person last ran an asset that reads secrets, every asset that
reads secrets is held, since its run would run that command; a run by hand of any one of them releases them all.

A new DuckDB holds nothing: after croft 0.4's upgrade to DuckDB 2.0 every SQL asset's code hash is new, but an asset
whose file is the one a person ran keeps its approval. The scheduler rebuilds it once and approves the new hash. An
asset edited since it was last run by hand is held as always.

What to do: check the change, then run it by hand once.

- croft validate --json, then croft preview <asset>: read columns, checks, diff and samples. A preview that
  succeeds also releases the asset.
- croft run <asset>: a run from a terminal or from Claude Code releases it, and the scheduler runs it from its
  next fire on.

Ask the user first when the change is theirs to approve (a new source, a transform that pays per row). A
scheduled run never releases anything by itself.

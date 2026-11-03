# LAKE_EXPIRY_OPTION: another tool set an age-based expiry on the lake (warning)

DuckLake stores options on the lake itself, and `expire_older_than` is one: a CHECKPOINT run by any tool that attaches
the lake then expires every snapshot older than that, whatever the trash promised to keep (the trash keeps each
version for 30 days, and each asset's 5 newest however old). `croft doctor` found one set; details.options names it
and its value.

croft is not affected: it never runs CHECKPOINT on a lake and never sets an option on one. Its own maintenance expires
by an explicit list of snapshots it computes from the promise (croft docs lake), and closing croft's instance on the
lake expires nothing. A test holds this. What is at risk is the versions the promise keeps, if somebody else's tool
runs CHECKPOINT on this lake.

This is a warning. Nothing was changed.

What to do:
- Ask the user whether the setting can go. Whoever set it (a data tool, a person with their own DuckDB) can remove it;
  croft does not remove an option it did not set.
- Tell whoever runs other tools on this lake never to run CHECKPOINT on it, and that the lake's folder must hold nothing
  but the lake (croft docs lake).

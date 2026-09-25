# SERVE_UNSAFE_FILESYSTEM: the warehouse or .croft/ is on a filesystem where file locks do not hold

croft keeps its processes apart with DuckDB's file lock and its own lock files in .croft/. On a network or shared
filesystem (NFS, SMB, a volume shared between machines or containers) those locks do not hold across machines:
croft serve could not hand the file to runs safely, and two writers could corrupt it. croft serve refuses to start
there, and croft doctor reports it as an error. details.reason, details.filesystem and details.path say which
mount it is.

Nothing was changed.

What to do: keep the database and .croft/ on a disk of the machine (or container) that runs every croft command.
With no croft command running, the user moves them (the fix names a place under ~/.local/share/croft/) and sets
"database" and "stateDir" in croft.json to the new paths; asset files stay where they are. Ask the user before
moving anything: it is their data. Then croft doctor, and croft serve again.

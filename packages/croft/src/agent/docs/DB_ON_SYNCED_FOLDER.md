# DB_ON_SYNCED_FOLDER: the warehouse or .croft/ is inside a synced folder (warning)

File sync (iCloud Drive's ~/Documents and ~/Desktop, Dropbox, OneDrive, Google Drive, network drives) copies files
while croft writes them: a DuckDB file synced mid-write can be corrupted, and its lock breaks when the sync client
touches it. croft init moves the database and .croft/ out of such folders by itself; croft doctor warns when they
are in one anyway (the project was moved, or croft.json points there). details name the folder and the place croft
suggests.

Nothing is blocked yet.

What to do: with no croft command running, move the warehouse and .croft/ to the place the fix names (under
~/.local/share/croft/) and set "database" and "stateDir" in croft.json to the new paths; the asset files stay where
they are. It moves the user's data, so ask the user first. Then croft doctor to check.

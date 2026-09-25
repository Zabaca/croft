# PROJECT_NOT_WRITABLE: croft cannot write where it keeps the project's state

croft writes runs, logs, the trash and backups under .croft/ (or the "stateDir" of croft.json), the warehouse next
to it, and a new project's files when croft init creates one. PROJECT_NOT_WRITABLE means a write there failed with a
permission error, a read-only disk, or a full disk (details.error: EACCES, EPERM, EROFS, ENOSPC, EDQUOT).
croft doctor probes the folder, croft init reports the path it could not write, and a backup before a DuckDB
upgrade reports the backups folder.

What was written before the failure stays; the command did not finish.

What to do: the fix is on the machine, so ask the user:
- a permission problem: make the folder writable for their user (chmod u+w <folder>), or run croft as the user
  that owns it;
- a full disk: free space (the trash in .croft/trash/ and old backups in .croft/backups/ are croft's own;
  croft doctor prunes the trash by its retention);
- a read-only location: create or move the project somewhere writable.
Then run the command again, and croft doctor to check.

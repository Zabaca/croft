# MOVE_FILE_CHANGED: the file warehouse changed while it was being moved, so the project was not switched

`croft move-to-lake` copies from a backup of the file and, before it switches, checks that the file still has the
bytes it had at the backup (a sha256 taken by a child process). It did not: something wrote the file meanwhile
(details has the fingerprints), or the backup was not a copy of this file. The lake therefore holds a copy of an older
file, so it was taken out of the lake again (details.undone) and nothing was switched. The project still keeps its
warehouse in the file.

The move holds a lease on every asset, so a croft run cannot be the cause. Another program writing the file can be,
and so can a croft serve or a scheduler tick of another copy of the project folder.

What to do: make sure nothing else writes the project (croft serve stopped, scheduling paused with croft schedule
pause, no other program holding the file), then run croft move-to-lake again.

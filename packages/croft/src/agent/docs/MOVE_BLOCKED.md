# MOVE_BLOCKED: something in the project has to change before it can move into a lake

`croft move-to-lake` refuses to start while one of these holds (details.reasons lists each one that applies, and the
hint gives the fix for it). Nothing was changed: the file, the lake and croft.json are as they were.
- There is no warehouse to move: the project has built nothing yet. Set `"enabled": true` in the lake block by hand and
  the first croft run creates the lake.
- Server mode is on (`serverMode.enabled`): server mode over a lake is not built yet. The project keeps its keys and
  settings as they are; keep it on the file until it is built, or ask the user whether to turn server mode off first.
- The read copy is on (`readCopy`): a lake has no file to copy. Ask the user, then remove it and read through
  croft serve.
- croft serve is running: it would go on serving and scheduling for the file after the move. Stop it, move, start it
  again.
- A croft rename did not finish: finish it first (croft rename <old> <new>).
- croft cannot rewrite croft.json, which the move does as its last step: make the file and its folder writable.

When the message says croft could not switch croft.json at the end, the lake already holds a verified copy and the
project still uses the file: set `"enabled": true` in the lake block by hand, or run croft move-to-lake again, which
finishes the move.

What to do: apply the fix the hint names; decisions about server mode, the read copy and stopping croft serve are the
user's. Then run croft move-to-lake again.
